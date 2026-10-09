-- Local synthetic collection-episode proof. This does not enroll a timed event.
BEGIN;
SET LOCAL statement_timeout='90s';
SET LOCAL TIME ZONE 'UTC';
CREATE TEMP TABLE episode_checks(label TEXT PRIMARY KEY);
CREATE FUNCTION pg_temp.episode_check(ok BOOLEAN,label TEXT) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
    IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'invoice episode contract failed: %',label; END IF;
    INSERT INTO pg_temp.episode_checks VALUES(label);
END $$;
CREATE FUNCTION pg_temp.episode_error(statement TEXT,code TEXT,message TEXT,label TEXT) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE got_code TEXT; got_message TEXT;
BEGIN
    BEGIN EXECUTE statement; EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS got_code=RETURNED_SQLSTATE,got_message=MESSAGE_TEXT; END;
    IF got_code IS DISTINCT FROM code OR (message IS NOT NULL AND got_message IS DISTINCT FROM message) THEN
        RAISE EXCEPTION 'invoice episode negative failed %: % (%) expected % (%)',label,got_code,got_message,code,message;
    END IF;
    PERFORM pg_temp.episode_check(true,label);
END $$;
-- fixture owners start. The runner copies only this named helper block.
CREATE FUNCTION pg_temp.episode_fixture(due DATE DEFAULT CURRENT_DATE+2,finish BOOLEAN DEFAULT true,metadata JSONB DEFAULT '{"connect_account_generation":1}',with_staff BOOLEAN DEFAULT true)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE s UUID:=gen_random_uuid(); a UUID:=gen_random_uuid(); y UUID:=gen_random_uuid(); i UUID:=gen_random_uuid();
BEGIN
    INSERT INTO auth.users(id,email,email_confirmed_at) VALUES(a,a||'@example.invalid',clock_timestamp());
    INSERT INTO public.studios(id,name,slug,owner_id,timezone) VALUES(s,'Invoice episode proof',s::TEXT,a,'UTC');
    IF with_staff THEN INSERT INTO public.staff_roles(studio_id,user_id,role) VALUES(s,a,'admin'); END IF;
    INSERT INTO public.studio_subscriptions(studio_id,status,comped) VALUES(s,'active',false);
    INSERT INTO public.studio_payment_accounts(studio_id,stripe_connected_account_id,metadata)
        VALUES(s,'acct_'||replace(s::TEXT,'-',''),'{"connect_account_generation":1}');
    INSERT INTO public.billing_payers(id,studio_id,display_name,email,stripe_account_id,stripe_customer_id,connect_account_generation)
        VALUES(y,s,'Synthetic payer','payer.'||y||'@example.invalid','acct_'||replace(s::TEXT,'-',''),'cus_'||y,1);
    INSERT INTO public.billing_invoices(id,studio_id,payer_id,status,currency,amount_due_cents,amount_paid_cents,amount_remaining_cents,due_date,
        stripe_account_id,stripe_customer_id,stripe_invoice_id,metadata)
        VALUES(i,s,y,'open','usd',1000,0,1000,due,'acct_'||replace(s::TEXT,'-',''),'cus_'||y,'in_'||i,metadata);
    IF finish THEN PERFORM private.workflow_finalize_invoice_episodes_v1(); END IF;
    RETURN jsonb_build_object('studio',s,'actor',a,'payer',y,'invoice',i);
END $$;
CREATE FUNCTION pg_temp.episode_snapshot(x JSONB) RETURNS JSONB LANGUAGE sql AS $$
    SELECT jsonb_build_object('state',(SELECT to_jsonb(s) FROM private.workflow_invoice_episode_state s WHERE invoice_id=(x->>'invoice')::UUID),
        'episodes',(SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY episode_number),'[]') FROM private.workflow_invoice_collection_episodes e WHERE invoice_id=(x->>'invoice')::UUID),
        'pending',(SELECT coalesce(jsonb_agg(to_jsonb(p)),'[]') FROM private.workflow_invoice_episode_pending p WHERE invoice_id=(x->>'invoice')::UUID),
        'runs',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY id),'[]') FROM public.automation_workflow_runs r WHERE studio_id=(x->>'studio')::UUID));
$$;
CREATE FUNCTION pg_temp.episode_run(x JSONB,kind TEXT DEFAULT 'invoice.overdue',requested_state TEXT DEFAULT 'claimed') RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE w UUID; r UUID; event_id UUID; source UUID:=(x->>'invoice')::UUID; context JSONB; activation public.automation_workflow_activations;
    graph JSONB:=jsonb_build_object('schema_version',1,'nodes',jsonb_build_array(
        jsonb_build_object('id','trigger','type','trigger','config',jsonb_build_object('event_type',kind,'program_id',NULL)),
        '{"id":"mail","type":"email","config":{"recipient":"invoice_payer","subject_template":"Proof","body_template":"Proof","reply_to_email":""}}'::JSONB,
        '{"id":"end","type":"end","config":{}}'::JSONB),
        'edges','[{"id":"next","source":"trigger","target":"mail","port":"next"},{"id":"done","source":"mail","target":"end","port":"next"}]'::JSONB);
BEGIN
    w:=(public.create_automation_workflow_v1((x->>'studio')::UUID,(x->>'actor')::UUID,gen_random_uuid(),'Episode proof','',graph,'{}')#>>'{payload,id}')::UUID;
    PERFORM public.command_automation_workflow_v1((x->>'studio')::UUID,(x->>'actor')::UUID,w,gen_random_uuid(),1,'publish');
    PERFORM public.command_automation_workflow_v1((x->>'studio')::UUID,(x->>'actor')::UUID,w,gen_random_uuid(),2,'start');
    SELECT e.context INTO context FROM private.workflow_invoice_collection_episodes e JOIN private.workflow_invoice_episode_state s ON s.current_episode_id=e.id
        WHERE s.invoice_id=(x->>'invoice')::UUID;
    IF kind='invoice.payment_failed' THEN
        -- Deliberate UUID collision proves event-family filtering, not payment authority.
        context:=jsonb_build_object('payment_id',source,'invoice_id',source,'payer_id',x->'payer','invoice_settlement_generation',1,
            'payment_evidence',jsonb_build_object('invalid_fields','[]'::JSONB));
    END IF;
    INSERT INTO private.automation_workflow_events(studio_id,event_type,source_key,subject_kind,subject_id,occurred_at,context)
        VALUES((x->>'studio')::UUID,kind,'episode-proof:'||gen_random_uuid(),'invoice',source,clock_timestamp(),context) RETURNING id INTO event_id;
    SELECT * INTO activation FROM public.automation_workflow_activations WHERE workflow_id=w AND retired_at IS NULL;
    INSERT INTO public.automation_workflow_runs(studio_id,workflow_id,version_id,event_id,activation_id,epoch,current_node_id)
        VALUES((x->>'studio')::UUID,w,activation.version_id,event_id,activation.id,activation.epoch,'trigger') RETURNING id INTO r;
    IF requested_state<>'queued' THEN
        UPDATE public.automation_workflow_runs SET state=requested_state,
            claim_token=CASE WHEN requested_state IN ('claimed','running','sending') THEN gen_random_uuid() END,
            lease_expires_at=CASE WHEN requested_state IN ('claimed','running','sending') THEN clock_timestamp()+INTERVAL '5 minutes' END,
            next_due_at=CASE WHEN requested_state IN ('queued','waiting','claimed','running') THEN clock_timestamp() END,
            revision=revision+1 WHERE id=r;
    END IF;
    RETURN x||jsonb_build_object('workflow',w,'run',r,'event',event_id,'token',(SELECT claim_token FROM public.automation_workflow_runs WHERE id=r));
END $$;
CREATE FUNCTION pg_temp.episode_rpc(statement TEXT) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE value JSONB; code TEXT; message TEXT;
BEGIN
    EXECUTE statement INTO value;
    RETURN jsonb_build_object('ok',true,'value',value);
EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS code=RETURNED_SQLSTATE,message=MESSAGE_TEXT;
    RETURN jsonb_build_object('ok',false,'code',code,'message',message);
END $$;
-- fixture owners end.
DO $$
DECLARE row RECORD; spec TEXT; x JSONB; y JSONB; before JSONB; after JSONB; result JSONB; snapshot JSONB; item JSONB; changed JSONB;
    i public.billing_invoices; payer public.billing_payers; missing public.billing_payers; original JSONB; expected JSONB; context JSONB;
    s UUID; invoice UUID; old_id UUID; n BIGINT; boundary TIMESTAMPTZ; repeated TIMESTAMPTZ; text_value TEXT; due DATE;
BEGIN
    FOR row IN SELECT * FROM pg_class WHERE oid IN ('private.workflow_invoice_episode_state'::REGCLASS,
        'private.workflow_invoice_collection_episodes'::REGCLASS,'private.workflow_invoice_episode_pending'::REGCLASS) LOOP
        PERFORM pg_temp.episode_check(row.relpersistence='p' AND row.relrowsecurity AND pg_get_userbyid(row.relowner)='postgres','storage '||row.relname);
        PERFORM pg_temp.episode_check(NOT has_table_privilege('anon',row.oid,'SELECT,INSERT,UPDATE,DELETE')
            AND NOT has_table_privilege('authenticated',row.oid,'SELECT,INSERT,UPDATE,DELETE')
            AND has_table_privilege('service_role',row.oid,'SELECT,INSERT,UPDATE')
            AND has_table_privilege('service_role',row.oid,'DELETE')=(row.relname='workflow_invoice_episode_pending'),'table ACL '||row.relname);
    END LOOP;
    PERFORM pg_temp.episode_check((SELECT count(*)=0 FROM pg_constraint WHERE conrelid='private.workflow_invoice_episode_pending'::REGCLASS AND contype='f'),'pending has no parent FK');
    PERFORM pg_temp.episode_check((SELECT count(*)=2 AND bool_and(confrelid IN ('public.studios'::REGCLASS,'private.workflow_invoice_collection_episodes'::REGCLASS))
        FROM pg_constraint WHERE conrelid='private.workflow_invoice_episode_state'::REGCLASS AND contype='f'),'state exact parent FKs');
    PERFORM pg_temp.episode_check((SELECT count(*)=1 AND bool_and(confrelid='private.workflow_invoice_episode_state'::REGCLASS AND confdeltype='c')
        FROM pg_constraint WHERE conrelid='private.workflow_invoice_collection_episodes'::REGCLASS AND contype='f'),'episode exact ownership FK');
    PERFORM pg_temp.episode_check((SELECT indisvalid AND indisready AND pg_get_expr(indpred,indrelid)='((closed_at IS NULL) AND threshold_eligible)'
        FROM pg_index WHERE indexrelid='private.workflow_invoice_episode_active_threshold'::REGCLASS),'active threshold partial index');
    PERFORM pg_temp.episode_check((SELECT tgdeferrable AND tginitdeferred AND tgenabled='O' FROM pg_trigger
        WHERE tgrelid='private.workflow_invoice_episode_pending'::REGCLASS AND tgname='workflow_invoice_episode_deferred'),'owned deferred constraint');
    FOREACH spec IN ARRAY ARRAY['workflow_invoice_episode_context_valid_v1(jsonb)',
        'workflow_invoice_episode_projection_v1(public.billing_invoices,public.billing_payers)','workflow_invoice_episode_threshold_v1(date,text)',
        'workflow_invoice_episode_state_identity_v1()','workflow_invoice_episode_identity_v1()','workflow_invoice_episode_pending_identity_v1()',
        'workflow_queue_invoice_episode_v1(uuid,uuid,boolean,boolean,boolean,text)','workflow_mark_invoice_episode_v1()',
        'workflow_mark_payer_episode_demo_v1()','workflow_finalize_invoice_episodes_v1()','workflow_finalize_invoice_episode_deferred_v1()'] LOOP
        SELECT * INTO STRICT row FROM pg_proc WHERE oid=('private.'||spec)::REGPROCEDURE;
        PERFORM pg_temp.episode_check(NOT row.prosecdef AND row.proconfig=ARRAY['search_path=""'] AND pg_get_userbyid(row.proowner)='postgres'
            AND NOT has_function_privilege('anon',row.oid,'EXECUTE') AND NOT has_function_privilege('authenticated',row.oid,'EXECUTE')
            AND has_function_privilege('service_role',row.oid,'EXECUTE')=(row.prorettype<>'trigger'::REGTYPE),'helper ACL '||spec);
    END LOOP;
    x:=pg_temp.episode_fixture(); invoice:=(x->>'invoice')::UUID; s:=(x->>'studio')::UUID;
    SELECT * INTO i FROM public.billing_invoices WHERE id=invoice;
    SELECT * INTO payer FROM public.billing_payers WHERE id=i.payer_id;
    original:=to_jsonb(i); expected:=private.workflow_invoice_episode_projection_v1(i,payer); context:=expected->'context';
    PERFORM pg_temp.episode_check(expected->>'classification'='open_positive' AND expected->'reason'='null'::JSONB
        AND private.workflow_invoice_episode_context_valid_v1(context) AND (SELECT count(*)=8 FROM jsonb_object_keys(context)),'exact canonical projection');
    PERFORM pg_temp.episode_check((SELECT episode_number=1 AND current_episode_id IS NOT NULL AND NOT ever_removed FROM private.workflow_invoice_episode_state WHERE invoice_id=invoice),'first actual episode');
    PERFORM pg_temp.episode_check((SELECT threshold_eligible AND opened_at<=threshold_at FROM private.workflow_invoice_collection_episodes WHERE invoice_id=invoice),'future episode timing');
    FOREACH text_value IN ARRAY ARRAY['usd','USD','uSd'] LOOP
        i.currency:=text_value;
        FOREACH changed IN ARRAY ARRAY['{"connect_account_generation":1}'::JSONB,'{"connect_account_generation":"1"}'::JSONB] LOOP
            i.metadata:=changed;
            PERFORM pg_temp.episode_check(private.workflow_invoice_episode_projection_v1(i,payer)=expected,'equivalent currency generation '||text_value||changed::TEXT);
        END LOOP;
    END LOOP;
    FOR item IN SELECT value FROM jsonb_array_elements('[{"status":null},{"status":"broken"},{"amount_remaining_cents":null},
        {"due_date":"infinity"},{"due_date":"10000-01-01"},{"currency":null},{"currency":"US"},{"currency":"1SD"},
        {"stripe_account_id":null},{"stripe_customer_id":"bad value"},{"stripe_invoice_id":""},
        {"metadata":{}},{"metadata":{"connect_account_generation":null}},{"metadata":{"connect_account_generation":true}},
        {"metadata":{"connect_account_generation":"01"}},{"metadata":{"connect_account_generation":"1.0"}},
        {"metadata":{"connect_account_generation":2147483648}},{"metadata":{"connect_account_generation":0}}]') LOOP
        i:=jsonb_populate_record(NULL::public.billing_invoices,original||item);
        result:=private.workflow_invoice_episode_projection_v1(i,payer);
        PERFORM pg_temp.episode_check(result='{"classification":"unavailable","reason":"facts_unavailable","context":null}'::JSONB,'malformed uncertainty '||item::TEXT);
        i.amount_remaining_cents:=0;
        PERFORM pg_temp.episode_check(private.workflow_invoice_episode_projection_v1(i,payer)->>'reason'='invoice_not_open','known zero precedence '||item::TEXT);
    END LOOP;
    FOR item IN SELECT value FROM jsonb_array_elements('[{"status":"paid"},{"status":"draft"},{"status":"void"},{"status":"uncollectible"},
        {"status":"refunded"},{"status":"partially_refunded"},{"amount_remaining_cents":0},{"amount_remaining_cents":-1}]') LOOP
        i:=jsonb_populate_record(NULL::public.billing_invoices,original||item||'{"currency":null}');
        PERFORM pg_temp.episode_check(private.workflow_invoice_episode_projection_v1(i,payer)->>'reason'='invoice_not_open','known closed '||item::TEXT);
    END LOOP;
    i:=jsonb_populate_record(NULL::public.billing_invoices,original); i.id:=NULL;
    PERFORM pg_temp.episode_check(private.workflow_invoice_episode_projection_v1(i,missing)->>'reason'='source_missing','missing invoice');
    i:=jsonb_populate_record(NULL::public.billing_invoices,original); i.due_date:=NULL; i.currency:=NULL;
    PERFORM pg_temp.episode_check(private.workflow_invoice_episode_projection_v1(i,payer)->>'reason'='invoice_not_overdue','known missing due');
    i:=jsonb_populate_record(NULL::public.billing_invoices,original);
    PERFORM pg_temp.episode_check(private.workflow_invoice_episode_projection_v1(i,missing)->>'reason'='invoice_parent_missing','missing payer');
    payer.studio_id:=gen_random_uuid();
    PERFORM pg_temp.episode_check(private.workflow_invoice_episode_projection_v1(i,payer)->>'reason'='invoice_parent_missing','foreign payer');
    SELECT * INTO payer FROM public.billing_payers WHERE id=i.payer_id;
    i.metadata:=i.metadata||'{"demo":true}'; i.currency:=NULL;
    PERFORM pg_temp.episode_check(private.workflow_invoice_episode_projection_v1(i,payer)->>'reason'='demo_source','invoice demo precedence');
    i:=jsonb_populate_record(NULL::public.billing_invoices,original); payer.metadata:='{"demo":true}';
    PERFORM pg_temp.episode_check(private.workflow_invoice_episode_projection_v1(i,payer)->>'reason'='demo_source','payer demo');
    payer.metadata:='{"demo":"true"}';
    PERFORM pg_temp.episode_check(private.workflow_invoice_episode_projection_v1(i,payer)=expected,'demo only JSON boolean');
    before:=pg_temp.episode_snapshot(x);
    UPDATE public.billing_invoices SET amount_remaining_cents=900,amount_paid_cents=100,currency='USD',
        metadata='{"connect_account_generation":"1","note":"omitted"}',invoice_number='label',collection_method='charge_automatically' WHERE id=invoice;
    UPDATE public.billing_payers SET display_name='Changed label',email='changed@example.invalid' WHERE id=(x->>'payer')::UUID;
    UPDATE public.studios SET timezone='Pacific/Auckland' WHERE id=s;
    PERFORM private.workflow_finalize_invoice_episodes_v1();
    PERFORM pg_temp.episode_check(pg_temp.episode_snapshot(x)=before,'positive progress labels normalized forms and zone are no-op');
    UPDATE public.billing_invoices SET currency='broken' WHERE id=invoice;
    PERFORM private.workflow_finalize_invoice_episodes_v1();
    PERFORM pg_temp.episode_check(pg_temp.episode_snapshot(x)->'episodes'=before->'episodes','malformed retains known episode');
    UPDATE public.billing_invoices SET currency='usd' WHERE id=invoice;
    PERFORM private.workflow_finalize_invoice_episodes_v1();
    PERFORM pg_temp.episode_check(pg_temp.episode_snapshot(x)->'episodes'=before->'episodes','same identity repair preserves opening');
    UPDATE public.billing_invoices SET currency='eur' WHERE id=invoice;
    UPDATE public.billing_invoices SET currency='usd' WHERE id=invoice;
    PERFORM private.workflow_finalize_invoice_episodes_v1();
    after:=pg_temp.episode_snapshot(x);
    PERFORM pg_temp.episode_check(jsonb_array_length(after->'episodes')=2 AND after#>>'{episodes,0,close_reason}'='source_context_changed'
        AND after#>'{episodes,1,context}'=before#>'{episodes,0,context}','context ABA starts new episode');
    PERFORM pg_temp.episode_check(after#>>'{episodes,0,frozen_timezone}'='UTC' AND after#>>'{episodes,1,frozen_timezone}'='Pacific/Auckland','zone frozen per episode');
    UPDATE public.billing_invoices SET status='paid' WHERE id=invoice;
    UPDATE public.billing_invoices SET status='open' WHERE id=invoice;
    PERFORM private.workflow_finalize_invoice_episodes_v1();
    PERFORM pg_temp.episode_check((SELECT episode_number=3 FROM private.workflow_invoice_episode_state WHERE invoice_id=invoice),'same context close reopen');
    before:=pg_temp.episode_snapshot(x);
    BEGIN
        UPDATE public.billing_invoices SET status='void' WHERE id=invoice;
        PERFORM private.workflow_finalize_invoice_episodes_v1();
        RAISE EXCEPTION USING ERRCODE='P5701';
    EXCEPTION WHEN SQLSTATE 'P5701' THEN NULL;
    END;
    PERFORM pg_temp.episode_check(pg_temp.episode_snapshot(x)=before,'business rollback restores all authority');
    UPDATE public.billing_invoices SET currency='broken' WHERE id=invoice;
    UPDATE public.billing_invoices SET status='paid' WHERE id=invoice;
    PERFORM private.workflow_finalize_invoice_episodes_v1();
    PERFORM pg_temp.episode_check((SELECT current_episode_id IS NULL FROM private.workflow_invoice_episode_state WHERE invoice_id=invoice)
        AND (SELECT close_reason='invoice_not_open' FROM private.workflow_invoice_collection_episodes WHERE invoice_id=invoice AND episode_number=3),'known closure beats malformed current');
    UPDATE public.billing_invoices SET status='open',currency='usd' WHERE id=invoice;
    PERFORM private.workflow_finalize_invoice_episodes_v1();
    UPDATE public.billing_payers SET metadata='{"demo":true}' WHERE id=(x->>'payer')::UUID;
    UPDATE public.billing_payers SET metadata='{}' WHERE id=(x->>'payer')::UUID;
    PERFORM private.workflow_finalize_invoice_episodes_v1();
    PERFORM pg_temp.episode_check((SELECT episode_number=5 FROM private.workflow_invoice_episode_state WHERE invoice_id=invoice),'payer demo ABA sticky');
    UPDATE public.billing_payers SET metadata='{"demo":true}' WHERE id=(x->>'payer')::UUID;
    PERFORM private.workflow_finalize_invoice_episodes_v1();
    PERFORM pg_temp.episode_check((SELECT current_episode_id IS NULL FROM private.workflow_invoice_episode_state WHERE invoice_id=invoice),'payer demo closes');
    UPDATE public.billing_payers SET metadata='{}' WHERE id=(x->>'payer')::UUID;
    PERFORM private.workflow_finalize_invoice_episodes_v1();
    PERFORM pg_temp.episode_check((SELECT episode_number=6 FROM private.workflow_invoice_episode_state WHERE invoice_id=invoice),'payer demo removal reopens');
    SELECT * INTO i FROM public.billing_invoices WHERE id=invoice;
    DELETE FROM public.billing_invoices WHERE id=invoice;
    INSERT INTO public.billing_invoices SELECT i.*;
    PERFORM private.workflow_finalize_invoice_episodes_v1();
    PERFORM pg_temp.episode_check((SELECT episode_number=7 AND ever_removed FROM private.workflow_invoice_episode_state WHERE invoice_id=invoice),'physical same id removal sticky');
    DELETE FROM public.billing_payers WHERE id=(x->>'payer')::UUID;
    PERFORM private.workflow_finalize_invoice_episodes_v1();
    PERFORM pg_temp.episode_check((SELECT current_episode_id IS NULL AND ever_removed FROM private.workflow_invoice_episode_state WHERE invoice_id=invoice),'payer deletion invoice SET NULL closes');
    x:=pg_temp.episode_fixture(CURRENT_DATE+2,true,'{}'); invoice:=(x->>'invoice')::UUID;
    PERFORM pg_temp.episode_check((SELECT episode_number=0 AND current_episode_id IS NULL FROM private.workflow_invoice_episode_state WHERE invoice_id=invoice),'initial unknown state no invented episode');
    boundary:=clock_timestamp();
    UPDATE public.billing_invoices SET metadata='{"connect_account_generation":1}' WHERE id=invoice;
    PERFORM private.workflow_finalize_invoice_episodes_v1();
    PERFORM pg_temp.episode_check((SELECT episode_number=1 AND opened_at>=boundary FROM private.workflow_invoice_collection_episodes WHERE invoice_id=invoice),'unknown first valid actual observation clock');
    x:=pg_temp.episode_fixture(CURRENT_DATE-1); invoice:=(x->>'invoice')::UUID;
    PERFORM pg_temp.episode_check((SELECT NOT threshold_eligible FROM private.workflow_invoice_collection_episodes WHERE invoice_id=invoice),'already overdue creation never retroactive');
    UPDATE public.billing_invoices SET status='paid' WHERE id=invoice;
    UPDATE public.billing_invoices SET status='open' WHERE id=invoice;
    PERFORM private.workflow_finalize_invoice_episodes_v1();
    PERFORM pg_temp.episode_check((SELECT NOT bool_or(threshold_eligible) FROM private.workflow_invoice_collection_episodes WHERE invoice_id=invoice),'already overdue reopening never retroactive');
    SET CONSTRAINTS ALL IMMEDIATE;
    x:=pg_temp.episode_fixture(CURRENT_DATE+2,false); invoice:=(x->>'invoice')::UUID;
    PERFORM pg_temp.episode_check(EXISTS(SELECT 1 FROM private.workflow_invoice_episode_pending WHERE invoice_id=invoice)
        AND NOT EXISTS(SELECT 1 FROM private.workflow_invoice_episode_state WHERE invoice_id=invoice),'earlier ALL IMMEDIATE still queues private source');
    SET CONSTRAINTS private.workflow_invoice_episode_deferred IMMEDIATE;
    PERFORM pg_temp.episode_check((SELECT episode_number=1 FROM private.workflow_invoice_episode_state WHERE invoice_id=invoice),'explicit private flush boundary');
    UPDATE public.billing_invoices SET status='paid' WHERE id=invoice;
    PERFORM pg_temp.episode_check(EXISTS(SELECT 1 FROM private.workflow_invoice_episode_pending WHERE invoice_id=invoice),'later callback re-defers only private constraint');
    SET CONSTRAINTS private.workflow_invoice_episode_deferred IMMEDIATE;
    UPDATE public.billing_invoices SET status='open' WHERE id=invoice;
    PERFORM private.workflow_finalize_invoice_episodes_v1();
    SET CONSTRAINTS private.workflow_invoice_episode_deferred DEFERRED;
    PERFORM pg_temp.episode_check((SELECT episode_number=2 FROM private.workflow_invoice_episode_state WHERE invoice_id=invoice),'separate explicit boundaries preserve history');
    x:=pg_temp.episode_fixture(CURRENT_DATE-2); x:=pg_temp.episode_run(x); invoice:=(x->>'invoice')::UUID;
    UPDATE public.billing_invoices SET status='paid' WHERE id=invoice;
    UPDATE public.billing_invoices SET status='open' WHERE id=invoice;
    result:=public.advance_automation_workflow_run_v1((x->>'studio')::UUID,(x->>'run')::UUID,(x->>'token')::UUID,10);
    PERFORM pg_temp.episode_check(result#>>'{payload,outcome}'='waiting' AND result#>>'{payload,run,reason}'='facts_unavailable','same transaction pending episode defers');
    PERFORM pg_temp.episode_check(NOT EXISTS(SELECT 1 FROM private.automation_workflow_run_steps WHERE run_id=(x->>'run')::UUID)
        AND NOT EXISTS(SELECT 1 FROM private.automation_workflow_follow_up_actions WHERE run_id=(x->>'run')::UUID)
        AND NOT EXISTS(SELECT 1 FROM private.automation_workflow_email_attempts WHERE run_id=(x->>'run')::UUID),'pending source has zero step action begin effects');
    PERFORM private.workflow_finalize_invoice_episodes_v1();
    PERFORM pg_temp.episode_check((SELECT state='cancelled' AND cancel_reason='source_context_changed' FROM public.automation_workflow_runs WHERE id=(x->>'run')::UUID),'final owner cancels same transaction deferred run');
    x:=pg_temp.episode_fixture(CURRENT_DATE-2); x:=pg_temp.episode_run(x); invoice:=(x->>'invoice')::UUID;
    UPDATE public.billing_invoices SET status='paid' WHERE id=invoice;
    result:=public.advance_automation_workflow_run_v1((x->>'studio')::UUID,(x->>'run')::UUID,(x->>'token')::UUID,10);
    PERFORM pg_temp.episode_check(result#>>'{payload,outcome}'='stopped' AND result#>>'{payload,run,reason}'='invoice_not_open','known current closure precedes pending deferral');
    PERFORM private.workflow_finalize_invoice_episodes_v1();
    x:=pg_temp.episode_fixture(CURRENT_DATE-2); invoice:=(x->>'invoice')::UUID;
    FOREACH text_value IN ARRAY ARRAY['queued','waiting','claimed','running','sending','unknown'] LOOP
        y:=pg_temp.episode_run(x,'invoice.overdue',text_value);
    END LOOP;
    y:=pg_temp.episode_run(x,'invoice.payment_failed','queued');
    UPDATE public.billing_invoices SET due_date=due_date+1 WHERE id=invoice;
    PERFORM private.workflow_finalize_invoice_episodes_v1();
    PERFORM pg_temp.episode_check((SELECT count(*)=4 FROM public.automation_workflow_runs WHERE studio_id=(x->>'studio')::UUID AND state='cancelled'),'complete executable cancellation union');
    PERFORM pg_temp.episode_check((SELECT count(*)=2 AND bool_and(cancel_requested_at IS NOT NULL AND cancel_reason='source_context_changed')
        FROM public.automation_workflow_runs WHERE studio_id=(x->>'studio')::UUID AND state IN ('sending','unknown')),'sending unknown truth with intent');
    PERFORM pg_temp.episode_check((SELECT state='queued' AND cancel_requested_at IS NULL FROM public.automation_workflow_runs WHERE id=(y->>'run')::UUID),'failed payment UUID collision excluded');
    x:=pg_temp.episode_fixture(); invoice:=(x->>'invoice')::UUID; before:=pg_temp.episode_snapshot(x);
    SELECT current_episode_id INTO old_id FROM private.workflow_invoice_episode_state WHERE invoice_id=invoice;
    PERFORM pg_temp.episode_error(format('UPDATE private.workflow_invoice_collection_episodes SET context=context||%L::jsonb WHERE id=%L','{"currency":"EUR"}',old_id),'P0001','AUTOMATION_STATE_CONFLICT','episode context immutable');
    PERFORM pg_temp.episode_error(format('UPDATE private.workflow_invoice_episode_state SET episode_number=0 WHERE invoice_id=%L',invoice),'P0001','AUTOMATION_STATE_CONFLICT','state cannot regress');
    PERFORM pg_temp.episode_error(format('INSERT INTO private.workflow_invoice_episode_pending VALUES(%L,%L,pg_backend_pid(),pg_current_xact_id(),true,true,false,%L)',x->>'studio',invoice,'source_context_changed'),'P0001','AUTOMATION_STATE_CONFLICT','direct pending forgery refused');
    PERFORM pg_temp.episode_error(format('SELECT private.workflow_queue_invoice_episode_v1(%L,%L,true,true,false,NULL)',x->>'studio',invoice),'P0001','AUTOMATION_STATE_CONFLICT','direct queue forgery refused');
    UPDATE public.billing_invoices SET status='paid' WHERE id=invoice;
    PERFORM private.workflow_finalize_invoice_episodes_v1();
    PERFORM pg_temp.episode_error(format('UPDATE private.workflow_invoice_collection_episodes SET closed_at=NULL,close_reason=NULL WHERE id=%L',old_id),'P0001','AUTOMATION_STATE_CONFLICT','episode cannot reopen');
    x:=pg_temp.episode_fixture(CURRENT_DATE+2,false,'{"connect_account_generation":1}',false); invoice:=(x->>'invoice')::UUID;
    DELETE FROM public.studios WHERE id=(x->>'studio')::UUID;
    PERFORM private.workflow_finalize_invoice_episodes_v1();
    PERFORM pg_temp.episode_check(NOT EXISTS(SELECT 1 FROM private.workflow_invoice_episode_state WHERE invoice_id=invoice)
        AND NOT EXISTS(SELECT 1 FROM private.workflow_invoice_collection_episodes WHERE invoice_id=invoice)
        AND NOT EXISTS(SELECT 1 FROM private.workflow_invoice_episode_pending WHERE invoice_id=invoice),'actual studio delete never recreates state');
END $$;
-- Additional identity refusals use real pending source ownership. Diagnostic
-- corruption below affects only new private rows and is rolled back by this file.
DO $$
DECLARE x JSONB; y JSONB; invoice UUID; episode UUID; before JSONB; context JSONB; item JSONB; row RECORD;
BEGIN
    x:=pg_temp.episode_fixture(); invoice:=(x->>'invoice')::UUID;
    SELECT current_episode_id INTO episode FROM private.workflow_invoice_episode_state WHERE invoice_id=invoice;
    SELECT e.context INTO context FROM private.workflow_invoice_collection_episodes e WHERE id=episode;
    FOREACH item IN ARRAY ARRAY[NULL::JSONB,'null','[]','{}',context||'{"extra":1}',context-'payer_id',
        context||'{"invoice_id":"not-uuid"}',context||'{"currency":"usd"}',context||'{"connect_account_generation":"1"}',
        context||'{"due_date":"0000-01-01"}',context||'{"due_date":"2026-02-30"}',context||'{"due_date":"2026-2-03"}',
        context||jsonb_build_object('stripe_invoice_id',repeat('x',256)),context||jsonb_build_object('stripe_invoice_id','bad'||chr(9)||'id'),
        context||jsonb_build_object('stripe_invoice_id',chr(233))] LOOP
        PERFORM pg_temp.episode_check(private.workflow_invoice_episode_context_valid_v1(item) IS NOT TRUE,'invalid canonical object '||coalesce(item::TEXT,'SQLNULL'));
    END LOOP;
    UPDATE public.billing_invoices SET currency='EUR' WHERE id=invoice;
    FOREACH item IN ARRAY ARRAY['{"context":{"currency":"EUR"}}'::JSONB,'{"frozen_timezone":"Pacific/Auckland"}',
        '{"opened_at":"2000-01-01T00:00:00Z"}','{"threshold_at":"2000-01-01T00:00:00Z"}',
        '{"threshold_eligible":false}','{"episode_number":7}'] LOOP
        PERFORM pg_temp.episode_error(format('UPDATE private.workflow_invoice_collection_episodes SET %s WHERE id=%L',
            (SELECT string_agg(format('%I=(jsonb_populate_record(NULL::private.workflow_invoice_collection_episodes,%L)).%I',key,item,key),',') FROM jsonb_object_keys(item) key),episode),
            'P0001','AUTOMATION_STATE_CONFLICT','immutable episode with pending owner '||item::TEXT);
    END LOOP;
    PERFORM pg_temp.episode_error(format('UPDATE private.workflow_invoice_episode_state SET invoice_id=gen_random_uuid() WHERE invoice_id=%L',invoice),
        'P0001','AUTOMATION_STATE_CONFLICT','state logical invoice immutable with pending');
    PERFORM pg_temp.episode_error(format('UPDATE private.workflow_invoice_episode_state SET current_episode_id=NULL WHERE invoice_id=%L',invoice),
        'P0001','AUTOMATION_STATE_CONFLICT','active pointer cannot disappear before close');
    PERFORM pg_temp.episode_error(format('UPDATE private.workflow_invoice_collection_episodes SET closed_at=%L,close_reason=%L WHERE id=%L','infinity','invoice_not_open',episode),
        '23514',NULL,'finite close time required');
    PERFORM private.workflow_finalize_invoice_episodes_v1();
    before:=pg_temp.episode_snapshot(x);
    UPDATE public.studios SET timezone='Unrecognized/Proof' WHERE id=(x->>'studio')::UUID;
    PERFORM private.workflow_finalize_invoice_episodes_v1();
    PERFORM pg_temp.episode_check(pg_temp.episode_snapshot(x)=before,'unrecognized zone alone preserves episode');
    UPDATE public.billing_invoices SET currency='USD' WHERE id=invoice;
    PERFORM private.workflow_finalize_invoice_episodes_v1();
    PERFORM pg_temp.episode_check((SELECT frozen_timezone='UTC' FROM private.workflow_invoice_collection_episodes WHERE invoice_id=invoice AND closed_at IS NULL),'unrecognized new episode zone freezes UTC');
    x:=pg_temp.episode_fixture(CURRENT_DATE+2,true,'{"connect_account_generation":1}',false); invoice:=(x->>'invoice')::UUID;
    DELETE FROM public.studios WHERE id=(x->>'studio')::UUID;
    PERFORM private.workflow_finalize_invoice_episodes_v1();
    PERFORM pg_temp.episode_check(NOT EXISTS(SELECT 1 FROM private.workflow_invoice_episode_state WHERE invoice_id=invoice)
        AND NOT EXISTS(SELECT 1 FROM private.workflow_invoice_collection_episodes WHERE invoice_id=invoice)
        AND NOT EXISTS(SELECT 1 FROM private.workflow_invoice_episode_pending WHERE invoice_id=invoice),'existing state history studio cascade');
    x:=pg_temp.episode_fixture(); invoice:=(x->>'invoice')::UUID; before:=pg_temp.episode_snapshot(x);
    UPDATE public.billing_invoices SET external=true WHERE id=invoice;
    UPDATE public.studio_payment_accounts SET metadata='{}' WHERE studio_id=(x->>'studio')::UUID;
    PERFORM private.workflow_finalize_invoice_episodes_v1();
    PERFORM pg_temp.episode_check(pg_temp.episode_snapshot(x)=before,'unit and account uncertainty do not replace episode');
    PERFORM pg_temp.episode_check(private.workflow_invoice_financial_context_v1((x->>'studio')::UUID,invoice)->'available' IS DISTINCT FROM 'true'::JSONB,
        'unchanged episode grants no financial authority');
    x:=pg_temp.episode_fixture(DATE '9999-12-31'); invoice:=(x->>'invoice')::UUID;
    PERFORM pg_temp.episode_check((SELECT threshold_at IS NULL AND NOT threshold_eligible FROM private.workflow_invoice_collection_episodes WHERE invoice_id=invoice),'unrepresentable boundary has no grant');
    x:=pg_temp.episode_fixture(CURRENT_DATE+2,true,'{}'); invoice:=(x->>'invoice')::UUID;
    DELETE FROM private.workflow_invoice_episode_state WHERE invoice_id=invoice;
    PERFORM pg_temp.episode_error(format('UPDATE public.billing_invoices SET invoice_number=%L WHERE id=%L','noop',invoice),
        'P0001','AUTOMATION_STATE_CONFLICT','missing existing state refuses even semantic noop');
    PERFORM pg_temp.episode_check(NOT EXISTS(SELECT 1 FROM private.workflow_invoice_episode_state WHERE invoice_id=invoice),'missing state never seeded by update');
    x:=pg_temp.episode_fixture(); invoice:=(x->>'invoice')::UUID;
    SET CONSTRAINTS private.workflow_invoice_episode_deferred IMMEDIATE;
    SET CONSTRAINTS private.workflow_invoice_episode_deferred DEFERRED;
    ALTER TABLE private.workflow_invoice_episode_pending DISABLE TRIGGER USER;
    INSERT INTO private.workflow_invoice_episode_pending VALUES((x->>'studio')::UUID,invoice,pg_backend_pid()+100000,pg_current_xact_id(),false,false,false,NULL);
    ALTER TABLE private.workflow_invoice_episode_pending ENABLE TRIGGER USER;
    PERFORM pg_temp.episode_error(format('UPDATE public.billing_invoices SET currency=%L WHERE id=%L','EUR',invoice),
        'P0001','AUTOMATION_STATE_CONFLICT','mismatched pending owner refuses source mutation');
    PERFORM pg_temp.episode_check((SELECT count(*)=1 FROM private.workflow_invoice_episode_pending WHERE invoice_id=invoice),'other pending owner never repaired');
    DELETE FROM private.workflow_invoice_episode_pending WHERE invoice_id=invoice;
    -- Counter overflow is a consistent diagnostic history at MAXBIGINT.
    SELECT current_episode_id INTO episode FROM private.workflow_invoice_episode_state WHERE invoice_id=invoice;
    ALTER TABLE private.workflow_invoice_episode_state DISABLE TRIGGER workflow_invoice_episode_state_identity_v1;
    ALTER TABLE private.workflow_invoice_collection_episodes DISABLE TRIGGER workflow_invoice_episode_identity_v1;
    UPDATE private.workflow_invoice_episode_state SET episode_number=9223372036854775807 WHERE invoice_id=invoice;
    UPDATE private.workflow_invoice_collection_episodes SET episode_number=9223372036854775807 WHERE id=episode;
    ALTER TABLE private.workflow_invoice_episode_state ENABLE TRIGGER workflow_invoice_episode_state_identity_v1;
    ALTER TABLE private.workflow_invoice_collection_episodes ENABLE TRIGGER workflow_invoice_episode_identity_v1;
    before:=pg_temp.episode_snapshot(x);
    PERFORM pg_temp.episode_error(format('UPDATE public.billing_invoices SET currency=%L WHERE id=%L; SELECT private.workflow_finalize_invoice_episodes_v1();','EUR',invoice),
        'P0001','AUTOMATION_STATE_CONFLICT','counter overflow refuses entire transition');
    PERFORM pg_temp.episode_check(pg_temp.episode_snapshot(x)=before,'overflow rollback preserves exact episode');
END $$;
DO $$
DECLARE row RECORD; boundary TIMESTAMPTZ; local_date DATE;
BEGIN
    FOR row IN SELECT * FROM (VALUES
        (DATE '2026-10-05','UTC',TIMESTAMPTZ '2026-10-06 00:00+00'),
        (DATE '2018-11-03','America/Sao_Paulo',TIMESTAMPTZ '2018-11-04 03:00+00'),
        (DATE '2020-10-31','America/Havana',TIMESTAMPTZ '2020-11-01 05:00+00'),
        (DATE '2011-12-29','Pacific/Apia',TIMESTAMPTZ '2011-12-30 10:00+00'),
        (DATE '0001-01-01','UTC',TIMESTAMPTZ '0001-01-02 00:00+00'),
        (DATE '9999-12-30','UTC',TIMESTAMPTZ '9999-12-31 00:00+00')) v(due,zone,expected) LOOP
        boundary:=private.workflow_invoice_episode_threshold_v1(row.due,row.zone);
        PERFORM pg_temp.episode_check(boundary=row.expected AND boundary=(row.due+1)::TIMESTAMP AT TIME ZONE row.zone,'PG17 scheduled midnight '||row.zone||row.due::TEXT);
    END LOOP;
    boundary:=private.workflow_invoice_episode_threshold_v1(DATE '2020-10-31','America/Havana');
    PERFORM pg_temp.episode_check(TIMESTAMPTZ '2020-11-01 04:30+00'<boundary
        AND (TIMESTAMPTZ '2020-11-01 04:30+00' AT TIME ZONE 'America/Havana')::DATE>DATE '2020-10-31','between repeated midnights activation date guard');
    PERFORM pg_temp.episode_check((TIMESTAMPTZ '2011-12-30 10:00+00' AT TIME ZONE 'Pacific/Apia')::DATE=DATE '2011-12-31','whole day skip resolved by PG17');
    PERFORM pg_temp.episode_check(private.workflow_invoice_episode_threshold_v1(DATE '9999-12-31','UTC') IS NULL
        AND private.workflow_invoice_episode_threshold_v1(DATE '9999-12-31','Pacific/Kiritimati') IS NULL,'year10000 arithmetic refused');
    PERFORM pg_temp.episode_check(private.workflow_invoice_episode_threshold_v1(DATE 'infinity','UTC') IS NULL
        AND private.workflow_invoice_episode_threshold_v1(DATE '0001-01-01 BC','UTC') IS NULL
        AND private.workflow_invoice_episode_threshold_v1(NULL,'UTC') IS NULL
        AND private.workflow_invoice_episode_threshold_v1(CURRENT_DATE,NULL) IS NULL
        AND private.workflow_invoice_episode_threshold_v1(CURRENT_DATE,'unrecognized/proof') IS NULL,'threshold invalid inputs unavailable');
END $$;
-- Keep the transaction-wide clear gate after the independent studio cascades.
DO $$
DECLARE x JSONB; invoice UUID;
BEGIN
    x:=pg_temp.episode_fixture(); invoice:=(x->>'invoice')::UUID;
    PERFORM public.clear_studio_operational_data_atomic((x->>'studio')::UUID,false);
    PERFORM private.workflow_finalize_invoice_episodes_v1();
    PERFORM pg_temp.episode_check(NOT EXISTS(SELECT 1 FROM public.billing_invoices WHERE id=invoice)
        AND (SELECT ever_removed AND current_episode_id IS NULL FROM private.workflow_invoice_episode_state WHERE invoice_id=invoice),'actual clear preserves logical closed history');
END $$;
SELECT count(*) AS invoice_episode_assertions FROM pg_temp.episode_checks;
ROLLBACK;
