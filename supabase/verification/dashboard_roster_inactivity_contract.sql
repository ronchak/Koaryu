BEGIN;

-- Dashboard watch_14/30/90 counts must equal the roster's inactivity IDs for
-- the same studio and business date. Participation is the class date, with a
-- UTC check-in fallback when the studio has no matching session row.
DO $$
DECLARE
    v_owner UUID := gen_random_uuid();
    v_studio UUID := gen_random_uuid();
    v_other UUID := gen_random_uuid();
    v_medium UUID := gen_random_uuid();
    v_large UUID := gen_random_uuid();
    v_today DATE := DATE '2026-05-20';
    v_moved_session UUID;
    v_fact JSONB;
    v_page JSONB;
    v_window INTEGER;
    v_case_studio UUID;
    v_expected TEXT[];
    v_actual TEXT[];
    v_profile TEXT;
    v_profile_studio UUID;
    v_sample INTEGER;
    v_started TIMESTAMPTZ;
    v_samples DOUBLE PRECISION[];
    v_warmup_ms DOUBLE PRECISION;
    v_median_ms DOUBLE PRECISION;
    v_min_ms DOUBLE PRECISION;
    v_max_ms DOUBLE PRECISION;
    v_attendance_rows BIGINT;
    v_denied BOOLEAN;
BEGIN
    IF to_regprocedure('public.dashboard_summary_facts(uuid,text,text,date,text)') IS NULL
       OR to_regprocedure('public.list_student_roster(uuid,text,text,uuid,integer,text,date,text,text,integer,text,uuid,text)') IS NULL THEN
        RAISE EXCEPTION 'Dashboard or roster read RPC is missing.';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM pg_proc AS procedure
        WHERE procedure.oid = 'public.dashboard_summary_facts(uuid,text,text,date,text)'::REGPROCEDURE
          AND (procedure.prosecdef
               OR procedure.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog']::TEXT[]
               OR procedure.provolatile IS DISTINCT FROM 's')
    ) THEN
        RAISE EXCEPTION 'Dashboard fact RPC security, search_path or volatility changed.';
    END IF;
    IF NOT has_function_privilege('service_role', 'public.dashboard_summary_facts(uuid,text,text,date,text)', 'EXECUTE')
       OR has_function_privilege('anon', 'public.dashboard_summary_facts(uuid,text,text,date,text)', 'EXECUTE')
       OR has_function_privilege('authenticated', 'public.dashboard_summary_facts(uuid,text,text,date,text)', 'EXECUTE')
       OR has_function_privilege('public', 'public.dashboard_summary_facts(uuid,text,text,date,text)', 'EXECUTE') THEN
        RAISE EXCEPTION 'Dashboard fact RPC ACL is not service-role-only.';
    END IF;

    INSERT INTO auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    VALUES (v_owner, 'authenticated', 'authenticated', 'dashboard-roster-' || replace(v_owner::TEXT, '-', '') || '@example.invalid', '{}', '{}', now(), now());
    INSERT INTO public.studios (id, name, slug, owner_id, timezone)
    VALUES
        (v_studio, 'Dashboard Roster Subject', 'dashboard-roster-subject-' || replace(v_studio::TEXT, '-', ''), v_owner, 'America/Los_Angeles'),
        (v_other, 'Dashboard Roster Other', 'dashboard-roster-other-' || replace(v_other::TEXT, '-', ''), v_owner, 'UTC'),
        (v_medium, 'Dashboard Roster Medium', 'dashboard-roster-medium-' || replace(v_medium::TEXT, '-', ''), v_owner, 'UTC'),
        (v_large, 'Dashboard Roster Large', 'dashboard-roster-large-' || replace(v_large::TEXT, '-', ''), v_owner, 'America/New_York');

    -- Each named case records the windows in which the roster must list it.
    CREATE TEMP TABLE dashboard_roster_cases (
        label TEXT PRIMARY KEY,
        studio_id UUID NOT NULL,
        student_id UUID NOT NULL DEFAULT gen_random_uuid(),
        status TEXT NOT NULL,
        membership_start_date DATE,
        created_at TIMESTAMPTZ NOT NULL,
        hold_start_date DATE,
        hold_end_date DATE,
        deleted BOOLEAN NOT NULL DEFAULT false,
        expected_windows INTEGER[] NOT NULL
    ) ON COMMIT DROP;
    INSERT INTO dashboard_roster_cases (label, studio_id, status, membership_start_date, created_at, hold_start_date, hold_end_date, deleted, expected_windows)
    VALUES
        ('delayed_entry', v_studio, 'active', DATE '2026-01-01', TIMESTAMPTZ '2026-01-01 12:00+00', NULL, NULL, false, ARRAY[14]),
        ('future_only', v_studio, 'active', DATE '2026-01-01', TIMESTAMPTZ '2026-01-01 12:00+00', NULL, NULL, false, ARRAY[14, 30, 90]),
        ('future_with_history', v_studio, 'active', DATE '2026-01-01', TIMESTAMPTZ '2026-01-01 12:00+00', NULL, NULL, false, ARRAY[14, 30]),
        ('same_day', v_studio, 'active', DATE '2026-01-01', TIMESTAMPTZ '2026-01-01 12:00+00', NULL, NULL, false, ARRAY[]::INTEGER[]),
        ('old_entry_recent_class', v_studio, 'active', DATE '2026-01-01', TIMESTAMPTZ '2026-01-01 12:00+00', NULL, NULL, false, ARRAY[]::INTEGER[]),
        ('missing_session_utc', v_studio, 'active', DATE '2026-01-01', TIMESTAMPTZ '2026-01-01 12:00+00', NULL, NULL, false, ARRAY[]::INTEGER[]),
        ('old_visit_recent_start', v_studio, 'active', DATE '2026-05-10', TIMESTAMPTZ '2026-05-10 12:00+00', NULL, NULL, false, ARRAY[14, 30, 90]),
        ('created_utc_fallback', v_studio, 'trialing', NULL, TIMESTAMPTZ '2026-05-06 02:00+00', NULL, NULL, false, ARRAY[14]),
        ('recent_start', v_studio, 'trialing', DATE '2026-05-10', TIMESTAMPTZ '2026-05-10 12:00+00', NULL, NULL, false, ARRAY[]::INTEGER[]),
        ('absent_only', v_studio, 'active', DATE '2026-01-01', TIMESTAMPTZ '2026-01-01 12:00+00', NULL, NULL, false, ARRAY[14, 30, 90]),
        ('removed_session', v_studio, 'active', DATE '2026-01-01', TIMESTAMPTZ '2026-01-01 12:00+00', NULL, NULL, false, ARRAY[]::INTEGER[]),
        ('boundary_30', v_studio, 'active', DATE '2026-01-01', TIMESTAMPTZ '2026-01-01 12:00+00', NULL, NULL, false, ARRAY[14, 30]),
        ('boundary_90', v_studio, 'active', DATE '2026-01-01', TIMESTAMPTZ '2026-01-01 12:00+00', NULL, NULL, false, ARRAY[14, 30, 90]),
        ('inside_90', v_studio, 'active', DATE '2026-01-01', TIMESTAMPTZ '2026-01-01 12:00+00', NULL, NULL, false, ARRAY[14, 30]),
        ('hold_ended', v_studio, 'active', DATE '2026-01-01', TIMESTAMPTZ '2026-01-01 12:00+00', DATE '2026-04-01', DATE '2026-05-19', false, ARRAY[14, 30, 90]),
        ('hold_now', v_studio, 'active', DATE '2026-01-01', TIMESTAMPTZ '2026-01-01 12:00+00', DATE '2026-05-01', NULL, false, ARRAY[]::INTEGER[]),
        ('paused', v_studio, 'paused', DATE '2026-01-01', TIMESTAMPTZ '2026-01-01 12:00+00', NULL, NULL, false, ARRAY[]::INTEGER[]),
        ('inactive', v_studio, 'inactive', DATE '2026-01-01', TIMESTAMPTZ '2026-01-01 12:00+00', NULL, NULL, false, ARRAY[]::INTEGER[]),
        ('canceled', v_studio, 'canceled', DATE '2026-01-01', TIMESTAMPTZ '2026-01-01 12:00+00', NULL, NULL, false, ARRAY[]::INTEGER[]),
        ('deleted', v_studio, 'active', DATE '2026-01-01', TIMESTAMPTZ '2026-01-01 12:00+00', NULL, NULL, true, ARRAY[]::INTEGER[]),
        ('other_recent', v_other, 'active', DATE '2026-01-01', TIMESTAMPTZ '2026-01-01 12:00+00', NULL, NULL, false, ARRAY[]::INTEGER[]),
        ('other_quiet', v_other, 'active', DATE '2026-01-01', TIMESTAMPTZ '2026-01-01 12:00+00', NULL, NULL, false, ARRAY[14, 30, 90]);
    INSERT INTO public.students (
        id, studio_id, legal_first_name, legal_last_name, status, membership_start_date,
        created_at, hold_start_date, hold_end_date, deleted_at
    )
    SELECT fixture.student_id, fixture.studio_id, 'Roster', fixture.label, fixture.status,
           fixture.membership_start_date, fixture.created_at, fixture.hold_start_date,
           fixture.hold_end_date, CASE WHEN fixture.deleted THEN TIMESTAMPTZ '2026-05-01 12:00+00' END
    FROM dashboard_roster_cases AS fixture;
    GRANT SELECT ON dashboard_roster_cases TO service_role;

    -- One class per visit keeps (session, student) unique and the dates explicit.
    CREATE TEMP TABLE dashboard_roster_visits (
        label TEXT NOT NULL,
        session_studio_id UUID NOT NULL,
        class_date DATE NOT NULL,
        checked_in_at TIMESTAMPTZ NOT NULL,
        status TEXT NOT NULL DEFAULT 'present',
        session_status TEXT NOT NULL DEFAULT 'scheduled',
        session_deleted BOOLEAN NOT NULL DEFAULT false,
        session_id UUID NOT NULL DEFAULT gen_random_uuid()
    ) ON COMMIT DROP;
    INSERT INTO dashboard_roster_visits (label, session_studio_id, class_date, checked_in_at, status, session_status, session_deleted)
    VALUES
        -- Entered today for a class twenty days ago.
        ('delayed_entry', v_studio, DATE '2026-04-30', TIMESTAMPTZ '2026-05-20 18:00+00', 'present', 'scheduled', false),
        -- Entered today for a class three days from now.
        ('future_only', v_studio, DATE '2026-05-23', TIMESTAMPTZ '2026-05-20 18:00+00', 'present', 'scheduled', false),
        ('future_with_history', v_studio, DATE '2026-05-25', TIMESTAMPTZ '2026-05-20 18:00+00', 'present', 'scheduled', false),
        ('future_with_history', v_studio, DATE '2026-03-01', TIMESTAMPTZ '2026-03-01 18:00+00', 'late', 'scheduled', false),
        ('same_day', v_studio, DATE '2026-05-20', TIMESTAMPTZ '2026-05-20 17:00+00', 'present', 'scheduled', false),
        -- A check-in timestamp older than 90 days attached to a recent class.
        ('old_entry_recent_class', v_studio, DATE '2026-05-15', TIMESTAMPTZ '2026-01-10 18:00+00', 'present', 'scheduled', false),
        -- UTC 2026-05-07 is 2026-05-06 in Los Angeles. The class row is moved
        -- to another studio below, so the roster uses the UTC check-in date.
        ('missing_session_utc', v_studio, DATE '2026-04-01', TIMESTAMPTZ '2026-05-07 02:00+00', 'present', 'scheduled', false),
        ('old_visit_recent_start', v_studio, DATE '2026-01-15', TIMESTAMPTZ '2026-01-15 18:00+00', 'present', 'scheduled', false),
        ('absent_only', v_studio, DATE '2026-05-18', TIMESTAMPTZ '2026-05-18 18:00+00', 'absent', 'scheduled', false),
        ('removed_session', v_studio, DATE '2026-05-17', TIMESTAMPTZ '2026-05-17 18:00+00', 'excused', 'canceled', true),
        ('boundary_30', v_studio, DATE '2026-04-20', TIMESTAMPTZ '2026-04-20 18:00+00', 'present', 'scheduled', false),
        ('boundary_90', v_studio, DATE '2026-02-19', TIMESTAMPTZ '2026-02-19 18:00+00', 'present', 'scheduled', false),
        ('inside_90', v_studio, DATE '2026-02-20', TIMESTAMPTZ '2026-02-20 18:00+00', 'present', 'scheduled', false),
        ('hold_now', v_studio, DATE '2026-01-05', TIMESTAMPTZ '2026-01-05 18:00+00', 'present', 'scheduled', false),
        ('paused', v_studio, DATE '2026-01-05', TIMESTAMPTZ '2026-01-05 18:00+00', 'present', 'scheduled', false),
        ('inactive', v_studio, DATE '2026-01-05', TIMESTAMPTZ '2026-01-05 18:00+00', 'present', 'scheduled', false),
        ('deleted', v_studio, DATE '2026-01-05', TIMESTAMPTZ '2026-01-05 18:00+00', 'present', 'scheduled', false),
        ('other_recent', v_other, DATE '2026-05-20', TIMESTAMPTZ '2026-05-20 12:00+00', 'present', 'scheduled', false),
        -- Another studio's delayed entry for an old class must not leak.
        ('other_quiet', v_other, DATE '2026-01-02', TIMESTAMPTZ '2026-05-20 12:00+00', 'present', 'scheduled', false);
    INSERT INTO public.class_sessions (id, studio_id, name, date, start_time, end_time, status, capacity, deleted_at)
    SELECT visit.session_id, visit.session_studio_id, 'Roster class ' || visit.label, visit.class_date,
           TIME '10:00', TIME '11:00', visit.session_status, 10,
           CASE WHEN visit.session_deleted THEN TIMESTAMPTZ '2026-05-18 12:00+00' END
    FROM dashboard_roster_visits AS visit;
    INSERT INTO public.attendance (studio_id, session_id, student_id, status, checked_in_at)
    SELECT fixture.studio_id, visit.session_id, fixture.student_id, visit.status, visit.checked_in_at
    FROM dashboard_roster_visits AS visit
    JOIN dashboard_roster_cases AS fixture ON fixture.label = visit.label;

    SELECT visit.session_id INTO STRICT v_moved_session
    FROM dashboard_roster_visits AS visit
    WHERE visit.label = 'missing_session_utc';
    UPDATE public.class_sessions SET studio_id = v_other WHERE id = v_moved_session;
    IF NOT EXISTS (
        SELECT 1
        FROM public.attendance AS attendance
        JOIN public.class_sessions AS session ON session.id = attendance.session_id
        WHERE attendance.session_id = v_moved_session
          AND attendance.studio_id = v_studio
          AND session.studio_id = v_other
    ) THEN
        RAISE EXCEPTION 'Missing-session fixture was not established.';
    END IF;

    -- Scaled studios mix delayed entries, future classes and quiet students.
    INSERT INTO public.students (studio_id, legal_first_name, legal_last_name, status, membership_start_date, created_at, hold_start_date, hold_end_date)
    SELECT scaled.studio_id, 'Scaled' || series, 'Student',
           CASE WHEN series % 23 = 0 THEN 'paused' WHEN series % 29 = 0 THEN 'inactive' WHEN series % 31 = 0 THEN 'trialing' ELSE 'active' END,
           CASE WHEN series % 7 = 0 THEN NULL ELSE DATE '2025-03-01' + (series % 420) END,
           TIMESTAMPTZ '2025-03-01 12:00+00' + make_interval(days => series % 430),
           CASE WHEN series % 37 = 0 THEN v_today - 3 END,
           CASE WHEN series % 74 = 0 THEN v_today - 1 END
    FROM (VALUES (v_medium, 250), (v_large, 2500)) AS scaled(studio_id, student_count)
    CROSS JOIN LATERAL generate_series(1, scaled.student_count) AS generated(series);
    INSERT INTO public.class_sessions (studio_id, name, date, start_time, end_time, status, capacity)
    SELECT scaled.studio_id, 'Scaled class ' || day_offset, v_today + day_offset,
           TIME '18:00', TIME '19:00', 'scheduled', 40
    FROM (VALUES (v_medium), (v_large)) AS scaled(studio_id)
    CROSS JOIN generate_series(-400, 10) AS generated(day_offset);
    INSERT INTO public.attendance (studio_id, session_id, student_id, status, checked_in_at)
    SELECT student.studio_id, session.id, student.id,
           CASE WHEN (student.ordinal + day_offset) % 17 = 0 THEN 'absent' ELSE 'present' END,
           (session.date + ((student.ordinal * 7 + day_offset + 400) % 25)) + TIME '12:00'
    FROM (
        SELECT candidate.id, candidate.studio_id,
               row_number() OVER (PARTITION BY candidate.studio_id ORDER BY candidate.legal_first_name)::INTEGER AS ordinal
        FROM public.students AS candidate
        WHERE candidate.studio_id IN (v_medium, v_large)
    ) AS student
    JOIN public.class_sessions AS session ON session.studio_id = student.studio_id
    CROSS JOIN LATERAL (SELECT session.date - v_today AS day_offset) AS offset_day
    WHERE (day_offset + 400 + student.ordinal) % (3 + student.ordinal % 40) = 0
      AND day_offset <= 10 - (student.ordinal % 130);
    SELECT count(*) INTO v_attendance_rows
    FROM public.attendance AS attendance
    WHERE attendance.studio_id IN (v_medium, v_large);
    ANALYZE public.students;
    ANALYZE public.attendance;
    ANALYZE public.class_sessions;

    SET LOCAL ROLE service_role;
    v_denied := false;
    BEGIN
        PERFORM public.list_student_roster(v_studio, NULL, NULL, NULL, 15, NULL, v_today, 'name', 'asc', 200, NULL, NULL, NULL);
    EXCEPTION WHEN SQLSTATE '22023' THEN
        v_denied := true;
    END;
    IF NOT v_denied THEN
        RAISE EXCEPTION 'Unsupported roster inactivity window was not rejected with SQLSTATE 22023.';
    END IF;
    v_denied := false;
    BEGIN
        PERFORM public.dashboard_summary_facts(v_studio, 'billing_hidden', 'America/Los_Angeles', v_today, 'dashboard-summary-v0');
    EXCEPTION WHEN SQLSTATE '22023' THEN
        v_denied := true;
    END;
    IF NOT v_denied THEN
        RAISE EXCEPTION 'Unsupported dashboard formula was not rejected with SQLSTATE 22023.';
    END IF;

    FOREACH v_case_studio IN ARRAY ARRAY[v_studio, v_other]::UUID[] LOOP
        v_fact := public.dashboard_summary_facts(
            v_case_studio, 'billing_hidden',
            CASE WHEN v_case_studio = v_studio THEN 'America/Los_Angeles' ELSE 'UTC' END,
            v_today, 'dashboard-summary-v1'
        );
        FOREACH v_window IN ARRAY ARRAY[14, 30, 90]::INTEGER[] LOOP
            v_page := public.list_student_roster(v_case_studio, NULL, NULL, NULL, v_window, NULL, v_today, 'name', 'asc', 200, NULL, NULL, NULL);
            SELECT array_agg(item.value->>'id' ORDER BY item.value->>'id')
            INTO v_actual
            FROM jsonb_array_elements(v_page->'items') AS item(value);
            SELECT array_agg(fixture.student_id::TEXT ORDER BY fixture.student_id::TEXT)
            INTO v_expected
            FROM dashboard_roster_cases AS fixture
            WHERE fixture.studio_id = v_case_studio
              AND v_window = ANY (fixture.expected_windows);
            IF v_actual IS DISTINCT FROM v_expected
               OR (v_page->>'has_next')::BOOLEAN IS DISTINCT FROM false THEN
                RAISE EXCEPTION 'Roster inactivity % IDs changed: expected %, actual % (%).',
                    v_window, v_expected, v_actual,
                    (SELECT array_agg(fixture.label ORDER BY fixture.label) FROM dashboard_roster_cases AS fixture
                     WHERE fixture.student_id::TEXT = ANY (COALESCE(v_actual, ARRAY[]::TEXT[])));
            END IF;
            IF (v_fact->'inactivity'->>('watch_' || v_window))::INTEGER IS DISTINCT FROM COALESCE(cardinality(v_actual), 0)
               OR (v_page->>'total')::INTEGER IS DISTINCT FROM COALESCE(cardinality(v_actual), 0) THEN
                RAISE EXCEPTION 'Dashboard watch_% % does not match roster IDs % (total %).',
                    v_window, v_fact->'inactivity'->>('watch_' || v_window), v_actual, v_page->>'total';
            END IF;
        END LOOP;
        IF (v_fact->'inactivity'->>'watch_14')::INTEGER > 0 AND NOT EXISTS (
            SELECT 1
            FROM jsonb_array_elements(v_fact->'actions') AS action(value)
            WHERE action.value->>'id' = 'students-going-quiet'
              AND action.value->>'href' = '/students?inactiveDays=14'
              AND action.value->>'title' LIKE 'Reach out to ' || (v_fact->'inactivity'->>'watch_14') || ' %'
        ) THEN
            RAISE EXCEPTION 'Dashboard quiet-student action does not match watch_14: %', v_fact->'actions';
        END IF;
    END LOOP;

    FOREACH v_profile IN ARRAY ARRAY['medium', 'large']::TEXT[] LOOP
        v_profile_studio := CASE v_profile WHEN 'medium' THEN v_medium ELSE v_large END;
        v_fact := public.dashboard_summary_facts(v_profile_studio, 'billing_visible',
            CASE v_profile WHEN 'medium' THEN 'UTC' ELSE 'America/New_York' END, v_today, 'dashboard-summary-v1');
        FOREACH v_window IN ARRAY ARRAY[14, 30, 90]::INTEGER[] LOOP
            v_page := public.list_student_roster(v_profile_studio, NULL, NULL, NULL, v_window, NULL, v_today, 'name', 'asc', 50, NULL, NULL, NULL);
            IF (v_fact->'inactivity'->>('watch_' || v_window))::INTEGER IS DISTINCT FROM (v_page->>'total')::INTEGER
               OR (v_page->>'total')::INTEGER IS NULL
               OR (v_page->>'total')::INTEGER = 0
               OR (v_page->>'total')::INTEGER = (v_fact->'emergency_contacts'->>'active_students')::INTEGER THEN
                RAISE EXCEPTION 'Scaled % watch_% % does not match non-trivial roster total %.',
                    v_profile, v_window, v_fact->'inactivity'->>('watch_' || v_window), v_page->>'total';
            END IF;
        END LOOP;

        -- Timings are diagnostics for the broadened attendance read, not a gate.
        v_started := clock_timestamp();
        PERFORM public.dashboard_summary_facts(v_profile_studio, 'billing_visible',
            CASE v_profile WHEN 'medium' THEN 'UTC' ELSE 'America/New_York' END, v_today, 'dashboard-summary-v1');
        v_warmup_ms := extract(epoch FROM clock_timestamp() - v_started) * 1000;
        v_samples := ARRAY[]::DOUBLE PRECISION[];
        FOR v_sample IN 1..20 LOOP
            v_started := clock_timestamp();
            PERFORM public.dashboard_summary_facts(v_profile_studio, 'billing_visible',
                CASE v_profile WHEN 'medium' THEN 'UTC' ELSE 'America/New_York' END, v_today, 'dashboard-summary-v1');
            v_samples := array_append(v_samples, extract(epoch FROM clock_timestamp() - v_started) * 1000);
        END LOOP;
        SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY value), min(value), max(value)
        INTO v_median_ms, v_min_ms, v_max_ms FROM unnest(v_samples) AS sample(value);
        RAISE NOTICE 'dashboard_roster_inactivity_samples profile=% watch_14=% watch_30=% watch_90=% scaled_attendance_rows=% warmup_ms=% sample_count=20 median_ms=% min_ms=% max_ms=%',
            v_profile, v_fact->'inactivity'->>'watch_14', v_fact->'inactivity'->>'watch_30',
            v_fact->'inactivity'->>'watch_90', v_attendance_rows, v_warmup_ms, v_median_ms, v_min_ms, v_max_ms;
    END LOOP;

    RAISE NOTICE 'Dashboard roster inactivity contract verification passed.';
END $$;

ROLLBACK;
