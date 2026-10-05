-- Synthetic rollback-only trial contract. Use only an owned disposable PG17 clone.
BEGIN;
SET LOCAL statement_timeout='60s';
CREATE TEMP TABLE trial_checks(label TEXT PRIMARY KEY);
GRANT SELECT,INSERT ON trial_checks TO anon,authenticated,service_role;
CREATE FUNCTION pg_temp.trial_check(p_ok BOOLEAN,p_label TEXT) RETURNS VOID
LANGUAGE plpgsql AS $$ BEGIN
    IF p_ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'trial contract failed: %',p_label; END IF;
    INSERT INTO trial_checks VALUES(p_label);
END $$;
CREATE FUNCTION pg_temp.trial_error(p_sql TEXT,p_state TEXT,p_message TEXT,p_label TEXT) RETURNS VOID
LANGUAGE plpgsql AS $$ DECLARE got_state TEXT; got_message TEXT; BEGIN
    BEGIN EXECUTE p_sql;
    EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS got_state=RETURNED_SQLSTATE,got_message=MESSAGE_TEXT;
    END;
    IF got_state IS DISTINCT FROM p_state OR (p_message IS NOT NULL AND got_message IS DISTINCT FROM p_message) THEN
        RAISE EXCEPTION 'trial negative failed %: got % (%), expected % (%)',p_label,got_state,got_message,p_state,p_message;
    END IF;
    PERFORM pg_temp.trial_check(true,p_label);
END $$;
CREATE FUNCTION pg_temp.trial_bad(s UUID,a UUID,l UUID,t UUID,rev BIGINT,req JSONB,code TEXT,kind TEXT,label TEXT,op UUID DEFAULT gen_random_uuid()) RETURNS VOID
LANGUAGE sql AS $$ SELECT pg_temp.trial_error(format('SELECT public.mutate_lead_trial_appointment_v1(%L,%L,%L,%L,%L,%L,%L)',s,a,l,t,op,rev,req),code,kind,label) $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO anon,authenticated,service_role;
SELECT pg_temp.trial_check(NOT EXISTS(SELECT 1 FROM public.lead_trial_appointments),'migration has no appointment backfill');
DO $$ DECLARE role_name TEXT; f REGPROCEDURE; BEGIN
    FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
        EXECUTE format('SET LOCAL ROLE %I',role_name);
        PERFORM pg_temp.trial_error('SELECT * FROM public.lead_trial_appointments','42501',NULL,role_name||' table denied');
        PERFORM pg_temp.trial_error('SELECT public.list_lead_trial_appointments_v1(NULL,NULL,NULL)','42501',NULL,role_name||' list denied');
        PERFORM pg_temp.trial_error('SELECT public.mutate_lead_trial_appointment_v1(NULL,NULL,NULL,NULL,NULL,NULL,NULL)','42501',NULL,role_name||' mutation denied');
        RESET ROLE;
    END LOOP;
    PERFORM pg_temp.trial_check((SELECT relrowsecurity AND relpersistence='p' AND pg_get_userbyid(relowner)='postgres'
        FROM pg_class WHERE oid='public.lead_trial_appointments'::REGCLASS),'logged postgres-owned RLS table');
    PERFORM pg_temp.trial_check(has_table_privilege('service_role','public.lead_trial_appointments','SELECT,INSERT,UPDATE')
        AND NOT has_table_privilege('service_role','public.lead_trial_appointments','DELETE,TRUNCATE,REFERENCES,TRIGGER'),'exact service table grants');
    FOR f IN SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE (n.nspname='private' AND p.proname IN ('automation_instant_v1','automation_utc_text_v1','automation_timezone_v1','trial_appointment_payload_v1','workflow_cancel_source_pending_v1'))
        OR (n.nspname='public' AND p.proname IN ('mutate_lead_trial_appointment_v1','list_lead_trial_appointments_v1')) LOOP
        PERFORM pg_temp.trial_check(has_function_privilege('service_role',f,'EXECUTE') AND NOT has_function_privilege('anon',f,'EXECUTE')
            AND NOT has_function_privilege('authenticated',f,'EXECUTE') AND (SELECT NOT prosecdef AND proconfig=ARRAY['search_path=""'] FROM pg_proc WHERE oid=f),f::TEXT||' service-only safe invoker');
    END LOOP;
END $$;
CREATE FUNCTION pg_temp.trial_fail_write() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN
    IF current_setting('koaryu.trial_fail',true)=TG_TABLE_NAME THEN RAISE EXCEPTION 'TRIAL_TEST_FAILURE'; END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER trial_test_failure BEFORE INSERT ON public.lead_activities FOR EACH ROW EXECUTE FUNCTION pg_temp.trial_fail_write();
CREATE TRIGGER trial_test_failure BEFORE INSERT ON public.audit_logs FOR EACH ROW EXECUTE FUNCTION pg_temp.trial_fail_write();
CREATE TRIGGER trial_test_failure BEFORE INSERT ON private.automation_command_operations FOR EACH ROW EXECUTE FUNCTION pg_temp.trial_fail_write();
DO $$
<<fixture>>
DECLARE a UUID:=gen_random_uuid(); owner_id UUID:=gen_random_uuid(); b UUID:=gen_random_uuid(); desk UUID:=gen_random_uuid();
    s UUID:=gen_random_uuid(); s2 UUID:=gen_random_uuid(); l UUID:=gen_random_uuid(); l2 UUID:=gen_random_uuid(); foreign_lead UUID:=gen_random_uuid();
    p UUID:=gen_random_uuid(); p2 UUID:=gen_random_uuid(); foreign_program UUID:=gen_random_uuid(); op UUID:=gen_random_uuid(); patch_op UUID:=gen_random_uuid();
    t UUID; t2 UUID; t3 UUID; l3 UUID:=gen_random_uuid(); r JSONB; first JSONB; patched JSONB; req JSONB; bad JSONB; v JSONB; page JSONB; cursor JSONB;
    n INTEGER; activity_n INTEGER; audit_n INTEGER; receipt_n INTEGER; label TEXT; stage_name TEXT; state_name TEXT;
    wid UUID; version_id UUID; activation_id UUID; event_id UUID; run_id UUID;
    g JSONB:='{"schema_version":1,"nodes":[{"id":"start","type":"trigger","config":{"event_type":"trial.scheduled"}},{"id":"end","type":"end","config":{}}],"edges":[{"id":"next","source":"start","target":"end","port":"next"}]}';
BEGIN
    INSERT INTO auth.users(id,email) VALUES(a,a||'@example.invalid'),(owner_id,owner_id||'@example.invalid'),(b,b||'@example.invalid'),(desk,desk||'@example.invalid');
    UPDATE auth.users SET email_confirmed_at=clock_timestamp() WHERE id IN (a,owner_id,b,desk);
    INSERT INTO public.studios(id,name,slug,owner_id,timezone) VALUES(s,'Trial contract',s::TEXT,owner_id,'UTC'),(s2,'Other trial',s2::TEXT,b,'UTC');
    INSERT INTO public.staff_roles(studio_id,user_id,role) VALUES(s,a,'admin'),(s,owner_id,'admin'),(s2,b,'admin'),(s,desk,'front_desk');
    INSERT INTO public.studio_subscriptions(studio_id,status,comped) VALUES(s,'active',false),(s2,'active',false);
    INSERT INTO public.programs(id,studio_id,name) VALUES(p,s,'Trial program'),(p2,s,'Other trial program'),(foreign_program,s2,'Foreign program');
    INSERT INTO public.leads(id,studio_id,first_name,last_name,program_id) VALUES(l,s,'Synthetic','Lead',p),(l2,s,'Second','Lead',p),(foreign_lead,s2,'Foreign','Lead',foreign_program);
    req:=jsonb_build_object('starts_at',private.automation_utc_text_v1(clock_timestamp()+INTERVAL '7 days'),
        'ends_at',private.automation_utc_text_v1(clock_timestamp()+INTERVAL '7 days 1 hour'),'timezone','America/Los_Angeles');
    SET LOCAL ROLE service_role;
    PERFORM pg_temp.trial_check(public.list_lead_trial_appointments_v1(s,a,l)->'payload'='{"items":[],"next_cursor":null,"has_more":false}','owned empty list');
    PERFORM pg_temp.trial_error(format('SELECT public.list_lead_trial_appointments_v1(%L,%L,%L)',s,a,foreign_lead),'P0002','AUTOMATION_NOT_FOUND','empty list checks lead tenant');
    PERFORM pg_temp.trial_error(format('SELECT public.list_lead_trial_appointments_v1(%L,%L,%L)',s,desk,l),'42501','AUTOMATION_ADMIN_REQUIRED','front desk trial management denied');
    PERFORM pg_temp.trial_bad(s,b,l,NULL,NULL,req,'42501','AUTOMATION_ADMIN_REQUIRED','cross tenant actor denied');
    PERFORM pg_temp.trial_bad(s,a,foreign_lead,NULL,NULL,req,'P0002','AUTOMATION_NOT_FOUND','cross tenant parent denied');
    PERFORM pg_temp.trial_bad(s,a,l,NULL,NULL,req||jsonb_build_object('program_id',foreign_program),'P0002','AUTOMATION_NOT_FOUND','foreign program denied');
    PERFORM pg_temp.trial_bad(s,a,l,NULL,NULL,req||jsonb_build_object('program_id',gen_random_uuid()),'P0002','AUTOMATION_NOT_FOUND','missing program denied');
    FOREACH label IN ARRAY ARRAY['lead_activities','audit_logs','automation_command_operations'] LOOP
        PERFORM set_config('koaryu.trial_fail',label,true);
        PERFORM pg_temp.trial_bad(s,a,l,NULL,NULL,req,'P0001','TRIAL_TEST_FAILURE','create failure at '||label);
        PERFORM pg_temp.trial_check(NOT EXISTS(SELECT 1 FROM public.lead_trial_appointments WHERE lead_id=l)
            AND NOT EXISTS(SELECT 1 FROM public.lead_activities WHERE lead_id=l)
            AND NOT EXISTS(SELECT 1 FROM public.audit_logs WHERE studio_id=s)
            AND NOT EXISTS(SELECT 1 FROM private.automation_command_operations WHERE studio_id=s)
            AND (SELECT stage='inquiry' FROM public.leads WHERE id=l),'rollback creation and stage after '||label);
    END LOOP;
    PERFORM set_config('koaryu.trial_fail','',true);
    first:=public.mutate_lead_trial_appointment_v1(s,a,l,NULL,op,NULL,req); t:=(first#>>'{payload,id}')::UUID;
    PERFORM pg_temp.trial_check(first#>>'{payload,program_id}'=p::TEXT AND first#>>'{payload,status}'='scheduled'
        AND first#>>'{payload,revision}'='1' AND first#>>'{payload,location}'='' AND first#>>'{payload,created_by}'=a::TEXT
        AND NOT first->'payload' ? 'schedule_revision' AND NOT first ? 'message','create canonical payload and inherited program');
    PERFORM pg_temp.trial_check((SELECT stage='trial_scheduled' FROM public.leads WHERE id=l)
        AND (SELECT count(*)=1 FROM public.lead_activities WHERE lead_id=l AND activity_type='meeting')
        AND (SELECT count(*)=1 FROM public.lead_activities WHERE lead_id=l AND activity_type='stage_change')
        AND (SELECT count(*)=1 FROM public.audit_logs WHERE entity_id=t),'atomic appointment stage activity audit');
    PERFORM pg_temp.trial_check(public.mutate_lead_trial_appointment_v1(s,a,l,NULL,op,NULL,req||'{"location":""}')=first||'{"replayed":true}','normalized default location replay');
    PERFORM pg_temp.trial_bad(s,a,l,NULL,NULL,req||'{"location":"Different"}','P0001','AUTOMATION_OPERATION_CONFLICT','different request conflicts',op);
    PERFORM pg_temp.trial_bad(s,a,l,NULL,NULL,req||'{"timezone":null}','P0001','AUTOMATION_OPERATION_CONFLICT','invalid changed replay conflicts',op);
    PERFORM pg_temp.trial_bad(s,a,l,NULL,NULL,req,'P0001','AUTOMATION_STATE_CONFLICT','one scheduled appointment');
    PERFORM pg_temp.trial_bad(s,a,l,t,2,'{"location":"Different"}','P0001','AUTOMATION_REVISION_CONFLICT','stale appointment revision');
    PERFORM pg_temp.trial_bad(s,a,l,t,1,'{"location":""}','P0001','AUTOMATION_STATE_CONFLICT','effective no-op rejected');
    PERFORM pg_temp.trial_bad(s,a,l,t,1,'{"status":"completed","location":"Different"}','22023','AUTOMATION_INVALID_REQUEST','outcome is status-only');
    PERFORM pg_temp.trial_bad(s,a,l,t,1,'{"status":"completed"}','P0001','AUTOMATION_STATE_CONFLICT','early completion rejected');
    PERFORM pg_temp.trial_bad(s,a,l,t,1,'{"status":"no_show"}','P0001','AUTOMATION_STATE_CONFLICT','early no-show rejected');
    patched:=public.mutate_lead_trial_appointment_v1(s,a,l,t,patch_op,1,'{"location":"Studio"}');
    PERFORM pg_temp.trial_check(patched#>>'{payload,revision}'='2' AND patched#>>'{payload,location}'='Studio','schedule edit increments once');
    PERFORM pg_temp.trial_check(public.mutate_lead_trial_appointment_v1(s,a,l,t,patch_op,1,'{"location":"Studio"}')=patched||'{"replayed":true}','edit replay before current revision');
    r:=public.mutate_lead_trial_appointment_v1(s,a,l2,NULL,gen_random_uuid(),NULL,req||'{"program_id":null}'); t2:=(r#>>'{payload,id}')::UUID;
    PERFORM pg_temp.trial_check(r#>'{payload,program_id}'='null'::JSONB,'explicit null prevents program inheritance');
    FOREACH bad IN ARRAY ARRAY['{"starts_at":null}'::JSONB,'{"starts_at":123}', '{"starts_at":"infinity"}',
        '{"starts_at":"2030-01-01T10:00:00"}', '{"starts_at":"2030-01-01T24:00:00Z"}',
        '{"starts_at":"2030-01-01T10:00:60Z"}', '{"starts_at":"0001-01-01T00:00:00+01:00"}',
        '{"starts_at":"9999-12-31T23:59:59-01:00"}', '{"timezone":"localtime"}', '{"timezone":"posix/UTC"}',
        '{"timezone":"right/UTC"}', '{"timezone":"Not/AZone"}', '{"timezone":"../UTC"}', '{"location":null}',
        '{"location":12}', '{"program_id":true}', '{"status":null}', '{"status":"bogus"}', '{"unknown":1}', '{}'] LOOP
        PERFORM pg_temp.trial_bad(s,a,l2,t2,1,bad,'22023','AUTOMATION_INVALID_REQUEST','invalid patch '||bad::TEXT);
    END LOOP;
    PERFORM pg_temp.trial_bad(s,a,l2,t2,1,jsonb_build_object('ends_at',req->'starts_at'),'22023','AUTOMATION_INVALID_REQUEST','zero merged window');
    PERFORM pg_temp.trial_bad(s,a,l2,t2,1,jsonb_build_object('ends_at',private.automation_utc_text_v1((req->>'starts_at')::TIMESTAMPTZ+INTERVAL '25 hours')),'22023','AUTOMATION_INVALID_REQUEST','window over one day');
    PERFORM pg_temp.trial_check(private.automation_instant_v1('"2030-11-03T01:30:00-07:00"')=TIMESTAMPTZ '2030-11-03 08:30:00Z'
        AND private.automation_instant_v1('"2030-11-03T01:30:00-08:00"')=TIMESTAMPTZ '2030-11-03 09:30:00Z'
        AND private.automation_instant_v1('"2030-01-01T00:00:00+23:59"')=TIMESTAMPTZ '2029-12-31 00:01:00Z'
        AND private.automation_instant_v1('"2030-01-01T00:00:00.123456789Z"')=TIMESTAMPTZ '2030-01-01 00:00:00.123456Z','resolved DST instants and Python fraction truncation');
    r:=public.mutate_lead_trial_appointment_v1(s,a,l2,t2,gen_random_uuid(),1,jsonb_build_object('program_id',p2));
    PERFORM pg_temp.trial_check(r#>>'{payload,program_id}'=p2::TEXT AND r#>>'{payload,revision}'='2','scheduled program correction uses current selected context');
    r:=public.mutate_lead_trial_appointment_v1(s,a,l2,t2,gen_random_uuid(),2,'{"program_id":null}');
    PERFORM pg_temp.trial_check(r#>'{payload,program_id}'='null'::JSONB AND r#>>'{payload,revision}'='3','explicit null patch clears selected context');
    RESET ROLE;
    UPDATE public.leads SET program_id=p2 WHERE id=l;
    UPDATE public.lead_trial_appointments SET starts_at=clock_timestamp()-INTERVAL '2 hours',ends_at=clock_timestamp()-INTERVAL '1 hour' WHERE id=t;
    SET LOCAL ROLE service_role;
    PERFORM pg_temp.trial_check(public.mutate_lead_trial_appointment_v1(s,a,l,NULL,op,NULL,req)=first||'{"replayed":true}','create replay after clock and inherited parent change');
    r:=public.mutate_lead_trial_appointment_v1(s,a,l,t,gen_random_uuid(),2,'{"status":"completed"}');
    PERFORM pg_temp.trial_check(r#>>'{payload,status}'='completed' AND r#>>'{payload,revision}'='3'
        AND (SELECT stage='trial_completed' FROM public.leads WHERE id=l),'explicit completion advances eligible stage');
    PERFORM pg_temp.trial_bad(s,a,l,t,3,'{"status":"canceled"}','P0001','AUTOMATION_STATE_CONFLICT','terminal outcome cannot change');
    r:=public.mutate_lead_trial_appointment_v1(s,a,l,NULL,gen_random_uuid(),NULL,req); t:=(r#>>'{payload,id}')::UUID;
    PERFORM pg_temp.trial_check((SELECT stage='trial_completed' FROM public.leads WHERE id=l),'rebooking preserves later stage');
    RESET ROLE;
    UPDATE public.leads SET stage='offer_sent' WHERE id=l;
    UPDATE public.lead_trial_appointments SET starts_at=clock_timestamp()-INTERVAL '2 hours',ends_at=clock_timestamp()-INTERVAL '1 hour' WHERE id=t;
    SET LOCAL ROLE service_role;
    r:=public.mutate_lead_trial_appointment_v1(s,a,l,t,gen_random_uuid(),1,'{"status":"no_show"}');
    PERFORM pg_temp.trial_check(r#>>'{payload,status}'='no_show' AND (SELECT stage='offer_sent' AND converted_student_id IS NULL FROM public.leads WHERE id=l),'explicit no-show preserves later stage without enrollment');
    RESET ROLE;
    INSERT INTO public.leads(id,studio_id,first_name,last_name,program_id,stage) VALUES(l3,s,'Later stage','Fixture',p2,'offer_sent');
    SET LOCAL ROLE service_role;
    r:=public.mutate_lead_trial_appointment_v1(s,a,l3,NULL,gen_random_uuid(),NULL,req); t3:=(r#>>'{payload,id}')::UUID;
    RESET ROLE;
    UPDATE public.lead_trial_appointments SET starts_at=clock_timestamp()-INTERVAL '2 hours',ends_at=clock_timestamp()-INTERVAL '1 hour' WHERE id=t3;
    SET LOCAL ROLE service_role;
    r:=public.mutate_lead_trial_appointment_v1(s,a,l3,t3,gen_random_uuid(),1,'{"status":"completed"}');
    PERFORM pg_temp.trial_check(r#>>'{payload,status}'='completed' AND (SELECT stage='offer_sent' FROM public.leads WHERE id=l3),'completion preserves offer_sent');
    r:=public.mutate_lead_trial_appointment_v1(s,a,l3,NULL,gen_random_uuid(),NULL,req); t3:=(r#>>'{payload,id}')::UUID;
    PERFORM public.convert_lead_to_student_atomic(s,a,l3,gen_random_uuid(),p2,'active',CURRENT_DATE);
    PERFORM pg_temp.trial_bad(s,a,l3,t3,1,'{"location":"Changed"}','P0001','AUTOMATION_STATE_CONFLICT','converted lead rejects schedule edits');
    r:=public.mutate_lead_trial_appointment_v1(s,a,l3,t3,gen_random_uuid(),1,'{"status":"canceled"}');
    PERFORM pg_temp.trial_check(r#>>'{payload,status}'='canceled' AND (SELECT stage='enrolled' AND converted_student_id IS NOT NULL FROM public.leads WHERE id=l3),'cancellation preserves genuine conversion');
    RESET ROLE;
    UPDATE public.programs SET archived_at=clock_timestamp() WHERE id=p;
    SET LOCAL ROLE service_role;
    PERFORM pg_temp.trial_bad(s,a,l2,t2,3,jsonb_build_object('program_id',p),'P0001','AUTOMATION_STATE_CONFLICT','archived current reference rejected');
    RESET ROLE;
    UPDATE public.lead_trial_appointments SET program_id=p WHERE id=t2;
    UPDATE public.leads SET stage='closed_lost' WHERE id=l2;
    DELETE FROM public.programs WHERE id=p;
    SET LOCAL ROLE service_role;
    PERFORM pg_temp.trial_check((SELECT program_id=p AND status='scheduled' FROM public.lead_trial_appointments WHERE id=t2),'deleted logical program retained without automatic outcome');
    r:=public.mutate_lead_trial_appointment_v1(s,a,l2,t2,gen_random_uuid(),3,'{"status":"canceled"}');
    PERFORM pg_temp.trial_check(r#>>'{payload,status}'='canceled' AND r#>>'{payload,program_id}'=p::TEXT
        AND (SELECT stage='closed_lost' FROM public.leads WHERE id=l2),'cancel after closed lead and deleted reference');
    PERFORM pg_temp.trial_check((SELECT count(*) FROM private.automation_workflow_events WHERE studio_id=s AND event_type LIKE 'trial.%')=
        (SELECT count(*) FROM private.automation_command_operations WHERE studio_id=s AND command IN ('trial.create','trial.update')
            AND result->>'status' IN ('scheduled','completed','no_show'))
        AND NOT EXISTS(SELECT 1 FROM private.automation_command_operations o WHERE o.studio_id=s AND o.command IN ('trial.create','trial.update')
            AND o.result->>'status' IN ('scheduled','completed','no_show') AND NOT EXISTS(
                SELECT 1 FROM private.automation_workflow_events e WHERE e.studio_id=s AND e.event_type='trial.'||(o.result->>'status')
                    AND e.subject_kind='trial' AND e.subject_id=(o.result->>'id')::UUID
                    AND e.source_key=(o.result->>'id')||':'||(o.result->>'revision')
                    AND e.context=jsonb_build_object('appointment_id',o.result->'id','lead_id',o.result->'lead_id',
                        'program_id',o.result->'program_id','revision',o.result->'revision','status',o.result->'status')))
        AND (SELECT count(*)=3 FROM private.automation_workflow_events WHERE studio_id=s AND event_type='lead.stage_changed'
            AND context->>'stage' IN ('trial_scheduled','trial_completed'))
        AND NOT EXISTS(SELECT 1 FROM private.automation_workflow_events e WHERE e.studio_id=s AND e.event_type='lead.stage_changed' AND e.context->>'stage' IN ('trial_scheduled','trial_completed')
            AND NOT EXISTS(SELECT 1 FROM public.lead_activities a WHERE a.id=e.source_key::UUID AND a.studio_id=s
                AND a.lead_id=e.subject_id AND a.activity_type='stage_change' AND e.context->>'activity_id'=a.id::TEXT
                AND e.context->>'lead_id'=a.lead_id::TEXT AND e.context->>'stage' IN ('trial_scheduled','trial_completed')))
        AND (SELECT count(*)=1 FROM private.automation_workflow_events e JOIN public.lead_activities activity
            ON activity.id=e.source_key::UUID AND activity.studio_id=s AND activity.lead_id=l3 AND activity.activity_type='stage_change'
            WHERE e.studio_id=s AND e.event_type='lead.stage_changed' AND e.subject_kind='lead' AND e.subject_id=l3
                AND e.context=jsonb_build_object('lead_id',l3,'program_id',p2,'activity_id',activity.id,'old_stage','offer_sent','stage','enrolled'))
        AND (SELECT count(*)=4 FROM private.automation_workflow_events WHERE studio_id=s AND event_type='lead.stage_changed')
        AND (SELECT count(*)=1 FROM private.automation_workflow_events e JOIN public.leads converted ON converted.id=l3 AND converted.studio_id=s
            WHERE e.studio_id=s AND e.event_type='student.enrolled' AND e.subject_kind='student' AND e.subject_id=converted.converted_student_id
                AND e.source_key=converted.converted_student_id::TEXT
                AND e.context=jsonb_build_object('student_id',converted.converted_student_id,'matched_program_ids','[]'::JSONB))
        AND (SELECT count(*)=1 FROM private.automation_workflow_events WHERE studio_id=s AND event_type='student.enrolled')
        AND NOT EXISTS(SELECT 1 FROM private.automation_workflow_events WHERE studio_id=s AND event_type NOT IN
            ('trial.scheduled','trial.completed','trial.no_show','lead.stage_changed','student.enrolled'))
        AND NOT EXISTS(SELECT 1 FROM public.automation_workflow_runs WHERE studio_id=s),'exact committed trial and owned stage occurrences without target runs');
    -- Cursor ordering has a tie so UUID, not insertion order, resolves the page.
    RESET ROLE;
    UPDATE public.lead_trial_appointments SET created_at=TIMESTAMPTZ '2026-01-01 00:00:00Z' WHERE lead_id=l;
    SET LOCAL ROLE service_role;
    page:=public.list_lead_trial_appointments_v1(s,a,l,1); cursor:=page#>'{payload,next_cursor}';
    PERFORM pg_temp.trial_check(page#>'{payload,has_more}'='true'::JSONB AND cursor->>'id'=page#>>'{payload,items,0,id}'
        AND cursor->>'created_at'=page#>>'{payload,items,0,created_at}','keyset cursor comes from last returned row');
    r:=public.list_lead_trial_appointments_v1(s,a,l,100,cursor);
    PERFORM pg_temp.trial_check(r#>'{payload,has_more}'='false'::JSONB AND r#>'{payload,next_cursor}'='null'::JSONB
        AND jsonb_array_length(r#>'{payload,items}')=1 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r#>'{payload,items}') item WHERE item->>'id'=cursor->>'id'),'keyset tie page has no repeats');
    PERFORM pg_temp.trial_error(format('SELECT public.list_lead_trial_appointments_v1(%L,%L,%L,0)',s,a,l),'22023','AUTOMATION_INVALID_REQUEST','invalid list limit');
    PERFORM pg_temp.trial_error(format('SELECT public.list_lead_trial_appointments_v1(%L,%L,%L,1,%L)',s,a,l,'{"id":"bad","created_at":"infinity"}'),'22023','AUTOMATION_INVALID_REQUEST','invalid list cursor');
    -- A real pending run fixture is synthetic test state only, never an emitter.
    r:=public.create_automation_workflow_v1(s,a,gen_random_uuid(),'Trial proof','',g,'{}'); wid:=(r#>>'{payload,id}')::UUID;
    r:=public.command_automation_workflow_v1(s,a,wid,gen_random_uuid(),1,'publish'); version_id:=(r#>>'{payload,published_version_id}')::UUID;
    PERFORM public.command_automation_workflow_v1(s,a,wid,gen_random_uuid(),2,'start');
    SELECT id INTO activation_id FROM public.automation_workflow_activations WHERE workflow_id=wid AND retired_at IS NULL;
    r:=public.mutate_lead_trial_appointment_v1(s,a,l,NULL,gen_random_uuid(),NULL,req); t:=(r#>>'{payload,id}')::UUID;
    FOREACH state_name IN ARRAY ARRAY['queued','waiting','claimed','running','sending','unknown','unrelated'] LOOP
        INSERT INTO private.automation_workflow_events(studio_id,event_type,source_key,subject_kind,subject_id,occurred_at)
            VALUES(s,'trial.scheduled',state_name,'trial',CASE WHEN state_name='unrelated' THEN t2 ELSE t END,clock_timestamp()) RETURNING id INTO event_id;
        INSERT INTO public.automation_workflow_runs(studio_id,workflow_id,version_id,event_id,activation_id,epoch,current_node_id,state,next_due_at,claim_token,lease_expires_at)
            VALUES(s,wid,version_id,event_id,activation_id,1,'start',CASE WHEN state_name='unrelated' THEN 'queued' ELSE state_name END,
                CASE WHEN state_name NOT IN ('sending','unknown') THEN clock_timestamp() END,
                CASE WHEN state_name IN ('claimed','running','sending','unknown') THEN gen_random_uuid() END,
                CASE WHEN state_name IN ('claimed','running','sending','unknown') THEN clock_timestamp()+INTERVAL '1 minute' END);
    END LOOP;
    SELECT count(*) INTO activity_n FROM public.lead_activities WHERE lead_id=l;
    SELECT count(*) INTO audit_n FROM public.audit_logs WHERE studio_id=s;
    SELECT count(*) INTO receipt_n FROM private.automation_command_operations WHERE studio_id=s;
    FOREACH label IN ARRAY ARRAY['lead_activities','audit_logs','automation_command_operations'] LOOP
        PERFORM set_config('koaryu.trial_fail',label,true);
        PERFORM pg_temp.trial_bad(s,a,l,t,1,'{"location":"New studio"}','P0001','TRIAL_TEST_FAILURE','atomic failure at '||label);
        PERFORM pg_temp.trial_check((SELECT revision=1 AND location='' FROM public.lead_trial_appointments WHERE id=t)
            AND (SELECT count(*)=activity_n FROM public.lead_activities WHERE lead_id=l)
            AND (SELECT count(*)=audit_n FROM public.audit_logs WHERE studio_id=s)
            AND (SELECT count(*)=receipt_n FROM private.automation_command_operations WHERE studio_id=s)
            AND NOT EXISTS(SELECT 1 FROM public.automation_workflow_runs WHERE workflow_id=wid AND state='cancelled'),'rollback all writes after '||label);
    END LOOP;
    PERFORM set_config('koaryu.trial_fail','',true);
    r:=public.mutate_lead_trial_appointment_v1(s,a,l,t,gen_random_uuid(),1,'{"location":"New studio"}');
    PERFORM pg_temp.trial_check((SELECT count(*)=4 FROM public.automation_workflow_runs run JOIN private.automation_workflow_events event ON event.id=run.event_id
            WHERE run.workflow_id=wid AND run.state='cancelled' AND run.claim_token IS NULL AND run.revision=2
                AND event.source_key IN ('queued','waiting','claimed','running'))
        AND (SELECT count(*)=2 FROM public.automation_workflow_runs run JOIN private.automation_workflow_events event ON event.id=run.event_id
            WHERE run.workflow_id=wid AND run.state IN ('sending','unknown') AND run.revision=2 AND run.claim_token IS NOT NULL AND run.next_due_at IS NULL
                AND run.cancel_requested_at IS NOT NULL AND run.cancel_reason='trial_changed'
                AND event.source_key IN ('sending','unknown'))
        AND (SELECT count(*)=1 FROM public.automation_workflow_runs run JOIN private.automation_workflow_events event ON event.id=run.event_id
            WHERE run.workflow_id=wid AND run.state='queued' AND event.source_key='unrelated' AND event.subject_id=t2)
        AND (SELECT count(*)=1 FROM public.automation_workflow_runs run JOIN private.automation_workflow_events event ON event.id=run.event_id
            WHERE run.workflow_id=wid AND run.state='cancelled' AND run.claim_token IS NULL AND run.revision=2
                AND event.source_key=t::TEXT||':1' AND event.subject_id=t AND event.event_type='trial.scheduled'
                AND event.context->>'revision'='1')
        AND (SELECT count(*)=1 FROM public.automation_workflow_runs run JOIN private.automation_workflow_events event ON event.id=run.event_id
            WHERE run.workflow_id=wid AND run.state='queued' AND run.revision=1 AND event.source_key=t::TEXT||':2'
                AND event.subject_id=t AND event.event_type='trial.scheduled' AND event.context->>'revision'='2')
        AND (SELECT count(*)=9 FROM public.automation_workflow_runs WHERE workflow_id=wid)
        AND (SELECT cancelled_at IS NULL AND retired_at IS NULL AND epoch=1 FROM public.automation_workflow_activations WHERE id=activation_id),'cancel only exact pending trial runs and preserve activation sending unknown');
    RESET ROLE;
    UPDATE public.staff_roles SET archived_at=clock_timestamp() WHERE studio_id=s AND user_id=a;
    SET LOCAL ROLE service_role;
    PERFORM pg_temp.trial_bad(s,a,l,NULL,NULL,req,'42501','AUTOMATION_ADMIN_REQUIRED','replay requires current active authority',op);
    RESET ROLE;
    UPDATE public.staff_roles SET archived_at=NULL WHERE studio_id=s AND user_id=a;
    UPDATE public.studio_subscriptions SET status='canceled' WHERE studio_id=s;
    SET LOCAL ROLE service_role;
    PERFORM pg_temp.trial_error(format('SELECT public.list_lead_trial_appointments_v1(%L,%L,%L)',s,a,l),'42501','AUTOMATION_ADMIN_REQUIRED','list requires entitlement');
    RESET ROLE;
    PERFORM pg_temp.trial_error(format('INSERT INTO public.lead_trial_appointments(studio_id,lead_id,starts_at,ends_at,timezone) VALUES(%L,%L,now(),now()+interval ''1 hour'',''UTC'')',s2,l),'23503',NULL,'composite lead tenant integrity');
    DELETE FROM public.leads WHERE id=l;
    PERFORM pg_temp.trial_check(NOT EXISTS(SELECT 1 FROM public.lead_trial_appointments WHERE lead_id=l),'lead deletion cascades appointments');
    -- A studio with no staff isolates the existing FK cascade from the retained
    -- last-admin guard, which deliberately rejects deleting active memberships.
    s:=gen_random_uuid(); l:=gen_random_uuid();
    INSERT INTO public.studios(id,name,slug,owner_id) VALUES(s,'Cascade fixture',s::TEXT,owner_id);
    INSERT INTO public.leads(id,studio_id,first_name,last_name) VALUES(l,s,'Cascade','Fixture');
    INSERT INTO public.lead_trial_appointments(studio_id,lead_id,starts_at,ends_at,timezone)
        VALUES(s,l,clock_timestamp(),clock_timestamp()+INTERVAL '1 hour','UTC');
    DELETE FROM public.studios WHERE id=s;
    PERFORM pg_temp.trial_check(NOT EXISTS(SELECT 1 FROM public.lead_trial_appointments WHERE studio_id=s),'studio deletion cascades appointments');
END $$;
SELECT jsonb_build_object('trial_contract_checks',count(*),'outcome','passed') FROM trial_checks;
ROLLBACK;
