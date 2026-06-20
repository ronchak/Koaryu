BEGIN;

DO $$
DECLARE
    v_owner UUID := gen_random_uuid();
    v_studio UUID := gen_random_uuid();
    v_program UUID := gen_random_uuid();
    v_other_program UUID := gen_random_uuid();
    v_first_student UUID := gen_random_uuid();
    v_second_student UUID := gen_random_uuid();
    v_other_student UUID := gen_random_uuid();
    v_rows JSONB;
BEGIN
    IF to_regprocedure('public.list_student_ids_for_program_filter(uuid, uuid, text, text, text, text, integer, integer)') IS NULL THEN
        RAISE EXCEPTION 'Missing public.list_student_ids_for_program_filter(uuid, uuid, text, text, text, text, integer, integer).';
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
        'koaryu-program-filter-' || replace(v_owner::TEXT, '-', '') || '@example.invalid',
        '{}'::jsonb,
        '{}'::jsonb,
        now(),
        now()
    );

    INSERT INTO public.studios (id, name, slug, owner_id)
    VALUES (v_studio, 'Koaryu Program Filter Smoke', 'koaryu-program-filter-' || replace(v_studio::TEXT, '-', ''), v_owner);

    INSERT INTO public.programs (id, studio_id, name, sort_order)
    VALUES
        (v_program, v_studio, 'Program Filter Smoke', 0),
        (v_other_program, v_studio, 'Other Program Filter Smoke', 1);

    INSERT INTO public.students (
        id,
        studio_id,
        legal_first_name,
        legal_last_name,
        date_of_birth,
        status,
        program_id,
        membership_start_date,
        created_at,
        updated_at
    )
    VALUES
        (
            v_first_student,
            v_studio,
            'Alpha',
            'Page',
            '2010-01-01',
            'active',
            v_program,
            '2026-01-01',
            now() - interval '3 days',
            now() - interval '3 days'
        ),
        (
            v_second_student,
            v_studio,
            'Beta',
            'Page',
            '2010-01-01',
            'active',
            NULL,
            '2026-01-02',
            now() - interval '2 days',
            now() - interval '2 days'
        ),
        (
            v_other_student,
            v_studio,
            'Gamma',
            'Other',
            '2010-01-01',
            'active',
            v_other_program,
            '2026-01-03',
            now() - interval '1 day',
            now() - interval '1 day'
        );

    INSERT INTO public.student_program_memberships (
        studio_id,
        student_id,
        program_id,
        status,
        started_at
    )
    VALUES (
        v_studio,
        v_second_student,
        v_program,
        'active',
        '2026-01-02'
    );

    SELECT jsonb_agg(to_jsonb(listed))
    INTO v_rows
    FROM public.list_student_ids_for_program_filter(
        v_studio,
        v_program,
        NULL::TEXT,
        NULL::TEXT,
        'name'::TEXT,
        'asc'::TEXT,
        50::INTEGER,
        0::INTEGER
    ) AS listed;

    IF COALESCE(jsonb_array_length(v_rows), 0) <> 2 THEN
        RAISE EXCEPTION 'Expected two program-filter rows, got %', v_rows;
    END IF;

    IF v_rows->0->>'student_id' <> v_first_student::TEXT
       OR v_rows->1->>'student_id' <> v_second_student::TEXT THEN
        RAISE EXCEPTION 'Program-filter RPC did not preserve name-asc page order: %', v_rows;
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(v_rows) AS row
        WHERE row->>'student_id' = v_first_student::TEXT
          AND row->>'total_count' = '2'
    ) OR NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(v_rows) AS row
        WHERE row->>'student_id' = v_second_student::TEXT
          AND row->>'total_count' = '2'
    ) THEN
        RAISE EXCEPTION 'Program-filter RPC did not return expected legacy/membership ids and total: %', v_rows;
    END IF;

    SELECT jsonb_agg(to_jsonb(listed))
    INTO v_rows
    FROM public.list_student_ids_for_program_filter(
        v_studio,
        v_program,
        NULL::TEXT,
        NULL::TEXT,
        'status'::TEXT,
        'desc'::TEXT,
        50::INTEGER,
        0::INTEGER
    ) AS listed;

    IF COALESCE(jsonb_array_length(v_rows), 0) <> 2
       OR v_rows->0->>'student_id' <> v_first_student::TEXT
       OR v_rows->1->>'student_id' <> v_second_student::TEXT THEN
        RAISE EXCEPTION 'Program-filter RPC did not preserve ascending name tie-breaks for status-desc order: %', v_rows;
    END IF;

    SELECT jsonb_agg(to_jsonb(listed))
    INTO v_rows
    FROM public.list_student_ids_for_program_filter(
        v_studio,
        v_program,
        NULL::TEXT,
        NULL::TEXT,
        'name'::TEXT,
        'asc'::TEXT,
        50::INTEGER,
        99::INTEGER
    ) AS listed;

    IF COALESCE(jsonb_array_length(v_rows), 0) <> 1
       OR NOT (v_rows->0 ? 'student_id')
       OR jsonb_typeof(v_rows->0->'student_id') <> 'null'
       OR NOT (v_rows->0 ? 'total_count')
       OR v_rows->0->>'total_count' <> '2' THEN
        RAISE EXCEPTION 'Expected out-of-range page sentinel with null student_id and preserved total_count=2, got %', v_rows;
    END IF;

    SELECT jsonb_agg(to_jsonb(listed))
    INTO v_rows
    FROM public.list_student_ids_for_program_filter(
        v_studio,
        v_program,
        'does-not-match-any-student'::TEXT,
        NULL::TEXT,
        'name'::TEXT,
        'asc'::TEXT,
        50::INTEGER,
        0::INTEGER
    ) AS listed;

    IF COALESCE(jsonb_array_length(v_rows), 0) <> 1
       OR NOT (v_rows->0 ? 'student_id')
       OR jsonb_typeof(v_rows->0->'student_id') <> 'null'
       OR NOT (v_rows->0 ? 'total_count')
       OR v_rows->0->>'total_count' <> '0' THEN
        RAISE EXCEPTION 'Expected no-match sentinel with null student_id and total_count=0, got %', v_rows;
    END IF;

    IF NOT has_function_privilege('service_role', 'public.list_student_ids_for_program_filter(uuid, uuid, text, text, text, text, integer, integer)', 'EXECUTE')
       OR has_function_privilege('anon', 'public.list_student_ids_for_program_filter(uuid, uuid, text, text, text, text, integer, integer)', 'EXECUTE')
       OR has_function_privilege('authenticated', 'public.list_student_ids_for_program_filter(uuid, uuid, text, text, text, text, integer, integer)', 'EXECUTE') THEN
        RAISE EXCEPTION 'Program-filter RPC execution privileges do not match the service-role-only contract.';
    END IF;
END $$;

ROLLBACK;
