-- Every fixture and injected failure is confined to this rollback transaction.
BEGIN;
CREATE FUNCTION pg_temp.fail_lead_command() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION USING ERRCODE = 'P0099', MESSAGE = 'injected lead command failure';
END;
$$;
DO $test$
DECLARE
    actor UUID := gen_random_uuid();
    other_actor UUID := gen_random_uuid();
    instructor UUID := gen_random_uuid();
    front_desk UUID := gen_random_uuid();
    studio UUID := gen_random_uuid();
    other_studio UUID := gen_random_uuid();
    program UUID := gen_random_uuid();
    foreign_program UUID := gen_random_uuid();
    inactive_program UUID := gen_random_uuid();
    lead UUID := gen_random_uuid();
    second_lead UUID := gen_random_uuid();
    operation UUID := gen_random_uuid();
    conversion_operation UUID := gen_random_uuid();
    conversion_result JSONB;
    result public.leads;
    original_result JSONB;
    before_row JSONB;
    before_counts JSONB;
    after_counts JSONB;
    target TEXT;
    failed BOOLEAN;
    invalid_patch JSONB;
    signature TEXT;
BEGIN
    FOREACH signature IN ARRAY ARRAY['public.update_lead_atomic(uuid,uuid,uuid,jsonb)',
        'public.follow_up_lead_atomic(uuid,uuid,uuid,uuid,jsonb)'] LOOP
        IF to_regprocedure(signature) IS NULL THEN
            RAISE EXCEPTION 'Missing lead command %', signature;
        END IF;
        IF NOT has_function_privilege('service_role',signature,'EXECUTE')
           OR has_function_privilege('anon',signature,'EXECUTE')
           OR has_function_privilege('authenticated',signature,'EXECUTE') THEN
            RAISE EXCEPTION 'Lead commands must be service-only: %',signature;
        END IF;
    END LOOP;
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.lead_follow_up_operations'::regclass)
       OR has_table_privilege('authenticated','public.lead_follow_up_operations','SELECT')
       OR has_table_privilege('anon','public.lead_follow_up_operations','SELECT') THEN
        RAISE EXCEPTION 'Lead receipts require service-only access and RLS';
    END IF;
    INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    SELECT id,'authenticated','authenticated',id::text || '@example.invalid','{}','{}',now(),now()
    FROM unnest(ARRAY[actor,other_actor,instructor,front_desk]) id;
    INSERT INTO public.studios(id,name,slug,owner_id) VALUES
        (studio,'Lead commands',studio::text,actor),(other_studio,'Other',other_studio::text,other_actor);
    INSERT INTO public.staff_roles(studio_id,user_id,role) VALUES (studio,instructor,'instructor'),(studio,front_desk,'front_desk'),(studio,actor,'admin'),(other_studio,other_actor,'admin');
    INSERT INTO public.programs(id,studio_id,name,archived_at) VALUES
        (program,studio,'Program',NULL),(foreign_program,other_studio,'Foreign',NULL),
        (inactive_program,studio,'Inactive',now());
    INSERT INTO public.leads(id,studio_id,first_name,last_name,program_id,follow_up_date,is_minor,guardian_name)
    VALUES (lead,studio,'Lead','One',program,CURRENT_DATE,TRUE,'Parent One'),
        (second_lead,studio,'Lead','Two',NULL,CURRENT_DATE,FALSE,NULL);

    -- Omission preserves fields; explicit null clears only the supplied field.
    SELECT * INTO result FROM public.update_lead_atomic(studio,actor,lead,'{"notes":"kept","phone":"555"}');
    SELECT * INTO result FROM public.update_lead_atomic(studio,actor,lead,'{"phone":null,"stage":"inquiry"}');
    IF result.notes IS DISTINCT FROM 'kept' OR result.phone IS NOT NULL
       OR EXISTS(SELECT 1 FROM public.lead_activities WHERE lead_id=lead) THEN
        RAISE EXCEPTION 'PATCH omission/null/no-op stage semantics changed';
    END IF;
    SELECT * INTO result FROM public.update_lead_atomic(studio,actor,lead,'{"stage":"trial_scheduled"}');
    IF NOT EXISTS(SELECT 1 FROM public.lead_activities WHERE lead_id=lead
        AND description='Stage changed from inquiry to trial_scheduled') THEN
        RAISE EXCEPTION 'Transition history must name locked prior stage';
    END IF;
    FOREACH invalid_patch IN ARRAY ARRAY['{"stage":"enrolled"}'::jsonb,'{"converted_student_id":null}',
        '{"studio_id":null}','{}','[]'] LOOP
        failed := FALSE;
        BEGIN
            PERFORM public.update_lead_atomic(studio,actor,lead,invalid_patch);
        EXCEPTION WHEN SQLSTATE '22023' THEN failed := TRUE;
        END;
        IF NOT failed THEN RAISE EXCEPTION 'Invalid PATCH accepted: %',invalid_patch; END IF;
    END LOOP;
    FOREACH invalid_patch IN ARRAY ARRAY[jsonb_build_object('program_id',foreign_program),
        jsonb_build_object('assigned_staff_id',other_actor)] LOOP
        failed := FALSE;
        BEGIN
            PERFORM public.update_lead_atomic(studio,actor,lead,invalid_patch);
        EXCEPTION WHEN SQLSTATE 'P0002' THEN failed := TRUE;
        END;
        IF NOT failed THEN RAISE EXCEPTION 'Foreign/inactive relation accepted'; END IF;
    END LOOP;
    failed := FALSE;
    BEGIN
        PERFORM public.update_lead_atomic(studio,actor,lead,jsonb_build_object('program_id',inactive_program));
    EXCEPTION WHEN SQLSTATE 'P0001' THEN
        IF SQLERRM <> 'PROGRAM_INACTIVE' THEN RAISE; END IF;
        failed := TRUE;
    END;
    IF NOT failed THEN RAISE EXCEPTION 'Archived program must retain PROGRAM_INACTIVE conflict'; END IF;
    UPDATE public.programs SET archived_at=now() WHERE id=program;
    failed := FALSE;
    BEGIN
        PERFORM public.follow_up_lead_atomic(studio,actor,lead,gen_random_uuid(),'{"next_stage":"enrolled"}');
    EXCEPTION WHEN SQLSTATE 'P0001' THEN
        IF SQLERRM <> 'PROGRAM_INACTIVE' THEN RAISE; END IF;
        failed := TRUE;
    END;
    IF NOT failed OR EXISTS(SELECT 1 FROM public.lead_follow_up_operations WHERE lead_id=lead)
       OR EXISTS(SELECT 1 FROM public.lead_activities WHERE lead_id=lead AND activity_type='follow_up') THEN
        RAISE EXCEPTION 'Archived conversion must retain conflict and roll back contact';
    END IF;
    UPDATE public.programs SET archived_at=NULL WHERE id=program;

    failed := FALSE;
    BEGIN
        PERFORM public.update_lead_atomic(studio,instructor,lead,'{"notes":"forbidden"}');
    EXCEPTION WHEN insufficient_privilege THEN failed := TRUE;
    END;
    IF NOT failed THEN RAISE EXCEPTION 'Instructor PATCH accepted'; END IF;
    failed := FALSE;
    BEGIN
        PERFORM public.follow_up_lead_atomic(studio,instructor,lead,gen_random_uuid(),'{"next_stage":"enrolled"}');
    EXCEPTION WHEN insufficient_privilege THEN failed := TRUE;
    END;
    IF NOT failed THEN RAISE EXCEPTION 'Instructor conversion accepted'; END IF;
    failed := FALSE;
    BEGIN
        PERFORM public.update_lead_atomic(other_studio,other_actor,lead,'{"notes":"foreign"}');
    EXCEPTION WHEN SQLSTATE 'P0002' THEN failed := TRUE;
    END;
    IF NOT failed THEN RAISE EXCEPTION 'Foreign lead accepted'; END IF;

    -- Each failure must undo the entire command, including nested conversion.
    FOREACH target IN ARRAY ARRAY['leads','lead_activities','lead_follow_up_operations'] LOOP
        SELECT to_jsonb(l) INTO before_row FROM public.leads l WHERE id=lead;
        SELECT jsonb_build_array((SELECT count(*) FROM public.lead_activities),
            (SELECT count(*) FROM public.students),(SELECT count(*) FROM public.student_program_memberships),
            (SELECT count(*) FROM public.guardians),(SELECT count(*) FROM public.student_guardians),
            (SELECT count(*) FROM public.audit_logs),(SELECT count(*) FROM public.lead_follow_up_operations)) INTO before_counts;
        EXECUTE format('CREATE TRIGGER inject_lead_command_failure BEFORE INSERT OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION pg_temp.fail_lead_command()',target);
        failed := FALSE;
        BEGIN
            PERFORM public.follow_up_lead_atomic(studio,actor,lead,gen_random_uuid(),'{"next_stage":"enrolled"}');
        EXCEPTION WHEN SQLSTATE 'P0099' THEN failed := TRUE;
        END;
        EXECUTE format('DROP TRIGGER inject_lead_command_failure ON public.%I',target);
        SELECT jsonb_build_array((SELECT count(*) FROM public.lead_activities),
            (SELECT count(*) FROM public.students),(SELECT count(*) FROM public.student_program_memberships),
            (SELECT count(*) FROM public.guardians),(SELECT count(*) FROM public.student_guardians),
            (SELECT count(*) FROM public.audit_logs),(SELECT count(*) FROM public.lead_follow_up_operations)) INTO after_counts;
        IF NOT failed OR before_counts IS DISTINCT FROM after_counts
           OR before_row IS DISTINCT FROM (SELECT to_jsonb(l) FROM public.leads l WHERE id=lead) THEN
            RAISE EXCEPTION 'Follow-up did not fully roll back injected % failure',target;
        END IF;
        IF target <> 'lead_follow_up_operations' THEN
            EXECUTE format('CREATE TRIGGER inject_lead_command_failure BEFORE INSERT OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION pg_temp.fail_lead_command()',target);
            failed := FALSE;
            BEGIN
                PERFORM public.update_lead_atomic(studio,actor,lead,'{"stage":"offer_sent"}');
            EXCEPTION WHEN SQLSTATE 'P0099' THEN failed := TRUE;
            END;
            EXECUTE format('DROP TRIGGER inject_lead_command_failure ON public.%I',target);
            IF NOT failed OR before_row IS DISTINCT FROM (SELECT to_jsonb(l) FROM public.leads l WHERE id=lead)
               OR (before_counts->>0)::bigint <> (SELECT count(*) FROM public.lead_activities) THEN
                RAISE EXCEPTION 'PATCH did not fully roll back injected % failure',target;
            END IF;
        END IF;
    END LOOP;
    SELECT * INTO result FROM public.follow_up_lead_atomic(studio,actor,lead,operation,'{"next_stage":"offer_sent"}');
    original_result := to_jsonb(result);
    PERFORM public.update_lead_atomic(studio,actor,lead,'{"notes":"later edit"}');
    SELECT * INTO result FROM public.follow_up_lead_atomic(studio,actor,lead,operation,'{"next_stage":"offer_sent"}');
    IF to_jsonb(result) IS DISTINCT FROM original_result OR result.follow_up_date IS NOT NULL
       OR (SELECT count(*) FROM public.lead_activities WHERE lead_id=lead AND activity_type='follow_up') <> 1
       OR (SELECT count(*) FROM public.lead_follow_up_operations WHERE lead_id=lead) <> 1 THEN
        RAISE EXCEPTION 'Same-key retry did not replay original result exactly once';
    END IF;
    failed := FALSE;
    BEGIN
        PERFORM public.follow_up_lead_atomic(studio,actor,lead,operation,'{"next_stage":"trial_completed"}');
    EXCEPTION WHEN unique_violation THEN failed := TRUE;
    END;
    IF NOT failed THEN RAISE EXCEPTION 'Changed request accepted for same operation'; END IF;
    failed := FALSE;
    BEGIN
        PERFORM public.follow_up_lead_atomic(studio,actor,second_lead,operation,'{"next_stage":"offer_sent"}');
    EXCEPTION WHEN unique_violation THEN failed := TRUE;
    END;
    IF NOT failed THEN RAISE EXCEPTION 'Changed lead accepted for same operation'; END IF;
    failed := FALSE;
    BEGIN
        PERFORM public.follow_up_lead_atomic(studio,front_desk,lead,operation,'{"next_stage":"offer_sent"}');
    EXCEPTION WHEN unique_violation THEN failed := TRUE;
    END;
    IF NOT failed THEN RAISE EXCEPTION 'Changed actor disclosed receipt'; END IF;
    failed := FALSE;
    BEGIN
        PERFORM public.follow_up_lead_atomic(other_studio,other_actor,lead,operation,'{"next_stage":"offer_sent"}');
    EXCEPTION WHEN unique_violation THEN failed := TRUE;
    END;
    IF NOT failed THEN RAISE EXCEPTION 'Changed actor/tenant disclosed receipt'; END IF;
    SELECT * INTO result FROM public.follow_up_lead_atomic(studio,actor,lead,conversion_operation,'{"next_stage":"enrolled"}');
    conversion_result := to_jsonb(result);
    IF result.stage IS DISTINCT FROM 'enrolled' OR result.converted_student_id IS NULL
       OR (SELECT count(*) FROM public.students WHERE id=result.converted_student_id) <> 1
       OR (SELECT count(*) FROM public.student_program_memberships WHERE student_id=result.converted_student_id) <> 1
       OR (SELECT count(*) FROM public.student_guardians WHERE student_id=result.converted_student_id) <> 1
       OR (SELECT count(*) FROM public.audit_logs WHERE entity_id=lead AND action='lead.converted') <> 1 THEN
        RAISE EXCEPTION 'Nested conversion effects incomplete';
    END IF;
    SELECT * INTO result FROM public.follow_up_lead_atomic(studio,actor,second_lead,gen_random_uuid(),'{"next_stage":null}');
    IF result.stage IS DISTINCT FROM 'inquiry' OR result.follow_up_date IS NOT NULL THEN
        RAISE EXCEPTION 'Contact-only command changed stage or retained follow-up';
    END IF;
    -- New contacts remain distinct; an omitted target canonicalizes to null.
    operation := gen_random_uuid();
    PERFORM public.follow_up_lead_atomic(studio,front_desk,second_lead,operation,'{}');
    PERFORM public.follow_up_lead_atomic(studio,front_desk,second_lead,operation,'{"next_stage":null}');
    IF (SELECT count(*) FROM public.lead_activities WHERE lead_id=second_lead AND activity_type='follow_up') <> 2 THEN
        RAISE EXCEPTION 'Distinct contact identity or omitted-target replay changed';
    END IF;
    UPDATE public.staff_roles SET archived_at=now() WHERE user_id=front_desk AND studio_id=studio;
    failed := FALSE;
    BEGIN
        PERFORM public.follow_up_lead_atomic(studio,front_desk,second_lead,operation,'{}');
    EXCEPTION WHEN insufficient_privilege THEN failed := TRUE;
    END;
    IF NOT failed THEN RAISE EXCEPTION 'Archived actor replay disclosed receipt'; END IF;
    -- No-program conversion retains Unassigned creation and the studio date default.
    UPDATE public.studios SET timezone='Pacific/Kiritimati' WHERE id=studio;
    SELECT * INTO result FROM public.follow_up_lead_atomic(studio,actor,second_lead,gen_random_uuid(),'{"next_stage":"enrolled"}');
    IF NOT EXISTS(SELECT 1 FROM public.students s JOIN public.programs p ON p.id=s.program_id
        WHERE s.id=result.converted_student_id AND p.studio_id=studio AND p.name='Unassigned'
        AND p.is_system AND s.membership_start_date=(CURRENT_TIMESTAMP AT TIME ZONE 'Pacific/Kiritimati')::date) THEN
        RAISE EXCEPTION 'Default program/date conversion semantics changed';
    END IF;

    -- Ordinary backward edits stay allowed after conversion. Completed-key replay
    -- returns its original result; a new enrollment intent restores the same student.
    PERFORM public.update_lead_atomic(studio,actor,lead,'{"stage":"offer_sent","follow_up_date":"2030-01-01"}');
    SELECT to_jsonb(l) INTO before_row FROM public.leads l WHERE id=lead;
    SELECT jsonb_build_array((SELECT count(*) FROM public.lead_activities),
        (SELECT count(*) FROM public.lead_follow_up_operations),
        (SELECT count(*) FROM public.students),(SELECT count(*) FROM public.student_program_memberships),
        (SELECT count(*) FROM public.guardians),(SELECT count(*) FROM public.student_guardians),
        (SELECT count(*) FROM public.audit_logs)) INTO before_counts;
    SELECT * INTO result FROM public.follow_up_lead_atomic(studio,actor,lead,conversion_operation,'{"next_stage":"enrolled"}');
    IF to_jsonb(result) IS DISTINCT FROM conversion_result
       OR before_row IS DISTINCT FROM (SELECT to_jsonb(l) FROM public.leads l WHERE id=lead) THEN
        RAISE EXCEPTION 'Converted-key replay must precede current-stage rejection';
    END IF;
    -- Restoration succeeds even when the original program is now archived.
    UPDATE public.programs SET archived_at=now() WHERE id=(before_row->>'program_id')::uuid;
    operation := gen_random_uuid();
    SELECT * INTO result FROM public.follow_up_lead_atomic(studio,actor,lead,operation,'{"next_stage":"enrolled"}');
    IF result.stage IS DISTINCT FROM 'enrolled' OR result.follow_up_date IS NOT NULL
       OR result.converted_student_id IS DISTINCT FROM (conversion_result->>'converted_student_id')::uuid
       OR (SELECT count(*) FROM public.lead_activities) <> (before_counts->>0)::integer+2
       OR (SELECT count(*) FROM public.lead_follow_up_operations) <> (before_counts->>1)::integer+1 THEN
        RAISE EXCEPTION 'New enrollment intent did not restore converted lead exactly once';
    END IF;
    before_row := to_jsonb(result);
    PERFORM public.follow_up_lead_atomic(studio,actor,lead,operation,'{"next_stage":"enrolled"}');
    IF before_row IS DISTINCT FROM (SELECT to_jsonb(l) FROM public.leads l WHERE id=lead)
       OR (SELECT count(*) FROM public.lead_activities) <> (before_counts->>0)::integer+2
       OR (SELECT count(*) FROM public.lead_follow_up_operations) <> (before_counts->>1)::integer+1 THEN
        RAISE EXCEPTION 'Restoration receipt retry duplicated history or effects';
    END IF;
    -- Null interest also bypasses default-program creation on restoration.
    PERFORM public.update_lead_atomic(studio,actor,lead,'{"stage":"offer_sent","program_id":null,"follow_up_date":"2030-02-01"}');
    SELECT * INTO result FROM public.follow_up_lead_atomic(studio,actor,lead,gen_random_uuid(),'{"next_stage":"enrolled"}');
    IF result.stage IS DISTINCT FROM 'enrolled' OR result.follow_up_date IS NOT NULL OR result.program_id IS NOT NULL
       OR result.converted_student_id IS DISTINCT FROM (conversion_result->>'converted_student_id')::uuid
       OR (SELECT count(*) FROM public.students) <> (before_counts->>2)::integer
       OR (SELECT count(*) FROM public.student_program_memberships) <> (before_counts->>3)::integer
       OR (SELECT count(*) FROM public.guardians) <> (before_counts->>4)::integer
       OR (SELECT count(*) FROM public.student_guardians) <> (before_counts->>5)::integer
       OR (SELECT count(*) FROM public.audit_logs) <> (before_counts->>6)::integer THEN
        RAISE EXCEPTION 'Restoration duplicated a conversion effect';
    END IF;
END;
$test$;

-- Explicit minor knowledge and permanent conversion identity must survive both
-- restoration entry points, including retries and tenant lookup failures.
DO $combined$
DECLARE
    actor UUID := gen_random_uuid();
    other_actor UUID := gen_random_uuid();
    studio UUID := gen_random_uuid();
    other_studio UUID := gen_random_uuid();
    program UUID := gen_random_uuid();
    lead UUID := gen_random_uuid();
    student UUID := gen_random_uuid();
    guardian UUID := gen_random_uuid();
    link UUID := gen_random_uuid();
    operation UUID := gen_random_uuid();
    result public.leads;
    retained JSONB;
    current_facts JSONB;
    before_tenant_failure JSONB;
    stages INTEGER;
    entry_point TEXT;
    failed BOOLEAN;
BEGIN
    INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    SELECT id,'authenticated','authenticated',id::text || '@example.invalid','{}','{}',now(),now()
    FROM unnest(ARRAY[actor,other_actor]) id;
    INSERT INTO public.studios(id,name,slug,owner_id) VALUES
        (studio,'Combined conversion',studio::text,actor),
        (other_studio,'Other combined',other_studio::text,other_actor);
    INSERT INTO public.staff_roles(studio_id,user_id,role) VALUES
        (studio,actor,'admin'),(other_studio,other_actor,'admin');
    INSERT INTO public.programs(id,studio_id,name) VALUES (program,studio,'Combined program');
    INSERT INTO public.leads(id,studio_id,first_name,last_name,stage,program_id,is_minor,guardian_name,follow_up_date)
    VALUES (lead,studio,'Explicit','Minor','offer_sent',program,TRUE,'Existing Parent',DATE '2030-01-01');
    SELECT * INTO result FROM public.convert_lead_to_student_atomic(
        studio,actor,lead,student,program,'active',CURRENT_DATE,guardian,link);
    IF result.converted_student_id IS DISTINCT FROM student OR result.stage IS DISTINCT FROM 'enrolled'
       OR result.follow_up_date IS NOT NULL
       OR NOT EXISTS(SELECT 1 FROM public.students WHERE id=student AND is_minor IS TRUE AND date_of_birth IS NULL)
       OR (SELECT count(*) FROM public.students WHERE studio_id=studio) <> 1
       OR (SELECT count(*) FROM public.student_program_memberships WHERE student_id=student) <> 1
       OR (SELECT count(*) FROM public.guardians WHERE studio_id=studio) <> 1
       OR (SELECT count(*) FROM public.student_guardians WHERE student_id=student) <> 1
       OR (SELECT count(*) FROM public.audit_logs WHERE entity_id=lead AND action='lead.converted') <> 1 THEN
        RAISE EXCEPTION 'Combined conversion lost explicit minority or duplicated conversion facts';
    END IF;
    SELECT jsonb_build_array(
        (SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM public.students s WHERE studio_id=studio),
        (SELECT jsonb_agg(to_jsonb(m) ORDER BY id) FROM public.student_program_memberships m WHERE studio_id=studio),
        (SELECT jsonb_agg(to_jsonb(g) ORDER BY id) FROM public.guardians g WHERE studio_id=studio),
        (SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM public.student_guardians l WHERE student_id=student),
        (SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM public.audit_logs a WHERE studio_id=studio)
    ) INTO retained;
    FOREACH entry_point IN ARRAY ARRAY['convert','follow-up'] LOOP
        SELECT count(*) INTO stages FROM public.lead_activities WHERE lead_id=lead AND activity_type='stage_change';
        PERFORM public.update_lead_atomic(studio,actor,lead,
            '{"stage":"offer_sent","program_id":null,"follow_up_date":"2030-02-01"}');
        IF (SELECT count(*) FROM public.lead_activities WHERE lead_id=lead AND activity_type='stage_change') <> stages+1 THEN
            RAISE EXCEPTION 'Ordinary backward edit must write exactly one stage change';
        END IF;
        IF entry_point='convert' THEN
            SELECT * INTO result FROM public.convert_lead_to_student_atomic(
                studio,actor,lead,gen_random_uuid(),NULL,'inactive',DATE '2035-01-01',gen_random_uuid(),gen_random_uuid());
            PERFORM public.convert_lead_to_student_atomic(studio,actor,lead,NULL,NULL,NULL,NULL,NULL,NULL);
            -- Clearing a follow-up while already enrolled changes no stage history.
            PERFORM public.update_lead_atomic(studio,actor,lead,'{"follow_up_date":"2030-03-01"}');
            SELECT * INTO result FROM public.convert_lead_to_student_atomic(studio,actor,lead,NULL,NULL,NULL,NULL,NULL,NULL);
        ELSE
            SELECT * INTO result FROM public.follow_up_lead_atomic(studio,actor,lead,operation,'{"next_stage":"enrolled"}');
            PERFORM public.follow_up_lead_atomic(studio,actor,lead,operation,'{"next_stage":"enrolled"}');
            PERFORM public.update_lead_atomic(studio,actor,lead,'{"follow_up_date":"2030-03-01"}');
            SELECT * INTO result FROM public.follow_up_lead_atomic(studio,actor,lead,gen_random_uuid(),'{"next_stage":"enrolled"}');
        END IF;
        SELECT jsonb_build_array(
            (SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM public.students s WHERE studio_id=studio),
            (SELECT jsonb_agg(to_jsonb(m) ORDER BY id) FROM public.student_program_memberships m WHERE studio_id=studio),
            (SELECT jsonb_agg(to_jsonb(g) ORDER BY id) FROM public.guardians g WHERE studio_id=studio),
            (SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM public.student_guardians l WHERE student_id=student),
            (SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM public.audit_logs a WHERE studio_id=studio)
        ) INTO current_facts;
        IF result.stage IS DISTINCT FROM 'enrolled' OR result.follow_up_date IS NOT NULL
           OR result.converted_student_id IS DISTINCT FROM student OR result.program_id IS NOT NULL
           OR current_facts IS DISTINCT FROM retained
           OR NOT EXISTS(SELECT 1 FROM public.students WHERE id=student AND is_minor IS TRUE AND date_of_birth IS NULL)
           OR (SELECT count(*) FROM public.lead_activities WHERE lead_id=lead AND activity_type='stage_change') <> stages+2 THEN
            RAISE EXCEPTION 'Combined % restoration changed conversion facts or stage history',entry_point;
        END IF;
    END LOOP;
    IF (SELECT count(*) FROM public.lead_activities WHERE lead_id=lead AND activity_type='stage_change') <> 5
       OR (SELECT count(*) FROM public.lead_activities WHERE lead_id=lead AND description='Stage changed from offer_sent to enrolled') <> 2
       OR (SELECT count(*) FROM public.lead_activities WHERE lead_id=lead AND description='Stage changed from enrolled to offer_sent') <> 2 THEN
        RAISE EXCEPTION 'Combined restore must record exactly one activity per actual stage change';
    END IF;
    SELECT jsonb_build_array(
        (SELECT to_jsonb(l) FROM public.leads l WHERE id=lead),
        (SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM public.lead_activities a),
        (SELECT jsonb_agg(to_jsonb(o) ORDER BY operation_id) FROM public.lead_follow_up_operations o)
    ) INTO before_tenant_failure;
    FOREACH entry_point IN ARRAY ARRAY['convert','follow-up'] LOOP
        failed := FALSE;
        BEGIN
            IF entry_point='convert' THEN
                PERFORM public.convert_lead_to_student_atomic(other_studio,other_actor,lead,NULL,NULL,NULL,NULL,NULL,NULL);
            ELSE
                PERFORM public.follow_up_lead_atomic(other_studio,other_actor,lead,gen_random_uuid(),'{"next_stage":"enrolled"}');
            END IF;
        EXCEPTION WHEN SQLSTATE 'P0001' OR SQLSTATE 'P0002' THEN
            IF SQLERRM <> 'Lead not found for studio.' THEN RAISE; END IF;
            failed := TRUE;
        END;
        IF NOT failed OR before_tenant_failure IS DISTINCT FROM jsonb_build_array(
            (SELECT to_jsonb(l) FROM public.leads l WHERE id=lead),
            (SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM public.lead_activities a),
            (SELECT jsonb_agg(to_jsonb(o) ORDER BY operation_id) FROM public.lead_follow_up_operations o)) THEN
            RAISE EXCEPTION 'Cross-tenant % restoration wrote lead state, activity or receipt',entry_point;
        END IF;
    END LOOP;
END;
$combined$;
ROLLBACK;
