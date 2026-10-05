-- Synthetic, transactional proof of explicit belt-test recipients. No sends.
BEGIN;
CREATE TEMP TABLE recipient_checks(label TEXT);
CREATE FUNCTION pg_temp.recipient_check(ok BOOLEAN,label TEXT) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
    IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'recipient contract failed: %',label; END IF;
    INSERT INTO pg_temp.recipient_checks VALUES(label);
END $$;
CREATE FUNCTION pg_temp.recipient_facts(s UUID) RETURNS JSONB LANGUAGE sql AS $$
 SELECT jsonb_build_object('recipients',(SELECT coalesce(jsonb_agg(to_jsonb(b) ORDER BY b.id),'[]'::jsonb) FROM public.belt_test_recipients b WHERE studio_id=s),
 'audits',(SELECT count(*) FROM public.audit_logs WHERE studio_id=s),
 'receipts',(SELECT count(*) FROM private.automation_command_operations WHERE studio_id=s))
$$;
CREATE FUNCTION pg_temp.recipient_error(statement TEXT,code TEXT,message TEXT,label TEXT,s UUID DEFAULT NULL) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE got_code TEXT; got_message TEXT; before JSONB;
BEGIN
    IF s IS NOT NULL THEN before:=pg_temp.recipient_facts(s); END IF;
    BEGIN EXECUTE statement; EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS got_code=RETURNED_SQLSTATE,got_message=MESSAGE_TEXT; END;
    IF got_code IS DISTINCT FROM code OR (message IS NOT NULL AND got_message IS DISTINCT FROM message) THEN
        RAISE EXCEPTION 'recipient negative failed %: got % (%), expected % (%)',label,got_code,got_message,code,message;
    END IF;
    IF s IS NOT NULL THEN PERFORM pg_temp.recipient_check(pg_temp.recipient_facts(s)=before,label||' unchanged');
    ELSE PERFORM pg_temp.recipient_check(true,label); END IF;
END $$;
CREATE FUNCTION pg_temp.recipient_approve(x JSONB,recipients JSONB DEFAULT NULL,operation UUID DEFAULT gen_random_uuid(),revision BIGINT DEFAULT 1) RETURNS JSONB LANGUAGE sql AS $$
 SELECT public.approve_belt_test_recipients_v1((x->>'studio')::uuid,(x->>'actor')::uuid,(x->>'event')::uuid,operation,revision,
 coalesce(recipients,jsonb_build_array(jsonb_build_object('student_id',x->'student','student_program_membership_id',x->'membership'))))
$$;
CREATE FUNCTION pg_temp.recipient_bad(x JSONB,recipients JSONB,code TEXT,message TEXT,label TEXT,revision BIGINT DEFAULT 1,operation UUID DEFAULT gen_random_uuid()) RETURNS VOID LANGUAGE sql AS $$
 SELECT pg_temp.recipient_error(format('SELECT pg_temp.recipient_approve(%L,%L,%L,%L)',x,recipients,operation,revision),code,message,label,(x->>'studio')::uuid)
$$;
CREATE FUNCTION pg_temp.recipient_fixture() RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE actor UUID:=gen_random_uuid(); owner UUID:=gen_random_uuid(); studio UUID:=gen_random_uuid(); program UUID:=gen_random_uuid(); ladder UUID:=gen_random_uuid(); rank0 UUID:=gen_random_uuid(); rank1 UUID:=gen_random_uuid(); rank2 UUID:=gen_random_uuid(); student UUID:=gen_random_uuid(); membership UUID:=gen_random_uuid(); session UUID:=gen_random_uuid(); attendance UUID:=gen_random_uuid(); event UUID:=gen_random_uuid();
BEGIN
INSERT INTO auth.users(id,email,email_confirmed_at) VALUES(actor,actor::text||'@example.invalid',clock_timestamp()),(owner,owner::text||'@example.invalid',clock_timestamp());
INSERT INTO public.studios(id,name,slug,owner_id,timezone) VALUES(studio,'Recipient race',studio,owner,'UTC');
INSERT INTO public.staff_roles(studio_id,user_id,role) VALUES(studio,actor,'admin'),(studio,owner,'admin');
INSERT INTO public.studio_subscriptions(studio_id,status,comped) VALUES(studio,'active',false);
INSERT INTO public.programs(id,studio_id,name) VALUES(program,studio,'Program');
INSERT INTO public.programs(studio_id,name,is_system) SELECT studio,'Unassigned',true WHERE NOT EXISTS(SELECT 1 FROM public.programs WHERE studio_id=studio AND is_system AND lower(name)='unassigned');
INSERT INTO public.belt_ladders(id,studio_id,name,program_id) VALUES(ladder,studio,'Ladder',program);
INSERT INTO public.belt_ranks(id,studio_id,ladder_id,name,display_order,min_classes,requires_approval) VALUES
(rank0,studio,ladder,'First',0,0,false),
(rank1,studio,ladder,'Next',1,1,true),
(rank2,studio,ladder,'Last',2,1,false);
INSERT INTO public.students(id,studio_id,legal_first_name,legal_last_name,status,program_id,current_belt_rank_id,membership_start_date)
VALUES(student,studio,'Synthetic','Recipient','active',program,rank0,CURRENT_DATE-120);
INSERT INTO public.student_program_memberships(id,studio_id,student_id,program_id,status,started_at,current_belt_rank_id)
VALUES(membership,studio,student,program,'active',CURRENT_DATE-120,rank0);
INSERT INTO public.class_sessions(id,studio_id,name,date,start_time,end_time,program_id,status)
VALUES(session,studio,'Class',CURRENT_DATE-1,'10:00','11:00',program,'completed');
INSERT INTO public.attendance(id,studio_id,session_id,student_id,status,checked_in_at)
VALUES(attendance,studio,session,student,'present',clock_timestamp()-interval '1 day');
INSERT INTO public.belt_test_events(id,studio_id,name,ladder_id,program_id,starts_at,ends_at,timezone,status)
VALUES(event,studio,'Test',ladder,program,clock_timestamp()+interval '7 days',clock_timestamp()+interval '7 days 1 hour','UTC','scheduled');
RETURN jsonb_build_object('actor',actor,'owner',owner,'studio',studio,'program',program,'ladder',ladder,'rank0',rank0,'rank1',rank1,'rank2',rank2,'student',student,'membership',membership,'session',session,'attendance',attendance,'event',event);
END $$;
GRANT ALL ON pg_temp.recipient_checks TO service_role,anon,authenticated;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO service_role,anon,authenticated;
CREATE FUNCTION pg_temp.recipient_fail_write() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN
    IF current_setting('koaryu.recipient_fail',true)=TG_TABLE_NAME THEN RAISE EXCEPTION 'RECIPIENT_WRITE_FAILURE'; END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER recipient_test_failure BEFORE INSERT ON public.audit_logs FOR EACH ROW EXECUTE FUNCTION pg_temp.recipient_fail_write();
CREATE TRIGGER recipient_test_failure BEFORE INSERT ON private.automation_command_operations FOR EACH ROW EXECUTE FUNCTION pg_temp.recipient_fail_write();
DO $$
DECLARE x JSONB:=pg_temp.recipient_fixture(); y JSONB:=pg_temp.recipient_fixture(); request JSONB; bad JSONB;
    first JSONB; replay JSONB; next_result JSONB; row_before JSONB; page JSONB; cols TEXT[];
    op UUID:=gen_random_uuid(); revoke_op UUID:=gen_random_uuid(); recipient UUID; s UUID:=(x->>'studio')::UUID;
    a UUID:=(x->>'actor')::UUID; e UUID:=(x->>'event')::UUID; n INTEGER; f REGPROCEDURE; role_name TEXT; key_name TEXT;
BEGIN
    request:=jsonb_build_array(jsonb_build_object('student_id',x->'student','student_program_membership_id',x->'membership'));
    FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
        EXECUTE format('SET LOCAL ROLE %I',role_name);
        PERFORM pg_temp.recipient_error('SELECT public.approve_belt_test_recipients_v1(NULL,NULL,NULL,NULL,NULL,NULL)','42501',NULL,role_name||' approve ACL');
        PERFORM pg_temp.recipient_error('SELECT public.revoke_belt_test_recipient_v1(NULL,NULL,NULL,NULL,NULL,NULL)','42501',NULL,role_name||' revoke ACL');
        PERFORM pg_temp.recipient_error('SELECT public.list_belt_test_recipients_v1(NULL,NULL,NULL)','42501',NULL,role_name||' list ACL');
        RESET ROLE;
    END LOOP;
    FOR f IN SELECT p.oid FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace WHERE p.proname IN
        ('approve_belt_test_recipients_v1','revoke_belt_test_recipient_v1','list_belt_test_recipients_v1','belt_test_recipient_payload_v1','belt_test_lock_recipient_runs_v1','belt_test_cancel_recipient_runs_v1') LOOP
        PERFORM pg_temp.recipient_check(has_function_privilege('service_role',f,'EXECUTE')
            AND NOT has_function_privilege('anon',f,'EXECUTE') AND NOT has_function_privilege('authenticated',f,'EXECUTE')
            AND (SELECT NOT prosecdef AND proconfig=ARRAY['search_path=""'] FROM pg_proc WHERE oid=f),'safe recipient function '||f::TEXT);
    END LOOP;
    SET LOCAL ROLE service_role;
    PERFORM pg_temp.recipient_check(public.list_belt_test_recipients_v1(s,a,e)->'payload'='{"items":[],"has_more":false,"next_cursor":null}', 'empty authorized list');
    PERFORM pg_temp.recipient_error(format('SELECT public.list_belt_test_recipients_v1(%L,%L,%L)',s,a,y->>'event'),'P0002','AUTOMATION_NOT_FOUND','empty foreign parent checked');
    FOREACH n IN ARRAY ARRAY[0,101] LOOP
        PERFORM pg_temp.recipient_error(format('SELECT public.list_belt_test_recipients_v1(%L,%L,%L,%L)',s,a,e,n),'22023','AUTOMATION_INVALID_REQUEST','list bound');
    END LOOP;
    FOREACH bad IN ARRAY ARRAY['{}'::JSONB,'{"id":null,"created_at":"2030-01-01T00:00:00Z"}','{"id":"bad","created_at":"2030-01-01T00:00:00Z"}',
        jsonb_build_object('id',gen_random_uuid(),'created_at','2030-01-01T00:00:00Z','extra',1)] LOOP
        PERFORM pg_temp.recipient_error(format('SELECT public.list_belt_test_recipients_v1(%L,%L,%L,50,%L)',s,a,e,bad),'22023','AUTOMATION_INVALID_REQUEST','cursor shape');
    END LOOP;
    FOREACH bad IN ARRAY ARRAY['null'::JSONB,'{}','[]','[null]','[{}]','[{"student_id":null}]',
        '[{"student_id":true}]','[{"student_id":"bad"}]',jsonb_build_array(request->0||'{"rank_id":null}'),
        jsonb_build_array(request->0||'{"student_program_membership_id":123}'),request||request] LOOP
        PERFORM pg_temp.recipient_bad(x,bad,'22023','AUTOMATION_INVALID_REQUEST','invalid batch '||bad::TEXT);
    END LOOP;
    SELECT jsonb_agg(jsonb_build_object('student_id',gen_random_uuid())) INTO bad FROM generate_series(1,101);
    PERFORM pg_temp.recipient_bad(x,bad,'22023','AUTOMATION_INVALID_REQUEST','batch over 100');
    PERFORM pg_temp.recipient_bad(x,request,'P0001','AUTOMATION_REVISION_CONFLICT','event CAS',2);
    PERFORM pg_temp.recipient_bad(x||jsonb_build_object('actor',y->'actor'),request,'42501','AUTOMATION_ADMIN_REQUIRED','foreign actor');
    PERFORM pg_temp.recipient_bad(x||jsonb_build_object('event',y->'event'),request,'P0002','AUTOMATION_NOT_FOUND','foreign event');
    PERFORM pg_temp.recipient_bad(x,request||jsonb_build_array(jsonb_build_object('student_id',y->'student','student_program_membership_id',y->'membership')),
        'P0002','AUTOMATION_NOT_FOUND','mixed foreign batch all or none');
    PERFORM pg_temp.recipient_bad(x,jsonb_build_array(jsonb_build_object('student_id',x->'student','student_program_membership_id',y->'membership')),
        'P0002','AUTOMATION_NOT_FOUND','foreign exact membership');
    PERFORM pg_temp.recipient_bad(x,jsonb_build_array(jsonb_build_object('student_id',x->'student')),
        'P0001','AUTOMATION_STATE_CONFLICT','null cannot replace membership');
    FOREACH key_name IN ARRAY ARRAY['audit_logs','automation_command_operations'] LOOP
        PERFORM set_config('koaryu.recipient_fail',key_name,true);
        PERFORM pg_temp.recipient_bad(x,request,'P0001','RECIPIENT_WRITE_FAILURE','atomic rollback after '||key_name);
    END LOOP;
    PERFORM set_config('koaryu.recipient_fail','',true);
    first:=pg_temp.recipient_approve(x,request,op); recipient:=(first#>>'{payload,items,0,id}')::UUID;
    SELECT array_agg(k ORDER BY k) INTO cols FROM jsonb_object_keys(first#>'{payload,items,0}') k;
    PERFORM pg_temp.recipient_check(cols=ARRAY['approved_at','approved_by','approved_current_rank_id','approved_schedule_revision','approved_target_rank_id','created_at','event_id','id','revision','revoked_at','state','student_id','student_program_membership_id','studio_id','updated_at'],'exact recipient DTO');
    PERFORM pg_temp.recipient_check(first#>>'{payload,items,0,student_id}'=x->>'student'
        AND first#>>'{payload,items,0,student_program_membership_id}'=x->>'membership'
        AND first#>>'{payload,items,0,approved_current_rank_id}'=x->>'rank0'
        AND first#>>'{payload,items,0,approved_target_rank_id}'=x->>'rank1'
        AND first#>>'{payload,event_revision}'='1' AND first#>>'{payload,schedule_revision}'='1'
        AND (SELECT revision=1 FROM public.belt_test_events WHERE id=e),'exact explicit approval and event revision unchanged');
    PERFORM pg_temp.recipient_check(NOT first ? 'message' AND first->>'replayed'='false','command envelope');
    PERFORM pg_temp.recipient_check((SELECT command='belt_test.approve' AND entity_type='belt_test' AND entity_id=e
        FROM private.automation_command_operations WHERE studio_id=s AND operation_id=op),'approval receipt tags');
    next_result:=pg_temp.recipient_approve(x);
    PERFORM pg_temp.recipient_check(next_result->'payload'=first->'payload','new key current approval is exact no-op');
    PERFORM pg_temp.recipient_bad(x,request||request,'P0001','AUTOMATION_OPERATION_CONFLICT','malformed changed receipt',1,op);
    PERFORM pg_temp.recipient_bad(x,request,'P0001','AUTOMATION_OPERATION_CONFLICT','changed receipt CAS',2,op);
    PERFORM public.mutate_belt_test_event_v1(s,a,e,gen_random_uuid(),1,'{"name":"Corrected"}');
    replay:=pg_temp.recipient_approve(x,request,op);
    PERFORM pg_temp.recipient_check(replay=first||'{"replayed":true}','replay retains original general event CAS after rename');
    PERFORM pg_temp.recipient_check(public.get_automation_operation_v1(s,a,op)#>'{payload,result}'=first->'payload','receipt readback immutable');
    RESET ROLE;
    UPDATE public.staff_roles SET archived_at=clock_timestamp() WHERE user_id=a;
    SET LOCAL ROLE service_role;
    PERFORM pg_temp.recipient_bad(x,request,'42501','AUTOMATION_ADMIN_REQUIRED','receipt replay checks current archived actor',1,op);
    RESET ROLE;
    UPDATE public.staff_roles SET archived_at=NULL,role='front_desk' WHERE user_id=a;
    SET LOCAL ROLE service_role;
    PERFORM pg_temp.recipient_bad(x,request,'42501','AUTOMATION_ADMIN_REQUIRED','receipt replay checks current role',1,op);
    RESET ROLE;
    UPDATE public.staff_roles SET role='admin' WHERE user_id=a;
    UPDATE public.studio_subscriptions SET status='canceled' WHERE studio_id=s;
    SET LOCAL ROLE service_role;
    PERFORM pg_temp.recipient_bad(x,request,'42501','AUTOMATION_ADMIN_REQUIRED','receipt replay checks current entitlement',1,op);
    RESET ROLE;
    UPDATE public.studio_subscriptions SET status='active' WHERE studio_id=s;
    SET LOCAL ROLE service_role;
    next_result:=public.revoke_belt_test_recipient_v1(s,a,e,recipient,revoke_op,1);
    PERFORM pg_temp.recipient_check(next_result#>>'{payload,state}'='revoked' AND next_result#>>'{payload,revision}'='2'
        AND next_result#>>'{payload,approved_at}'=first#>>'{payload,items,0,approved_at}'
        AND next_result#>>'{payload,revoked_at}' IS NOT NULL,'revoke preserves approval snapshot');
    PERFORM pg_temp.recipient_check(public.revoke_belt_test_recipient_v1(s,a,e,recipient,revoke_op,1)=next_result||'{"replayed":true}','revoke exact replay');
    PERFORM pg_temp.recipient_error(format('SELECT public.revoke_belt_test_recipient_v1(%L,%L,%L,%L,%L,1)',s,a,e,recipient,gen_random_uuid()),'P0001','AUTOMATION_REVISION_CONFLICT','revoke stale CAS',s);
    next_result:=pg_temp.recipient_approve(x,request,gen_random_uuid(),2);
    PERFORM pg_temp.recipient_check(next_result#>>'{payload,items,0,id}'=recipient::TEXT AND next_result#>>'{payload,items,0,revision}'='3'
        AND next_result#>'{payload,items,0,revoked_at}'='null'::JSONB AND next_result#>>'{payload,items,0,created_at}'=first#>>'{payload,items,0,created_at}','explicit reapproval retains identity');
    RESET ROLE;
    -- Reject active holds, non-active/deleted students, ended memberships and source changes.
    FOREACH bad IN ARRAY ARRAY['{"status":"paused"}'::JSONB,'{"deleted_at":"2026-01-01T00:00:00Z"}',
        jsonb_build_object('hold_start_date',CURRENT_DATE,'hold_end_date',NULL)] LOOP
        SELECT to_jsonb(st) INTO row_before FROM public.students st WHERE id=(x->>'student')::UUID;
        UPDATE public.students SET status=coalesce(bad->>'status',status),deleted_at=(bad->>'deleted_at')::TIMESTAMPTZ,
            hold_start_date=(bad->>'hold_start_date')::DATE,hold_end_date=(bad->>'hold_end_date')::DATE WHERE id=(x->>'student')::UUID;
        SET LOCAL ROLE service_role;
        PERFORM pg_temp.recipient_bad(x,request,'P0001','AUTOMATION_STATE_CONFLICT','ineligible student',2);
        RESET ROLE;
        UPDATE public.students SET status=row_before->>'status',deleted_at=(row_before->>'deleted_at')::TIMESTAMPTZ,
            hold_start_date=(row_before->>'hold_start_date')::DATE,hold_end_date=(row_before->>'hold_end_date')::DATE WHERE id=(x->>'student')::UUID;
    END LOOP;
    UPDATE public.student_program_memberships SET status='paused' WHERE id=(x->>'membership')::UUID;
    SET LOCAL ROLE service_role;
    PERFORM pg_temp.recipient_check(pg_temp.recipient_approve(x,request,gen_random_uuid(),2)->'payload'=next_result->'payload','paused unended membership accepted');
    RESET ROLE;
    UPDATE public.student_program_memberships SET status='ended',ended_at=CURRENT_DATE WHERE id=(x->>'membership')::UUID;
    SET LOCAL ROLE service_role;
    PERFORM pg_temp.recipient_bad(x,request,'P0001','AUTOMATION_STATE_CONFLICT','ended exact membership',2);
    RESET ROLE;
    UPDATE public.student_program_memberships SET status='active',ended_at=NULL WHERE id=(x->>'membership')::UUID;
    UPDATE public.programs SET archived_at=clock_timestamp() WHERE id=(x->>'program')::UUID;
    SET LOCAL ROLE service_role;
    PERFORM pg_temp.recipient_bad(x,request,'P0001','AUTOMATION_STATE_CONFLICT','archived program',2);
    RESET ROLE;
    UPDATE public.programs SET archived_at=NULL WHERE id=(x->>'program')::UUID;
    UPDATE public.belt_ranks SET min_classes=2 WHERE id=(x->>'rank1')::UUID;
    SET LOCAL ROLE service_role;
    PERFORM pg_temp.recipient_bad(x,request,'P0001','AUTOMATION_STATE_CONFLICT','insufficient earned classes',2);
    RESET ROLE;
    UPDATE public.belt_ranks SET min_classes=1,min_months=5 WHERE id=(x->>'rank1')::UUID;
    SET LOCAL ROLE service_role;
    PERFORM pg_temp.recipient_bad(x,request,'P0001','AUTOMATION_STATE_CONFLICT','insufficient elapsed days',2);
    RESET ROLE;
    UPDATE public.belt_ranks SET min_months=0 WHERE id=(x->>'rank1')::UUID;
    UPDATE public.class_sessions SET status='canceled' WHERE id=(x->>'session')::UUID;
    SET LOCAL ROLE service_role;
    PERFORM pg_temp.recipient_bad(x,request,'P0001','AUTOMATION_STATE_CONFLICT','canceled class excluded',2);
    RESET ROLE;
    UPDATE public.class_sessions SET status=NULL WHERE id=(x->>'session')::UUID;
    SET LOCAL ROLE service_role;
    PERFORM pg_temp.recipient_bad(x,request,'P0001','AUTOMATION_STATE_CONFLICT','unknown session status cannot earn credit',2);
    RESET ROLE;
    UPDATE public.class_sessions SET status='completed' WHERE id=(x->>'session')::UUID;
    UPDATE public.attendance SET counts_toward_eligibility=false WHERE id=(x->>'attendance')::UUID;
    SET LOCAL ROLE service_role;
    PERFORM pg_temp.recipient_bad(x,request,'P0001','AUTOMATION_STATE_CONFLICT','noncredit attendance excluded',2);
    RESET ROLE;
    UPDATE public.attendance SET counts_toward_eligibility=true WHERE id=(x->>'attendance')::UUID;
    UPDATE public.belt_test_events SET starts_at=clock_timestamp()-INTERVAL '2 hours',ends_at=clock_timestamp()-INTERVAL '1 hour' WHERE id=e;
    SET LOCAL ROLE service_role;
    PERFORM pg_temp.recipient_check(pg_temp.recipient_approve(x,request,op)=first||'{"replayed":true}','receipt survives event passing');
    PERFORM pg_temp.recipient_bad(x,request,'P0001','AUTOMATION_STATE_CONFLICT','new approval after start rejected',2);
    RESET ROLE;
    DELETE FROM public.student_program_memberships WHERE id=(x->>'membership')::UUID;
    SET LOCAL ROLE service_role;
    PERFORM pg_temp.recipient_check(public.list_belt_test_recipients_v1(s,a,e)#>>'{payload,items,0,student_program_membership_id}'=x->>'membership','deleted membership remains logical snapshot');
    PERFORM pg_temp.recipient_check(pg_temp.recipient_approve(x,request,op)=first||'{"replayed":true}','receipt survives membership deletion');
    RESET ROLE;
    PERFORM pg_temp.recipient_check((SELECT count(*)=2 FROM private.automation_workflow_events WHERE studio_id=s)
        AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY[1,3]) revision WHERE NOT EXISTS(
            SELECT 1 FROM private.automation_workflow_events captured WHERE captured.studio_id=s AND captured.event_type='belt_test.approved'
                AND captured.subject_kind='belt_test' AND captured.subject_id=recipient
                AND captured.source_key=recipient::TEXT||':'||revision::TEXT||':1'
                AND captured.context=jsonb_build_object('event_id',e,'student_id',x->'student','student_program_membership_id',x->'membership',
                    'approved_program_id',x->'program','approved_current_rank_id',x->'rank0','approved_target_rank_id',x->'rank1',
                    'approved_schedule_revision',1,'approval_revision',revision)))
        AND NOT EXISTS(SELECT 1 FROM public.automation_workflow_runs WHERE studio_id=s)
        AND NOT EXISTS(SELECT 1 FROM public.promotions WHERE studio_id=s)
        AND NOT EXISTS(SELECT 1 FROM public.automation_deliveries WHERE studio_id=s),'exact changed approval snapshots without runs promotion or delivery effects');
END $$;
DO $$
DECLARE x JSONB:=pg_temp.recipient_fixture(); s UUID:=(x->>'studio')::UUID; a UUID:=(x->>'actor')::UUID;
    e UUID:=(x->>'event')::UUID; req JSONB; first JSONB; op UUID:=gen_random_uuid(); at TIMESTAMPTZ:=clock_timestamp()-INTERVAL '31 days';
    old_membership UUID:=gen_random_uuid(); promotion UUID:=gen_random_uuid(); other_student UUID:=gen_random_uuid(); other_membership UUID:=gen_random_uuid();
BEGIN
    req:=jsonb_build_array(jsonb_build_object('student_id',x->'student','student_program_membership_id',x->'membership'));
    -- A same-program historical row wins over the older exact-membership row.
    INSERT INTO public.promotions(studio_id,student_id,student_program_membership_id,program_id,from_rank_id,to_rank_id,promoted_by,promoted_at)
        VALUES(s,(x->>'student')::UUID,(x->>'membership')::UUID,(x->>'program')::UUID,NULL,(x->>'rank0')::UUID,a,at-INTERVAL '30 days');
    INSERT INTO public.promotions(id,studio_id,student_id,program_id,from_rank_id,to_rank_id,promoted_by,promoted_at,transition_kind,notes)
        VALUES(promotion,s,(x->>'student')::UUID,(x->>'program')::UUID,(x->>'rank1')::UUID,(x->>'rank0')::UUID,a,at,'demotion','Synthetic');
    UPDATE public.attendance SET checked_in_at=at-INTERVAL '1 microsecond' WHERE id=(x->>'attendance')::UUID;
    SET LOCAL ROLE service_role;
    PERFORM pg_temp.recipient_bad(x,req,'P0001','AUTOMATION_STATE_CONFLICT','latest same-program demotion anchor excludes earlier attendance');
    RESET ROLE;
    UPDATE public.attendance SET checked_in_at=at WHERE id=(x->>'attendance')::UUID;
    UPDATE public.belt_ranks SET min_months=1 WHERE id=(x->>'rank1')::UUID;
    SET LOCAL ROLE service_role;
    first:=pg_temp.recipient_approve(x,req,op);
    PERFORM pg_temp.recipient_check(first#>>'{payload,items,0,approved_target_rank_id}'=x->>'rank1','attendance equals latest anchor and elapsed day threshold');
    RESET ROLE;
    -- A newer exact-membership anchor at 29d23h must fail a 30-day requirement.
    at:=clock_timestamp()-INTERVAL '29 days 23 hours';
    INSERT INTO public.promotions(studio_id,student_id,student_program_membership_id,program_id,from_rank_id,to_rank_id,promoted_by,promoted_at)
        VALUES(s,(x->>'student')::UUID,(x->>'membership')::UUID,(x->>'program')::UUID,NULL,(x->>'rank0')::UUID,a,at);
    UPDATE public.attendance SET checked_in_at=at WHERE id=(x->>'attendance')::UUID;
    SET LOCAL ROLE service_role;
    PERFORM pg_temp.recipient_bad(x,req,'P0001','AUTOMATION_STATE_CONFLICT','completed UTC days rather than calendar dates');
    PERFORM pg_temp.recipient_check(pg_temp.recipient_approve(x,req,op)=first||'{"replayed":true}','original receipt survives changed rank history');
    RESET ROLE;
    -- Mixed valid/held batch must reject all rows, regardless of sorted input order.
    UPDATE public.belt_ranks SET min_classes=0,min_months=0 WHERE id=(x->>'rank1')::UUID;
    INSERT INTO public.students(id,studio_id,legal_first_name,legal_last_name,status,program_id,current_belt_rank_id,hold_start_date)
        VALUES(other_student,s,'Held','Synthetic','active',(x->>'program')::UUID,(x->>'rank0')::UUID,CURRENT_DATE);
    INSERT INTO public.student_program_memberships(id,studio_id,student_id,program_id,status,current_belt_rank_id)
        VALUES(other_membership,s,other_student,(x->>'program')::UUID,'active',(x->>'rank0')::UUID);
    req:=req||jsonb_build_array(jsonb_build_object('student_id',other_student,'student_program_membership_id',other_membership));
    SET LOCAL ROLE service_role;
    PERFORM pg_temp.recipient_bad(x,req,'P0001','AUTOMATION_STATE_CONFLICT','mixed same-studio held batch is all or none');
    RESET ROLE;
    UPDATE public.students SET hold_start_date=NULL WHERE id=other_student;
    SET LOCAL ROLE service_role;
    op:=gen_random_uuid(); first:=pg_temp.recipient_approve(x,req,op);
    PERFORM pg_temp.recipient_check(jsonb_array_length(first#>'{payload,items}')=2,'multi-context approval');
    PERFORM pg_temp.recipient_check(pg_temp.recipient_approve(x,jsonb_build_array(req->1,req->0),op)=first||'{"replayed":true}','batch order normalization replay');
    first:=public.list_belt_test_recipients_v1(s,a,e,1);
    PERFORM pg_temp.recipient_check(first#>>'{payload,has_more}'='true' AND jsonb_array_length(first#>'{payload,items}')=1,'bounded keyset first page');
    first:=public.list_belt_test_recipients_v1(s,a,e,1,first#>'{payload,next_cursor}');
    PERFORM pg_temp.recipient_check(first#>>'{payload,has_more}'='false' AND first#>'{payload,next_cursor}'='null'::JSONB AND jsonb_array_length(first#>'{payload,items}')=1,'keyset last page');
    RESET ROLE;
END $$;
DO $$
DECLARE x JSONB:=pg_temp.recipient_fixture(); req JSONB; first JSONB; op UUID:=gen_random_uuid(); s UUID:=(x->>'studio')::UUID;
BEGIN
    DELETE FROM public.student_program_memberships WHERE id=(x->>'membership')::UUID;
    req:=jsonb_build_array(jsonb_build_object('student_id',x->'student'));
    SET LOCAL ROLE service_role;
    PERFORM pg_temp.recipient_bad(x,req,'P0001','AUTOMATION_STATE_CONFLICT','null legacy cannot enter scoped ladder');
    RESET ROLE;
    UPDATE public.belt_ladders SET program_id=NULL WHERE id=(x->>'ladder')::UUID;
    UPDATE public.belt_test_events SET program_id=NULL WHERE id=(x->>'event')::UUID;
    SET LOCAL ROLE service_role;
    first:=pg_temp.recipient_approve(x,req,op);
    PERFORM pg_temp.recipient_check(first#>'{payload,items,0,student_program_membership_id}'='null'::JSONB,'supported unscoped legacy with retained scalar program');
    PERFORM pg_temp.recipient_check(pg_temp.recipient_approve(x,jsonb_build_array(req->0||'{"student_program_membership_id":null}'),op)=first||'{"replayed":true}','omitted and explicit null normalize identically');
    RESET ROLE;
    UPDATE public.programs SET archived_at=clock_timestamp() WHERE id=(x->>'program')::UUID;
    SET LOCAL ROLE service_role;
    PERFORM pg_temp.recipient_bad(x,req,'P0001','AUTOMATION_STATE_CONFLICT','legacy scalar program remains current');
    RESET ROLE;
    UPDATE public.programs SET archived_at=NULL WHERE id=(x->>'program')::UUID;
    INSERT INTO public.student_program_memberships(studio_id,student_id,program_id,status)
        VALUES(s,(x->>'student')::UUID,(x->>'program')::UUID,'paused');
    SET LOCAL ROLE service_role;
    PERFORM pg_temp.recipient_bad(x,req,'P0001','AUTOMATION_STATE_CONFLICT','paused membership prevents legacy reinterpretation');
    PERFORM pg_temp.recipient_check(pg_temp.recipient_approve(x,req,op)=first||'{"replayed":true}','legacy original receipt survives later membership');
    RESET ROLE;
END $$;
DO $$
DECLARE x JSONB:=pg_temp.recipient_fixture(); result JSONB; expected UUID; next_rank UUID; mode INTEGER;
BEGIN
    UPDATE public.belt_ranks SET min_classes=0,requires_approval=false WHERE ladder_id=(x->>'ladder')::UUID;
    FOR mode IN 1..3 LOOP
        IF mode=1 THEN
            UPDATE public.belt_ranks SET display_order=0 WHERE ladder_id=(x->>'ladder')::UUID;
            UPDATE public.belt_ranks SET created_at=NULL WHERE id=(x->>'rank0')::UUID OR id=(x->>'rank1')::UUID;
        ELSIF mode=2 THEN
            UPDATE public.belt_ranks SET display_order=0,created_at=NULL WHERE ladder_id=(x->>'ladder')::UUID;
        ELSE
            UPDATE public.belt_ranks SET display_order=0,created_at=TIMESTAMPTZ '2020-01-01Z' WHERE ladder_id=(x->>'ladder')::UUID;
        END IF;
        -- Select the first two using the same exact V40 window, then run V40 itself.
        SELECT id INTO expected FROM public.belt_ranks WHERE ladder_id=(x->>'ladder')::UUID ORDER BY display_order,created_at,id LIMIT 1;
        SELECT id INTO next_rank FROM public.belt_ranks WHERE ladder_id=(x->>'ladder')::UUID ORDER BY display_order,created_at,id OFFSET 1 LIMIT 1;
        UPDATE public.student_program_memberships SET current_belt_rank_id=expected WHERE id=(x->>'membership')::UUID;
        UPDATE public.students SET current_belt_rank_id=expected WHERE id=(x->>'student')::UUID;
        SET LOCAL ROLE service_role;
        result:=pg_temp.recipient_approve(x);
        PERFORM pg_temp.recipient_check(result#>>'{payload,items,0,approved_current_rank_id}'=expected::TEXT
            AND result#>>'{payload,items,0,approved_target_rank_id}'=next_rank::TEXT,'V40 null/tie ordering mode '||mode);
        PERFORM public.record_student_rank_transition_v3((x->>'studio')::UUID,(x->>'student')::UUID,(x->>'membership')::UUID,(x->>'program')::UUID,next_rank,(x->>'actor')::UUID,NULL,'promotion',gen_random_uuid());
        RESET ROLE;
    END LOOP;
END $$;
DO $$
DECLARE x JSONB:=pg_temp.recipient_fixture(); s UUID:=(x->>'studio')::UUID;
    result JSONB; req JSONB; program2 UUID:=gen_random_uuid(); membership2 UUID:=gen_random_uuid();
BEGIN
    UPDATE public.belt_ladders SET program_id=NULL WHERE id=(x->>'ladder')::UUID;
    UPDATE public.belt_test_events SET program_id=NULL WHERE id=(x->>'event')::UUID;
    INSERT INTO public.programs(id,studio_id,name) VALUES(program2,s,'Second');
    INSERT INTO public.student_program_memberships(id,studio_id,student_id,program_id,status)
        VALUES(membership2,s,(x->>'student')::UUID,program2,'paused');
    req:=jsonb_build_array(jsonb_build_object('student_id',x->'student','student_program_membership_id',x->'membership'),
        jsonb_build_object('student_id',x->'student','student_program_membership_id',membership2));
    SET LOCAL ROLE service_role;
    result:=pg_temp.recipient_approve(x,req);
    PERFORM pg_temp.recipient_check(jsonb_array_length(result#>'{payload,items}')=2 AND NOT EXISTS(
        SELECT 1 FROM jsonb_array_elements(result#>'{payload,items}') n WHERE n.value ? 'approved_program_id'),'unscoped explicit contexts keep unchanged public DTO');
    PERFORM pg_temp.recipient_check((SELECT count(*)=2 FROM public.belt_test_recipients b JOIN public.student_program_memberships m ON m.id=b.student_program_membership_id
        WHERE b.studio_id=s AND b.approved_program_id=m.program_id),'internal snapshots bind exact selected programs');
    RESET ROLE;
    UPDATE public.programs SET archived_at=clock_timestamp() WHERE id=program2;
    SET LOCAL ROLE service_role;
    PERFORM pg_temp.recipient_bad(x,req,'P0001','AUTOMATION_STATE_CONFLICT','unscoped batch requires every exact selected program current');
    RESET ROLE;
END $$;
DO $$
<<fixture>>
DECLARE x JSONB:=pg_temp.recipient_fixture(); s UUID:=(x->>'studio')::UUID; a UUID:=(x->>'actor')::UUID;
    first JSONB; result JSONB; req JSONB; recipient_id UUID; op UUID:=gen_random_uuid();
BEGIN
    DELETE FROM public.student_program_memberships WHERE id=(x->>'membership')::UUID;
    UPDATE public.belt_ladders SET program_id=NULL WHERE id=(x->>'ladder')::UUID;
    UPDATE public.belt_test_events SET program_id=NULL WHERE id=(x->>'event')::UUID;
    req:=jsonb_build_array(jsonb_build_object('student_id',x->'student'));
    SET LOCAL ROLE service_role;
    first:=pg_temp.recipient_approve(x,req,op); recipient_id:=(first#>>'{payload,items,0,id}')::UUID;
    PERFORM pg_temp.recipient_check((SELECT approved_program_id=(x->>'program')::UUID FROM public.belt_test_recipients b WHERE b.id=recipient_id),'legacy internal program snapshot');
    RESET ROLE;
    DELETE FROM public.programs WHERE programs.id=(x->>'program')::UUID;
    PERFORM pg_temp.recipient_check((SELECT approved_program_id=(x->>'program')::UUID FROM public.belt_test_recipients b WHERE b.id=recipient_id),'program delete cannot null internal snapshot');
    SET LOCAL ROLE service_role;
    result:=pg_temp.recipient_approve(x,req);
    PERFORM pg_temp.recipient_check(result#>>'{payload,items,0,revision}'='2' AND (SELECT approved_program_id IS NULL FROM public.belt_test_recipients b WHERE b.id=recipient_id),
        'explicit reapproval advances revision when only internal context changed');
    PERFORM pg_temp.recipient_check(pg_temp.recipient_approve(x,req,op)=first||'{"replayed":true}','public original snapshot receipt remains immutable');
    PERFORM public.revoke_belt_test_recipient_v1(s,a,(x->>'event')::UUID,recipient_id,gen_random_uuid(),2);
    RESET ROLE;
    PERFORM pg_temp.recipient_error(format('UPDATE public.belt_test_recipients SET approved_program_id=%L,revision=revision+1 WHERE id=%L',gen_random_uuid(),recipient_id),
        'P0001','AUTOMATION_STATE_CONFLICT','revoke cannot rewrite internal program',s);
END $$;
DO $$
DECLARE x JSONB:=pg_temp.recipient_fixture(); studio_day DATE; req JSONB; result JSONB;
BEGIN
    UPDATE public.studios SET timezone='Pacific/Kiritimati' WHERE id=(x->>'studio')::UUID;
    UPDATE public.belt_test_events SET timezone='Pacific/Honolulu' WHERE id=(x->>'event')::UUID;
    studio_day:=(clock_timestamp() AT TIME ZONE 'Pacific/Kiritimati')::DATE;
    UPDATE public.students SET hold_start_date=studio_day-1,hold_end_date=studio_day WHERE id=(x->>'student')::UUID;
    req:=jsonb_build_array(jsonb_build_object('student_id',x->'student','student_program_membership_id',x->'membership'));
    SET LOCAL ROLE service_role;
    PERFORM pg_temp.recipient_bad(x,req,'P0001','AUTOMATION_STATE_CONFLICT','inclusive studio-local hold end ignores event display zone');
    RESET ROLE;
    UPDATE public.students SET hold_start_date=studio_day-2,hold_end_date=studio_day-1 WHERE id=(x->>'student')::UUID;
    SET LOCAL ROLE service_role;
    result:=pg_temp.recipient_approve(x,req);
    PERFORM pg_temp.recipient_check(result#>>'{payload,items,0,state}'='approved','expired studio-local hold permits approval');
    RESET ROLE;
    UPDATE public.studios SET timezone='Not/AZone' WHERE id=(x->>'studio')::UUID;
    UPDATE public.students SET hold_start_date=(clock_timestamp() AT TIME ZONE 'UTC')::DATE,hold_end_date=NULL WHERE id=(x->>'student')::UUID;
    SET LOCAL ROLE service_role;
    PERFORM pg_temp.recipient_bad(x,req,'P0001','AUTOMATION_STATE_CONFLICT','unrecognized studio zone uses UTC hold day');
    RESET ROLE;
END $$;
SELECT count(*)||' belt recipient assertions passed' AS result FROM pg_temp.recipient_checks;
ROLLBACK;
