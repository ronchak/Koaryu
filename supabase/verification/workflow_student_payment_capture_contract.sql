-- Committed command-owned occurrences on a disposable database only.
BEGIN;
SET LOCAL statement_timeout='60s';
CREATE TEMP TABLE capture_checks(label TEXT PRIMARY KEY);
CREATE FUNCTION pg_temp.capture_check(ok BOOLEAN,label TEXT) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
    IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'capture contract failed: %',label; END IF;
    INSERT INTO pg_temp.capture_checks VALUES(label);
END $$;
CREATE FUNCTION pg_temp.capture_error(statement TEXT,code TEXT,message TEXT,label TEXT) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE got_code TEXT; got_message TEXT;
BEGIN
    BEGIN EXECUTE statement; EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS got_code=RETURNED_SQLSTATE,got_message=MESSAGE_TEXT; END;
    IF got_code IS DISTINCT FROM code OR got_message IS DISTINCT FROM message THEN
        RAISE EXCEPTION 'capture negative failed %: got % (%), expected % (%)',label,got_code,got_message,code,message;
    END IF;
    PERFORM pg_temp.capture_check(true,label);
END $$;
CREATE FUNCTION pg_temp.capture_fixture() RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE a UUID:=gen_random_uuid(); o UUID:=gen_random_uuid(); s UUID:=gen_random_uuid(); p UUID:=gen_random_uuid(); l UUID:=gen_random_uuid(); staff UUID:=gen_random_uuid();
BEGIN
    INSERT INTO auth.users(id,email,email_confirmed_at) VALUES(a,a||'@example.invalid',clock_timestamp()),(o,o||'@example.invalid',clock_timestamp()),(staff,staff||'@example.invalid',clock_timestamp());
    INSERT INTO public.studios(id,name,slug,owner_id,timezone) VALUES(s,'Capture contract',s::TEXT,o,'UTC');
    INSERT INTO public.staff_roles(studio_id,user_id,role) VALUES(s,a,'front_desk'),(s,o,'admin'),(s,staff,'instructor');
    INSERT INTO public.studio_subscriptions(studio_id,status,comped) VALUES(s,'active',false);
    INSERT INTO public.programs(id,studio_id,name) VALUES(p,s,'Program');
    INSERT INTO public.leads(id,studio_id,first_name,last_name,program_id) VALUES(l,s,'Direct demo','Lead',p);
    RETURN jsonb_build_object('studio',s,'actor',a,'owner',o,'program',p,'lead',l,'assignee',staff);
END $$;
CREATE FUNCTION pg_temp.capture_workflow(s UUID,a UUID,event_type TEXT,program UUID DEFAULT NULL) RETURNS UUID LANGUAGE plpgsql AS $$
DECLARE g JSONB; r JSONB; w UUID;
BEGIN
    g:=jsonb_build_object('schema_version',1,'nodes',jsonb_build_array(
        jsonb_build_object('id','trigger','type','trigger','config',jsonb_build_object('event_type',event_type,'program_id',program)),
        '{"id":"end","type":"end","config":{}}'::JSONB),'edges','[{"id":"next","source":"trigger","target":"end","port":"next"}]'::JSONB);
    r:=public.create_automation_workflow_v1(s,a,gen_random_uuid(),'Capture','',g,'{}'); w:=(r#>>'{payload,id}')::UUID;
    PERFORM public.command_automation_workflow_v1(s,a,w,gen_random_uuid(),1,'publish');
    PERFORM public.command_automation_workflow_v1(s,a,w,gen_random_uuid(),2,'start');
    RETURN w;
END $$;
CREATE FUNCTION pg_temp.capture_facts(s UUID) RETURNS JSONB LANGUAGE sql AS $$
 SELECT jsonb_build_object('leads',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY id),'[]') FROM public.leads r WHERE studio_id=s),
 'activities',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY id),'[]') FROM public.lead_activities r WHERE studio_id=s),
 'audits',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY id),'[]') FROM public.audit_logs r WHERE studio_id=s),
 'events',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY id),'[]') FROM private.automation_workflow_events r WHERE studio_id=s),
 'runs',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY id),'[]') FROM public.automation_workflow_runs r WHERE studio_id=s),
 'receipts',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY operation_id),'[]') FROM private.automation_command_operations r WHERE studio_id=s))
$$;
CREATE FUNCTION pg_temp.capture_fail() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF current_setting('koaryu.capture_fail',true)=TG_TABLE_NAME THEN RAISE EXCEPTION 'CAPTURE_INJECTED_FAILURE'; END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER capture_test_failure AFTER INSERT ON public.lead_activities FOR EACH ROW EXECUTE FUNCTION pg_temp.capture_fail();
CREATE TRIGGER capture_test_failure AFTER INSERT ON public.audit_logs FOR EACH ROW EXECUTE FUNCTION pg_temp.capture_fail();
CREATE TRIGGER capture_test_failure AFTER INSERT ON private.automation_workflow_events FOR EACH ROW EXECUTE FUNCTION pg_temp.capture_fail();
CREATE TRIGGER capture_test_failure AFTER INSERT ON public.automation_workflow_runs FOR EACH ROW EXECUTE FUNCTION pg_temp.capture_fail();
CREATE TRIGGER capture_test_failure AFTER INSERT ON private.automation_command_operations FOR EACH ROW EXECUTE FUNCTION pg_temp.capture_fail();
GRANT ALL ON pg_temp.capture_checks TO service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO service_role;
DO $$
DECLARE x JSONB:=pg_temp.capture_fixture(); y JSONB:=pg_temp.capture_fixture();
    s UUID:=(x->>'studio')::UUID; a UUID:=(x->>'actor')::UUID; owner UUID:=(x->>'owner')::UUID;
    program UUID:=(x->>'program')::UUID; student UUID:=gen_random_uuid(); existing UUID:=gen_random_uuid();
    converted UUID:=gen_random_uuid(); lead UUID:=(x->>'lead')::UUID; l2 UUID:=gen_random_uuid();
    welcome UUID; filtered UUID; stage_workflow UUID; promotion_workflow UUID; payment_workflow UUID;
    ladder UUID:=gen_random_uuid(); white UUID:=gen_random_uuid(); yellow UUID:=gen_random_uuid();
    promotion UUID; op UUID:=gen_random_uuid(); membership UUID; payer UUID:=gen_random_uuid(); invoice UUID:=gen_random_uuid();
    payment UUID:=gen_random_uuid(); later UUID:=gen_random_uuid(); unlinked UUID:=gen_random_uuid();
    demo_payment UUID; demo_payer UUID:=gen_random_uuid(); demo_invoice UUID:=gen_random_uuid();
    failed UUID; run UUID; programs UUID[]:=ARRAY[program]; p UUID; result RECORD;
    before JSONB; after JSONB; marker JSONB; source_event private.automation_workflow_events; k TEXT; n INTEGER;
BEGIN
    PERFORM pg_temp.capture_check((SELECT relrowsecurity AND relpersistence='p' AND pg_get_userbyid(relowner)='postgres'
        FROM pg_class WHERE oid='private.workflow_payment_capture_markers'::REGCLASS),'payment marker logged private RLS table');
    PERFORM pg_temp.capture_check(NOT has_table_privilege('anon','private.workflow_payment_capture_markers','SELECT')
        AND NOT has_table_privilege('authenticated','private.workflow_payment_capture_markers','INSERT')
        AND NOT has_table_privilege('service_role','private.workflow_payment_capture_markers','DELETE'),'marker client and deletion privileges denied');
    FOR k IN SELECT unnest(ARRAY['workflow_student_enrollment_event_v1(uuid,uuid,jsonb)','workflow_capture_payment_failure_v1()']) LOOP
        PERFORM pg_temp.capture_check((SELECT NOT prosecdef AND proconfig=ARRAY['search_path=""']
            AND has_function_privilege('service_role',oid,'EXECUTE') AND NOT has_function_privilege('anon',oid,'EXECUTE')
            AND NOT has_function_privilege('authenticated',oid,'EXECUTE') FROM pg_proc WHERE oid=('private.'||k)::REGPROCEDURE),'private bounded capture ACL '||k);
    END LOOP;
    SET LOCAL ROLE service_role;
    welcome:=pg_temp.capture_workflow(s,owner,'student.enrolled');
    filtered:=pg_temp.capture_workflow(s,owner,'student.enrolled',program);
    stage_workflow:=pg_temp.capture_workflow(s,owner,'lead.stage_changed');
    promotion_workflow:=pg_temp.capture_workflow(s,owner,'student.promoted',program);
    payment_workflow:=pg_temp.capture_workflow(s,owner,'invoice.payment_failed');
    -- Inputs remain unbounded by the 25-target projection, through the actual v2 entry.
    FOR n IN 1..30 LOOP
        p:=gen_random_uuid(); programs:=array_append(programs,p);
        INSERT INTO public.programs(id,studio_id,name) VALUES(p,s,'Extra program '||n);
    END LOOP;
    SELECT * INTO result FROM public.write_student_profile_v2_atomic(student,s,a,
        '{"legal_first_name":"New","legal_last_name":"Student","status":"active"}',programs,'[]',true,'student.created');
    SELECT * INTO source_event FROM private.automation_workflow_events WHERE studio_id=s AND event_type='student.enrolled' AND subject_id=student;
    PERFORM pg_temp.capture_check(source_event.source_key=student::TEXT AND source_event.subject_kind='student'
        AND source_event.context=jsonb_build_object('student_id',student,'matched_program_ids',jsonb_build_array(program))
        AND jsonb_array_length(result.result_program_memberships)=31,'actual v2 insert captures once with bounded exact current membership filters');
    PERFORM pg_temp.capture_check((SELECT count(*)=2 FROM public.automation_workflow_runs WHERE event_id=source_event.id),'generic and matching welcome targets');
    INSERT INTO public.students(id,studio_id,legal_first_name,legal_last_name) VALUES(existing,s,'Direct demo','Student');
    PERFORM public.write_student_profile_v2_atomic(existing,s,a,'{"phone":"edited"}',NULL,'[]',false,'student.created');
    PERFORM pg_temp.capture_check(NOT EXISTS(SELECT 1 FROM private.automation_workflow_events WHERE subject_id=existing),'forged created audit on existing student does not welcome');
    PERFORM public.write_student_profile_v2_atomic(student,s,a,'{"phone":"edited"}',programs,'[]',true,'student.created');
    PERFORM pg_temp.capture_check((SELECT count(*)=1 FROM private.automation_workflow_events WHERE event_type='student.enrolled' AND subject_id=student),'profile replay or added programs cannot welcome twice');

    PERFORM public.convert_lead_to_student_atomic(s,a,lead,converted,program,'active',CURRENT_DATE);
    PERFORM pg_temp.capture_check((SELECT count(*)=1 FROM private.automation_workflow_events WHERE event_type='student.enrolled' AND subject_id=converted)
        AND (SELECT count(*)=1 FROM private.automation_workflow_events WHERE event_type='lead.stage_changed' AND subject_id=lead),'first conversion captures both owned events');
    SELECT * INTO source_event FROM private.automation_workflow_events WHERE event_type='lead.stage_changed' AND subject_id=lead;
    PERFORM pg_temp.capture_check(EXISTS(SELECT 1 FROM public.lead_activities WHERE id=(source_event.context->>'activity_id')::UUID
        AND studio_id=s AND lead_id=lead AND activity_type='stage_change') AND source_event.source_key=source_event.context->>'activity_id','conversion stage key is actual owned activity');
    SELECT pg_temp.capture_facts(s) INTO before;
    PERFORM public.convert_lead_to_student_atomic(s,a,lead,gen_random_uuid(),NULL,'inactive',NULL);
    PERFORM pg_temp.capture_check(before=pg_temp.capture_facts(s),'unchanged restoration preserves original result and no effects');
    UPDATE public.leads SET follow_up_date=CURRENT_DATE+1 WHERE id=lead;
    PERFORM public.convert_lead_to_student_atomic(s,a,lead,gen_random_uuid(),NULL,'inactive',NULL);
    PERFORM pg_temp.capture_check((SELECT count(*)=1 FROM private.automation_workflow_events WHERE subject_id=lead),'follow-up-only restoration has no stage occurrence');
    UPDATE public.leads SET stage='inquiry' WHERE id=lead;
    PERFORM public.convert_lead_to_student_atomic(s,a,lead,gen_random_uuid(),NULL,'inactive',NULL);
    PERFORM pg_temp.capture_check((SELECT count(*)=2 FROM private.automation_workflow_events WHERE event_type='lead.stage_changed' AND subject_id=lead)
        AND (SELECT count(*)=1 FROM private.automation_workflow_events WHERE event_type='student.enrolled' AND subject_id=converted),'real restoration stage activity without second welcome');
    INSERT INTO public.leads(id,studio_id,first_name,last_name,program_id) VALUES(l2,s,'Retained','Student',program);
    PERFORM public.convert_lead_to_student_atomic(s,a,l2,student,program,'active',CURRENT_DATE);
    PERFORM pg_temp.capture_check((SELECT count(*)=1 FROM private.automation_workflow_events WHERE event_type='student.enrolled' AND subject_id=student),'ON CONFLICT retained student does not gain second welcome');
    INSERT INTO public.leads(id,studio_id,first_name,last_name,program_id) VALUES(gen_random_uuid(),s,'Retained','Demo',program) RETURNING id INTO l2;
    PERFORM public.convert_lead_to_student_atomic(s,a,l2,existing,program,'active',CURRENT_DATE);
    PERFORM pg_temp.capture_check(NOT EXISTS(SELECT 1 FROM private.automation_workflow_events WHERE event_type='student.enrolled' AND subject_id=existing),'ON CONFLICT retained direct student never welcomes');

    INSERT INTO public.belt_ladders(id,studio_id,program_id,name) VALUES(ladder,s,program,'Ranks');
    INSERT INTO public.belt_ranks(id,studio_id,ladder_id,name,display_order) VALUES(white,s,ladder,'White',1),(yellow,s,ladder,'Yellow',2);
    SELECT id INTO membership FROM public.student_program_memberships WHERE student_id=student AND program_id=program AND ended_at IS NULL;
    SELECT id INTO promotion FROM public.record_student_rank_transition_v3(s,student,membership,program,white,a,NULL,'promotion',op);
    SELECT * INTO source_event FROM private.automation_workflow_events WHERE event_type='student.promoted' AND subject_id=promotion;
    PERFORM pg_temp.capture_check(source_event.source_key=promotion::TEXT AND source_event.subject_kind='promotion' AND source_event.context=jsonb_build_object(
        'promotion_id',promotion,'student_id',student,'student_program_membership_id',membership,'program_id',program,'rank_id',white,'from_rank_id',NULL,'rank_context_generation',2),'actual promotion stores exact returned identity and resolved context');
    PERFORM pg_temp.capture_check(private.workflow_rank_context_generation_v1(s,student,membership)=2,'genuine promotion advances its exact generation once');
    PERFORM public.record_student_rank_transition_v3(s,student,membership,program,white,a,NULL,'promotion',op);
    PERFORM pg_temp.capture_check((SELECT count(*)=1 FROM private.automation_workflow_events WHERE event_type='student.promoted'),'rank operation replay is silent');
    PERFORM public.record_student_rank_transition_v3(s,student,membership,program,yellow,a,NULL,'promotion',gen_random_uuid());
    PERFORM public.record_student_rank_transition_v3(s,student,membership,program,white,a,'Correction','demotion',gen_random_uuid());
    INSERT INTO public.promotions(studio_id,student_id,student_program_membership_id,program_id,from_rank_id,to_rank_id,promoted_by)
        VALUES(s,student,membership,program,white,yellow,a);
    PERFORM pg_temp.capture_check((SELECT count(*)=2 FROM private.automation_workflow_events WHERE event_type='student.promoted'),'demotion and direct demo promotion insert are silent');

    -- Invoke the real import owner, which inserts directly, while welcome is active.
    SELECT * INTO result FROM public.claim_student_import_run_v2(s,a,'students_csv_execute','capture-import','capture-hash','capture-token',45);
    run:=(result.run_row->>'id')::UUID; failed:=gen_random_uuid();
    PERFORM public.import_student_row_atomic(jsonb_build_object('id',failed,'studio_id',s,'legal_first_name','Imported','legal_last_name','Student',
        'tags','[]'::JSONB,'_import_outcome',jsonb_build_object('row_number',2,'is_valid',true,'issues','[]'::JSONB,
            'data','{"legal_first_name":"Imported","legal_last_name":"Student"}'::JSONB,'imported_without_belt',false)),
        s,run,'capture-token',2,NULL,NULL,NULL,NULL,ARRAY[program]);
    PERFORM pg_temp.capture_check(EXISTS(SELECT 1 FROM public.students WHERE id=failed)
        AND NOT EXISTS(SELECT 1 FROM private.automation_workflow_events WHERE event_type='student.enrolled' AND subject_id=failed),'actual import owner remains excluded');

    INSERT INTO public.billing_payers(id,studio_id,display_name) VALUES(payer,s,'Synthetic payer');
    INSERT INTO public.billing_invoices(id,studio_id,payer_id,status,amount_due_cents) VALUES(invoice,s,payer,'open',1000);
    INSERT INTO public.billing_payments(id,studio_id,payer_id,invoice_id,status,amount_cents) VALUES(payment,s,payer,invoice,'failed',1000);
    SELECT * INTO source_event FROM private.automation_workflow_events WHERE event_type='invoice.payment_failed' AND subject_id=payment;
    PERFORM pg_temp.capture_check(source_event.source_key=payment::TEXT AND source_event.subject_kind='invoice'
        AND source_event.context=jsonb_build_object('payment_id',payment,'invoice_id',invoice,'payer_id',payer),'failed INSERT captures exact payment and same-studio parents');
    PERFORM pg_temp.capture_check((SELECT eligible AND failure_seen FROM private.workflow_payment_capture_markers WHERE payment_id=payment)
        AND (SELECT count(*)=1 FROM public.automation_workflow_runs WHERE event_id=source_event.id),'first payment failure marker and one target');
    UPDATE public.billing_payments SET status='failed' WHERE id=payment;
    UPDATE public.billing_payments SET status='processing' WHERE id=payment;
    UPDATE public.billing_payments SET status='failed' WHERE id=payment;
    PERFORM pg_temp.capture_check((SELECT count(*)=1 FROM private.automation_workflow_events WHERE subject_id=payment),'failed repeats and processing cycle never reenroll');
    INSERT INTO public.billing_payments(id,studio_id,payer_id,invoice_id,status,amount_cents) VALUES(later,s,payer,invoice,'processing',1000);
    PERFORM pg_temp.capture_check((SELECT eligible AND NOT failure_seen FROM private.workflow_payment_capture_markers WHERE payment_id=later),'new nonfailed payment eligible but unseen');
    UPDATE public.billing_payments SET status='failed' WHERE id=later;
    PERFORM pg_temp.capture_check((SELECT count(*)=1 FROM private.automation_workflow_events WHERE subject_id=later),'later first failure captured');
    INSERT INTO public.billing_payments(id,studio_id,status,amount_cents) VALUES(unlinked,s,'failed',1000);
    UPDATE public.billing_payments SET payer_id=payer,invoice_id=invoice WHERE id=unlinked;
    PERFORM pg_temp.capture_check((SELECT context=jsonb_build_object('payment_id',unlinked,'invoice_id',NULL,'payer_id',NULL)
        FROM private.automation_workflow_events WHERE subject_id=unlinked) AND (SELECT count(*)=1 FROM private.automation_workflow_events WHERE subject_id=unlinked),'later linking never retargets or repeats first failure');

    INSERT INTO public.billing_payers(id,studio_id,display_name,metadata) VALUES(demo_payer,s,'Demo payer','{"demo":true}');
    INSERT INTO public.billing_invoices(id,studio_id,payer_id,status,amount_due_cents,metadata) VALUES(demo_invoice,s,payer,'open',1000,'{"demo":true}');
    FOR n IN 1..4 LOOP
        demo_payment:=gen_random_uuid();
        INSERT INTO public.billing_payments(id,studio_id,payer_id,invoice_id,status,amount_cents,metadata)
            VALUES(demo_payment,s,CASE WHEN n=2 THEN demo_payer ELSE payer END,CASE WHEN n=3 THEN demo_invoice ELSE invoice END,
                CASE WHEN n=4 THEN 'processing' ELSE 'failed' END,1000,CASE WHEN n=1 THEN '{"demo":true}'::JSONB ELSE '{}'::JSONB END);
        IF n=4 THEN UPDATE public.billing_payments SET status='failed',metadata='{"demo":true}' WHERE id=demo_payment; END IF;
        UPDATE public.billing_payments SET metadata='{}',status='failed' WHERE id=demo_payment;
        PERFORM pg_temp.capture_check(NOT EXISTS(SELECT 1 FROM private.automation_workflow_events WHERE subject_id=demo_payment),
            'explicit payment invoice payer demo excluded '||n);
    END LOOP;
    INSERT INTO public.billing_payments(id,studio_id,status,amount_cents,metadata) VALUES(gen_random_uuid(),s,'failed',1000,'{"demo":null}') RETURNING id INTO demo_payment;
    PERFORM pg_temp.capture_check(EXISTS(SELECT 1 FROM private.automation_workflow_events WHERE subject_id=demo_payment),'null demo metadata preserves ordinary eligibility');

    FOREACH k IN ARRAY ARRAY['automation_workflow_events','automation_workflow_runs'] LOOP
        failed:=gen_random_uuid();
        PERFORM set_config('koaryu.capture_fail',k,true);
        PERFORM pg_temp.capture_error(format('SELECT public.write_student_profile_v2_atomic(%L,%L,%L,%L,ARRAY[%L::UUID],%L,true,%L)',failed,s,a,
            '{"legal_first_name":"Rollback","legal_last_name":"Student"}',program,'[]','student.created'),'P0001','CAPTURE_INJECTED_FAILURE','profile failure after '||k);
        PERFORM pg_temp.capture_check(NOT EXISTS(SELECT 1 FROM public.students WHERE id=failed)
            AND NOT EXISTS(SELECT 1 FROM private.automation_workflow_events WHERE subject_id=failed),'profile atomic rollback after '||k);
        PERFORM pg_temp.capture_error(format('INSERT INTO public.billing_payments(id,studio_id,status,amount_cents) VALUES(%L,%L,%L,10)',failed,s,'failed'),
            'P0001','CAPTURE_INJECTED_FAILURE','payment failure after '||k);
        PERFORM pg_temp.capture_check(NOT EXISTS(SELECT 1 FROM public.billing_payments WHERE id=failed)
            AND NOT EXISTS(SELECT 1 FROM private.workflow_payment_capture_markers WHERE payment_id=failed),'failed INSERT does not consume marker after '||k);
        PERFORM set_config('koaryu.capture_fail','',true);
        INSERT INTO public.billing_payments(id,studio_id,status,amount_cents) VALUES(failed,s,'processing',10);
        PERFORM set_config('koaryu.capture_fail',k,true);
        PERFORM pg_temp.capture_error(format('UPDATE public.billing_payments SET status=%L WHERE id=%L','failed',failed),
            'P0001','CAPTURE_INJECTED_FAILURE','payment UPDATE failure after '||k);
        PERFORM pg_temp.capture_check((SELECT status='processing' FROM public.billing_payments WHERE id=failed)
            AND (SELECT NOT failure_seen FROM private.workflow_payment_capture_markers WHERE payment_id=failed),'failed UPDATE does not consume first failure after '||k);
        PERFORM set_config('koaryu.capture_fail','',true);
        UPDATE public.billing_payments SET status='failed' WHERE id=failed;
        PERFORM pg_temp.capture_check((SELECT count(*)=1 FROM private.automation_workflow_events WHERE subject_id=failed),'failure retry captures after rollback '||k);
    END LOOP;
    RESET ROLE;
    -- No active targets still permanently consumes the first failure.
    s:=(y->>'studio')::UUID; a:=(y->>'owner')::UUID; failed:=gen_random_uuid();
    SET LOCAL ROLE service_role;
    INSERT INTO public.billing_payments(id,studio_id,status,amount_cents) VALUES(failed,s,'failed',10);
    PERFORM pg_temp.capture_check((SELECT failure_seen FROM private.workflow_payment_capture_markers WHERE payment_id=failed)
        AND EXISTS(SELECT 1 FROM private.automation_workflow_events WHERE subject_id=failed)
        AND NOT EXISTS(SELECT 1 FROM public.automation_workflow_runs WHERE studio_id=s),'first failure seen with zero active workflows');
    payment_workflow:=pg_temp.capture_workflow(s,a,'invoice.payment_failed');
    UPDATE public.billing_payments SET status='processing' WHERE id=failed;
    UPDATE public.billing_payments SET status='failed' WHERE id=failed;
    PERFORM pg_temp.capture_check(NOT EXISTS(SELECT 1 FROM public.automation_workflow_runs WHERE studio_id=s),'later activation never backfills payment');
    SELECT to_jsonb(m) INTO marker FROM private.workflow_payment_capture_markers m WHERE payment_id=failed;
    PERFORM public.clear_studio_operational_data_atomic(s,false);
    PERFORM pg_temp.capture_check((SELECT to_jsonb(m)=marker FROM private.workflow_payment_capture_markers m WHERE payment_id=failed)
        AND NOT EXISTS(SELECT 1 FROM public.billing_payments WHERE id=failed),'operational clear preserves seen payment identity');
    INSERT INTO public.billing_payments(id,studio_id,status,amount_cents) VALUES(failed,s,'failed',10);
    PERFORM pg_temp.capture_check((SELECT count(*)=1 FROM private.automation_workflow_events WHERE subject_id=failed)
        AND NOT EXISTS(SELECT 1 FROM public.automation_workflow_runs WHERE studio_id=s),'same payment identity after clear cannot replay');
    RESET ROLE;
END $$;
SELECT jsonb_build_object('checks',count(*),'labels',jsonb_agg(label ORDER BY label)) FROM capture_checks;
ROLLBACK;
