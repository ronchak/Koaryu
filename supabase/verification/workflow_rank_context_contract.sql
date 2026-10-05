-- Run only on a disposable local database. All source facts are synthetic.
BEGIN;
SET LOCAL statement_timeout='60s';
CREATE TEMP TABLE rank_checks(label TEXT PRIMARY KEY);
CREATE FUNCTION pg_temp.rank_check(ok BOOLEAN,label TEXT) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
    IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'rank context contract failed: %',label; END IF;
    INSERT INTO pg_temp.rank_checks VALUES(label);
END $$;
CREATE FUNCTION pg_temp.rank_error(statement TEXT,code TEXT,message TEXT,label TEXT) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE got_code TEXT; got_message TEXT;
BEGIN
    BEGIN EXECUTE statement;
    EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS got_code=RETURNED_SQLSTATE,got_message=MESSAGE_TEXT;
    END;
    IF got_code IS DISTINCT FROM code OR got_message IS DISTINCT FROM message THEN
        RAISE EXCEPTION 'rank context negative failed %: got % (%), expected % (%)',label,got_code,got_message,code,message;
    END IF;
    PERFORM pg_temp.rank_check(true,label);
END $$;
CREATE FUNCTION pg_temp.rank_fixture(legacy BOOLEAN DEFAULT false) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE a UUID:=gen_random_uuid(); s UUID:=gen_random_uuid(); p UUID:=gen_random_uuid(); p2 UUID:=gen_random_uuid();
    l UUID:=gen_random_uuid(); l2 UUID:=gen_random_uuid(); r0 UUID:=gen_random_uuid(); r1 UUID:=gen_random_uuid(); r2 UUID:=gen_random_uuid();
    q0 UUID:=gen_random_uuid(); q1 UUID:=gen_random_uuid(); student UUID:=gen_random_uuid(); m UUID:=gen_random_uuid(); m2 UUID:=gen_random_uuid(); e UUID:=gen_random_uuid();
BEGIN
    INSERT INTO auth.users(id,email,email_confirmed_at) VALUES(a,a||'@example.invalid',clock_timestamp());
    INSERT INTO public.studios(id,name,slug,owner_id,timezone) VALUES(s,'Rank context',s,a,'UTC');
    INSERT INTO public.staff_roles(studio_id,user_id,role) VALUES(s,a,'admin');
    INSERT INTO public.studio_subscriptions(studio_id,status,comped) VALUES(s,'active',false);
    INSERT INTO public.programs(id,studio_id,name) VALUES(p,s,'First'),(p2,s,'Second');
    INSERT INTO public.programs(studio_id,name,is_system) SELECT s,'Unassigned',true
        WHERE NOT EXISTS(SELECT 1 FROM public.programs WHERE studio_id=s AND is_system AND lower(name)='unassigned');
    INSERT INTO public.belt_ladders(id,studio_id,name,program_id) VALUES(l,s,'First ladder',CASE WHEN legacy THEN NULL ELSE p END),(l2,s,'Second ladder',p2);
    INSERT INTO public.belt_ranks(id,studio_id,ladder_id,name,display_order,min_classes,min_months) VALUES
        (r0,s,l,'First',0,0,0),(r1,s,l,'Next',1,0,0),(r2,s,l,'Last',2,0,0),(q0,s,l2,'Other first',0,0,0),(q1,s,l2,'Other next',1,0,0);
    INSERT INTO public.students(id,studio_id,legal_first_name,legal_last_name,status,program_id,current_belt_rank_id,membership_start_date)
        VALUES(student,s,'Synthetic','Rank','active',p,r0,CURRENT_DATE-120);
    IF NOT legacy THEN
        INSERT INTO public.student_program_memberships(id,studio_id,student_id,program_id,status,started_at,current_belt_rank_id)
            VALUES(m,s,student,p,'active',CURRENT_DATE-120,r0),(m2,s,student,p2,'paused',CURRENT_DATE-90,q1);
    ELSE m:=NULL; m2:=NULL;
    END IF;
    INSERT INTO public.belt_test_events(id,studio_id,name,ladder_id,program_id,starts_at,ends_at,timezone,status)
        VALUES(e,s,'Future test',l,CASE WHEN legacy THEN NULL ELSE p END,clock_timestamp()+INTERVAL '7 days',clock_timestamp()+INTERVAL '7 days 1 hour','UTC','scheduled');
    -- A fixture owns its declared final boundary, including caller IMMEDIATE mode.
    SET CONSTRAINTS private.workflow_rank_deferred IMMEDIATE;
    RETURN jsonb_build_object('actor',a,'studio',s,'program',p,'program2',p2,'ladder',l,'ladder2',l2,
        'rank0',r0,'rank1',r1,'rank2',r2,'other0',q0,'other1',q1,'student',student,'membership',m,'membership2',m2,'event',e);
END $$;
CREATE FUNCTION pg_temp.rank_generation(x JSONB,key TEXT DEFAULT 'membership') RETURNS BIGINT LANGUAGE sql AS $$
    SELECT private.workflow_rank_context_generation_v1((x->>'studio')::UUID,(x->>'student')::UUID,(x->>key)::UUID)
$$;
CREATE FUNCTION pg_temp.rank_transition(x JSONB,target TEXT,kind TEXT DEFAULT 'promotion',operation UUID DEFAULT gen_random_uuid())
RETURNS public.promotions LANGUAGE sql AS $$
    SELECT public.record_student_rank_transition_v3((x->>'studio')::UUID,(x->>'student')::UUID,(x->>'membership')::UUID,
        (x->>'program')::UUID,(x->>target)::UUID,(x->>'actor')::UUID,CASE WHEN kind='demotion' THEN 'Synthetic correction' END,kind,operation)
$$;
CREATE FUNCTION pg_temp.rank_approve(x JSONB,operation UUID DEFAULT gen_random_uuid()) RETURNS JSONB LANGUAGE sql AS $$
    SELECT public.approve_belt_test_recipients_v1((x->>'studio')::UUID,(x->>'actor')::UUID,(x->>'event')::UUID,operation,1,
        jsonb_build_array(jsonb_build_object('student_id',x->'student','student_program_membership_id',x->'membership')))
$$;
CREATE FUNCTION pg_temp.rank_workflow(x JSONB,kind TEXT DEFAULT 'student.promoted') RETURNS UUID LANGUAGE plpgsql AS $$
DECLARE result JSONB; w UUID; graph JSONB;
BEGIN
    graph:=jsonb_build_object('schema_version',1,'nodes',jsonb_build_array(
        jsonb_build_object('id','trigger','type','trigger','config',jsonb_build_object('event_type',kind,'program_id',NULL)),
        '{"id":"end","type":"end","config":{}}'::JSONB),'edges','[{"id":"next","source":"trigger","target":"end","port":"next"}]'::JSONB);
    result:=public.create_automation_workflow_v1((x->>'studio')::UUID,(x->>'actor')::UUID,gen_random_uuid(),'Rank proof','',graph,'{}');
    w:=(result#>>'{payload,id}')::UUID;
    PERFORM public.command_automation_workflow_v1((x->>'studio')::UUID,(x->>'actor')::UUID,w,gen_random_uuid(),1,'publish');
    PERFORM public.command_automation_workflow_v1((x->>'studio')::UUID,(x->>'actor')::UUID,w,gen_random_uuid(),2,'start');
    RETURN w;
END $$;
CREATE FUNCTION pg_temp.rank_facts(s UUID) RETURNS JSONB LANGUAGE sql AS $$
    SELECT jsonb_build_object('authority',(SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY id),'[]') FROM private.workflow_rank_contexts c WHERE studio_id=s),
        'students',(SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY id),'[]') FROM public.students c WHERE studio_id=s),
        'memberships',(SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY id),'[]') FROM public.student_program_memberships c WHERE studio_id=s),
        'promotions',(SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY id),'[]') FROM public.promotions c WHERE studio_id=s),
        'events',(SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY id),'[]') FROM private.automation_workflow_events c WHERE studio_id=s),
        'runs',(SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY id),'[]') FROM public.automation_workflow_runs c WHERE studio_id=s),
        'scopes',(SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY id),'[]') FROM private.workflow_rank_scopes c WHERE studio_id=s),
        'pending',(SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY scope_id),'[]') FROM private.workflow_rank_pending_contexts c WHERE studio_id=s),
        'intents',(SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY id),'[]') FROM private.workflow_rank_pending_events c WHERE studio_id=s))
$$;
GRANT ALL ON pg_temp.rank_checks TO service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO service_role;

DO $$
DECLARE x JSONB:=pg_temp.rank_fixture(); s UUID:=(x->>'studio')::UUID; student UUID:=(x->>'student')::UUID;
    actor UUID:=(x->>'actor')::UUID; p UUID:=(x->>'program')::UUID; p2 UUID:=(x->>'program2')::UUID;
    m UUID:=(x->>'membership')::UUID; first JSONB; second JSONB; receipt_op UUID:=gen_random_uuid();
    promote_op UUID:=gen_random_uuid(); promotion public.promotions; original_event JSONB; prior BIGINT; scope UUID;
BEGIN
    SET LOCAL ROLE service_role;
    PERFORM pg_temp.rank_check(pg_temp.rank_generation(x)=1 AND pg_temp.rank_generation(x,'membership2')=1,'new source INSERT owns explicit baseline one');
    PERFORM pg_temp.rank_workflow(x,'belt_test.approved');
    PERFORM pg_temp.rank_workflow(x);
    first:=pg_temp.rank_approve(x,receipt_op);
    SELECT to_jsonb(e) INTO original_event FROM private.automation_workflow_events e WHERE studio_id=s AND event_type='belt_test.approved';
    PERFORM pg_temp.rank_check((original_event#>>'{context,approved_rank_context_generation}')::BIGINT=1,'approval binds baseline authority');
    PERFORM public.write_student_profile_v2_atomic(student,s,actor,'{"phone":"synthetic"}',ARRAY[p,p2],'[]',true,'student.updated');
    PERFORM pg_temp.rank_check(pg_temp.rank_generation(x)=1 AND pg_temp.rank_generation(x,'membership2')=1,'unchanged wrapper retained ranks do not advance');
    PERFORM public.write_student_profile_v2_atomic(student,s,actor,'{"preferred_name":"Synthetic"}',ARRAY[p2,p],'[]',true,'student.updated');
    PERFORM pg_temp.rank_check(pg_temp.rank_generation(x)=1 AND pg_temp.rank_generation(x,'membership2')=1
        AND (SELECT current_belt_rank_id=(x->>'other1')::UUID FROM public.students WHERE id=student),'primary projection swap preserves independent memberships');
    PERFORM public.mutate_student_program_membership_atomic(student,s,actor,'update',m,'{"status":"paused"}');
    PERFORM pg_temp.rank_check(pg_temp.rank_generation(x)=1,'active to paused preserves supported live context');
    second:=pg_temp.rank_approve(x);
    PERFORM pg_temp.rank_check(second#>>'{payload,items,0,revision}'='1','benign mirrors retain approval no-op');

    promotion:=pg_temp.rank_transition(x,'rank1','promotion',promote_op);
    PERFORM pg_temp.rank_check(pg_temp.rank_generation(x)=2 AND pg_temp.rank_generation(x,'membership2')=1,'genuine promotion advances only selected membership');
    PERFORM pg_temp.rank_check((SELECT context->>'rank_context_generation'='2' FROM private.automation_workflow_events WHERE subject_id=promotion.id),'promotion owns its actual returned generation');
    PERFORM pg_temp.rank_transition(x,'rank1','promotion',promote_op);
    PERFORM pg_temp.rank_check(pg_temp.rank_generation(x)=2,'operation replay advances nothing');
    PERFORM pg_temp.rank_transition(x,'rank0','demotion');
    PERFORM pg_temp.rank_check(pg_temp.rank_generation(x)=3,'same transaction promotion demotion ABA advances twice');
    PERFORM pg_temp.rank_check((SELECT state='cancelled' AND cancel_reason='rank_context_superseded' FROM public.automation_workflow_runs r
        JOIN private.automation_workflow_events e ON e.id=r.event_id WHERE e.subject_id=promotion.id),'old promotion work remains canceled after ABA');
    second:=pg_temp.rank_approve(x);
    PERFORM pg_temp.rank_check(second#>>'{payload,items,0,revision}'='2'
        AND (SELECT approved_rank_context_generation=3 FROM public.belt_test_recipients WHERE id=(second#>>'{payload,items,0,id}')::UUID),'explicit reapproval after ABA captures new generation and revision');
    PERFORM pg_temp.rank_check((SELECT to_jsonb(e)=original_event FROM private.automation_workflow_events e WHERE id=(original_event->>'id')::UUID)
        AND pg_temp.rank_approve(x,receipt_op)=first||'{"replayed":true}','prior approval occurrence and receipt remain immutable');
    PERFORM public.mutate_student_program_membership_atomic(student,s,actor,'update',m,jsonb_build_object('current_belt_rank_id',x->'rank1'));
    PERFORM public.mutate_student_program_membership_atomic(student,s,actor,'update',m,jsonb_build_object('current_belt_rank_id',x->'rank0'));
    PERFORM pg_temp.rank_check(pg_temp.rank_generation(x)=5,'two administrative commands preserve both completed changes');
    PERFORM pg_temp.rank_check((SELECT count(*)=1 FROM private.automation_workflow_events WHERE studio_id=s AND event_type='student.promoted'),'administrative and demotion changes create no congratulations');

    PERFORM public.write_student_profile_atomic(student,s,actor,jsonb_build_object('current_belt_rank_id',x->'rank1'),ARRAY[p,p2],'[]',true,'student.updated');
    PERFORM public.write_student_profile_atomic(student,s,actor,jsonb_build_object('current_belt_rank_id',x->'rank0'),ARRAY[p,p2],'[]',true,'student.updated');
    PERFORM pg_temp.rank_check(pg_temp.rank_generation(x)=7 AND pg_temp.rank_generation(x,'membership2')=1,'two completed profile commands preserve administrative ABA');
    -- The reader must refuse an unfinished recognized source owner.
    PERFORM 1 FROM public.students WHERE id=student FOR UPDATE;
    scope:=private.workflow_rank_scope_enter_v1(s,student,'profile');
    PERFORM pg_temp.rank_error(format('SELECT private.workflow_rank_context_generation_v1(%L,%L,%L)',s,student,m),
        'P0001','AUTOMATION_RANK_CONTEXT_UNAVAILABLE','unfinished owner cannot grant generation');
    PERFORM pg_temp.rank_error('SET CONSTRAINTS private.workflow_rank_deferred IMMEDIATE',
        'P0001','AUTOMATION_RANK_CONTEXT_UNAVAILABLE','forced reconciliation refuses active owner');
    PERFORM private.workflow_rank_scope_finish_v1(scope);
    PERFORM private.workflow_rank_finalize_pending_v1(s);
    PERFORM pg_temp.rank_check(pg_temp.rank_generation(x)=7,'failed forced flush leaves authority unchanged');
    PERFORM pg_temp.rank_check(NOT EXISTS(SELECT 1 FROM private.workflow_rank_scopes WHERE studio_id=s),'successful finalization drains scope ownership');
    RESET ROLE;
END $$;

DO $$
DECLARE x JSONB:=pg_temp.rank_fixture(); s UUID:=(x->>'studio')::UUID; student UUID:=(x->>'student')::UUID;
    actor UUID:=(x->>'actor')::UUID; p UUID:=(x->>'program')::UUID; p2 UUID:=(x->>'program2')::UUID;
    before JSONB; caught BOOLEAN:=false; first BIGINT; second BIGINT;
BEGIN
    SET LOCAL ROLE service_role;
    -- An unknown private call must remain pending until a next command or flush.
    PERFORM private.write_student_profile_atomic(student,s,actor,jsonb_build_object('current_belt_rank_id',x->'rank1'),ARRAY[p,p2],'[]',true,'student.updated');
    PERFORM pg_temp.rank_check((SELECT generation=1 FROM private.workflow_rank_contexts WHERE studio_id=s AND student_program_membership_id=(x->>'membership')::UUID)
        AND EXISTS(SELECT 1 FROM private.workflow_rank_scopes WHERE studio_id=s AND owner='private_profile' AND state='unknown'),'unmarked private tail leaves unknown final boundary');
    -- A separate recognized command compares A -> B before writing B -> A.
    PERFORM public.write_student_profile_atomic(student,s,actor,jsonb_build_object('current_belt_rank_id',x->'rank0'),ARRAY[p,p2],'[]',true,'student.updated');
    PERFORM pg_temp.rank_check(pg_temp.rank_generation(x)=3,'next recognized entry preserves unmarked administrative ABA');
    before:=pg_temp.rank_facts(s);
    BEGIN
        PERFORM pg_temp.rank_transition(x,'rank1');
        RAISE EXCEPTION 'RANK_ROLLBACK_SENTINEL';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM<>'RANK_ROLLBACK_SENTINEL' THEN RAISE; END IF;
        caught:=true;
    END;
    PERFORM pg_temp.rank_check(caught AND pg_temp.rank_facts(s)=before,'subtransaction rollback restores source authority events and pending state');
    SET CONSTRAINTS ALL IMMEDIATE;
    PERFORM public.write_student_profile_atomic(student,s,actor,'{"phone":"later"}',ARRAY[p,p2],'[]',true,'student.updated');
    PERFORM pg_temp.rank_check(pg_temp.rank_generation(x)=3,'caller ALL IMMEDIATE cannot close an intermediate SPI boundary');
    -- Explicit external flush after an unmarked private return declares finality.
    PERFORM private.write_student_profile_atomic(student,s,actor,jsonb_build_object('current_belt_rank_id',x->'rank1'),ARRAY[p,p2],'[]',true,'student.updated');
    SET CONSTRAINTS private.workflow_rank_deferred IMMEDIATE;
    PERFORM pg_temp.rank_check(pg_temp.rank_generation(x)=4 AND NOT EXISTS(SELECT 1 FROM private.workflow_rank_scopes WHERE studio_id=s),'declared external final flush closes unknown scope');
    RESET ROLE;
END $$;

DO $$
DECLARE x JSONB:=pg_temp.rank_fixture(true); s UUID:=(x->>'studio')::UUID; student UUID:=(x->>'student')::UUID;
    p UUID:=(x->>'program')::UUID; rank UUID:=(x->>'rank0')::UUID; membership UUID:=gen_random_uuid(); old_id UUID;
BEGIN
    SELECT id INTO old_id FROM private.workflow_rank_contexts WHERE studio_id=s AND student_id=student AND student_program_membership_id IS NULL;
    SET LOCAL ROLE service_role;
    PERFORM pg_temp.rank_check(pg_temp.rank_generation(x)=1,'legacy has explicit independent baseline');
    INSERT INTO public.student_program_memberships(id,studio_id,student_id,program_id,status,current_belt_rank_id) VALUES(membership,s,student,p,'active',rank);
    SET CONSTRAINTS private.workflow_rank_deferred IMMEDIATE;
    PERFORM pg_temp.rank_check(pg_temp.rank_generation(x)=2,'gaining live membership permanently supersedes legacy');
    RESET ROLE;
    DELETE FROM public.student_program_memberships WHERE id=membership;
    SET CONSTRAINTS private.workflow_rank_deferred IMMEDIATE;
    PERFORM pg_temp.rank_check(pg_temp.rank_generation(x)=3
        AND (SELECT generation=2 AND tombstoned FROM private.workflow_rank_contexts WHERE studio_id=s AND student_program_membership_id=membership),'physical membership removal keeps its tombstone and advances legacy');
    INSERT INTO public.student_program_memberships(id,studio_id,student_id,program_id,status,current_belt_rank_id) VALUES(membership,s,student,p,'active',rank);
    SET CONSTRAINTS private.workflow_rank_deferred IMMEDIATE;
    PERFORM pg_temp.rank_check((SELECT generation=3 AND NOT tombstoned FROM private.workflow_rank_contexts WHERE studio_id=s AND student_program_membership_id=membership),'reusing a membership UUID never resets authority');
    DELETE FROM public.student_program_memberships WHERE id=membership;
    SET CONSTRAINTS private.workflow_rank_deferred IMMEDIATE;
    DELETE FROM public.belt_ranks WHERE id=rank;
    INSERT INTO public.belt_ranks(id,studio_id,ladder_id,name,display_order,min_classes,min_months) VALUES(rank,s,(x->>'ladder')::UUID,'First again',0,0,0);
    UPDATE public.students SET current_belt_rank_id=rank WHERE id=student;
    SET CONSTRAINTS private.workflow_rank_deferred IMMEDIATE;
    PERFORM pg_temp.rank_check(pg_temp.rank_generation(x)=6,'physical rank deletion recreation is sticky despite equal final UUID');
    DELETE FROM public.students WHERE id=student;
    INSERT INTO public.students(id,studio_id,legal_first_name,legal_last_name,status,program_id,current_belt_rank_id)
        VALUES(student,s,'Reused','Student','active',p,rank);
    SET CONSTRAINTS private.workflow_rank_deferred IMMEDIATE;
    PERFORM pg_temp.rank_check(pg_temp.rank_generation(x)=7 AND (SELECT id=old_id FROM private.workflow_rank_contexts
        WHERE studio_id=s AND student_id=student AND student_program_membership_id IS NULL),'same transaction student UUID reuse retains stable authority identity');
END $$;

DO $$
DECLARE x JSONB:=pg_temp.rank_fixture(); s UUID:=(x->>'studio')::UUID; promotion public.promotions; r RECORD;
    i INTEGER:=0; ids UUID[]; before JSONB; result JSONB; desired TEXT; token UUID;
BEGIN
    SET LOCAL ROLE service_role;
    FOR i IN 1..6 LOOP PERFORM pg_temp.rank_workflow(x); END LOOP;
    promotion:=pg_temp.rank_transition(x,'rank1');
    i:=0;
    FOR r IN SELECT id FROM public.automation_workflow_runs WHERE studio_id=s ORDER BY id LOOP
        i:=i+1; desired:=(ARRAY['queued','waiting','claimed','running','sending','unknown'])[i];
        UPDATE public.automation_workflow_runs SET state=desired,reason=CASE WHEN desired IN ('sending','unknown') THEN 'truthful_delivery_reason' END,
            claim_token=CASE WHEN desired IN ('claimed','running','sending','unknown') THEN gen_random_uuid() END,
            lease_expires_at=CASE WHEN desired IN ('claimed','running','sending','unknown') THEN clock_timestamp()+INTERVAL '5 minutes' END WHERE id=r.id;
    END LOOP;
    SELECT jsonb_agg(to_jsonb(saved) ORDER BY saved.id) INTO before FROM public.automation_workflow_runs saved WHERE studio_id=s AND state IN ('sending','unknown');
    SELECT array_agg(id ORDER BY id) INTO ids FROM public.automation_workflow_runs WHERE studio_id=s;
    PERFORM 1 FROM public.automation_workflows WHERE studio_id=s ORDER BY id FOR UPDATE;
    PERFORM 1 FROM public.automation_workflow_runs WHERE studio_id=s ORDER BY id FOR UPDATE;
    result:=private.workflow_cancel_runs_v1(s,ids||ids,clock_timestamp(),'rank_context_superseded');
    PERFORM pg_temp.rank_check(result='{"cancelled_count":4,"intent_count":6}'::JSONB,'fresh cancellation counts distinct pending and retained-truth intents');

    PERFORM pg_temp.rank_transition(x,'rank0','demotion');
    PERFORM pg_temp.rank_check((SELECT count(*)=4 FROM public.automation_workflow_runs WHERE studio_id=s AND state='cancelled'
        AND claim_token IS NULL AND lease_expires_at IS NULL AND reason='rank_context_superseded' AND revision=2),'pending states cancel once and release claim lease');
    PERFORM pg_temp.rank_check(NOT EXISTS(SELECT 1 FROM jsonb_array_elements(before) old JOIN public.automation_workflow_runs current ON current.id=(old->>'id')::UUID
        WHERE current.state<>old->>'state' OR current.reason<>old->>'reason' OR to_jsonb(current.claim_token)<>old->'claim_token'
            OR to_jsonb(current.lease_expires_at)<>old->'lease_expires_at' OR current.cancel_reason IS DISTINCT FROM 'rank_context_superseded'
            OR current.cancel_requested_at IS NULL OR current.revision<>2),'sending unknown retain actual evidence while gaining monotonic intent');
    SELECT array_agg(id ORDER BY id) INTO ids FROM public.automation_workflow_runs WHERE studio_id=s;
    result:=private.workflow_cancel_runs_v1(s,ids||ids,clock_timestamp(),'second_reason');
    PERFORM pg_temp.rank_check(result='{"cancelled_count":0,"intent_count":0}'::JSONB,'duplicate and already-intended cancel counts are idempotent');
    PERFORM pg_temp.rank_error(format('UPDATE public.automation_workflow_runs SET cancel_reason=''different'' WHERE id=%L',ids[1]),
        '22023','AUTOMATION_IMMUTABLE_RECORD','recorded cancellation reason cannot be replaced');
    PERFORM pg_temp.rank_error(format('UPDATE public.automation_workflow_runs SET cancel_reason=NULL,cancel_requested_at=NULL WHERE id=%L',ids[1]),
        '22023','AUTOMATION_IMMUTABLE_RECORD','recorded cancellation intent cannot be removed');
    PERFORM pg_temp.rank_error(format('SELECT private.workflow_cancel_runs_v1(%L,ARRAY[%L]::UUID[],clock_timestamp(),''rank_context_superseded'')',gen_random_uuid(),ids[1]),
        '22023','AUTOMATION_INVALID_REQUEST','foreign run request is rejected without skipping');
    PERFORM pg_temp.rank_error(format('SELECT private.workflow_cancel_runs_v1(%L,ARRAY[]::UUID[],''infinity''::TIMESTAMPTZ,''rank_context_superseded'')',s),
        '22023','AUTOMATION_INVALID_REQUEST','infinite cancellation time rejected');
    PERFORM pg_temp.rank_error(format('SELECT private.workflow_cancel_runs_v1(%L,ARRAY[]::UUID[],clock_timestamp(),''Raw Reason'')',s),
        '22023','AUTOMATION_INVALID_REQUEST','unsafe cancellation code rejected');
    PERFORM pg_temp.rank_transition(x,'rank1');
    PERFORM pg_temp.rank_check(NOT EXISTS(SELECT 1 FROM public.automation_workflow_runs WHERE id=ANY(ids) AND cancel_requested_at IS NULL),'later equal rank never revives intended work');
    RESET ROLE;
END $$;

DO $$
DECLARE x JSONB:=pg_temp.rank_fixture(); y JSONB:=pg_temp.rank_fixture(); s UUID:=(x->>'studio')::UUID; before JSONB; item TEXT;
BEGIN
    SET LOCAL ROLE service_role;
    PERFORM pg_temp.rank_workflow(x);
    PERFORM pg_temp.rank_transition(x,'rank1');
    UPDATE public.automation_workflow_runs SET revision=9223372036854775807 WHERE studio_id=s;
    before:=pg_temp.rank_facts(s);
    PERFORM pg_temp.rank_error(format('SELECT pg_temp.rank_transition(%L,''rank0'',''demotion'')',x),
        'P0001','AUTOMATION_STATE_CONFLICT','run revision overflow aborts source command');
    PERFORM pg_temp.rank_check(pg_temp.rank_facts(s)=before,'overflow rolls back rank event cancellation and queue together');
    RESET ROLE;
    UPDATE private.workflow_rank_contexts SET generation=9223372036854775807 WHERE studio_id=(y->>'studio')::UUID AND student_program_membership_id=(y->>'membership')::UUID;
    before:=pg_temp.rank_facts((y->>'studio')::UUID);
    SET LOCAL ROLE service_role;
    PERFORM pg_temp.rank_error(format('SELECT pg_temp.rank_transition(%L,''rank1'')',y),
        'P0001','AUTOMATION_STATE_CONFLICT','generation overflow aborts source command');
    PERFORM pg_temp.rank_check(pg_temp.rank_facts((y->>'studio')::UUID)=before,'generation overflow preserves complete prior facts');
    RESET ROLE;
    DELETE FROM private.workflow_rank_contexts WHERE studio_id=(y->>'studio')::UUID AND student_program_membership_id=(y->>'membership')::UUID;
    SET LOCAL ROLE service_role;
    PERFORM pg_temp.rank_error(format('SELECT pg_temp.rank_generation(%L)',y),
        'P0001','AUTOMATION_RANK_CONTEXT_UNAVAILABLE','missing authority is unavailable never generation zero');
    PERFORM pg_temp.rank_error(format('SELECT pg_temp.rank_transition(%L,''rank1'')',y),
        'P0001','AUTOMATION_RANK_CONTEXT_UNAVAILABLE','ordinary updates cannot fabricate missing baseline');
    RESET ROLE;
    FOREACH item IN ARRAY ARRAY['workflow_rank_contexts','workflow_rank_scopes','workflow_rank_pending_contexts','workflow_rank_pending_events'] LOOP
        PERFORM pg_temp.rank_check((SELECT relrowsecurity AND relpersistence='p' AND pg_get_userbyid(relowner)='postgres'
            FROM pg_class WHERE oid=('private.'||item)::REGCLASS),'private logged RLS table '||item);
        PERFORM pg_temp.rank_check(NOT has_table_privilege('anon','private.'||item,'SELECT')
            AND NOT has_table_privilege('authenticated','private.'||item,'INSERT'),'no client table privileges '||item);
    END LOOP;
    PERFORM pg_temp.rank_check(NOT has_table_privilege('service_role','private.workflow_rank_contexts','DELETE'),'trusted service cannot erase durable generations');
    PERFORM pg_temp.rank_check(NOT has_table_privilege('service_role','private.workflow_rank_pending_events','UPDATE')
        AND NOT has_table_privilege('service_role','private.workflow_rank_pending_events','DELETE')
        AND NOT has_table_privilege('service_role','private.workflow_rank_pending_contexts','DELETE'),'pending intents and comparison evidence only drain through scope owner');
    FOREACH item IN ARRAY ARRAY['workflow_rank_scope_enter_v1(uuid,uuid,text)','workflow_rank_mark_dirty_v1(uuid,uuid,uuid,boolean)',
        'workflow_rank_compare_pending_v1(uuid,uuid)','workflow_rank_scope_finish_v1(uuid,uuid,jsonb)',
        'workflow_rank_finalize_pending_v1(uuid)','workflow_rank_context_generation_v1(uuid,uuid,uuid)',
        'workflow_finalize_rank_deferred_v1()','workflow_cancel_runs_v1(uuid,uuid[],timestamp with time zone,text)'] LOOP
        PERFORM pg_temp.rank_check((SELECT NOT prosecdef AND proconfig=ARRAY['search_path=""'] AND pg_get_userbyid(proowner)='postgres'
            AND has_function_privilege('service_role',oid,'EXECUTE')=(prorettype<>'trigger'::REGTYPE) AND NOT has_function_privilege('anon',oid,'EXECUTE')
            AND NOT has_function_privilege('authenticated',oid,'EXECUTE') FROM pg_proc WHERE oid=('private.'||item)::REGPROCEDURE),'private fixed helper boundary '||item);
    END LOOP;
    PERFORM pg_temp.rank_check(NOT EXISTS(SELECT 1 FROM private.workflow_rank_scopes)
        AND NOT EXISTS(SELECT 1 FROM private.workflow_rank_pending_contexts) AND NOT EXISTS(SELECT 1 FROM private.workflow_rank_pending_events),'successful commands leave no pending transaction authority');
END $$;

DO $$
DECLARE x JSONB:=pg_temp.rank_fixture(); s UUID:=(x->>'studio')::UUID; targets JSONB; changed UUID; packet JSONB;
BEGIN
    SET LOCAL ROLE service_role;
    PERFORM pg_temp.rank_workflow(x);
    PERFORM pg_temp.rank_transition(x,'rank1');
    PERFORM private.write_student_profile_atomic((x->>'student')::UUID,s,(x->>'actor')::UUID,
        jsonb_build_object('current_belt_rank_id',x->'rank0'),ARRAY[(x->>'program')::UUID,(x->>'program2')::UUID],'[]',true,'student.updated');
    PERFORM private.workflow_rank_compare_pending_v1(s,(x->>'student')::UUID);
    targets:=private.workflow_prepare_capture_v1(s,ARRAY(SELECT id FROM public.automation_workflows WHERE studio_id=s),true);
    FOREACH packet IN ARRAY ARRAY[targets,jsonb_build_object('lock_mode','share','packet',targets),
        jsonb_build_object('lock_mode','update','packet',targets||'{"backend_pid":0}'),
        jsonb_build_object('lock_mode','update','packet',targets||'{"locked_workflow_ids":[]}'),
        jsonb_build_object('lock_mode','update','packet',targets-'locked_workflow_ids')] LOOP
        UPDATE private.workflow_rank_scopes SET capture_targets=packet WHERE studio_id=s;
        PERFORM pg_temp.rank_error(format('SELECT private.workflow_rank_finalize_pending_v1(%L)',s),
            'P0001','AUTOMATION_RANK_CONTEXT_UNAVAILABLE','invalid frozen coordination '||md5(packet::TEXT));
    END LOOP;
    UPDATE private.workflow_rank_scopes SET capture_targets=jsonb_build_object('lock_mode','update','packet',targets) WHERE studio_id=s;
    PERFORM private.workflow_rank_finalize_pending_v1(s);
    PERFORM pg_temp.rank_check(NOT EXISTS(SELECT 1 FROM private.workflow_rank_scopes WHERE studio_id=s)
        AND (SELECT bool_and(cancel_requested_at IS NOT NULL) FROM public.automation_workflow_runs WHERE studio_id=s),'exact frozen UPDATE packet completes after rejected coordination');
    RESET ROLE;
END $$;

DO $$
DECLARE a UUID:=gen_random_uuid(); s UUID:=gen_random_uuid(); p UUID:=gen_random_uuid(); student UUID:=gen_random_uuid();
BEGIN
    -- No staff membership exists, so this is a supported physical studio cascade
    -- rather than a bypass of the retained last-active-admin deletion guard.
    INSERT INTO auth.users(id,email) VALUES(a,a||'@example.invalid');
    INSERT INTO public.studios(id,name,slug,owner_id) VALUES(s,'Studio cascade',s,a);
    INSERT INTO public.programs(id,studio_id,name) VALUES(p,s,'Program');
    INSERT INTO public.students(id,studio_id,legal_first_name,legal_last_name,program_id) VALUES(student,s,'Cascade','Source',p);
    INSERT INTO public.student_program_memberships(studio_id,student_id,program_id,status) VALUES(s,student,p,'active');
    SET CONSTRAINTS private.workflow_rank_deferred IMMEDIATE;
    UPDATE public.students SET phone='pending cascade' WHERE id=student;
    PERFORM pg_temp.rank_check(EXISTS(SELECT 1 FROM private.workflow_rank_scopes WHERE studio_id=s),'studio cascade fixture has real pending callback work');
    DELETE FROM public.studios WHERE id=s;
    SET CONSTRAINTS private.workflow_rank_deferred IMMEDIATE;
    PERFORM pg_temp.rank_check(NOT EXISTS(SELECT 1 FROM private.workflow_rank_contexts WHERE studio_id=s)
        AND NOT EXISTS(SELECT 1 FROM private.workflow_rank_scopes WHERE studio_id=s)
        AND NOT EXISTS(SELECT 1 FROM private.workflow_rank_pending_contexts WHERE studio_id=s)
        AND NOT EXISTS(SELECT 1 FROM private.workflow_rank_pending_events WHERE studio_id=s),'physical studio cascade removes evidence without late callback reinsertion');
END $$;


DO $$
DECLARE x JSONB:=pg_temp.rank_fixture(true); s UUID:=(x->>'studio')::UUID; member UUID:=gen_random_uuid(); before JSONB; saw_flag BOOLEAN:=false;
BEGIN
    SELECT context INTO before FROM private.workflow_rank_contexts WHERE studio_id=s AND student_program_membership_id IS NULL;
    BEGIN
        INSERT INTO public.student_program_memberships(id,studio_id,student_id,program_id,status,current_belt_rank_id)
            VALUES(member,s,(x->>'student')::UUID,(x->>'program')::UUID,'paused',(x->>'rank0')::UUID);
        DELETE FROM public.student_program_memberships WHERE id=member;
        SELECT EXISTS(SELECT 1 FROM private.workflow_rank_pending_contexts WHERE studio_id=s AND legacy_membership_gained) INTO saw_flag;
        RAISE EXCEPTION 'LEGACY_APPEARANCE_ROLLBACK';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM<>'LEGACY_APPEARANCE_ROLLBACK' THEN RAISE; END IF;
    END;
    PERFORM pg_temp.rank_check(saw_flag AND pg_temp.rank_generation(x)=1 AND NOT EXISTS(SELECT 1 FROM private.workflow_rank_scopes WHERE studio_id=s),
        'subtransaction rollback removes sticky legacy appearance evidence');
    INSERT INTO public.student_program_memberships(id,studio_id,student_id,program_id,status,current_belt_rank_id)
        VALUES(member,s,(x->>'student')::UUID,(x->>'program')::UUID,'active',(x->>'rank0')::UUID);
    DELETE FROM public.student_program_memberships WHERE id=member;
    SET CONSTRAINTS private.workflow_rank_deferred IMMEDIATE;
    PERFORM pg_temp.rank_check(pg_temp.rank_generation(x)=2 AND (SELECT context=before FROM private.workflow_rank_contexts
        WHERE studio_id=s AND student_program_membership_id IS NULL),'one deferred add remove cycle permanently supersedes equal legacy tuple');
    PERFORM pg_temp.rank_check(NOT EXISTS(SELECT 1 FROM private.automation_workflow_events WHERE studio_id=s),'legacy membership appearance never creates welcome or promotion');
END $$;


DO $$
DECLARE x JSONB; s UUID; member UUID; before JSONB; original_status TEXT;
BEGIN
    FOREACH original_status IN ARRAY ARRAY['ended','paused'] LOOP
        x:=pg_temp.rank_fixture(true); s:=(x->>'studio')::UUID; member:=gen_random_uuid();
        INSERT INTO public.student_program_memberships(id,studio_id,student_id,program_id,status,ended_at,current_belt_rank_id)
            VALUES(member,s,(x->>'student')::UUID,(x->>'program')::UUID,original_status,CURRENT_DATE,(x->>'rank0')::UUID);
        SET CONSTRAINTS private.workflow_rank_deferred IMMEDIATE;
        SELECT context INTO before FROM private.workflow_rank_contexts WHERE studio_id=s AND student_program_membership_id IS NULL;
        UPDATE public.student_program_memberships SET status='paused',ended_at=NULL WHERE id=member;
        UPDATE public.student_program_memberships SET status=original_status,ended_at=CURRENT_DATE WHERE id=member;
        SET CONSTRAINTS private.workflow_rank_deferred IMMEDIATE;
        PERFORM pg_temp.rank_check(pg_temp.rank_generation(x)=2 AND (SELECT context=before FROM private.workflow_rank_contexts
            WHERE studio_id=s AND student_program_membership_id IS NULL),'deferred existing membership reactivation cycle supersedes legacy '||original_status);
    END LOOP;
END $$;

-- A currently approved target is part of the exact context's authority even
-- when no current student/membership row points at that future rank.
DO $$
DECLARE x JSONB; s UUID; legacy BOOLEAN; first JSONB; second JSONB; original_event JSONB; original_receipt UUID;
    before JSONB; before_context JSONB; recipient UUID; old_run UUID; rolled_back BOOLEAN;
BEGIN
    FOREACH legacy IN ARRAY ARRAY[false,true] LOOP
        x:=pg_temp.rank_fixture(legacy); s:=(x->>'studio')::UUID; original_receipt:=gen_random_uuid();
        SET LOCAL ROLE service_role;
        PERFORM pg_temp.rank_workflow(x,'belt_test.approved');
        first:=pg_temp.rank_approve(x,original_receipt); recipient:=(first#>>'{payload,items,0,id}')::UUID;
        SELECT to_jsonb(e) INTO original_event FROM private.automation_workflow_events e WHERE studio_id=s AND event_type='belt_test.approved';
        SELECT id INTO old_run FROM public.automation_workflow_runs WHERE event_id=(original_event->>'id')::UUID;
        SELECT context INTO before_context FROM private.workflow_rank_contexts WHERE studio_id=s
            AND student_program_membership_id IS NOT DISTINCT FROM (x->>'membership')::UUID;
        before:=pg_temp.rank_facts(s); rolled_back:=false;
        BEGIN
            DELETE FROM public.belt_ranks WHERE id=(x->>'rank1')::UUID;
            INSERT INTO public.belt_ranks(id,studio_id,ladder_id,name,display_order,min_classes,min_months)
                VALUES((x->>'rank1')::UUID,s,(x->>'ladder')::UUID,'Restored target',1,0,0);
            SET CONSTRAINTS private.workflow_rank_deferred IMMEDIATE;
            RAISE EXCEPTION 'APPROVED_TARGET_ROLLBACK';
        EXCEPTION WHEN OTHERS THEN
            IF SQLERRM<>'APPROVED_TARGET_ROLLBACK' THEN RAISE; END IF;
            rolled_back:=true;
        END;
        PERFORM pg_temp.rank_check(rolled_back AND pg_temp.rank_facts(s)=before,'approved target deletion rollback preserves all authority and work '||legacy::TEXT);
        DELETE FROM public.belt_ranks WHERE id=(x->>'rank1')::UUID;
        INSERT INTO public.belt_ranks(id,studio_id,ladder_id,name,display_order,min_classes,min_months)
            VALUES((x->>'rank1')::UUID,s,(x->>'ladder')::UUID,'Restored target',1,0,0);
        SET CONSTRAINTS private.workflow_rank_deferred IMMEDIATE;
        PERFORM pg_temp.rank_check(pg_temp.rank_generation(x)=2 AND (SELECT context=before_context FROM private.workflow_rank_contexts
            WHERE studio_id=s AND student_program_membership_id IS NOT DISTINCT FROM (x->>'membership')::UUID),
            'approved target UUID recreation supersedes unchanged current rank tuple '||legacy::TEXT);
        PERFORM pg_temp.rank_check((SELECT state='cancelled' AND cancel_reason='rank_context_superseded' AND cancel_requested_at IS NOT NULL AND revision=2
            FROM public.automation_workflow_runs WHERE id=old_run),'approved target deletion cancels prior queued work '||legacy::TEXT);
        second:=pg_temp.rank_approve(x);
        PERFORM pg_temp.rank_check(second#>>'{payload,items,0,revision}'='2' AND second#>>'{payload,items,0,approved_target_rank_id}'=x->>'rank1'
            AND (SELECT approved_rank_context_generation=2 FROM public.belt_test_recipients WHERE id=recipient),
            'same target explicit reapproval records new generation and revision '||legacy::TEXT);
        PERFORM pg_temp.rank_check((SELECT to_jsonb(e)=original_event FROM private.automation_workflow_events e WHERE id=(original_event->>'id')::UUID)
            AND pg_temp.rank_approve(x,original_receipt)=first||'{"replayed":true}',
            'target recreation preserves immutable old approval event and receipt '||legacy::TEXT);
        PERFORM pg_temp.rank_check(pg_temp.rank_approve(x)#>>'{payload,items,0,revision}'='2'
            AND (SELECT count(*)=2 FROM private.automation_workflow_events WHERE studio_id=s AND event_type='belt_test.approved'),
            'new generation identical approval remains a no-op '||legacy::TEXT);
        IF NOT legacy THEN
            PERFORM pg_temp.rank_check(pg_temp.rank_generation(x,'membership2')=1,'target deletion preserves unrelated membership authority');
        END IF;
        RESET ROLE;
    END LOOP;
END $$;

DO $$
DECLARE x JSONB; s UUID; legacy BOOLEAN; mode TEXT; result JSONB; before JSONB; after JSONB; generation BIGINT;
BEGIN
    FOREACH legacy IN ARRAY ARRAY[false,true] LOOP
        FOREACH mode IN ARRAY ARRAY['revoked','stale'] LOOP
            x:=pg_temp.rank_fixture(legacy); s:=(x->>'studio')::UUID;
            SET LOCAL ROLE service_role;
            PERFORM pg_temp.rank_workflow(x,'belt_test.approved');
            result:=pg_temp.rank_approve(x);
            IF mode='revoked' THEN
                PERFORM public.revoke_belt_test_recipient_v1(s,(x->>'actor')::UUID,(x->>'event')::UUID,
                    (result#>>'{payload,items,0,id}')::UUID,gen_random_uuid(),1);
            ELSE
                PERFORM pg_temp.rank_transition(x,'rank1');
                PERFORM pg_temp.rank_transition(x,'rank0','demotion');
            END IF;
            generation:=pg_temp.rank_generation(x); before:=pg_temp.rank_facts(s);
            DELETE FROM public.belt_ranks WHERE id=(x->>'rank1')::UUID;
            INSERT INTO public.belt_ranks(id,studio_id,ladder_id,name,display_order,min_classes,min_months)
                VALUES((x->>'rank1')::UUID,s,(x->>'ladder')::UUID,'Restored target',1,0,0);
            SET CONSTRAINTS private.workflow_rank_deferred IMMEDIATE;
            after:=pg_temp.rank_facts(s);
            PERFORM pg_temp.rank_check(pg_temp.rank_generation(x)=generation,
                'target deletion excludes historical approval generation '||mode||' legacy '||legacy::TEXT);
            PERFORM pg_temp.rank_check(after-'promotions'=before-'promotions',
                'historical approval target deletion preserves authority events runs and pending facts '||mode||' legacy '||legacy::TEXT);
            -- Existing nullable rank FKs still clear on historical transitions.
            -- Their original command/snapshot fields and every other fact remain.
            PERFORM pg_temp.rank_check((SELECT jsonb_agg(value->'id' ORDER BY value->>'id') FROM jsonb_array_elements(before->'promotions'))
                IS NOT DISTINCT FROM (SELECT jsonb_agg(value->'id' ORDER BY value->>'id') FROM jsonb_array_elements(after->'promotions'))
                AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(before->'promotions') old
                    JOIN jsonb_array_elements(after->'promotions') new ON new->'id'=old->'id'
                    WHERE new-'from_rank_id'-'to_rank_id' IS DISTINCT FROM old-'from_rank_id'-'to_rank_id'
                        OR new->'from_rank_id' IS DISTINCT FROM CASE WHEN old->'from_rank_id'=x->'rank1' THEN 'null'::JSONB ELSE old->'from_rank_id' END
                        OR new->'to_rank_id' IS DISTINCT FROM CASE WHEN old->'to_rank_id'=x->'rank1' THEN 'null'::JSONB ELSE old->'to_rank_id' END),
                'target deletion retains exact historical promotion FK semantics '||mode||' legacy '||legacy::TEXT);
            RESET ROLE;
        END LOOP;
    END LOOP;
END $$;

DO $$
DECLARE x JSONB:=pg_temp.rank_fixture(); s UUID:=(x->>'studio')::UUID; other_event UUID:=gen_random_uuid(); before JSONB;
BEGIN
    SET LOCAL ROLE service_role;
    PERFORM public.mutate_student_program_membership_atomic((x->>'student')::UUID,s,(x->>'actor')::UUID,'update',
        (x->>'membership2')::UUID,jsonb_build_object('current_belt_rank_id',x->'other0'));
    INSERT INTO public.belt_test_events(id,studio_id,name,ladder_id,program_id,starts_at,ends_at,timezone,status)
        VALUES(other_event,s,'Independent test',(x->>'ladder2')::UUID,(x->>'program2')::UUID,
            clock_timestamp()+INTERVAL '7 days',clock_timestamp()+INTERVAL '7 days 1 hour','UTC','scheduled');
    PERFORM pg_temp.rank_workflow(x,'belt_test.approved');
    PERFORM pg_temp.rank_approve(x||jsonb_build_object('event',other_event,'membership',x->'membership2'));
    before:=pg_temp.rank_facts(s);
    DELETE FROM public.belt_ranks WHERE id=(x->>'rank1')::UUID;
    INSERT INTO public.belt_ranks(id,studio_id,ladder_id,name,display_order,min_classes,min_months)
        VALUES((x->>'rank1')::UUID,s,(x->>'ladder')::UUID,'Restored target',1,0,0);
    SET CONSTRAINTS private.workflow_rank_deferred IMMEDIATE;
    PERFORM pg_temp.rank_check(pg_temp.rank_generation(x)=1 AND pg_temp.rank_generation(x,'membership2')=2
        AND pg_temp.rank_facts(s)=before AND (SELECT state='queued' AND cancel_requested_at IS NULL FROM public.automation_workflow_runs WHERE studio_id=s),
        'target deletion preserves a current unrelated same-studio approval and queued work');
    RESET ROLE;
END $$;

SELECT count(*)||' rank context assertions passed' AS result FROM pg_temp.rank_checks;
ROLLBACK;
