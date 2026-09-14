BEGIN;

DO $$
DECLARE
    v_owner UUID := gen_random_uuid();
    v_empty UUID := gen_random_uuid();
    v_sample INTEGER;
    v_started TIMESTAMPTZ;
    v_samples DOUBLE PRECISION[];
    v_warmup_ms DOUBLE PRECISION;
    v_median_ms DOUBLE PRECISION;
    v_min_ms DOUBLE PRECISION;
    v_max_ms DOUBLE PRECISION;
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
    v_expected_recent_ids TEXT[];
    v_actual_recent_ids TEXT[];
    v_profile_studio UUID;
    v_profile TEXT;
    v_hour INTEGER;
    v_denied BOOLEAN;
BEGIN
    IF to_regprocedure('public.dashboard_summary_facts(uuid,text,text,date,text)') IS NULL THEN
        RAISE EXCEPTION 'Dashboard fact RPC is missing.';
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

    INSERT INTO auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    VALUES (v_owner, 'authenticated', 'authenticated', 'dashboard-facts-' || replace(v_owner::TEXT, '-', '') || '@example.invalid', '{}', '{}', now(), now());
    INSERT INTO public.studios (id, name, slug, owner_id, timezone)
    VALUES
        (v_empty, 'Dashboard Facts Empty', 'dashboard-facts-empty-' || replace(v_empty::TEXT, '-', ''), v_owner, 'UTC'),
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

    -- Expand independent non-roster dimensions after the focused formula checks.
    INSERT INTO public.leads (studio_id, first_name, last_name, stage)
    SELECT v_large, 'Duplicate', 'Name', 'inquiry' FROM generate_series(1, 5000);
    INSERT INTO public.billing_invoices (studio_id, status, due_date)
    SELECT v_medium, 'open', DATE '2026-05-20' FROM generate_series(1, 200);
    INSERT INTO public.billing_invoices (studio_id, status, due_date)
    SELECT v_large, 'open', DATE '2026-05-20' FROM generate_series(1, 201);
    v_fact := public.dashboard_summary_facts(v_empty, 'billing_visible', 'UTC', DATE '2026-05-20', 'dashboard-summary-v1');
    IF (v_fact->'students'->>'total_students')::INTEGER <> 0
       OR (v_fact->'leads'->>'active_leads')::INTEGER <> 0 THEN
        RAISE EXCEPTION 'Empty studio leaked facts from populated studios.';
    END IF;
    v_fact := public.dashboard_summary_facts(v_large, 'billing_visible', 'UTC', DATE '2026-05-20', 'dashboard-summary-v1');
    IF (v_fact->'leads'->>'active_leads')::INTEGER <> 5000
       OR (v_fact->'billing'->>'payment_attention_count')::INTEGER <> 201 THEN
        RAISE EXCEPTION 'Scaled lead or uncapped invoice fact mismatch.';
    END IF;

    FOREACH v_profile IN ARRAY ARRAY['small', 'medium', 'large']::TEXT[] LOOP
        v_profile_studio := CASE v_profile WHEN 'small' THEN v_small WHEN 'medium' THEN v_medium ELSE v_large END;
        -- Measure the RPC itself. Copied EXPLAIN fragments and row-visit limits
        -- reject valid planner choices; these timings are diagnostics, not a gate.
        v_started := clock_timestamp();
        PERFORM public.dashboard_summary_facts(v_profile_studio, 'billing_visible',
            CASE v_profile WHEN 'small' THEN 'America/Los_Angeles' ELSE 'UTC' END,
            DATE '2026-05-20', 'dashboard-summary-v1');
        v_warmup_ms := extract(epoch FROM clock_timestamp() - v_started) * 1000;
        v_samples := ARRAY[]::DOUBLE PRECISION[];
        FOR v_sample IN 1..20 LOOP
            v_started := clock_timestamp();
            PERFORM public.dashboard_summary_facts(v_profile_studio, 'billing_visible',
                CASE v_profile WHEN 'small' THEN 'America/Los_Angeles' ELSE 'UTC' END,
                DATE '2026-05-20', 'dashboard-summary-v1');
            v_samples := array_append(v_samples, extract(epoch FROM clock_timestamp() - v_started) * 1000);
        END LOOP;
        SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY value), min(value), max(value)
        INTO v_median_ms, v_min_ms, v_max_ms FROM unnest(v_samples) AS sample(value);
        RAISE NOTICE 'dashboard_facts_samples profile=% warmup_count=1 warmup_ms=% sample_count=20 median_ms=% min_ms=% max_ms=%',
            v_profile, v_warmup_ms, v_median_ms, v_min_ms, v_max_ms;
    END LOOP;

    RAISE NOTICE 'Dashboard summary facts contract verification passed.';
END $$;

ROLLBACK;
