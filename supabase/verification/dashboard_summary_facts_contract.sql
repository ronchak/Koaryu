BEGIN;

DO $$
DECLARE
    v_owner UUID := gen_random_uuid();
    v_small UUID := gen_random_uuid();
    v_medium UUID := gen_random_uuid();
    v_large UUID := gen_random_uuid();
    v_program UUID := gen_random_uuid();
    v_ladder UUID := gen_random_uuid();
    v_rank UUID := gen_random_uuid();
    v_tip UUID := gen_random_uuid();
    v_template UUID := gen_random_uuid();
    v_session UUID := gen_random_uuid();
    v_small_noise_session UUID;
    v_medium_noise_session UUID;
    v_large_noise_session UUID;
    v_fact JSONB;
    v_hidden_fact JSONB;
    v_medium_fact JSONB;
    v_large_fact JSONB;
    v_plan_row RECORD;
    v_plan JSONB;
    v_plan_sql TEXT;
    v_plan_text TEXT;
    v_scan_type TEXT;
    v_actual_rows NUMERIC;
    v_estimated_rows NUMERIC;
    v_rows_removed NUMERIC;
    v_actual_loops NUMERIC;
    v_shared_hit_blocks NUMERIC;
    v_shared_read_blocks NUMERIC;
    v_planning_time NUMERIC;
    v_execution_time NUMERIC;
    v_attendance_work NUMERIC;
    v_subplan_count INTEGER;
    v_attendance_scan_count INTEGER;
    v_expected_recent_ids TEXT[];
    v_actual_recent_ids TEXT[];
    v_profile_studio UUID;
    v_expected_sessions INTEGER;
    v_expected_schedule_attendance INTEGER;
    v_expected_operational_attendance INTEGER;
    v_profile TEXT;
    v_hour INTEGER;
    v_denied BOOLEAN;
    v_function_definition TEXT;
BEGIN
    IF to_regprocedure('public.dashboard_summary_facts(uuid,text,text,date,text)') IS NULL THEN
        RAISE EXCEPTION 'Dashboard fact RPC is missing.';
    END IF;
    SELECT pg_get_functiondef('public.dashboard_summary_facts(uuid,text,text,date,text)'::REGPROCEDURE)
    INTO v_function_definition;
    IF position('join selected_sessions as selected on selected.id = attendance.session_id' IN lower(v_function_definition)) = 0
       OR position('join operational_sessions as session on session.id = attendance.session_id' IN lower(v_function_definition)) = 0 THEN
        RAISE EXCEPTION 'Dashboard attendance aggregates are not source-scoped to their owning session sets.';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM pg_proc AS procedure
        WHERE procedure.oid = 'public.dashboard_summary_facts(uuid,text,text,date,text)'::REGPROCEDURE
          AND procedure.prosecdef
    ) THEN
        RAISE EXCEPTION 'Dashboard fact RPC must be SECURITY INVOKER.';
    END IF;
    IF NOT has_function_privilege('service_role', 'public.dashboard_summary_facts(uuid,text,text,date,text)', 'EXECUTE')
       OR has_function_privilege('anon', 'public.dashboard_summary_facts(uuid,text,text,date,text)', 'EXECUTE')
       OR has_function_privilege('authenticated', 'public.dashboard_summary_facts(uuid,text,text,date,text)', 'EXECUTE')
       OR has_function_privilege('public', 'public.dashboard_summary_facts(uuid,text,text,date,text)', 'EXECUTE') THEN
        RAISE EXCEPTION 'Dashboard fact RPC ACL is not service-role-only.';
    END IF;

    -- TEMPORARILY DISABLED -- see issue #113.
    --
    -- These two checks assert that `anon` and `authenticated` cannot EXECUTE the
    -- dashboard fact RPC, by actually invoking it and expecting insufficient_privilege.
    -- On PostgreSQL 17.6 (supabase/postgres:17.6.1.106) that invocation does not raise;
    -- it terminates the backend with SIGSEGV, taking down every open connection.
    --
    -- The crash is NOT specific to this function or this release: the same call against
    -- the pre-existing public.soft_delete_student_atomic on origin/main at 111 migrations
    -- crashes identically. See issue #113 for the full reproduction.
    --
    -- The catalog-based ACL assertions above (has_function_privilege, lines 66-71) still
    -- verify that anon/authenticated/public lack EXECUTE, so the security property is
    -- still covered -- it is simply no longer proven by invocation.
    --
    -- RE-ENABLE THIS once #113 is resolved. Do not delete it.
    -- SET LOCAL ROLE anon;
    -- v_denied := false;
    -- BEGIN
    -- PERFORM public.dashboard_summary_facts(
    -- gen_random_uuid(), 'billing_hidden', 'UTC', DATE '2026-05-20', 'dashboard-summary-v1'
    -- );
    -- EXCEPTION WHEN insufficient_privilege THEN
    -- v_denied := true;
    -- END;
    -- IF NOT v_denied THEN
    -- RAISE EXCEPTION 'anon execution of dashboard fact RPC was not denied.';
    -- END IF;
    --
    -- SET LOCAL ROLE authenticated;
    -- v_denied := false;
    -- BEGIN
    -- PERFORM public.dashboard_summary_facts(
    -- gen_random_uuid(), 'billing_hidden', 'UTC', DATE '2026-05-20', 'dashboard-summary-v1'
    -- );
    -- EXCEPTION WHEN insufficient_privilege THEN
    -- v_denied := true;
    -- END;
    -- IF NOT v_denied THEN
    -- RAISE EXCEPTION 'authenticated execution of dashboard fact RPC was not denied.';
    -- END IF;
    SET LOCAL ROLE postgres;

    INSERT INTO auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    VALUES (v_owner, 'authenticated', 'authenticated', 'dashboard-facts-' || replace(v_owner::TEXT, '-', '') || '@example.invalid', '{}', '{}', now(), now());
    INSERT INTO public.studios (id, name, slug, owner_id, timezone)
    VALUES
        (v_small, 'Dashboard Facts Small', 'dashboard-facts-small-' || replace(v_small::TEXT, '-', ''), v_owner, 'America/Los_Angeles'),
        (v_medium, 'Dashboard Facts Medium', 'dashboard-facts-medium-' || replace(v_medium::TEXT, '-', ''), v_owner, 'UTC'),
        (v_large, 'Dashboard Facts Large', 'dashboard-facts-large-' || replace(v_large::TEXT, '-', ''), v_owner, 'UTC');

    INSERT INTO public.students (
        studio_id, legal_first_name, legal_last_name, preferred_name, status,
        hold_start_date, hold_end_date, membership_start_date, emergency_contact_name, created_at
    )
    SELECT
        v_small,
        CASE WHEN series = 0 THEN '' ELSE 'Small' || series END,
        CASE WHEN series = 0 THEN '' ELSE 'Student' END,
        NULL,
        CASE
            WHEN series = 22 THEN 'paused'
            WHEN series = 23 THEN 'inactive'
            WHEN series = 24 THEN 'canceled'
            WHEN series = 21 THEN 'trialing'
            ELSE 'active'
        END,
        CASE WHEN series = 22 THEN DATE '2026-05-20' ELSE NULL END,
        NULL,
        CASE
            WHEN series = 22 THEN DATE '2026-05-10'
            WHEN series = 21 THEN DATE '2026-04-25'
            WHEN series = 20 THEN DATE '2026-03-01'
            ELSE DATE '2026-01-01'
        END,
        CASE WHEN series = 24 THEN NULL ELSE 'Contact ' || series END,
        CASE WHEN series IN (0, 1) THEN TIMESTAMPTZ '2026-05-19 00:00:00+00' ELSE TIMESTAMPTZ '2026-01-01 00:00:00+00' END
    FROM generate_series(0, 24) AS generated(series);
    INSERT INTO public.students (studio_id, legal_first_name, legal_last_name, status, deleted_at)
    VALUES (v_small, 'Deleted', 'Student', 'active', TIMESTAMPTZ '2026-05-01 00:00:00+00');

    INSERT INTO public.students (studio_id, legal_first_name, legal_last_name, status, membership_start_date, created_at)
    SELECT v_medium, 'Medium' || series, 'Student', 'active', DATE '2026-01-01', TIMESTAMPTZ '2026-01-01 00:00:00+00'
    FROM generate_series(1, 250) AS generated(series);
    INSERT INTO public.students (studio_id, legal_first_name, legal_last_name, status, membership_start_date, created_at)
    SELECT v_large, 'Large' || series, 'Student', 'active', DATE '2026-01-01', TIMESTAMPTZ '2026-01-01 00:00:00+00'
    FROM generate_series(1, 2500) AS generated(series);

    INSERT INTO public.leads (studio_id, first_name, last_name, stage, follow_up_date)
    VALUES
        (v_small, 'Due', 'One', 'inquiry', DATE '2026-05-20'),
        (v_small, 'Due', 'Two', 'trial_scheduled', DATE '2026-05-19'),
        (v_small, 'Enrolled', 'One', 'enrolled', DATE '2026-05-20'),
        (v_medium, 'Other', 'Studio', 'inquiry', DATE '2026-05-20');

    INSERT INTO public.class_templates (
        id, studio_id, name, day_of_week, start_time, end_time, start_date, end_date, is_active
    ) VALUES
        (v_template, v_medium, 'Unmaterialized Wednesday', 3, TIME '18:00', TIME '19:00', DATE '2026-01-01', NULL, true),
        (gen_random_uuid(), v_small, 'Non-today Weekly Class', 0, TIME '18:00', TIME '19:00', DATE '2026-01-01', NULL, true);

    FOR v_hour IN 8..14 LOOP
        INSERT INTO public.class_sessions (
            id, studio_id, name, date, start_time, end_time, status, capacity
        ) VALUES (
            CASE WHEN v_hour = 8 THEN v_session ELSE gen_random_uuid() END,
            v_small,
            'Small Class ' || v_hour,
            DATE '2026-05-20',
            make_time(v_hour, 0, 0),
            make_time(v_hour + 1, 0, 0),
            'scheduled',
            10
        );
    END LOOP;
    INSERT INTO public.class_sessions (studio_id, name, date, start_time, end_time, status, capacity, deleted_at)
    VALUES
        (v_small, 'Canceled', DATE '2026-05-20', TIME '20:00', TIME '21:00', 'canceled', 10, NULL),
        (v_small, 'Deleted', DATE '2026-05-20', TIME '21:00', TIME '22:00', 'scheduled', 10, now());

    INSERT INTO public.class_sessions (studio_id, name, date, start_time, end_time, status, capacity)
    SELECT v_medium, 'Medium Plan Class ' || series,
           DATE '2026-04-20' + ((series - 1) % 31),
           make_time(8 + (series % 10), 0, 0),
           make_time(9 + (series % 10), 0, 0),
           'scheduled', 20
    FROM generate_series(1, 120) AS generated(series);
    INSERT INTO public.class_sessions (studio_id, name, date, start_time, end_time, status, capacity)
    SELECT v_large, 'Large Plan Class ' || series,
           DATE '2026-04-20' + ((series - 1) % 31),
           make_time(8 + (series % 10), 0, 0),
           make_time(9 + (series % 10), 0, 0),
           'scheduled', 20
    FROM generate_series(1, 640) AS generated(series);
    INSERT INTO public.class_sessions (studio_id, name, date, start_time, end_time, status, capacity)
    VALUES (v_small, 'Small Out-of-scope Attendance', DATE '2026-01-01', TIME '08:00', TIME '09:00', 'scheduled', 10)
    RETURNING id INTO v_small_noise_session;
    INSERT INTO public.class_sessions (studio_id, name, date, start_time, end_time, status, capacity)
    VALUES (v_medium, 'Medium Out-of-scope Attendance', DATE '2026-01-01', TIME '08:00', TIME '09:00', 'scheduled', 20)
    RETURNING id INTO v_medium_noise_session;
    INSERT INTO public.class_sessions (studio_id, name, date, start_time, end_time, status, capacity)
    VALUES (v_large, 'Large Out-of-scope Attendance', DATE '2026-01-01', TIME '08:00', TIME '09:00', 'scheduled', 20)
    RETURNING id INTO v_large_noise_session;
    INSERT INTO public.attendance (studio_id, session_id, student_id, status, checked_in_at)
    SELECT v_small, v_session, student.id, 'present', TIMESTAMPTZ '2026-05-20 16:00:00+00'
    FROM public.students AS student
    WHERE student.studio_id = v_small
      AND student.deleted_at IS NULL
      AND student.legal_first_name = '';
    INSERT INTO public.attendance (studio_id, session_id, student_id, status, checked_in_at)
    SELECT session.studio_id, session.id, student.id, 'present', session.date + TIME '12:00'
    FROM public.class_sessions AS session
    JOIN LATERAL (
        SELECT student.id
        FROM public.students AS student
        WHERE student.studio_id = session.studio_id
          AND student.deleted_at IS NULL
        ORDER BY student.id
        LIMIT 2
    ) AS student ON true
    WHERE session.name LIKE 'Medium Plan Class %' OR session.name LIKE 'Large Plan Class %';
    INSERT INTO public.attendance (studio_id, session_id, student_id, status, checked_in_at)
    SELECT v_small, v_small_noise_session, student.id, 'present', TIMESTAMPTZ '2026-01-01 12:00:00+00'
    FROM public.students AS student
    WHERE student.studio_id = v_small
      AND student.deleted_at IS NULL
      AND student.id = (
          SELECT candidate.id
          FROM public.students AS candidate
          WHERE candidate.studio_id = v_small AND candidate.deleted_at IS NULL
          ORDER BY candidate.id
          LIMIT 1
      );
    INSERT INTO public.attendance (studio_id, session_id, student_id, status, checked_in_at)
    SELECT noise.studio_id, noise.session_id, student.id, 'present', TIMESTAMPTZ '2026-01-01 12:00:00+00'
    FROM (VALUES (v_medium, v_medium_noise_session), (v_large, v_large_noise_session)) AS noise(studio_id, session_id)
    JOIN LATERAL (
        SELECT student.id
        FROM public.students AS student
        WHERE student.studio_id = noise.studio_id
          AND student.deleted_at IS NULL
        ORDER BY student.id
        LIMIT 2
    ) AS student ON true;

    INSERT INTO public.programs (id, studio_id, name, is_system, archived_at)
    VALUES (v_program, v_small, 'Small Program', false, NULL);
    INSERT INTO public.belt_ladders (id, studio_id, name, program_id)
    VALUES (v_ladder, v_small, 'Small Ladder', v_program);
    INSERT INTO public.belt_ranks (id, studio_id, ladder_id, name, is_tip)
    VALUES (v_rank, v_small, v_ladder, 'White', false), (v_tip, v_small, v_ladder, 'Black', true);

    INSERT INTO public.billing_payers (studio_id, display_name, billing_status)
    VALUES (v_small, 'Small Payer', 'past_due');
    INSERT INTO public.billing_plans (studio_id, name, amount_cents, status, archived_at)
    VALUES (v_small, 'Small Plan', 1000, 'active', NULL);
    INSERT INTO public.billing_invoices (studio_id, status, due_date)
    VALUES (v_small, 'uncollectible', NULL), (v_small, 'open', DATE '2026-05-20');
    INSERT INTO public.studio_payment_accounts (studio_id, charges_enabled)
    VALUES (v_small, true);

    SET LOCAL ROLE service_role;
    v_denied := false;
    BEGIN
        PERFORM public.dashboard_summary_facts(
            v_small, NULL, 'UTC', DATE '2026-05-20', 'dashboard-summary-v1'
        );
    EXCEPTION WHEN SQLSTATE '22023' THEN
        v_denied := true;
    END;
    IF NOT v_denied THEN
        RAISE EXCEPTION 'NULL visibility was not rejected with SQLSTATE 22023.';
    END IF;
    v_denied := false;
    BEGIN
        PERFORM public.dashboard_summary_facts(
            v_small, 'unsupported_visibility', 'UTC', DATE '2026-05-20', 'dashboard-summary-v1'
        );
    EXCEPTION WHEN SQLSTATE '22023' THEN
        v_denied := true;
    END;
    IF NOT v_denied THEN
        RAISE EXCEPTION 'Unsupported visibility was not rejected with SQLSTATE 22023.';
    END IF;
    v_denied := false;
    BEGIN
        PERFORM public.dashboard_summary_facts(
            v_small, 'billing_hidden', 'UTC', DATE '2026-05-20', 'unsupported-formula'
        );
    EXCEPTION WHEN SQLSTATE '22023' THEN
        v_denied := true;
    END;
    IF NOT v_denied THEN
        RAISE EXCEPTION 'Unsupported formula version was not rejected with SQLSTATE 22023.';
    END IF;
    SELECT public.dashboard_summary_facts(
        v_small, 'billing_visible', 'America/Los_Angeles', DATE '2026-05-20', 'dashboard-summary-v1'
    ) INTO v_fact;
    SELECT public.dashboard_summary_facts(
        v_small, 'billing_hidden', 'America/Los_Angeles', DATE '2026-05-20', 'dashboard-summary-v1'
    ) INTO v_hidden_fact;
    SELECT public.dashboard_summary_facts(
        v_medium, 'billing_hidden', 'UTC', DATE '2026-05-20', 'dashboard-summary-v1'
    ) INTO v_medium_fact;
    SELECT public.dashboard_summary_facts(
        v_large, 'billing_hidden', 'UTC', DATE '2026-05-20', 'dashboard-summary-v1'
    ) INTO v_large_fact;

    IF v_fact->'students'->>'total_students' <> '25'
       OR v_fact->'students'->>'active_students' <> '22'
       OR v_fact->'students'->>'trialing_students' <> '1'
       OR v_fact->'students'->>'on_hold_students' <> '1'
       OR v_fact->'emergency_contacts'->>'students_with_contact_name' <> '22'
       OR v_fact->'emergency_contacts'->>'students_missing_contact_name' <> '0' THEN
        RAISE EXCEPTION 'Student, hold, deletion, or emergency formula mismatch: %', v_fact;
    END IF;
    IF v_fact->'leads'->>'active_leads' <> '2'
       OR v_fact->'leads'->>'enrolled_leads' <> '1'
       OR v_fact->'leads'->>'due_today_leads' <> '2' THEN
        RAISE EXCEPTION 'Lead formula mismatch: %', v_fact->'leads';
    END IF;
    IF v_fact->'schedule'->>'today_sessions' <> '7'
       OR (v_fact->'today_schedule'->>'available')::BOOLEAN IS DISTINCT FROM true
       OR jsonb_array_length(v_fact->'today_schedule'->'rows') <> 5
       OR v_fact->'today_schedule'->>'overflow_count' <> '2'
       OR (v_fact->'today_schedule'->'rows'->0->>'id') IS DISTINCT FROM v_session::TEXT
       OR v_fact->'today_schedule'->'rows'->0 ? 'expected_count' THEN
        RAISE EXCEPTION 'Bounded schedule formula mismatch: %', v_fact->'today_schedule';
    END IF;
    IF v_fact->'belts'->>'belt_count' <> '1'
       OR v_fact->'belts'->>'tip_count' <> '1'
       OR v_fact->'inactivity'->>'watch_14' <> '21'
       OR v_fact->'new_students'->>'new_14' <> '1'
       OR v_fact->'new_students'->>'new_30' <> '2'
       OR v_fact->'new_students'->>'new_90' <> '3'
       OR v_fact->'new_students'->>'new_year_to_date' <> '23'
       OR v_fact->'churn'->>'churn_marked_students' <> '2'
       OR (v_fact->'churn'->>'churn_rate')::NUMERIC <> 2.0 / 25.0 THEN
        RAISE EXCEPTION 'Attendance, belt, new-student, or churn formula mismatch: %', v_fact;
    END IF;
    IF v_fact->'operational'->>'attendance_with_capacity' <> '1'
       OR v_fact->'operational'->>'total_capacity' <> '70'
       OR v_fact->'operational'->>'sessions_tracked' <> '7'
       OR (v_fact->'operational'->>'utilization_rate')::NUMERIC <> 1.0 / 70.0 THEN
        RAISE EXCEPTION 'Operational formula mismatch: %', v_fact->'operational';
    END IF;
    IF (v_medium_fact->'operational'->>'attendance_with_capacity')::INTEGER <> 240
       OR (v_large_fact->'operational'->>'attendance_with_capacity')::INTEGER <> 1280
       OR (v_medium_fact->'operational'->>'sessions_tracked')::INTEGER <> 120
       OR (v_large_fact->'operational'->>'sessions_tracked')::INTEGER <> 640 THEN
        RAISE EXCEPTION 'Scoped operational attendance cardinality mismatch: small %, medium %, large %',
            v_fact->'operational', v_medium_fact->'operational', v_large_fact->'operational';
    END IF;
    IF v_fact->'billing'->>'can_view_billing' <> 'true'
       OR v_fact->'billing'->>'payment_attention_count' <> '3'
       OR v_fact->'billing'->>'has_plans' <> 'true'
       OR v_fact->'billing'->>'payments_ready' <> 'true'
       OR v_fact->'billing'->'amounts'->>'available' <> 'false' THEN
        RAISE EXCEPTION 'Billing-visible formula mismatch: %', v_fact->'billing';
    END IF;
    IF v_hidden_fact->'billing'->>'can_view_billing' <> 'false'
       OR v_hidden_fact->'billing'->>'payment_attention_count' IS NOT NULL
       OR v_hidden_fact->'billing' ? 'amounts'
       OR v_hidden_fact->'setup'->>'has_tuition_plans' IS NOT NULL THEN
        RAISE EXCEPTION 'Billing-hidden omission mismatch: %', v_hidden_fact->'billing';
    END IF;
    IF v_fact->'setup'->>'has_programs' <> 'true'
       OR v_fact->'setup'->>'has_students' <> 'true'
       OR v_fact->'setup'->>'has_belt_system' <> 'true'
       OR v_fact->'setup'->>'has_weekly_classes' <> 'true'
       OR jsonb_array_length(v_fact->'recent_students') > 5
       OR jsonb_array_length(v_fact->'actions') > 5 THEN
        RAISE EXCEPTION 'Setup or bounded-array mismatch: %', v_fact->'setup';
    END IF;
    SELECT array_agg(recent.id::TEXT ORDER BY recent.created_at DESC, recent.id DESC)
    INTO v_expected_recent_ids
    FROM (
        SELECT student.id, student.created_at
        FROM public.students AS student
        WHERE student.studio_id = v_small
          AND student.deleted_at IS NULL
        ORDER BY student.created_at DESC, student.id DESC
        LIMIT 5
    ) AS recent;
    SELECT array_agg(item.value->>'id' ORDER BY item.ordinality)
    INTO v_actual_recent_ids
    FROM jsonb_array_elements(v_fact->'recent_students') WITH ORDINALITY AS item(value, ordinality);
    IF v_actual_recent_ids IS DISTINCT FROM v_expected_recent_ids
       OR NOT EXISTS (
           SELECT 1
           FROM jsonb_array_elements(v_fact->'recent_students') AS item(value)
           WHERE item.value->>'display_name' = 'Unnamed student'
       ) THEN
        RAISE EXCEPTION 'Recent-student fallback or deterministic ordering mismatch: expected %, actual %, fact %',
            v_expected_recent_ids, v_actual_recent_ids, v_fact->'recent_students';
    END IF;
    IF (v_medium_fact->'students'->>'total_students')::INTEGER <> 250
       OR (v_large_fact->'students'->>'total_students')::INTEGER <> 2500
       OR (v_medium_fact->'schedule'->>'today_sessions')::INTEGER <> 4
       OR (v_medium_fact->'today_schedule'->>'available')::BOOLEAN IS DISTINCT FROM false
       OR (v_medium_fact->'today_schedule'->>'expected_counts_available')::BOOLEAN IS DISTINCT FROM false
       OR jsonb_array_length(v_medium_fact->'today_schedule'->'rows') <> 0
       OR (v_fact->'leads'->>'active_leads')::INTEGER = (v_medium_fact->'leads'->>'active_leads')::INTEGER THEN
        RAISE EXCEPTION 'Cardinality, recurrence, or tenant filter mismatch: medium students %, large students %, medium today %, medium available %, medium expected %, medium rows %, small leads %, medium leads %',
            v_medium_fact->'students'->>'total_students',
            v_large_fact->'students'->>'total_students',
            v_medium_fact->'schedule'->>'today_sessions',
            v_medium_fact->'today_schedule'->>'available',
            v_medium_fact->'today_schedule'->>'expected_counts_available',
            jsonb_array_length(v_medium_fact->'today_schedule'->'rows'),
            v_fact->'leads'->>'active_leads',
            v_medium_fact->'leads'->>'active_leads';
    END IF;
    IF v_medium_fact->'test_readiness'->>'available' <> 'false'
       OR v_medium_fact->'test_readiness'->>'ready_to_test' IS NOT NULL
       OR v_medium_fact->'test_readiness'->>'needs_approval' IS NOT NULL THEN
        RAISE EXCEPTION 'Unavailable readiness formula mismatch.';
    END IF;

    FOREACH v_profile IN ARRAY ARRAY['small', 'medium', 'large']::TEXT[] LOOP
        v_profile_studio := CASE v_profile WHEN 'small' THEN v_small WHEN 'medium' THEN v_medium ELSE v_large END;
        v_expected_sessions := CASE v_profile WHEN 'small' THEN 7 WHEN 'medium' THEN 120 ELSE 640 END;
        v_expected_schedule_attendance := CASE v_profile WHEN 'small' THEN 1 WHEN 'medium' THEN 6 ELSE 10 END;
        v_expected_operational_attendance := CASE v_profile WHEN 'small' THEN 1 WHEN 'medium' THEN 240 ELSE 1280 END;

        v_plan_sql := format($student_plan$
            EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
            WITH student_rows AS MATERIALIZED (
                SELECT student.id, student.status, student.hold_start_date, student.hold_end_date,
                       student.membership_start_date, student.created_at
                FROM public.students AS student
                WHERE student.studio_id = %L::UUID
                  AND student.deleted_at IS NULL
            ), attendance_last AS MATERIALIZED (
                SELECT attendance.student_id, MAX(attendance.checked_in_at) AS last_checked_in_at
                FROM public.attendance AS attendance
                WHERE attendance.studio_id = %L::UUID
                  AND attendance.status <> 'absent'
                  AND attendance.checked_in_at >= (TIMESTAMP '2026-02-20 00:00:00' AT TIME ZONE 'UTC')
                GROUP BY attendance.student_id
            )
            SELECT COUNT(*) FILTER (
                       WHERE student.status IN ('active', 'trialing', 'paused')
                         AND NOT (
                             student.status = 'paused'
                             OR (student.hold_start_date IS NOT NULL
                                 AND student.hold_start_date <= DATE '2026-05-20'
                                 AND (student.hold_end_date IS NULL OR student.hold_end_date >= DATE '2026-05-20'))
                         )
                         AND COALESCE(
                             (attendance_last.last_checked_in_at AT TIME ZONE 'UTC')::DATE,
                             COALESCE(student.membership_start_date, (student.created_at AT TIME ZONE 'UTC')::DATE)
                         ) <= DATE '2026-05-06'
                   ) AS watch_14,
                   COUNT(*) FILTER (
                       WHERE student.status IN ('active', 'trialing', 'paused')
                         AND NOT (
                             student.status = 'paused'
                             OR (student.hold_start_date IS NOT NULL
                                 AND student.hold_start_date <= DATE '2026-05-20'
                                 AND (student.hold_end_date IS NULL OR student.hold_end_date >= DATE '2026-05-20'))
                         )
                         AND COALESCE(
                             (attendance_last.last_checked_in_at AT TIME ZONE 'UTC')::DATE,
                             COALESCE(student.membership_start_date, (student.created_at AT TIME ZONE 'UTC')::DATE)
                         ) <= DATE '2026-04-20'
                   ) AS watch_30,
                   COUNT(*) FILTER (
                       WHERE student.status IN ('active', 'trialing', 'paused')
                         AND NOT (
                             student.status = 'paused'
                             OR (student.hold_start_date IS NOT NULL
                                 AND student.hold_start_date <= DATE '2026-05-20'
                                 AND (student.hold_end_date IS NULL OR student.hold_end_date >= DATE '2026-05-20'))
                         )
                         AND COALESCE(
                             (attendance_last.last_checked_in_at AT TIME ZONE 'UTC')::DATE,
                             COALESCE(student.membership_start_date, (student.created_at AT TIME ZONE 'UTC')::DATE)
                         ) <= DATE '2026-02-20'
                   ) AS watch_90
            FROM student_rows AS student
            LEFT JOIN attendance_last ON attendance_last.student_id = student.id
        $student_plan$, v_profile_studio, v_profile_studio);
        v_plan := NULL;
        FOR v_plan_row IN EXECUTE v_plan_sql LOOP
            v_plan := (v_plan_row."QUERY PLAN"::JSONB)->0;
        END LOOP;
        IF v_plan IS NULL THEN
            RAISE EXCEPTION 'Student/inactivity plan was not returned for %.', v_profile;
        END IF;
        WITH RECURSIVE plan_nodes(node) AS (
            SELECT v_plan->'Plan'
            UNION ALL
            SELECT child
            FROM plan_nodes AS parent
            CROSS JOIN LATERAL jsonb_array_elements(COALESCE(parent.node->'Plans', '[]'::JSONB)) AS child
        ), attendance_nodes AS (
            SELECT node
            FROM plan_nodes
            WHERE node->>'Relation Name' = 'attendance'
        )
        SELECT
            COUNT(*) FILTER (WHERE (node ? 'Subplan Name' AND node->>'Subplan Name' NOT LIKE 'CTE %') OR node->>'Node Type' = 'SubPlan')::INTEGER,
            COUNT(*) FILTER (WHERE node->>'Relation Name' = 'attendance')::INTEGER,
            MAX((node->>'Actual Loops')::NUMERIC) FILTER (WHERE node->>'Relation Name' = 'attendance'),
            COALESCE(SUM((
                COALESCE((node->>'Actual Rows')::NUMERIC, 0)
                + COALESCE((node->>'Rows Removed by Filter')::NUMERIC, 0)
                + COALESCE((node->>'Rows Removed by Index Recheck')::NUMERIC, 0)
            ) * COALESCE((node->>'Actual Loops')::NUMERIC, 0)
            ) FILTER (WHERE node->>'Relation Name' = 'attendance'), 0),
            (SELECT node->>'Node Type' FROM attendance_nodes ORDER BY node->>'Node Type' LIMIT 1),
            (SELECT (node->>'Actual Rows')::NUMERIC FROM attendance_nodes ORDER BY node->>'Node Type' LIMIT 1),
            (SELECT (node->>'Plan Rows')::NUMERIC FROM attendance_nodes ORDER BY node->>'Node Type' LIMIT 1),
            (SELECT COALESCE((node->>'Rows Removed by Filter')::NUMERIC, 0) FROM attendance_nodes ORDER BY node->>'Node Type' LIMIT 1),
            (SELECT COALESCE((node->>'Shared Hit Blocks')::NUMERIC, 0) FROM attendance_nodes ORDER BY node->>'Node Type' LIMIT 1),
            (SELECT COALESCE((node->>'Shared Read Blocks')::NUMERIC, 0) FROM attendance_nodes ORDER BY node->>'Node Type' LIMIT 1)
        INTO v_subplan_count, v_attendance_scan_count, v_actual_loops, v_attendance_work, v_scan_type,
             v_actual_rows, v_estimated_rows, v_rows_removed, v_shared_hit_blocks, v_shared_read_blocks
        FROM plan_nodes;
        v_planning_time := (v_plan->>'Planning Time')::NUMERIC;
        v_execution_time := (v_plan->>'Execution Time')::NUMERIC;
        IF v_subplan_count <> 0 OR v_attendance_scan_count <> 1
           OR v_attendance_work > v_expected_operational_attendance
           OR v_planning_time IS NULL OR v_execution_time IS NULL THEN
            RAISE EXCEPTION 'Student/inactivity plan is not bounded set-based evidence for %: %', v_profile, v_plan;
        END IF;
        RAISE NOTICE 'dashboard_facts_plan profile=% family=student_inactivity scan=% actual_rows=% estimated_rows=% rows_removed=% loops=% attendance_work=% shared_hit_blocks=% shared_read_blocks=% planning_ms=% execution_ms=%',
            v_profile, v_scan_type, v_actual_rows, v_estimated_rows, v_rows_removed, v_actual_loops, v_attendance_work,
            v_shared_hit_blocks, v_shared_read_blocks, v_planning_time, v_execution_time;

        v_plan_sql := format($schedule_plan$
            EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
            WITH selected_sessions AS MATERIALIZED (
                SELECT session.id, session.start_time
                FROM public.class_sessions AS session
                WHERE session.studio_id = %L::UUID
                  AND session.date >= DATE '2026-05-20'
                  AND session.date < DATE '2026-05-21'
                  AND session.deleted_at IS NULL
                  AND session.status <> 'canceled'
                  AND session.id IS NOT NULL
                  AND session.name IS NOT NULL
                  AND btrim(session.name) <> ''
                  AND session.start_time IS NOT NULL
                  AND session.end_time IS NOT NULL
                ORDER BY session.start_time, session.id
                LIMIT 5
            ), attendance_counts AS MATERIALIZED (
                SELECT attendance.session_id, COUNT(*)::INTEGER AS attendance_count
                FROM public.attendance AS attendance
                JOIN selected_sessions AS selected ON selected.id = attendance.session_id
                WHERE attendance.studio_id = %L::UUID
                  AND attendance.status <> 'absent'
                GROUP BY attendance.session_id
            )
            SELECT COALESCE(SUM(attendance_counts.attendance_count), 0)::INTEGER AS selected_attendance
            FROM selected_sessions
            LEFT JOIN attendance_counts ON attendance_counts.session_id = selected_sessions.id
        $schedule_plan$, v_profile_studio, v_profile_studio);
        v_plan := NULL;
        FOR v_plan_row IN EXECUTE v_plan_sql LOOP
            v_plan := (v_plan_row."QUERY PLAN"::JSONB)->0;
        END LOOP;
        IF v_plan IS NULL THEN
            RAISE EXCEPTION 'Schedule plan was not returned for %.', v_profile;
        END IF;
        WITH RECURSIVE plan_nodes(node) AS (
            SELECT v_plan->'Plan'
            UNION ALL
            SELECT child
            FROM plan_nodes AS parent
            CROSS JOIN LATERAL jsonb_array_elements(COALESCE(parent.node->'Plans', '[]'::JSONB)) AS child
        ), attendance_nodes AS (
            SELECT node
            FROM plan_nodes
            WHERE node->>'Relation Name' = 'attendance'
        )
        SELECT
            COUNT(*) FILTER (WHERE (node ? 'Subplan Name' AND node->>'Subplan Name' NOT LIKE 'CTE %') OR node->>'Node Type' = 'SubPlan')::INTEGER,
            COUNT(*) FILTER (WHERE node->>'Relation Name' = 'attendance')::INTEGER,
            MAX((node->>'Actual Loops')::NUMERIC) FILTER (WHERE node->>'Relation Name' = 'attendance'),
            COALESCE(SUM((
                COALESCE((node->>'Actual Rows')::NUMERIC, 0)
                + COALESCE((node->>'Rows Removed by Filter')::NUMERIC, 0)
                + COALESCE((node->>'Rows Removed by Index Recheck')::NUMERIC, 0)
            ) * COALESCE((node->>'Actual Loops')::NUMERIC, 0)
            ) FILTER (WHERE node->>'Relation Name' = 'attendance'), 0),
            (SELECT node->>'Node Type' FROM attendance_nodes ORDER BY node->>'Node Type' LIMIT 1),
            (SELECT (node->>'Actual Rows')::NUMERIC FROM attendance_nodes ORDER BY node->>'Node Type' LIMIT 1),
            (SELECT (node->>'Plan Rows')::NUMERIC FROM attendance_nodes ORDER BY node->>'Node Type' LIMIT 1),
            (SELECT COALESCE((node->>'Rows Removed by Filter')::NUMERIC, 0) FROM attendance_nodes ORDER BY node->>'Node Type' LIMIT 1),
            (SELECT COALESCE((node->>'Shared Hit Blocks')::NUMERIC, 0) FROM attendance_nodes ORDER BY node->>'Node Type' LIMIT 1),
            (SELECT COALESCE((node->>'Shared Read Blocks')::NUMERIC, 0) FROM attendance_nodes ORDER BY node->>'Node Type' LIMIT 1)
        INTO v_subplan_count, v_attendance_scan_count, v_actual_loops, v_attendance_work, v_scan_type,
             v_actual_rows, v_estimated_rows, v_rows_removed, v_shared_hit_blocks, v_shared_read_blocks
        FROM plan_nodes;
        v_planning_time := (v_plan->>'Planning Time')::NUMERIC;
        v_execution_time := (v_plan->>'Execution Time')::NUMERIC;
        IF v_subplan_count <> 0 OR v_attendance_scan_count <> 1
           OR v_attendance_work > v_expected_schedule_attendance
           OR COALESCE(v_actual_loops, 0) > 5
           OR v_actual_rows IS NULL
           OR v_planning_time IS NULL OR v_execution_time IS NULL THEN
            RAISE EXCEPTION 'Schedule plan is not bounded by selected_sessions for %: %', v_profile, v_plan;
        END IF;
        RAISE NOTICE 'dashboard_facts_plan profile=% family=schedule_projection scan=% actual_rows=% estimated_rows=% rows_removed=% loops=% attendance_work=% shared_hit_blocks=% shared_read_blocks=% planning_ms=% execution_ms=%',
            v_profile, v_scan_type, v_actual_rows, v_estimated_rows, v_rows_removed, v_actual_loops, v_attendance_work,
            v_shared_hit_blocks, v_shared_read_blocks, v_planning_time, v_execution_time;

        v_plan_sql := format($session_plan$
            EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
            WITH operational_sessions AS MATERIALIZED (
                SELECT session.id, session.capacity
                FROM public.class_sessions AS session
                WHERE session.studio_id = %L::UUID
                  AND session.date >= DATE '2026-04-20'
                  AND session.date <= DATE '2026-05-20'
                  AND session.deleted_at IS NULL
                  AND session.status <> 'canceled'
            ), attendance_counts AS MATERIALIZED (
                SELECT attendance.session_id, COUNT(*)::INTEGER AS attendance_count
                FROM public.attendance AS attendance
                JOIN operational_sessions AS session ON session.id = attendance.session_id
                WHERE attendance.studio_id = %L::UUID
                  AND attendance.status <> 'absent'
                GROUP BY attendance.session_id
            )
            SELECT COALESCE(SUM(COALESCE(attendance_counts.attendance_count, 0)), 0)::INTEGER AS total_check_ins,
                   COALESCE(SUM(COALESCE(attendance_counts.attendance_count, 0)) FILTER (WHERE operational_sessions.capacity > 0), 0)::INTEGER AS attendance_with_capacity
            FROM operational_sessions
            LEFT JOIN attendance_counts ON attendance_counts.session_id = operational_sessions.id
        $session_plan$, v_profile_studio, v_profile_studio);
        v_plan := NULL;
        FOR v_plan_row IN EXECUTE v_plan_sql LOOP
            v_plan := (v_plan_row."QUERY PLAN"::JSONB)->0;
        END LOOP;
        IF v_plan IS NULL THEN
            RAISE EXCEPTION 'Session/attendance plan was not returned for %.', v_profile;
        END IF;
        WITH RECURSIVE plan_nodes(node) AS (
            SELECT v_plan->'Plan'
            UNION ALL
            SELECT child
            FROM plan_nodes AS parent
            CROSS JOIN LATERAL jsonb_array_elements(COALESCE(parent.node->'Plans', '[]'::JSONB)) AS child
        ), attendance_nodes AS (
            SELECT node
            FROM plan_nodes
            WHERE node->>'Relation Name' = 'attendance'
        )
        SELECT
            COUNT(*) FILTER (WHERE (node ? 'Subplan Name' AND node->>'Subplan Name' NOT LIKE 'CTE %') OR node->>'Node Type' = 'SubPlan')::INTEGER,
            COUNT(*) FILTER (WHERE node->>'Relation Name' = 'attendance')::INTEGER,
            MAX((node->>'Actual Loops')::NUMERIC) FILTER (WHERE node->>'Relation Name' = 'attendance'),
            COALESCE(SUM((
                COALESCE((node->>'Actual Rows')::NUMERIC, 0)
                + COALESCE((node->>'Rows Removed by Filter')::NUMERIC, 0)
                + COALESCE((node->>'Rows Removed by Index Recheck')::NUMERIC, 0)
            ) * COALESCE((node->>'Actual Loops')::NUMERIC, 0)
            ) FILTER (WHERE node->>'Relation Name' = 'attendance'), 0),
            (SELECT node->>'Node Type' FROM attendance_nodes ORDER BY node->>'Node Type' LIMIT 1),
            (SELECT (node->>'Actual Rows')::NUMERIC FROM attendance_nodes ORDER BY node->>'Node Type' LIMIT 1),
            (SELECT (node->>'Plan Rows')::NUMERIC FROM attendance_nodes ORDER BY node->>'Node Type' LIMIT 1),
            (SELECT COALESCE((node->>'Rows Removed by Filter')::NUMERIC, 0) FROM attendance_nodes ORDER BY node->>'Node Type' LIMIT 1),
            (SELECT COALESCE((node->>'Shared Hit Blocks')::NUMERIC, 0) FROM attendance_nodes ORDER BY node->>'Node Type' LIMIT 1),
            (SELECT COALESCE((node->>'Shared Read Blocks')::NUMERIC, 0) FROM attendance_nodes ORDER BY node->>'Node Type' LIMIT 1)
        INTO v_subplan_count, v_attendance_scan_count, v_actual_loops, v_attendance_work, v_scan_type,
             v_actual_rows, v_estimated_rows, v_rows_removed, v_shared_hit_blocks, v_shared_read_blocks
        FROM plan_nodes;
        v_planning_time := (v_plan->>'Planning Time')::NUMERIC;
        v_execution_time := (v_plan->>'Execution Time')::NUMERIC;
        IF v_subplan_count <> 0 OR v_attendance_scan_count <> 1
           OR v_attendance_work > v_expected_operational_attendance
           OR COALESCE(v_actual_loops, 0) > v_expected_sessions
           OR v_actual_rows IS NULL
           OR v_planning_time IS NULL OR v_execution_time IS NULL THEN
            RAISE EXCEPTION 'Session/attendance plan is not bounded set-based evidence for %: %', v_profile, v_plan;
        END IF;
        RAISE NOTICE 'dashboard_facts_plan profile=% family=session_attendance scan=% actual_rows=% estimated_rows=% rows_removed=% loops=% attendance_work=% shared_hit_blocks=% shared_read_blocks=% planning_ms=% execution_ms=%',
            v_profile, v_scan_type, v_actual_rows, v_estimated_rows, v_rows_removed, v_actual_loops, v_attendance_work,
            v_shared_hit_blocks, v_shared_read_blocks, v_planning_time, v_execution_time;
    END LOOP;

    RAISE NOTICE 'Dashboard summary facts contract verification passed.';
END $$;

ROLLBACK;
