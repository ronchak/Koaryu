-- Atomic operational clear, retained definitions/receipts and cached-call fence.
-- Synthetic fixture writes roll back. No hosted target or email is used.
BEGIN;
SET LOCAL statement_timeout='90s';
SET LOCAL TIME ZONE 'UTC';
CREATE FUNCTION pg_temp.clear_check(ok BOOLEAN,label TEXT) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'clear contract: %',label; END IF; END $$;
CREATE FUNCTION pg_temp.clear_error(statement TEXT,code TEXT,message TEXT) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE actual_code TEXT; actual_message TEXT;
BEGIN
    BEGIN EXECUTE statement; EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS actual_code=RETURNED_SQLSTATE,actual_message=MESSAGE_TEXT; END;
    PERFORM pg_temp.clear_check(actual_code=code AND actual_message=message,'exact error '||message);
END $$;
-- fixture owners start.
CREATE FUNCTION pg_temp.clear_fixture(active BOOLEAN DEFAULT true) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE a UUID:=gen_random_uuid(); s UUID:=gen_random_uuid(); p UUID:=gen_random_uuid(); w UUID; graph JSONB;
BEGIN
    INSERT INTO auth.users(id,email,email_confirmed_at) VALUES(a,a||'@example.invalid',clock_timestamp());
    INSERT INTO public.studios(id,name,slug,owner_id,timezone) VALUES(s,'Clear fixture',s::TEXT,a,'UTC');
    INSERT INTO public.staff_roles(studio_id,user_id,role) VALUES(s,a,'admin');
    INSERT INTO public.studio_subscriptions(studio_id,status,comped) VALUES(s,'active',false);
    INSERT INTO public.programs(id,studio_id,name) VALUES(p,s,'Clear program');
    graph:='{"schema_version":1,"nodes":[{"id":"trigger","type":"trigger","config":{"event_type":"lead.created","program_id":null}},{"id":"end","type":"end","config":{}}],"edges":[{"id":"next","source":"trigger","target":"end","port":"next"}]}';
    w:=(public.create_automation_workflow_v1(s,a,gen_random_uuid(),'Clear workflow','',graph,'{}')#>>'{payload,id}')::UUID;
    IF active THEN
        PERFORM public.command_automation_workflow_v1(s,a,w,gen_random_uuid(),1,'publish');
        PERFORM public.command_automation_workflow_v1(s,a,w,gen_random_uuid(),2,'start');
    END IF;
    RETURN jsonb_build_object('studio',s,'actor',a,'program',p,'workflow',w,'graph',graph);
END $$;
-- fixture owners end.
DO $$
DECLARE fn REGPROCEDURE; info RECORD;
BEGIN
    FOREACH fn IN ARRAY ARRAY['public.clear_studio_operational_data_v2(uuid,boolean)'::REGPROCEDURE,
        'public.clear_studio_operational_data_atomic(uuid,boolean)'::REGPROCEDURE,
        'private.clear_studio_operational_data_v2(uuid,boolean)'::REGPROCEDURE] LOOP
        SELECT * INTO info FROM pg_proc WHERE oid=fn;
        PERFORM pg_temp.clear_check(NOT info.prosecdef AND info.pronargdefaults=1
            AND has_function_privilege('service_role',fn,'EXECUTE')
            AND NOT has_function_privilege('anon',fn,'EXECUTE')
            AND NOT has_function_privilege('authenticated',fn,'EXECUTE'),'service-only invoker/default '||fn);
    END LOOP;
    PERFORM pg_temp.clear_check((SELECT prorettype='void'::REGTYPE FROM pg_proc
        WHERE oid='public.clear_studio_operational_data_atomic(uuid,boolean)'::REGPROCEDURE),'old VOID result');
    PERFORM pg_temp.clear_check((SELECT tgtype=10 AND NOT tgisinternal FROM pg_trigger
        WHERE tgrelid='public.billing_disputes'::REGCLASS AND tgname='automation_clear_current_owner'),'unconditional BEFORE DELETE statement fence');
    PERFORM pg_temp.clear_error('SELECT public.clear_studio_operational_data_v2(NULL)','22023','Studio operational clear requires a studio id.');
    PERFORM pg_temp.clear_error(format('SELECT public.clear_studio_operational_data_v2(%L)',gen_random_uuid()),'P0001','Studio not found for operational clear.');
END $$;
SAVEPOINT physical;
DO $$
DECLARE x JSONB:=pg_temp.clear_fixture(); s UUID:=(x->>'studio')::UUID; a UUID:=(x->>'actor')::UUID; w UUID:=(x->>'workflow')::UUID;
    draft UUID; paused UUID; archived UUID; op UUID:=gen_random_uuid(); lead JSONB; request JSONB; result JSONB; previous JSONB;
    trial UUID:=gen_random_uuid(); belt UUID:=gen_random_uuid(); student UUID:=gen_random_uuid(); recipient UUID:=gen_random_uuid(); state TEXT; event UUID; activation public.automation_workflow_activations;
BEGIN
    draft:=(public.create_automation_workflow_v1(s,a,gen_random_uuid(),'Draft','',x->'graph','{}')#>>'{payload,id}')::UUID;
    paused:=(public.create_automation_workflow_v1(s,a,gen_random_uuid(),'Paused','',x->'graph','{}')#>>'{payload,id}')::UUID;
    PERFORM public.command_automation_workflow_v1(s,a,paused,gen_random_uuid(),1,'publish');
    archived:=(public.create_automation_workflow_v1(s,a,gen_random_uuid(),'Archived','',x->'graph','{}')#>>'{payload,id}')::UUID;
    PERFORM public.command_automation_workflow_v1(s,a,archived,gen_random_uuid(),1,'archive');
    request:=jsonb_build_object('first_name','Retained','last_name','Receipt','source','referral','email','receipt@example.invalid','notes','Original saved details','program_id',x->'program');
    lead:=public.create_lead_atomic_v1(s,a,op,request);
    INSERT INTO public.lead_trial_appointments(id,studio_id,lead_id,starts_at,ends_at,timezone)
        VALUES(trial,s,(lead#>>'{payload,id}')::UUID,clock_timestamp()+INTERVAL '1 day',clock_timestamp()+INTERVAL '1 day 1 hour','UTC');
    INSERT INTO public.students(id,studio_id,legal_first_name,legal_last_name) VALUES(student,s,'Clear','Student');
    INSERT INTO public.belt_test_events(id,studio_id,name,ladder_id,starts_at,ends_at,timezone,status)
        VALUES(belt,s,'Scheduled event',gen_random_uuid(),clock_timestamp()+INTERVAL '1 day',clock_timestamp()+INTERVAL '1 day 1 hour','UTC','scheduled');
    INSERT INTO public.belt_test_recipients(id,studio_id,event_id,student_id,approved_schedule_revision,approved_rank_context_generation,approved_target_rank_id,state,approved_at)
        VALUES(recipient,s,belt,student,1,1,gen_random_uuid(),'approved',clock_timestamp());
    INSERT INTO public.automation_rules(studio_id,enabled,inactivity_days,subject_template,body_template,reply_to_email,revision)
        VALUES(s,true,14,'Retained subject','Retained body','reply@example.invalid',7);
    INSERT INTO public.automation_deliveries(studio_id,student_id,attendance_id,attendance_date,attendance_checked_in_at,attendance_occurred_at,
        student_name,student_first_name,studio_name,recipient_email,recipient_name,recipient_kind,subject_template,body_template,reply_to_email,rule_revision,days_absent)
        VALUES(s,student,gen_random_uuid(),CURRENT_DATE,clock_timestamp(),clock_timestamp(),'Clear Student','Clear','Clear fixture','clear@example.invalid','Clear','student','Subject','Body','reply@example.invalid',7,20);
    SELECT * INTO activation FROM public.automation_workflow_activations WHERE workflow_id=w AND retired_at IS NULL;
    -- The real lead command already created one queued run. These rows isolate
    -- cancellation vocabulary; actual sender attempts are proved by the runner.
    FOREACH state IN ARRAY ARRAY['waiting','claimed','running','sending','unknown','completed'] LOOP
        INSERT INTO private.automation_workflow_events(studio_id,event_type,source_key,subject_kind,subject_id,occurred_at)
            VALUES(s,'lead.created','clear-fixture:'||gen_random_uuid(),'lead',gen_random_uuid(),clock_timestamp()) RETURNING id INTO event;
        INSERT INTO public.automation_workflow_runs(studio_id,workflow_id,version_id,event_id,activation_id,epoch,current_node_id,state,next_due_at,claim_token,lease_expires_at)
            VALUES(s,w,activation.version_id,event,activation.id,activation.epoch,'trigger',state,
                CASE WHEN state IN ('waiting','claimed','running') THEN clock_timestamp() END,
                CASE WHEN state IN ('claimed','running','sending') THEN gen_random_uuid() END,
                CASE WHEN state IN ('claimed','running','sending') THEN clock_timestamp()+INTERVAL '1 minute' END);
    END LOOP;
    SELECT jsonb_agg(to_jsonb(r) ORDER BY operation_id) INTO previous FROM private.automation_command_operations r WHERE studio_id=s;
    PERFORM set_config('koaryu.automation_clear_owner','previous-value',true);
    SET LOCAL ROLE service_role;
    result:=public.clear_studio_operational_data_v2(s)->'payload';
    RESET ROLE;
    PERFORM pg_temp.clear_check(result=jsonb_build_object('workflows_paused',1,'workflow_runs_cancelled',4,'workflow_cancellation_intents_added',6,
        'attendance_rule_paused',true,'attendance_deliveries_cancelled',1,'belt_test_events_deleted',1,'belt_test_recipients_deleted',1,
        'sending_attempts_preserved',0,'unknown_attempts_preserved',0),'exact nine owned effects');
    PERFORM pg_temp.clear_check(current_setting('koaryu.automation_clear_owner')='previous-value','prior marker restored');
    PERFORM pg_temp.clear_check((SELECT jsonb_agg(to_jsonb(r) ORDER BY operation_id)=previous FROM private.automation_command_operations r WHERE studio_id=s),'full immutable receipts unchanged');
    PERFORM pg_temp.clear_check(public.create_lead_atomic_v1(s,a,op,request)=lead||'{"replayed":true}'::JSONB
        AND NOT EXISTS(SELECT 1 FROM public.leads WHERE studio_id=s),'matching old lead operation never recreates');
    PERFORM pg_temp.clear_check(public.get_automation_operation_v1(s,a,op)#>'{payload,result}'=lead->'payload','receipt retains original details');
    PERFORM pg_temp.clear_error(format('SELECT public.get_lead_trial_appointment_v1(%L,%L,%L,%L)',s,a,lead#>>'{payload,id}',trial),'P0002','AUTOMATION_NOT_FOUND');
    PERFORM pg_temp.clear_check((SELECT count(*)=4 FROM public.automation_workflows WHERE studio_id=s)
        AND (SELECT status='draft' AND revision=1 FROM public.automation_workflows WHERE id=draft)
        AND (SELECT status='paused' AND revision=2 FROM public.automation_workflows WHERE id=paused)
        AND (SELECT status='archived' AND revision=2 FROM public.automation_workflows WHERE id=archived)
        AND (SELECT status='paused' AND revision=4 FROM public.automation_workflows WHERE id=w),'saved statuses/revisions retained');
    PERFORM pg_temp.clear_check((SELECT NOT enabled AND revision=8 AND subject_template='Retained subject' FROM public.automation_rules WHERE studio_id=s),'rule paused once and configuration retained');
    PERFORM pg_temp.clear_check(NOT EXISTS(SELECT 1 FROM public.students WHERE studio_id=s)
        AND NOT EXISTS(SELECT 1 FROM public.programs WHERE studio_id=s)
        AND NOT EXISTS(SELECT 1 FROM public.lead_trial_appointments WHERE studio_id=s)
        AND NOT EXISTS(SELECT 1 FROM public.belt_test_events WHERE studio_id=s)
        AND NOT EXISTS(SELECT 1 FROM public.belt_test_recipients WHERE studio_id=s)
        AND NOT EXISTS(SELECT 1 FROM public.automation_deliveries WHERE studio_id=s),'all operational parents removed');
    PERFORM pg_temp.clear_check(EXISTS(SELECT 1 FROM public.studio_subscriptions WHERE studio_id=s)
        AND (SELECT count(*)=7 FROM private.automation_workflow_events WHERE studio_id=s),'platform false and seen events retained');
    result:=public.clear_studio_operational_data_v2(s)->'payload';
    PERFORM pg_temp.clear_check(result=jsonb_build_object('workflows_paused',0,'workflow_runs_cancelled',0,'workflow_cancellation_intents_added',0,
        'attendance_rule_paused',false,'attendance_deliveries_cancelled',0,'belt_test_events_deleted',0,'belt_test_recipients_deleted',0,
        'sending_attempts_preserved',0,'unknown_attempts_preserved',0),'already paused empty studio exact zero effects');
    PERFORM public.clear_studio_operational_data_atomic(s,true);
    PERFORM pg_temp.clear_check(NOT EXISTS(SELECT 1 FROM public.studio_subscriptions WHERE studio_id=s),'VOID wrapper platform true');
    -- A finished new owner cannot lend its restored marker to a cached old body.
    PERFORM pg_temp.clear_error('DELETE FROM public.billing_disputes WHERE false','P0001','AUTOMATION_STUDIO_BUSY');
END $$;
SELECT 'physical clear, exact effects, retention, replay and marker restoration passed';
ROLLBACK TO physical;
SAVEPOINT keys;
DO $$
DECLARE x JSONB; s UUID; sign INTEGER; key BIGINT; decoded BIGINT; other UUID; marker JSONB;
BEGIN
    FOREACH sign IN ARRAY ARRAY[-1,1] LOOP
        LOOP
            x:=pg_temp.clear_fixture(false); s:=(x->>'studio')::UUID;
            key:=hashtextextended('koaryu.local-plan-clear:'||s,0);
            EXIT WHEN CASE WHEN sign=-1 THEN key<0 ELSE key>=0 END;
        END LOOP;
        BEGIN
            PERFORM pg_advisory_xact_lock(key);
            SELECT (classid::BIGINT<<32)|objid::BIGINT INTO decoded FROM pg_locks
                WHERE locktype='advisory' AND pid=pg_backend_pid() AND mode='ExclusiveLock' AND granted AND objsubid=1
                    AND database=(SELECT oid FROM pg_database WHERE datname=current_database())
                    AND ((classid::BIGINT<<32)|objid::BIGINT)=key;
            PERFORM pg_temp.clear_check(decoded=key,'signed64 key decoding');
            PERFORM pg_temp.clear_error('DELETE FROM public.billing_disputes WHERE false','P0001','AUTOMATION_STUDIO_BUSY');
            PERFORM set_config('koaryu.automation_clear_owner','invalid-json',true);
            PERFORM pg_temp.clear_error('DELETE FROM public.billing_disputes WHERE false','P0001','AUTOMATION_STUDIO_BUSY');
            marker:=jsonb_build_object('studio_id',s,'backend_pid',pg_backend_pid(),'transaction_id',pg_current_xact_id()::TEXT);
            PERFORM set_config('koaryu.automation_clear_owner',(marker||'{"backend_pid":0}')::TEXT,true);
            PERFORM pg_temp.clear_error('DELETE FROM public.billing_disputes WHERE false','P0001','AUTOMATION_STUDIO_BUSY');
            PERFORM set_config('koaryu.automation_clear_owner',(marker||'{"transaction_id":"0"}')::TEXT,true);
            PERFORM pg_temp.clear_error('DELETE FROM public.billing_disputes WHERE false','P0001','AUTOMATION_STUDIO_BUSY');
            PERFORM set_config('koaryu.automation_clear_owner',marker::TEXT,true);
            DELETE FROM public.billing_disputes WHERE false;
            other:=(pg_temp.clear_fixture(false)->>'studio')::UUID;
            PERFORM pg_advisory_xact_lock(hashtextextended('koaryu.local-plan-clear:'||other,0));
            PERFORM pg_temp.clear_error('DELETE FROM public.billing_disputes WHERE false','P0001','AUTOMATION_STUDIO_BUSY');
            RAISE EXCEPTION USING ERRCODE='PCL01',MESSAGE='release test locks';
        EXCEPTION WHEN SQLSTATE 'PCL01' THEN NULL; END;
    END LOOP;
    DELETE FROM public.billing_disputes WHERE false;
    PERFORM pg_advisory_xact_lock(111);
    DELETE FROM public.billing_disputes WHERE false;
    PERFORM pg_advisory_xact_lock(22,33);
    DELETE FROM public.billing_disputes WHERE false;
END $$;
SELECT 'both signed keys, exact marker, ambiguous studios and ordinary deletes passed';
ROLLBACK TO keys;
ROLLBACK;
