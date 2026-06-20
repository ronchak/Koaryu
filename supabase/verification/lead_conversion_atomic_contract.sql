BEGIN;

DO $$
DECLARE
    v_rpc REGPROCEDURE := 'public.convert_lead_to_student_atomic(uuid, uuid, uuid, uuid, uuid, text, date, uuid, uuid)'::REGPROCEDURE;
    v_owner UUID := gen_random_uuid();
    v_other_owner UUID := gen_random_uuid();
    v_studio UUID := gen_random_uuid();
    v_other_studio UUID := gen_random_uuid();
    v_program UUID := gen_random_uuid();
    v_other_program UUID := gen_random_uuid();
    v_lead UUID := gen_random_uuid();
    v_conflict_lead UUID := gen_random_uuid();
    v_student UUID := gen_random_uuid();
    v_conflict_student UUID := gen_random_uuid();
    v_guardian UUID := gen_random_uuid();
    v_link UUID := gen_random_uuid();
    v_converted public.leads%ROWTYPE;
    v_count INTEGER;
BEGIN
    IF to_regprocedure('public.convert_lead_to_student_atomic(uuid, uuid, uuid, uuid, uuid, text, date, uuid, uuid)') IS NULL THEN
        RAISE EXCEPTION 'Missing public.convert_lead_to_student_atomic(uuid, uuid, uuid, uuid, uuid, text, date, uuid, uuid).';
    END IF;

    IF NOT has_function_privilege('service_role', v_rpc, 'EXECUTE') THEN
        RAISE EXCEPTION 'service_role must execute public.convert_lead_to_student_atomic.';
    END IF;

    IF has_function_privilege('anon', v_rpc, 'EXECUTE')
       OR has_function_privilege('authenticated', v_rpc, 'EXECUTE') THEN
        RAISE EXCEPTION 'Browser-facing roles must not execute public.convert_lead_to_student_atomic.';
    END IF;

    INSERT INTO auth.users (
        id,
        aud,
        role,
        email,
        raw_app_meta_data,
        raw_user_meta_data,
        created_at,
        updated_at
    )
    VALUES
        (
            v_owner,
            'authenticated',
            'authenticated',
            'lead-conversion-' || replace(v_owner::TEXT, '-', '') || '@example.invalid',
            '{}'::jsonb,
            '{}'::jsonb,
            now(),
            now()
        ),
        (
            v_other_owner,
            'authenticated',
            'authenticated',
            'lead-conversion-' || replace(v_other_owner::TEXT, '-', '') || '@example.invalid',
            '{}'::jsonb,
            '{}'::jsonb,
            now(),
            now()
        );

    INSERT INTO public.studios (id, name, slug, owner_id)
    VALUES
        (v_studio, 'Lead Conversion Smoke', 'lead-conversion-' || replace(v_studio::TEXT, '-', ''), v_owner),
        (v_other_studio, 'Lead Conversion Other', 'lead-conversion-' || replace(v_other_studio::TEXT, '-', ''), v_other_owner);

    INSERT INTO public.programs (id, studio_id, name)
    VALUES
        (v_program, v_studio, 'Youth BJJ'),
        (v_other_program, v_other_studio, 'Other Program');

    INSERT INTO public.leads (
        id,
        studio_id,
        first_name,
        last_name,
        email,
        phone,
        source,
        stage,
        program_id,
        is_minor,
        guardian_name,
        guardian_email,
        guardian_phone,
        follow_up_date,
        notes
    )
    VALUES
        (
            v_lead,
            v_studio,
            'Ava',
            'Nguyen',
            'ava@example.invalid',
            '555-0100',
            'walk_in',
            'trial_completed',
            v_program,
            TRUE,
            'Mina Nguyen',
            'mina@example.invalid',
            '555-0199',
            CURRENT_DATE,
            'Trial complete.'
        ),
        (
            v_conflict_lead,
            v_studio,
            'Noah',
            'Kim',
            'noah@example.invalid',
            NULL,
            'referral',
            'trial_completed',
            v_program,
            FALSE,
            NULL,
            NULL,
            NULL,
            CURRENT_DATE,
            NULL
        );

    SELECT *
    INTO v_converted
    FROM public.convert_lead_to_student_atomic(
        v_studio,
        v_owner,
        v_lead,
        v_student,
        v_program,
        'active',
        DATE '2026-06-01',
        v_guardian,
        v_link
    );

    IF v_converted.id <> v_lead
       OR v_converted.stage <> 'enrolled'
       OR v_converted.converted_student_id <> v_student
       OR v_converted.follow_up_date IS NOT NULL THEN
        RAISE EXCEPTION 'Lead conversion did not return the enrolled lead state.';
    END IF;

    SELECT COUNT(*)
    INTO v_count
    FROM public.students
    WHERE id = v_student
      AND studio_id = v_studio
      AND program_id = v_program
      AND membership_start_date = DATE '2026-06-01'
      AND tags = ARRAY['converted-lead']::TEXT[];

    IF v_count <> 1 THEN
        RAISE EXCEPTION 'Lead conversion did not create the expected student.';
    END IF;

    SELECT COUNT(*)
    INTO v_count
    FROM public.student_program_memberships
    WHERE studio_id = v_studio
      AND student_id = v_student
      AND program_id = v_program
      AND status = 'active'
      AND started_at = DATE '2026-06-01'
      AND ended_at IS NULL;

    IF v_count <> 1 THEN
        RAISE EXCEPTION 'Lead conversion did not create one active program membership.';
    END IF;

    SELECT COUNT(*)
    INTO v_count
    FROM public.guardians guardian
    JOIN public.student_guardians link ON link.guardian_id = guardian.id
    WHERE guardian.id = v_guardian
      AND guardian.studio_id = v_studio
      AND guardian.first_name = 'Mina'
      AND guardian.last_name = 'Nguyen'
      AND link.id = v_link
      AND link.student_id = v_student;

    IF v_count <> 1 THEN
        RAISE EXCEPTION 'Lead conversion did not create the expected guardian relationship.';
    END IF;

    SELECT COUNT(*)
    INTO v_count
    FROM public.lead_activities
    WHERE studio_id = v_studio
      AND lead_id = v_lead
      AND activity_type = 'stage_change'
      AND created_by = v_owner;

    IF v_count <> 1 THEN
        RAISE EXCEPTION 'Lead conversion did not create one lead activity.';
    END IF;

    SELECT COUNT(*)
    INTO v_count
    FROM public.audit_logs
    WHERE studio_id = v_studio
      AND actor_id = v_owner
      AND action = 'lead.converted'
      AND entity_id = v_lead
      AND metadata->>'student_id' = v_student::TEXT;

    IF v_count <> 1 THEN
        RAISE EXCEPTION 'Lead conversion did not create one audit log.';
    END IF;

    PERFORM public.convert_lead_to_student_atomic(
        v_studio,
        v_owner,
        v_lead,
        v_student,
        v_program,
        'active',
        DATE '2026-06-01',
        v_guardian,
        v_link
    );

    SELECT COUNT(*)
    INTO v_count
    FROM public.students
    WHERE id = v_student;

    IF v_count <> 1 THEN
        RAISE EXCEPTION 'Retrying converted lead duplicated the student.';
    END IF;

    INSERT INTO public.students (
        id,
        studio_id,
        legal_first_name,
        legal_last_name,
        status,
        membership_start_date,
        program_id
    )
    VALUES (
        v_conflict_student,
        v_other_studio,
        'Other',
        'Student',
        'active',
        CURRENT_DATE,
        v_other_program
    );

    BEGIN
        PERFORM public.convert_lead_to_student_atomic(
            v_studio,
            v_owner,
            v_conflict_lead,
            v_conflict_student,
            v_program,
            'active',
            DATE '2026-06-01',
            NULL,
            NULL
        );
        RAISE EXCEPTION 'Expected cross-studio student id conflict to fail.';
    EXCEPTION
        WHEN OTHERS THEN
            IF SQLERRM NOT ILIKE '%another studio%' THEN
                RAISE;
            END IF;
    END;
END $$;

ROLLBACK;
