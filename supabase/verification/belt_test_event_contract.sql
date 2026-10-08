-- Synthetic rollback-only belt-test event contract. Owned disposable PG17 only.
BEGIN;
SET LOCAL statement_timeout='60s';
CREATE TEMP TABLE belt_checks(label TEXT PRIMARY KEY);
GRANT SELECT,INSERT ON belt_checks TO anon,authenticated,service_role;
CREATE FUNCTION pg_temp.belt_check(ok BOOLEAN,label TEXT) RETURNS VOID LANGUAGE plpgsql AS $$ BEGIN
    IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'belt contract failed: %',label; END IF;
    INSERT INTO belt_checks VALUES(label);
END $$;
CREATE FUNCTION pg_temp.belt_error(statement TEXT,code TEXT,message TEXT,label TEXT) RETURNS VOID
LANGUAGE plpgsql AS $$ DECLARE got_code TEXT; got_message TEXT; BEGIN
    BEGIN EXECUTE statement;
    EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS got_code=RETURNED_SQLSTATE,got_message=MESSAGE_TEXT;
    END;
    IF got_code IS DISTINCT FROM code OR (message IS NOT NULL AND got_message IS DISTINCT FROM message) THEN
        RAISE EXCEPTION 'belt negative failed %: got % (%), expected % (%)',label,got_code,got_message,code,message;
    END IF;
    PERFORM pg_temp.belt_check(true,label);
END $$;
CREATE FUNCTION pg_temp.belt_bad(s UUID,a UUID,t UUID,rev BIGINT,req JSONB,code TEXT,kind TEXT,label TEXT,op UUID DEFAULT gen_random_uuid()) RETURNS VOID
LANGUAGE sql AS $$ SELECT pg_temp.belt_error(format('SELECT public.mutate_belt_test_event_v1(%L,%L,%L,%L,%L,%L)',s,a,t,op,rev,req),code,kind,label) $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO anon,authenticated,service_role;
SELECT pg_temp.belt_check(NOT EXISTS(SELECT 1 FROM public.belt_test_events) AND NOT EXISTS(SELECT 1 FROM public.belt_test_recipients),'no migration backfill');
DO $$ DECLARE role_name TEXT; t TEXT; f REGPROCEDURE; BEGIN
    FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
        EXECUTE format('SET LOCAL ROLE %I',role_name);
        FOREACH t IN ARRAY ARRAY['belt_test_events','belt_test_recipients'] LOOP
            PERFORM pg_temp.belt_error('SELECT * FROM public.'||t,'42501',NULL,role_name||' denied '||t);
        END LOOP;
        PERFORM pg_temp.belt_error('SELECT public.mutate_belt_test_event_v1(NULL,NULL,NULL,NULL,NULL,NULL)','42501',NULL,role_name||' mutation denied');
        PERFORM pg_temp.belt_error('SELECT public.list_belt_test_events_v1(NULL,NULL)','42501',NULL,role_name||' list denied');
        PERFORM pg_temp.belt_error('SELECT public.get_belt_test_event_v1(NULL,NULL,NULL)','42501',NULL,role_name||' detail denied');
        RESET ROLE;
    END LOOP;
    FOREACH t IN ARRAY ARRAY['belt_test_events','belt_test_recipients'] LOOP
        PERFORM pg_temp.belt_check((SELECT relrowsecurity AND relpersistence='p' AND pg_get_userbyid(relowner)='postgres'
            FROM pg_class WHERE oid=('public.'||t)::REGCLASS),'logged RLS owner '||t);
        PERFORM pg_temp.belt_check(has_table_privilege('service_role','public.'||t,'SELECT,INSERT,UPDATE,DELETE')
            AND NOT has_table_privilege('service_role','public.'||t,'TRUNCATE,REFERENCES,TRIGGER'),'exact service grants '||t);
        PERFORM pg_temp.belt_check((SELECT count(*)=2 AND bool_and(NOT polpermissive) FROM pg_policy
            WHERE polrelid=('public.'||t)::REGCLASS),'restrictive policies '||t);
    END LOOP;
    FOR f IN SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE (n.nspname='private' AND p.proname IN ('belt_test_name_v1','belt_test_event_payload_v1','belt_test_recipient_identity_v1'))
        OR (n.nspname='public' AND p.proname IN ('mutate_belt_test_event_v1','get_belt_test_event_v1','list_belt_test_events_v1')) LOOP
        PERFORM pg_temp.belt_check(has_function_privilege('service_role',f,'EXECUTE')=(f::TEXT<>'private.belt_test_recipient_identity_v1()') AND NOT has_function_privilege('anon',f,'EXECUTE')
            AND NOT has_function_privilege('authenticated',f,'EXECUTE') AND (SELECT NOT prosecdef AND proconfig=ARRAY['search_path=""'] FROM pg_proc WHERE oid=f),'safe function '||f::TEXT);
    END LOOP;
END $$;
CREATE FUNCTION pg_temp.belt_fail_write() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN
    IF current_setting('koaryu.belt_fail',true)=TG_TABLE_NAME THEN RAISE EXCEPTION 'BELT_TEST_FAILURE'; END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER belt_test_failure BEFORE INSERT ON public.audit_logs FOR EACH ROW EXECUTE FUNCTION pg_temp.belt_fail_write();
CREATE TRIGGER belt_test_failure BEFORE INSERT ON private.automation_command_operations FOR EACH ROW EXECUTE FUNCTION pg_temp.belt_fail_write();
DO $$
<<fixture>>
DECLARE a UUID:=gen_random_uuid(); owner_id UUID:=gen_random_uuid(); b UUID:=gen_random_uuid(); desk UUID:=gen_random_uuid();
    s UUID:=gen_random_uuid(); s2 UUID:=gen_random_uuid(); p UUID:=gen_random_uuid(); p2 UUID:=gen_random_uuid(); fp UUID:=gen_random_uuid();
    l UUID:=gen_random_uuid(); l2 UUID:=gen_random_uuid(); fl UUID:=gen_random_uuid(); legacy UUID:=gen_random_uuid();
    student UUID:=gen_random_uuid(); foreign_student UUID:=gen_random_uuid(); membership UUID:=gen_random_uuid(); rank1 UUID:=gen_random_uuid(); rank2 UUID:=gen_random_uuid();
    op UUID:=gen_random_uuid(); patch_op UUID:=gen_random_uuid(); t UUID; t2 UUID; cancel_event UUID; ft UUID; recipient UUID; other_recipient UUID;
    req JSONB; bad JSONB; first JSONB; r JSONB; v JSONB; page JSONB; cursor JSONB; original JSONB; patch JSONB;
    cascade_studio UUID:=gen_random_uuid(); cascade_student UUID:=gen_random_uuid(); cascade_event UUID:=gen_random_uuid();
    n INTEGER; rev BIGINT; sched BIGINT; label TEXT; state_name TEXT; key_name TEXT; cols TEXT[];
    wid UUID; version_id UUID; activation_id UUID; event_id UUID;
    graph JSONB:='{"schema_version":1,"nodes":[{"id":"start","type":"trigger","config":{"event_type":"belt_test.approved"}},{"id":"end","type":"end","config":{}}],"edges":[{"id":"next","source":"start","target":"end","port":"next"}]}';
BEGIN
    INSERT INTO auth.users(id,email,email_confirmed_at) VALUES(a,a||'@example.invalid',clock_timestamp()),(owner_id,owner_id||'@example.invalid',clock_timestamp()),
        (b,b||'@example.invalid',clock_timestamp()),(desk,desk||'@example.invalid',clock_timestamp());
    INSERT INTO public.studios(id,name,slug,owner_id,timezone) VALUES(s,'Belt contract',s::TEXT,owner_id,'UTC'),(s2,'Other belt',s2::TEXT,b,'UTC');
    INSERT INTO public.staff_roles(studio_id,user_id,role) VALUES(s,a,'admin'),(s,owner_id,'admin'),(s2,b,'admin'),(s,desk,'front_desk');
    INSERT INTO public.studio_subscriptions(studio_id,status,comped) VALUES(s,'active',false),(s2,'active',false);
    INSERT INTO public.programs(id,studio_id,name) VALUES(p,s,'Program'),(p2,s,'Other program'),(fp,s2,'Foreign program');
    INSERT INTO public.belt_ladders(id,studio_id,name,program_id) VALUES(l,s,'Ladder',p),(l2,s,'Other ladder',p2),(fl,s2,'Foreign ladder',fp),(legacy,s,'Legacy',NULL);
    INSERT INTO public.students(id,studio_id,legal_first_name,legal_last_name) VALUES(student,s,'Synthetic','Recipient'),(foreign_student,s2,'Foreign','Recipient');
    INSERT INTO public.student_program_memberships(id,studio_id,student_id,program_id) VALUES(membership,s,student,p);
    INSERT INTO public.belt_ranks(id,studio_id,ladder_id,name,display_order) VALUES(rank1,s,l,'First',0),(rank2,s,l,'Second',1);
    req:=jsonb_build_object('name',' Belt day ','ladder_id',l,'starts_at',private.automation_utc_text_v1(clock_timestamp()+INTERVAL '7 days'),
        'ends_at',private.automation_utc_text_v1(clock_timestamp()+INTERVAL '7 days 1 hour'),'timezone','America/Los_Angeles');
    SET LOCAL ROLE service_role;
    PERFORM pg_temp.belt_check(public.list_belt_test_events_v1(s,a)->'payload'='{"items":[],"next_cursor":null,"has_more":false}','authorized empty list');
    PERFORM pg_temp.belt_bad(s,desk,NULL,NULL,req,'42501','AUTOMATION_ADMIN_REQUIRED','front desk denied');
    PERFORM pg_temp.belt_bad(s,b,NULL,NULL,req,'42501','AUTOMATION_ADMIN_REQUIRED','foreign actor denied');
    PERFORM pg_temp.belt_bad(s,a,NULL,NULL,req||jsonb_build_object('ladder_id',fl),'P0002','AUTOMATION_NOT_FOUND','foreign ladder denied');
    PERFORM pg_temp.belt_bad(s,a,NULL,NULL,req||jsonb_build_object('ladder_id',gen_random_uuid()),'P0002','AUTOMATION_NOT_FOUND','missing ladder denied');
    FOREACH label IN ARRAY ARRAY['audit_logs','automation_command_operations'] LOOP
        PERFORM set_config('koaryu.belt_fail',label,true);
        PERFORM pg_temp.belt_bad(s,a,NULL,NULL,req,'P0001','BELT_TEST_FAILURE','create failure '||label);
        PERFORM pg_temp.belt_check(NOT EXISTS(SELECT 1 FROM public.belt_test_events WHERE studio_id=s)
            AND NOT EXISTS(SELECT 1 FROM public.audit_logs WHERE studio_id=s)
            AND NOT EXISTS(SELECT 1 FROM private.automation_command_operations WHERE studio_id=s),'no ghost create '||label);
    END LOOP;
    PERFORM set_config('koaryu.belt_fail','',true);
    first:=public.mutate_belt_test_event_v1(s,a,NULL,op,NULL,req); t:=(first#>>'{payload,id}')::UUID;
    SELECT array_agg(k ORDER BY k) INTO cols FROM jsonb_object_keys(first->'payload') k;
    PERFORM pg_temp.belt_check(cols=ARRAY['created_at','created_by','ends_at','id','ladder_id','location','name','program_id','revision','schedule_revision','starts_at','status','studio_id','timezone','updated_at'],'exact event DTO fields');
    PERFORM pg_temp.belt_check(first#>>'{payload,program_id}'=p::TEXT AND first#>>'{payload,status}'='draft' AND first#>>'{payload,name}'='Belt day'
        AND first#>>'{payload,revision}'='1' AND first#>>'{payload,schedule_revision}'='1' AND first#>>'{payload,location}'='' AND NOT first ? 'message','canonical draft and derived program');
    PERFORM pg_temp.belt_check(public.get_belt_test_event_v1(s,a,t)->'payload'=first->'payload','detail is canonical command DTO');
    FOREACH bad IN ARRAY ARRAY['{"status":"bogus"}'::JSONB,'{"revision":0}','{"schedule_revision":0}',
        '{"schedule_revision":2}','{"starts_at":"infinity"}','{"ends_at":"-infinity"}',
        '{"created_at":"infinity"}','{"updated_at":"infinity"}','{"location":null}',
        '{"timezone":"Not/AZone"}','{"name":"\t\n"}','{"name":"\u00a0"}'] LOOP
        PERFORM pg_temp.belt_error(format('INSERT INTO public.belt_test_events SELECT (jsonb_populate_record(NULL::public.belt_test_events,%L::jsonb)).*',
            first->'payload'||bad||jsonb_build_object('id',gen_random_uuid())),
            CASE WHEN bad ? 'name' OR bad ? 'timezone' THEN '22023' WHEN bad ? 'location' THEN '23502' ELSE '23514' END,
            NULL,'event table constraint '||bad::TEXT);
    END LOOP;

    PERFORM pg_temp.belt_check(public.mutate_belt_test_event_v1(s,a,NULL,op,NULL,req||'{"name":"Belt day","status":"draft","location":""}')=first||'{"replayed":true}','normalized defaults replay');
    PERFORM pg_temp.belt_bad(s,a,NULL,NULL,req||'{"name":"Other"}','P0001','AUTOMATION_OPERATION_CONFLICT','changed valid replay conflict',op);
    PERFORM pg_temp.belt_bad(s,a,NULL,NULL,req||'{"name":null}','P0001','AUTOMATION_OPERATION_CONFLICT','changed malformed replay conflict',op);
    PERFORM pg_temp.belt_check((SELECT command='belt_test.create' AND entity_type='belt_test' AND entity_id=t FROM private.automation_command_operations WHERE studio_id=s AND operation_id=op),'receipt entity tags');
    PERFORM pg_temp.belt_check(public.get_automation_operation_v1(s,a,op)#>'{payload,result}'=first->'payload','common operation readback');
    r:=public.mutate_belt_test_event_v1(s2,b,NULL,gen_random_uuid(),NULL,req||jsonb_build_object('ladder_id',fl)); ft:=(r#>>'{payload,id}')::UUID;
    PERFORM pg_temp.belt_bad(s,a,ft,1,'{"name":"Other"}','P0002','AUTOMATION_NOT_FOUND','foreign event edit denied');
    PERFORM pg_temp.belt_error(format('SELECT public.get_belt_test_event_v1(%L,%L,%L)',s,a,ft),'P0002','AUTOMATION_NOT_FOUND','foreign detail denied');
    PERFORM pg_temp.belt_error(format('SELECT public.list_belt_test_events_v1(%L,%L)',s,desk),'42501','AUTOMATION_ADMIN_REQUIRED','front desk list denied');
    FOREACH bad IN ARRAY ARRAY['{"starts_at":null}'::JSONB,'{"starts_at":123}','{"starts_at":"infinity"}',
        '{"starts_at":"2030-01-01T10:00:00"}','{"starts_at":"2030-01-01T24:00:00Z"}','{"starts_at":"2030-01-01T10:00:60Z"}',
        '{"starts_at":"0001-01-01T00:00:00+01:00"}','{"starts_at":"9999-12-31T23:59:59-01:00"}',
        '{"timezone":"localtime"}','{"timezone":"posix/UTC"}','{"timezone":"right/UTC"}','{"timezone":"Not/AZone"}','{"timezone":"../UTC"}',
        '{"location":null}','{"location":12}','{"ladder_id":true}','{"ladder_id":null}','{"ladder_id":"bad"}',
        '{"status":null}','{"status":"bogus"}','{"unknown":1}','{"program_id":null}','{"name":null}','{"name":" "}','{"name":"\t\n"}','{"name":"\u00a0"}','{}'] LOOP
        PERFORM pg_temp.belt_bad(s,a,t,1,bad,'22023','AUTOMATION_INVALID_REQUEST','invalid patch '||bad::TEXT);
    END LOOP;
    PERFORM pg_temp.belt_bad(s,a,t,1,jsonb_build_object('name',repeat('a',141)),'22023','AUTOMATION_INVALID_REQUEST','name too long');
    PERFORM pg_temp.belt_bad(s,a,t,1,jsonb_build_object('location',repeat('a',241)),'22023','AUTOMATION_INVALID_REQUEST','location too long');
    PERFORM pg_temp.belt_bad(s,a,NULL,NULL,req-'ladder_id','22023','AUTOMATION_INVALID_REQUEST','required ladder omitted');
    PERFORM pg_temp.belt_bad(s,a,NULL,NULL,req||jsonb_build_object('program_id',p),'22023','AUTOMATION_INVALID_REQUEST','client program forbidden');
    PERFORM pg_temp.belt_bad(s,a,NULL,NULL,req||'{"status":"completed"}','22023','AUTOMATION_INVALID_REQUEST','create terminal forbidden');
    PERFORM pg_temp.belt_bad(s,a,t,1,jsonb_build_object('ends_at',req->'starts_at'),'22023','AUTOMATION_INVALID_REQUEST','zero window');
    PERFORM pg_temp.belt_bad(s,a,t,1,jsonb_build_object('ends_at',private.automation_utc_text_v1((req->>'starts_at')::TIMESTAMPTZ+INTERVAL '25 hours')),'22023','AUTOMATION_INVALID_REQUEST','window over day');
    PERFORM pg_temp.belt_bad(s,a,t,2,'{"name":"Changed"}','P0001','AUTOMATION_REVISION_CONFLICT','stale CAS');
    PERFORM pg_temp.belt_bad(s,a,t,1,'{"name":"Belt day"}','P0001','AUTOMATION_STATE_CONFLICT','effective no-op');
    PERFORM pg_temp.belt_bad(s,a,t,1,'{"status":"completed"}','P0001','AUTOMATION_STATE_CONFLICT','draft cannot complete');
    r:=public.mutate_belt_test_event_v1(s,a,t,patch_op,1,'{"status":"scheduled"}');
    PERFORM pg_temp.belt_check(r#>>'{payload,status}'='scheduled' AND r#>>'{payload,revision}'='2' AND r#>>'{payload,schedule_revision}'='1','draft scheduling preserves unchanged schedule');
    PERFORM pg_temp.belt_bad(s,a,t,2,'{"status":"draft"}','P0001','AUTOMATION_STATE_CONFLICT','scheduled cannot return to draft');
    PERFORM pg_temp.belt_bad(s,a,t,2,'{"status":"completed"}','P0001','AUTOMATION_STATE_CONFLICT','early completion');
    r:=public.mutate_belt_test_event_v1(s,a,NULL,gen_random_uuid(),NULL,req||jsonb_build_object('ladder_id',legacy,
        'starts_at','2020-01-01T00:00:00Z','ends_at','2020-01-01T01:00:00Z')); t2:=(r#>>'{payload,id}')::UUID;
    PERFORM pg_temp.belt_check(r#>'{payload,program_id}'='null'::JSONB AND r#>>'{payload,status}'='draft','past draft and genuine legacy null context');
    PERFORM pg_temp.belt_bad(s,a,t2,1,'{"status":"scheduled"}','P0001','AUTOMATION_STATE_CONFLICT','past draft cannot schedule');
    PERFORM pg_temp.belt_check(NOT EXISTS(SELECT 1 FROM private.automation_workflow_events WHERE studio_id=s)
        AND NOT EXISTS(SELECT 1 FROM public.belt_test_recipients WHERE studio_id=s),'commands do not invent approval or enrollment');
    RESET ROLE;
    INSERT INTO public.belt_test_recipients(studio_id,event_id,student_id,student_program_membership_id,approved_schedule_revision,approved_rank_context_generation,
        approved_current_rank_id,approved_target_rank_id,state,approved_by,approved_at)
        VALUES(s,t,student,membership,1,private.workflow_rank_context_generation_v1(s,student,membership),rank1,rank2,'approved',a,clock_timestamp()) RETURNING id INTO recipient;
    INSERT INTO public.belt_test_recipients(studio_id,event_id,student_id,approved_schedule_revision,approved_rank_context_generation,approved_target_rank_id,state,approved_by,approved_at)
        VALUES(s,t2,student,1,private.workflow_rank_context_generation_v1(s,student,NULL),rank2,'approved',a,clock_timestamp()) RETURNING id INTO other_recipient;
    SELECT to_jsonb(x) INTO original FROM public.belt_test_recipients x WHERE id=recipient;
    FOREACH bad IN ARRAY ARRAY['{"state":"bogus"}'::JSONB,'{"revision":0}','{"approved_schedule_revision":0}',
        '{"approved_target_rank_id":null}','{"approved_at":"infinity"}','{"revoked_at":"infinity"}',
        '{"created_at":"infinity"}','{"updated_at":"infinity"}','{"state":"revoked"}'] LOOP
        PERFORM pg_temp.belt_error(format('INSERT INTO public.belt_test_recipients SELECT (jsonb_populate_record(NULL::public.belt_test_recipients,%L::jsonb)).*',
            original||bad||jsonb_build_object('id',gen_random_uuid(),'student_program_membership_id',gen_random_uuid())),
            CASE WHEN bad ? 'approved_target_rank_id' THEN '23502' ELSE '23514' END,NULL,'recipient table constraint '||bad::TEXT);
    END LOOP;

    PERFORM pg_temp.belt_error(format('INSERT INTO public.belt_test_recipients SELECT (jsonb_populate_record(NULL::public.belt_test_recipients,%L::jsonb)).*',
        original||jsonb_build_object('id',gen_random_uuid(),'student_id',foreign_student)),'23503',NULL,'recipient student tenant binding');
    PERFORM pg_temp.belt_error(format('INSERT INTO public.belt_test_recipients SELECT (jsonb_populate_record(NULL::public.belt_test_recipients,%L::jsonb)).*',
        original||jsonb_build_object('id',gen_random_uuid(),'event_id',ft)),'23503',NULL,'recipient event tenant binding');
    SELECT to_jsonb(x) INTO v FROM public.belt_test_recipients x WHERE id=other_recipient;
    PERFORM pg_temp.belt_error(format('INSERT INTO public.belt_test_recipients SELECT (jsonb_populate_record(NULL::public.belt_test_recipients,%L::jsonb)).*',
        v||jsonb_build_object('id',gen_random_uuid())),'23505',NULL,'null membership duplicate rejected');
    FOREACH key_name IN ARRAY ARRAY['event_id','student_id','student_program_membership_id','id'] LOOP
        PERFORM pg_temp.belt_error(format('UPDATE public.belt_test_recipients SET %I=%L,revision=revision+1 WHERE id=%L',key_name,gen_random_uuid(),recipient),
            'P0001','AUTOMATION_STATE_CONFLICT','immutable identity '||key_name);
    END LOOP;
    PERFORM pg_temp.belt_error(format('UPDATE public.belt_test_recipients SET approved_target_rank_id=%L WHERE id=%L',gen_random_uuid(),recipient),
        'P0001','AUTOMATION_STATE_CONFLICT','snapshot change requires revision');
    SET LOCAL ROLE service_role;
    r:=public.mutate_belt_test_event_v1(s,a,t,gen_random_uuid(),2,'{"name":"Corrected"}');
    PERFORM pg_temp.belt_check(r#>>'{payload,revision}'='3' AND r#>>'{payload,schedule_revision}'='1'
        AND (SELECT to_jsonb(x)=original FROM public.belt_test_recipients x WHERE id=recipient),'name preserves exact approval row');
    -- One synthetic run per state proves cancellation preserves sending/unknown truth while recording intent.
    r:=public.create_automation_workflow_v1(s,a,gen_random_uuid(),'Belt proof','',graph,'{}'); wid:=(r#>>'{payload,id}')::UUID;
    r:=public.command_automation_workflow_v1(s,a,wid,gen_random_uuid(),1,'publish'); version_id:=(r#>>'{payload,published_version_id}')::UUID;
    PERFORM public.command_automation_workflow_v1(s,a,wid,gen_random_uuid(),2,'start');
    SELECT id INTO activation_id FROM public.automation_workflow_activations WHERE workflow_id=wid AND retired_at IS NULL;
    FOREACH state_name IN ARRAY ARRAY['queued','waiting','claimed','running','sending','unknown','unrelated'] LOOP
        INSERT INTO private.automation_workflow_events(studio_id,event_type,source_key,subject_kind,subject_id,occurred_at)
            VALUES(s,'belt_test.approved',state_name,'belt_test',CASE WHEN state_name='unrelated' THEN other_recipient ELSE recipient END,clock_timestamp()) RETURNING id INTO event_id;
        INSERT INTO public.automation_workflow_runs(studio_id,workflow_id,version_id,event_id,activation_id,epoch,current_node_id,state,next_due_at,claim_token,lease_expires_at)
            VALUES(s,wid,version_id,event_id,activation_id,1,'start',CASE WHEN state_name='unrelated' THEN 'queued' ELSE state_name END,
                CASE WHEN state_name NOT IN ('sending','unknown') THEN clock_timestamp() END,
                CASE WHEN state_name IN ('claimed','running','sending','unknown') THEN gen_random_uuid() END,
                CASE WHEN state_name IN ('claimed','running','sending','unknown') THEN clock_timestamp()+INTERVAL '1 minute' END);
    END LOOP;
    SELECT count(*) INTO n FROM private.automation_command_operations WHERE studio_id=s;
    FOREACH label IN ARRAY ARRAY['audit_logs','automation_command_operations'] LOOP
        PERFORM set_config('koaryu.belt_fail',label,true);
        PERFORM pg_temp.belt_bad(s,a,t,3,'{"location":"Changed"}','P0001','BELT_TEST_FAILURE','update failure '||label);
        PERFORM pg_temp.belt_check((SELECT revision=3 AND schedule_revision=1 AND location='' FROM public.belt_test_events WHERE id=t)
            AND (SELECT to_jsonb(x)=original FROM public.belt_test_recipients x WHERE id=recipient)
            AND (SELECT count(*)=n FROM private.automation_command_operations WHERE studio_id=s)
            AND (SELECT count(*)=3 FROM public.audit_logs WHERE entity_id=t)
            AND NOT EXISTS(SELECT 1 FROM public.automation_workflow_runs WHERE workflow_id=wid AND state='cancelled'),'atomic invalidation rollback '||label);
    END LOOP;
    PERFORM set_config('koaryu.belt_fail','',true);
    rev:=3; sched:=1;
    FOREACH patch IN ARRAY ARRAY['{"location":"Changed"}'::JSONB,'{"timezone":"UTC"}',
        jsonb_build_object('starts_at',private.automation_utc_text_v1((req->>'starts_at')::TIMESTAMPTZ+INTERVAL '1 minute')),
        jsonb_build_object('ends_at',private.automation_utc_text_v1((req->>'ends_at')::TIMESTAMPTZ+INTERVAL '1 minute')),
        jsonb_build_object('ladder_id',l2)] LOOP
        r:=public.mutate_belt_test_event_v1(s,a,t,gen_random_uuid(),rev,patch);
        PERFORM pg_temp.belt_check(r#>>'{payload,revision}'=(rev+1)::TEXT AND r#>>'{payload,schedule_revision}'=(sched+1)::TEXT
            AND (SELECT state='revoked' AND revoked_at IS NOT NULL AND approved_current_rank_id=rank1 AND approved_target_rank_id=rank2
                AND student_program_membership_id=membership FROM public.belt_test_recipients WHERE id=recipient),'effective change invalidates '||patch::TEXT);
        rev:=rev+1; sched:=sched+1;
        -- A synthetic explicit reapproval revision, never an exposed task04 command.
        UPDATE public.belt_test_recipients SET state='approved',revision=revision+1,approved_schedule_revision=sched,revoked_at=NULL WHERE id=recipient;
    END LOOP;
    PERFORM pg_temp.belt_check((SELECT program_id=p2 FROM public.belt_test_events WHERE id=t),'different ladder derives different program');
    PERFORM pg_temp.belt_check((SELECT count(*)=4 FROM public.automation_workflow_runs WHERE workflow_id=wid AND state='cancelled' AND claim_token IS NULL)
        AND (SELECT count(*)=2 FROM public.automation_workflow_runs WHERE workflow_id=wid AND state IN ('sending','unknown') AND claim_token IS NOT NULL AND next_due_at IS NULL
            AND revision=2 AND cancel_requested_at IS NOT NULL AND cancel_reason='belt_test_changed')
        AND (SELECT count(*)=1 FROM public.automation_workflow_runs WHERE workflow_id=wid AND state='queued'),'cancel nonsending runs only across exact event recipients');
    RESET ROLE;
    UPDATE public.belt_test_events SET starts_at=clock_timestamp()-INTERVAL '2 hours',ends_at=clock_timestamp()-INTERVAL '1 hour' WHERE id=t;
    SET LOCAL ROLE service_role;
    r:=public.mutate_belt_test_event_v1(s,a,t,gen_random_uuid(),rev,'{"name":"Started correction"}'); rev:=rev+1;
    PERFORM pg_temp.belt_check(r#>>'{payload,schedule_revision}'=sched::TEXT AND (SELECT state='approved' FROM public.belt_test_recipients WHERE id=recipient),'started name correction preserves approval');
    PERFORM pg_temp.belt_bad(s,a,t,rev,'{"location":"Too late"}','P0001','AUTOMATION_STATE_CONFLICT','past effective schedule edit rejected');
    r:=public.mutate_belt_test_event_v1(s,a,t,gen_random_uuid(),rev,'{"status":"completed"}'); rev:=rev+1;
    PERFORM pg_temp.belt_check(r#>>'{payload,status}'='completed' AND (SELECT state='revoked' FROM public.belt_test_recipients WHERE id=recipient),'explicit completion revokes approval');
    PERFORM pg_temp.belt_bad(s,a,t,rev,'{"name":"Terminal"}','P0001','AUTOMATION_STATE_CONFLICT','completed terminal');
    PERFORM pg_temp.belt_check(public.mutate_belt_test_event_v1(s,a,NULL,op,NULL,req)=first||'{"replayed":true}','create replay after time status revision changes');
    PERFORM pg_temp.belt_check(public.mutate_belt_test_event_v1(s,a,t,patch_op,1,'{"status":"scheduled"}')#>>'{payload,status}'='scheduled','patch replay after completion');
    -- Exact old reference required even for name-only and supplied same ladder.
    r:=public.mutate_belt_test_event_v1(s,a,NULL,gen_random_uuid(),NULL,req); t:=(r#>>'{payload,id}')::UUID;
    r:=public.mutate_belt_test_event_v1(s,a,NULL,gen_random_uuid(),NULL,req); cancel_event:=(r#>>'{payload,id}')::UUID;
    RESET ROLE;
    UPDATE public.programs SET archived_at=clock_timestamp() WHERE id=p;
    SET LOCAL ROLE service_role;
    PERFORM pg_temp.belt_bad(s,a,t,1,'{"name":"Archived"}','P0001','AUTOMATION_STATE_CONFLICT','name edit requires active program');
    RESET ROLE;
    DELETE FROM public.student_program_memberships WHERE id=membership;
    DELETE FROM public.belt_ranks WHERE id IN (rank1,rank2);
    DELETE FROM public.programs WHERE id=p;
    SET LOCAL ROLE service_role;
    PERFORM pg_temp.belt_check((SELECT student_program_membership_id=membership AND approved_current_rank_id=rank1 AND approved_target_rank_id=rank2 FROM public.belt_test_recipients WHERE id=recipient),'deleted membership and ranks retain snapshots');
    PERFORM pg_temp.belt_check((SELECT ladder_id=l AND program_id=p FROM public.belt_test_events WHERE id=t),'deleted program retains event context');
    PERFORM pg_temp.belt_bad(s,a,t,1,'{"name":"Detached"}','P0001','AUTOMATION_STATE_CONFLICT','name edit rejects detached program');
    PERFORM pg_temp.belt_bad(s,a,t,1,jsonb_build_object('name','Same selected','ladder_id',l),'P0001','AUTOMATION_STATE_CONFLICT','supplied same ladder cannot repair context');
    PERFORM pg_temp.belt_bad(s,a,t,1,'{"location":"Detached"}','P0001','AUTOMATION_STATE_CONFLICT','schedule edit rejects detached program');
    PERFORM pg_temp.belt_bad(s,a,t,1,'{"status":"canceled","location":"New location"}','P0001','AUTOMATION_STATE_CONFLICT','mixed cancel schedule edit requires context');
    PERFORM pg_temp.belt_bad(s,a,t,1,jsonb_build_object('status','canceled','ladder_id',gen_random_uuid()),'P0002','AUTOMATION_NOT_FOUND','mixed cancel new ladder must resolve');
    r:=public.mutate_belt_test_event_v1(s,a,cancel_event,gen_random_uuid(),1,'{"status":"canceled","name":"Historical correction"}');
    PERFORM pg_temp.belt_check(r#>>'{payload,status}'='canceled' AND r#>>'{payload,name}'='Historical correction'
        AND r#>>'{payload,program_id}'=p::TEXT AND r#>>'{payload,schedule_revision}'='1','cancel plus name retains detached context');
    r:=public.mutate_belt_test_event_v1(s,a,t2,gen_random_uuid(),1,'{"status":"canceled","starts_at":"2019-01-01T00:00:00Z","ends_at":"2019-01-01T01:00:00Z"}');
    PERFORM pg_temp.belt_check(r#>>'{payload,status}'='canceled' AND r#>>'{payload,schedule_revision}'='2','mixed cancel with valid context needs no future window');

    r:=public.mutate_belt_test_event_v1(s,a,t,gen_random_uuid(),1,jsonb_build_object('ladder_id',l2));
    PERFORM pg_temp.belt_check(r#>>'{payload,program_id}'=p2::TEXT,'genuinely different ladder can repair context');
    RESET ROLE;
    DELETE FROM public.belt_ladders WHERE id=l2;
    SET LOCAL ROLE service_role;
    PERFORM pg_temp.belt_bad(s,a,t,2,'{"name":"Missing ladder"}','P0002','AUTOMATION_NOT_FOUND','missing ladder name edit denied');
    r:=public.mutate_belt_test_event_v1(s,a,t,gen_random_uuid(),2,'{"status":"canceled"}');
    PERFORM pg_temp.belt_check(r#>>'{payload,status}'='canceled' AND r#>>'{payload,ladder_id}'=l2::TEXT AND r#>>'{payload,program_id}'=p2::TEXT,'cancel preserves missing logical context');
    PERFORM pg_temp.belt_bad(s,a,t,3,'{"name":"Terminal"}','P0001','AUTOMATION_STATE_CONFLICT','canceled terminal');
    RESET ROLE;
    UPDATE public.belt_test_events SET created_at=TIMESTAMPTZ '2026-01-01 00:00:00Z' WHERE studio_id=s;
    SET LOCAL ROLE service_role;
    page:=public.list_belt_test_events_v1(s,a,1); cursor:=page#>'{payload,next_cursor}';
    PERFORM pg_temp.belt_check(page#>'{payload,has_more}'='true'::JSONB AND cursor->>'id'=page#>>'{payload,items,0,id}'
        AND cursor->>'created_at'=page#>>'{payload,items,0,created_at}','cursor exact row snapshot');
    r:=public.list_belt_test_events_v1(s,a,100,cursor);
    PERFORM pg_temp.belt_check(r#>'{payload,has_more}'='false'::JSONB AND r#>'{payload,next_cursor}'='null'::JSONB
        AND jsonb_array_length(r#>'{payload,items}')=3 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r#>'{payload,items}') item WHERE item->>'id'=cursor->>'id'),'keyset tie without repeats');
    PERFORM pg_temp.belt_error(format('SELECT public.list_belt_test_events_v1(%L,%L,0)',s,a),'22023','AUTOMATION_INVALID_REQUEST','bad list limit');
    PERFORM pg_temp.belt_error(format('SELECT public.list_belt_test_events_v1(%L,%L,1,%L)',s,a,'{"id":"bad","created_at":"infinity"}'),'22023','AUTOMATION_INVALID_REQUEST','bad cursor');
    RESET ROLE;
    UPDATE public.staff_roles SET archived_at=clock_timestamp() WHERE studio_id=s AND user_id=a;
    SET LOCAL ROLE service_role;
    PERFORM pg_temp.belt_bad(s,a,NULL,NULL,req,'42501','AUTOMATION_ADMIN_REQUIRED','archived admin replay denied',op);
    RESET ROLE;
    UPDATE public.staff_roles SET archived_at=NULL,role='front_desk' WHERE studio_id=s AND user_id=a;
    SET LOCAL ROLE service_role;
    PERFORM pg_temp.belt_bad(s,a,NULL,NULL,req,'42501','AUTOMATION_ADMIN_REQUIRED','demoted admin replay denied',op);
    RESET ROLE;
    UPDATE public.staff_roles SET role='admin' WHERE studio_id=s AND user_id=a;
    UPDATE public.studio_subscriptions SET status='canceled' WHERE studio_id=s;
    SET LOCAL ROLE service_role;
    PERFORM pg_temp.belt_bad(s,a,NULL,NULL,req,'42501','AUTOMATION_ADMIN_REQUIRED','lost entitlement replay denied',op);
    RESET ROLE;
    DELETE FROM public.students WHERE id=student;
    PERFORM pg_temp.belt_check(NOT EXISTS(SELECT 1 FROM public.belt_test_recipients WHERE student_id=student),'student deletion cascades recipient rows');
    -- A tenant without staff exercises FK cascades without bypassing the retained
    -- last-admin deletion guard on the authenticated command fixture.
    INSERT INTO public.studios(id,name,slug,owner_id) VALUES(cascade_studio,'Cascade fixture',cascade_studio::TEXT,owner_id);
    INSERT INTO public.students(id,studio_id,legal_first_name,legal_last_name) VALUES(cascade_student,cascade_studio,'Cascade','Fixture');
    INSERT INTO public.belt_test_events SELECT (jsonb_populate_record(NULL::public.belt_test_events,
        to_jsonb(e)||jsonb_build_object('id',cascade_event,'studio_id',cascade_studio))).* FROM public.belt_test_events e WHERE id=t2;
    INSERT INTO public.belt_test_recipients(studio_id,event_id,student_id,approved_schedule_revision,approved_rank_context_generation,approved_target_rank_id,state,approved_at)
        VALUES(cascade_studio,cascade_event,cascade_student,1,private.workflow_rank_context_generation_v1(cascade_studio,cascade_student,NULL),rank2,'approved',clock_timestamp());
    DELETE FROM public.studios WHERE id=cascade_studio;
    PERFORM pg_temp.belt_check(NOT EXISTS(SELECT 1 FROM public.belt_test_events WHERE studio_id=cascade_studio)
        AND NOT EXISTS(SELECT 1 FROM public.belt_test_recipients WHERE studio_id=cascade_studio),'studio deletion cascades domain rows');
END $$;
SELECT jsonb_build_object('contract','belt_test_event','checks',count(*),'result','passed') FROM belt_checks;
ROLLBACK;
