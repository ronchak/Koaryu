BEGIN;

DO $$
DECLARE
    v_owner UUID := gen_random_uuid();
    v_studio UUID := gen_random_uuid();
    v_other_studio UUID := gen_random_uuid();
    v_empty_studio UUID := gen_random_uuid();
    v_template_early UUID := gen_random_uuid();
    v_template_late UUID := gen_random_uuid();
    v_other_template UUID := gen_random_uuid();
    v_session_early UUID := gen_random_uuid();
    v_session_late UUID := gen_random_uuid();
    v_session_canceled UUID := gen_random_uuid();
    v_session_deleted UUID := gen_random_uuid();
    v_session_outside UUID := gen_random_uuid();
    v_other_session UUID := gen_random_uuid();
    v_student_preferred UUID := gen_random_uuid();
    v_student_legal UUID := gen_random_uuid();
    v_other_student UUID := gen_random_uuid();
    v_payload JSONB;
    v_other_payload JSONB;
    v_empty_payload JSONB;
    v_before_templates BIGINT;
    v_before_sessions BIGINT;
    v_before_attendance BIGINT;
    v_denied BOOLEAN;
    v_function_config TEXT[];
BEGIN
    IF to_regprocedure('public.schedule_window_read(uuid,date,date,text)') IS NULL THEN
        RAISE EXCEPTION 'Missing schedule_window_read RPC signature.';
    END IF;

    SELECT function.proconfig
    INTO v_function_config
    FROM pg_proc AS function
    JOIN pg_namespace AS namespace
      ON namespace.oid = function.pronamespace
    WHERE namespace.nspname = 'public'
      AND function.oid = 'public.schedule_window_read(uuid,date,date,text)'::REGPROCEDURE
      AND function.prosecdef = false
      AND function.provolatile = 's';
    IF v_function_config IS NULL
       OR NOT (v_function_config @> ARRAY['search_path=pg_catalog']) THEN
        RAISE EXCEPTION 'Schedule window RPC must be stable, invoker-security, and pinned to pg_catalog.';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_proc AS function
        JOIN pg_namespace AS namespace
          ON namespace.oid = function.pronamespace
        CROSS JOIN LATERAL aclexplode(
            COALESCE(function.proacl, acldefault('f', function.proowner))
        ) AS privilege
        WHERE namespace.nspname = 'public'
          AND function.oid = 'public.schedule_window_read(uuid,date,date,text)'::REGPROCEDURE
          AND privilege.grantee = 0
          AND privilege.privilege_type = 'EXECUTE'
    ) THEN
        RAISE EXCEPTION 'PUBLIC can execute the schedule window RPC.';
    END IF;
    IF has_function_privilege(
            'anon',
            'public.schedule_window_read(uuid,date,date,text)',
            'EXECUTE'
       )
       OR has_function_privilege(
            'authenticated',
            'public.schedule_window_read(uuid,date,date,text)',
            'EXECUTE'
       )
       OR NOT has_function_privilege(
            'service_role',
            'public.schedule_window_read(uuid,date,date,text)',
            'EXECUTE'
       ) THEN
        RAISE EXCEPTION 'Schedule window RPC ACL is not service_role-only.';
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
        'schedule-window-' || replace(v_owner::TEXT, '-', '') || '@example.invalid',
        '{}'::JSONB,
        '{}'::JSONB,
        now(),
        now()
    );

    INSERT INTO public.studios (id, name, slug, owner_id)
    VALUES
        (v_studio, 'Schedule Window Studio', 'schedule-window-' || replace(v_studio::TEXT, '-', ''), v_owner),
        (v_other_studio, 'Other Schedule Studio', 'schedule-window-other-' || replace(v_other_studio::TEXT, '-', ''), v_owner),
        (v_empty_studio, 'Empty Schedule Studio', 'schedule-window-empty-' || replace(v_empty_studio::TEXT, '-', ''), v_owner);

    INSERT INTO public.class_templates (
        id,
        studio_id,
        name,
        day_of_week,
        start_time,
        end_time,
        start_date,
        end_date,
        capacity,
        is_active
    )
    VALUES
        (v_template_late, v_studio, 'Tuesday Late', 2, TIME '18:00', TIME '19:00', DATE '2026-05-01', NULL, 20, true),
        (v_template_early, v_studio, 'Monday Early', 1, TIME '09:00', TIME '10:00', DATE '2026-05-01', NULL, 12, true),
        (v_other_template, v_other_studio, 'Other Tenant Template', 1, TIME '08:00', TIME '09:00', DATE '2026-05-01', NULL, 8, true);

    INSERT INTO public.students (
        id,
        studio_id,
        legal_first_name,
        legal_last_name,
        preferred_name,
        status
    )
    VALUES
        (v_student_preferred, v_studio, 'Keiko', 'Tanaka', 'Kai', 'active'),
        (v_student_legal, v_studio, 'Mina', 'Sato', NULL, 'active'),
        (v_other_student, v_other_studio, 'Other', 'Student', NULL, 'active');

    INSERT INTO public.class_sessions (
        id,
        studio_id,
        template_id,
        name,
        date,
        start_time,
        end_time,
        capacity,
        status,
        deleted_at
    )
    VALUES
        (v_session_late, v_studio, v_template_late, 'Late Session', DATE '2026-05-20', TIME '18:00', TIME '19:00', 20, 'scheduled', NULL),
        (v_session_early, v_studio, v_template_early, 'Early Session', DATE '2026-05-20', TIME '09:00', TIME '10:00', 12, 'scheduled', NULL),
        (v_session_canceled, v_studio, NULL, 'Canceled Session', DATE '2026-05-21', TIME '09:00', TIME '10:00', 10, 'canceled', NULL),
        (v_session_deleted, v_studio, NULL, 'Deleted Session', DATE '2026-05-20', TIME '07:00', TIME '08:00', 10, 'canceled', now()),
        (v_session_outside, v_studio, NULL, 'Outside Session', DATE '2026-05-30', TIME '09:00', TIME '10:00', 10, 'scheduled', NULL),
        (v_other_session, v_other_studio, v_other_template, 'Other Tenant Session', DATE '2026-05-20', TIME '08:00', TIME '09:00', 8, 'scheduled', NULL);

    INSERT INTO public.attendance (
        studio_id,
        session_id,
        student_id,
        status,
        checked_in_at,
        is_cross_program,
        counts_toward_eligibility
    )
    VALUES
        (v_studio, v_session_early, v_student_preferred, 'present', TIMESTAMPTZ '2026-05-20 16:00:00+00', false, true),
        (v_studio, v_session_early, v_student_legal, 'absent', TIMESTAMPTZ '2026-05-20 16:01:00+00', false, true),
        (v_studio, v_session_canceled, v_student_preferred, 'present', TIMESTAMPTZ '2026-05-21 16:00:00+00', false, true),
        (v_other_studio, v_other_session, v_other_student, 'present', TIMESTAMPTZ '2026-05-20 15:00:00+00', false, true);

    SELECT COUNT(*) INTO v_before_templates FROM public.class_templates;
    SELECT COUNT(*) INTO v_before_sessions FROM public.class_sessions;
    SELECT COUNT(*) INTO v_before_attendance FROM public.attendance;

    SELECT public.schedule_window_read(
        v_studio,
        DATE '2026-05-20',
        DATE '2026-05-21',
        'schedule-window-v1'
    )
    INTO v_payload;

    IF v_payload->>'contract_version' <> 'schedule-window-v1'
       OR v_payload->'range'->>'start_date' <> '2026-05-20'
       OR v_payload->'range'->>'end_date' <> '2026-05-21'
       OR v_payload->'range'->>'day_count' <> '2' THEN
        RAISE EXCEPTION 'Schedule window metadata is incorrect: %', v_payload;
    END IF;
    IF jsonb_typeof(v_payload->'templates') <> 'array'
       OR jsonb_typeof(v_payload->'sessions') <> 'array'
       OR jsonb_typeof(v_payload->'attendance') <> 'array' THEN
        RAISE EXCEPTION 'Schedule window collections are not arrays: %', v_payload;
    END IF;
    IF jsonb_array_length(v_payload->'templates') <> 2
       OR v_payload->'templates'->0->>'id' <> v_template_early::TEXT
       OR v_payload->'templates'->1->>'id' <> v_template_late::TEXT THEN
        RAISE EXCEPTION 'Schedule templates are incomplete, unscoped, or unordered: %', v_payload->'templates';
    END IF;
    IF jsonb_array_length(v_payload->'sessions') <> 3
       OR v_payload->'sessions'->0->>'id' <> v_session_early::TEXT
       OR v_payload->'sessions'->1->>'id' <> v_session_late::TEXT
       OR v_payload->'sessions'->2->>'id' <> v_session_canceled::TEXT
       OR v_payload->'sessions'->0->>'attendance_count' <> '1'
       OR v_payload->'sessions'->2->>'attendance_count' <> '1' THEN
        RAISE EXCEPTION 'Schedule sessions are incomplete, unscoped, unordered, or miscounted: %', v_payload->'sessions';
    END IF;
    IF jsonb_array_length(v_payload->'attendance') <> 2
       OR v_payload->'attendance'->0->>'student_name' <> 'Kai Tanaka'
       OR v_payload->'attendance'->1->>'student_name' <> 'Mina Sato' THEN
        RAISE EXCEPTION 'Schedule attendance projection or names are incorrect: %', v_payload->'attendance';
    END IF;
    IF (v_payload->'attendance'->0) ? 'students'
       OR (v_payload->'attendance'->0) ? 'email'
       OR (v_payload->'sessions'->0) ? 'deleted_at' THEN
        RAISE EXCEPTION 'Schedule window exposed fields outside the page contract: %', v_payload;
    END IF;

    IF (SELECT COUNT(*) FROM public.class_templates) <> v_before_templates
       OR (SELECT COUNT(*) FROM public.class_sessions) <> v_before_sessions
       OR (SELECT COUNT(*) FROM public.attendance) <> v_before_attendance THEN
        RAISE EXCEPTION 'Schedule window read changed persisted schedule state.';
    END IF;

    SELECT public.schedule_window_read(
        v_other_studio,
        DATE '2026-05-20',
        DATE '2026-05-21',
        'schedule-window-v1'
    )
    INTO v_other_payload;
    IF jsonb_array_length(v_other_payload->'templates') <> 1
       OR jsonb_array_length(v_other_payload->'sessions') <> 1
       OR jsonb_array_length(v_other_payload->'attendance') <> 1
       OR v_other_payload->'templates'->0->>'studio_id' <> v_other_studio::TEXT
       OR v_other_payload->'sessions'->0->>'studio_id' <> v_other_studio::TEXT
       OR v_other_payload->'attendance'->0->>'studio_id' <> v_other_studio::TEXT THEN
        RAISE EXCEPTION 'Schedule window crossed studio boundaries: %', v_other_payload;
    END IF;

    SELECT public.schedule_window_read(
        v_empty_studio,
        DATE '2026-05-20',
        DATE '2026-05-21',
        'schedule-window-v1'
    )
    INTO v_empty_payload;
    IF v_empty_payload->'templates' <> '[]'::JSONB
       OR v_empty_payload->'sessions' <> '[]'::JSONB
       OR v_empty_payload->'attendance' <> '[]'::JSONB THEN
        RAISE EXCEPTION 'Empty schedule window did not return empty arrays: %', v_empty_payload;
    END IF;

    v_denied := false;
    BEGIN
        PERFORM public.schedule_window_read(
            v_studio,
            DATE '2026-05-20',
            DATE '2026-05-21',
            'unsupported-contract'
        );
    EXCEPTION WHEN SQLSTATE '22023' THEN
        v_denied := true;
    END;
    IF NOT v_denied THEN
        RAISE EXCEPTION 'Schedule window accepted an unsupported contract version.';
    END IF;

    v_denied := false;
    BEGIN
        PERFORM public.schedule_window_read(
            v_studio,
            DATE '2026-05-21',
            DATE '2026-05-20',
            'schedule-window-v1'
        );
    EXCEPTION WHEN SQLSTATE '22023' THEN
        v_denied := true;
    END;
    IF NOT v_denied THEN
        RAISE EXCEPTION 'Schedule window accepted a reversed date range.';
    END IF;

    v_denied := false;
    BEGIN
        PERFORM public.schedule_window_read(
            v_studio,
            DATE '2026-01-01',
            DATE '2026-04-04',
            'schedule-window-v1'
        );
    EXCEPTION WHEN SQLSTATE '22023' THEN
        v_denied := true;
    END;
    IF NOT v_denied THEN
        RAISE EXCEPTION 'Schedule window accepted more than 93 days.';
    END IF;

    v_denied := false;
    BEGIN
        PERFORM public.schedule_window_read(
            NULL,
            DATE '2026-05-20',
            DATE '2026-05-21',
            'schedule-window-v1'
        );
    EXCEPTION WHEN SQLSTATE '22004' THEN
        v_denied := true;
    END;
    IF NOT v_denied THEN
        RAISE EXCEPTION 'Schedule window accepted a null studio.';
    END IF;

    v_denied := false;
    BEGIN
        PERFORM public.schedule_window_read(
            gen_random_uuid(),
            DATE '2026-05-20',
            DATE '2026-05-21',
            'schedule-window-v1'
        );
    EXCEPTION WHEN SQLSTATE 'P0002' THEN
        v_denied := true;
    END;
    IF NOT v_denied THEN
        RAISE EXCEPTION 'Schedule window accepted a missing studio.';
    END IF;

    RAISE NOTICE 'Schedule window read RPC contract verification passed.';
END $$;

ROLLBACK;
