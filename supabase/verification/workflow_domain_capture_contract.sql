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
DECLARE x JSONB:=pg_temp.capture_fixture(); y JSONB:=pg_temp.capture_fixture(); s UUID:=(x->>'studio')::UUID; a UUID:=(x->>'actor')::UUID;
    owner UUID:=(x->>'owner')::UUID; program UUID:=(x->>'program')::UUID; op UUID:=gen_random_uuid(); result JSONB; original JSONB;
    req JSONB; before JSONB; l UUID; w UUID; packet JSONB; events JSONB; first_event private.automation_workflow_events;
    k TEXT; f REGPROCEDURE; cols TEXT[]; detail TEXT;
BEGIN
    PERFORM pg_temp.capture_check(NOT EXISTS(SELECT 1 FROM private.automation_workflow_events WHERE studio_id=s),'direct demo insert has no event');
    FOR f IN SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE
        (n.nspname='private' AND p.proname IN ('workflow_prepare_capture_v1','workflow_capture_events_v1'))
        OR (n.nspname='public' AND p.proname='create_lead_atomic_v1') LOOP
        PERFORM pg_temp.capture_check(has_function_privilege('service_role',f,'EXECUTE') AND NOT has_function_privilege('anon',f,'EXECUTE')
            AND NOT has_function_privilege('authenticated',f,'EXECUTE') AND (SELECT NOT prosecdef AND proconfig=ARRAY['search_path=""'] FROM pg_proc WHERE oid=f),'safe capture function '||f::TEXT);
    END LOOP;
    PERFORM pg_temp.capture_check((SELECT prosecdef AND proconfig=ARRAY['search_path=""'] AND pg_get_userbyid(proowner)='postgres'
        AND has_function_privilege('service_role',oid,'EXECUTE') AND NOT has_function_privilege('anon',oid,'EXECUTE')
        AND NOT has_function_privilege('authenticated',oid,'EXECUTE') FROM pg_proc
        WHERE oid='private.workflow_lock_lead_assignee_v1(uuid)'::REGPROCEDURE),'private Auth-only assignee helper privileges');
    req:=jsonb_build_object('first_name','  unchanged  ','last_name','','program_id',program,'assigned_staff_id',x->'assignee',
        'phone','not reformatted','notes','private note never enters event','guardian_email','synthetic@example.invalid');
    SET LOCAL ROLE service_role;
    original:=public.create_lead_atomic_v1(s,a,op,req); l:=(original#>>'{payload,id}')::UUID;
    SELECT array_agg(key ORDER BY key) INTO cols FROM jsonb_object_keys(original->'payload') key;
    PERFORM pg_temp.capture_check(cols=ARRAY['assigned_staff_id','converted_student_id','created_at','email','first_name','follow_up_date',
        'guardian_email','guardian_name','guardian_phone','id','is_minor','last_name','lost_reason','notes','phone','program_id','program_interest',
        'source','stage','studio_id','updated_at'],'full LeadResponse field parity with explicit nulls');
    PERFORM pg_temp.capture_check(original#>>'{payload,first_name}'='  unchanged  ' AND original#>>'{payload,last_name}'=''
        AND original#>>'{payload,phone}'='not reformatted' AND original#>>'{payload,source}'='walk_in'
        AND original#>>'{payload,stage}'='inquiry' AND original#>'{payload,is_minor}'='false'
        AND original#>'{payload,converted_student_id}'='null' AND original#>'{payload,lost_reason}'='null','retained strings and defaults');
    SELECT * INTO first_event FROM private.automation_workflow_events WHERE studio_id=s;
    PERFORM pg_temp.capture_check(first_event.event_type='lead.created' AND first_event.source_key=l::TEXT AND first_event.subject_id=l
        AND first_event.context=jsonb_build_object('lead_id',l,'program_id',program,'stage','inquiry')
        AND NOT EXISTS(SELECT 1 FROM public.automation_workflow_runs WHERE studio_id=s),'seen occurrence without active targets has bounded context');
    PERFORM pg_temp.capture_check((SELECT command='lead.create' AND entity_type='lead' AND entity_id=l FROM private.automation_command_operations
        WHERE studio_id=s AND operation_id=op),'lead receipt command and entity tags');
    PERFORM pg_temp.capture_check(public.get_automation_operation_v1(s,a,op)#>'{payload,result}'=original->'payload','front desk own receipt readback');
    PERFORM pg_temp.capture_check(public.create_lead_atomic_v1(s,a,op,req||'{"source":"walk_in","stage":"inquiry","is_minor":false}')=original||'{"replayed":true}','same key normalized original result');
    PERFORM pg_temp.capture_error(format('SELECT public.create_lead_atomic_v1(%L,%L,%L,%L)',s,a,op,req||'{"notes":"changed"}'),
        'P0001','AUTOMATION_OPERATION_CONFLICT','same key changed request conflict');
    PERFORM pg_temp.capture_error(format('SELECT public.create_lead_atomic_v1(%L,%L,%L,%L)',s,owner,op,req),
        'P0001','AUTOMATION_OPERATION_CONFLICT','same key changed authorized actor conflict');
    RESET ROLE;
    UPDATE public.programs SET archived_at=clock_timestamp() WHERE id=program;
    UPDATE public.staff_roles SET archived_at=clock_timestamp() WHERE user_id=(x->>'assignee')::UUID;
    UPDATE public.leads SET notes='later private edit' WHERE id=l;
    SET LOCAL ROLE service_role;
    PERFORM pg_temp.capture_check(public.create_lead_atomic_v1(s,a,op,req)=original||'{"replayed":true}','authorized replay ignores current program assignee and lead edits');
    RESET ROLE;
    UPDATE public.staff_roles SET archived_at=NULL WHERE user_id=(x->>'assignee')::UUID;
    SET LOCAL ROLE service_role;
    BEGIN PERFORM public.create_lead_atomic_v1(s,a,gen_random_uuid(),req);
    EXCEPTION WHEN SQLSTATE 'P0001' THEN
        GET STACKED DIAGNOSTICS detail=PG_EXCEPTION_DETAIL;
        IF SQLERRM<>'PROGRAM_INACTIVE' THEN RAISE; END IF;
    END;
    PERFORM pg_temp.capture_check(detail=program::TEXT,'PROGRAM_INACTIVE preserves exact requested program detail');
    RESET ROLE;
    UPDATE public.programs SET archived_at=NULL WHERE id=program;
    UPDATE public.staff_roles SET role='instructor' WHERE user_id=a;
    SET LOCAL ROLE service_role;
    PERFORM pg_temp.capture_error(format('SELECT public.create_lead_atomic_v1(%L,%L,%L,%L)',s,a,op,req),
        '42501','AUTOMATION_ADMIN_REQUIRED','current role required before historical receipt');
    RESET ROLE;
    UPDATE public.staff_roles SET role='front_desk' WHERE user_id=a;
    SET LOCAL ROLE service_role;
    w:=pg_temp.capture_workflow(s,owner,'lead.created',program);
    -- Old seen occurrence cannot enroll when a matching workflow appears later.
    packet:=private.workflow_prepare_capture_v1(s);
    events:=jsonb_build_array(jsonb_build_object('event_type',first_event.event_type,'source_key',first_event.source_key,
        'subject_kind',first_event.subject_kind,'subject_id',first_event.subject_id,'occurred_at',private.automation_utc_text_v1(first_event.occurred_at),'context',first_event.context));
    PERFORM private.workflow_capture_events_v1(s,events,packet);
    PERFORM pg_temp.capture_check(NOT EXISTS(SELECT 1 FROM public.automation_workflow_runs WHERE studio_id=s),'seen occurrence never backfills after start');
    FOREACH k IN ARRAY ARRAY['lead_activities','audit_logs','automation_workflow_events','automation_workflow_runs','automation_command_operations'] LOOP
        before:=pg_temp.capture_facts(s);
        PERFORM set_config('koaryu.capture_fail',k,true);
        PERFORM pg_temp.capture_error(format('SELECT public.create_lead_atomic_v1(%L,%L,%L,%L)',s,a,gen_random_uuid(),req),
            'P0001','CAPTURE_INJECTED_FAILURE','failure injected after '||k);
        PERFORM pg_temp.capture_check(pg_temp.capture_facts(s)=before,'all source and capture facts roll back after '||k);
    END LOOP;
    PERFORM set_config('koaryu.capture_fail','',true);
    result:=public.create_lead_atomic_v1(s,a,gen_random_uuid(),req);
    PERFORM pg_temp.capture_check((SELECT count(*)=1 FROM public.automation_workflow_runs WHERE studio_id=s AND workflow_id=w)
        AND (SELECT r.version_id=w.published_version_id AND r.current_node_id='trigger' AND r.state='queued'
            FROM public.automation_workflow_runs r JOIN public.automation_workflows w ON w.id=r.workflow_id WHERE r.studio_id=s),'exact matching active published target queued');
    before:=pg_temp.capture_facts(s);
    FOREACH events IN ARRAY ARRAY['[]'::JSONB,'[{}]'::JSONB,jsonb_build_array(to_jsonb(first_event))] LOOP
        PERFORM pg_temp.capture_error(format('SELECT private.workflow_capture_events_v1(%L,%L,%L)',s,events,packet),
            '22023','AUTOMATION_INVALID_REQUEST','malformed event rejected '||md5(events::TEXT));
    END LOOP;
    PERFORM pg_temp.capture_error(format('SELECT private.workflow_capture_events_v1(%L,%L,%L)',s,
        jsonb_build_array(jsonb_build_object('event_type',first_event.event_type,'source_key',first_event.source_key,'subject_kind',first_event.subject_kind,
            'subject_id',first_event.subject_id,'occurred_at',private.automation_utc_text_v1(first_event.occurred_at),
            'context',first_event.context||'{"notes":"forbidden"}')),packet),'22023','AUTOMATION_INVALID_REQUEST','raw source content rejected');
    PERFORM pg_temp.capture_error(format('SELECT private.workflow_capture_events_v1(%L,%L,%L)',s,'[{}]',packet||'{"transaction_id":"0"}'),
        '22023','AUTOMATION_INVALID_REQUEST','other transaction packet rejected');
    PERFORM pg_temp.capture_error(format('SELECT private.workflow_prepare_capture_v1(%L,ARRAY[%L]::UUID[],true)',s,gen_random_uuid()),
        '22023','AUTOMATION_INVALID_REQUEST','foreign or missing invalidation target rejected');
    PERFORM pg_temp.capture_error(format('SELECT private.workflow_capture_events_v1(%L,%L,%L)',s,'[{}]',
        jsonb_set(packet,'{targets,0,epoch}','9223372036854775808')),'22023','AUTOMATION_INVALID_REQUEST','out of range target epoch rejected');
    PERFORM pg_temp.capture_error(format('SELECT private.workflow_capture_events_v1(%L,%L,%L)',s,
        jsonb_build_array(jsonb_build_object('event_type','trial.scheduled','source_key',l::TEXT||':overflow','subject_kind','trial','subject_id',l,
            'occurred_at',private.automation_utc_text_v1(clock_timestamp()),'context',jsonb_build_object('appointment_id',l,'lead_id',l,
                'program_id',NULL,'revision',9223372036854775808::NUMERIC,'status','scheduled'))),packet),
        '22023','AUTOMATION_INVALID_REQUEST','out of range owner revision rejected');
    PERFORM pg_temp.capture_error(format('SELECT private.workflow_capture_events_v1(%L,%L,%L)',s,
        jsonb_build_array(jsonb_build_object('event_type','invoice.payment_failed','source_key',l::TEXT,'subject_kind','invoice','subject_id',l,
            'occurred_at',private.automation_utc_text_v1(clock_timestamp()),'context',jsonb_build_object('payment_id',gen_random_uuid(),
                'invoice_id',NULL,'payer_id',NULL))),packet),'22023','AUTOMATION_INVALID_REQUEST','payment occurrence identity mismatch rejected');
    PERFORM pg_temp.capture_check(pg_temp.capture_facts(s)=before,'invalid private captures leave every fact unchanged');
    -- Stage changes are owned by activity identity; notes and identical stage are silent.
    PERFORM public.update_lead_atomic(s,a,l,'{"stage":"offer_sent"}');
    PERFORM public.update_lead_atomic(s,a,l,'{"stage":"offer_sent","notes":"private"}');
    PERFORM public.follow_up_lead_atomic(s,a,l,op,'{"next_stage":"trial_completed"}');
    PERFORM public.follow_up_lead_atomic(s,a,l,op,'{"next_stage":"trial_completed"}');
    PERFORM public.update_lead_atomic(s,a,l,'{"stage":"offer_sent"}');
    PERFORM pg_temp.capture_check((SELECT count(*)=3 FROM private.automation_workflow_events WHERE studio_id=s AND event_type='lead.stage_changed')
        AND NOT EXISTS(SELECT 1 FROM private.automation_workflow_events e WHERE e.studio_id=s AND e.event_type='lead.stage_changed'
            AND NOT EXISTS(SELECT 1 FROM public.lead_activities activity WHERE activity.id::TEXT=e.source_key
                AND activity.id=(e.context->>'activity_id')::UUID AND activity.lead_id=e.subject_id AND activity.activity_type='stage_change')),
        'three actual stage transitions use three owned activity identities with no nested duplicate');
END $$;
RESET ROLE;
DO $$
DECLARE x JSONB:=pg_temp.capture_fixture(); s UUID:=(x->>'studio')::UUID; actor UUID:=(x->>'owner')::UUID;
    ladder UUID:=gen_random_uuid(); r0 UUID:=gen_random_uuid(); r1 UUID:=gen_random_uuid(); student UUID:=gen_random_uuid();
    event UUID:=gen_random_uuid(); program2 UUID:=gen_random_uuid(); recipient UUID; op UUID:=gen_random_uuid(); w UUID;
    first JSONB; second JSONB; original_event JSONB; result JSONB; request JSONB;
BEGIN
    INSERT INTO public.programs(id,studio_id,name) VALUES(program2,s,'Second program');
    INSERT INTO public.belt_ladders(id,studio_id,name) VALUES(ladder,s,'Unscoped event');
    INSERT INTO public.belt_ranks(id,studio_id,ladder_id,name,display_order,min_classes,min_months) VALUES(r0,s,ladder,'First',0,0,0),(r1,s,ladder,'Next',1,0,0);
    INSERT INTO public.students(id,studio_id,legal_first_name,legal_last_name,status,program_id,membership_start_date)
        VALUES(student,s,'Synthetic','Approved','active',(x->>'program')::UUID,CURRENT_DATE-120);
    INSERT INTO public.belt_test_events(id,studio_id,name,ladder_id,starts_at,ends_at,timezone,status)
        VALUES(event,s,'Test',ladder,clock_timestamp()+INTERVAL '7 days',clock_timestamp()+INTERVAL '7 days 1 hour','UTC','scheduled');
    request:=jsonb_build_array(jsonb_build_object('student_id',student));
    SET LOCAL ROLE service_role;
    first:=public.approve_belt_test_recipients_v1(s,actor,event,op,1,request); recipient:=(first#>>'{payload,items,0,id}')::UUID;
    SELECT to_jsonb(e) INTO original_event FROM private.automation_workflow_events e WHERE e.studio_id=s;
    PERFORM pg_temp.capture_check(original_event->'context'=jsonb_build_object('event_id',event,'student_id',student,
        'student_program_membership_id',NULL,'approved_program_id',x->'program','approved_current_rank_id',NULL,
        'approved_target_rank_id',r0,'approved_schedule_revision',1,'approval_revision',1,'approved_rank_context_generation',1),'zero-target approval stores full original private snapshot');
    PERFORM pg_temp.capture_check((original_event#>>'{context,approved_rank_context_generation}')::BIGINT=1,'first approval captures observed baseline generation');
    PERFORM public.approve_belt_test_recipients_v1(s,actor,event,gen_random_uuid(),1,request);
    PERFORM pg_temp.capture_check((SELECT count(*)=1 FROM private.automation_workflow_events WHERE studio_id=s),'current identical new-key approval emits nothing');
    RESET ROLE;
    UPDATE public.students SET current_belt_rank_id=r0,program_id=program2 WHERE id=student;
    SET LOCAL ROLE service_role;
    PERFORM public.mutate_belt_test_event_v1(s,actor,event,gen_random_uuid(),1,jsonb_build_object('starts_at',private.automation_utc_text_v1(clock_timestamp()+INTERVAL '8 days'),
        'ends_at',private.automation_utc_text_v1(clock_timestamp()+INTERVAL '8 days 1 hour')));
    w:=pg_temp.capture_workflow(s,actor,'belt_test.approved',program2);
    second:=public.approve_belt_test_recipients_v1(s,actor,event,gen_random_uuid(),2,request);
    PERFORM pg_temp.capture_check((SELECT context=jsonb_build_object('event_id',event,'student_id',student,'student_program_membership_id',NULL,
        'approved_program_id',program2,'approved_current_rank_id',r0,'approved_target_rank_id',r1,
        'approved_schedule_revision',2,'approval_revision',(second#>>'{payload,items,0,revision}')::BIGINT,
        'approved_rank_context_generation',private.workflow_rank_context_generation_v1(s,student,NULL))
        FROM private.automation_workflow_events WHERE studio_id=s AND source_key=recipient::TEXT||':'||(second#>>'{payload,items,0,revision}')||':2'),
        'reapproval preserves new program rank and schedule in its new occurrence');
    PERFORM pg_temp.capture_check((SELECT to_jsonb(e)=original_event FROM private.automation_workflow_events e WHERE e.id=(original_event->>'id')::UUID)
        AND public.approve_belt_test_recipients_v1(s,actor,event,op,1,request)=first||'{"replayed":true}',
        'later rank program and schedule never rewrite prior event or receipt');
    PERFORM pg_temp.capture_check((SELECT count(*)=1 FROM public.automation_workflow_runs WHERE studio_id=s AND workflow_id=w)
        AND (SELECT e.context->>'approved_program_id'=program2::TEXT AND e.context->>'approved_schedule_revision'='2'
            FROM public.automation_workflow_runs r JOIN private.automation_workflow_events e ON e.id=r.event_id WHERE r.studio_id=s),
        'unscoped event targets only exact recipient approved program and never historical approval');
    PERFORM public.approve_belt_test_recipients_v1(s,actor,event,gen_random_uuid(),2,request);
    PERFORM pg_temp.capture_check((SELECT count(*)=2 FROM private.automation_workflow_events WHERE studio_id=s)
        AND (SELECT count(*)=1 FROM public.automation_workflow_runs WHERE studio_id=s),'current reapproval remains silent after active workflow');
END $$;
RESET ROLE;
DO $$
DECLARE x JSONB:=pg_temp.capture_fixture(); s UUID:=(x->>'studio')::UUID; actor UUID:=(x->>'actor')::UUID;
    op UUID:=gen_random_uuid(); ambiguous_op UUID:=gen_random_uuid(); dmy_op UUID:=gen_random_uuid();
    request JSONB; first JSONB; original JSONB; before JSONB; raw_date TEXT; retained_date TEXT;
BEGIN
    SET LOCAL ROLE service_role;
    SET LOCAL TIME ZONE 'Pacific/Kiritimati';
    request:='{"first_name":"Relative","last_name":"Date","follow_up_date":"today"}';
    first:=public.create_lead_atomic_v1(s,actor,op,request);
    PERFORM pg_temp.capture_check(first#>>'{payload,follow_up_date}'=CURRENT_DATE::TEXT,'fresh relative date retains database DATE semantics');
    SET LOCAL TIME ZONE 'Pacific/Honolulu';
    before:=pg_temp.capture_facts(s);
    PERFORM pg_temp.capture_check((first#>>'{payload,follow_up_date}')::DATE<>CURRENT_DATE
        AND public.create_lead_atomic_v1(s,actor,op,request)=first||'{"replayed":true}',
        'relative date original receipt survives timezone and local-day change');
    PERFORM pg_temp.capture_check(pg_temp.capture_facts(s)=before,'relative date replay writes no source receipt or event');
    SET LOCAL DateStyle TO 'ISO, MDY';
    request:='{"first_name":"Ambiguous","last_name":"Date","follow_up_date":"03/04/2030"}';
    original:=public.create_lead_atomic_v1(s,actor,ambiguous_op,request);
    PERFORM pg_temp.capture_check(original#>>'{payload,follow_up_date}'='2030-03-04','fresh ambiguous date honors original MDY setting');
    SET LOCAL DateStyle TO 'ISO, DMY';
    before:=pg_temp.capture_facts(s);
    PERFORM pg_temp.capture_check('03/04/2030'::DATE=DATE '2030-04-03'
        AND public.create_lead_atomic_v1(s,actor,ambiguous_op,request)=original||'{"replayed":true}',
        'ambiguous date original receipt survives DateStyle change');
    PERFORM pg_temp.capture_error(format('SELECT public.create_lead_atomic_v1(%L,%L,%L,%L)',s,actor,ambiguous_op,
        request||'{"follow_up_date":"2030-03-04"}'),'P0001','AUTOMATION_OPERATION_CONFLICT','changed raw date conflicts even when equivalent to original stored date');
    PERFORM pg_temp.capture_check(pg_temp.capture_facts(s)=before,'DateStyle replay and changed-raw conflict leave every fact unchanged');
    request:='{"first_name":"DMY only","last_name":"Date","follow_up_date":"31/12/2030"}';
    original:=public.create_lead_atomic_v1(s,actor,dmy_op,request);
    SET LOCAL DateStyle TO 'ISO, MDY';
    PERFORM pg_temp.capture_check(public.create_lead_atomic_v1(s,actor,dmy_op,request)=original||'{"replayed":true}',
        'matching date receipt bypasses syntax invalid under current DateStyle');
    FOREACH raw_date IN ARRAY ARRAY['infinity','-infinity'] LOOP
        -- The retained direct insert accepts PostgreSQL's nonfinite DATE values.
        -- The atomic owner must preserve that pre-existing input behavior.
        INSERT INTO public.leads(studio_id,first_name,last_name,follow_up_date)
            VALUES(s,'Retained direct','Date',raw_date::DATE) RETURNING follow_up_date::TEXT INTO retained_date;
        request:=jsonb_build_object('first_name','Atomic','last_name','Date','follow_up_date',raw_date);
        first:=public.create_lead_atomic_v1(s,actor,gen_random_uuid(),request);
        PERFORM pg_temp.capture_check(retained_date=raw_date AND first#>>'{payload,follow_up_date}'=retained_date,
            'atomic owner preserves retained DATE value '||raw_date);
    END LOOP;
    FOREACH raw_date IN ARRAY ARRAY['not-a-date','2026-02-30','999999999-01-01'] LOOP
        before:=pg_temp.capture_facts(s);
        request:=jsonb_build_object('first_name','Malformed','last_name','Date','follow_up_date',raw_date);
        PERFORM pg_temp.capture_error(format('SELECT public.create_lead_atomic_v1(%L,%L,%L,%L)',s,actor,gen_random_uuid(),request),
            '22023','AUTOMATION_INVALID_REQUEST','malformed fresh date rejected '||raw_date);
        PERFORM pg_temp.capture_check(pg_temp.capture_facts(s)=before,'malformed fresh date leaves every fact unchanged '||raw_date);
    END LOOP;
    SET LOCAL TIME ZONE 'UTC';
END $$;
SELECT jsonb_build_object('contract','workflow_domain_capture','checks',count(*),'result','passed') FROM capture_checks;
ROLLBACK;
