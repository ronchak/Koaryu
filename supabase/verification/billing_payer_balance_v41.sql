BEGIN ISOLATION LEVEL READ COMMITTED;
DO $seed$
DECLARE
    owner_id UUID := gen_random_uuid();
    studio_a UUID := gen_random_uuid();
    studio_b UUID := gen_random_uuid();
    payer_a UUID := gen_random_uuid();
    payer_other UUID := gen_random_uuid();
    payer_b UUID := gen_random_uuid();
    payer_empty UUID := gen_random_uuid();
    payer_overflow UUID := gen_random_uuid();
    payer_many UUID := gen_random_uuid();
BEGIN
    INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES(owner_id,'authenticated','authenticated',owner_id||'@example.invalid','{}','{}',now(),now());
    INSERT INTO public.studios(id,name,slug,owner_id) VALUES
        (studio_a,'Balance A','balance-a-'||studio_a,owner_id),
        (studio_b,'Balance B','balance-b-'||studio_b,owner_id);
    INSERT INTO public.billing_payers(id,studio_id,display_name,balance_cents,billing_status) VALUES
        (payer_a,studio_a,'Primary',11,'failed'),
        (payer_other,studio_a,'Other payer',66,'failed'),
        (payer_b,studio_b,'Other studio',77,'failed'),
        (payer_empty,studio_a,'Empty',88,'failed'),
        (payer_overflow,studio_a,'Overflow',99,'failed'),
        (payer_many,studio_a,'Many invoices',123,'failed');
    INSERT INTO public.billing_invoices(studio_id,payer_id,status,amount_due_cents,amount_paid_cents,amount_remaining_cents,due_date,external)
    VALUES
        (studio_a,payer_a,'draft',100,0,100,'2099-01-01',true),
        (studio_a,payer_a,'open',200,0,200,NULL,true),
        (studio_a,payer_a,'uncollectible',300,0,300,'2020-01-01',true),
        (studio_a,payer_a,'partially_refunded',400,0,400,NULL,true),
        (studio_a,payer_a,'open',600,0,0,NULL,true),
        (studio_a,payer_a,'open',100,0,-50,NULL,true),
        (studio_a,payer_a,'paid',9000,9000,9000,NULL,true),
        (studio_a,payer_a,'void',8000,0,8000,NULL,true),
        (studio_a,payer_a,'refunded',7000,7000,7000,NULL,true),
        (studio_a,payer_other,'open',4000,0,4000,NULL,true),
        (studio_b,payer_b,'open',6000,0,6000,NULL,true),
        (studio_a,payer_overflow,'open',2147483647,0,2147483647,NULL,true),
        (studio_a,payer_overflow,'open',2147483647,0,2147483647,NULL,true);
    INSERT INTO public.billing_invoices(studio_id,payer_id,status,amount_due_cents,amount_remaining_cents,external)
    SELECT studio_a,payer_many,'open',1,1,true FROM generate_series(1,1001);
    PERFORM set_config('balance_test.studio_a',studio_a::TEXT,true),
        set_config('balance_test.studio_b',studio_b::TEXT,true),
        set_config('balance_test.payer_a',payer_a::TEXT,true),
        set_config('balance_test.payer_b',payer_b::TEXT,true),
        set_config('balance_test.payer_other',payer_other::TEXT,true),
        set_config('balance_test.payer_empty',payer_empty::TEXT,true),
        set_config('balance_test.payer_overflow',payer_overflow::TEXT,true),
        set_config('balance_test.payer_many',payer_many::TEXT,true);
END;
$seed$;

SET LOCAL ROLE service_role;
DO $proof$
DECLARE
    studio_a UUID := current_setting('balance_test.studio_a')::UUID;
    studio_b UUID := current_setting('balance_test.studio_b')::UUID;
    payer_a UUID := current_setting('balance_test.payer_a')::UUID;
    payer_b UUID := current_setting('balance_test.payer_b')::UUID;
    payer_other UUID := current_setting('balance_test.payer_other')::UUID;
    payer_empty UUID := current_setting('balance_test.payer_empty')::UUID;
    payer_overflow UUID := current_setting('balance_test.payer_overflow')::UUID;
    payer_many UUID := current_setting('balance_test.payer_many')::UUID;
    failed BOOLEAN := false;
BEGIN
    IF current_user <> 'service_role' OR current_setting('transaction_isolation') <> 'read committed' THEN
        RAISE EXCEPTION 'Balance proof must execute as service_role at READ COMMITTED';
    END IF;
    PERFORM public.recompute_billing_payer_balance_v1(studio_a,payer_a);
    IF (SELECT ROW(balance_cents,billing_status) FROM public.billing_payers WHERE id=payer_a)
        IS DISTINCT FROM ROW(1000,'current'::TEXT) THEN
        RAISE EXCEPTION 'Balance inclusion, explicit zero, negative clamp or non-overdue status failed';
    END IF;
    IF (SELECT ROW(balance_cents,overdue_balance_cents,uncollectible_balance_cents,billing_status)
        FROM public.billing_payer_balance_facts_v1(studio_a,payer_a))
        IS DISTINCT FROM ROW(1000::BIGINT,0::BIGINT,300::BIGINT,'outstanding'::TEXT) THEN
        RAISE EXCEPTION 'Mixed draft, undated and uncollectible invoices lost their separate facts';
    END IF;
    PERFORM public.recompute_billing_payer_balance_v1(studio_b,payer_a);
    PERFORM public.recompute_billing_payer_balance_v1(studio_a,payer_b);
    PERFORM public.recompute_billing_payer_balance_v1(studio_a,gen_random_uuid());
    PERFORM public.recompute_billing_payer_balance_v1(studio_a,NULL);
    IF (SELECT balance_cents FROM public.billing_payers WHERE id=payer_a) IS DISTINCT FROM 1000
        OR (SELECT balance_cents FROM public.billing_payers WHERE id=payer_b) IS DISTINCT FROM 77
        OR (SELECT balance_cents FROM public.billing_payers WHERE id=payer_other) IS DISTINCT FROM 66 THEN
        RAISE EXCEPTION 'Missing/foreign payer scope changed a balance';
    END IF;
    PERFORM public.recompute_billing_payer_balance_v1(studio_a,payer_empty);
    IF (SELECT ROW(balance_cents,billing_status) FROM public.billing_payers WHERE id=payer_empty)
        IS DISTINCT FROM ROW(0,'current'::TEXT) THEN
        RAISE EXCEPTION 'Empty payer did not become zero/current';
    END IF;
    PERFORM public.recompute_billing_payer_balance_v1(studio_a,payer_many);
    IF (SELECT balance_cents FROM public.billing_payers WHERE id=payer_many) IS DISTINCT FROM 1001 THEN
        RAISE EXCEPTION 'Balance calculation omitted invoices beyond a client page';
    END IF;
    BEGIN
        PERFORM public.recompute_billing_payer_balance_v1(studio_a,payer_overflow);
    EXCEPTION WHEN numeric_value_out_of_range THEN
        failed := true;
    END;
    IF NOT failed OR (SELECT ROW(balance_cents,billing_status) FROM public.billing_payers WHERE id=payer_overflow)
        IS DISTINCT FROM ROW(99,'failed'::TEXT) THEN
        RAISE EXCEPTION 'Overflow did not fail without changing the payer';
    END IF;
    -- Current schema excludes NULL remaining values. Do not weaken it to
    -- manufacture an unreachable fallback in the financial calculation.
    IF NOT (SELECT attnotnull FROM pg_catalog.pg_attribute
        WHERE attrelid='public.billing_invoices'::regclass AND attname='amount_remaining_cents') THEN
        RAISE EXCEPTION 'Unexpected nullable invoice remaining-balance schema';
    END IF;
END;
$proof$;

RESET ROLE;
DO $collection_seed$
DECLARE actor UUID := gen_random_uuid(); studio UUID := gen_random_uuid();
BEGIN
    INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES(actor,'authenticated','authenticated',actor||'@example.invalid','{}','{}',now(),now());
    INSERT INTO public.studios(id,name,slug,owner_id,timezone)
    VALUES(studio,'Collection facts',studio::TEXT,actor,'UTC');
    PERFORM set_config('balance_test.collection_studio',studio::TEXT,true);
END;
$collection_seed$;
SET LOCAL ROLE service_role;
DO $collection_facts$
DECLARE
    studio UUID := current_setting('balance_test.collection_studio')::UUID;
    today DATE := (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::DATE;
    payer UUID;
    today_payer UUID;
    overdue_payer UUID;
    test_case RECORD;
    facts RECORD;
    projected JSONB;
    before_row JSONB;
    landing JSONB;
    server_zone TEXT;
BEGIN
    FOR test_case IN SELECT * FROM (VALUES
        ('draft','draft',-1,100,100,0,0,'outstanding'),
        ('future','open',1,100,100,0,0,'outstanding'),
        ('today','open',0,100,100,0,0,'outstanding'),
        ('undated','open',NULL,100,100,0,0,'outstanding'),
        ('overdue','open',-1,100,100,100,0,'past_due'),
        ('uncollectible','uncollectible',-1,100,100,0,100,'uncollectible'),
        ('partial refund','partially_refunded',-1,100,100,100,0,'past_due'),
        ('paid','paid',-1,100,0,0,0,'current'),
        ('void','void',-1,100,0,0,0,'current'),
        ('refunded','refunded',-1,100,0,0,0,'current'),
        ('zero','open',-1,0,0,0,0,'current'),
        ('negative','open',-1,-50,0,0,0,'current')
    ) AS cases(label,status,day_offset,remaining,balance,overdue,uncollectible,read_status)
    LOOP
        payer := gen_random_uuid();
        INSERT INTO public.billing_payers(id,studio_id,display_name,balance_cents,billing_status)
        VALUES(payer,studio,test_case.label,999,'past_due');
        INSERT INTO public.billing_invoices(studio_id,payer_id,status,amount_due_cents,amount_remaining_cents,due_date,external)
        VALUES(studio,payer,test_case.status,100,test_case.remaining,today+test_case.day_offset,true);
        SELECT to_jsonb(p) INTO before_row FROM public.billing_payers p WHERE id=payer;
        SELECT * INTO facts FROM public.billing_payer_balance_facts_v1(studio,payer,today);
        IF ROW(facts.balance_cents,facts.overdue_balance_cents,facts.uncollectible_balance_cents,facts.billing_status)
           IS DISTINCT FROM ROW(test_case.balance::BIGINT,test_case.overdue::BIGINT,test_case.uncollectible::BIGINT,test_case.read_status) THEN
            RAISE EXCEPTION 'Collection policy failed for %: %',test_case.label,row_to_json(facts);
        END IF;
        SELECT p INTO projected FROM public.list_billing_payers_v1(studio,payer,today) p;
        IF projected->>'id' IS DISTINCT FROM payer::TEXT
           OR projected->>'billing_status' IS DISTINCT FROM test_case.read_status
           OR (projected->>'overdue_balance_cents')::BIGINT IS DISTINCT FROM test_case.overdue::BIGINT
           OR (SELECT to_jsonb(p) FROM public.billing_payers p WHERE id=payer) IS DISTINCT FROM before_row THEN
            RAISE EXCEPTION 'Payer projection lost facts or rewrote retained rows for %',test_case.label;
        END IF;
        PERFORM public.recompute_billing_payer_balance_v1(studio,payer);
        IF (SELECT ROW(balance_cents,billing_status) FROM public.billing_payers WHERE id=payer)
           IS DISTINCT FROM ROW(test_case.balance,
               CASE WHEN test_case.overdue>0 THEN 'past_due' ELSE 'current' END) THEN
            RAISE EXCEPTION 'Stored compatibility snapshot disagrees for %',test_case.label;
        END IF;
        IF test_case.label='today' THEN today_payer:=payer; END IF;
        IF test_case.label='overdue' THEN overdue_payer:=payer; END IF;
    END LOOP;

    SELECT to_jsonb(p) INTO before_row FROM public.billing_payers p WHERE id=today_payer;
    SELECT p INTO projected FROM public.list_billing_payers_v1(studio,today_payer,today+1) p;
    IF projected->>'billing_status' IS DISTINCT FROM 'past_due'
       OR projected->>'overdue_balance_cents' IS DISTINCT FROM '100'
       OR (SELECT to_jsonb(p) FROM public.billing_payers p WHERE id=today_payer) IS DISTINCT FROM before_row THEN
        RAISE EXCEPTION 'Next-day reads require a payment event or rewrite the stored row';
    END IF;
    FOREACH server_zone IN ARRAY ARRAY['Pacific/Kiritimati','Etc/GMT+12'] LOOP
        PERFORM set_config('TimeZone',server_zone,true);
        SELECT * INTO facts FROM public.billing_payer_balance_facts_v1(studio,today_payer);
        IF facts.overdue_balance_cents IS DISTINCT FROM 0::BIGINT THEN
            RAISE EXCEPTION 'Today classification used server timezone %',server_zone;
        END IF;
        SELECT * INTO facts FROM public.billing_payer_balance_facts_v1(studio,overdue_payer);
        IF facts.overdue_balance_cents IS DISTINCT FROM 100::BIGINT THEN
            RAISE EXCEPTION 'Overdue classification used server timezone %',server_zone;
        END IF;
    END LOOP;
    PERFORM set_config('TimeZone','UTC',true);
    INSERT INTO public.billing_payers(studio_id,display_name,billing_status)
    VALUES(studio,'Independent payment failure','failed');
    INSERT INTO public.billing_invoices(studio_id,status,amount_due_cents,amount_remaining_cents,due_date,external)
    VALUES (studio,'open',50,50,today-1,true),
           (studio,'uncollectible',75,75,NULL,true),
           (studio,'draft',25,25,today-1,true);
    IF (SELECT SUM(balance_cents) FROM public.billing_payer_balance_facts_v1(studio)) IS DISTINCT FROM 700::NUMERIC
       OR public.billing_attention_count_v1(studio,today) IS DISTINCT FROM 8
       OR public.billing_attention_count_v1(studio,today+1) IS DISTINCT FROM 10 THEN
        RAISE EXCEPTION 'Attention facts lost unassigned invoices or invented payer attribution';
    END IF;
    projected:=public.dashboard_summary_facts(studio,'billing_visible','UTC',today,'dashboard-summary-v1');
    IF projected->'billing'->>'payment_attention_count' IS DISTINCT FROM '8' THEN
        RAISE EXCEPTION 'Primary Dashboard did not consume the current billing attention facts';
    END IF;
    landing:=public.billing_landing_aggregates(studio,now()-INTERVAL '1 month',now());
    IF landing->>'failed_payer_count' IS DISTINCT FROM '3'
       OR landing->>'open_invoice_amount_cents' IS DISTINCT FROM '850' THEN
        RAISE EXCEPTION 'Landing disagrees with scoped current payer facts: %',landing;
    END IF;
    IF EXISTS (SELECT 1 FROM public.list_billing_payers_v1(
        current_setting('balance_test.studio_b')::UUID,today_payer,today))
       OR EXISTS (SELECT 1 FROM public.billing_payer_balance_facts_v1(
        current_setting('balance_test.studio_b')::UUID,today_payer,today)) THEN
        RAISE EXCEPTION 'Collection facts crossed a studio boundary';
    END IF;
END;
$collection_facts$;

RESET ROLE;
CREATE FUNCTION pg_temp.fail_balance_update() RETURNS TRIGGER LANGUAGE plpgsql AS $fault$
BEGIN
    RAISE EXCEPTION 'intentional balance update failure';
END;
$fault$;
CREATE TRIGGER balance_contract_fault BEFORE UPDATE OF balance_cents ON public.billing_payers
FOR EACH ROW EXECUTE FUNCTION pg_temp.fail_balance_update();
SET LOCAL ROLE service_role;
DO $rollback$
DECLARE failed BOOLEAN := false;
BEGIN
    BEGIN
        PERFORM public.recompute_billing_payer_balance_v1(
            current_setting('balance_test.studio_a')::UUID,
            current_setting('balance_test.payer_other')::UUID);
    EXCEPTION WHEN raise_exception THEN
        IF SQLERRM <> 'intentional balance update failure' THEN RAISE; END IF;
        failed := true;
    END;
    IF NOT failed OR (SELECT ROW(balance_cents,billing_status) FROM public.billing_payers
        WHERE id=current_setting('balance_test.payer_other')::UUID)
        IS DISTINCT FROM ROW(66,'failed'::TEXT) THEN
        RAISE EXCEPTION 'Balance update failure did not roll back';
    END IF;
END;
$rollback$;
RESET ROLE;
DROP TRIGGER balance_contract_fault ON public.billing_payers;
SET LOCAL ROLE anon;
DO $anon$
BEGIN
    IF has_function_privilege(current_user,'public.billing_invoice_collection_facts_v1(uuid,uuid,date)','EXECUTE')
       OR has_function_privilege(current_user,'public.billing_attention_count_v1(uuid,date)','EXECUTE')
       OR has_function_privilege(current_user,'public.billing_payer_balance_facts_v1(uuid,uuid,date)','EXECUTE')
       OR has_function_privilege(current_user,'public.list_billing_payers_v1(uuid,uuid,date)','EXECUTE') THEN
        RAISE EXCEPTION 'Unprivileged caller can execute current payer reads';
    END IF;
    BEGIN
        PERFORM public.recompute_billing_payer_balance_v1(NULL,NULL);
        RAISE EXCEPTION 'Anonymous caller unexpectedly executed balance RPC';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
END;
$anon$;
RESET ROLE;
SET LOCAL ROLE authenticated;
DO $authenticated$
BEGIN
    IF has_function_privilege(current_user,'public.billing_invoice_collection_facts_v1(uuid,uuid,date)','EXECUTE')
       OR has_function_privilege(current_user,'public.billing_attention_count_v1(uuid,date)','EXECUTE')
       OR has_function_privilege(current_user,'public.billing_payer_balance_facts_v1(uuid,uuid,date)','EXECUTE')
       OR has_function_privilege(current_user,'public.list_billing_payers_v1(uuid,uuid,date)','EXECUTE') THEN
        RAISE EXCEPTION 'Unprivileged caller can execute current payer reads';
    END IF;
    BEGIN
        PERFORM public.recompute_billing_payer_balance_v1(NULL,NULL);
        RAISE EXCEPTION 'Authenticated caller unexpectedly executed balance RPC';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
END;
$authenticated$;
ROLLBACK;
