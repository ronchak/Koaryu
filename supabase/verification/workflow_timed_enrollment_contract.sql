-- Synthetic local proof. Injected clocks exist only in pg_temp, never the RPC.
BEGIN;
SET LOCAL statement_timeout='90s';
SET LOCAL TIME ZONE 'UTC';
CREATE TEMP TABLE timed_checks(label TEXT PRIMARY KEY);
CREATE TEMP TABLE timed_plans(label TEXT PRIMARY KEY,plan JSONB NOT NULL);
CREATE FUNCTION pg_temp.timed_check(ok BOOLEAN,label TEXT) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
    IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'timed enrollment contract failed: %',label; END IF;
    INSERT INTO pg_temp.timed_checks VALUES(label);
END $$;
-- fixture owners start. Runner copies this block into its owned proof schema.
CREATE FUNCTION pg_temp.timed_rpc(statement TEXT) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE value JSONB; code TEXT; message TEXT;
BEGIN
    EXECUTE statement INTO value;
    RETURN jsonb_build_object('ok',true,'value',value);
EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS code=RETURNED_SQLSTATE,message=MESSAGE_TEXT;
    RETURN jsonb_build_object('ok',false,'code',code,'message',message);
END $$;
CREATE FUNCTION pg_temp.timed_graph(kind TEXT,offset_minutes INTEGER DEFAULT -1440,program UUID DEFAULT NULL) RETURNS JSONB LANGUAGE sql AS $$
    SELECT jsonb_build_object('schema_version',1,'nodes',jsonb_build_array(
        jsonb_build_object('id','trigger','type','trigger','config',jsonb_build_object('event_type',kind,'program_id',program)
            ||CASE WHEN kind IN ('trial.upcoming','belt_test.upcoming') THEN jsonb_build_object('offset_minutes',offset_minutes) ELSE '{}'::JSONB END),
        '{"id":"end","type":"end","config":{}}'::JSONB),
        'edges','[{"id":"next","source":"trigger","target":"end","port":"next"}]'::JSONB)
$$;
CREATE FUNCTION pg_temp.timed_workflow(x JSONB,kind TEXT,offset_minutes INTEGER DEFAULT -1440,program UUID DEFAULT NULL,start_workflow BOOLEAN DEFAULT true)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE w UUID; a UUID; v UUID; revision BIGINT:=2;
BEGIN
    w:=(public.create_automation_workflow_v1((x->>'studio')::UUID,(x->>'actor')::UUID,gen_random_uuid(),'Timed proof','',
        pg_temp.timed_graph(kind,offset_minutes,program),'{}')#>>'{payload,id}')::UUID;
    PERFORM public.command_automation_workflow_v1((x->>'studio')::UUID,(x->>'actor')::UUID,w,gen_random_uuid(),1,'publish');
    IF start_workflow THEN
        PERFORM public.command_automation_workflow_v1((x->>'studio')::UUID,(x->>'actor')::UUID,w,gen_random_uuid(),2,'start');
        revision:=3;
    END IF;
    SELECT id,version_id INTO a,v FROM public.automation_workflow_activations WHERE workflow_id=w AND retired_at IS NULL;
    RETURN x||jsonb_build_object('workflow',w,'activation',a,'version',v,'workflow_revision',revision,'kind',kind);
END $$;
CREATE FUNCTION pg_temp.timed_fixture(kind TEXT DEFAULT 'trial.upcoming',start_at TIMESTAMPTZ DEFAULT clock_timestamp()+INTERVAL '2 days')
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE s UUID:=gen_random_uuid(); a UUID:=gen_random_uuid(); p UUID:=gen_random_uuid(); p2 UUID:=gen_random_uuid(); source UUID; parent UUID;
    lead UUID; student UUID; ladder UUID; rank UUID; payer UUID; context JSONB; result JSONB;
BEGIN
    INSERT INTO auth.users(id,email,email_confirmed_at) VALUES(a,a||'@example.invalid',clock_timestamp());
    INSERT INTO public.studios(id,name,slug,owner_id,timezone) VALUES(s,'Timed fixture',s::TEXT,a,'UTC');
    INSERT INTO public.staff_roles(studio_id,user_id,role) VALUES(s,a,'admin');
    INSERT INTO public.studio_subscriptions(studio_id,status,comped) VALUES(s,'active',false);
    INSERT INTO public.programs(id,studio_id,name) VALUES(p,s,'Timed program'),(p2,s,'Other timer filter');
    IF kind='trial.upcoming' THEN
        lead:=gen_random_uuid();
        INSERT INTO public.leads(id,studio_id,first_name,last_name,source,stage,program_id)
            VALUES(lead,s,'Trial','Fixture','referral','inquiry',p);
        result:=public.mutate_lead_trial_appointment_v1(s,a,lead,NULL,gen_random_uuid(),NULL,jsonb_build_object(
            'starts_at',private.automation_utc_text_v1(start_at),'ends_at',private.automation_utc_text_v1(start_at+INTERVAL '1 hour'),
            'timezone','UTC','program_id',p));
        source:=(result#>>'{payload,id}')::UUID;
    ELSIF kind='belt_test.upcoming' THEN
        student:=gen_random_uuid(); ladder:=gen_random_uuid(); rank:=gen_random_uuid();
        INSERT INTO public.belt_ladders(id,studio_id,name) VALUES(ladder,s,'Unscoped timed ladder');
        INSERT INTO public.belt_ranks(id,studio_id,ladder_id,name,display_order,min_classes,min_months) VALUES(rank,s,ladder,'First',0,0,0);
        INSERT INTO public.students(id,studio_id,legal_first_name,legal_last_name,status,program_id,membership_start_date)
            VALUES(student,s,'Belt','Fixture','active',p,CURRENT_DATE-100);
        SET CONSTRAINTS private.workflow_rank_deferred IMMEDIATE;
        result:=public.mutate_belt_test_event_v1(s,a,NULL,gen_random_uuid(),NULL,jsonb_build_object('name','Timed event','ladder_id',ladder,
            'starts_at',private.automation_utc_text_v1(start_at),'ends_at',private.automation_utc_text_v1(start_at+INTERVAL '1 hour'),'timezone','UTC','status','scheduled'));
        parent:=(result#>>'{payload,id}')::UUID;
        result:=public.approve_belt_test_recipients_v1(s,a,parent,gen_random_uuid(),1,jsonb_build_array(
            jsonb_build_object('student_id',student,'student_program_membership_id',NULL)));
        source:=(result#>>'{payload,items,0,id}')::UUID;
    ELSE
        payer:=gen_random_uuid(); source:=gen_random_uuid();
        INSERT INTO public.studio_payment_accounts(studio_id,stripe_connected_account_id,metadata)
            VALUES(s,'acct_'||replace(s::TEXT,'-',''),'{"connect_account_generation":1}');
        INSERT INTO public.billing_payers(id,studio_id,display_name,email,stripe_account_id,stripe_customer_id,connect_account_generation)
            VALUES(payer,s,'Timed payer','payer.'||payer||'@example.invalid','acct_'||replace(s::TEXT,'-',''),'cus_'||payer,1);
        INSERT INTO public.billing_invoices(id,studio_id,payer_id,status,currency,amount_due_cents,amount_paid_cents,amount_remaining_cents,due_date,
            stripe_account_id,stripe_customer_id,stripe_invoice_id,metadata)
            VALUES(source,s,payer,'open','usd',1000,0,1000,start_at::DATE-1,'acct_'||replace(s::TEXT,'-',''),'cus_'||payer,'in_'||source,'{"connect_account_generation":1}');
        PERFORM private.workflow_finalize_invoice_episodes_v1();
    END IF;
    RETURN jsonb_build_object('studio',s,'actor',a,'program',p,'program2',p2,'source',source,'parent',parent,'lead',lead,
        'student',student,'ladder',ladder,'rank',rank,'payer',payer,'kind',kind,'starts_at',start_at);
END $$;
CREATE FUNCTION pg_temp.timed_resume(packet JSONB,ownership JSONB,at TIMESTAMPTZ) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE item JSONB; result JSONB; results JSONB:='[]';
BEGIN
    FOR item IN SELECT x.value FROM jsonb_array_elements(packet->'pairs') x WHERE EXISTS(
        SELECT 1 FROM jsonb_array_elements(ownership->'owned_pairs') o WHERE o->'activation_id'=x.value->'activation_id'
            AND o->'source_record_id'=x.value->'source_record_id') LOOP
        result:=private.workflow_enroll_timed_occurrence_v1((item->>'activation_id')::UUID,(item->>'subject_id')::UUID,
            (item->>'source_record_id')::UUID,(item->>'source_starts_at')::TIMESTAMPTZ,(item->>'threshold_at')::TIMESTAMPTZ,at);
        results:=results||jsonb_build_array(result);
    END LOOP;
    RETURN results;
END $$;
CREATE FUNCTION pg_temp.timed_payment(x JSONB,state TEXT,linked BOOLEAN DEFAULT true) RETURNS UUID LANGUAGE plpgsql AS $$
DECLARE v_id UUID:=gen_random_uuid();
BEGIN
    INSERT INTO public.billing_payments(id,studio_id,payer_id,invoice_id,status,amount_cents,currency,stripe_account_id,stripe_customer_id,stripe_invoice_id,
        connect_account_generation,payment_method_type,idempotency_key,net_collected_amount_cents)
        SELECT v_id,i.studio_id,i.payer_id,CASE WHEN linked THEN i.id END,state,100,'usd',i.stripe_account_id,i.stripe_customer_id,
            CASE WHEN linked THEN i.stripe_invoice_id END,1,'card',v_id::TEXT,CASE WHEN state='succeeded' THEN 100 ELSE 0 END FROM public.billing_invoices i WHERE i.id=(x->>'source')::UUID;
    RETURN v_id;
END $$;
CREATE FUNCTION pg_temp.timed_repair_fixture() RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE x JSONB; failed JSONB; payment UUID; success UUID; run UUID;
BEGIN
    x:=pg_temp.timed_workflow(pg_temp.timed_fixture('invoice.overdue'),'invoice.overdue');
    failed:=pg_temp.timed_workflow(x,'invoice.payment_failed');
    payment:=pg_temp.timed_payment(x,'failed');
    SELECT r.id INTO run FROM public.automation_workflow_runs r JOIN private.automation_workflow_events e ON e.id=r.event_id
        WHERE r.workflow_id=(failed->>'workflow')::UUID AND e.subject_id=payment;
    UPDATE public.studio_payment_accounts SET metadata='{"connect_account_generation":2}' WHERE studio_id=(x->>'studio')::UUID;
    success:=pg_temp.timed_payment(x,'succeeded');
    UPDATE public.studio_payment_accounts SET metadata='{"connect_account_generation":1}' WHERE studio_id=(x->>'studio')::UUID;
    RETURN x||jsonb_build_object('failed_workflow',failed->'workflow','failed_run',run,'payment',payment,'success',success);
END $$;
CREATE FUNCTION pg_temp.timed_scan(at TIMESTAMPTZ,limit_count INTEGER DEFAULT 100) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE packet JSONB; ownership JSONB; item JSONB; result JSONB; results JSONB:='[]'; events INTEGER:=0; runs INTEGER:=0;
BEGIN
    packet:=private.workflow_timed_candidates_v1(limit_count,at);
    ownership:=private.workflow_lock_timed_sources_v1(packet->'pairs');
    FOR item IN SELECT x.value FROM jsonb_array_elements(packet->'pairs') x WHERE EXISTS(
        SELECT 1 FROM jsonb_array_elements(ownership->'owned_pairs') o WHERE o->'activation_id'=x.value->'activation_id'
            AND o->'source_record_id'=x.value->'source_record_id') LOOP
        result:=private.workflow_enroll_timed_occurrence_v1((item->>'activation_id')::UUID,(item->>'subject_id')::UUID,
            (item->>'source_record_id')::UUID,(item->>'source_starts_at')::TIMESTAMPTZ,(item->>'threshold_at')::TIMESTAMPTZ,at);
        results:=results||jsonb_build_array(result); events:=events+(result->>'created_event')::BOOLEAN::INTEGER;
        runs:=runs+(result->>'enqueued_run')::BOOLEAN::INTEGER;
    END LOOP;
    RETURN jsonb_build_object('packet',packet,'ownership',ownership,'results',results,'created',events,'enqueued',runs);
END $$;
CREATE FUNCTION pg_temp.timed_at(x JSONB) RETURNS TIMESTAMPTZ LANGUAGE plpgsql AS $$
DECLARE result TIMESTAMPTZ;
BEGIN
    IF x->>'kind'='invoice.overdue' THEN
        SELECT e.threshold_at INTO result FROM private.workflow_invoice_collection_episodes e
            JOIN private.workflow_invoice_episode_state s ON s.current_episode_id=e.id WHERE s.invoice_id=(x->>'source')::UUID;
    ELSE
        result:=(x->>'starts_at')::TIMESTAMPTZ+make_interval(mins=>(SELECT offset_minutes FROM private.workflow_timer_activations WHERE activation_id=(x->>'activation')::UUID));
    END IF;
    RETURN result;
END $$;
CREATE FUNCTION pg_temp.timed_snapshot() RETURNS JSONB LANGUAGE sql AS $$
    SELECT jsonb_build_object('timer',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY activation_id),'[]') FROM private.workflow_timer_activations t),
        'cursor',(SELECT to_jsonb(c) FROM private.workflow_timer_dispatch_cursor c),
        'events',(SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY id),'[]') FROM private.automation_workflow_events e),
        'runs',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY id),'[]') FROM public.automation_workflow_runs r),
        'settlements',(SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY invoice_id),'[]') FROM private.workflow_invoice_settlement_authority s),
        'observations',(SELECT coalesce(jsonb_agg(to_jsonb(o) ORDER BY payment_id),'[]') FROM private.workflow_payment_settlement_observations o))
$$;
CREATE FUNCTION pg_temp.timed_command(x JSONB,command TEXT) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE revision BIGINT;
BEGIN
    SELECT w.revision INTO revision FROM public.automation_workflows w WHERE w.id=(x->>'workflow')::UUID;
    RETURN public.command_automation_workflow_v1((x->>'studio')::UUID,(x->>'actor')::UUID,(x->>'workflow')::UUID,gen_random_uuid(),revision,command);
END $$;
-- fixture owners end.
DO $$
DECLARE spec TEXT; kind TEXT; x JSONB; y JSONB; result JSONB; packet JSONB; before JSONB; after JSONB; item JSONB;
    at TIMESTAMPTZ; bound TIMESTAMPTZ; n INTEGER; metadata RECORD; identity UUID; original UUID; old_version UUID; changed JSONB;
BEGIN
    FOREACH spec IN ARRAY ARRAY['workflow_timer_activations','workflow_timer_dispatch_cursor'] LOOP
        SELECT * INTO metadata FROM pg_class WHERE oid=('private.'||spec)::REGCLASS;
        PERFORM pg_temp.timed_check(metadata.relpersistence='p' AND metadata.relrowsecurity AND pg_get_userbyid(metadata.relowner)='postgres','logged RLS owner '||spec);
        PERFORM pg_temp.timed_check(NOT has_table_privilege('anon',metadata.oid,'SELECT,INSERT,UPDATE,DELETE')
            AND NOT has_table_privilege('authenticated',metadata.oid,'SELECT,INSERT,UPDATE,DELETE')
            AND has_table_privilege('service_role',metadata.oid,'SELECT,UPDATE') AND NOT has_table_privilege('service_role',metadata.oid,'DELETE'),'closed table ACL '||spec);
        PERFORM pg_temp.timed_check((SELECT count(*)=1 AND bool_and(NOT polpermissive AND polcmd='*') FROM pg_policy WHERE polrelid=metadata.oid),'restrictive policy '||spec);
    END LOOP;
    PERFORM pg_temp.timed_check((SELECT count(*)=0 FROM pg_constraint WHERE conrelid='private.workflow_timer_dispatch_cursor'::REGCLASS AND contype='f'),'singleton logical identity without parent callback');
    PERFORM pg_temp.timed_check((SELECT count(*)=1 AND bool_and(confdeltype='c' AND confrelid='public.automation_workflow_activations'::REGCLASS)
        FROM pg_constraint WHERE conrelid='private.workflow_timer_activations'::REGCLASS AND contype='f'),'activation exact composite cascade');
    FOREACH spec IN ARRAY ARRAY['private.workflow_timer_activation_insert_v1()','private.workflow_timer_activation_identity_v1()',
        'private.workflow_timed_candidates_v1(integer,timestamp with time zone)','private.workflow_lock_timed_sources_v1(jsonb)',
        'private.workflow_enroll_timed_occurrence_v1(uuid,uuid,uuid,timestamp with time zone,timestamp with time zone,timestamp with time zone)',
        'public.process_automation_workflow_occurrences_v1(integer)'] LOOP
        SELECT * INTO metadata FROM pg_proc WHERE oid=spec::REGPROCEDURE;
        PERFORM pg_temp.timed_check(NOT metadata.prosecdef AND metadata.provolatile='v' AND metadata.proconfig=ARRAY['search_path=""']
            AND pg_get_userbyid(metadata.proowner)='postgres' AND NOT has_function_privilege('anon',metadata.oid,'EXECUTE')
            AND NOT has_function_privilege('authenticated',metadata.oid,'EXECUTE')
            AND has_function_privilege('service_role',metadata.oid,'EXECUTE')=(metadata.prorettype<>'trigger'::REGTYPE),'owner function ACL '||spec);
    END LOOP;
    FOR metadata IN SELECT name,definition FROM (VALUES
        ('workflow_timer_activations_scan','(studio_id, activation_id)'),('lead_trial_appointments_timer_scan','(studio_id, starts_at, id)'),
        ('belt_test_events_timer_scan','(studio_id, starts_at, id)'),('belt_test_recipients_timer_scan','(studio_id, event_id, id)'),
        ('workflow_invoice_episodes_timer_scan','(studio_id, threshold_at, id)'),
        ('workflow_payment_settlement_uncertain_scan','(studio_id, invoice_id, payment_id)'),
        ('workflow_events_failed_invoice','(studio_id, ((context ->> ''invoice_id''::text)), id)')) shapes(name,definition) LOOP
        PERFORM pg_temp.timed_check((SELECT count(*)=1 AND bool_and(i.indisvalid AND i.indisready AND position(metadata.definition IN pg_get_indexdef(i.indexrelid))>0)
            FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE c.relname=metadata.name),'seek index '||metadata.name);
    END LOOP;
    FOREACH spec IN ARRAY ARRAY['NULL','0','101','-1'] LOOP
        result:=pg_temp.timed_rpc('SELECT public.process_automation_workflow_occurrences_v1('||spec||');');
        PERFORM pg_temp.timed_check(result->>'code'='22023' AND result->>'message'='AUTOMATION_INVALID_REQUEST','RPC strict limit '||spec);
    END LOOP;
    result:=public.process_automation_workflow_occurrences_v1();
    PERFORM pg_temp.timed_check(result='{"payload":{"created_event_count":0,"enqueued_run_count":0,"has_more":false}}'::JSONB,'empty exact aggregate');
    FOREACH kind IN ARRAY ARRAY['trial.upcoming','belt_test.upcoming','invoice.overdue'] LOOP
        x:=pg_temp.timed_fixture(kind); x:=pg_temp.timed_workflow(x,kind); at:=pg_temp.timed_at(x);
        PERFORM pg_temp.timed_check((SELECT count(*)=1 FROM private.workflow_timer_activations WHERE activation_id=(x->>'activation')::UUID),'project activation '||kind);
        result:=pg_temp.timed_scan(at-INTERVAL '1 microsecond');
        PERFORM pg_temp.timed_check(NOT EXISTS(SELECT 1 FROM public.automation_workflow_runs WHERE workflow_id=(x->>'workflow')::UUID),'before threshold '||kind);
        result:=pg_temp.timed_scan(at);
        PERFORM pg_temp.timed_check((SELECT count(*)=1 FROM public.automation_workflow_runs WHERE workflow_id=(x->>'workflow')::UUID),'threshold equality enrolls '||kind);
        PERFORM pg_temp.timed_check((SELECT r.state='queued' AND r.revision=1 AND r.current_node_id='trigger' AND r.claim_token IS NULL
            AND r.cancel_requested_at IS NULL AND r.next_due_at=at AND r.version_id=(x->>'version')::UUID
            AND e.occurred_at=at AND e.created_at=at FROM public.automation_workflow_runs r JOIN private.automation_workflow_events e ON e.id=r.event_id
            WHERE r.workflow_id=(x->>'workflow')::UUID),'exact immutable timed run '||kind);
        result:=pg_temp.timed_scan(at+INTERVAL '1 second');
        PERFORM pg_temp.timed_check((SELECT count(*)=1 FROM public.automation_workflow_runs WHERE workflow_id=(x->>'workflow')::UUID),'overlap idempotence '||kind);
        PERFORM pg_temp.timed_check(NOT EXISTS(SELECT 1 FROM private.automation_workflow_run_steps s JOIN public.automation_workflow_runs r ON r.id=s.run_id
            WHERE r.workflow_id=(x->>'workflow')::UUID),'no traversal '||kind);
        PERFORM pg_temp.timed_command(x,'pause');
    END LOOP;
    x:=pg_temp.timed_fixture(); x:=pg_temp.timed_workflow(x,'trial.upcoming'); at:=pg_temp.timed_at(x);
    y:=pg_temp.timed_workflow(x,'trial.upcoming'); result:=pg_temp.timed_scan(at);
    PERFORM pg_temp.timed_check((SELECT count(*)=1 FROM private.automation_workflow_events WHERE studio_id=(x->>'studio')::UUID AND event_type='trial.upcoming')
        AND (SELECT count(*)=2 FROM public.automation_workflow_runs WHERE studio_id=(x->>'studio')::UUID),'same offset one occurrence two workflows');
    y:=pg_temp.timed_workflow(x,'trial.upcoming',-1439); result:=pg_temp.timed_scan(at+INTERVAL '1 minute');
    PERFORM pg_temp.timed_check((SELECT count(*)=2 AND count(DISTINCT occurred_at)=2 FROM private.automation_workflow_events
        WHERE studio_id=(x->>'studio')::UUID AND event_type='trial.upcoming'),'different offset exact distinct occurrence');
    SELECT id INTO identity FROM public.automation_workflow_runs WHERE workflow_id=(x->>'workflow')::UUID;
    PERFORM private.workflow_cancel_runs_v1((x->>'studio')::UUID,ARRAY[identity],clock_timestamp(),'run_cancelled');
    result:=pg_temp.timed_scan(at+INTERVAL '1 minute');
    PERFORM pg_temp.timed_check((SELECT count(*)=1 AND bool_and(state='cancelled') FROM public.automation_workflow_runs WHERE workflow_id=(x->>'workflow')::UUID),'canceled enrollment never revived');
    -- Exact provenance must exist. A raw source row is not an occurrence.
    x:=pg_temp.timed_fixture(); x:=pg_temp.timed_workflow(x,'trial.upcoming'); at:=pg_temp.timed_at(x);
    DELETE FROM private.automation_workflow_events WHERE studio_id=(x->>'studio')::UUID AND event_type='trial.scheduled';
    result:=pg_temp.timed_scan(at);
    PERFORM pg_temp.timed_check(NOT EXISTS(SELECT 1 FROM public.automation_workflow_runs WHERE workflow_id=(x->>'workflow')::UUID)
        AND (SELECT last_source_id=(x->>'source')::UUID FROM private.workflow_timer_activations WHERE activation_id=(x->>'activation')::UUID),'missing provenance advances only progress');
    -- Repair source provenance through a real schedule revision; no synthetic seen marker.
    PERFORM public.mutate_lead_trial_appointment_v1((x->>'studio')::UUID,(x->>'actor')::UUID,(x->>'lead')::UUID,(x->>'source')::UUID,
        gen_random_uuid(),1,'{"location":"Second room"}');
    result:=pg_temp.timed_scan(at);
    PERFORM pg_temp.timed_check(EXISTS(SELECT 1 FROM public.automation_workflow_runs WHERE workflow_id=(x->>'workflow')::UUID),'repaired source found behind cursor');
    FOREACH kind IN ARRAY ARRAY['trial.upcoming','belt_test.upcoming'] LOOP
        x:=pg_temp.timed_fixture(kind,clock_timestamp()+INTERVAL '30 seconds'); x:=pg_temp.timed_workflow(x,kind,-1);
        result:=pg_temp.timed_scan(clock_timestamp());
        PERFORM pg_temp.timed_check(NOT EXISTS(SELECT 1 FROM public.automation_workflow_runs WHERE workflow_id=(x->>'workflow')::UUID),'late source cannot backfill '||kind);
        x:=pg_temp.timed_fixture(kind); x:=pg_temp.timed_workflow(x,kind); at:=pg_temp.timed_at(x);
        result:=pg_temp.timed_scan((x->>'starts_at')::TIMESTAMPTZ);
        PERFORM pg_temp.timed_check(NOT EXISTS(SELECT 1 FROM public.automation_workflow_runs WHERE workflow_id=(x->>'workflow')::UUID),'meaningful window closes at start '||kind);
        result:=pg_temp.timed_rpc(format('UPDATE private.workflow_timer_activations SET program_id=%L WHERE activation_id=%L',gen_random_uuid(),x->>'activation'));
        PERFORM pg_temp.timed_check(result->>'message'='AUTOMATION_IMMUTABLE_RECORD','immutable filter '||kind);
    END LOOP;
    x:=pg_temp.timed_fixture(); x:=pg_temp.timed_workflow(x,'trial.upcoming',-1440,NULL,false);
    PERFORM pg_temp.timed_check((SELECT status='paused' FROM public.automation_workflows WHERE id=(x->>'workflow')::UUID)
        AND NOT EXISTS(SELECT 1 FROM private.workflow_timer_activations WHERE workflow_id=(x->>'workflow')::UUID),'first publish paused no activation');
    PERFORM pg_temp.timed_command(x,'start');
    SELECT x||jsonb_build_object('activation',id,'version',version_id) INTO x FROM public.automation_workflow_activations WHERE workflow_id=(x->>'workflow')::UUID AND retired_at IS NULL;
    at:=pg_temp.timed_at(x); old_version:=(x->>'version')::UUID;
    PERFORM pg_temp.timed_command(x,'publish'); result:=pg_temp.timed_scan(at);
    PERFORM pg_temp.timed_check((SELECT count(*)=1 AND bool_and(version_id<>old_version) FROM public.automation_workflow_runs
        WHERE workflow_id=(x->>'workflow')::UUID),'republish before crossing selects new interval');
    PERFORM pg_temp.timed_command(x,'pause'); PERFORM pg_temp.timed_command(x,'start'); result:=pg_temp.timed_scan(at);
    PERFORM pg_temp.timed_check((SELECT count(*)=1 FROM public.automation_workflow_runs WHERE workflow_id=(x->>'workflow')::UUID),'resume never duplicates old occurrence');
    PERFORM pg_temp.timed_command(x,'archive'); result:=pg_temp.timed_scan(at);
    PERFORM pg_temp.timed_check((SELECT bool_and(cancel_requested_at IS NOT NULL) FROM public.automation_workflow_runs WHERE workflow_id=(x->>'workflow')::UUID),'archive monotonic cancellation');
    x:=pg_temp.timed_fixture(); x:=pg_temp.timed_workflow(x,'trial.upcoming',-1440,(x->>'program')::UUID); at:=pg_temp.timed_at(x);
    UPDATE public.programs SET archived_at=clock_timestamp() WHERE id=(x->>'program')::UUID;
    result:=pg_temp.timed_scan(at);
    PERFORM pg_temp.timed_check(NOT EXISTS(SELECT 1 FROM public.automation_workflow_runs WHERE workflow_id=(x->>'workflow')::UUID),'current program archive refuses enrollment');
    UPDATE public.programs SET archived_at=NULL WHERE id=(x->>'program')::UUID;
    result:=pg_temp.timed_scan(at);
    PERFORM pg_temp.timed_check(EXISTS(SELECT 1 FROM public.automation_workflow_runs WHERE workflow_id=(x->>'workflow')::UUID),'program restoration can retry unmaterialized crossing');
    x:=pg_temp.timed_fixture('invoice.overdue',CURRENT_DATE::TIMESTAMPTZ); x:=pg_temp.timed_workflow(x,'invoice.overdue');
    result:=pg_temp.timed_scan(clock_timestamp()+INTERVAL '2 days');
    PERFORM pg_temp.timed_check(NOT EXISTS(SELECT 1 FROM public.automation_workflow_runs WHERE workflow_id=(x->>'workflow')::UUID),'new already overdue episode has no old crossing');
    x:=pg_temp.timed_fixture('invoice.overdue'); x:=pg_temp.timed_workflow(x,'invoice.overdue'); at:=pg_temp.timed_at(x);
    SELECT current_episode_id INTO original FROM private.workflow_invoice_episode_state WHERE invoice_id=(x->>'source')::UUID;
    UPDATE public.studios SET timezone='America/Los_Angeles' WHERE id=(x->>'studio')::UUID;
    result:=pg_temp.timed_scan(at);
    PERFORM pg_temp.timed_check(NOT EXISTS(SELECT 1 FROM public.automation_workflow_runs WHERE workflow_id=(x->>'workflow')::UUID)
        AND (SELECT frozen_timezone='UTC' AND id=original FROM private.workflow_invoice_collection_episodes WHERE id=original),'frozen threshold waits for current zone eligibility');
    result:=pg_temp.timed_scan(at+INTERVAL '12 hours');
    PERFORM pg_temp.timed_check(EXISTS(SELECT 1 FROM public.automation_workflow_runs WHERE workflow_id=(x->>'workflow')::UUID),'current zone later admission preserves frozen occurrence');
    x:=pg_temp.timed_fixture('invoice.overdue'); x:=pg_temp.timed_workflow(x,'invoice.overdue'); at:=pg_temp.timed_at(x);
    UPDATE public.studio_payment_accounts SET metadata='{"connect_account_generation":2}' WHERE studio_id=(x->>'studio')::UUID;
    result:=pg_temp.timed_scan(at);
    PERFORM pg_temp.timed_check(NOT EXISTS(SELECT 1 FROM public.automation_workflow_runs WHERE workflow_id=(x->>'workflow')::UUID),'financial uncertainty has no seen occurrence');
    UPDATE public.studio_payment_accounts SET metadata='{"connect_account_generation":1}' WHERE studio_id=(x->>'studio')::UUID;
    result:=pg_temp.timed_scan(at);
    PERFORM pg_temp.timed_check(EXISTS(SELECT 1 FROM public.automation_workflow_runs WHERE workflow_id=(x->>'workflow')::UUID),'financial repair permits one later admission');
    x:=pg_temp.timed_fixture('invoice.overdue'); x:=pg_temp.timed_workflow(x,'invoice.overdue'); at:=pg_temp.timed_at(x);
    UPDATE public.billing_invoices SET currency='broken' WHERE id=(x->>'source')::UUID;
    UPDATE public.billing_invoices SET currency='usd' WHERE id=(x->>'source')::UUID;
    before:=(SELECT to_jsonb(p) FROM private.workflow_invoice_episode_pending p WHERE invoice_id=(x->>'source')::UUID);
    result:=pg_temp.timed_scan(at);
    PERFORM pg_temp.timed_check(NOT EXISTS(SELECT 1 FROM public.automation_workflow_runs WHERE workflow_id=(x->>'workflow')::UUID)
        AND before=(SELECT to_jsonb(p) FROM private.workflow_invoice_episode_pending p WHERE invoice_id=(x->>'source')::UUID),'own pending episode stays unavailable without flush');
    PERFORM private.workflow_finalize_invoice_episodes_v1(); result:=pg_temp.timed_scan(at);
    PERFORM pg_temp.timed_check(EXISTS(SELECT 1 FROM public.automation_workflow_runs WHERE workflow_id=(x->>'workflow')::UUID),'explicit source finalization allows later timer');
    x:=pg_temp.timed_fixture('invoice.overdue'); x:=pg_temp.timed_workflow(x,'invoice.overdue'); at:=pg_temp.timed_at(x);
    UPDATE public.billing_invoices SET status='paid' WHERE id=(x->>'source')::UUID;
    packet:=private.workflow_timed_candidates_v1(100,at); PERFORM private.workflow_lock_timed_sources_v1(packet->'pairs');
    SELECT value INTO item FROM jsonb_array_elements(packet->'pairs') WHERE value->>'activation_id'=x->>'activation';
    result:=private.workflow_enroll_timed_occurrence_v1((x->>'activation')::UUID,(x->>'source')::UUID,(item->>'source_record_id')::UUID,NULL,at,at);
    PERFORM pg_temp.timed_check(result->>'decision'='ineligible','known closed invoice precedes own pending uncertainty');
    PERFORM private.workflow_finalize_invoice_episodes_v1();
    x:=pg_temp.timed_workflow(pg_temp.timed_fixture('belt_test.upcoming'),'belt_test.upcoming'); at:=pg_temp.timed_at(x);
    identity:=private.workflow_rank_scope_enter_v1((x->>'studio')::UUID,(x->>'student')::UUID,'profile');
    before:=(SELECT jsonb_agg(to_jsonb(s)) FROM private.workflow_rank_scopes s WHERE studio_id=(x->>'studio')::UUID);
    result:=pg_temp.timed_scan(at);
    PERFORM pg_temp.timed_check(NOT EXISTS(SELECT 1 FROM public.automation_workflow_runs WHERE workflow_id=(x->>'workflow')::UUID)
        AND before=(SELECT jsonb_agg(to_jsonb(s)) FROM private.workflow_rank_scopes s WHERE studio_id=(x->>'studio')::UUID),'own rank scope unavailable without reconciliation');
    PERFORM private.workflow_rank_scope_finish_v1(identity); PERFORM private.workflow_rank_finalize_pending_v1((x->>'studio')::UUID);
    result:=pg_temp.timed_scan(at);
    PERFORM pg_temp.timed_check(EXISTS(SELECT 1 FROM public.automation_workflow_runs WHERE workflow_id=(x->>'workflow')::UUID),'finished unchanged rank scope admits later crossing');
    -- PostgreSQL's resolved midnight policy, including a repeated midnight.
    PERFORM pg_temp.timed_check(private.workflow_invoice_episode_threshold_v1(DATE '2018-11-03','America/Sao_Paulo')=TIMESTAMPTZ '2018-11-04 03:00+00','gap midnight resolution');
    PERFORM pg_temp.timed_check(private.workflow_invoice_episode_threshold_v1(DATE '2020-10-31','America/Havana')=TIMESTAMPTZ '2020-11-01 05:00+00','overlap later midnight resolution');
    PERFORM pg_temp.timed_check((TIMESTAMPTZ '2020-11-01 04:30+00' AT TIME ZONE 'America/Havana')::DATE>DATE '2020-10-31','between repeated midnight activation excluded by local date');
    PERFORM pg_temp.timed_check(private.workflow_invoice_episode_threshold_v1(DATE '9999-12-31','UTC') IS NULL
        AND private.workflow_invoice_episode_threshold_v1(DATE '0001-01-01','Pacific/Kiritimati') IS NOT NULL,'supported threshold UTC range');
    FOREACH kind IN ARRAY ARRAY['outage','missing'] LOOP
        x:=pg_temp.timed_workflow(pg_temp.timed_fixture('trial.upcoming',clock_timestamp()+INTERVAL '61 seconds'),'trial.upcoming',-1);
        IF kind='outage' THEN UPDATE public.studio_subscriptions SET status='canceled',comped=false WHERE studio_id=(x->>'studio')::UUID;
        ELSE DELETE FROM public.studio_subscriptions WHERE studio_id=(x->>'studio')::UUID; END IF;
        PERFORM pg_sleep(greatest(0,extract(epoch FROM pg_temp.timed_at(x)-clock_timestamp()))+0.02);
        result:=public.process_automation_workflow_occurrences_v1();
        PERFORM pg_temp.timed_check(EXISTS(SELECT 1 FROM public.automation_workflow_runs WHERE workflow_id=(x->>'workflow')::UUID),'real crossing records trigger during entitlement '||kind);
        UPDATE public.automation_workflow_runs SET next_due_at=clock_timestamp()+INTERVAL '1 day'
            WHERE state IN ('queued','waiting','claimed','running') AND workflow_id<>(x->>'workflow')::UUID;
        packet:=public.claim_automation_workflow_runs_v1(1)#>'{payload,claims,0}';
        result:=public.advance_automation_workflow_run_v1((x->>'studio')::UUID,(packet->>'run_id')::UUID,(packet->>'claim_token')::UUID,10);
        PERFORM pg_temp.timed_check(result#>>'{payload,outcome}'='waiting' AND result#>>'{payload,run,reason}'='subscription_required'
            AND NOT EXISTS(SELECT 1 FROM private.automation_workflow_run_steps WHERE run_id=(packet->>'run_id')::UUID),'runtime effect remains deferred during entitlement '||kind);
    END LOOP;
    -- Bad internal packets fail before acquiring any business parent.
    FOREACH changed IN ARRAY ARRAY['{}'::JSONB,'null'::JSONB,'[{}]'::JSONB] LOOP
        result:=pg_temp.timed_rpc(format('SELECT private.workflow_lock_timed_sources_v1(%L::jsonb)',changed));
        PERFORM pg_temp.timed_check(result->>'code'='22023','closed internal packet '||changed::TEXT);
    END LOOP;
    before:=pg_temp.timed_snapshot();
    BEGIN
        PERFORM pg_temp.timed_scan(clock_timestamp()+INTERVAL '2 days');
        RAISE EXCEPTION USING ERRCODE='P57T1';
    EXCEPTION WHEN SQLSTATE 'P57T1' THEN NULL;
    END;
    PERFORM pg_temp.timed_check(pg_temp.timed_snapshot()=before,'later failure rolls back all progress and effects');
END $$;
-- Historical clock fixtures exercise half-open intervals and PG midnight
-- choices. Only these named immutable clock fields are adjusted in this rollback
-- transaction; source contexts still come from the real schedule/episode owners.
DO $$
DECLARE x JSONB; at TIMESTAMPTZ; record_id UUID; packet JSONB; result JSONB; old JSONB; context JSONB; source_key TEXT; identity UUID;
BEGIN
    UPDATE public.automation_workflow_activations SET retired_at=coalesce(retired_at,greatest(clock_timestamp(),active_from)),cancelled_at=greatest(clock_timestamp(),retired_at,active_from) WHERE cancelled_at IS NULL;
    x:=pg_temp.timed_workflow(pg_temp.timed_fixture(),'trial.upcoming'); at:=pg_temp.timed_at(x);
    ALTER TABLE public.automation_workflow_activations DISABLE TRIGGER automation_workflow_activations_immutable;
    UPDATE public.automation_workflow_activations SET active_from=at WHERE id=(x->>'activation')::UUID;
    ALTER TABLE public.automation_workflow_activations ENABLE TRIGGER automation_workflow_activations_immutable;
    result:=pg_temp.timed_scan(at);
    PERFORM pg_temp.timed_check((result->>'enqueued')::INTEGER=1,'threshold equals activation start');
    x:=pg_temp.timed_workflow(pg_temp.timed_fixture(),'trial.upcoming'); at:=pg_temp.timed_at(x);
    UPDATE public.automation_workflow_activations SET retired_at=at WHERE id=(x->>'activation')::UUID;
    result:=pg_temp.timed_scan(at);
    PERFORM pg_temp.timed_check(NOT EXISTS(SELECT 1 FROM public.automation_workflow_runs WHERE workflow_id=(x->>'workflow')::UUID),'threshold equals retired boundary excluded');
    x:=pg_temp.timed_workflow(pg_temp.timed_fixture(),'trial.upcoming'); at:=pg_temp.timed_at(x);
    SELECT e.context INTO context FROM private.automation_workflow_events e WHERE e.subject_id=(x->>'source')::UUID AND e.event_type='trial.scheduled';
    source_key:=(x->>'source')||':1:-1440';
    INSERT INTO private.automation_workflow_events(studio_id,event_type,source_key,subject_kind,subject_id,occurred_at,context)
        VALUES((x->>'studio')::UUID,'trial.upcoming',source_key,'trial',gen_random_uuid(),at,context) RETURNING id INTO identity;
    old:=pg_temp.timed_snapshot(); result:=pg_temp.timed_rpc(format('SELECT pg_temp.timed_scan(%L)',at));
    PERFORM pg_temp.timed_check(result->>'message'='AUTOMATION_STATE_CONFLICT' AND pg_temp.timed_snapshot()=old,'conflicting immutable occurrence aborts all progress');
    DELETE FROM private.automation_workflow_events WHERE id=identity;
    UPDATE public.automation_workflow_activations SET retired_at=coalesce(retired_at,greatest(clock_timestamp(),active_from)),cancelled_at=greatest(clock_timestamp(),retired_at,active_from) WHERE cancelled_at IS NULL;
    x:=pg_temp.timed_fixture('invoice.overdue',TIMESTAMPTZ '2020-11-01 05:00+00');
    UPDATE public.studios SET timezone='America/Havana' WHERE id=(x->>'studio')::UUID;
    UPDATE public.billing_invoices SET currency='eur' WHERE id=(x->>'source')::UUID;
    UPDATE public.billing_invoices SET currency='usd' WHERE id=(x->>'source')::UUID;
    PERFORM private.workflow_finalize_invoice_episodes_v1();
    SELECT current_episode_id INTO record_id FROM private.workflow_invoice_episode_state WHERE invoice_id=(x->>'source')::UUID;
    ALTER TABLE private.workflow_invoice_collection_episodes DISABLE TRIGGER workflow_invoice_episode_identity_v1;
    UPDATE private.workflow_invoice_collection_episodes SET opened_at=TIMESTAMPTZ '2020-10-31 03:00+00',threshold_eligible=true WHERE id=record_id;
    ALTER TABLE private.workflow_invoice_collection_episodes ENABLE TRIGGER workflow_invoice_episode_identity_v1;
    x:=pg_temp.timed_workflow(x,'invoice.overdue'); at:=pg_temp.timed_at(x);
    ALTER TABLE public.automation_workflow_activations DISABLE TRIGGER automation_workflow_activations_immutable;
    UPDATE public.automation_workflow_activations SET active_from=TIMESTAMPTZ '2020-11-01 04:30+00' WHERE id=(x->>'activation')::UUID;
    ALTER TABLE public.automation_workflow_activations ENABLE TRIGGER automation_workflow_activations_immutable;
    result:=pg_temp.timed_scan(at);
    PERFORM pg_temp.timed_check((result->>'enqueued')::INTEGER=0,'actual admission denies activation between repeated midnights');
    ALTER TABLE public.automation_workflow_activations DISABLE TRIGGER automation_workflow_activations_immutable;
    UPDATE public.automation_workflow_activations SET active_from=TIMESTAMPTZ '2020-11-01 03:30+00' WHERE id=(x->>'activation')::UUID;
    ALTER TABLE public.automation_workflow_activations ENABLE TRIGGER automation_workflow_activations_immutable;
    result:=pg_temp.timed_scan(at);
    PERFORM pg_temp.timed_check((result->>'enqueued')::INTEGER=1 AND (SELECT frozen_timezone='America/Havana' FROM private.workflow_invoice_collection_episodes WHERE id=record_id),'earlier local date admits same frozen repeated midnight');
END $$;
-- Large raw histories are deliberately synthetic. Missing provenance is tested
-- as unavailable, while the four command-created sources remain real events.
DO $$
DECLARE x JSONB; y JSONB; packet JSONB; result JSONB; at TIMESTAMPTZ:=clock_timestamp()+INTERVAL '1 day 1 minute';
    starts TIMESTAMPTZ:=clock_timestamp()+INTERVAL '2 days'; s UUID; w UUID; v UUID; epoch BIGINT; last UUID; expected UUID;
    idx INTEGER; count_pairs INTEGER; chosen UUID[]; metadata RECORD; old JSONB; malformed JSONB; item JSONB;
BEGIN
    UPDATE public.automation_workflow_activations SET retired_at=coalesce(retired_at,greatest(clock_timestamp(),active_from)),cancelled_at=greatest(clock_timestamp(),retired_at,active_from) WHERE cancelled_at IS NULL;
    CREATE TEMP TABLE timed_backlog_sources(id UUID PRIMARY KEY);
    CREATE TEMP TABLE timed_backlog_seen(id UUID PRIMARY KEY);
    FOR idx IN 1..4 LOOP
        x:=pg_temp.timed_workflow(pg_temp.timed_fixture('trial.upcoming',starts),'trial.upcoming');
        INSERT INTO pg_temp.timed_backlog_sources VALUES((x->>'source')::UUID);
        WITH leads AS (
            INSERT INTO public.leads(studio_id,first_name,last_name,source,stage)
                SELECT (x->>'studio')::UUID,'Raw','No provenance','referral','inquiry' FROM generate_series(1,500) RETURNING id),
        trials AS (
            INSERT INTO public.lead_trial_appointments(studio_id,lead_id,starts_at,ends_at,timezone)
                SELECT (x->>'studio')::UUID,id,starts,starts+INTERVAL '1 hour','UTC' FROM leads RETURNING id)
        INSERT INTO pg_temp.timed_backlog_sources SELECT id FROM trials;
    END LOOP;
    SELECT t.studio_id,t.workflow_id,t.version_id,t.epoch INTO s,w,v,epoch FROM private.workflow_timer_activations t ORDER BY t.studio_id,t.activation_id LIMIT 1;
    INSERT INTO public.automation_workflow_activations(studio_id,workflow_id,version_id,epoch,active_from,retired_at,cancelled_at)
        SELECT s,w,v,epoch,clock_timestamp(),clock_timestamp(),clock_timestamp() FROM generate_series(1,150);
    UPDATE private.workflow_timer_dispatch_cursor SET last_studio_id=NULL,last_activation_id=NULL;
    SELECT activation_id INTO expected FROM private.workflow_timer_activations ORDER BY studio_id,activation_id OFFSET 99 LIMIT 1;
    packet:=private.workflow_timed_candidates_v1(100,at);
    SELECT last_activation_id INTO last FROM private.workflow_timer_dispatch_cursor;
    PERFORM pg_temp.timed_check(last=expected,'raw 100 activation bound precedes canceled filter');
    INSERT INTO pg_temp.timed_backlog_seen SELECT (z->>'source_record_id')::UUID FROM jsonb_array_elements(packet->'pairs') z ON CONFLICT DO NOTHING;
    FOR idx IN 1..120 LOOP
        result:=pg_temp.timed_scan(at+idx*INTERVAL '1 microsecond',100); packet:=result->'packet'; count_pairs:=jsonb_array_length(packet->'pairs');
        IF count_pairs>100 OR EXISTS(SELECT 1 FROM jsonb_array_elements(packet->'pairs') z GROUP BY z->>'activation_id' HAVING count(*)>25) THEN
            RAISE EXCEPTION 'Raw pair bound violated';
        END IF;
        IF EXISTS(SELECT 1 FROM jsonb_array_elements(packet->'pairs') z GROUP BY z->>'activation_id',z->>'source_record_id' HAVING count(*)>1) THEN
            RAISE EXCEPTION 'Duplicate pair inside bounded decision page';
        END IF;
        INSERT INTO pg_temp.timed_backlog_seen SELECT (z->>'source_record_id')::UUID FROM jsonb_array_elements(packet->'pairs') z ON CONFLICT DO NOTHING;
        EXIT WHEN (SELECT count(*) FROM pg_temp.timed_backlog_seen)=2004;
    END LOOP;
    PERFORM pg_temp.timed_check((SELECT count(*)=2004 FROM pg_temp.timed_backlog_seen),'2004 sources across four studios eventually wrap despite unavailable history');
    PERFORM pg_temp.timed_check((SELECT count(*)=4 FROM private.automation_workflow_events e JOIN pg_temp.timed_backlog_sources s ON s.id=e.subject_id
        WHERE e.event_type='trial.upcoming'),'unavailable backlog creates no invented occurrence');
    ANALYZE public.lead_trial_appointments;
    SELECT id INTO last FROM public.lead_trial_appointments WHERE studio_id=(x->>'studio')::UUID ORDER BY starts_at,id OFFSET 200 LIMIT 1;
    EXECUTE format('EXPLAIN (ANALYZE,COSTS OFF,FORMAT JSON) SELECT t.id,t.id subject_id,t.starts_at+INTERVAL ''-1440 minutes'' threshold_at,t.starts_at
        FROM public.lead_trial_appointments t WHERE t.studio_id=%L AND t.status=''scheduled'' AND t.starts_at>%L AND t.starts_at>=%L AND t.starts_at<=%L
        AND (t.starts_at,t.id)>(%L,%L) ORDER BY t.starts_at,t.id LIMIT 1',x->>'studio',at,starts,starts,starts,last) INTO result;
    INSERT INTO pg_temp.timed_plans VALUES('trial cursor after 200 rows',result);
    PERFORM pg_temp.timed_check(result::TEXT LIKE '%lead_trial_appointments_timer_scan%' AND result::TEXT LIKE '%Index Cond%'
        AND result::TEXT NOT LIKE '%Rows Removed by Filter%', 'actual trial seek plan has no discarded historical prefix');
    SELECT studio_id,activation_id INTO s,last FROM private.workflow_timer_activations ORDER BY studio_id,activation_id OFFSET 100 LIMIT 1;
    SET LOCAL enable_seqscan=off;
    EXECUTE format('EXPLAIN (ANALYZE,COSTS OFF,FORMAT JSON) SELECT * FROM private.workflow_timer_activations t
        WHERE (t.studio_id,t.activation_id)>(%L,%L) ORDER BY t.studio_id,t.activation_id LIMIT 1 FOR UPDATE NOWAIT',s,last) INTO result;
    INSERT INTO pg_temp.timed_plans VALUES('metadata typed seek with small-fixture seqscan disabled',result);
    PERFORM pg_temp.timed_check(result::TEXT LIKE '%workflow_timer_activations_scan%' AND result::TEXT LIKE '%Index Cond%','metadata indexed seek');
    SET LOCAL enable_seqscan=on;
    FOREACH idx IN ARRAY ARRAY[1,25,26,100] LOOP
        packet:=private.workflow_timed_candidates_v1(idx,at);
        PERFORM pg_temp.timed_check(jsonb_array_length(packet->'pairs')<=idx,'actual pair request cap '||idx);
    END LOOP;
    UPDATE public.automation_workflow_activations SET retired_at=coalesce(retired_at,greatest(clock_timestamp(),active_from)),cancelled_at=greatest(clock_timestamp(),retired_at,active_from) WHERE cancelled_at IS NULL;
    x:=pg_temp.timed_workflow(pg_temp.timed_fixture('invoice.overdue'),'invoice.overdue');
    INSERT INTO public.billing_invoices(studio_id,payer_id,status,currency,amount_due_cents,amount_paid_cents,amount_remaining_cents,due_date,
        stripe_account_id,stripe_customer_id,stripe_invoice_id,metadata)
        SELECT i.studio_id,i.payer_id,'open','usd',1000,0,1000,i.due_date,i.stripe_account_id,i.stripe_customer_id,'in_'||gen_random_uuid(),i.metadata
        FROM public.billing_invoices i CROSS JOIN generate_series(1,12) WHERE i.id=(x->>'source')::UUID;
    PERFORM private.workflow_finalize_invoice_episodes_v1();
    SET LOCAL enable_seqscan=off;
    SELECT id INTO last FROM private.workflow_invoice_collection_episodes WHERE studio_id=(x->>'studio')::UUID ORDER BY threshold_at,id OFFSET 3 LIMIT 1;
    EXECUTE format('EXPLAIN (ANALYZE,COSTS OFF,FORMAT JSON) SELECT e.id,e.invoice_id,e.threshold_at FROM private.workflow_invoice_collection_episodes e
        WHERE e.studio_id=%L AND e.closed_at IS NULL AND e.threshold_eligible AND e.threshold_at<=%L
        AND (e.threshold_at,e.id)>(%L,%L) ORDER BY e.threshold_at,e.id LIMIT 1',x->>'studio',pg_temp.timed_at(x),pg_temp.timed_at(x),last) INTO result;
    INSERT INTO pg_temp.timed_plans VALUES('invoice typed seek with small-fixture seqscan disabled',result);
    PERFORM pg_temp.timed_check(result::TEXT LIKE '%workflow_invoice_episodes_timer_scan%' AND result::TEXT LIKE '%Index Cond%','invoice indexed seek');
    SET LOCAL enable_seqscan=on;
    CREATE TEMP TABLE timed_invoice_seen(id UUID PRIMARY KEY);
    FOR idx IN 1..8 LOOP
        packet:=private.workflow_timed_candidates_v1(100,pg_temp.timed_at(x));
        PERFORM pg_temp.timed_check((SELECT count(DISTINCT z->>'subject_id')<=10 FROM jsonb_array_elements(packet->'pairs') z),'ten invoice cap pass '||idx);
        INSERT INTO pg_temp.timed_invoice_seen SELECT (z->>'subject_id')::UUID FROM jsonb_array_elements(packet->'pairs') z ON CONFLICT DO NOTHING;
    END LOOP;
    PERFORM pg_temp.timed_check((SELECT count(*)=13 FROM pg_temp.timed_invoice_seen),'eleventh invoice position preserved for later calls');
    UPDATE public.automation_workflow_activations SET retired_at=coalesce(retired_at,greatest(clock_timestamp(),active_from)),cancelled_at=greatest(clock_timestamp(),retired_at,active_from) WHERE cancelled_at IS NULL;
    x:=pg_temp.timed_fixture('belt_test.upcoming',starts); x:=pg_temp.timed_workflow(x,'belt_test.upcoming');
    FOR idx IN 1..35 LOOP
        s:=gen_random_uuid();
        INSERT INTO public.students(id,studio_id,legal_first_name,legal_last_name,status,program_id,membership_start_date)
            VALUES(s,(x->>'studio')::UUID,'Recipient','Raw page','active',(x->>'program')::UUID,CURRENT_DATE-100);
        SET CONSTRAINTS private.workflow_rank_deferred IMMEDIATE;
        PERFORM public.approve_belt_test_recipients_v1((x->>'studio')::UUID,(x->>'actor')::UUID,(x->>'parent')::UUID,gen_random_uuid(),1,
            jsonb_build_array(jsonb_build_object('student_id',s,'student_program_membership_id',NULL)));
    END LOOP;
    CREATE TEMP TABLE timed_belt_seen(id UUID PRIMARY KEY);
    FOR idx IN 1..10 LOOP
        packet:=private.workflow_timed_candidates_v1(100,at);
        INSERT INTO pg_temp.timed_belt_seen SELECT (z->>'subject_id')::UUID FROM jsonb_array_elements(packet->'pairs') z ON CONFLICT DO NOTHING;
    END LOOP;
    PERFORM pg_temp.timed_check((SELECT count(*)=36 FROM pg_temp.timed_belt_seen),'recipient continuation beyond 25 and equal parent coordinate');
    SET LOCAL enable_seqscan=off;
    SELECT id INTO last FROM public.belt_test_recipients WHERE studio_id=(x->>'studio')::UUID AND state='approved' ORDER BY id OFFSET 10 LIMIT 1;
    EXECUTE format('EXPLAIN (ANALYZE,COSTS OFF,FORMAT JSON) SELECT r.id FROM public.belt_test_recipients r WHERE r.studio_id=%L AND r.event_id=%L
        AND r.state=''approved'' AND r.id>%L ORDER BY r.id LIMIT 25',x->>'studio',x->>'parent',last) INTO result;
    INSERT INTO pg_temp.timed_plans VALUES('recipient typed seek with small-fixture seqscan disabled',result);
    PERFORM pg_temp.timed_check(result::TEXT LIKE '%belt_test_recipients_timer_scan%' AND result::TEXT LIKE '%Index Cond%','recipient indexed seek');
    SET LOCAL enable_seqscan=on;
    FOR idx IN 1..4 LOOP PERFORM pg_temp.timed_workflow(x,'belt_test.upcoming'); END LOOP;
    UPDATE private.workflow_timer_activations SET last_threshold_at=NULL,last_event_id=NULL,last_source_id=NULL WHERE studio_id=(x->>'studio')::UUID;
    SELECT studio_id,activation_id INTO s,last FROM private.workflow_timer_activations WHERE studio_id<(x->>'studio')::UUID ORDER BY studio_id DESC,activation_id DESC LIMIT 1;
    UPDATE private.workflow_timer_dispatch_cursor SET last_studio_id=s,last_activation_id=last;
    result:=pg_temp.timed_scan(at);
    PERFORM pg_temp.timed_check((result->>'enqueued')::INTEGER=100 AND (result->>'created')::INTEGER BETWEEN 25 AND 36
        AND result#>'{packet,has_more}'='true'::JSONB,'actual 100 insert flags stay bounded while events are reused');
    UPDATE public.belt_test_recipients SET state='revoked',revision=revision+1,revoked_at=clock_timestamp() WHERE studio_id=(x->>'studio')::UUID;
    INSERT INTO public.belt_test_events(studio_id,name,ladder_id,starts_at,ends_at,timezone,status)
        SELECT (x->>'studio')::UUID,'Empty raw parent',(x->>'ladder')::UUID,starts,starts+INTERVAL '1 hour','UTC','scheduled' FROM generate_series(1,150);
    SET LOCAL enable_seqscan=off;
    SELECT id INTO last FROM public.belt_test_events WHERE studio_id=(x->>'studio')::UUID ORDER BY starts_at,id OFFSET 50 LIMIT 1;
    EXECUTE format('EXPLAIN (ANALYZE,COSTS OFF,FORMAT JSON) SELECT * FROM public.belt_test_events e WHERE e.studio_id=%L AND e.status=''scheduled''
        AND e.starts_at>%L AND (e.starts_at,e.id)>(%L,%L) ORDER BY e.starts_at,e.id LIMIT 1',x->>'studio',at,starts,last) INTO result;
    INSERT INTO pg_temp.timed_plans VALUES('belt parent typed seek with small-fixture seqscan disabled',result);
    PERFORM pg_temp.timed_check(result::TEXT LIKE '%belt_test_events_timer_scan%' AND result::TEXT LIKE '%Index Cond%','parent indexed seek');
    SET LOCAL enable_seqscan=on;
    UPDATE private.workflow_timer_activations SET last_threshold_at=NULL,last_event_id=NULL,last_source_id=NULL WHERE studio_id=(x->>'studio')::UUID;
    SELECT studio_id,activation_id INTO s,last FROM private.workflow_timer_activations WHERE studio_id<(x->>'studio')::UUID ORDER BY studio_id DESC,activation_id DESC LIMIT 1;
    UPDATE private.workflow_timer_dispatch_cursor SET last_studio_id=s,last_activation_id=last;
    packet:=private.workflow_timed_candidates_v1(100,at);
    SELECT id INTO expected FROM public.belt_test_events WHERE studio_id=(x->>'studio')::UUID AND status='scheduled' ORDER BY starts_at,id OFFSET 24 LIMIT 1;
    PERFORM pg_temp.timed_check(jsonb_array_length(packet->'pairs')=0 AND packet->'has_more'='true'::JSONB
        AND (SELECT count(*)=4 AND bool_and(last_event_id=expected AND last_source_id IS NULL) FROM private.workflow_timer_activations
            WHERE studio_id=(x->>'studio')::UUID AND last_event_id IS NOT NULL),'25 raw empty parents per activation and 100 per call');
    PERFORM pg_temp.timed_check(NOT EXISTS(SELECT 1 FROM private.workflow_timer_activations t WHERE t.studio_id=(x->>'studio')::UUID AND t.last_event_id IS NOT NULL
        AND NOT EXISTS(SELECT 1 FROM public.belt_test_events e WHERE e.id=t.last_event_id)),'typed belt cursor contains only actual event identities');
    -- Private shape and corruption branches are unavailable, never zero success.
    old:=pg_temp.timed_snapshot();
    BEGIN
        DELETE FROM private.workflow_timer_dispatch_cursor;
        result:=pg_temp.timed_rpc('SELECT public.process_automation_workflow_occurrences_v1();');
        PERFORM pg_temp.timed_check(result->>'message'='AUTOMATION_STATE_CONFLICT','missing singleton never reseeded');
        RAISE EXCEPTION USING ERRCODE='P57T2';
    EXCEPTION WHEN SQLSTATE 'P57T2' THEN NULL;
    END;
    PERFORM pg_temp.timed_check(pg_temp.timed_snapshot()=old,'missing singleton probe restores exact owned state');
END $$;
SELECT count(*) AS timed_enrollment_contract_checks FROM pg_temp.timed_checks;
SELECT jsonb_object_agg(label,plan) AS timed_query_plans FROM pg_temp.timed_plans;
ROLLBACK;
