BEGIN;

DO $$
DECLARE
    v_rpc REGPROCEDURE := 'public.clear_studio_operational_data_atomic(uuid, boolean)'::REGPROCEDURE;
    v_owner UUID := gen_random_uuid();
    v_other_owner UUID := gen_random_uuid();
    v_studio UUID := gen_random_uuid();
    v_other_studio UUID := gen_random_uuid();
    v_program UUID := gen_random_uuid();
    v_other_program UUID := gen_random_uuid();
    v_student UUID := gen_random_uuid();
    v_guardian UUID := gen_random_uuid();
    v_lead UUID := gen_random_uuid();
    v_count INTEGER;
BEGIN
    IF to_regprocedure('public.clear_studio_operational_data_atomic(uuid, boolean)') IS NULL THEN
        RAISE EXCEPTION 'Missing public.clear_studio_operational_data_atomic(uuid, boolean).';
    END IF;

    IF NOT has_function_privilege('service_role', v_rpc, 'EXECUTE') THEN
        RAISE EXCEPTION 'service_role must execute public.clear_studio_operational_data_atomic.';
    END IF;

    IF has_function_privilege('anon', v_rpc, 'EXECUTE')
       OR has_function_privilege('authenticated', v_rpc, 'EXECUTE') THEN
        RAISE EXCEPTION 'Browser-facing roles must not execute public.clear_studio_operational_data_atomic.';
    END IF;

    BEGIN
        PERFORM public.clear_studio_operational_data_atomic(gen_random_uuid(), false);
        RAISE EXCEPTION 'Expected unknown studio operational clear to fail.';
    EXCEPTION
        WHEN OTHERS THEN
            IF SQLERRM NOT ILIKE '%Studio not found for operational clear%' THEN
                RAISE;
            END IF;
    END;

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
            'studio-clear-' || replace(v_owner::TEXT, '-', '') || '@example.invalid',
            '{}'::jsonb,
            '{}'::jsonb,
            now(),
            now()
        ),
        (
            v_other_owner,
            'authenticated',
            'authenticated',
            'studio-clear-' || replace(v_other_owner::TEXT, '-', '') || '@example.invalid',
            '{}'::jsonb,
            '{}'::jsonb,
            now(),
            now()
        );

    INSERT INTO public.studios (id, name, slug, owner_id)
    VALUES
        (v_studio, 'Studio Clear Smoke', 'studio-clear-' || replace(v_studio::TEXT, '-', ''), v_owner),
        (v_other_studio, 'Studio Clear Other', 'studio-clear-' || replace(v_other_studio::TEXT, '-', ''), v_other_owner);

    INSERT INTO public.programs (id, studio_id, name)
    VALUES
        (v_program, v_studio, 'Target Program'),
        (v_other_program, v_other_studio, 'Other Program');

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
        v_student,
        v_studio,
        'Aiko',
        'Tanaka',
        'active',
        CURRENT_DATE,
        v_program
    );

    INSERT INTO public.guardians (
        id,
        studio_id,
        first_name,
        last_name,
        is_primary_contact
    )
    VALUES (
        v_guardian,
        v_studio,
        'Hana',
        'Tanaka',
        true
    );

    INSERT INTO public.student_guardians (student_id, guardian_id)
    VALUES (v_student, v_guardian);

    INSERT INTO public.leads (
        id,
        studio_id,
        first_name,
        last_name,
        source,
        stage,
        program_id,
        is_minor
    )
    VALUES (
        v_lead,
        v_studio,
        'Noah',
        'Kim',
        'referral',
        'inquiry',
        v_program,
        false
    );

    PERFORM public.clear_studio_operational_data_atomic(v_studio, false);

    SELECT COUNT(*)
    INTO v_count
    FROM public.students
    WHERE studio_id = v_studio;

    IF v_count <> 0 THEN
        RAISE EXCEPTION 'Atomic studio clear did not delete target studio students.';
    END IF;

    SELECT COUNT(*)
    INTO v_count
    FROM public.guardians
    WHERE studio_id = v_studio;

    IF v_count <> 0 THEN
        RAISE EXCEPTION 'Atomic studio clear did not delete target studio guardians.';
    END IF;

    SELECT COUNT(*)
    INTO v_count
    FROM public.student_guardians
    WHERE student_id = v_student
       OR guardian_id = v_guardian;

    IF v_count <> 0 THEN
        RAISE EXCEPTION 'Atomic studio clear did not delete target student guardian joins.';
    END IF;

    SELECT COUNT(*)
    INTO v_count
    FROM public.leads
    WHERE studio_id = v_studio;

    IF v_count <> 0 THEN
        RAISE EXCEPTION 'Atomic studio clear did not delete target studio leads.';
    END IF;

    SELECT COUNT(*)
    INTO v_count
    FROM public.programs
    WHERE studio_id = v_studio;

    IF v_count <> 0 THEN
        RAISE EXCEPTION 'Atomic studio clear did not delete target studio programs.';
    END IF;

    SELECT COUNT(*)
    INTO v_count
    FROM public.programs
    WHERE id = v_other_program
      AND studio_id = v_other_studio;

    IF v_count <> 1 THEN
        RAISE EXCEPTION 'Atomic studio clear deleted data from another studio.';
    END IF;
END $$;

ROLLBACK;
