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
        IS DISTINCT FROM ROW(1000,'past_due'::TEXT) THEN
        RAISE EXCEPTION 'Status inclusion, explicit zero, negative clamp or date preservation failed';
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
    -- manufacture a test of the retained legacy fallback expression.
    IF NOT (SELECT attnotnull FROM pg_catalog.pg_attribute
        WHERE attrelid='public.billing_invoices'::regclass AND attname='amount_remaining_cents') THEN
        RAISE EXCEPTION 'Unexpected nullable invoice remaining-balance schema';
    END IF;
END;
$proof$;

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
    BEGIN
        PERFORM public.recompute_billing_payer_balance_v1(NULL,NULL);
        RAISE EXCEPTION 'Authenticated caller unexpectedly executed balance RPC';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
END;
$authenticated$;
ROLLBACK;
