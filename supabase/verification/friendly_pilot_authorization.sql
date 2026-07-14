BEGIN;

DO $$
DECLARE
    v_owner UUID := gen_random_uuid();
    v_studio_a UUID := gen_random_uuid();
    v_studio_b UUID := gen_random_uuid();
    v_program UUID := gen_random_uuid();
    v_ladder UUID := gen_random_uuid();
    v_rank_low UUID := gen_random_uuid();
    v_rank_high UUID := gen_random_uuid();
    v_student UUID := gen_random_uuid();
    v_membership UUID := gen_random_uuid();
    v_demotion public.promotions%ROWTYPE;
    v_expected_exception BOOLEAN := false;
BEGIN
    IF to_regprocedure(
        'public.record_student_demotion(uuid, uuid, uuid, uuid, uuid, uuid, uuid, text)'
    ) IS NULL THEN
        RAISE EXCEPTION 'Missing public.record_student_demotion RPC.';
    END IF;

    IF has_function_privilege(
        'anon',
        'public.record_student_demotion(uuid, uuid, uuid, uuid, uuid, uuid, uuid, text)',
        'EXECUTE'
    ) OR has_function_privilege(
        'authenticated',
        'public.record_student_demotion(uuid, uuid, uuid, uuid, uuid, uuid, uuid, text)',
        'EXECUTE'
    ) OR NOT has_function_privilege(
        'service_role',
        'public.record_student_demotion(uuid, uuid, uuid, uuid, uuid, uuid, uuid, text)',
        'EXECUTE'
    ) THEN
        RAISE EXCEPTION 'Demotion RPC execution privileges are not service-role-only.';
    END IF;

    IF has_table_privilege('anon', 'public.students', 'SELECT')
       OR has_table_privilege('authenticated', 'public.students', 'SELECT') THEN
        RAISE EXCEPTION 'Student rows remain directly selectable by a browser role.';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger AS trigger_row
        WHERE trigger_row.tgrelid = 'public.staff_roles'::REGCLASS
          AND trigger_row.tgname = 'enforce_single_studio_membership'
          AND trigger_row.tgenabled <> 'D'
          AND NOT trigger_row.tgisinternal
    ) THEN
        RAISE EXCEPTION 'Single-studio membership trigger is missing or disabled.';
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
    VALUES (
        v_owner,
        'authenticated',
        'authenticated',
        'friendly-pilot-' || replace(v_owner::TEXT, '-', '') || '@example.invalid',
        '{}'::JSONB,
        '{}'::JSONB,
        now(),
        now()
    );

    INSERT INTO public.studios (id, name, slug, owner_id)
    VALUES
        (
            v_studio_a,
            'Friendly Pilot Authorization A',
            'friendly-pilot-a-' || replace(v_studio_a::TEXT, '-', ''),
            v_owner
        ),
        (
            v_studio_b,
            'Friendly Pilot Authorization B',
            'friendly-pilot-b-' || replace(v_studio_b::TEXT, '-', ''),
            v_owner
        );

    INSERT INTO public.staff_roles (studio_id, user_id, role)
    VALUES (v_studio_a, v_owner, 'admin');

    BEGIN
        INSERT INTO public.staff_roles (studio_id, user_id, role)
        VALUES (v_studio_b, v_owner, 'admin');
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%one studio%' THEN
            v_expected_exception := true;
        ELSE
            RAISE;
        END IF;
    END;

    IF NOT v_expected_exception THEN
        RAISE EXCEPTION 'A second cross-studio membership was accepted.';
    END IF;

    INSERT INTO public.programs (id, studio_id, name, sort_order)
    VALUES (v_program, v_studio_a, 'Friendly Pilot Program', 0);

    INSERT INTO public.belt_ladders (id, studio_id, name, program_id)
    VALUES (v_ladder, v_studio_a, 'Friendly Pilot Ladder', v_program);

    INSERT INTO public.belt_ranks (id, ladder_id, studio_id, name, display_order)
    VALUES
        (v_rank_low, v_ladder, v_studio_a, 'Lower Rank', 0),
        (v_rank_high, v_ladder, v_studio_a, 'Higher Rank', 1);

    INSERT INTO public.students (
        id,
        studio_id,
        legal_first_name,
        legal_last_name,
        status,
        program_id,
        current_belt_rank_id
    )
    VALUES (
        v_student,
        v_studio_a,
        'Friendly',
        'Pilot',
        'active',
        v_program,
        v_rank_high
    );

    INSERT INTO public.student_program_memberships (
        id,
        studio_id,
        student_id,
        program_id,
        status,
        started_at,
        current_belt_rank_id
    )
    VALUES (
        v_membership,
        v_studio_a,
        v_student,
        v_program,
        'active',
        CURRENT_DATE,
        v_rank_high
    );

    SELECT *
    INTO v_demotion
    FROM public.record_student_demotion(
        v_studio_a,
        v_student,
        v_membership,
        v_program,
        v_rank_high,
        v_rank_low,
        v_owner,
        'Correcting an earlier rank entry'
    );

    IF v_demotion.id IS NULL THEN
        RAISE EXCEPTION 'Demotion RPC did not return its rank-change row.';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM public.audit_logs
        WHERE studio_id = v_studio_a
          AND entity_id = v_demotion.id
          AND action = 'student.demoted'
          AND metadata->>'reason' = 'Correcting an earlier rank entry'
    ) THEN
        RAISE EXCEPTION 'Demotion did not create the required reasoned audit event.';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.audit_logs
        WHERE studio_id = v_studio_a
          AND entity_id = v_demotion.id
          AND action = 'student.promoted'
    ) THEN
        RAISE EXCEPTION 'Demotion retained an ambiguous promotion audit event.';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM public.student_program_memberships
        WHERE id = v_membership
          AND current_belt_rank_id = v_rank_low
    ) THEN
        RAISE EXCEPTION 'Demotion did not update the program membership atomically.';
    END IF;

    RAISE NOTICE 'Friendly Pilot authorization verification passed.';
END $$;

ROLLBACK;
