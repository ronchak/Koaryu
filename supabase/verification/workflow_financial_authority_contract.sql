-- Financial ordering/evidence only; execute on the guarded disposable PG17 clone.
BEGIN;
SET LOCAL statement_timeout='60s';
CREATE TEMP TABLE financial_checks(label TEXT PRIMARY KEY);
CREATE FUNCTION pg_temp.financial_check(ok BOOLEAN,label TEXT) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
    IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'financial contract failed: %',label; END IF;
    INSERT INTO pg_temp.financial_checks VALUES(label);
END $$;
CREATE FUNCTION pg_temp.financial_error(statement TEXT,code TEXT,message TEXT,label TEXT) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE got_code TEXT; got_message TEXT;
BEGIN
    BEGIN EXECUTE statement; EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS got_code=RETURNED_SQLSTATE,got_message=MESSAGE_TEXT; END;
    IF got_code IS DISTINCT FROM code OR (message IS NOT NULL AND got_message IS DISTINCT FROM message) THEN
        RAISE EXCEPTION 'financial negative failed %: % (%) expected % (%)',label,got_code,got_message,code,message;
    END IF;
    PERFORM pg_temp.financial_check(true,label);
END $$;
-- fixture owners start: also installed under financial_proof by the guarded runner.
CREATE FUNCTION pg_temp.financial_fixture(with_staff BOOLEAN DEFAULT true) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE s UUID:=gen_random_uuid(); a UUID:=gen_random_uuid(); y UUID:=gen_random_uuid(); i UUID:=gen_random_uuid();
BEGIN
    INSERT INTO auth.users(id,email,email_confirmed_at) VALUES(a,a||'@example.invalid',clock_timestamp());
    INSERT INTO public.studios(id,name,slug,owner_id,timezone) VALUES(s,'Financial authority proof',s::TEXT,a,'UTC');
    IF with_staff THEN INSERT INTO public.staff_roles(studio_id,user_id,role) VALUES(s,a,'admin'); END IF;
    INSERT INTO public.studio_subscriptions(studio_id,status,comped) VALUES(s,'active',false);
    INSERT INTO public.studio_payment_accounts(studio_id,stripe_connected_account_id,metadata)
        VALUES(s,'acct_'||replace(s::TEXT,'-',''),'{"connect_account_generation":1}');
    INSERT INTO public.billing_payers(id,studio_id,display_name,stripe_account_id,stripe_customer_id,connect_account_generation)
        VALUES(y,s,'Synthetic payer','acct_'||replace(s::TEXT,'-',''),'cus_'||y,1);
    INSERT INTO public.billing_invoices(id,studio_id,payer_id,status,currency,amount_due_cents,amount_paid_cents,amount_remaining_cents,
        stripe_account_id,stripe_customer_id,stripe_invoice_id,metadata)
        VALUES(i,s,y,'open','usd',1000000,125,900000,'acct_'||replace(s::TEXT,'-',''),'cus_'||y,'in_'||i,'{"connect_account_generation":1}');
    RETURN jsonb_build_object('studio',s,'actor',a,'payer',y,'invoice',i);
END $$;
CREATE FUNCTION pg_temp.financial_payment(x JSONB,status TEXT DEFAULT 'succeeded',changes JSONB DEFAULT '{}',payment_id UUID DEFAULT gen_random_uuid())
RETURNS UUID LANGUAGE plpgsql AS $$
DECLARE p public.billing_payments; data JSONB;
BEGIN
    data:=jsonb_build_object('id',payment_id,'studio_id',x->>'studio','payer_id',x->>'payer','invoice_id',x->>'invoice',
        'status',status,'amount_cents',100,'currency','usd','stripe_account_id','acct_'||replace(x->>'studio','-',''),
        'stripe_customer_id','cus_'||(x->>'payer'),'stripe_invoice_id','in_'||(x->>'invoice'),'connect_account_generation',1,
        'payment_method_type',CASE WHEN status='externally_recorded' THEN 'external' ELSE 'card' END,
        'external_method',CASE WHEN status='externally_recorded' THEN 'Cash' END,'metadata','{}'::JSONB,
        'adjustment_reconciliation_required',false)||changes;
    p:=jsonb_populate_record(NULL::public.billing_payments,data);
    INSERT INTO public.billing_payments(id,studio_id,payer_id,invoice_id,status,amount_cents,currency,stripe_account_id,
        stripe_customer_id,stripe_invoice_id,stripe_payment_intent_id,stripe_charge_id,connect_account_generation,
        payment_method_type,external_method,metadata,adjustment_reconciliation_required,idempotency_key,
        net_collected_amount_cents,refundable_amount_cents)
        VALUES(p.id,p.studio_id,p.payer_id,p.invoice_id,p.status,p.amount_cents,p.currency,p.stripe_account_id,
            p.stripe_customer_id,p.stripe_invoice_id,p.stripe_payment_intent_id,p.stripe_charge_id,p.connect_account_generation,
            p.payment_method_type,p.external_method,p.metadata,p.adjustment_reconciliation_required,p.id::TEXT,
            CASE WHEN p.status IN ('succeeded','refunded','disputed','externally_recorded') THEN p.amount_cents ELSE 0 END,
            CASE WHEN p.status IN ('succeeded','refunded','disputed','externally_recorded') AND p.stripe_charge_id IS NOT NULL THEN p.amount_cents ELSE 0 END);
    RETURN payment_id;
END $$;
CREATE FUNCTION pg_temp.financial_workflow(x JSONB,event_type TEXT DEFAULT 'invoice.payment_failed') RETURNS UUID LANGUAGE plpgsql AS $$
DECLARE r JSONB; w UUID; g JSONB:=jsonb_build_object('schema_version',1,'nodes',jsonb_build_array(
    jsonb_build_object('id','trigger','type','trigger','config',jsonb_build_object('event_type',event_type,'program_id',NULL)),
    '{"id":"mail","type":"email","config":{"recipient":"invoice_payer","subject_template":"Proof","body_template":"Proof","reply_to_email":""}}'::JSONB,
    '{"id":"end","type":"end","config":{}}'::JSONB),'edges','[{"id":"next","source":"trigger","target":"mail","port":"next"},{"id":"done","source":"mail","target":"end","port":"next"}]'::JSONB);
BEGIN
    r:=public.create_automation_workflow_v1((x->>'studio')::UUID,(x->>'actor')::UUID,gen_random_uuid(),'Financial proof','',g,'{}');
    w:=(r#>>'{payload,id}')::UUID;
    PERFORM public.command_automation_workflow_v1((x->>'studio')::UUID,(x->>'actor')::UUID,w,gen_random_uuid(),1,'publish');
    PERFORM public.command_automation_workflow_v1((x->>'studio')::UUID,(x->>'actor')::UUID,w,gen_random_uuid(),2,'start');
    RETURN w;
END $$;
CREATE FUNCTION pg_temp.financial_state(s UUID) RETURNS JSONB LANGUAGE sql AS $$
    SELECT jsonb_build_object('authority',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY invoice_id),'[]') FROM private.workflow_invoice_settlement_authority t WHERE studio_id=s),
        'observations',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY payment_id),'[]') FROM private.workflow_payment_settlement_observations t WHERE studio_id=s),
        'payments',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]') FROM public.billing_payments t WHERE studio_id=s),
        'invoices',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]') FROM public.billing_invoices t WHERE studio_id=s),
        'payers',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]') FROM public.billing_payers t WHERE studio_id=s),
        'account',(SELECT to_jsonb(t) FROM public.studio_payment_accounts t WHERE studio_id=s),
        'markers',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY payment_id),'[]') FROM private.workflow_payment_capture_markers t WHERE studio_id=s),
        'events',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]') FROM private.automation_workflow_events t WHERE studio_id=s),
        'runs',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]') FROM public.automation_workflow_runs t WHERE studio_id=s));
$$;
-- fixture owners end.
DO $$
DECLARE r RECORD; spec TEXT; x JSONB; s UUID; i UUID; p UUID; q UUID; w UUID; before JSONB; evidence JSONB; identity JSONB;
    row public.billing_payments; result JSONB; item JSONB; n INTEGER; gen BIGINT; rid UUID; seen TIMESTAMPTZ; first JSONB;
BEGIN
    FOR r IN SELECT * FROM pg_class WHERE oid IN ('private.workflow_invoice_settlement_authority'::REGCLASS,
        'private.workflow_payment_settlement_observations'::REGCLASS) LOOP
        PERFORM pg_temp.financial_check(r.relpersistence='p' AND r.relrowsecurity AND pg_get_userbyid(r.relowner)='postgres','logged RLS owner '||r.relname);
        PERFORM pg_temp.financial_check(NOT has_table_privilege('anon',r.oid,'SELECT,INSERT,UPDATE,DELETE')
            AND NOT has_table_privilege('authenticated',r.oid,'SELECT,INSERT,UPDATE,DELETE')
            AND has_table_privilege('service_role',r.oid,'SELECT,INSERT,UPDATE') AND NOT has_table_privilege('service_role',r.oid,'DELETE'),'exact table privileges '||r.relname);
        PERFORM pg_temp.financial_check((SELECT count(*)=1 AND bool_and(confrelid='public.studios'::REGCLASS AND confdeltype='c')
            FROM pg_constraint WHERE conrelid=r.oid AND contype='f'),'studio-only cascade '||r.relname);
    END LOOP;
    FOREACH spec IN ARRAY ARRAY['workflow_invoice_settlement_seed_v1()','workflow_payment_evidence_v1(public.billing_payments)',
        'workflow_payment_evidence_valid_v1(jsonb)','workflow_payment_settlement_valid_v1(uuid,uuid)',
        'workflow_invoice_financial_context_v1(uuid,uuid,uuid)','workflow_prepare_financial_context_v1(uuid,uuid,uuid)',
        'workflow_observe_payment_settlement_v1(uuid,uuid)','workflow_cancel_settled_invoice_runs_v1(uuid,uuid[])',
        'workflow_invoice_settlement_identity_v1()','workflow_settlement_observation_identity_v1()'] LOOP
        SELECT * INTO STRICT r FROM pg_proc WHERE oid=('private.'||spec)::REGPROCEDURE;
        PERFORM pg_temp.financial_check(NOT r.prosecdef AND r.proconfig=ARRAY['search_path=""'] AND pg_get_userbyid(r.proowner)='postgres'
            AND NOT has_function_privilege('anon',r.oid,'EXECUTE') AND NOT has_function_privilege('authenticated',r.oid,'EXECUTE')
            AND has_function_privilege('service_role',r.oid,'EXECUTE')=(r.prorettype<>'trigger'::REGTYPE),'private invoker signature '||spec);
    END LOOP;
    PERFORM pg_temp.financial_check((SELECT bool_and(provolatile='s') FROM pg_proc WHERE oid IN
        ('private.workflow_invoice_financial_context_v1(uuid,uuid,uuid)'::REGPROCEDURE,'private.workflow_payment_settlement_valid_v1(uuid,uuid)'::REGPROCEDURE)),'readers stable');
    PERFORM pg_temp.financial_check((SELECT bool_and(provolatile='i') FROM pg_proc WHERE oid IN
        ('private.workflow_payment_evidence_v1(public.billing_payments)'::REGPROCEDURE,'private.workflow_payment_evidence_valid_v1(jsonb)'::REGPROCEDURE)),'serializers immutable');
    FOR r IN SELECT * FROM (VALUES('public.billing_payments','workflow_capture_payment_failure_v1',21),
        ('public.billing_invoices','workflow_invoice_settlement_seed_v1',5),
        ('private.workflow_invoice_settlement_authority','workflow_invoice_settlement_identity_v1',23),
        ('private.workflow_payment_settlement_observations','workflow_settlement_observation_identity_v1',23)) v(relation,name,kind) LOOP
        PERFORM pg_temp.financial_check((SELECT count(*)=1 AND bool_and(t.tgtype=r.kind AND t.tgenabled='O' AND NOT t.tgisinternal
            AND t.tgfoid=('private.'||r.name||'()')::REGPROCEDURE AND t.tgnargs=0) FROM pg_trigger t
            WHERE t.tgrelid=r.relation::REGCLASS AND t.tgname=r.name),'exact financial trigger '||r.name);
    END LOOP;
    PERFORM pg_temp.financial_check((SELECT array_agg(a.attname::TEXT ORDER BY a.attname) FROM pg_trigger t
        CROSS JOIN LATERAL unnest(t.tgattr) v(attnum) JOIN pg_attribute a ON a.attrelid=t.tgrelid AND a.attnum=v.attnum
        WHERE t.tgrelid='public.billing_payments'::REGCLASS AND t.tgname='workflow_capture_payment_failure_v1')=
        ARRAY['adjustment_reconciliation_reason_code','adjustment_reconciliation_required','amount_cents','connect_account_generation','currency',
            'external_method','invoice_id','metadata','payer_id','payment_method_type','status','stripe_account_id','stripe_charge_id',
            'stripe_customer_id','stripe_invoice_id','stripe_payment_intent_id'],'exact observed payment UPDATE columns');
    x:=pg_temp.financial_fixture(); s:=(x->>'studio')::UUID; i:=(x->>'invoice')::UUID;
    PERFORM pg_temp.financial_check(private.workflow_invoice_financial_context_v1(s,i)=jsonb_build_object('available',true,'currency','USD',
        'unit_convention','stripe_minor_units','invoice_settlement_generation',1),'actual invoice insert seed and provider units');
    before:=pg_temp.financial_state(s); PERFORM private.workflow_invoice_financial_context_v1(s,i); PERFORM private.workflow_payment_settlement_valid_v1(s,gen_random_uuid());
    PERFORM pg_temp.financial_check(pg_temp.financial_state(s)=before,'readers do not write or seed');
    w:=pg_temp.financial_workflow(x); p:=pg_temp.financial_payment(x,'failed');
    SELECT id INTO rid FROM public.automation_workflow_runs WHERE workflow_id=w;
    SELECT context INTO first FROM private.automation_workflow_events WHERE subject_id=p;
    PERFORM pg_temp.financial_check(first->>'invoice_settlement_generation'='1' AND private.workflow_payment_evidence_valid_v1(first->'payment_evidence'),'first failure captures complete bounded evidence');
    q:=pg_temp.financial_payment(x);
    SELECT cancel_requested_at INTO seen FROM public.automation_workflow_runs WHERE id=rid;
    PERFORM pg_temp.financial_check(seen IS NOT NULL AND (SELECT state='cancelled' AND cancel_reason='payment_settled' FROM public.automation_workflow_runs WHERE id=rid),'partial settlement cancels old failure');
    PERFORM pg_temp.financial_check((SELECT status='open' AND amount_remaining_cents=900000 AND amount_paid_cents=125 FROM public.billing_invoices WHERE id=i),'stored balance remains exact');
    SELECT first_evidence,accepted_identity INTO evidence,identity FROM private.workflow_payment_settlement_observations WHERE payment_id=q;
    UPDATE public.billing_payments SET metadata='{"unrelated":"ignored"}',status='succeeded' WHERE id=q;
    PERFORM private.recompute_billing_payment_adjustment_totals(q);
    UPDATE public.billing_payments SET stripe_payment_intent_id='pi_enriched',stripe_charge_id='ch_enriched',refundable_amount_cents=100 WHERE id=q;
    PERFORM pg_temp.financial_check((SELECT generation=2 FROM private.workflow_invoice_settlement_authority WHERE invoice_id=i)
        AND (SELECT first_evidence=evidence AND accepted_identity=identity FROM private.workflow_payment_settlement_observations WHERE payment_id=q),'duplicate adjustment and optional enrichment preserve acceptance');
    p:=pg_temp.financial_payment(x,'failed');
    PERFORM pg_temp.financial_check((SELECT context->>'invoice_settlement_generation'='2' FROM private.automation_workflow_events WHERE subject_id=p),'new failure binds later generation');
    UPDATE public.billing_payments SET status='refunded',refunded_amount_cents=100,net_collected_amount_cents=0,refundable_amount_cents=0 WHERE id=q;
    PERFORM pg_temp.financial_check((SELECT NOT uncertain FROM private.workflow_payment_settlement_observations WHERE payment_id=q),'refund alone preserves accepted truth');
    DELETE FROM public.billing_payments WHERE id=q;
    PERFORM pg_temp.financial_check((SELECT generation=2 FROM private.workflow_invoice_settlement_authority WHERE invoice_id=i)
        AND (SELECT cancel_requested_at=seen FROM public.automation_workflow_runs WHERE id=rid),'refund and deletion never revive old cancellation');
    q:=pg_temp.financial_payment(x,'externally_recorded','{"stripe_account_id":null,"stripe_customer_id":null,"stripe_invoice_id":null,"connect_account_generation":null}');
    PERFORM pg_temp.financial_check(private.workflow_payment_settlement_valid_v1(s,q) AND (SELECT generation=3 FROM private.workflow_invoice_settlement_authority WHERE invoice_id=i),'linked retained external USD convention');
    before:=pg_temp.financial_state(s);
    PERFORM pg_temp.financial_error(format('UPDATE private.workflow_invoice_settlement_authority SET generation=generation+2 WHERE invoice_id=%L',i),'P0001','AUTOMATION_STATE_CONFLICT','generation cannot skip');
    PERFORM pg_temp.financial_error(format('UPDATE private.workflow_payment_settlement_observations SET baseline=true WHERE payment_id=%L',q),'P0001','AUTOMATION_STATE_CONFLICT','baseline immutable');
    PERFORM pg_temp.financial_error(format('UPDATE private.workflow_payment_settlement_observations SET accepted_generation=NULL,accepted_identity=NULL WHERE payment_id=%L',q),'P0001','AUTOMATION_STATE_CONFLICT','acceptance cannot be removed');
    PERFORM pg_temp.financial_error(format('UPDATE private.workflow_payment_settlement_observations SET first_evidence=first_evidence||%L::jsonb WHERE payment_id=%L','{"demo":true}',q),'P0001','AUTOMATION_STATE_CONFLICT','first evidence immutable');
    PERFORM pg_temp.financial_check(pg_temp.financial_state(s)=before,'identity refusals are atomic');
    -- Source normalization is total, preserving invalid-null versus actual absence.
    SELECT * INTO row FROM public.billing_payments WHERE id=q;
    row.currency:=' USD'; row.stripe_account_id:=repeat('s',256); row.external_method:=chr(133); row.payment_method_type:=' bad';
    row.metadata:='{"demo":"true","arbitrary":"not retained"}'; evidence:=private.workflow_payment_evidence_v1(row);
    PERFORM pg_temp.financial_check(private.workflow_payment_evidence_valid_v1(evidence) AND evidence->'invalid_fields'=
        '["currency","external_method","payment_method_type","stripe_account_id"]'::JSONB AND evidence->'demo'='false'::JSONB
        AND NOT evidence::TEXT LIKE '%arbitrary%' AND evidence->'stripe_account_id'='null'::JSONB,'bounded invalid field representation and exact demo true');
    row.currency:='usd'; row.stripe_account_id:=repeat(chr(34),255); row.stripe_customer_id:=repeat(chr(92),255);
    row.stripe_invoice_id:=repeat(chr(34),255); row.stripe_payment_intent_id:=repeat(chr(92),255); row.stripe_charge_id:=repeat(chr(34),255);
    row.payment_method_type:=repeat(chr(34),80); row.external_method:=repeat(U&'\+01f600',80); row.metadata:='{"demo":true}';
    row.amount_cents:=2147483647;row.connect_account_generation:=2147483647;row.status:='externally_recorded';
    evidence:=private.workflow_payment_evidence_v1(row);
    PERFORM pg_temp.financial_check(private.workflow_payment_evidence_valid_v1(evidence) AND octet_length(evidence::TEXT)<=4096
        AND evidence->'invalid_fields'='[]'::JSONB AND evidence->'demo'='true'::JSONB,'max escaped identifiers and four-byte display text fit cap');
    FOREACH item IN ARRAY ARRAY[evidence-'demo',evidence||'{"demo":null}',evidence||'{"extra":1}',evidence||'{"amount_cents":1.5}',
        evidence||'{"currency":"usd"}',evidence||'{"invalid_fields":["demo"]}',evidence||'{"invalid_fields":["currency","currency"]}']::JSONB[] LOOP
        PERFORM pg_temp.financial_check(NOT private.workflow_payment_evidence_valid_v1(item),'invalid closed envelope '||md5(item::TEXT));
    END LOOP;
    -- Every legally admitted malformed positive persists bounded uncertainty.
    FOR item IN SELECT value FROM jsonb_array_elements('[{"amount_cents":0},{"currency":"US D"},{"connect_account_generation":null},
        {"metadata":{"demo":true}},{"adjustment_reconciliation_required":true},{"stripe_invoice_id":"wrong"},
        {"payment_method_type":" bad"},{"stripe_account_id":""}]') LOOP
        x:=pg_temp.financial_fixture(); s:=(x->>'studio')::UUID; i:=(x->>'invoice')::UUID; p:=pg_temp.financial_payment(x,'succeeded',item);
        PERFORM pg_temp.financial_check((SELECT uncertain AND accepted_generation IS NULL FROM private.workflow_payment_settlement_observations WHERE payment_id=p)
            AND private.workflow_invoice_financial_context_v1(s,i)->'available'='false'::JSONB,'purported positive uncertain '||item::TEXT);
        DELETE FROM public.billing_payments WHERE id=p;
        PERFORM pg_temp.financial_check(private.workflow_invoice_financial_context_v1(s,i)->'available'='false'::JSONB,'deleted uncertainty retained '||item::TEXT);
    END LOOP;
    -- Repair a mutable original error, retaining its first invalid evidence.
    x:=pg_temp.financial_fixture(); s:=(x->>'studio')::UUID; i:=(x->>'invoice')::UUID;
    p:=pg_temp.financial_payment(x,'succeeded','{"currency":"bad text"}');
    SELECT first_evidence INTO evidence FROM private.workflow_payment_settlement_observations WHERE payment_id=p;
    UPDATE public.billing_payments SET currency='usd' WHERE id=p;
    PERFORM pg_temp.financial_check((SELECT NOT uncertain AND accepted_generation=2 AND first_evidence=evidence FROM private.workflow_payment_settlement_observations WHERE payment_id=p),'correction accepts once without rewriting invalid evidence');
    UPDATE public.billing_payments SET currency='EUR' WHERE id=p;
    UPDATE public.billing_invoices SET currency='EUR' WHERE id=i;
    PERFORM pg_temp.financial_check(private.workflow_invoice_financial_context_v1(s,i)->'available'='false'::JSONB,'accepted identity remains binding even when parents match changed currency');
    UPDATE public.billing_invoices SET currency='usd' WHERE id=i; UPDATE public.billing_payments SET currency='usd' WHERE id=p;
    PERFORM pg_temp.financial_check((SELECT NOT uncertain AND accepted_generation=2 FROM private.workflow_payment_settlement_observations WHERE payment_id=p),'accepted identity restoration resolves without advancing');
    UPDATE public.billing_payments SET status='failed',net_collected_amount_cents=0 WHERE id=p;
    PERFORM pg_temp.financial_check((SELECT uncertain FROM private.workflow_payment_settlement_observations WHERE payment_id=p)
        AND (SELECT count(*)=1 FROM private.automation_workflow_events WHERE subject_id=p),'contradicted accepted failure is captured but unavailable');
    -- Source missing/malformed generation, account and current payer are unavailable.
    x:=pg_temp.financial_fixture(); s:=(x->>'studio')::UUID; i:=(x->>'invoice')::UUID;
    FOREACH item IN ARRAY ARRAY['{}'::JSONB,'{"connect_account_generation":null}','{"connect_account_generation":"0"}',
        '{"connect_account_generation":2147483648}',jsonb_build_object('connect_account_generation',repeat('9',100000))] LOOP
        UPDATE public.billing_invoices SET metadata=item WHERE id=i;
        PERFORM pg_temp.financial_check(private.workflow_invoice_financial_context_v1(s,i)->'available'='false'::JSONB,'invoice explicit generation '||md5(item::TEXT));
    END LOOP;
    UPDATE public.billing_invoices SET metadata='{"connect_account_generation":1}' WHERE id=i;
    UPDATE public.studio_payment_accounts SET metadata=jsonb_build_object('connect_account_generation',repeat('9',100000)) WHERE studio_id=s;
    PERFORM pg_temp.financial_check(private.workflow_invoice_financial_context_v1(s,i)->'available'='false'::JSONB,'huge account generation safely unavailable');
    UPDATE public.studio_payment_accounts SET metadata='{}' WHERE studio_id=s;
    PERFORM pg_temp.financial_check(private.workflow_invoice_financial_context_v1(s,i)->'available'='true'::JSONB,'only actual account permits legacy generation');
    DELETE FROM public.studio_payment_accounts WHERE studio_id=s;
    PERFORM pg_temp.financial_check(private.workflow_invoice_financial_context_v1(s,i)->'available'='false'::JSONB,'missing account never fabricated');
    -- Both aggregate status sets must preserve exact currency/parent evidence.
    FOR spec IN SELECT unnest(ARRAY['succeeded','refunded','disputed','externally_recorded']) LOOP
        x:=pg_temp.financial_fixture(); s:=(x->>'studio')::UUID; i:=(x->>'invoice')::UUID;
        p:=pg_temp.financial_payment(x,spec);
        before:=(SELECT to_jsonb(b) FROM public.billing_invoices b WHERE id=i);
        PERFORM pg_temp.financial_check(private.workflow_invoice_financial_context_v1(s,i)->'available'='true'::JSONB,'matching contributor '||spec);
        UPDATE public.billing_payments SET currency='EUR' WHERE id=p;
        PERFORM pg_temp.financial_check(private.workflow_invoice_financial_context_v1(s,i)->'available'='false'::JSONB
            AND (SELECT to_jsonb(b)=before FROM public.billing_invoices b WHERE id=i),'mismatched contributor does not change balance '||spec);
    END LOOP;
    x:=pg_temp.financial_fixture(); s:=(x->>'studio')::UUID; i:=(x->>'invoice')::UUID;
    p:=pg_temp.financial_payment(x,'refunded','{"payment_method_type":null,"external_method":"Cash","stripe_account_id":null}');
    PERFORM pg_temp.financial_check(private.workflow_invoice_financial_context_v1(s,i)->'available'='false'::JSONB,'missing contributor identity cannot pass nullable predicate');
    UPDATE public.billing_invoices SET currency='ZZZ' WHERE id=i; DELETE FROM public.billing_payments WHERE id=p;
    PERFORM pg_temp.financial_check(private.workflow_invoice_financial_context_v1(s,i)->>'currency'='ZZZ','unsupported well formed currency stays known');
    UPDATE public.billing_invoices SET external=true WHERE id=i;
    PERFORM pg_temp.financial_check(private.workflow_invoice_financial_context_v1(s,i)->'available'='false'::JSONB,'arbitrary local invoice has no unit authority');
    -- A known orphan accepts exactly once on actual late association.
    x:=pg_temp.financial_fixture(); s:=(x->>'studio')::UUID; i:=(x->>'invoice')::UUID;
    p:=pg_temp.financial_payment(x,'succeeded','{"invoice_id":null}');
    PERFORM pg_temp.financial_check((SELECT invoice_id IS NULL AND uncertain FROM private.workflow_payment_settlement_observations WHERE payment_id=p),'orphan positive retained');
    UPDATE public.billing_payments SET invoice_id=i WHERE id=p;
    PERFORM pg_temp.financial_check((SELECT invoice_id=i AND accepted_generation=2 AND NOT uncertain FROM private.workflow_payment_settlement_observations WHERE payment_id=p),'orphan late link accepted once');
    DELETE FROM public.billing_payments WHERE id=p;
    INSERT INTO public.billing_invoices(id,studio_id,payer_id,status,currency,amount_due_cents,stripe_account_id,stripe_customer_id,stripe_invoice_id,metadata)
        SELECT gen_random_uuid(),studio_id,payer_id,'open',currency,amount_due_cents,stripe_account_id,stripe_customer_id,'in_other_'||id,metadata
        FROM public.billing_invoices WHERE id=i RETURNING id INTO q;
    PERFORM pg_temp.financial_payment(x||jsonb_build_object('invoice',q),'failed',jsonb_build_object('stripe_invoice_id','in_other_'||i),p);
    PERFORM pg_temp.financial_check((SELECT invoice_id=i AND uncertain FROM private.workflow_payment_settlement_observations WHERE payment_id=p)
        AND private.workflow_invoice_financial_context_v1(s,i)->'available'='false'::JSONB
        AND private.workflow_invoice_financial_context_v1(s,q,p)->'available'='false'::JSONB,'logical payment reuse keeps original association and blocks both contexts');
    -- Bound repair includes no more than 20 observations, with current parents first.
    FOREACH n IN ARRAY ARRAY[0,1,20,21] LOOP
        x:=pg_temp.financial_fixture(); s:=(x->>'studio')::UUID; i:=(x->>'invoice')::UUID;
        UPDATE public.billing_payers SET stripe_account_id=NULL,stripe_customer_id=NULL,connect_account_generation=NULL WHERE id=(x->>'payer')::UUID;
        FOR gen IN 1..n LOOP PERFORM pg_temp.financial_payment(x); END LOOP;
        UPDATE public.billing_payers SET stripe_account_id='acct_'||replace(s::TEXT,'-',''),stripe_customer_id='cus_'||(x->>'payer'),connect_account_generation=1 WHERE id=(x->>'payer')::UUID;
        before:=pg_temp.financial_state(s); PERFORM private.workflow_invoice_financial_context_v1(s,i);
        PERFORM pg_temp.financial_check(pg_temp.financial_state(s)=before,'read never repairs count '||n);
        result:=private.workflow_prepare_financial_context_v1(s,i);
        PERFORM pg_temp.financial_check((SELECT count(*)=least(n,20) FROM private.workflow_payment_settlement_observations WHERE studio_id=s AND NOT uncertain)
            AND (result->>'available')::BOOLEAN=(n<=20),'bounded repair count '||n);
    END LOOP;
    x:=pg_temp.financial_fixture(); s:=(x->>'studio')::UUID; i:=(x->>'invoice')::UUID;
    p:=pg_temp.financial_payment(x,'succeeded','{"currency":"bad"}');
    UPDATE public.billing_payments SET status='refunded' WHERE id=p;
    UPDATE public.billing_payments SET currency='usd' WHERE id=p;
    PERFORM private.workflow_prepare_financial_context_v1(s,i);
    PERFORM pg_temp.financial_check((SELECT uncertain AND accepted_generation IS NULL FROM private.workflow_payment_settlement_observations WHERE payment_id=p),'refunded-only correction cannot grant new acceptance');
    -- Operational deletion retains logical evidence; only the studio cascades it.
    DELETE FROM public.billing_payments WHERE studio_id=s; DELETE FROM public.billing_invoices WHERE studio_id=s;
    PERFORM pg_temp.financial_check((SELECT count(*)=1 FROM private.workflow_invoice_settlement_authority WHERE studio_id=s)
        AND (SELECT count(*)=1 FROM private.workflow_payment_settlement_observations WHERE studio_id=s),'financial parent deletion retains private evidence');
    -- Supported physical cascade fixture has no staff memberships; the retained last-admin guard stays active.
    x:=pg_temp.financial_fixture(false);s:=(x->>'studio')::UUID;PERFORM pg_temp.financial_payment(x);
    DELETE FROM public.studios WHERE id=s;
    PERFORM pg_temp.financial_check(NOT EXISTS(SELECT 1 FROM private.workflow_invoice_settlement_authority WHERE studio_id=s)
        AND NOT EXISTS(SELECT 1 FROM private.workflow_payment_settlement_observations WHERE studio_id=s),'actual studio deletion cascades private evidence');
END $$;
-- Table CHECK proof independently of its stricter runtime identity trigger.
CREATE TEMP TABLE financial_observation_shape (LIKE private.workflow_payment_settlement_observations INCLUDING CONSTRAINTS);
SELECT pg_temp.financial_error('INSERT INTO financial_observation_shape(payment_id,studio_id,first_evidence,baseline,uncertain) VALUES(gen_random_uuid(),gen_random_uuid(),''{}'',true,true)',
    '23514',NULL,'baseline CHECK rejects missing acceptance');
CREATE FUNCTION pg_temp.financial_inject() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF current_setting('koaryu.financial_fail',true)=NEW.payment_id::TEXT THEN RAISE EXCEPTION 'FINANCIAL_INJECTED_FAILURE'; END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER financial_test_failure AFTER UPDATE ON private.workflow_payment_settlement_observations FOR EACH ROW EXECUTE FUNCTION pg_temp.financial_inject();
DO $$
DECLARE x JSONB; s UUID; i UUID; p UUID; q UUID; w UUID; r UUID; step UUID; a UUID; before JSONB; result JSONB; packet JSONB; context JSONB;
    entry JSONB; record_before JSONB; st TEXT; at TIMESTAMPTZ:=clock_timestamp();
BEGIN
    x:=pg_temp.financial_fixture(); s:=(x->>'studio')::UUID; i:=(x->>'invoice')::UUID; w:=pg_temp.financial_workflow(x);
    p:=pg_temp.financial_payment(x,'failed'); SELECT e.context INTO context FROM private.automation_workflow_events e WHERE subject_id=p;
    packet:=private.workflow_prepare_capture_v1(s);before:=pg_temp.financial_state(s);
    FOREACH entry IN ARRAY ARRAY[jsonb_set(context,'{invoice_settlement_generation}','null'),jsonb_set(context,'{invoice_id}','null'),
        jsonb_set(context,'{payment_evidence,status}','"succeeded"')] LOOP
        PERFORM pg_temp.financial_error(format('SELECT private.workflow_capture_events_v1(%L,%L,%L)',s,jsonb_build_array(jsonb_build_object(
            'event_type','invoice.payment_failed','source_key',gen_random_uuid()::TEXT,'subject_kind','invoice','subject_id',p,
            'occurred_at',private.automation_utc_text_v1(clock_timestamp()),'context',entry)),packet),'22023','AUTOMATION_INVALID_REQUEST','failure context pairing '||md5(entry::TEXT));
    END LOOP;
    PERFORM pg_temp.financial_check(pg_temp.financial_state(s)=before,'malformed failure batches leave complete state unchanged');
    -- Missing ledger is a deliberately corrupted private fixture, never a production repair.
    DELETE FROM private.workflow_invoice_settlement_authority WHERE studio_id=s AND invoice_id=i;
    before:=pg_temp.financial_state(s);
    PERFORM pg_temp.financial_error(format('SELECT pg_temp.financial_payment(%L,''failed'')',x),'P0001','AUTOMATION_STATE_CONFLICT','linked missing ledger refuses without generation zero');
    PERFORM pg_temp.financial_check(pg_temp.financial_state(s)=before AND private.workflow_invoice_financial_context_v1(s,i)->'available'='false'::JSONB,'missing ledger refusal leaves no payment or marker');
    INSERT INTO private.workflow_invoice_settlement_authority VALUES(s,i,1);
    -- Synthetic maximum ledger fixture; restore the exact private guard before invoking any source owner.
    ALTER TABLE private.workflow_invoice_settlement_authority DISABLE TRIGGER workflow_invoice_settlement_identity_v1;
    UPDATE private.workflow_invoice_settlement_authority SET generation=9223372036854775807 WHERE invoice_id=i;
    ALTER TABLE private.workflow_invoice_settlement_authority ENABLE TRIGGER workflow_invoice_settlement_identity_v1;
    before:=pg_temp.financial_state(s);
    PERFORM pg_temp.financial_error(format('SELECT pg_temp.financial_payment(%L)',x),'P0001','AUTOMATION_STATE_CONFLICT','generation overflow refuses atomically');
    PERFORM pg_temp.financial_check(pg_temp.financial_state(s)=before,'overflow leaves no source evidence or cancellation');
    -- Rollback on a later repair candidate removes prior generation/acceptance/cancellation work.
    x:=pg_temp.financial_fixture(); s:=(x->>'studio')::UUID; i:=(x->>'invoice')::UUID; w:=pg_temp.financial_workflow(x);PERFORM pg_temp.financial_payment(x,'failed');
    UPDATE public.billing_payers SET stripe_account_id=NULL,stripe_customer_id=NULL,connect_account_generation=NULL WHERE id=(x->>'payer')::UUID;
    p:=pg_temp.financial_payment(x);q:=pg_temp.financial_payment(x);
    UPDATE public.billing_payers SET stripe_account_id='acct_'||replace(s::TEXT,'-',''),stripe_customer_id='cus_'||(x->>'payer'),connect_account_generation=1 WHERE id=(x->>'payer')::UUID;
    PERFORM set_config('koaryu.financial_fail',greatest(p,q)::TEXT,true);before:=pg_temp.financial_state(s);
    PERFORM pg_temp.financial_error(format('SELECT private.workflow_prepare_financial_context_v1(%L,%L)',s,i),'P0001','FINANCIAL_INJECTED_FAILURE','later repair failure aborts complete batch');
    PERFORM pg_temp.financial_check(pg_temp.financial_state(s)=before,'later repair failure leaves no partial private or workflow state');
    PERFORM set_config('koaryu.financial_fail','',true);PERFORM private.workflow_prepare_financial_context_v1(s,i);
    -- Preserve actual step/attempt/receipt metadata and first intent on sending and unknown paths.
    FOREACH st IN ARRAY ARRAY['sending','unknown'] LOOP
        x:=pg_temp.financial_fixture();s:=(x->>'studio')::UUID;i:=(x->>'invoice')::UUID;w:=pg_temp.financial_workflow(x);p:=pg_temp.financial_payment(x,'failed');
        SELECT id INTO r FROM public.automation_workflow_runs WHERE workflow_id=w;
        UPDATE public.automation_workflow_runs SET state=st,current_node_id='mail',next_due_at=NULL,claim_token=gen_random_uuid(),lease_expires_at=at+INTERVAL '1 hour',reason='old_truth' WHERE id=r;
        INSERT INTO private.automation_workflow_run_steps(studio_id,run_id,sequence,node_id,node_type,outcome,entered_at)
            VALUES(s,r,1,'mail','email','sending',at) RETURNING id INTO step;
        INSERT INTO private.automation_workflow_email_attempts(studio_id,run_id,step_id,node_id,attempt_number,state,recipient_email,recipient_kind,began_at)
            VALUES(s,r,step,'mail',1,'sending','synthetic@example.invalid','invoice_payer',at) RETURNING id INTO a;
        SELECT jsonb_build_object('step',to_jsonb(t),'attempt',to_jsonb(d),'receipts',(SELECT jsonb_agg(to_jsonb(o) ORDER BY operation_id)
            FROM private.automation_command_operations o WHERE studio_id=s)) INTO record_before
            FROM private.automation_workflow_run_steps t,private.automation_workflow_email_attempts d WHERE t.id=step AND d.id=a;
        q:=pg_temp.financial_payment(x);
        SELECT to_jsonb(rr) INTO before FROM public.automation_workflow_runs rr WHERE id=r;
        PERFORM private.workflow_cancel_settled_invoice_runs_v1(s,ARRAY[i]);
        PERFORM pg_temp.financial_check((SELECT state=st AND reason='old_truth' AND cancel_reason='payment_settled' AND cancel_requested_at IS NOT NULL
            AND to_jsonb(rr)=before FROM public.automation_workflow_runs rr WHERE id=r),'inflight truth and first intent preserved '||st);
        PERFORM pg_temp.financial_check((SELECT jsonb_build_object('step',to_jsonb(t),'attempt',to_jsonb(d),'receipts',(SELECT jsonb_agg(to_jsonb(o) ORDER BY operation_id)
            FROM private.automation_command_operations o WHERE studio_id=s))=record_before FROM private.automation_workflow_run_steps t,
            private.automation_workflow_email_attempts d WHERE t.id=step AND d.id=a),'step attempt original receipts unchanged '||st);
    END LOOP;
    -- Accepted refund identity contradiction survives subsequent payment deletion.
    x:=pg_temp.financial_fixture();s:=(x->>'studio')::UUID;i:=(x->>'invoice')::UUID;p:=pg_temp.financial_payment(x);
    UPDATE public.billing_payments SET status='refunded',currency='EUR' WHERE id=p;
    DELETE FROM public.billing_payments WHERE id=p;
    PERFORM pg_temp.financial_check((SELECT uncertain AND accepted_generation=2 FROM private.workflow_payment_settlement_observations WHERE payment_id=p)
        AND private.workflow_invoice_financial_context_v1(s,i)->'available'='false'::JSONB,'refund identity contradiction remains unavailable after deletion');
    -- External method retains USD units after an adjustment owner restores succeeded status.
    x:=pg_temp.financial_fixture();s:=(x->>'studio')::UUID;i:=(x->>'invoice')::UUID;
    UPDATE public.billing_invoices SET currency='EUR' WHERE id=i;
    p:=pg_temp.financial_payment(x,'succeeded','{"currency":"EUR","payment_method_type":"external","external_method":"Cash"}');
    PERFORM pg_temp.financial_check(NOT private.workflow_payment_settlement_valid_v1(s,p) AND (SELECT uncertain FROM private.workflow_payment_settlement_observations WHERE payment_id=p),'external method cannot bypass USD with succeeded status');
    UPDATE public.billing_payments SET status='refunded' WHERE id=p;
    PERFORM private.recompute_billing_payment_adjustment_totals(p);
    PERFORM pg_temp.financial_check((SELECT status='succeeded' AND payment_method_type='external' FROM public.billing_payments WHERE id=p)
        AND NOT private.workflow_payment_settlement_valid_v1(s,p),'actual adjustment recompute retains external unit convention');
END $$;
SELECT count(*) AS financial_authority_contract_checks FROM financial_checks;
ROLLBACK;
