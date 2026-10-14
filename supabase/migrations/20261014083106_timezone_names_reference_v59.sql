-- V59 caches accepted timezone names; conversions still use PostgreSQL's live rules.
-- Require the exact supported predecessor before changing any installed object.
DO $predecessor$
DECLARE v RECORD;
BEGIN
    SELECT * INTO v FROM public.koaryu_release_schema_preflight_v39();
    IF v.ready IS DISTINCT FROM TRUE OR v.migration_count IS DISTINCT FROM 153
       OR v.migration_head IS DISTINCT FROM '20261013013243'
       OR v.manifest_version IS DISTINCT FROM 'release-db-attestation-v58' THEN
        RAISE EXCEPTION 'V59 requires exact V58 readiness: %', row_to_json(v);
    END IF;
END;
$predecessor$;

CREATE TABLE private.timezone_names (name TEXT PRIMARY KEY);
ALTER TABLE private.timezone_names OWNER TO postgres;
ALTER TABLE private.timezone_names ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE private.timezone_names FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE private.timezone_names TO service_role;
INSERT INTO private.timezone_names(name) SELECT name FROM pg_catalog.pg_timezone_names;

CREATE FUNCTION private.timezone_name_known(p_name TEXT) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog
AS $function$
    SELECT EXISTS(SELECT 1 FROM private.timezone_names WHERE name = p_name)
$function$;

CREATE FUNCTION private.timezone_name_or_utc(p_name TEXT) RETURNS TEXT
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog
AS $function$
    SELECT CASE WHEN private.timezone_name_known(p_name) THEN p_name ELSE 'UTC' END
$function$;

ALTER FUNCTION private.timezone_name_known(TEXT) OWNER TO postgres;
ALTER FUNCTION private.timezone_name_or_utc(TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.timezone_name_known(TEXT), private.timezone_name_or_utc(TEXT)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.timezone_name_known(TEXT), private.timezone_name_or_utc(TEXT)
    TO service_role;


-- Retain 20260523183427_atomic_studio_onboarding.sql semantics and existing function privileges.
CREATE OR REPLACE FUNCTION public.create_studio_onboarding(
    p_user_id UUID,
    p_name TEXT,
    p_timezone TEXT DEFAULT 'America/New_York',
    p_idempotency_key TEXT DEFAULT NULL
)
RETURNS SETOF public.studios
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public, private
AS $$
DECLARE
    v_name TEXT := btrim(COALESCE(p_name, ''));
    v_timezone TEXT := btrim(COALESCE(p_timezone, 'America/New_York'));
    v_key TEXT := NULLIF(btrim(COALESCE(p_idempotency_key, '')), '');
    v_slug_base TEXT;
    v_slug TEXT;
    v_request_hash TEXT;
    v_existing_request private.studio_creation_requests%ROWTYPE;
    v_studio public.studios%ROWTYPE;
BEGIN
    IF p_user_id IS NULL THEN
        RAISE EXCEPTION 'User id is required.'
            USING ERRCODE = '22023';
    END IF;

    IF v_name = '' THEN
        RAISE EXCEPTION 'Studio name is required.'
            USING ERRCODE = '22023';
    END IF;

    IF v_timezone = '' THEN
        RAISE EXCEPTION 'Timezone is required.'
            USING ERRCODE = '22023';
    END IF;

    IF NOT private.timezone_name_known(v_timezone) THEN
        RAISE EXCEPTION 'Choose a valid timezone.'
            USING ERRCODE = '22023';
    END IF;

    IF v_key IS NOT NULL AND char_length(v_key) > 200 THEN
        RAISE EXCEPTION 'Idempotency key is too long.'
            USING ERRCODE = '22023';
    END IF;

    PERFORM pg_advisory_xact_lock(
        hashtext('koaryu_studio_onboarding'),
        hashtext(p_user_id::TEXT)
    );

    v_request_hash := md5(v_name || chr(31) || v_timezone);

    IF v_key IS NOT NULL THEN
        SELECT *
        INTO v_existing_request
        FROM private.studio_creation_requests
        WHERE user_id = p_user_id
          AND idempotency_key = v_key
        FOR UPDATE;

        IF FOUND THEN
            IF v_existing_request.request_hash <> v_request_hash THEN
                RAISE EXCEPTION 'Idempotency key was already used for a different studio creation request.'
                    USING ERRCODE = '23505';
            END IF;

            IF v_existing_request.studio_id IS NULL THEN
                RAISE EXCEPTION 'Idempotent studio creation record is missing its studio.'
                    USING ERRCODE = 'P0002';
            END IF;

            RETURN QUERY
            SELECT *
            FROM public.studios
            WHERE id = v_existing_request.studio_id;

            IF NOT FOUND THEN
                RAISE EXCEPTION 'Idempotent studio creation record references a missing studio.'
                    USING ERRCODE = 'P0002';
            END IF;

            RETURN;
        END IF;
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.staff_roles
        WHERE user_id = p_user_id
    ) OR EXISTS (
        SELECT 1
        FROM public.studios
        WHERE owner_id = p_user_id
    ) THEN
        RAISE EXCEPTION 'You already have a studio. Only one studio per account in v1.'
            USING ERRCODE = '23505';
    END IF;

    IF v_key IS NOT NULL THEN
        INSERT INTO private.studio_creation_requests (
            user_id,
            idempotency_key,
            request_hash
        )
        VALUES (
            p_user_id,
            v_key,
            v_request_hash
        );
    END IF;

    v_slug_base := btrim(
        regexp_replace(
            regexp_replace(
                regexp_replace(lower(v_name), '[^[:alnum:]_[:space:]-]', '', 'g'),
                '[[:space:]_]+',
                '-',
                'g'
            ),
            '-+',
            '-',
            'g'
        ),
        '-'
    );

    IF v_slug_base = '' THEN
        v_slug_base := 'studio';
    END IF;

    v_slug := v_slug_base || '-' || substr(replace(gen_random_uuid()::TEXT, '-', ''), 1, 6);

    INSERT INTO public.studios (
        name,
        slug,
        owner_id,
        timezone
    )
    VALUES (
        v_name,
        v_slug,
        p_user_id,
        v_timezone
    )
    RETURNING * INTO v_studio;

    INSERT INTO public.staff_roles (
        studio_id,
        user_id,
        role
    )
    VALUES (
        v_studio.id,
        p_user_id,
        'admin'
    );

    INSERT INTO public.audit_logs (
        studio_id,
        actor_id,
        action,
        entity_type,
        entity_id,
        metadata
    )
    VALUES (
        v_studio.id,
        p_user_id,
        'studio.created',
        'studio',
        v_studio.id,
        jsonb_build_object('name', v_name)
    );

    INSERT INTO public.studio_subscriptions (
        studio_id,
        status,
        comped,
        current_period_start
    )
    VALUES (
        v_studio.id,
        'incomplete',
        false,
        now()
    );

    IF v_key IS NOT NULL THEN
        UPDATE private.studio_creation_requests
        SET studio_id = v_studio.id,
            updated_at = now()
        WHERE user_id = p_user_id
          AND idempotency_key = v_key;
    END IF;

    RETURN NEXT v_studio;
    RETURN;
END;
$$;


-- Retain 20260929152445_dashboard_roster_inactivity_v53.sql semantics and existing function privileges.
CREATE OR REPLACE FUNCTION public.dashboard_summary_facts(p_studio_id uuid, p_visibility text, p_timezone_name text, p_local_date date, p_formula_version text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
    v_studio RECORD;
    v_timezone TEXT;
    v_weekday INTEGER;
    v_lookback_14 DATE := p_local_date - 14;
    v_lookback_30 DATE := p_local_date - 30;
    v_lookback_90 DATE := p_local_date - 90;
    v_year_start DATE := make_date(EXTRACT(YEAR FROM p_local_date)::INTEGER, 1, 1);
    v_students JSONB;
    v_student_counts RECORD;
    v_emergency_contacts RECORD;
    v_lead_counts RECORD;
    v_schedule_counts RECORD;
    v_today_schedule JSONB;
    v_belt_counts RECORD;
    v_inactivity_counts RECORD;
    v_new_student_counts RECORD;
    v_operational_counts RECORD;
    v_operational_base RECORD;
    v_operational_attendance RECORD;
    v_churn_counts RECORD;
    v_billing_counts RECORD;
    v_setup_flags RECORD;
    v_recent_students JSONB;
    v_actions JSONB := '[]'::JSONB;
BEGIN
    IF p_formula_version IS DISTINCT FROM 'dashboard-summary-v1' THEN
        RAISE EXCEPTION 'Unsupported dashboard summary formula version: %', p_formula_version
            USING ERRCODE = '22023';
    END IF;
    IF p_visibility IS NULL OR p_visibility NOT IN ('billing_visible', 'billing_hidden') THEN
        RAISE EXCEPTION 'Unsupported dashboard summary visibility: %', p_visibility
            USING ERRCODE = '22023';
    END IF;
    IF p_studio_id IS NULL OR p_local_date IS NULL THEN
        RAISE EXCEPTION 'Dashboard summary studio and local date are required'
            USING ERRCODE = '22004';
    END IF;

    SELECT studio.id, studio.name, studio.timezone
    INTO v_studio
    FROM public.studios AS studio
    WHERE studio.id = p_studio_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Dashboard summary studio does not exist'
            USING ERRCODE = 'P0002';
    END IF;

    SELECT CASE
        WHEN private.timezone_name_known(p_timezone_name) THEN p_timezone_name
        ELSE 'UTC'
    END
    INTO v_timezone;
    v_weekday := (EXTRACT(DOW FROM p_local_date)::INTEGER);

    -- This is the same bounded student projection used by the current
    -- service. It intentionally excludes contact fields other than the
    -- response's emergency-contact name signal.
    WITH student_rows AS (
        SELECT
            student.id,
            student.legal_first_name,
            student.legal_last_name,
            student.preferred_name,
            student.status,
            student.hold_start_date,
            student.hold_end_date,
            student.membership_start_date,
            student.created_at,
            student.emergency_contact_name,
            COALESCE(student.membership_start_date, (student.created_at AT TIME ZONE 'UTC')::DATE) AS start_date,
            (
                student.status = 'paused'
                OR (
                    student.hold_start_date IS NOT NULL
                    AND student.hold_start_date <= p_local_date
                    AND (student.hold_end_date IS NULL OR student.hold_end_date >= p_local_date)
                )
            ) AS on_hold_now
        FROM public.students AS student
        WHERE student.studio_id = p_studio_id
          AND student.deleted_at IS NULL
    ), attendance_last AS (
        -- Participation dates match list_student_roster: a visit counts on its
        -- class date, falls back to the UTC check-in date without a session and
        -- ignores future classes. Entry time does not bound the history.
        SELECT attendance.student_id,
               MAX(
                   CASE
                       WHEN COALESCE(
                           class_session.date,
                           (attendance.checked_in_at AT TIME ZONE 'UTC')::DATE
                       ) <= p_local_date
                       THEN COALESCE(
                           class_session.date,
                           (attendance.checked_in_at AT TIME ZONE 'UTC')::DATE
                       )
                       ELSE NULL
                   END
               ) AS last_attendance_date
        FROM public.attendance AS attendance
        LEFT JOIN public.class_sessions AS class_session
          ON class_session.id = attendance.session_id
         AND class_session.studio_id = p_studio_id
        WHERE attendance.studio_id = p_studio_id
          AND attendance.status <> 'absent'
        GROUP BY attendance.student_id
    ), student_facts AS (
        SELECT
            COUNT(*)::INTEGER AS total_students,
            COUNT(*) FILTER (WHERE student.status IN ('active', 'trialing'))::INTEGER AS active_students,
            COUNT(*) FILTER (WHERE student.status = 'trialing')::INTEGER AS trialing_students,
            COUNT(*) FILTER (WHERE student.on_hold_now)::INTEGER AS on_hold_students,
            COUNT(*) FILTER (
                WHERE student.status IN ('active', 'trialing')
                  AND student.emergency_contact_name IS NOT NULL
                  AND student.emergency_contact_name <> ''
            )::INTEGER AS students_with_contact_name,
            COUNT(*) FILTER (
                WHERE student.status IN ('active', 'trialing', 'paused')
                  AND student.start_date IS NOT NULL
                  AND student.start_date >= v_lookback_14
                  AND student.start_date <= p_local_date
            )::INTEGER AS new_14,
            COUNT(*) FILTER (
                WHERE student.status IN ('active', 'trialing', 'paused')
                  AND student.start_date IS NOT NULL
                  AND student.start_date >= v_lookback_30
                  AND student.start_date <= p_local_date
            )::INTEGER AS new_30,
            COUNT(*) FILTER (
                WHERE student.status IN ('active', 'trialing', 'paused')
                  AND student.start_date IS NOT NULL
                  AND student.start_date >= v_lookback_90
                  AND student.start_date <= p_local_date
            )::INTEGER AS new_90,
            COUNT(*) FILTER (
                WHERE student.status IN ('active', 'trialing', 'paused')
                  AND student.start_date IS NOT NULL
                  AND student.start_date >= v_year_start
                  AND student.start_date <= p_local_date
            )::INTEGER AS new_year_to_date,
            COUNT(*) FILTER (
                WHERE student.status IN ('active', 'trialing', 'paused')
                  AND NOT student.on_hold_now
                  AND COALESCE(
                      attendance_last.last_attendance_date,
                      student.start_date
                  ) <= p_local_date - 14
            )::INTEGER AS watch_14,
            COUNT(*) FILTER (
                WHERE student.status IN ('active', 'trialing', 'paused')
                  AND NOT student.on_hold_now
                  AND COALESCE(
                      attendance_last.last_attendance_date,
                      student.start_date
                  ) <= p_local_date - 30
            )::INTEGER AS watch_30,
            COUNT(*) FILTER (
                WHERE student.status IN ('active', 'trialing', 'paused')
                  AND NOT student.on_hold_now
                  AND COALESCE(
                      attendance_last.last_attendance_date,
                      student.start_date
                  ) <= p_local_date - 90
            )::INTEGER AS watch_90,
            COUNT(*) FILTER (WHERE student.status = 'inactive')::INTEGER AS inactive_students,
            COUNT(*) FILTER (WHERE student.status = 'canceled')::INTEGER AS canceled_students
        FROM student_rows AS student
        LEFT JOIN attendance_last
          ON attendance_last.student_id = student.id
    )
    SELECT * INTO v_student_counts FROM student_facts;
    v_students := jsonb_build_object(
        'total_students', v_student_counts.total_students,
        'active_students', v_student_counts.active_students,
        'trialing_students', v_student_counts.trialing_students,
        'on_hold_students', v_student_counts.on_hold_students
    );
    SELECT true AS available,
           v_student_counts.active_students AS active_students,
           v_student_counts.students_with_contact_name AS students_with_contact_name,
           GREATEST(0, v_student_counts.active_students - v_student_counts.students_with_contact_name)
             AS students_missing_contact_name
    INTO v_emergency_contacts;
    SELECT v_student_counts.watch_14 AS watch_14,
           v_student_counts.watch_30 AS watch_30,
           v_student_counts.watch_90 AS watch_90
    INTO v_inactivity_counts;
    SELECT v_student_counts.new_14 AS new_14,
           v_student_counts.new_30 AS new_30,
           v_student_counts.new_90 AS new_90,
           v_student_counts.new_year_to_date AS new_year_to_date
    INTO v_new_student_counts;
    SELECT v_student_counts.inactive_students AS inactive_students,
           v_student_counts.canceled_students AS canceled_students,
           v_student_counts.inactive_students + v_student_counts.canceled_students AS churn_marked_students,
           CASE WHEN v_student_counts.total_students > 0
                THEN (v_student_counts.inactive_students + v_student_counts.canceled_students)::NUMERIC / v_student_counts.total_students
                ELSE NULL END AS churn_rate
    INTO v_churn_counts;

    SELECT
        COUNT(*) FILTER (WHERE lead.stage IN ('inquiry', 'trial_scheduled', 'trial_completed', 'offer_sent'))::INTEGER AS active_leads,
        COUNT(*) FILTER (WHERE lead.stage = 'enrolled')::INTEGER AS enrolled_leads,
        COUNT(*) FILTER (
            WHERE lead.stage IN ('inquiry', 'trial_scheduled', 'trial_completed', 'offer_sent')
              AND lead.follow_up_date <= p_local_date
        )::INTEGER AS due_today_leads
    INTO v_lead_counts
    FROM public.leads AS lead
    WHERE lead.studio_id = p_studio_id;

    WITH today_sessions AS (
        SELECT session.id, session.template_id, session.name, session.start_time,
               session.end_time, session.capacity, session.status, session.deleted_at
        FROM public.class_sessions AS session
        WHERE session.studio_id = p_studio_id
          AND session.date >= p_local_date
          AND session.date < p_local_date + 1
    ), represented_templates AS (
        SELECT DISTINCT today_session.template_id
        FROM today_sessions AS today_session
        WHERE today_session.template_id IS NOT NULL
    ), applicable_templates AS (
        SELECT template.id
        FROM public.class_templates AS template
        WHERE template.studio_id = p_studio_id
          AND template.is_active = true
          AND template.day_of_week = v_weekday
          AND (template.start_date IS NULL OR template.start_date <= p_local_date)
          AND (template.end_date IS NULL OR template.end_date >= p_local_date)
    ), live_sessions AS (
        SELECT today_session.*
        FROM today_sessions AS today_session
        WHERE today_session.deleted_at IS NULL
          AND today_session.status <> 'canceled'
    ), validated_sessions AS (
        SELECT live_session.*
        FROM live_sessions AS live_session
        WHERE live_session.id IS NOT NULL
          AND live_session.name IS NOT NULL
          AND btrim(live_session.name) <> ''
          AND live_session.start_time IS NOT NULL
          AND live_session.end_time IS NOT NULL
    ), schedule_facts AS (
        SELECT
            (SELECT COUNT(*) FROM live_sessions)::INTEGER
              + (SELECT COUNT(*) FROM applicable_templates AS template WHERE NOT EXISTS (
                    SELECT 1 FROM represented_templates AS represented WHERE represented.template_id = template.id
                ))::INTEGER AS today_sessions,
            EXISTS (
                SELECT 1 FROM applicable_templates AS template WHERE NOT EXISTS (
                    SELECT 1 FROM represented_templates AS represented WHERE represented.template_id = template.id
                )
            ) AS has_unmaterialized,
            NOT EXISTS (
                  SELECT 1 FROM live_sessions AS live_session
                  WHERE live_session.id IS NULL
                     OR live_session.name IS NULL
                     OR btrim(live_session.name) = ''
                     OR live_session.start_time IS NULL
                     OR live_session.end_time IS NULL
              ) AS rows_valid
    )
    SELECT * INTO v_schedule_counts FROM schedule_facts;

    IF v_schedule_counts.has_unmaterialized OR NOT v_schedule_counts.rows_valid THEN
        v_today_schedule := jsonb_build_object(
            'available', false,
            'expected_counts_available', false,
            'rows', '[]'::JSONB
        );
    ELSE
        WITH selected_sessions AS MATERIALIZED (
            SELECT live_session.*
            FROM public.class_sessions AS live_session
            WHERE live_session.studio_id = p_studio_id
              AND live_session.date >= p_local_date
              AND live_session.date < p_local_date + 1
              AND live_session.deleted_at IS NULL
              AND live_session.status <> 'canceled'
              AND live_session.id IS NOT NULL
              AND live_session.name IS NOT NULL
              AND btrim(live_session.name) <> ''
              AND live_session.start_time IS NOT NULL
              AND live_session.end_time IS NOT NULL
            ORDER BY live_session.start_time, live_session.id
            LIMIT 5
        ), attendance_counts AS MATERIALIZED (
            SELECT attendance.session_id, COUNT(*)::INTEGER AS attendance_count
            FROM public.attendance AS attendance
            JOIN selected_sessions AS selected ON selected.id = attendance.session_id
            WHERE attendance.studio_id = p_studio_id
              AND attendance.status <> 'absent'
            GROUP BY attendance.session_id
        )
        SELECT jsonb_build_object(
            'available', true,
            'expected_counts_available', false,
            'rows', COALESCE((
                SELECT jsonb_agg(
                    jsonb_build_object(
                        'id', selected.id,
                        'start_time', selected.start_time::TEXT,
                        'end_time', selected.end_time::TEXT,
                        'name', selected.name,
                        'capacity', selected.capacity,
                        'attendance_count', COALESCE(attendance_counts.attendance_count, 0)
                    ) ORDER BY selected.start_time, selected.id
                )
                FROM selected_sessions AS selected
                LEFT JOIN attendance_counts ON attendance_counts.session_id = selected.id
            ), '[]'::JSONB),
            'overflow_count', GREATEST(0, (
                SELECT COUNT(*)::INTEGER
                FROM public.class_sessions AS live_session
                WHERE live_session.studio_id = p_studio_id
                  AND live_session.date >= p_local_date
                  AND live_session.date < p_local_date + 1
                  AND live_session.deleted_at IS NULL
                  AND live_session.status <> 'canceled'
                  AND live_session.id IS NOT NULL
                  AND live_session.name IS NOT NULL
                  AND btrim(live_session.name) <> ''
                  AND live_session.start_time IS NOT NULL
                  AND live_session.end_time IS NOT NULL
            ) - 5)
        ) INTO v_today_schedule;
    END IF;

    SELECT
        (SELECT COUNT(*) FROM public.class_sessions AS session
         WHERE session.studio_id = p_studio_id
           AND session.date >= v_lookback_30
           AND session.date <= p_local_date
           AND session.deleted_at IS NULL
           AND session.status <> 'canceled')::INTEGER AS sessions_tracked,
        COALESCE((SELECT SUM(session.capacity) FROM public.class_sessions AS session
         WHERE session.studio_id = p_studio_id
           AND session.date >= v_lookback_30
           AND session.date <= p_local_date
           AND session.deleted_at IS NULL
           AND session.status <> 'canceled'
           AND session.capacity > 0), 0)::INTEGER AS total_capacity,
        (SELECT COUNT(*) FROM public.class_sessions AS session
         WHERE session.studio_id = p_studio_id
           AND session.date >= v_lookback_30
           AND session.date <= p_local_date
           AND session.deleted_at IS NULL
           AND session.status <> 'canceled'
           AND session.capacity > 0)::INTEGER AS sessions_with_capacity
    INTO v_operational_base;
    WITH operational_sessions AS MATERIALIZED (
        SELECT session.id, session.capacity
        FROM public.class_sessions AS session
        WHERE session.studio_id = p_studio_id
          AND session.date >= v_lookback_30
          AND session.date <= p_local_date
          AND session.deleted_at IS NULL
          AND session.status <> 'canceled'
    ), attendance_counts AS MATERIALIZED (
        SELECT attendance.session_id, COUNT(*)::INTEGER AS attendance_count
        FROM public.attendance AS attendance
        JOIN operational_sessions AS session ON session.id = attendance.session_id
        WHERE attendance.studio_id = p_studio_id
          AND attendance.status <> 'absent'
        GROUP BY attendance.session_id
    )
    SELECT
        COALESCE(SUM(COALESCE(attendance_counts.attendance_count, 0)), 0)::INTEGER AS total_check_ins,
        COALESCE(SUM(COALESCE(attendance_counts.attendance_count, 0)) FILTER (WHERE operational_sessions.capacity > 0), 0)::INTEGER AS attendance_with_capacity
    INTO STRICT v_operational_attendance
    FROM operational_sessions
    LEFT JOIN attendance_counts ON attendance_counts.session_id = operational_sessions.id;

    SELECT
        COALESCE(v_operational_attendance.attendance_with_capacity, 0)::INTEGER AS attendance_with_capacity,
        COALESCE(v_operational_base.total_capacity, 0)::INTEGER AS total_capacity,
        COALESCE(v_operational_base.sessions_tracked, 0)::INTEGER AS sessions_tracked,
        COALESCE(v_operational_base.sessions_with_capacity, 0)::INTEGER AS sessions_with_capacity,
        CASE WHEN COALESCE(v_operational_base.total_capacity, 0) > 0
             THEN v_operational_attendance.attendance_with_capacity::NUMERIC / v_operational_base.total_capacity
             ELSE NULL END AS utilization_rate,
        CASE WHEN COALESCE(v_operational_base.sessions_tracked, 0) > 0
             THEN v_operational_attendance.total_check_ins::NUMERIC / v_operational_base.sessions_tracked
             ELSE 0 END AS average_attendance
    INTO v_operational_counts;

    SELECT
        COUNT(*) FILTER (WHERE program.is_system = false AND program.archived_at IS NULL)::INTEGER AS program_count,
        COUNT(*) FILTER (WHERE program.is_system = false AND program.archived_at IS NULL)::INTEGER > 0 AS has_programs
    INTO v_setup_flags
    FROM public.programs AS program
    WHERE program.studio_id = p_studio_id;

    SELECT
        COUNT(*) FILTER (WHERE rank.is_tip = false)::INTEGER AS belt_count,
        COUNT(*) FILTER (WHERE rank.is_tip = true)::INTEGER AS tip_count
    INTO v_belt_counts
    FROM public.belt_ranks AS rank
    WHERE rank.studio_id = p_studio_id
      AND rank.ladder_id IN (
          SELECT ladder.id
          FROM public.belt_ladders AS ladder
          WHERE ladder.studio_id = p_studio_id
            AND ladder.program_id IN (
                SELECT program.id
                FROM public.programs AS program
                WHERE program.studio_id = p_studio_id
                  AND program.is_system = false
                  AND program.archived_at IS NULL
            )
      );

    IF p_visibility = 'billing_visible' THEN
        SELECT
            true AS can_view_billing,
            public.billing_attention_count_v1(p_studio_id,p_local_date) AS payment_attention_count,
            EXISTS (SELECT 1 FROM public.billing_plans AS plan WHERE plan.studio_id = p_studio_id AND plan.archived_at IS NULL) AS has_plans,
            COALESCE((SELECT account.charges_enabled FROM public.studio_payment_accounts AS account WHERE account.studio_id = p_studio_id), false) AS payments_ready
        INTO v_billing_counts;
    ELSE
        SELECT false AS can_view_billing, NULL::INTEGER AS payment_attention_count,
               NULL::BOOLEAN AS has_plans, NULL::BOOLEAN AS payments_ready
        INTO v_billing_counts;
    END IF;

    SELECT
        (v_setup_flags.has_programs)::BOOLEAN AS has_programs,
        (v_student_counts.total_students > 0)::BOOLEAN AS has_students,
        (v_belt_counts.belt_count > 0)::BOOLEAN AS has_belt_system,
        (
            EXISTS (SELECT 1 FROM public.class_templates AS template WHERE template.studio_id = p_studio_id AND template.is_active = true)
            OR EXISTS (SELECT 1 FROM public.class_sessions AS session WHERE session.studio_id = p_studio_id AND session.deleted_at IS NULL)
            OR v_schedule_counts.today_sessions > 0
        )::BOOLEAN AS has_weekly_classes,
        CASE WHEN v_billing_counts.can_view_billing THEN v_billing_counts.has_plans ELSE NULL END AS has_tuition_plans
    INTO v_setup_flags;

    SELECT COALESCE(jsonb_agg(
        jsonb_build_object(
            'id', student.id,
            'display_name', COALESCE(NULLIF(btrim(COALESCE(NULLIF(student.preferred_name, ''), student.legal_first_name, '') || ' ' || COALESCE(student.legal_last_name, '')), ''), 'Unnamed student'),
            'status', COALESCE(student.status, 'active'),
            'started_on', COALESCE(student.membership_start_date::TEXT, (student.created_at AT TIME ZONE 'UTC')::DATE::TEXT)
        ) ORDER BY student.created_at DESC, student.id DESC
    ), '[]'::JSONB)
    INTO v_recent_students
    FROM (
        SELECT student.*
        FROM public.students AS student
        WHERE student.studio_id = p_studio_id
          AND student.deleted_at IS NULL
        ORDER BY student.created_at DESC, student.id DESC
        LIMIT 5
    ) AS student;

    IF v_lead_counts.due_today_leads > 0 THEN
        v_actions := v_actions || jsonb_build_array(jsonb_build_object(
            'id', 'lead-followups',
            'title', format('Follow up with %s %s', v_lead_counts.due_today_leads, CASE WHEN v_lead_counts.due_today_leads = 1 THEN 'lead' ELSE 'leads' END),
            'description', 'These prospects are due today. Handle them before the next class block gets busy.',
            'href', '/leads', 'tone', 'accent', 'meta', 'Today'
        ));
    ELSIF v_lead_counts.active_leads = 0 THEN
        v_actions := v_actions || jsonb_build_array(jsonb_build_object(
            'id', 'first-lead', 'title', 'Add your first lead',
            'description', 'Track a trial student or parent inquiry so follow-ups do not live in someone''s memory.',
            'href', '/leads', 'tone', 'accent', 'meta', NULL
        ));
    END IF;
    IF v_schedule_counts.today_sessions > 0 THEN
        v_actions := v_actions || jsonb_build_array(jsonb_build_object(
            'id', 'today-classes',
            'title', format('Check in %s %s', v_schedule_counts.today_sessions, CASE WHEN v_schedule_counts.today_sessions = 1 THEN 'class' ELSE 'classes' END),
            'description', 'Open today''s schedule, mark attendance, and keep promotion progress accurate.',
            'href', '/schedule', 'tone', 'warning', 'meta', p_local_date::TEXT
        ));
    END IF;
    IF v_belt_counts.belt_count = 0 THEN
        v_actions := v_actions || jsonb_build_array(jsonb_build_object(
            'id', 'belt-system', 'title', 'Set up your belt system',
            'description', 'Add ranks and promotion rules before your first test cycle arrives.',
            'href', '/belt-tracker', 'tone', 'success', 'meta', NULL
        ));
    END IF;
    IF v_student_counts.watch_14 > 0 THEN
        v_actions := v_actions || jsonb_build_array(jsonb_build_object(
            'id', 'students-going-quiet',
            'title', format('Reach out to %s %s going quiet', v_student_counts.watch_14, CASE WHEN v_student_counts.watch_14 = 1 THEN 'student' ELSE 'students' END),
            'description', 'They have crossed 14 days without attendance and are not currently on hold.',
            'href', '/students?inactiveDays=14', 'tone', 'warning', 'meta', NULL
        ));
    END IF;
    IF v_billing_counts.can_view_billing AND v_billing_counts.payment_attention_count > 0 THEN
        v_actions := v_actions || jsonb_build_array(jsonb_build_object(
            'id', 'payment-issues',
            'title', format('Fix %s %s', v_billing_counts.payment_attention_count, CASE WHEN v_billing_counts.payment_attention_count = 1 THEN 'tuition issue' ELSE 'tuition issues' END),
            'description', 'Review failed payments, past-due families, and invoices that need manual attention.',
            'href', '/billing', 'tone', 'danger', 'meta', NULL
        ));
    ELSIF v_billing_counts.can_view_billing AND v_billing_counts.payments_ready IS false THEN
        v_actions := v_actions || jsonb_build_array(jsonb_build_object(
            'id', 'payments-setup', 'title', 'Finish payment setup',
            'description', 'Create tuition plans or finish Stripe Connect when you are ready to collect through Koaryu.',
            'href', '/billing', 'tone', 'neutral', 'meta', NULL
        ));
    END IF;
    SELECT COALESCE(jsonb_agg(value ORDER BY ordinal), '[]'::JSONB)
    INTO v_actions
    FROM jsonb_array_elements(v_actions) WITH ORDINALITY AS action(value, ordinal)
    WHERE ordinal <= 5;

    RETURN jsonb_build_object(
        'formula_version', p_formula_version,
        'studio', jsonb_build_object('id', v_studio.id, 'name', v_studio.name, 'timezone', v_timezone),
        'today', p_local_date,
        'timezone', v_timezone,
        'today_schedule', v_today_schedule,
        'emergency_contacts', jsonb_build_object(
            'available', v_emergency_contacts.available,
            'active_students', v_emergency_contacts.active_students,
            'students_with_contact_name', v_emergency_contacts.students_with_contact_name,
            'students_missing_contact_name', v_emergency_contacts.students_missing_contact_name
        ),
        'students', v_students,
        'leads', jsonb_build_object('active_leads', v_lead_counts.active_leads, 'enrolled_leads', v_lead_counts.enrolled_leads, 'due_today_leads', v_lead_counts.due_today_leads),
        'schedule', jsonb_build_object('today_sessions', v_schedule_counts.today_sessions),
        'belts', jsonb_build_object('belt_count', v_belt_counts.belt_count, 'tip_count', v_belt_counts.tip_count),
        'inactivity', jsonb_build_object('watch_14', v_inactivity_counts.watch_14, 'watch_30', v_inactivity_counts.watch_30, 'watch_90', v_inactivity_counts.watch_90),
        'new_students', jsonb_build_object('new_14', v_new_student_counts.new_14, 'new_30', v_new_student_counts.new_30, 'new_90', v_new_student_counts.new_90, 'new_year_to_date', v_new_student_counts.new_year_to_date),
        'operational', jsonb_build_object('attendance_with_capacity', v_operational_counts.attendance_with_capacity, 'total_capacity', v_operational_counts.total_capacity, 'sessions_tracked', v_operational_counts.sessions_tracked, 'sessions_with_capacity', v_operational_counts.sessions_with_capacity, 'utilization_rate', v_operational_counts.utilization_rate, 'average_attendance', v_operational_counts.average_attendance),
        'churn', jsonb_build_object('inactive_students', v_churn_counts.inactive_students, 'canceled_students', v_churn_counts.canceled_students, 'churn_marked_students', v_churn_counts.churn_marked_students, 'churn_rate', v_churn_counts.churn_rate),
        'test_readiness', jsonb_build_object('ready_to_test', NULL, 'needs_approval', NULL, 'available', false),
        'billing', jsonb_build_object(
            'can_view_billing', v_billing_counts.can_view_billing,
            'payment_attention_count', v_billing_counts.payment_attention_count,
            'has_plans', v_billing_counts.has_plans,
            'payments_ready', v_billing_counts.payments_ready
        ) || CASE WHEN v_billing_counts.can_view_billing THEN jsonb_build_object('amounts', jsonb_build_object('available', false)) ELSE '{}'::JSONB END,
        'setup', jsonb_build_object('has_programs', v_setup_flags.has_programs, 'has_students', v_setup_flags.has_students, 'has_belt_system', v_setup_flags.has_belt_system, 'has_weekly_classes', v_setup_flags.has_weekly_classes, 'has_tuition_plans', v_setup_flags.has_tuition_plans),
        'recent_students', v_recent_students,
        'actions', v_actions
    );
END;
$function$;


-- Retain 20261005105341_automation_workflow_graph_v57.sql semantics and existing function privileges.
CREATE OR REPLACE FUNCTION public.follow_up_lead_atomic(
    p_studio_id UUID, p_actor_id UUID, p_lead_id UUID, p_operation_id UUID, p_request JSONB
)
RETURNS public.leads
LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $function$
DECLARE
    v_lead public.leads;
    v_result public.leads;
    v_receipt public.lead_follow_up_operations;
    v_request JSONB;
    v_stage TEXT;
    v_program UUID;
    v_program_archived TIMESTAMPTZ;
    v_student UUID;
    v_guardian UUID;
    v_link UUID;
    v_digest BYTEA;
    v_timezone TEXT;
    v_start DATE;
BEGIN
    IF NOT pg_catalog.pg_try_advisory_xact_lock_shared(pg_catalog.hashtextextended('koaryu.local-plan-clear:'||p_studio_id::TEXT,0)) THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='LEAD_STUDIO_BUSY';
    END IF;
    -- Use the existing narrow Auth-owner helper before locking memberships or
    -- leads. Account cleanup locks Auth first and then visits these FK children.
    IF NOT private.lock_student_import_actor(p_actor_id) THEN
        RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='Lead management permission required.';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM public.staff_roles WHERE studio_id=p_studio_id
          AND user_id=p_actor_id AND archived_at IS NULL
          AND role IN ('admin','front_desk')
    ) THEN
        RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='Lead management permission required.';
    END IF;
    PERFORM 1 FROM public.staff_roles
    WHERE studio_id=p_studio_id AND user_id=p_actor_id
      AND archived_at IS NULL AND role IN ('admin','front_desk') FOR SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='Lead management permission required.';
    END IF;
    -- Use the same membership-before-studio order as staff administration.
    BEGIN
        PERFORM 1 FROM public.studios WHERE id=p_studio_id FOR KEY SHARE NOWAIT;
    EXCEPTION WHEN lock_not_available THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='LEAD_STUDIO_BUSY';
    END;
    IF p_operation_id IS NULL OR p_request IS NULL OR jsonb_typeof(p_request) <> 'object' THEN
        RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='A keyed follow-up request is required.';
    END IF;
    IF EXISTS(SELECT 1 FROM jsonb_object_keys(p_request) AS fields(name) WHERE name <> 'next_stage')
       OR (p_request ? 'next_stage' AND jsonb_typeof(p_request->'next_stage') NOT IN ('null','string')) THEN
        RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Unsupported follow-up request.';
    END IF;
    v_stage := p_request->>'next_stage';
    IF v_stage IS NOT NULL AND v_stage <> ALL(ARRAY['inquiry','trial_scheduled','trial_completed',
        'offer_sent','enrolled','closed_lost']) THEN
        RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Unsupported follow-up stage.';
    END IF;
    -- Keep conversion authorization explicit even while its roles match lead management.
    IF v_stage='enrolled' AND NOT EXISTS(SELECT 1 FROM public.staff_roles
        WHERE studio_id=p_studio_id AND user_id=p_actor_id AND archived_at IS NULL
        AND role IN ('admin','front_desk')) THEN
        RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='Lead conversion permission required.';
    END IF;
    v_request := jsonb_build_object('next_stage',v_stage);
    -- A global operation identity also rejects reuse for another tenant or lead.
    -- This lock precedes the lead lock for every follow-up caller.
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
        'lead-follow-up:' || p_operation_id::text,0));
    SELECT * INTO v_receipt FROM public.lead_follow_up_operations WHERE operation_id=p_operation_id;
    IF FOUND THEN
        IF v_receipt.studio_id IS DISTINCT FROM p_studio_id
           OR v_receipt.actor_id IS DISTINCT FROM p_actor_id
           OR v_receipt.lead_id IS DISTINCT FROM p_lead_id
           OR v_receipt.request IS DISTINCT FROM v_request THEN
            RAISE EXCEPTION USING ERRCODE='23505', MESSAGE='Follow-up operation identity conflict.';
        END IF;
        RETURN jsonb_populate_record(NULL::public.leads,v_receipt.result);
    END IF;
    SELECT * INTO v_lead FROM public.leads
    WHERE id=p_lead_id AND studio_id=p_studio_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0002', MESSAGE='Lead not found for studio.';
    END IF;
    IF v_stage='enrolled' THEN
        IF v_lead.converted_student_id IS NOT NULL THEN
            -- Restoring the existing conversion must also work after the lead's
            -- original program was archived or its interest was cleared.
            SELECT * INTO v_result FROM public.convert_lead_to_student_atomic(
                p_studio_id,p_actor_id,p_lead_id,v_lead.converted_student_id,
                NULL,NULL,NULL,NULL,NULL);
        ELSE
            v_program := v_lead.program_id;
            IF v_program IS NULL THEN
                SELECT id INTO v_program FROM public.programs
                WHERE studio_id=p_studio_id AND name='Unassigned' LIMIT 1;
                IF v_program IS NULL THEN
                    INSERT INTO public.programs(studio_id,name,description,color_hex,sort_order,is_system)
                    VALUES(p_studio_id,'Unassigned','Students awaiting program assignment.','#94A3B8',9999,TRUE)
                    ON CONFLICT (studio_id,lower(name)) WHERE archived_at IS NULL DO NOTHING
                    RETURNING id INTO v_program;
                    IF v_program IS NULL THEN
                        SELECT id INTO v_program FROM public.programs
                        WHERE studio_id=p_studio_id AND name='Unassigned' AND archived_at IS NULL;
                    END IF;
                END IF;
            END IF;
            BEGIN
                SELECT archived_at INTO v_program_archived FROM public.programs
                WHERE id=v_program AND studio_id=p_studio_id FOR SHARE NOWAIT;
            EXCEPTION WHEN lock_not_available THEN
                RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='LEAD_STUDIO_BUSY';
            END;
            IF NOT FOUND THEN
                RAISE EXCEPTION USING ERRCODE='P0002', MESSAGE='Program not found for studio.';
            END IF;
            IF v_program_archived IS NOT NULL THEN
                RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='PROGRAM_INACTIVE', DETAIL=v_program::text;
            END IF;
            -- RFC 4122 UUIDv5, identical to LeadService's established namespace/names.
            v_digest := substring(extensions.digest(uuid_send('27c8322f-a4e4-46d7-bfae-018f6b638858'::uuid)
                || convert_to(p_studio_id::text || ':' || p_lead_id::text || ':student','UTF8'),'sha1') FROM 1 FOR 16);
            v_student := encode(set_byte(set_byte(v_digest,6,(get_byte(v_digest,6) & 15) | 80),
                8,(get_byte(v_digest,8) & 63) | 128),'hex')::uuid;
            v_digest := substring(extensions.digest(uuid_send('27c8322f-a4e4-46d7-bfae-018f6b638858'::uuid)
                || convert_to(p_studio_id::text || ':' || p_lead_id::text || ':guardian','UTF8'),'sha1') FROM 1 FOR 16);
            v_guardian := encode(set_byte(set_byte(v_digest,6,(get_byte(v_digest,6) & 15) | 80),
                8,(get_byte(v_digest,8) & 63) | 128),'hex')::uuid;
            v_digest := substring(extensions.digest(uuid_send('27c8322f-a4e4-46d7-bfae-018f6b638858'::uuid)
                || convert_to(v_student::text || ':' || v_guardian::text || ':link','UTF8'),'sha1') FROM 1 FOR 16);
            v_link := encode(set_byte(set_byte(v_digest,6,(get_byte(v_digest,6) & 15) | 80),
                8,(get_byte(v_digest,8) & 63) | 128),'hex')::uuid;
            SELECT COALESCE(NULLIF(timezone,''),'UTC') INTO v_timezone FROM public.studios WHERE id=p_studio_id;
            IF NOT private.timezone_name_known(v_timezone) THEN
                v_timezone := 'UTC';
            END IF;
            v_start := (CURRENT_TIMESTAMP AT TIME ZONE v_timezone)::date;
            SELECT * INTO v_result FROM public.convert_lead_to_student_atomic(p_studio_id,p_actor_id,p_lead_id,
                v_student,v_program,'active',v_start,v_guardian,v_link);
        END IF;
    ELSE
        SELECT * INTO v_result FROM public.update_lead_atomic(p_studio_id,p_actor_id,p_lead_id,
            jsonb_build_object('follow_up_date',NULL) ||
            CASE WHEN v_stage IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('stage',v_stage) END);
    END IF;
    INSERT INTO public.lead_activities(studio_id,lead_id,activity_type,description,created_by)
    VALUES(p_studio_id,p_lead_id,'follow_up',CASE WHEN v_stage IS NULL THEN 'Contacted lead'
        ELSE 'Contacted lead and moved to ' || v_stage END,p_actor_id);
    INSERT INTO public.lead_follow_up_operations(operation_id,studio_id,actor_id,lead_id,request,result)
    VALUES(p_operation_id,p_studio_id,p_actor_id,p_lead_id,v_request,to_jsonb(v_result));
    RETURN v_result;
END;
$function$;


-- Retain 20260930024404_student_profile_qa_v54.sql semantics and existing function privileges.
CREATE OR REPLACE FUNCTION public.student_business_date(p_studio_id UUID)
RETURNS DATE
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
    v_timezone TEXT;
BEGIN
    SELECT COALESCE(NULLIF(studio.timezone, ''), 'UTC') INTO v_timezone
    FROM public.studios AS studio WHERE studio.id = p_studio_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Student studio not found.' USING ERRCODE = '23503';
    END IF;
    IF NOT private.timezone_name_known(v_timezone) THEN
        v_timezone := 'UTC';
    END IF;
    RETURN (CURRENT_TIMESTAMP AT TIME ZONE v_timezone)::DATE;
END;
$$;


-- Retain 20261004220435_missed_class_automation_v56.sql semantics and existing function privileges.
CREATE OR REPLACE FUNCTION private.missed_class_automation_candidates(
    p_studio_id UUID,p_inactivity_days INTEGER,p_student_id UUID DEFAULT NULL,p_delivery_id UUID DEFAULT NULL,
    p_reference_at TIMESTAMPTZ DEFAULT clock_timestamp()
) RETURNS TABLE(student_id UUID,student_name TEXT,student_first_name TEXT,studio_name TEXT,
    reference_date DATE,last_attendance_date DATE,days_absent INTEGER,attendance_id UUID,
    attendance_checked_in_at TIMESTAMPTZ,attendance_occurred_at TIMESTAMPTZ,
    recipient_name TEXT,recipient_email TEXT,recipient_kind TEXT,skip_reason TEXT)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path='' AS $$
WITH studio_zone AS MATERIALIZED (
    SELECT s.id,s.name,
        private.timezone_name_or_utc(s.timezone) AS timezone FROM public.studios s WHERE s.id=p_studio_id
), studio_clock AS MATERIALIZED (
    SELECT z.*,(p_reference_at AT TIME ZONE z.timezone)::date AS today,p_reference_at AS reference_at
    FROM studio_zone z WHERE isfinite(p_reference_at)
), facts AS MATERIALIZED (
    SELECT s.*,c.name AS studio_name,c.today,c.timezone,
        CASE WHEN s.date_of_birth IS NULL THEN COALESCE(s.is_minor,false)
            WHEN isfinite(s.date_of_birth) AND s.date_of_birth<=c.today
            THEN s.date_of_birth>(c.today-INTERVAL '18 years')::date ELSE NULL END AS minor,
        a.id AS attendance_id,a.date AS attendance_date,a.checked_in_at,a.occurred_at,
        g.valid_count,g.primary_count,g.valid_primary_count,g.primary_email,g.primary_name,g.any_email,g.any_name
    FROM public.students s JOIN studio_clock c ON c.id=s.studio_id
    LEFT JOIN LATERAL (
        SELECT a.id,cs.date,a.checked_in_at,(cs.date+cs.start_time) AT TIME ZONE c.timezone AS occurred_at
        FROM public.attendance a JOIN public.class_sessions cs ON cs.id=a.session_id AND cs.studio_id=s.studio_id
        WHERE a.studio_id=s.studio_id AND a.student_id=s.id AND a.status IN ('present','late')
            AND cs.deleted_at IS NULL AND cs.status IS DISTINCT FROM 'canceled'
            AND isfinite(cs.date) AND cs.date<=c.today AND isfinite(a.checked_in_at) AND a.checked_in_at<=c.reference_at
            AND (cs.date+cs.start_time) AT TIME ZONE c.timezone<=c.reference_at
        ORDER BY cs.date DESC,cs.start_time DESC,a.checked_in_at DESC,a.id DESC LIMIT 1
    ) a ON true
    LEFT JOIN LATERAL (
        SELECT count(*) FILTER (WHERE private.automation_normalize_email(g.email) IS NOT NULL) AS valid_count,
            count(*) FILTER (WHERE g.is_primary_contact) AS primary_count,
            count(*) FILTER (WHERE g.is_primary_contact AND private.automation_normalize_email(g.email) IS NOT NULL) AS valid_primary_count,
            max(private.automation_normalize_email(g.email)) FILTER (WHERE g.is_primary_contact) AS primary_email,
            max(g.first_name||' '||g.last_name) FILTER (WHERE g.is_primary_contact) AS primary_name,
            max(private.automation_normalize_email(g.email)) AS any_email,max(g.first_name||' '||g.last_name) FILTER (WHERE private.automation_normalize_email(g.email) IS NOT NULL) AS any_name
        FROM public.student_guardians sg JOIN public.guardians g ON g.id=sg.guardian_id AND g.studio_id=s.studio_id
        WHERE sg.student_id=s.id
    ) g ON true
    WHERE s.studio_id=p_studio_id AND (p_student_id IS NULL OR s.id=p_student_id)
), routed AS MATERIALIZED (
    SELECT f.*,CASE WHEN minor THEN CASE WHEN primary_count=1 AND valid_primary_count=1 THEN primary_email
            WHEN primary_count<=1 AND valid_count=1 THEN any_email END
        ELSE private.automation_normalize_email(email) END AS routed_email,
        CASE WHEN minor THEN CASE WHEN primary_count=1 AND valid_primary_count=1 THEN primary_name
            WHEN primary_count<=1 AND valid_count=1 THEN any_name END
        ELSE legal_first_name||' '||legal_last_name END AS routed_name
    FROM facts f
)
SELECT r.id,r.legal_first_name||' '||r.legal_last_name,COALESCE(NULLIF(r.preferred_name,''),r.legal_first_name),
    r.studio_name,r.today,r.attendance_date,r.today-r.attendance_date,r.attendance_id,r.checked_in_at,r.occurred_at,
    r.routed_name,r.routed_email,CASE WHEN minor THEN 'guardian' ELSE 'student' END,
    CASE WHEN r.deleted_at IS NOT NULL THEN 'student_unavailable'
        WHEN r.status<>'active' THEN 'inactive'
        WHEN r.hold_start_date IS NOT NULL AND r.hold_start_date<=r.today
            AND (r.hold_end_date IS NULL OR r.hold_end_date>=r.today) THEN 'on_hold'
        WHEN r.minor IS NULL THEN 'invalid_birth_date'
        WHEN r.attendance_id IS NULL THEN 'never_attended'
        WHEN r.today-r.attendance_date<p_inactivity_days THEN 'recent_attendance'
        WHEN r.minor AND (r.primary_count>1 OR (r.valid_primary_count=0 AND r.valid_count>1)) THEN 'guardian_ambiguous'
        WHEN r.minor AND r.routed_email IS NULL THEN 'guardian_missing'
        WHEN r.routed_email IS NULL THEN 'invalid_email'
        WHEN EXISTS(SELECT 1 FROM public.automation_suppressions x WHERE x.studio_id=p_studio_id AND x.recipient_email=r.routed_email) THEN 'suppressed'
        WHEN EXISTS(SELECT 1 FROM public.automation_deliveries d WHERE d.studio_id=p_studio_id AND d.student_id=r.id
            AND d.attempted_at IS NOT NULL AND d.id IS DISTINCT FROM p_delivery_id
            AND NOT (r.attendance_id<>d.attendance_id AND r.attendance_date>d.attendance_date AND r.checked_in_at>d.attempted_at AND r.occurred_at>d.attempted_at))
            THEN 'episode_already_attempted'
    END
FROM routed r
$$;


-- Retain 20261004220435_missed_class_automation_v56.sql semantics and existing function privileges.
CREATE OR REPLACE FUNCTION public.preview_missed_class_automation_v1(p_studio_id UUID,p_actor_id UUID,p_inactivity_days INTEGER) RETURNS JSONB
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE v_result JSONB; v_reference_at TIMESTAMPTZ;
BEGIN
    PERFORM private.automation_require_admin(p_studio_id,p_actor_id);
    IF p_inactivity_days IS NULL OR p_inactivity_days NOT BETWEEN 1 AND 90 THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid inactivity days.';
    END IF;
    v_reference_at:=clock_timestamp();
    WITH candidates AS MATERIALIZED (SELECT * FROM private.missed_class_automation_candidates(p_studio_id,p_inactivity_days,NULL,NULL,v_reference_at)),
    sample AS (SELECT * FROM candidates ORDER BY (skip_reason IS NOT NULL),student_name,student_id LIMIT 100)
    SELECT jsonb_build_object('reference_date',(SELECT (v_reference_at AT TIME ZONE
        private.timezone_name_or_utc(s.timezone))::date
        FROM public.studios s WHERE s.id=p_studio_id),
        'eligible_count',(SELECT count(*) FROM candidates WHERE skip_reason IS NULL),
        'skipped_count',(SELECT count(*) FROM candidates WHERE skip_reason IS NOT NULL),
        'recipients',COALESCE((SELECT jsonb_agg(jsonb_build_object('student_id',student_id,'student_name',student_name,
            'student_first_name',student_first_name,'studio_name',studio_name,'last_attendance_date',last_attendance_date,
            'days_absent',days_absent,'recipient_name',recipient_name,'recipient_email',recipient_email,
            'recipient_kind',recipient_kind,'skip_reason',skip_reason) ORDER BY (skip_reason IS NOT NULL),student_name,student_id) FROM sample),'[]'::jsonb),
        'truncated',(SELECT count(*)>100 FROM candidates)) INTO v_result;
    RETURN v_result;
END $$;


-- Retain 20261005105341_automation_workflow_graph_v57.sql semantics and existing function privileges.
CREATE OR REPLACE FUNCTION private.automation_timezone_v1(p_value JSONB) RETURNS TEXT
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $$
DECLARE v TEXT;
BEGIN
    v:=p_value#>>'{}';
    IF jsonb_typeof(p_value) IS DISTINCT FROM 'string' OR length(v)>128
        OR v !~ '^[A-Za-z0-9._+-]+(/[A-Za-z0-9._+-]+)*$'
        OR v ~ '(^|/)(\.|\.\.)(/|$)' OR split_part(v,'/',1) IN ('localtime','posixrules','posix','right')
        OR NOT private.timezone_name_known(v) THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
    END IF;
    RETURN v;
END $$;


-- Retain 20261005105341_automation_workflow_graph_v57.sql semantics and existing function privileges.
CREATE OR REPLACE FUNCTION public.approve_belt_test_recipients_v1(
    p_studio_id UUID,p_actor_id UUID,p_event_id UUID,p_operation_id UUID,p_expected_event_revision BIGINT,p_recipients JSONB
) RETURNS JSONB LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
DECLARE event public.belt_test_events; ladder public.belt_ladders; student public.students;
    membership public.student_program_memberships; current_rank public.belt_ranks; target_rank public.belt_ranks;
    recipient public.belt_test_recipients; receipt private.automation_command_operations;
    item JSONB; prepared JSONB:='[]'; normalized JSONB:='[]'; items JSONB:='[]'; result JSONB;
    fingerprint TEXT; replay BOOLEAN; student_ids UUID[]; changed_ids UUID[]:='{}'; v_program UUID;
    v_membership UUID; v_rank UUID; v_at TIMESTAMPTZ; v_today DATE; v_promotion TIMESTAMPTZ; v_anchor TIMESTAMPTZ;
    targets JSONB; workflow_ids UUID[]; events JSONB:='[]'; did_change BOOLEAN;
    v_classes BIGINT; v_days NUMERIC; v_timezone TEXT; v_generation BIGINT; v_student_id UUID; rank_workflows UUID[]; rank_runs UUID[];
BEGIN
    IF p_studio_id IS NULL OR p_actor_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='AUTOMATION_ADMIN_REQUIRED';
    END IF;
    IF NOT pg_catalog.pg_try_advisory_xact_lock_shared(pg_catalog.hashtextextended('koaryu.local-plan-clear:'||p_studio_id::TEXT,0)) THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STUDIO_BUSY';
    END IF;
    PERFORM private.workflow_require_actor_v1(p_studio_id,p_actor_id);
    IF p_event_id IS NULL OR p_operation_id IS NULL OR p_expected_event_revision IS NULL OR p_expected_event_revision<1 THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
    END IF;
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('automation.operation:'||p_studio_id::TEXT||':'||p_operation_id::TEXT,0));
    SELECT * INTO receipt FROM private.automation_command_operations WHERE studio_id=p_studio_id AND operation_id=p_operation_id;
    replay:=FOUND;
    BEGIN
        IF jsonb_typeof(p_recipients) IS DISTINCT FROM 'array' THEN
            RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
        END IF;
        IF jsonb_array_length(p_recipients) NOT BETWEEN 1 AND 100 THEN
            RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
        END IF;
        FOR item IN SELECT value FROM jsonb_array_elements(p_recipients) LOOP
            IF NOT private.workflow_json_keys_v1(item,ARRAY['student_id','student_program_membership_id'],ARRAY['student_id'])
                OR jsonb_typeof(item->'student_id') IS DISTINCT FROM 'string'
                OR item->>'student_id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                OR (item ? 'student_program_membership_id' AND item->'student_program_membership_id'<>'null'::JSONB
                    AND (jsonb_typeof(item->'student_program_membership_id') IS DISTINCT FROM 'string'
                        OR item->>'student_program_membership_id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')) THEN
                RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
            END IF;
            normalized:=normalized||jsonb_build_array(jsonb_build_object('student_id',(item->>'student_id')::UUID,
                'student_program_membership_id',(item->>'student_program_membership_id')::UUID));
        END LOOP;
        IF EXISTS(SELECT 1 FROM jsonb_array_elements(normalized) GROUP BY value HAVING count(*)>1) THEN
            RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
        END IF;
        SELECT jsonb_agg(value ORDER BY (value->>'student_id')::UUID,(value->>'student_program_membership_id')::UUID NULLS FIRST)
            INTO normalized FROM jsonb_array_elements(normalized);
    EXCEPTION WHEN SQLSTATE '22023' THEN
        IF replay THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_OPERATION_CONFLICT'; END IF;
        RAISE;
    END;
    fingerprint:=private.workflow_hash_v1(jsonb_build_object('command','belt_test.approve','studio_id',p_studio_id,'actor_id',p_actor_id,
        'event_id',p_event_id,'expected_event_revision',p_expected_event_revision,'recipients',normalized));
    IF replay THEN
        IF receipt.actor_id<>p_actor_id OR receipt.command<>'belt_test.approve' OR receipt.request_fingerprint<>fingerprint THEN
            RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_OPERATION_CONFLICT';
        END IF;
        RETURN jsonb_build_object('payload',receipt.result,'operation_id',p_operation_id,'replayed',true);
    END IF;
    SELECT * INTO event FROM public.belt_test_events WHERE studio_id=p_studio_id AND id=p_event_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='AUTOMATION_NOT_FOUND'; END IF;
    IF event.revision<>p_expected_event_revision THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_REVISION_CONFLICT'; END IF;
    SELECT array_agg(DISTINCT (value->>'student_id')::UUID ORDER BY (value->>'student_id')::UUID)
        INTO student_ids FROM jsonb_array_elements(normalized);
    PERFORM 1 FROM public.students WHERE studio_id=p_studio_id AND id=ANY(student_ids) ORDER BY id FOR UPDATE;
    IF (SELECT count(*) FROM public.students WHERE studio_id=p_studio_id AND id=ANY(student_ids))<>cardinality(student_ids) THEN
        RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='AUTOMATION_NOT_FOUND';
    END IF;
    -- Include ended memberships: reactivation cannot change a legacy predicate.
    PERFORM 1 FROM public.student_program_memberships WHERE studio_id=p_studio_id AND student_id=ANY(student_ids) ORDER BY id FOR UPDATE;
    FOREACH v_student_id IN ARRAY student_ids LOOP
        PERFORM private.workflow_rank_compare_pending_v1(p_studio_id,v_student_id);
    END LOOP;
    BEGIN
        -- UPDATE, rather than SHARE, excludes a concurrent rank INSERT's FK lock.
        SELECT * INTO ladder FROM public.belt_ladders WHERE studio_id=p_studio_id AND id=event.ladder_id FOR UPDATE NOWAIT;
        IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='AUTOMATION_NOT_FOUND'; END IF;
        IF ladder.program_id IS DISTINCT FROM event.program_id THEN
            RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT';
        END IF;
        PERFORM 1 FROM public.belt_ranks WHERE studio_id=p_studio_id AND ladder_id=ladder.id ORDER BY id FOR SHARE NOWAIT;
        -- Legacy scalar programs remain meaningful even when the event is unscoped.
        FOR v_program IN SELECT id FROM (
            SELECT event.program_id id UNION SELECT s.program_id FROM public.students s
            JOIN jsonb_array_elements(normalized) n ON s.id=(n.value->>'student_id')::UUID
            WHERE n.value->'student_program_membership_id'='null'::JSONB AND s.studio_id=p_studio_id
            UNION SELECT m.program_id FROM public.student_program_memberships m
            JOIN jsonb_array_elements(normalized) n ON m.id=(n.value->>'student_program_membership_id')::UUID
                AND m.student_id=(n.value->>'student_id')::UUID WHERE m.studio_id=p_studio_id
        ) programs WHERE id IS NOT NULL ORDER BY id LOOP
            PERFORM 1 FROM public.programs WHERE studio_id=p_studio_id AND id=v_program FOR SHARE NOWAIT;
            IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='AUTOMATION_NOT_FOUND'; END IF;
            IF EXISTS(SELECT 1 FROM public.programs WHERE id=v_program AND archived_at IS NOT NULL) THEN
                RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT';
            END IF;
        END LOOP;
        -- These are actual evidence rows, not a stale pre-lock count. Lock all
        -- selected students' existing evidence so credit updates cannot race it.
        PERFORM 1 FROM public.class_sessions cs WHERE cs.studio_id=p_studio_id AND EXISTS(
            SELECT 1 FROM public.attendance a WHERE a.studio_id=p_studio_id AND a.student_id=ANY(student_ids) AND a.session_id=cs.id)
            ORDER BY cs.id FOR SHARE NOWAIT;
        PERFORM 1 FROM public.attendance a WHERE a.studio_id=p_studio_id AND a.student_id=ANY(student_ids) ORDER BY a.id FOR SHARE NOWAIT;
        -- An attendance edit may commit a different session between the two
        -- statements. Its row is now stable; own every current session too.
        PERFORM 1 FROM public.class_sessions cs WHERE cs.studio_id=p_studio_id AND EXISTS(
            SELECT 1 FROM public.attendance a WHERE a.studio_id=p_studio_id AND a.student_id=ANY(student_ids) AND a.session_id=cs.id)
            ORDER BY cs.id FOR SHARE NOWAIT;
    EXCEPTION WHEN lock_not_available THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STUDIO_BUSY';
    END;
    FOR item IN SELECT value FROM jsonb_array_elements(normalized) LOOP
        SELECT * INTO student FROM public.students WHERE studio_id=p_studio_id AND id=(item->>'student_id')::UUID;
        v_membership:=(item->>'student_program_membership_id')::UUID;
        IF v_membership IS NOT NULL THEN
            SELECT * INTO membership FROM public.student_program_memberships WHERE studio_id=p_studio_id
                AND id=v_membership AND student_id=student.id;
            IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='AUTOMATION_NOT_FOUND'; END IF;
            IF membership.status NOT IN ('active','paused') OR membership.ended_at IS NOT NULL
                OR (event.program_id IS NOT NULL AND membership.program_id IS DISTINCT FROM event.program_id) THEN
                RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT';
            END IF;
            v_rank:=membership.current_belt_rank_id; v_program:=membership.program_id;
            v_anchor:=membership.started_at::TIMESTAMP AT TIME ZONE 'UTC';
        ELSE
            IF event.program_id IS NOT NULL OR EXISTS(SELECT 1 FROM public.student_program_memberships
                WHERE studio_id=p_studio_id AND student_id=student.id AND status IN ('active','paused') AND ended_at IS NULL) THEN
                RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT';
            END IF;
            v_rank:=student.current_belt_rank_id; v_program:=student.program_id;
            v_anchor:=student.membership_start_date::TIMESTAMP AT TIME ZONE 'UTC';
        END IF;
        current_rank:=NULL;
        IF v_rank IS NOT NULL THEN
            SELECT * INTO current_rank FROM public.belt_ranks WHERE studio_id=p_studio_id AND ladder_id=ladder.id AND id=v_rank;
            IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT'; END IF;
        END IF;
        WITH ordered AS (SELECT r.id,row_number() OVER (ORDER BY r.display_order,r.created_at,r.id) position
            FROM public.belt_ranks r WHERE r.studio_id=p_studio_id AND r.ladder_id=ladder.id)
        SELECT r.* INTO target_rank FROM ordered o JOIN public.belt_ranks r ON r.id=o.id
            WHERE v_rank IS NULL OR o.position>(SELECT position FROM ordered WHERE id=v_rank)
            ORDER BY o.position LIMIT 1;
        IF NOT FOUND OR target_rank.min_classes IS NULL OR target_rank.min_months IS NULL
            OR target_rank.min_classes<0 OR target_rank.min_months<0 THEN
            RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT';
        END IF;
        SELECT p.promoted_at INTO v_promotion FROM public.promotions p WHERE p.studio_id=p_studio_id AND p.student_id=student.id
            AND ((v_membership IS NOT NULL AND p.student_program_membership_id=v_membership)
                OR (v_program IS NOT NULL AND p.program_id=v_program) OR (v_membership IS NULL AND p.program_id IS NULL))
            ORDER BY p.promoted_at DESC,p.id DESC LIMIT 1;
        v_anchor:=coalesce(v_promotion,v_anchor,student.membership_start_date::TIMESTAMP AT TIME ZONE 'UTC');
        IF (v_promotion IS NOT NULL AND NOT isfinite(v_promotion)) OR (v_anchor IS NOT NULL AND NOT isfinite(v_anchor)) THEN
            RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT';
        END IF;
        v_generation:=private.workflow_rank_context_generation_v1(p_studio_id,student.id,v_membership);
        prepared:=prepared||jsonb_build_array(item||jsonb_build_object('rank_context_generation',v_generation,'program_id',v_program,'current_rank_id',v_rank,'target_rank_id',target_rank.id,
            'promotion_at',v_promotion,'anchor_at',v_anchor,'min_classes',target_rank.min_classes,'min_days',target_rank.min_months::BIGINT*30));
    END LOOP;
    PERFORM 1 FROM public.belt_test_recipients b WHERE b.studio_id=p_studio_id AND b.event_id=p_event_id AND EXISTS(
        SELECT 1 FROM jsonb_array_elements(normalized) n WHERE b.student_id=(n.value->>'student_id')::UUID
            AND b.student_program_membership_id IS NOT DISTINCT FROM (n.value->>'student_program_membership_id')::UUID) ORDER BY b.id FOR UPDATE;
    SELECT coalesce(array_agg(b.id ORDER BY b.id),'{}'::UUID[]) INTO changed_ids FROM public.belt_test_recipients b
        JOIN jsonb_array_elements(prepared) n ON b.student_id=(n.value->>'student_id')::UUID
            AND b.student_program_membership_id IS NOT DISTINCT FROM (n.value->>'student_program_membership_id')::UUID
        WHERE b.studio_id=p_studio_id AND b.event_id=p_event_id AND (b.state<>'approved' OR b.approved_schedule_revision<>event.schedule_revision
            OR b.approved_rank_context_generation IS DISTINCT FROM (n.value->>'rank_context_generation')::BIGINT
            OR b.approved_program_id IS DISTINCT FROM (n.value->>'program_id')::UUID
            OR b.approved_current_rank_id IS DISTINCT FROM (n.value->>'current_rank_id')::UUID OR b.approved_target_rank_id<>(n.value->>'target_rank_id')::UUID);
    IF EXISTS(SELECT 1 FROM public.belt_test_recipients WHERE id=ANY(changed_ids) AND revision=9223372036854775807) THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT';
    END IF;
    SELECT coalesce(array_agg(DISTINCT r.workflow_id ORDER BY r.workflow_id),'{}'::UUID[]) INTO workflow_ids
        FROM public.automation_workflow_runs r JOIN private.automation_workflow_events e ON e.studio_id=r.studio_id AND e.id=r.event_id
        WHERE r.studio_id=p_studio_id AND e.subject_kind='belt_test' AND e.subject_id=ANY(changed_ids);
    IF EXISTS(SELECT 1 FROM private.workflow_rank_scopes WHERE studio_id=p_studio_id AND backend_pid=pg_catalog.pg_backend_pid()
        AND transaction_id=pg_catalog.pg_current_xact_id() AND (state='active' OR (state='unknown' AND owner='private_profile'))) THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_RANK_CONTEXT_UNAVAILABLE';
    END IF;
    FOR v_student_id IN SELECT DISTINCT student_id FROM private.workflow_rank_scopes WHERE studio_id=p_studio_id
        AND backend_pid=pg_catalog.pg_backend_pid() AND transaction_id=pg_catalog.pg_current_xact_id() ORDER BY student_id LOOP
        PERFORM private.workflow_rank_compare_pending_v1(p_studio_id,v_student_id);
    END LOOP;
    -- Include earlier completed rank commands in the same final-mode union.
    SELECT coalesce(array_agg(DISTINCT r.workflow_id ORDER BY r.workflow_id),'{}'::UUID[]),
        coalesce(array_agg(DISTINCT r.id ORDER BY r.id),'{}'::UUID[]) INTO rank_workflows,rank_runs
        FROM public.automation_workflow_runs r JOIN private.automation_workflow_events e ON e.studio_id=r.studio_id AND e.id=r.event_id
        WHERE r.studio_id=p_studio_id AND e.event_type IN ('student.promoted','belt_test.approved','belt_test.upcoming')
            AND EXISTS(SELECT 1 FROM private.workflow_rank_pending_contexts p JOIN private.workflow_rank_scopes s ON s.id=p.scope_id
                WHERE p.studio_id=e.studio_id AND p.student_id=(e.context->>'student_id')::UUID
                    AND p.student_program_membership_id IS NOT DISTINCT FROM (e.context->>'student_program_membership_id')::UUID
                    AND p.changed AND s.backend_pid=pg_catalog.pg_backend_pid() AND s.transaction_id=pg_catalog.pg_current_xact_id());
    SELECT coalesce(array_agg(DISTINCT id ORDER BY id),'{}'::UUID[]) INTO workflow_ids FROM unnest(workflow_ids||rank_workflows) id;
    targets:=private.workflow_prepare_capture_v1(p_studio_id,workflow_ids,true);
    UPDATE private.workflow_rank_scopes SET capture_targets=jsonb_build_object('lock_mode','update','packet',targets) WHERE studio_id=p_studio_id
        AND backend_pid=pg_catalog.pg_backend_pid() AND transaction_id=pg_catalog.pg_current_xact_id();
    PERFORM 1 FROM public.automation_workflow_runs r JOIN private.automation_workflow_events e ON e.studio_id=r.studio_id AND e.id=r.event_id
        WHERE r.studio_id=p_studio_id AND ((e.subject_kind='belt_test' AND e.subject_id=ANY(changed_ids)
            AND r.state IN ('queued','waiting','claimed','running','sending','unknown')) OR r.id=ANY(rank_runs)) ORDER BY r.id FOR UPDATE OF r;
    -- Time and all eligibility are evaluated after the final potentially blocking lock.
    v_at:=clock_timestamp();
    SELECT private.timezone_name_or_utc(s.timezone)
        INTO v_timezone FROM public.studios s WHERE id=p_studio_id;
    v_today:=(v_at AT TIME ZONE v_timezone)::DATE;
    IF event.status<>'scheduled' OR event.starts_at<=v_at THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT';
    END IF;
    FOR item IN SELECT value FROM jsonb_array_elements(prepared) LOOP
        SELECT * INTO student FROM public.students WHERE studio_id=p_studio_id AND id=(item->>'student_id')::UUID;
        IF student.status<>'active' OR student.deleted_at IS NOT NULL OR (student.hold_start_date IS NOT NULL
            AND student.hold_start_date<=v_today AND (student.hold_end_date IS NULL OR student.hold_end_date>=v_today)) THEN
            RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT';
        END IF;
        SELECT count(*) INTO v_classes FROM public.attendance a JOIN public.class_sessions cs ON cs.id=a.session_id AND cs.studio_id=p_studio_id
            WHERE a.studio_id=p_studio_id AND a.student_id=student.id AND a.status<>'absent' AND a.counts_toward_eligibility IS DISTINCT FROM false
                AND cs.deleted_at IS NULL AND cs.status<>'canceled'
                AND (event.program_id IS NULL OR cs.program_id=event.program_id)
                AND (item->>'promotion_at' IS NULL OR a.checked_in_at>=(item->>'promotion_at')::TIMESTAMPTZ);
        v_days:=CASE WHEN item->>'anchor_at' IS NULL THEN 0 ELSE greatest(0,floor(extract(epoch FROM (v_at-(item->>'anchor_at')::TIMESTAMPTZ))/86400)) END;
        IF v_classes<(item->>'min_classes')::BIGINT OR v_days<(item->>'min_days')::BIGINT THEN
            RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT';
        END IF;
    END LOOP;
    -- Every selected context has passed before any recipient/audit/receipt write.
    FOR item IN SELECT value FROM jsonb_array_elements(prepared) LOOP
        SELECT * INTO recipient FROM public.belt_test_recipients WHERE studio_id=p_studio_id AND event_id=p_event_id
            AND student_id=(item->>'student_id')::UUID
            AND student_program_membership_id IS NOT DISTINCT FROM (item->>'student_program_membership_id')::UUID;
        did_change:=false;
        IF NOT FOUND THEN
            did_change:=true;
            INSERT INTO public.belt_test_recipients(studio_id,event_id,student_id,student_program_membership_id,approved_schedule_revision,approved_program_id,approved_rank_context_generation,
                approved_current_rank_id,approved_target_rank_id,state,revision,approved_by,approved_at,created_at,updated_at)
                VALUES(p_studio_id,p_event_id,(item->>'student_id')::UUID,(item->>'student_program_membership_id')::UUID,event.schedule_revision,(item->>'program_id')::UUID,(item->>'rank_context_generation')::BIGINT,
                    (item->>'current_rank_id')::UUID,(item->>'target_rank_id')::UUID,'approved',1,p_actor_id,v_at,v_at,v_at) RETURNING * INTO recipient;
        ELSIF recipient.id=ANY(changed_ids) THEN
            did_change:=true;
            UPDATE public.belt_test_recipients SET approved_schedule_revision=event.schedule_revision,
                approved_program_id=(item->>'program_id')::UUID,approved_rank_context_generation=(item->>'rank_context_generation')::BIGINT,
                approved_current_rank_id=(item->>'current_rank_id')::UUID,approved_target_rank_id=(item->>'target_rank_id')::UUID,
                state='approved',revision=revision+1,approved_by=p_actor_id,approved_at=v_at,revoked_at=NULL,updated_at=v_at
                WHERE id=recipient.id RETURNING * INTO recipient;
        END IF;
        IF did_change THEN
            events:=events||jsonb_build_array(jsonb_build_object('event_type','belt_test.approved',
                'source_key',recipient.id::TEXT||':'||recipient.revision::TEXT||':'||recipient.approved_schedule_revision::TEXT,
                'subject_kind','belt_test','subject_id',recipient.id,'occurred_at',private.automation_utc_text_v1(v_at),
                'context',jsonb_build_object('event_id',recipient.event_id,'student_id',recipient.student_id,
                    'student_program_membership_id',recipient.student_program_membership_id,'approved_program_id',recipient.approved_program_id,
                    'approved_current_rank_id',recipient.approved_current_rank_id,'approved_target_rank_id',recipient.approved_target_rank_id,
                    'approved_schedule_revision',recipient.approved_schedule_revision,'approval_revision',recipient.revision,
                    'approved_rank_context_generation',recipient.approved_rank_context_generation)));
        END IF;
        items:=items||jsonb_build_array(private.belt_test_recipient_payload_v1(recipient));
    END LOOP;
    PERFORM private.belt_test_cancel_recipient_runs_v1(p_studio_id,changed_ids,v_at);
    PERFORM private.workflow_rank_finalize_pending_v1(p_studio_id);
    IF events<>'[]'::JSONB THEN PERFORM private.workflow_capture_events_v1(p_studio_id,events,targets); END IF;
    result:=jsonb_build_object('items',items,'event_revision',p_expected_event_revision,'schedule_revision',event.schedule_revision);
    INSERT INTO public.audit_logs(studio_id,actor_id,action,entity_type,entity_id,metadata)
        VALUES(p_studio_id,p_actor_id,'belt_test.approve','belt_test',p_event_id,
            jsonb_build_object('event_revision',p_expected_event_revision,'schedule_revision',event.schedule_revision,'recipient_count',jsonb_array_length(items)));
    INSERT INTO private.automation_command_operations(studio_id,operation_id,actor_id,command,request_fingerprint,entity_type,entity_id,result,committed_at)
        VALUES(p_studio_id,p_operation_id,p_actor_id,'belt_test.approve',fingerprint,'belt_test',p_event_id,result,v_at);
    RETURN jsonb_build_object('payload',result,'operation_id',p_operation_id,'replayed',false);
END $$;


-- Retain 20261005105341_automation_workflow_graph_v57.sql semantics and existing function privileges.
CREATE OR REPLACE FUNCTION private.workflow_current_source_facts_v1(
    p_studio_id UUID,p_event_type TEXT,p_subject_id UUID,p_captured_context JSONB,p_trigger_config JSONB,
    p_reference_at TIMESTAMPTZ,p_recipient_ids TEXT[]
) RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $$
DECLARE
    cat JSONB:=private.workflow_catalog_v1(); meta JSONB:=cat#>ARRAY['triggers',p_event_type];
    studio public.studios; student public.students; promotion public.promotions; lead public.leads;
    trial public.lead_trial_appointments; event public.belt_test_events; recipient public.belt_test_recipients;
    invoice public.billing_invoices; payment public.billing_payments; payer public.billing_payers;
    program public.programs; rank public.belt_ranks; ladder public.belt_ladders;
    context JSONB:=p_captured_context; expected JSONB; authority JSONB; finance JSONB; evidence JSONB;
    conditions JSONB:='{}'; templates JSONB:='{}'; anchors JSONB:='{}'; recipients JSONB:='{}'; addresses JSONB:='{}';
    source_found BOOLEAN:=false; reason TEXT; unavailable BOOLEAN:=false; context_bad BOOLEAN:=false; current_context_bad BOOLEAN:=false;
    student_id UUID; lead_id UUID; program_id UUID; membership_id UUID; rank_id UUID; filter_id UUID;
    generation JSONB; settlement_generation BIGINT; today DATE; captured_due DATE; zone TEXT; minor BOOLEAN; on_hold BOOLEAN; approval_current BOOLEAN:=false;
    policy TEXT; email TEXT; name TEXT; kind TEXT; contact_reason TEXT; contact_decision TEXT; staff JSONB; guardian RECORD;
    fields TEXT[]; k TEXT; value JSONB; is_trial BOOLEAN:=p_event_type LIKE 'trial.%';
    is_belt BOOLEAN:=p_event_type LIKE 'belt_test.%'; is_invoice BOOLEAN:=p_event_type LIKE 'invoice.%';
BEGIN
    IF p_studio_id IS NULL OR p_subject_id IS NULL OR meta IS NULL OR p_reference_at IS NULL
        OR NOT isfinite(p_reference_at) OR p_reference_at NOT BETWEEN TIMESTAMPTZ '0001-01-01 00:00:00+00' AND TIMESTAMPTZ '9999-12-31 23:59:59.999999+00'
        OR p_recipient_ids IS NULL OR cardinality(p_recipient_ids)>4
        OR cardinality(p_recipient_ids)<>(SELECT count(DISTINCT x) FROM unnest(p_recipient_ids) x)
        OR EXISTS(SELECT 1 FROM unnest(p_recipient_ids) x WHERE x IS NULL OR NOT meta->'recipient_ids' ? x)
        OR NOT private.workflow_json_keys_v1(p_trigger_config,ARRAY['event_type','program_id','offset_minutes'],ARRAY['event_type','program_id'])
        OR p_trigger_config->>'event_type' IS DISTINCT FROM p_event_type
        OR (p_trigger_config->'program_id'<>'null'::JSONB AND NOT coalesce(private.workflow_typed_value_v1(p_trigger_config->'program_id',cat#>'{fields,program.id}'),false)) THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
    END IF;
    filter_id:=(p_trigger_config->>'program_id')::UUID;
    SELECT * INTO studio FROM public.studios WHERE id=p_studio_id;
    IF studio.id IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='AUTOMATION_NOT_FOUND'; END IF;
    zone:=private.timezone_name_or_utc(studio.timezone);
    today:=(p_reference_at AT TIME ZONE zone)::DATE;
    -- The primary record determines scoped404 independently from any missing parent.
    CASE
    WHEN p_event_type='student.enrolled' THEN
        SELECT * INTO student FROM public.students WHERE studio_id=p_studio_id AND id=p_subject_id;
        source_found:=student.id IS NOT NULL; student_id:=student.id;
        IF p_captured_context IS NOT NULL THEN
            context_bad:=NOT private.workflow_json_keys_v1(context,ARRAY['student_id','matched_program_ids'],ARRAY['student_id','matched_program_ids'])
                OR context->'student_id' IS DISTINCT FROM to_jsonb(p_subject_id) OR jsonb_typeof(context->'matched_program_ids') IS DISTINCT FROM 'array';
            IF NOT context_bad THEN
                context_bad:=jsonb_array_length(context->'matched_program_ids')>25 OR EXISTS(SELECT 1 FROM jsonb_array_elements(context->'matched_program_ids') v
                    WHERE NOT coalesce(private.workflow_typed_value_v1(v,cat#>'{fields,program.id}'),false));
            END IF;
        END IF;
    WHEN p_event_type='student.promoted' THEN
        SELECT * INTO promotion FROM public.promotions WHERE studio_id=p_studio_id AND id=p_subject_id;
        source_found:=promotion.id IS NOT NULL; student_id:=promotion.student_id;
        membership_id:=promotion.command_membership_id; program_id:=promotion.command_program_id; rank_id:=promotion.to_rank_id;
        IF source_found AND promotion.transition_kind IS DISTINCT FROM 'promotion' THEN reason:='promotion_unavailable'; END IF;
        IF p_captured_context IS NULL THEN
            SELECT e.context INTO context FROM private.automation_workflow_events e WHERE e.studio_id=p_studio_id
                AND e.event_type=p_event_type AND e.source_key=p_subject_id::TEXT AND e.subject_id=p_subject_id AND e.subject_kind='promotion';
        END IF;
        expected:=jsonb_build_object('promotion_id',p_subject_id,'student_id',student_id,'student_program_membership_id',membership_id,
            'program_id',program_id,'rank_id',rank_id);
        context_bad:=context IS NULL OR NOT private.workflow_json_keys_v1(context,
            ARRAY['promotion_id','student_id','student_program_membership_id','program_id','rank_id','from_rank_id','rank_context_generation'],
            ARRAY['promotion_id','student_id','student_program_membership_id','program_id','rank_id','rank_context_generation'])
            OR NOT coalesce(private.workflow_integer_v1(context->'rank_context_generation',1,9223372036854775807),false)
            OR (context ? 'from_rank_id' AND context->'from_rank_id' IS DISTINCT FROM coalesce(to_jsonb(promotion.command_from_rank_id),'null'::JSONB));
        IF NOT context_bad AND NOT context @> expected THEN reason:=coalesce(reason,'source_context_changed'); END IF;
        generation:=context->'rank_context_generation';
        IF NOT context_bad THEN conditions:=jsonb_build_object('program.id',program_id); END IF;
        IF rank_id IS NOT NULL THEN conditions:=conditions||jsonb_build_object('promotion.rank_id',rank_id); END IF;
        IF promotion.to_rank_name_snapshot IS NOT NULL THEN templates:=jsonb_build_object('rank_name',private.workflow_fact_text_v1(promotion.to_rank_name_snapshot)); END IF;
    WHEN p_event_type IN ('lead.created','lead.stage_changed') THEN
        SELECT * INTO lead FROM public.leads WHERE studio_id=p_studio_id AND id=p_subject_id;
        source_found:=lead.id IS NOT NULL; lead_id:=lead.id; program_id:=lead.program_id;
        IF p_captured_context IS NOT NULL THEN
            fields:=CASE WHEN p_event_type='lead.created' THEN ARRAY['lead_id','program_id','stage'] ELSE ARRAY['lead_id','program_id','activity_id','old_stage','stage'] END;
            context_bad:=NOT private.workflow_json_keys_v1(context,fields,fields)
                OR context->'lead_id' IS DISTINCT FROM to_jsonb(p_subject_id)
                OR NOT coalesce(private.workflow_typed_value_v1(context->'stage',cat#>'{fields,lead.stage}'),false)
                OR (context->'program_id'<>'null'::JSONB AND NOT coalesce(private.workflow_typed_value_v1(context->'program_id',cat#>'{fields,program.id}'),false));
            IF p_event_type='lead.stage_changed' THEN
                context_bad:=context_bad OR NOT coalesce(private.workflow_typed_value_v1(context->'old_stage',cat#>'{fields,lead.stage}'),false)
                    OR NOT coalesce(private.workflow_typed_value_v1(context->'activity_id',cat#>'{fields,program.id}'),false);
            END IF;
        END IF;
    WHEN is_trial THEN
        SELECT * INTO trial FROM public.lead_trial_appointments WHERE studio_id=p_studio_id AND id=p_subject_id;
        source_found:=trial.id IS NOT NULL; lead_id:=trial.lead_id; program_id:=trial.program_id;
        expected:=jsonb_build_object('appointment_id',p_subject_id,'lead_id',lead_id,'program_id',program_id,'revision',trial.revision,'status',trial.status);
        IF p_captured_context IS NOT NULL THEN
            context_bad:=NOT private.workflow_json_keys_v1(context,ARRAY['appointment_id','lead_id','program_id','revision','status'],ARRAY['appointment_id','lead_id','program_id','revision','status'])
                OR NOT coalesce(private.workflow_integer_v1(context->'revision',1,9223372036854775807),false);
            IF NOT context_bad AND context IS DISTINCT FROM expected THEN reason:='source_context_changed'; END IF;
        END IF;
        IF source_found AND (trial.status IS DISTINCT FROM CASE WHEN p_event_type IN ('trial.scheduled','trial.upcoming') THEN 'scheduled' ELSE substr(p_event_type,7) END
            OR (p_event_type IN ('trial.scheduled','trial.upcoming') AND trial.starts_at BETWEEN TIMESTAMPTZ '0001-01-01+00' AND TIMESTAMPTZ '9999-12-31 23:59:59.999999+00' AND trial.starts_at<=p_reference_at)) THEN reason:='trial_unavailable'; END IF;
        IF p_event_type='trial.no_show' AND trial.rebooking_superseded THEN reason:='trial_rebooked'; END IF;
        IF source_found THEN
            conditions:=jsonb_build_object('trial.status',trial.status);
            templates:=jsonb_build_object('trial_location',private.workflow_fact_text_v1(trial.location));
            IF trial.starts_at BETWEEN TIMESTAMPTZ '0001-01-01+00' AND TIMESTAMPTZ '9999-12-31 23:59:59.999999+00'
                AND trial.ends_at>trial.starts_at AND isfinite(trial.ends_at)
                AND private.timezone_name_known(trial.timezone) THEN
                templates:=templates||jsonb_build_object('trial_start',jsonb_build_object('kind','event_time','instant',private.automation_utc_text_v1(trial.starts_at),'timezone',trial.timezone));
                IF meta->'delay_fields' ? 'trial.starts_at' THEN anchors:=jsonb_build_object('trial.starts_at',private.automation_utc_text_v1(trial.starts_at)); END IF;
            ELSE unavailable:=true; END IF;
        END IF;
    WHEN is_belt THEN
        SELECT * INTO recipient FROM public.belt_test_recipients WHERE studio_id=p_studio_id AND id=p_subject_id;
        source_found:=recipient.id IS NOT NULL; student_id:=recipient.student_id; membership_id:=recipient.student_program_membership_id;
        program_id:=recipient.approved_program_id; rank_id:=recipient.approved_current_rank_id; generation:=to_jsonb(recipient.approved_rank_context_generation);
        SELECT * INTO event FROM public.belt_test_events WHERE studio_id=p_studio_id AND id=recipient.event_id;
        expected:=jsonb_build_object('event_id',recipient.event_id,'student_id',student_id,'student_program_membership_id',membership_id,
            'approved_program_id',program_id,'approved_current_rank_id',rank_id,'approved_target_rank_id',recipient.approved_target_rank_id,
            'approved_schedule_revision',recipient.approved_schedule_revision,'approval_revision',recipient.revision,'approved_rank_context_generation',recipient.approved_rank_context_generation);
        IF p_captured_context IS NOT NULL THEN
            fields:=ARRAY['event_id','student_id','student_program_membership_id','approved_program_id','approved_current_rank_id','approved_target_rank_id','approved_schedule_revision','approval_revision','approved_rank_context_generation'];
            context_bad:=NOT private.workflow_json_keys_v1(context,fields,fields);
            IF NOT context_bad AND context IS DISTINCT FROM expected THEN reason:='approval_changed'; END IF;
        END IF;
        IF source_found AND (event.id IS NULL OR recipient.state<>'approved' OR event.status<>'scheduled'
            OR (event.starts_at BETWEEN TIMESTAMPTZ '0001-01-01+00' AND TIMESTAMPTZ '9999-12-31 23:59:59.999999+00' AND event.starts_at<=p_reference_at) OR event.schedule_revision<>recipient.approved_schedule_revision) THEN reason:='belt_test_unavailable'; END IF;
        IF event.id IS NOT NULL THEN
            conditions:=jsonb_build_object('belt_test.event_scheduled',event.status='scheduled');
            templates:=jsonb_build_object('event_name',private.workflow_fact_text_v1(event.name),'event_location',private.workflow_fact_text_v1(event.location));
            IF event.starts_at BETWEEN TIMESTAMPTZ '0001-01-01+00' AND TIMESTAMPTZ '9999-12-31 23:59:59.999999+00'
                AND event.ends_at>event.starts_at AND isfinite(event.ends_at)
                AND private.timezone_name_known(event.timezone) THEN
                templates:=templates||jsonb_build_object('event_start',jsonb_build_object('kind','event_time','instant',private.automation_utc_text_v1(event.starts_at),'timezone',event.timezone));
                anchors:=jsonb_build_object('belt_test.starts_at',private.automation_utc_text_v1(event.starts_at));
            ELSE unavailable:=true; END IF;
        END IF;
    WHEN is_invoice THEN
        IF p_event_type='invoice.payment_failed' THEN
            SELECT * INTO payment FROM public.billing_payments WHERE studio_id=p_studio_id AND id=p_subject_id;
            source_found:=payment.id IS NOT NULL;
            SELECT * INTO invoice FROM public.billing_invoices WHERE studio_id=p_studio_id AND id=payment.invoice_id;
            IF source_found AND payment.status<>'failed' THEN reason:='payment_not_failed'; END IF;
            IF p_captured_context IS NULL THEN
                SELECT e.context INTO context FROM private.automation_workflow_events e WHERE e.studio_id=p_studio_id
                    AND e.event_type=p_event_type AND e.source_key=p_subject_id::TEXT AND e.subject_id=p_subject_id AND e.subject_kind='invoice';
            END IF;
            context_bad:=context IS NULL OR NOT private.workflow_json_keys_v1(context,
                ARRAY['payment_id','invoice_id','payer_id','invoice_settlement_generation','payment_evidence'],
                ARRAY['payment_id','invoice_id','payer_id','invoice_settlement_generation','payment_evidence'])
                OR NOT coalesce(private.workflow_integer_v1(context->'invoice_settlement_generation',1,9223372036854775807),false)
                OR NOT coalesce(private.workflow_payment_evidence_valid_v1(context->'payment_evidence'),false);
        ELSE
            SELECT * INTO invoice FROM public.billing_invoices WHERE studio_id=p_studio_id AND id=p_subject_id;
            source_found:=invoice.id IS NOT NULL;
            IF p_captured_context IS NOT NULL THEN
                fields:=ARRAY['invoice_id','payer_id','due_date','stripe_account_id','stripe_customer_id','stripe_invoice_id','connect_account_generation','currency'];
                context_bad:=NOT private.workflow_json_keys_v1(context,fields,fields)
                    OR NOT coalesce(private.workflow_typed_value_v1(context->'invoice_id',cat#>'{fields,program.id}'),false)
                    OR NOT coalesce(private.workflow_typed_value_v1(context->'payer_id',cat#>'{fields,program.id}'),false)
                    OR NOT coalesce(private.workflow_integer_v1(context->'connect_account_generation',1,2147483647),false)
                    OR jsonb_typeof(context->'currency') IS DISTINCT FROM 'string' OR context->>'currency' !~ '^[A-Za-z]{3}$'
                    OR jsonb_typeof(context->'due_date') IS DISTINCT FROM 'string' OR context->>'due_date' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$';
                FOREACH k IN ARRAY ARRAY['stripe_account_id','stripe_customer_id','stripe_invoice_id'] LOOP
                    context_bad:=context_bad OR jsonb_typeof(context->k) IS DISTINCT FROM 'string'
                        OR octet_length(context->>k) NOT BETWEEN 1 AND 255 OR context->>k !~ '^[!-~]+$';
                END LOOP;
                IF NOT context_bad THEN
                    BEGIN
                        captured_due:=(context->>'due_date')::DATE;
                        context_bad:=NOT isfinite(captured_due) OR captured_due NOT BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'
                            OR to_char(captured_due,'YYYY-MM-DD') IS DISTINCT FROM context->>'due_date';
                    EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN context_bad:=true;
                    END;
                END IF;
                -- Equality is meaningful only for known current comparison values.
                -- This validates scalar shape; the existing financial reader still
                -- owns provider/payer agreement, unit provenance and settlement.
                current_context_bad:=invoice.currency IS NULL OR invoice.currency !~ '^[A-Za-z]{3}$'
                    OR (invoice.due_date IS NOT NULL AND (NOT isfinite(invoice.due_date)
                        OR invoice.due_date NOT BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'));
                k:=invoice.metadata->>'connect_account_generation';
                IF k IS NULL OR length(k) NOT BETWEEN 1 AND 10 OR k !~ '^[1-9][0-9]*$' THEN current_context_bad:=true;
                ELSIF k::NUMERIC>2147483647 THEN current_context_bad:=true; END IF;
                FOREACH k IN ARRAY ARRAY['stripe_account_id','stripe_customer_id','stripe_invoice_id'] LOOP
                    value:=to_jsonb(invoice)->k;
                    current_context_bad:=current_context_bad OR jsonb_typeof(value) IS DISTINCT FROM 'string'
                        OR octet_length(value#>>'{}') NOT BETWEEN 1 AND 255 OR value#>>'{}' !~ '^[!-~]+$';
                END LOOP;
                IF current_context_bad THEN unavailable:=true;
                ELSIF NOT context_bad AND invoice.due_date IS NOT NULL AND (context->'invoice_id' IS DISTINCT FROM to_jsonb(invoice.id)
                    OR context->'payer_id' IS DISTINCT FROM coalesce(to_jsonb(invoice.payer_id),'null'::JSONB)
                    OR captured_due IS DISTINCT FROM invoice.due_date OR upper(context->>'currency') IS DISTINCT FROM upper(invoice.currency)
                    OR context->>'stripe_account_id' IS DISTINCT FROM invoice.stripe_account_id
                    OR context->>'stripe_customer_id' IS DISTINCT FROM invoice.stripe_customer_id
                    OR context->>'stripe_invoice_id' IS DISTINCT FROM invoice.stripe_invoice_id
                    OR context->>'connect_account_generation' IS DISTINCT FROM invoice.metadata->>'connect_account_generation') THEN reason:='source_context_changed'; END IF;
            END IF;
        END IF;
        SELECT * INTO payer FROM public.billing_payers WHERE studio_id=p_studio_id AND id=invoice.payer_id;
        IF source_found AND (invoice.id IS NULL OR payer.id IS NULL) THEN reason:='invoice_parent_missing'; END IF;
        IF invoice.id IS NOT NULL THEN
            conditions:=jsonb_build_object('invoice.open_balance',invoice.status='open' AND invoice.amount_remaining_cents>0);
            IF invoice.collection_method IS NULL OR invoice.collection_method IN ('send_invoice','charge_automatically') THEN
                conditions:=conditions||jsonb_build_object('invoice.collection_method',invoice.collection_method);
            END IF;
            IF invoice.due_date IS NULL OR (isfinite(invoice.due_date) AND invoice.due_date BETWEEN DATE '0001-01-01' AND DATE '9999-12-31') THEN
                conditions:=conditions||jsonb_build_object('invoice.overdue',invoice.status='open' AND invoice.amount_remaining_cents>0
                    AND coalesce(invoice.due_date<today,false));
                templates:=templates||jsonb_build_object('invoice_due_date',jsonb_build_object('kind','date','value',to_char(invoice.due_date,'YYYY-MM-DD')));
                IF p_event_type='invoice.overdue' AND (invoice.due_date IS NULL OR invoice.due_date>=today) THEN reason:=coalesce(reason,'invoice_not_overdue'); END IF;
            ELSIF p_event_type='invoice.overdue' THEN unavailable:=true; END IF;
            IF invoice.status<>'open' OR invoice.amount_remaining_cents<=0 THEN reason:=coalesce(reason,'invoice_not_open'); END IF;
            IF coalesce(invoice.metadata->'demo'='true'::JSONB,false) OR coalesce(payer.metadata->'demo'='true'::JSONB,false)
                OR coalesce(payment.metadata->'demo'='true'::JSONB,false) THEN reason:=coalesce(reason,'demo_source'); END IF;
            -- A known newer committed settlement remains a successor even when
            -- unrelated current financial facts are unavailable. Never repair it.
            IF p_event_type='invoice.payment_failed' AND NOT context_bad
                AND context->'payment_id'=to_jsonb(payment.id) AND context->'invoice_id'=to_jsonb(invoice.id)
                AND context#>'{payment_evidence,invalid_fields}'='[]'::JSONB THEN
                SELECT a.generation INTO settlement_generation FROM private.workflow_invoice_settlement_authority a
                    WHERE a.studio_id=p_studio_id AND a.invoice_id=invoice.id;
                IF settlement_generation>(context->>'invoice_settlement_generation')::BIGINT THEN reason:=coalesce(reason,'payment_settled');
                ELSIF settlement_generation IS NULL OR settlement_generation<(context->>'invoice_settlement_generation')::BIGINT THEN unavailable:=true; END IF;
            END IF;
            finance:=private.workflow_invoice_financial_context_v1(p_studio_id,invoice.id,payment.id);
            IF finance->'available' IS DISTINCT FROM 'true'::JSONB THEN unavailable:=true;
            ELSE
                templates:=templates||jsonb_build_object('invoice_balance',jsonb_build_object('kind','money',
                    'amount_minor_units',invoice.amount_remaining_cents,'currency',finance->'currency','unit_convention',finance->'unit_convention'));
            END IF;
            templates:=templates||jsonb_build_object('invoice_number',private.workflow_fact_text_v1(invoice.invoice_number));
            IF p_event_type='invoice.payment_failed' AND NOT context_bad THEN
                evidence:=private.workflow_payment_evidence_v1(payment);
                -- The evidence normalizer records malformed nonnull values as
                -- null plus invalid_fields. Those are unknown, not new identities.
                IF evidence->'invalid_fields' IS DISTINCT FROM '[]'::JSONB
                    OR EXISTS(SELECT 1 FROM jsonb_each(evidence) x WHERE x.key IN
                        ('currency','stripe_account_id','stripe_customer_id','stripe_invoice_id','connect_account_generation') AND x.value='null'::JSONB) THEN unavailable:=true;
                ELSIF context->'payment_id' IS DISTINCT FROM to_jsonb(payment.id) OR context->'invoice_id' IS DISTINCT FROM to_jsonb(invoice.id)
                    OR context->'payer_id' IS DISTINCT FROM to_jsonb(payer.id) THEN reason:=coalesce(reason,'source_context_changed');
                ELSIF context#>>'{payment_evidence,status}' IS DISTINCT FROM 'failed'
                    OR context#>'{payment_evidence,invalid_fields}' IS DISTINCT FROM '[]'::JSONB
                    OR context#>'{payment_evidence,payment_id}' IS DISTINCT FROM context->'payment_id'
                    OR context#>'{payment_evidence,invoice_id}' IS DISTINCT FROM context->'invoice_id'
                    OR context#>'{payment_evidence,payer_id}' IS DISTINCT FROM context->'payer_id'
                    OR EXISTS(SELECT 1 FROM jsonb_each(context->'payment_evidence') x WHERE x.key IN
                        ('currency','stripe_account_id','stripe_customer_id','stripe_invoice_id','connect_account_generation') AND x.value='null'::JSONB) THEN unavailable:=true;
                ELSIF EXISTS(SELECT 1 FROM jsonb_each(context->'payment_evidence') x WHERE x.key IN
                    ('payment_id','payer_id','invoice_id','stripe_account_id','stripe_customer_id','stripe_invoice_id','connect_account_generation')
                    AND x.value IS DISTINCT FROM evidence->x.key) THEN reason:=coalesce(reason,'source_context_changed');
                ELSIF context#>'{payment_evidence,currency}' IS DISTINCT FROM evidence->'currency' THEN
                    IF finance->'available'='true'::JSONB THEN reason:=coalesce(reason,'source_context_changed'); ELSE unavailable:=true; END IF;
                ELSIF finance->'available'='true'::JSONB AND context->'invoice_settlement_generation' IS DISTINCT FROM finance->'invoice_settlement_generation' THEN
                    reason:=coalesce(reason,'payment_settled');
                END IF;
            END IF;
        END IF;
    ELSE RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
    END CASE;
    -- A present durable context is never repaired by current equality. Validate
    -- its stored types before interpreting a difference as a known successor.
    IF context IS NOT NULL AND p_event_type<>'invoice.overdue' THEN
        IF jsonb_typeof(context) IS DISTINCT FROM 'object' THEN context_bad:=true;
        ELSE
            FOR k,value IN SELECT x.key,x.value FROM jsonb_each(context) x LOOP
                IF k IN ('rank_context_generation','approved_rank_context_generation','approved_schedule_revision','approval_revision','revision','invoice_settlement_generation') THEN
                    context_bad:=context_bad OR NOT coalesce(private.workflow_integer_v1(value,1,9223372036854775807),false);
                ELSIF k IN ('stage','old_stage') THEN
                    context_bad:=context_bad OR NOT coalesce(private.workflow_typed_value_v1(value,cat#>'{fields,lead.stage}'),false);
                ELSIF k='status' THEN
                    context_bad:=context_bad OR NOT coalesce(private.workflow_typed_value_v1(value,cat#>'{fields,trial.status}'),false);
                ELSIF k NOT IN ('matched_program_ids','payment_evidence') THEN
                    context_bad:=context_bad OR NOT (coalesce(private.workflow_typed_value_v1(value,cat#>'{fields,program.id}'),false)
                        OR (value='null'::JSONB AND k IN ('program_id','student_program_membership_id','approved_program_id','approved_current_rank_id','from_rank_id')));
                END IF;
            END LOOP;
        END IF;
        -- Malformed context differences are unknown, not a fabricated successor.
        IF context_bad AND reason IN ('source_context_changed','approval_changed') THEN reason:=NULL; END IF;
    END IF;
    IF NOT source_found THEN reason:='source_missing'; END IF;
    -- Resolve exact current parents before optional contact/render availability.
    IF student_id IS NOT NULL THEN
        IF student.id IS NULL THEN SELECT * INTO student FROM public.students WHERE studio_id=p_studio_id AND id=student_id; END IF;
        IF student.id IS NULL OR student.deleted_at IS NOT NULL THEN reason:=coalesce(reason,'student_unavailable');
        ELSIF student.status<>'active' THEN reason:=coalesce(reason,'inactive'); END IF;
        IF student.id IS NOT NULL THEN
            conditions:=conditions||jsonb_build_object('student.status',student.status);
            IF (student.hold_start_date IS NULL OR isfinite(student.hold_start_date)) AND (student.hold_end_date IS NULL OR isfinite(student.hold_end_date)) THEN
                on_hold:=student.hold_start_date IS NOT NULL AND student.hold_start_date<=today AND (student.hold_end_date IS NULL OR student.hold_end_date>=today);
                conditions:=conditions||jsonb_build_object('student.on_hold',on_hold);
                IF on_hold THEN reason:=coalesce(reason,'on_hold'); END IF;
            ELSE unavailable:=true; END IF;
            minor:=CASE WHEN student.date_of_birth IS NULL THEN coalesce(student.is_minor,false)
                WHEN isfinite(student.date_of_birth) AND student.date_of_birth BETWEEN DATE '0001-01-01' AND today
                THEN student.date_of_birth>(today-INTERVAL '18 years')::DATE END;
            IF minor IS NOT NULL THEN conditions:=conditions||jsonb_build_object('student.is_minor',minor); END IF;
            templates:=templates||jsonb_build_object('student_first_name',private.workflow_fact_text_v1(CASE WHEN private.workflow_blank_v1(to_jsonb(student.preferred_name)) THEN student.legal_first_name ELSE student.preferred_name END));
        END IF;
    END IF;
    IF lead_id IS NOT NULL THEN
        IF lead.id IS NULL THEN SELECT * INTO lead FROM public.leads WHERE studio_id=p_studio_id AND id=lead_id; END IF;
        IF lead.id IS NULL THEN reason:=coalesce(reason,'lead_unavailable');
        ELSE
            conditions:=conditions||jsonb_build_object('lead.stage',lead.stage,'lead.unconverted',lead.converted_student_id IS NULL AND lead.stage<>'enrolled');
            IF lead.source IN ('walk_in','referral','social','search','website','other') THEN conditions:=conditions||jsonb_build_object('lead.source',lead.source); END IF;
            IF lead.converted_student_id IS NOT NULL OR lead.stage NOT IN ('inquiry','trial_scheduled','trial_completed','offer_sent') THEN reason:=coalesce(reason,'lead_closed'); END IF;
            templates:=templates||jsonb_build_object('lead_first_name',private.workflow_fact_text_v1(lead.first_name));
        END IF;
    END IF;
    IF meta->'field_ids' ? 'program.id' AND NOT (p_event_type='student.promoted' AND context_bad) THEN conditions:=conditions||jsonb_build_object('program.id',program_id); END IF;
    IF program_id IS NOT NULL THEN
        SELECT * INTO program FROM public.programs WHERE studio_id=p_studio_id AND id=program_id AND archived_at IS NULL;
        IF program.id IS NULL THEN reason:=coalesce(reason,'program_unavailable'); END IF;
    END IF;
    IF p_event_type='student.promoted' AND NOT context_bad THEN
        IF program_id IS NULL THEN templates:=templates||jsonb_build_object('program_name',private.workflow_fact_text_v1(NULL));
        ELSIF program.id IS NOT NULL THEN templates:=templates||jsonb_build_object('program_name',private.workflow_fact_text_v1(program.name)); END IF;
    END IF;
    IF filter_id IS NOT NULL AND NOT (p_event_type='student.promoted' AND context_bad) THEN
        IF p_event_type='student.enrolled' THEN
            IF NOT EXISTS(SELECT 1 FROM public.student_program_memberships m JOIN public.programs p ON p.studio_id=m.studio_id AND p.id=m.program_id
                WHERE m.studio_id=p_studio_id AND m.student_id=student.id AND m.program_id=filter_id AND m.status IN ('active','paused') AND m.ended_at IS NULL AND p.archived_at IS NULL)
                OR (p_captured_context IS NOT NULL AND NOT context_bad AND NOT context->'matched_program_ids' @> jsonb_build_array(filter_id)) THEN reason:=coalesce(reason,'program_unavailable'); END IF;
        ELSIF program_id IS DISTINCT FROM filter_id THEN reason:=coalesce(reason,'program_unavailable'); END IF;
    END IF;
    IF (p_event_type='student.promoted' OR is_belt) AND student.id IS NOT NULL THEN
        authority:=private.workflow_current_rank_authority_v1(p_studio_id,student.id,membership_id);
        IF authority->'pending'='true'::JSONB THEN unavailable:=true;
        ELSE
        IF NOT context_bad THEN
        IF authority#>'{context,source_exists}' IS DISTINCT FROM 'true'::JSONB OR authority#>'{context,live}' IS DISTINCT FROM 'true'::JSONB THEN
            reason:=coalesce(reason,'rank_context_lost');
        ELSIF authority->'available' IS DISTINCT FROM 'true'::JSONB THEN unavailable:=true;
        ELSIF authority#>'{context,program_id}' IS DISTINCT FROM coalesce(to_jsonb(program_id),'null'::JSONB)
            OR authority#>'{context,rank_id}' IS DISTINCT FROM coalesce(to_jsonb(rank_id),'null'::JSONB) THEN reason:=coalesce(reason,'rank_context_changed');
        ELSIF (authority->>'generation')::BIGINT<(generation#>>'{}')::BIGINT THEN unavailable:=true;
        ELSIF authority->'generation' IS DISTINCT FROM generation THEN reason:=coalesce(reason,'rank_context_superseded'); END IF;
        END IF;
        IF rank_id IS NOT NULL THEN
            SELECT * INTO rank FROM public.belt_ranks WHERE studio_id=p_studio_id AND id=rank_id;
            IF rank.id IS NULL THEN reason:=coalesce(reason,'rank_unavailable'); END IF;
        ELSIF p_event_type='student.promoted' THEN reason:=coalesce(reason,'rank_unavailable'); END IF;
        SELECT * INTO ladder FROM public.belt_ladders WHERE studio_id=p_studio_id AND id=CASE WHEN is_belt THEN event.ladder_id ELSE rank.ladder_id END;
        IF ladder.id IS NULL
            OR (rank.id IS NOT NULL AND rank.ladder_id IS DISTINCT FROM ladder.id)
            OR (NOT context_bad AND ladder.program_id IS NOT NULL AND ladder.program_id IS DISTINCT FROM program_id)
            OR (is_belt AND ladder.program_id IS DISTINCT FROM event.program_id)
            OR (is_belt AND membership_id IS NULL AND event.program_id IS NOT NULL) THEN reason:=coalesce(reason,'ladder_unavailable'); END IF;
        IF is_belt AND NOT EXISTS(SELECT 1 FROM public.belt_ranks WHERE studio_id=p_studio_id AND id=recipient.approved_target_rank_id AND ladder_id=ladder.id) THEN reason:=coalesce(reason,'rank_unavailable'); END IF;
        END IF;
        approval_current:=reason IS NULL AND NOT unavailable AND NOT context_bad;
    END IF;
    IF is_belt THEN
        -- Unknown authority is omitted; a known terminal source is diagnostic false.
        IF reason IS NOT NULL OR (NOT unavailable AND NOT context_bad) THEN conditions:=conditions||jsonb_build_object('belt_test.approval_current',approval_current); END IF;
    END IF;
    unavailable:=unavailable OR context_bad;
    templates:=templates||jsonb_build_object('studio_name',private.workflow_fact_text_v1(studio.name));
    -- Resolve each role independently; no global recipient_name or guardian fallback.
    FOREACH policy IN ARRAY p_recipient_ids LOOP
        email:=NULL; name:=NULL; kind:=NULL; contact_reason:=NULL; contact_decision:='skip';
        CASE policy
        WHEN 'student_or_guardian' THEN
            IF student.id IS NULL THEN contact_reason:='student_unavailable';
            ELSIF minor IS NULL THEN contact_reason:='invalid_birth_date'; contact_decision:='unavailable';
            ELSIF NOT minor THEN email:=private.automation_normalize_email(student.email); name:=student.legal_first_name||' '||student.legal_last_name; kind:='student';
            ELSE
                SELECT count(*) FILTER(WHERE private.automation_normalize_email(g.email) IS NOT NULL) valid_count,
                    count(*) FILTER(WHERE g.is_primary_contact) primary_count,
                    count(*) FILTER(WHERE g.is_primary_contact AND private.automation_normalize_email(g.email) IS NOT NULL) valid_primary_count,
                    max(private.automation_normalize_email(g.email)) FILTER(WHERE g.is_primary_contact) primary_email,
                    max(g.first_name||' '||g.last_name) FILTER(WHERE g.is_primary_contact) primary_name,
                    max(private.automation_normalize_email(g.email)) any_email,
                    max(g.first_name||' '||g.last_name) FILTER(WHERE private.automation_normalize_email(g.email) IS NOT NULL) any_name
                    INTO guardian FROM public.student_guardians sg JOIN public.guardians g ON g.id=sg.guardian_id AND g.studio_id=p_studio_id WHERE sg.student_id=student.id;
                IF guardian.primary_count>1 OR (guardian.valid_primary_count=0 AND guardian.valid_count>1) THEN contact_reason:='guardian_ambiguous';
                ELSIF guardian.primary_count=1 AND guardian.valid_primary_count=1 THEN email:=guardian.primary_email; name:=guardian.primary_name;
                ELSIF guardian.primary_count<=1 AND guardian.valid_count=1 THEN email:=guardian.any_email; name:=guardian.any_name;
                ELSE contact_reason:='guardian_missing'; END IF;
                kind:='guardian';
            END IF;
        WHEN 'lead_or_guardian' THEN
            IF lead.id IS NULL THEN contact_reason:='lead_unavailable';
            ELSIF lead.is_minor IS NULL THEN contact_reason:='minority_unavailable'; contact_decision:='unavailable';
            ELSIF lead.is_minor THEN email:=private.automation_normalize_email(lead.guardian_email); name:=lead.guardian_name; kind:='guardian';
            ELSE email:=private.automation_normalize_email(lead.email); name:=lead.first_name||' '||lead.last_name; kind:='lead'; END IF;
        WHEN 'assigned_staff' THEN
            staff:=private.workflow_current_staff_recipient_v1(p_studio_id,lead.assigned_staff_id);
            contact_decision:=staff->>'decision'; contact_reason:=staff->>'reason'; email:=staff->>'email'; name:=staff->>'name'; kind:='assigned_staff';
        WHEN 'invoice_payer' THEN
            IF payer.id IS NULL THEN contact_reason:='payer_unavailable';
            ELSE email:=private.automation_normalize_email(payer.email); name:=payer.display_name; kind:='invoice_payer'; END IF;
        END CASE;
        IF contact_reason IS NULL AND email IS NULL THEN contact_reason:='invalid_email'; END IF;
        IF contact_reason IS NULL AND EXISTS(SELECT 1 FROM public.automation_suppressions WHERE studio_id=p_studio_id AND recipient_email=email) THEN contact_reason:='suppressed'; END IF;
        IF contact_reason IS NULL THEN contact_decision:='ready';
        ELSE
            IF contact_decision<>'unavailable' THEN contact_decision:='skip'; END IF;
            email:=NULL; kind:=NULL;
        END IF;
        recipients:=recipients||jsonb_build_object(policy,jsonb_build_object('decision',contact_decision,'reason',contact_reason,
            'template_facts',CASE WHEN contact_decision='unavailable' THEN '{}'::JSONB ELSE jsonb_build_object('recipient_name',private.workflow_fact_text_v1(name)) END));
        addresses:=addresses||jsonb_build_object(policy,jsonb_build_object('email',email,'kind',kind));
    END LOOP;
    -- Catalog applicability is the final closed-map boundary.
    SELECT coalesce(jsonb_object_agg(e.key,e.value),'{}'::JSONB) INTO conditions FROM jsonb_each(conditions) e
        WHERE meta->'field_ids' ? e.key AND (private.workflow_typed_value_v1(e.value,cat#>ARRAY['fields',e.key])
            OR (e.value='null'::JSONB AND cat#>ARRAY['fields',e.key,'nullable']='true'::JSONB));
    SELECT coalesce(jsonb_object_agg(e.key,e.value),'{}'::JSONB) INTO templates FROM jsonb_each(templates) e WHERE meta->'template_variables' ? e.key;
    RETURN jsonb_build_object('entity_found',source_found,'facts',jsonb_build_object(
        'source_decision',CASE WHEN reason IS NOT NULL THEN 'ineligible' WHEN unavailable THEN 'unavailable' ELSE 'eligible' END,
        'source_reason',coalesce(reason,CASE WHEN unavailable THEN 'facts_unavailable' END),
        'condition_facts',conditions,'template_facts',templates,'anchors',anchors,'recipients',recipients),'recipient_addresses',addresses);
END $$;


-- Retain 20261005105341_automation_workflow_graph_v57.sql semantics and existing function privileges.
CREATE OR REPLACE FUNCTION private.workflow_invoice_episode_identity_v1() RETURNS TRIGGER
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
DECLARE state private.workflow_invoice_episode_state; pending private.workflow_invoice_episode_pending; invoice public.billing_invoices;
    payer public.billing_payers; zone TEXT; projection JSONB;
BEGIN
    SELECT * INTO pending FROM private.workflow_invoice_episode_pending WHERE studio_id=NEW.studio_id AND invoice_id=NEW.invoice_id
        AND backend_pid=pg_catalog.pg_backend_pid() AND transaction_id=pg_catalog.pg_current_xact_id();
    IF pending.invoice_id IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT'; END IF;
    IF TG_OP='UPDATE' THEN
        IF (to_jsonb(NEW)-ARRAY['closed_at','close_reason']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['closed_at','close_reason'])
            OR OLD.closed_at IS NOT NULL OR NEW.closed_at IS NULL OR NEW.close_reason IS NULL THEN
            RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT';
        END IF;
        RETURN NEW;
    END IF;
    SELECT * INTO state FROM private.workflow_invoice_episode_state WHERE studio_id=NEW.studio_id AND invoice_id=NEW.invoice_id;
    SELECT * INTO invoice FROM public.billing_invoices WHERE studio_id=NEW.studio_id AND id=NEW.invoice_id;
    SELECT * INTO payer FROM public.billing_payers WHERE studio_id=NEW.studio_id AND id=invoice.payer_id;
    SELECT private.timezone_name_or_utc(s.timezone)
        INTO zone FROM public.studios s WHERE s.id=NEW.studio_id;
    projection:=private.workflow_invoice_episode_projection_v1(invoice,payer);
    IF state.invoice_id IS NULL OR NEW.episode_number::NUMERIC<>state.episode_number::NUMERIC+1 OR NEW.closed_at IS NOT NULL OR NEW.close_reason IS NOT NULL
        OR projection->>'classification' IS DISTINCT FROM 'open_positive' OR NEW.context IS DISTINCT FROM projection->'context'
        OR NEW.frozen_timezone IS DISTINCT FROM zone OR NEW.threshold_at IS DISTINCT FROM private.workflow_invoice_episode_threshold_v1(invoice.due_date,zone)
        OR NEW.threshold_eligible IS DISTINCT FROM coalesce(NEW.threshold_at IS NOT NULL AND NEW.opened_at<=NEW.threshold_at
            AND (NEW.opened_at AT TIME ZONE zone)::DATE<=invoice.due_date,false)
        OR (state.current_episode_id IS NOT NULL AND EXISTS(SELECT 1 FROM private.workflow_invoice_collection_episodes WHERE id=state.current_episode_id AND closed_at IS NULL)) THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT';
    END IF;
    RETURN NEW;
END $$;


-- Retain 20261005105341_automation_workflow_graph_v57.sql semantics and existing function privileges.
CREATE OR REPLACE FUNCTION private.workflow_finalize_invoice_episodes_v1() RETURNS VOID
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
DECLARE item RECORD; invoice public.billing_invoices; payer public.billing_payers; state private.workflow_invoice_episode_state;
    episode private.workflow_invoice_collection_episodes; projection JSONB; decisions JSONB:='{}'; decision JSONB;
    workflows UUID[]; runs UUID[]; retired UUID[]:='{}'; at TIMESTAMPTZ; zone TEXT; boundary TIMESTAMPTZ; new_id UUID; reason TEXT; retire BOOLEAN;
BEGIN
    IF NOT EXISTS(SELECT 1 FROM private.workflow_invoice_episode_pending WHERE backend_pid=pg_catalog.pg_backend_pid()
        AND transaction_id=pg_catalog.pg_current_xact_id()) THEN RETURN; END IF;
    IF EXISTS(SELECT 1 FROM private.workflow_invoice_episode_pending p JOIN private.workflow_invoice_episode_pending own USING(invoice_id)
        WHERE own.backend_pid=pg_catalog.pg_backend_pid() AND own.transaction_id=pg_catalog.pg_current_xact_id()
        AND (p.studio_id<>own.studio_id OR p.backend_pid<>own.backend_pid OR p.transaction_id<>own.transaction_id)) THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT';
    END IF;
    FOR item IN SELECT DISTINCT studio_id FROM private.workflow_invoice_episode_pending WHERE backend_pid=pg_catalog.pg_backend_pid()
        AND transaction_id=pg_catalog.pg_current_xact_id() ORDER BY studio_id LOOP
        IF NOT pg_catalog.pg_try_advisory_xact_lock_shared(pg_catalog.hashtextextended('koaryu.local-plan-clear:'||item.studio_id::TEXT,0)) THEN
            RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STUDIO_BUSY';
        END IF;
    END LOOP;
    -- Complete source/reference ownership precedes the complete cancellation union.
    PERFORM 1 FROM public.studios s WHERE EXISTS(SELECT 1 FROM private.workflow_invoice_episode_pending p WHERE p.studio_id=s.id
        AND p.backend_pid=pg_catalog.pg_backend_pid() AND p.transaction_id=pg_catalog.pg_current_xact_id()) ORDER BY s.id FOR SHARE NOWAIT;
    PERFORM 1 FROM public.billing_invoices i WHERE EXISTS(SELECT 1 FROM private.workflow_invoice_episode_pending p WHERE p.invoice_id=i.id
        AND p.backend_pid=pg_catalog.pg_backend_pid() AND p.transaction_id=pg_catalog.pg_current_xact_id()) ORDER BY i.id FOR UPDATE NOWAIT;
    PERFORM 1 FROM public.billing_payers y WHERE EXISTS(SELECT 1 FROM public.billing_invoices i JOIN private.workflow_invoice_episode_pending p ON p.invoice_id=i.id
        AND p.studio_id=i.studio_id WHERE i.payer_id=y.id AND i.studio_id=y.studio_id AND p.backend_pid=pg_catalog.pg_backend_pid()
        AND p.transaction_id=pg_catalog.pg_current_xact_id()) ORDER BY y.id FOR SHARE NOWAIT;
    PERFORM 1 FROM private.workflow_invoice_episode_state s WHERE EXISTS(SELECT 1 FROM private.workflow_invoice_episode_pending p WHERE p.invoice_id=s.invoice_id
        AND p.backend_pid=pg_catalog.pg_backend_pid() AND p.transaction_id=pg_catalog.pg_current_xact_id()) ORDER BY s.invoice_id FOR UPDATE NOWAIT;
    PERFORM 1 FROM private.workflow_invoice_collection_episodes e WHERE EXISTS(SELECT 1 FROM private.workflow_invoice_episode_state s
        JOIN private.workflow_invoice_episode_pending p ON p.invoice_id=s.invoice_id WHERE s.current_episode_id=e.id AND p.backend_pid=pg_catalog.pg_backend_pid()
        AND p.transaction_id=pg_catalog.pg_current_xact_id()) ORDER BY e.id FOR UPDATE NOWAIT;
    FOR item IN SELECT * FROM private.workflow_invoice_episode_pending WHERE backend_pid=pg_catalog.pg_backend_pid()
        AND transaction_id=pg_catalog.pg_current_xact_id() ORDER BY invoice_id LOOP
        IF NOT EXISTS(SELECT 1 FROM public.studios WHERE id=item.studio_id) THEN CONTINUE; END IF;
        SELECT * INTO invoice FROM public.billing_invoices WHERE id=item.invoice_id;
        SELECT * INTO state FROM private.workflow_invoice_episode_state WHERE invoice_id=item.invoice_id;
        IF (invoice.id IS NOT NULL AND invoice.studio_id<>item.studio_id) OR (state.invoice_id IS NOT NULL AND state.studio_id<>item.studio_id)
            OR (state.invoice_id IS NULL AND NOT item.may_initialize) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT'; END IF;
        SELECT * INTO payer FROM public.billing_payers WHERE id=invoice.payer_id AND studio_id=item.studio_id;
        projection:=private.workflow_invoice_episode_projection_v1(invoice,payer);
        SELECT * INTO episode FROM private.workflow_invoice_collection_episodes WHERE id=state.current_episode_id;
        IF state.current_episode_id IS NOT NULL AND (episode.id IS NULL OR episode.closed_at IS NOT NULL) THEN
            RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT';
        END IF;
        retire:=episode.id IS NOT NULL AND (item.saw_known_transition OR projection->>'classification'='excluded'
            OR (projection->>'classification'='open_positive' AND projection->'context' IS DISTINCT FROM episode.context));
        reason:=CASE WHEN projection->>'classification'='excluded' THEN projection->>'reason' ELSE 'source_context_changed' END;
        IF retire OR item.saw_known_transition THEN retired:=array_append(retired,item.invoice_id); END IF;
        decisions:=decisions||jsonb_build_object(item.invoice_id::TEXT,jsonb_build_object('projection',projection,'retire',retire,'reason',reason));
    END LOOP;
    SELECT coalesce(array_agg(DISTINCT r.workflow_id ORDER BY r.workflow_id),'{}'::UUID[]),coalesce(array_agg(DISTINCT r.id ORDER BY r.id),'{}'::UUID[])
        INTO workflows,runs FROM public.automation_workflow_runs r JOIN private.automation_workflow_events e ON e.id=r.event_id AND e.studio_id=r.studio_id
        JOIN private.workflow_invoice_episode_pending p ON p.studio_id=e.studio_id AND p.invoice_id=e.subject_id
        WHERE p.backend_pid=pg_catalog.pg_backend_pid() AND p.transaction_id=pg_catalog.pg_current_xact_id() AND p.invoice_id=ANY(retired)
        AND e.event_type='invoice.overdue' AND e.subject_kind='invoice' AND r.state IN ('queued','waiting','claimed','running','sending','unknown');
    PERFORM 1 FROM public.automation_workflows WHERE id=ANY(workflows) ORDER BY id FOR UPDATE NOWAIT;
    PERFORM 1 FROM public.automation_workflow_runs WHERE id=ANY(runs) ORDER BY id FOR UPDATE NOWAIT;
    at:=clock_timestamp();
    -- No additional parent acquisition is permitted below this final clock.
    FOR item IN SELECT * FROM private.workflow_invoice_episode_pending WHERE backend_pid=pg_catalog.pg_backend_pid()
        AND transaction_id=pg_catalog.pg_current_xact_id() ORDER BY invoice_id LOOP
        decision:=decisions->item.invoice_id::TEXT;
        IF decision IS NULL THEN CONTINUE; END IF;
        projection:=decision->'projection'; reason:=decision->>'reason';
        SELECT * INTO state FROM private.workflow_invoice_episode_state WHERE invoice_id=item.invoice_id;
        IF state.invoice_id IS NULL THEN
            INSERT INTO private.workflow_invoice_episode_state(invoice_id,studio_id,updated_at) VALUES(item.invoice_id,item.studio_id,at) RETURNING * INTO state;
        END IF;
        IF (decision->>'retire')::BOOLEAN THEN
            UPDATE private.workflow_invoice_collection_episodes SET closed_at=at,close_reason=reason WHERE id=state.current_episode_id;
            UPDATE private.workflow_invoice_episode_state SET current_episode_id=NULL,updated_at=at WHERE invoice_id=item.invoice_id RETURNING * INTO state;
        END IF;
        IF item.invoice_id=ANY(retired) THEN
            PERFORM private.workflow_cancel_runs_v1(item.studio_id,ARRAY(SELECT r.id FROM public.automation_workflow_runs r
                JOIN private.automation_workflow_events e ON e.id=r.event_id AND e.studio_id=r.studio_id WHERE r.id=ANY(runs)
                AND e.studio_id=item.studio_id AND e.subject_id=item.invoice_id ORDER BY r.id),at,reason);
        END IF;
        IF state.current_episode_id IS NULL AND projection->>'classification'='open_positive' THEN
            IF state.episode_number=9223372036854775807 THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT'; END IF;
            SELECT private.timezone_name_or_utc(s.timezone)
                INTO zone FROM public.studios s WHERE s.id=item.studio_id;
            boundary:=private.workflow_invoice_episode_threshold_v1((projection#>>'{context,due_date}')::DATE,zone); new_id:=gen_random_uuid();
            INSERT INTO private.workflow_invoice_collection_episodes(id,studio_id,invoice_id,episode_number,context,opened_at,frozen_timezone,threshold_at,threshold_eligible)
                VALUES(new_id,item.studio_id,item.invoice_id,state.episode_number+1,projection->'context',at,zone,boundary,
                    coalesce(boundary IS NOT NULL AND at<=boundary AND (at AT TIME ZONE zone)::DATE<=(projection#>>'{context,due_date}')::DATE,false));
            UPDATE private.workflow_invoice_episode_state SET episode_number=episode_number+1,current_episode_id=new_id,updated_at=at WHERE invoice_id=item.invoice_id;
        END IF;
        UPDATE private.workflow_invoice_episode_state SET ever_removed=ever_removed OR item.saw_removal,updated_at=at WHERE invoice_id=item.invoice_id;
    END LOOP;
    DELETE FROM private.workflow_invoice_episode_pending WHERE backend_pid=pg_catalog.pg_backend_pid() AND transaction_id=pg_catalog.pg_current_xact_id();
END $$;


-- Retain 20261005105341_automation_workflow_graph_v57.sql semantics and existing function privileges.
CREATE OR REPLACE FUNCTION private.workflow_apply_lead_follow_up_v1(
    p_studio_id UUID,p_run_id UUID,p_step_id UUID,p_node_id TEXT,p_lead_id UUID,p_config JSONB,p_at TIMESTAMPTZ
) RETURNS VOID LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
DECLARE v_lead public.leads; zone TEXT; due DATE; activity UUID:=gen_random_uuid(); previous DATE;
BEGIN
    IF EXISTS(SELECT 1 FROM private.automation_workflow_follow_up_actions WHERE studio_id=p_studio_id AND run_id=p_run_id AND node_id=p_node_id) THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT';
    END IF;
    SELECT * INTO v_lead FROM public.leads WHERE studio_id=p_studio_id AND id=p_lead_id;
    IF v_lead.id IS NULL OR v_lead.converted_student_id IS NOT NULL OR v_lead.stage NOT IN ('inquiry','trial_scheduled','trial_completed','offer_sent') THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT';
    END IF;
    SELECT private.timezone_name_or_utc(s.timezone)
        INTO zone FROM public.studios s WHERE id=p_studio_id;
    previous:=v_lead.follow_up_date;
    due:=(p_at AT TIME ZONE zone)::DATE+(p_config->>'due_in_days')::INTEGER;
    IF (previous IS NOT NULL AND previous NOT BETWEEN DATE '0001-01-01' AND DATE '9999-12-31')
        OR due NOT BETWEEN DATE '0001-01-01' AND DATE '9999-12-31' THEN
        RAISE EXCEPTION USING ERRCODE='P57F1',MESSAGE='AUTOMATION_FACTS_UNAVAILABLE';
    END IF;
    due:=least(previous,due);
    UPDATE public.leads SET follow_up_date=due WHERE studio_id=p_studio_id AND id=p_lead_id AND follow_up_date IS DISTINCT FROM due;
    INSERT INTO public.lead_activities(id,studio_id,lead_id,activity_type,description,created_by,created_at)
        VALUES(activity,p_studio_id,p_lead_id,'note','Automation follow-up due '||to_char(due,'YYYY-MM-DD')||'.'
            ||CASE WHEN coalesce(p_config->>'note','')<>'' THEN ' '||(p_config->>'note') ELSE '' END,NULL,p_at);
    INSERT INTO private.automation_workflow_follow_up_actions(studio_id,run_id,step_id,node_id,lead_id,activity_id,previous_due_date,due_date,created_at)
        VALUES(p_studio_id,p_run_id,p_step_id,p_node_id,p_lead_id,activity,previous,due,p_at);
EXCEPTION WHEN datetime_field_overflow THEN
    RAISE EXCEPTION USING ERRCODE='P57F1',MESSAGE='AUTOMATION_FACTS_UNAVAILABLE';
END $$;

-- Advance only the inherited singleton whose referenced function bodies changed.
DO $expectation$
DECLARE changed INTEGER;
BEGIN
    UPDATE private.koaryu_release_v31_expectations
       SET expected_sha256='1513ff10defced0c619f85c7927259165f6c9eb7ef1400be076f567fd39c85b3'
     WHERE expectation_key='operational_contract_v31'
       AND expected_sha256='af3435a9266c9b482f7933dfc6ff5a756ec71fcf9eb7f3cba481e816226e50cb';
    GET DIAGNOSTICS changed = ROW_COUNT;
    IF changed<>1 THEN RAISE EXCEPTION 'V59 requires the exact V58 expectation singleton.'; END IF;
END;
$expectation$;

CREATE FUNCTION public.koaryu_release_schema_preflight_v40()
 RETURNS TABLE(ready boolean, migration_count integer, migration_head text, pending_versions text[], security_failures text[], manifest_version text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
 SET TimeZone TO 'UTC'
 SET DateStyle TO 'ISO, YMD'
 SET IntervalStyle TO 'postgres'
AS $function$
DECLARE
    v_count INTEGER;
    v_head TEXT;
    v_pending TEXT[];
    v_failures TEXT[] := ARRAY[]::TEXT[];
    v_expected TEXT;
BEGIN
    SELECT count(*)::INTEGER,
           max(version),
           array_agg(version ORDER BY version COLLATE "C")
               FILTER (WHERE version >= '20260727100000')
    INTO v_count, v_head, v_pending
    FROM supabase_migrations.schema_migrations;
    IF v_count <> 154 OR v_head <> '20261014083106' THEN
        v_failures := array_append(v_failures, 'migration_history_v59');
    END IF;
    IF COALESCE(v_pending, ARRAY[]::TEXT[]) IS DISTINCT FROM ARRAY[
        '20260727100000','20260727110000','20260801050957','20260801060000',
        '20260801070000','20260801080000','20260801090000','20260801091000',
        '20260801092000','20260801093000','20260801094000','20260801105313',
        '20260801112153','20260801115044','20260801123112','20260801131844',
        '20260814043325','20260814103046','20260814105424','20260814114500',
        '20260814152000','20260814170000','20260814183000','20260814200000',
        '20260814213000','20260815220402','20260816012723','20260820012533',
        '20260820025759','20260820060216','20260822193000','20260823193155',
        '20260824190500','20260825042838','20260825043911','20260826030234',
        '20260826030249','20260826051527',
        '20260826073728','20260826102840','20260826155911','20260826185651','20260830065627','20260830082610','20260830151714','20260831022021','20260831054918','20260902001000','20260905022339','20260908080420','20260908133504','20260908183744','20260910084231','20260910093958','20260910135133','20260910185031','20260914033337','20260914055301','20260920035023','20260920052705','20260920154441','20260925030000','20260926194918','20260929152445','20260930024404','20260930192626','20261004220435','20261005105341','20261013013243','20261014083106'
    ]::TEXT[] THEN
        v_failures := array_append(v_failures, 'migration_history_sequence_v31');
        v_failures := array_append(v_failures, 'migration_history_sequence_v30');
    END IF;
    IF private.koaryu_release_resource_ownership_manifest_v31()
       IS DISTINCT FROM '0:c205b2c94e351fd8b25071d9d788f387a61f4bfff4bfb32aa032d36cc445beae' THEN
        v_failures := array_append(v_failures, 'resource_ownership_manifest_v31');
    END IF;
    IF private.koaryu_release_schedule_window_manifest_v1()
       <> '0:f4c66d3098dcb3210ac6cc92e1831eebaf9f2ed74b210e84ec773cb1d8e854a7' THEN
        v_failures := array_append(v_failures, 'schedule_window_manifest_v1');
    END IF;
    IF encode(extensions.digest(convert_to(pg_get_functiondef(
        'private.koaryu_release_schedule_window_manifest_v1()'::REGPROCEDURE
    ), 'UTF8'), 'sha256'), 'hex')
       <> '8df0d054a33defc36a16f802283cd815a6e5cfd9b1633d7aef288daa4b8158f0' THEN
        v_failures := array_append(v_failures, 'schedule_window_manifest_v1_function');
    END IF;
    SELECT expected_sha256 INTO v_expected
    FROM private.koaryu_release_v31_expectations
    WHERE expectation_key = 'operational_contract_v31';
    IF NOT FOUND
       OR (SELECT count(*) FROM private.koaryu_release_v31_expectations) <> 1
       OR private.koaryu_release_operational_contract_v31()
            IS DISTINCT FROM '0:' || v_expected THEN
        v_failures := array_append(v_failures, 'operational_contract_v31');
    END IF;
    IF NOT EXISTS (
        SELECT 1
        FROM pg_class AS relation
        JOIN pg_namespace AS namespace ON namespace.oid=relation.relnamespace
        JOIN pg_roles AS owner ON owner.oid=relation.relowner
        WHERE namespace.nspname='private'
          AND relation.relname='koaryu_release_v31_expectations'
          AND relation.relkind='r'
          AND owner.rolname='postgres'
          AND relation.relrowsecurity
    )
       OR has_table_privilege(
            'service_role','private.koaryu_release_v31_expectations',
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
       )
       OR has_table_privilege(
            'authenticated','private.koaryu_release_v31_expectations',
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
       )
       OR has_table_privilege(
            'anon','private.koaryu_release_v31_expectations',
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
       )
       OR EXISTS (
            SELECT 1
            FROM pg_class AS relation
            CROSS JOIN LATERAL aclexplode(COALESCE(
                relation.relacl,
                acldefault('r',relation.relowner)
            )) AS privilege
            WHERE relation.oid='private.koaryu_release_v31_expectations'::REGCLASS
              AND privilege.grantee<>relation.relowner
    ) THEN
        v_failures := array_append(v_failures, 'operational_contract_v31_expectation_acl');
    END IF;
    IF EXISTS (
        WITH required_expectation_tables(table_name) AS (
            VALUES
                ('koaryu_release_v27_expectations'),
                ('koaryu_release_v28_expectations'),
                ('koaryu_release_v29_expectations'),
                ('koaryu_release_v30_expectations')
        ), expectation_table_state AS (
            SELECT
                required.table_name,
                relation.oid,
                relation.relkind,
                relation.relrowsecurity,
                owner.rolname AS owner_name,
                COALESCE((
                    SELECT count(DISTINCT privilege.privilege_type)
                    FROM aclexplode(COALESCE(
                        relation.relacl,
                        acldefault('r', relation.relowner)
                    )) AS privilege
                    WHERE privilege.grantee=relation.relowner
                      AND NOT privilege.is_grantable
                      AND privilege.privilege_type IN (
                          'SELECT','INSERT','UPDATE','DELETE',
                          'TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'
                      )
                ), 0) AS owner_privilege_count,
                EXISTS (
                    SELECT 1
                    FROM aclexplode(COALESCE(
                        relation.relacl,
                        acldefault('r', relation.relowner)
                    )) AS privilege
                    WHERE privilege.grantee<>relation.relowner
                       OR privilege.is_grantable
                       OR privilege.privilege_type NOT IN (
                          'SELECT','INSERT','UPDATE','DELETE',
                          'TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'
                       )
                ) AS unexpected_privilege
            FROM required_expectation_tables AS required
            LEFT JOIN pg_class AS relation
              ON relation.relname=required.table_name
             AND relation.relnamespace='private'::REGNAMESPACE
            LEFT JOIN pg_roles AS owner ON owner.oid=relation.relowner
        )
        SELECT 1
        FROM expectation_table_state
        WHERE oid IS NULL
           OR relkind<>'r'
           OR owner_name<>'postgres'
           OR NOT relrowsecurity
           OR owner_privilege_count<>8
           OR unexpected_privilege
    ) THEN
        v_failures := array_append(
            v_failures,
            'inherited_operational_contract_expectation_acl'
        );
    END IF;
    SELECT expected_sha256 INTO v_expected
    FROM private.koaryu_release_v30_expectations
    WHERE expectation_key = 'operational_contract_v30';
    IF NOT FOUND
       OR (SELECT count(*) FROM private.koaryu_release_v30_expectations) <> 1
       OR v_expected <> '2b57633cdd638418ca7837de9a496755e0a3620f381375657f099f6bcded8c23' THEN
        v_failures := array_append(v_failures, 'operational_contract_v30_expectation');
    END IF;
    SELECT expected_sha256 INTO v_expected
    FROM private.koaryu_release_v26_expectations
    WHERE expectation_key = 'operational_contract_v26';
    IF NOT FOUND
       OR (SELECT count(*) FROM private.koaryu_release_v26_expectations) <> 1
       OR v_expected <> '556935a0c58b3aca9509dd355798100efb1d147830875225fd8464e9a9736136'
       OR has_table_privilege('service_role', 'private.koaryu_release_v26_expectations', 'SELECT')
       OR has_table_privilege('authenticated', 'private.koaryu_release_v26_expectations', 'SELECT')
       OR has_table_privilege('anon', 'private.koaryu_release_v26_expectations', 'SELECT') THEN
        v_failures := array_append(v_failures, 'operational_contract_v26_expectation');
    END IF;
    IF encode(extensions.digest(convert_to(
        (SELECT prosrc FROM pg_proc
         WHERE oid = 'public.koaryu_release_schema_preflight_v7()'::REGPROCEDURE),
        'UTF8'
    ), 'sha256'), 'hex')
       <> '8ce5a3a090a1fc1d29dab85c65fe8be07d6efa9639950732d13cf88e854f91f1' THEN
        v_failures := array_append(v_failures, 'schema_preflight_v7_body');
    END IF;
    IF encode(extensions.digest(convert_to(
        (SELECT prosrc FROM pg_proc
         WHERE oid = 'public.koaryu_release_schema_preflight_v8()'::REGPROCEDURE),
        'UTF8'
    ), 'sha256'), 'hex')
       <> '245040e7bfe42122a551d112ec9d411999b519866e59c8cd537de02c85f9889a' THEN
        v_failures := array_append(v_failures, 'schema_preflight_v8_body');
    END IF;
    IF encode(extensions.digest(convert_to(
        (SELECT prosrc FROM pg_proc
         WHERE oid = 'public.koaryu_release_schema_preflight_v9()'::REGPROCEDURE),
        'UTF8'
    ), 'sha256'), 'hex')
       <> '0f34947cbc4126a929b69db07690ca4bc73fe8b5b9982190ebb6fe2ebbb2d179' THEN
        v_failures := array_append(v_failures, 'schema_preflight_v9_body');
    END IF;
    IF encode(extensions.digest(convert_to(
        (SELECT prosrc FROM pg_proc
         WHERE oid = 'public.koaryu_release_schema_preflight_v10()'::REGPROCEDURE),
        'UTF8'
    ), 'sha256'), 'hex')
       <> '6b14a7594f511f258d6b94863c369a67f08e142dc721429adc7cdab4d4e64f86' THEN
        v_failures := array_append(v_failures, 'schema_preflight_v10_body');
    END IF;
    IF encode(extensions.digest(convert_to(
        (SELECT prosrc FROM pg_proc
         WHERE oid = 'public.koaryu_release_schema_preflight_v11()'::REGPROCEDURE),
        'UTF8'
    ), 'sha256'), 'hex')
       <> '8270ab9a1a4ee091e700dc6fd2d33f2af5fa79dc1de34f3afd391c626e076843' THEN
        v_failures := array_append(v_failures, 'schema_preflight_v11_body');
    END IF;
    IF private.koaryu_release_operational_contract_v26()
       <> '0:eaae3521154ebb1416b3efc95d49f69a2aa583d236a4710b03fda985dae691c0' THEN
        v_failures := array_append(v_failures, 'operational_contract_v26');
    END IF;
    IF private.koaryu_release_operational_contract_v27()
       <> '0:9c6c6f80b94c0412170e2ae59a8d8f1243c3fd049852e50e551592c1d389de07' THEN
        v_failures := array_append(v_failures, 'operational_contract_v27');
    END IF;
    IF private.koaryu_release_operational_contract_v28()
       <> '0:8ca312d765bde9dff26086e888638ee12eb49da8d028e33e6e01455c500e1fdd' THEN
        v_failures := array_append(v_failures, 'operational_contract_v28');
    END IF;
    IF private.koaryu_release_operational_contract_v29()
       <> '0:ad66d5b59dcf033b05cc3a9c3eaece3943972b9e197cbcc55854e3f3aee8b99b' THEN
        v_failures := array_append(v_failures, 'operational_contract_v29');
    END IF;
    IF private.koaryu_release_operational_contract_v30()
       <> '0:1c245a6142a2e9ca2d3249d8772530798cca4ab8a0d9fe9059277f1c37501a4e' THEN
        v_failures := array_append(v_failures, 'operational_contract_v30');
    END IF;
    IF encode(extensions.digest(convert_to(pg_get_functiondef(
        'private.koaryu_release_payments_replay_repairs_manifest_v30()'::REGPROCEDURE
    ), 'UTF8'), 'sha256'), 'hex')
       <> 'a70b46c8b13a88f51d795be3ae4bc759bcc14495fda1cab9629e5c9c86e66228' THEN
        v_failures := array_append(v_failures, 'payments_replay_repairs_manifest_v30_function');
    END IF;
    IF encode(extensions.digest(convert_to(pg_get_functiondef(
        'private.koaryu_release_operational_manifest_v11()'::REGPROCEDURE
    ), 'UTF8'), 'sha256'), 'hex')
       <> '79e338cb42307acf37e395647f29dbb88df57fa8d65443cc976a30c566cff6d2' THEN
        v_failures := array_append(v_failures, 'operational_manifest_v11_function');
    END IF;
    IF private.koaryu_release_operational_manifest_v11()
       <> '6bd9219671f61de0ac124efaacc894af329b6d86e8c092aa4ff65f614eedffa7' THEN
        v_failures := array_append(v_failures, 'operational_manifest_v11');
    END IF;
    IF private.koaryu_release_provider_operation_steps_manifest_v28()
       <> '0:9f285d9d386666f8b42a6ce9d2c04eac3a6f897f979bb4e8d47c81c318ab5c53' THEN
        v_failures := array_append(v_failures, 'provider_operation_steps_manifest_v28');
        v_failures := array_append(v_failures, 'operational_contract_v28');
    END IF;
    IF encode(extensions.digest(convert_to(pg_get_functiondef(
        'private.koaryu_release_resource_ownership_manifest_v31()'::REGPROCEDURE
    ), 'UTF8'), 'sha256'), 'hex')
       <> '6ee84c579e50be2b514ac00c975c1f60cf5f116e36adc27fe4296312e5188090' THEN
        v_failures:=array_append(v_failures,'resource_ownership_manifest_v31_function');
    END IF;
    IF encode(extensions.digest(convert_to(pg_get_functiondef(
        'private.koaryu_release_operational_contract_v31()'::REGPROCEDURE
    ), 'UTF8'), 'sha256'), 'hex')
       <> '6b54e02534f38bcd7bb6e6e811d9e01c9782958319514fee3f0a2f1d4ed167d4' THEN
        v_failures:=array_append(v_failures,'operational_contract_v31_function');
    END IF;
    IF encode(extensions.digest(convert_to(pg_get_functiondef(
        'private.koaryu_release_provider_operation_steps_manifest_v28()'::REGPROCEDURE
    ), 'UTF8'), 'sha256'), 'hex')
       <> 'b16b633c6f78a2d5cf7d63f1d32679563ff2429197cc92a4d94e826b33a26035' THEN
        v_failures:=array_append(v_failures,'provider_operation_steps_manifest_v28_function');
    END IF;
    IF private.koaryu_release_live_billing_v3_manifest_v25()
       <> '0:45cb113e37c4ded47a36179688cb2cb5159567b949ffd038e74a63ee9f35ea73' THEN
        v_failures := array_append(v_failures, 'live_billing_v3_manifest_v25');
        v_failures := array_append(v_failures, 'operational_contract_v26');
        v_failures := array_append(v_failures, 'operational_contract_v27');
    END IF;
    IF encode(extensions.digest(convert_to(pg_get_functiondef(
        'private.koaryu_release_operational_manifest_v7()'::REGPROCEDURE
    ), 'UTF8'), 'sha256'), 'hex')
       <> '2615e19ea37158de13259f072419f7047440a2ad1065288e7b0056d21439f57f' THEN
        v_failures := array_append(v_failures, 'operational_manifest_v7_function');
    END IF;
    IF encode(extensions.digest(convert_to(pg_get_functiondef(
        'public.set_studio_live_billing_authorization_operations_v1(uuid,text,boolean,timestamp with time zone,text,uuid,text[],text,text)'::REGPROCEDURE
    ), 'UTF8'), 'sha256'), 'hex')
       <> '6500b8aaf8bb91cc91841f2bafaf3699b7ffa328ccaba4a0023721e3eb68f811' THEN
        v_failures := array_append(v_failures, 'operation_authorization_writer_function');
    END IF;
    IF has_function_privilege(
        'service_role',
        'public.set_studio_live_billing_authorization_scope_v3(uuid,text,boolean,timestamp with time zone,text,uuid,text,text)',
        'EXECUTE'
    ) THEN
        v_failures := array_append(v_failures, 'legacy_authorization_scope_execute');
    END IF;
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'public.studio_live_billing_authorizations'::REGCLASS
          AND conname = 'studio_live_billing_authorizations_operation_set_exact'
          AND convalidated
    ) THEN
        v_failures := array_append(v_failures, 'operation_allowlist_constraint');
    END IF;
    IF NOT EXISTS (
        SELECT 1
        FROM pg_attribute AS attribute
        LEFT JOIN pg_attrdef AS default_value
          ON default_value.adrelid = attribute.attrelid
         AND default_value.adnum = attribute.attnum
        WHERE attribute.attrelid = 'public.studio_live_billing_authorizations'::REGCLASS
          AND attribute.attname = 'allowed_operations'
          AND NOT attribute.attisdropped
          AND attribute.attnotnull
          AND format_type(attribute.atttypid, attribute.atttypmod) = 'text[]'
          AND pg_get_expr(default_value.adbin, default_value.adrelid) = 'ARRAY[]::text[]'
    ) THEN
        v_failures := array_append(v_failures, 'operation_allowlist_column');
    END IF;
    IF private.live_billing_operation_set_is_canonical_v1(
            'connect_payments',ARRAY[
                'connected_subscription_schedule.create',
                'connected_subscription_schedule.release',
                'connected_subscription_schedule.update'
            ]::TEXT[]
       ) IS DISTINCT FROM true
       OR private.live_billing_operation_set_is_canonical_v1(
            'connect_payments',ARRAY[
                'connected_subscription_schedule.update',
                'connected_subscription_schedule.create'
            ]::TEXT[]
       ) IS DISTINCT FROM false
       OR private.live_billing_operation_set_is_canonical_v1(
            'connect_payments',ARRAY[
                'connected_subscription_schedule.create',
                'connected_subscription_schedule.unknown'
            ]::TEXT[]
       ) IS DISTINCT FROM false THEN
        v_failures := array_append(
            v_failures,'operation_allowlist_schedule_semantics'
        );
    END IF;
    IF private.koaryu_release_operational_manifest_v12()
       IS DISTINCT FROM 'e146e9eca5fdfdbeed736f58ed81bd3461da5f9c4dca77cdef3a6bd13e0385e7' THEN
        v_failures := array_append(v_failures, 'operational_manifest_v12');
    END IF;
    IF encode(extensions.digest(convert_to(pg_get_functiondef(
        'private.koaryu_release_operational_manifest_v12()'::REGPROCEDURE
    ), 'UTF8'), 'sha256'), 'hex')
       <> '57a017e4e7be92f023d31dc4a18e75b95c676765f42b54f9f5fb9f4b768ca3bd' THEN
        v_failures := array_append(v_failures, 'operational_manifest_v12_function');
    END IF;
    IF private.koaryu_release_invoice_retry_preread_manifest_v32()
           <> '0:9c658ccd26b813cabc195023f2cac43a76b7c2dff4558b3f68659ad9c70c6cf5' THEN
            v_failures := array_append(
                v_failures,'invoice_retry_preread_manifest_v32'
            );
        END IF;
        IF private.koaryu_release_invoice_retry_compatibility_manifest_v33()
       <> '0:8497daa806dcd7e33992fe8ca76f3207eb36b41e5a976be781e3bf33b22d4fdb' THEN
      v_failures:=array_append(v_failures,'invoice_retry_compatibility_manifest_v33');
    END IF;
    IF private.koaryu_release_invoice_retry_closeout_manifest_v34()
       <> '0:70e87b852a84f9fcad61413ea8660fdf9d5adcb028ec03427f30d815e42526b6' THEN
      v_failures:=array_append(v_failures,'invoice_retry_closeout_manifest_v34');
    END IF;
    IF private.koaryu_release_stripe_rehearsal_evidence_manifest_v35()
       IS DISTINCT FROM (SELECT evidence_manifest FROM private.koaryu_release_v35_expectations
                          WHERE singleton) THEN
      v_failures:=array_append(v_failures,'stripe_rehearsal_evidence_manifest_v35');
    END IF;
    IF has_function_privilege('anon',
      'public.read_stripe_rehearsal_local_evidence_v1(uuid,text,integer,timestamptz,timestamptz,jsonb,uuid[],uuid,text[],text[])','EXECUTE')
       OR has_function_privilege('authenticated',
      'public.read_stripe_rehearsal_local_evidence_v1(uuid,text,integer,timestamptz,timestamptz,jsonb,uuid[],uuid,text[],text[])','EXECUTE')
       OR NOT has_function_privilege('service_role',
      'public.read_stripe_rehearsal_local_evidence_v1(uuid,text,integer,timestamptz,timestamptz,jsonb,uuid[],uuid,text[],text[])','EXECUTE') THEN
      v_failures:=array_append(v_failures,'stripe_rehearsal_evidence_acl_v35');
    END IF;
    IF private.koaryu_release_payer_setup_recovery_manifest_v36()
    IS DISTINCT FROM (SELECT recovery_manifest FROM private.koaryu_release_v36_expectations WHERE singleton) THEN
   v_failures:=array_append(v_failures,'payer_setup_recovery_manifest_v36');
 END IF;
 IF private.koaryu_release_adjustment_trigger_guard_manifest_v37()
      IS DISTINCT FROM (
        SELECT trigger_guard_manifest
        FROM private.koaryu_release_v37_expectations
        WHERE singleton
      ) THEN
     v_failures:=array_append(v_failures,'adjustment_trigger_guard_manifest_v37');
   END IF;

 IF EXISTS (
  SELECT 1 FROM (VALUES
  ('public.billing_payment_cohort(uuid,timestamptz,timestamptz)','5d6f683e3c56fe05db7e4101073d1a23792081192219cfa9eda4db8dcf734a1d'),
  ('public.billing_landing_aggregates(uuid,timestamptz,timestamptz)','9af84c3c261a4ddb8aad9bc1c9cc332260fb1e31b1e7f51816b402339e2ad576'),
  ('public.billing_webhook_health(text,boolean,timestamptz)','3bdcc77c7d768e5ede8750900c0b75ac98bdffbb14ada059c580185133a9fd52')
  ) expected(signature,body_hash)
  LEFT JOIN pg_catalog.pg_proc p ON p.oid=to_regprocedure(expected.signature)
  WHERE p.oid IS NULL OR p.prosecdef OR p.provolatile<>'s'
  OR p.proowner <> 'postgres'::regrole OR p.prorettype<>'jsonb'::regtype
  OR NOT ('search_path=""'=ANY(coalesce(p.proconfig,ARRAY[]::text[])))
  OR encode(extensions.digest(convert_to(p.prosrc,'UTF8'),'sha256'),'hex')<>expected.body_hash
  OR NOT has_function_privilege('service_role',p.oid,'EXECUTE')
  OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
            WHERE a.privilege_type='EXECUTE' AND a.grantee NOT IN ('postgres'::regrole,'service_role'::regrole))
 ) THEN v_failures:=array_append(v_failures,'billing_landing_reads_v38'); END IF;
 IF EXISTS (
  SELECT 1 FROM (VALUES
   ('public.idx_billing_invoices_studio_history','public.billing_invoices','CREATE INDEX idx_billing_invoices_studio_history ON public.billing_invoices USING btree (studio_id, created_at DESC, id DESC)'),
   ('public.idx_billing_payments_studio_history','public.billing_payments','CREATE INDEX idx_billing_payments_studio_history ON public.billing_payments USING btree (studio_id, created_at DESC, id DESC)')
  ) expected(index_name,table_name,definition)
  LEFT JOIN pg_catalog.pg_class c ON c.oid=to_regclass(expected.index_name)
  LEFT JOIN pg_catalog.pg_index i ON i.indexrelid=c.oid
  WHERE c.oid IS NULL OR c.relkind<>'i' OR c.relowner<>'postgres'::regrole
   OR i.indrelid IS DISTINCT FROM to_regclass(expected.table_name)
   OR i.indisvalid IS DISTINCT FROM true OR i.indisready IS DISTINCT FROM true
   OR i.indislive IS DISTINCT FROM true OR i.indisunique IS DISTINCT FROM false
   OR pg_get_indexdef(i.indexrelid) IS DISTINCT FROM expected.definition
 ) THEN v_failures:=array_append(v_failures,'billing_history_indexes_v38'); END IF;
 IF EXISTS (
  SELECT 1 FROM pg_catalog.pg_proc p
  WHERE p.oid='private.koaryu_release_critical_surface_manifest_v16()'::REGPROCEDURE
    AND (p.proowner <> 'postgres'::REGROLE OR p.prosecdef OR p.provolatile <> 's'
      OR encode(extensions.digest(convert_to(pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
         IS DISTINCT FROM '7fb0ba103de76167982cc96f0698d7516418ababb0892dc70d5c85e1d83efc0f'
      OR EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
                 WHERE a.grantee <> p.proowner))
 ) THEN v_failures:=array_append(v_failures,'rank_command_manifest_v40_definition'); END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='recompute_billing_payer_balance_v1') <> 1
       OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure('public.recompute_billing_payer_balance_v1(uuid,uuid)')
          AND p.proowner='postgres'::REGROLE AND p.prosecdef AND p.provolatile='v'
          AND p.prorettype='void'::REGTYPE AND NOT p.proretset
          AND p.proconfig=ARRAY['search_path=""']::TEXT[]
          AND encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
              = '78890d7907bb56bfdb337df262b17cc5144f8bd87d169df26a10fc048072670f'
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                         a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
              = '[ ["postgres","postgres","EXECUTE",false], ["service_role","postgres","EXECUTE",false] ]'::JSONB
       ) THEN
        v_failures:=array_append(v_failures,'payer_balance_rpc_v41');
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='record_external_payment_v1') <> 1
       OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure('public.record_external_payment_v1(uuid,uuid,uuid,integer,text,text,text,text,text)')
          AND p.proowner='postgres'::REGROLE AND NOT p.prosecdef AND p.provolatile='v'
          AND p.prorettype='jsonb'::REGTYPE AND NOT p.proretset
          AND p.proconfig=ARRAY['search_path=""']::TEXT[]
          AND encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
              = '150aedb400108d00c3fe90ca3de7d4ccde6df24ad8dda4f045cd6256af1ad13d'
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                         a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
              = '[ ["postgres","postgres","EXECUTE",false], ["service_role","postgres","EXECUTE",false] ]'::JSONB
       ) THEN
        v_failures:=array_append(v_failures,'external_payment_rpc_v43');
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='write_billing_plan_v1') <> 1
       OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure('public.write_billing_plan_v1(uuid,uuid,uuid,jsonb,uuid[])')
          AND p.proowner='postgres'::REGROLE AND NOT p.prosecdef AND p.provolatile='v'
          AND p.prorettype='jsonb'::REGTYPE AND NOT p.proretset
          AND p.proconfig=ARRAY['search_path=""']::TEXT[]
          AND encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
              = 'ac577f4bec60aecc52b4950eda7d8a8a469d6ac035d05afeabb74e3a9c8fe789'
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                         a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
              = '[ ["postgres","postgres","EXECUTE",false], ["service_role","postgres","EXECUTE",false] ]'::JSONB
       ) THEN
        v_failures:=array_append(v_failures,'local_plan_rpc_v44');
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='clear_studio_operational_data_atomic') <> 1
       OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure('public.clear_studio_operational_data_atomic(uuid,boolean)')
          AND p.proowner='postgres'::REGROLE AND NOT p.prosecdef AND p.provolatile='v'
          AND p.prorettype='void'::REGTYPE AND NOT p.proretset
          AND p.proconfig=ARRAY['search_path=public, pg_temp']::TEXT[]
          AND encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
              = 'fd4f3a1e65eef9f113ac8a648b72d45d84c5d9261e6436bd4aabe6c4643221fd'
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                         a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
              = '[ ["postgres","postgres","EXECUTE",false], ["service_role","postgres","EXECUTE",false] ]'::JSONB
       ) THEN
        v_failures:=array_append(v_failures,'local_plan_clear_coordination_v44');
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='private' AND p.proname='claim_student_import_run_owned') <> 1
       OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure('private.claim_student_import_run_owned(uuid,uuid,text,text,text,text,boolean,integer)')
          AND p.proowner='postgres'::REGROLE AND NOT p.prosecdef AND p.provolatile='v'
          AND p.prorettype='record'::REGTYPE AND p.proretset
          AND p.proconfig=ARRAY['search_path=pg_catalog']::TEXT[]
          AND encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
              = '34c8fbfd2e843be56034d686c2d90911c6c3938ca5e71da1616ea092a6edcddc'
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                         a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
              = '[ ["postgres","postgres","EXECUTE",false], ["service_role","postgres","EXECUTE",false] ]'::JSONB
       ) THEN
        v_failures:=array_append(v_failures,'import_private_claim_student_import_run_owned_v45');
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='private' AND p.proname='import_student_row_atomic') <> 1
       OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure('private.import_student_row_atomic(jsonb,uuid,uuid,text,integer,text,text,text,text,uuid[])')
          AND p.proowner='postgres'::REGROLE AND NOT p.prosecdef AND p.provolatile='v'
          AND p.prorettype='record'::REGTYPE AND p.proretset
          AND p.proconfig=ARRAY['search_path=public, pg_temp']::TEXT[]
          AND encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
              = 'afb0c874110e03126be86e561bd1c4cac0391c404f5ecd2c5b342799a625b8a7'
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                         a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
              = '[ ["postgres","postgres","EXECUTE",false], ["service_role","postgres","EXECUTE",false] ]'::JSONB
       ) THEN
        v_failures:=array_append(v_failures,'import_private_import_student_row_atomic_v45');
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='private' AND p.proname='lock_student_import_actor') <> 1
       OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure('private.lock_student_import_actor(uuid)')
          AND p.proowner='postgres'::REGROLE AND p.prosecdef AND p.provolatile='v'
          AND p.prorettype='boolean'::REGTYPE AND NOT p.proretset
          AND p.proconfig=ARRAY['search_path=pg_catalog']::TEXT[]
          AND encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
              = 'd04e6d08b7fd24eca4a46eddf8fbcaaeeef80d65431e55de5562a198ac09c331'
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                         a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
              = '[ ["postgres","postgres","EXECUTE",false], ["service_role","postgres","EXECUTE",false] ]'::JSONB
       ) THEN
        v_failures:=array_append(v_failures,'import_private_lock_student_import_actor_v45');
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='private' AND p.proname='lock_student_import_run') <> 1
       OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure('private.lock_student_import_run(uuid,uuid,text)')
          AND p.proowner='postgres'::REGROLE AND NOT p.prosecdef AND p.provolatile='v'
          AND p.prorettype='public.student_import_runs'::REGTYPE AND NOT p.proretset
          AND p.proconfig=ARRAY['search_path=pg_catalog']::TEXT[]
          AND encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
              = '95ea7bdd011af07a17f77120ab7227dd540a1e612b79e03f305f9f5c591002af'
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                         a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
              = '[ ["postgres","postgres","EXECUTE",false], ["service_role","postgres","EXECUTE",false] ]'::JSONB
       ) THEN
        v_failures:=array_append(v_failures,'import_private_lock_student_import_run_v45');
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='claim_student_import_run') <> 1
       OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure('public.claim_student_import_run(uuid,uuid,text,text,text,text,integer)')
          AND p.proowner='postgres'::REGROLE AND NOT p.prosecdef AND p.provolatile='v'
          AND p.prorettype='record'::REGTYPE AND p.proretset
          AND p.proconfig=ARRAY['search_path=public, pg_temp']::TEXT[]
          AND encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
              = '187d0eb3385fc7958efc0dedc1e2a39a61224b59596f4611339b6eb7da1c159d'
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                         a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
              = '[ ["postgres","postgres","EXECUTE",false], ["service_role","postgres","EXECUTE",false] ]'::JSONB
       ) THEN
        v_failures:=array_append(v_failures,'import_public_claim_student_import_run_v45');
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='claim_student_import_run_v2') <> 1
       OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure('public.claim_student_import_run_v2(uuid,uuid,text,text,text,text,integer)')
          AND p.proowner='postgres'::REGROLE AND NOT p.prosecdef AND p.provolatile='v'
          AND p.prorettype='record'::REGTYPE AND p.proretset
          AND p.proconfig=ARRAY['search_path=pg_catalog']::TEXT[]
          AND encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
              = '91c5c8919bd1ddfc2b9bfa82ca9cced577a94974e7854a17fc3156540216add2'
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                         a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
              = '[ ["postgres","postgres","EXECUTE",false], ["service_role","postgres","EXECUTE",false] ]'::JSONB
       ) THEN
        v_failures:=array_append(v_failures,'import_public_claim_student_import_run_v2_v45');
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='finish_student_import_run') <> 1
       OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure('public.finish_student_import_run(uuid,text,text,jsonb,text)')
          AND p.proowner='postgres'::REGROLE AND NOT p.prosecdef AND p.provolatile='v'
          AND p.prorettype='record'::REGTYPE AND p.proretset
          AND p.proconfig=ARRAY['search_path=public, pg_temp']::TEXT[]
          AND encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
              = '8f40eed2f27ce892b08a673121247a34e8eaf342e0fb9953b6c873945e16b032'
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                         a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
              = '[ ["postgres","postgres","EXECUTE",false], ["service_role","postgres","EXECUTE",false] ]'::JSONB
       ) THEN
        v_failures:=array_append(v_failures,'import_public_finish_student_import_run_v45');
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='import_student_row_atomic') <> 1
       OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure('public.import_student_row_atomic(jsonb,uuid,uuid,text,integer,text,text,text,text,uuid[])')
          AND p.proowner='postgres'::REGROLE AND NOT p.prosecdef AND p.provolatile='v'
          AND p.prorettype='record'::REGTYPE AND p.proretset
          AND p.proconfig=ARRAY['search_path=pg_catalog, public, private']::TEXT[]
          AND encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
              = '6d9d129040e0f3cb831cbb883c56ee6c8bf4c4b18aff59eb55c0ccf862ae2bd9'
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                         a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
              = '[ ["postgres","postgres","EXECUTE",false], ["service_role","postgres","EXECUTE",false] ]'::JSONB
       ) THEN
        v_failures:=array_append(v_failures,'import_public_import_student_row_atomic_v45');
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='bind_student_import_rank_v1') <> 1
       OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure('public.bind_student_import_rank_v1(uuid,uuid,text,uuid,text,uuid)')
          AND p.proowner='postgres'::REGROLE AND NOT p.prosecdef AND p.provolatile='v'
          AND p.prorettype='jsonb'::REGTYPE AND NOT p.proretset
          AND p.proconfig=ARRAY['search_path=pg_catalog']::TEXT[]
          AND encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
              = 'e428fbeb91f8457bf717917bd93685531188d49d25b003eb2bd6ab7f184f2e68'
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                         a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
              = '[ ["postgres","postgres","EXECUTE",false], ["service_role","postgres","EXECUTE",false] ]'::JSONB
       ) THEN
        v_failures:=array_append(v_failures,'import_public_bind_student_import_rank_v1_v45');
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='prepare_student_import_belts_v1') <> 1
       OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure('public.prepare_student_import_belts_v1(uuid,uuid,text,uuid,uuid,jsonb,boolean)')
          AND p.proowner='postgres'::REGROLE AND NOT p.prosecdef AND p.provolatile='v'
          AND p.prorettype='jsonb'::REGTYPE AND NOT p.proretset
          AND p.proconfig=ARRAY['search_path=pg_catalog']::TEXT[]
          AND encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
              = '7b61469ec2de918d7f79effa3a52c590b3eef9416c2ba716f1b6d9cfc91669bb'
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                         a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
              = '[ ["postgres","postgres","EXECUTE",false], ["service_role","postgres","EXECUTE",false] ]'::JSONB
       ) THEN
        v_failures:=array_append(v_failures,'import_public_prepare_student_import_belts_v1_v45');
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='prepare_student_import_program_v1') <> 1
       OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure('public.prepare_student_import_program_v1(uuid,uuid,text,text,uuid,text,uuid,boolean,boolean)')
          AND p.proowner='postgres'::REGROLE AND NOT p.prosecdef AND p.provolatile='v'
          AND p.prorettype='jsonb'::REGTYPE AND NOT p.proretset
          AND p.proconfig=ARRAY['search_path=pg_catalog']::TEXT[]
          AND encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
              = '25fadfe0298192b7d2bf6c6210ad199743e7dd01d9dd035e7c9f36ba7c17794e'
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                         a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
              = '[ ["postgres","postgres","EXECUTE",false], ["service_role","postgres","EXECUTE",false] ]'::JSONB
       ) THEN
        v_failures:=array_append(v_failures,'import_public_prepare_student_import_program_v1_v45');
    END IF;
    IF (SELECT jsonb_build_object(
            'owner',pg_catalog.pg_get_userbyid(relation.relowner),
            'rls',relation.relrowsecurity,'force_rls',relation.relforcerowsecurity,
            'columns',(SELECT jsonb_agg(jsonb_build_array(attribute.attname,
                pg_catalog.format_type(attribute.atttypid,attribute.atttypmod),attribute.attnotnull,
                pg_catalog.pg_get_expr(default_value.adbin,default_value.adrelid),
                attribute.attidentity,attribute.attgenerated,attribute.attacl IS NULL) ORDER BY attribute.attnum)
                FROM pg_catalog.pg_attribute attribute
                LEFT JOIN pg_catalog.pg_attrdef default_value
                  ON default_value.adrelid=attribute.attrelid AND default_value.adnum=attribute.attnum
                WHERE attribute.attrelid=relation.oid AND attribute.attnum>0 AND NOT attribute.attisdropped),
            'acl',(SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN acl.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(acl.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(acl.grantor)::TEXT,acl.privilege_type,acl.is_grantable)
                ORDER BY CASE WHEN acl.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(acl.grantee)::TEXT END COLLATE "C",
                         acl.privilege_type,acl.is_grantable)
                FROM pg_catalog.aclexplode(COALESCE(relation.relacl,pg_catalog.acldefault('r',relation.relowner))) acl),
            'constraints',(SELECT jsonb_agg(jsonb_build_array(constraint_row.conname,constraint_row.contype,
                constraint_row.convalidated,constraint_row.condeferrable,constraint_row.condeferred,
                pg_catalog.pg_get_constraintdef(constraint_row.oid)) ORDER BY constraint_row.conname COLLATE "C")
                FROM pg_catalog.pg_constraint constraint_row WHERE constraint_row.conrelid=relation.oid),
            'indexes',(SELECT jsonb_agg(jsonb_build_array(index_relation.relname,index_row.indisvalid,
                index_row.indisready,index_row.indisunique,index_row.indisprimary,pg_catalog.pg_get_indexdef(index_row.indexrelid))
                ORDER BY index_relation.relname COLLATE "C")
                FROM pg_catalog.pg_index index_row JOIN pg_catalog.pg_class index_relation ON index_relation.oid=index_row.indexrelid
                WHERE index_row.indrelid=relation.oid),
            'no_policies',NOT EXISTS(SELECT 1 FROM pg_catalog.pg_policy policy WHERE policy.polrelid=relation.oid),
            'no_user_triggers',NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger trigger_row
                WHERE trigger_row.tgrelid=relation.oid AND NOT trigger_row.tgisinternal))
        FROM pg_catalog.pg_class relation WHERE relation.oid=pg_catalog.to_regclass('private.student_import_receipts')
          AND relation.relkind='r') IS DISTINCT FROM '{"owner":"postgres","rls":false,"force_rls":false,"columns":[["import_run_id","uuid",true,null,"","",true],["kind","text",true,null,"","",true],["key","text",true,null,"","",true],["result_json","jsonb",true,null,"","",true],["created_at","timestamp with time zone",true,"now()","","",true]],"acl":[["postgres","postgres","DELETE",false],["postgres","postgres","INSERT",false],["postgres","postgres","MAINTAIN",false],["postgres","postgres","REFERENCES",false],["postgres","postgres","SELECT",false],["postgres","postgres","TRIGGER",false],["postgres","postgres","TRUNCATE",false],["postgres","postgres","UPDATE",false],["service_role","postgres","INSERT",false],["service_role","postgres","SELECT",false]],"constraints":[["student_import_receipts_import_run_id_fkey","f",true,false,false,"FOREIGN KEY (import_run_id) REFERENCES public.student_import_runs(id) ON DELETE CASCADE"],["student_import_receipts_key_check","c",true,false,false,"CHECK (((char_length(key) >= 1) AND (char_length(key) <= 512)))"],["student_import_receipts_kind_check","c",true,false,false,"CHECK ((kind = ANY (ARRAY[''student''::text, ''program''::text, ''ladder''::text, ''rank''::text])))"],["student_import_receipts_pkey","p",true,false,false,"PRIMARY KEY (import_run_id, kind, key)"],["student_import_receipts_result_json_check","c",true,false,false,"CHECK ((jsonb_typeof(result_json) = ''object''::text))"]],"indexes":[["student_import_receipts_pkey",true,true,true,true,"CREATE UNIQUE INDEX student_import_receipts_pkey ON private.student_import_receipts USING btree (import_run_id, kind, key)"]],"no_policies":true,"no_user_triggers":true}'::JSONB
       OR (SELECT jsonb_build_array(pg_catalog.format_type(attribute.atttypid,attribute.atttypmod),
                attribute.attnotnull,pg_catalog.pg_get_expr(default_value.adbin,default_value.adrelid),
                attribute.attidentity,attribute.attgenerated,attribute.attacl IS NULL)
            FROM pg_catalog.pg_attribute attribute LEFT JOIN pg_catalog.pg_attrdef default_value
              ON default_value.adrelid=attribute.attrelid AND default_value.adnum=attribute.attnum
            WHERE attribute.attrelid=pg_catalog.to_regclass('public.student_import_runs')
              AND attribute.attname='receipts_enabled' AND NOT attribute.attisdropped)
          IS DISTINCT FROM '["boolean",true,"false","","",true]'::JSONB THEN
        v_failures:=array_append(v_failures,'import_receipts_v45');
    END IF;
    IF private.koaryu_release_student_rank_writer_manifest_v13()
       IS DISTINCT FROM '4:d34f843175fbf8d24fae0c6e9d80101cf2590d23ac6724e957ba7e04e68eb267' THEN
        v_failures := array_append(v_failures, 'import_rank_manifest_v45');
    END IF;
    IF encode(extensions.digest(convert_to(pg_get_functiondef(
        'private.koaryu_release_student_rank_writer_manifest_v13()'::REGPROCEDURE
    ), 'UTF8'), 'sha256'), 'hex')
       <> 'feed7c0421cbeb5bcb2555837dd1c244367f180c8a884380f2f281ef919c82ee' THEN
        v_failures := array_append(v_failures, 'import_rank_manifest_definition_v45');
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='begin_billing_enrollment_activation_v1') <> 1
       OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure('public.begin_billing_enrollment_activation_v1(uuid,uuid,uuid,text,text,text,text,integer,uuid,bigint,uuid,text,text)')
          AND p.proowner='postgres'::REGROLE AND p.prosecdef AND p.provolatile='v'
          AND p.prorettype='jsonb'::REGTYPE AND NOT p.proretset
          AND p.proconfig=ARRAY['search_path=""']::TEXT[]
          AND encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
              = 'a104d7696ec9a711358697783ca065c9d78233ffa4c63d77633c8fcf42ff5e59'
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                         a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
              = '[ ["postgres","postgres","EXECUTE",false], ["service_role","postgres","EXECUTE",false] ]'::JSONB
       ) THEN
        v_failures:=array_append(v_failures,'activation_begin_v48');
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='reject_billing_autopay_activation_without_provider_v31') <> 1
       OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure('public.reject_billing_autopay_activation_without_provider_v31(uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,integer,uuid,text,text,bigint)')
          AND p.proowner='postgres'::REGROLE AND p.prosecdef AND p.provolatile='v'
          AND p.prorettype='jsonb'::REGTYPE AND NOT p.proretset
          AND p.proconfig=ARRAY['search_path=""']::TEXT[]
          AND encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
              = 'b2bee4e53471d0a949ff4533f7ab14938c4fc919e8c97ce8d767f854bc876b44'
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                         a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
              = '[ ["postgres","postgres","EXECUTE",false], ["service_role","postgres","EXECUTE",false] ]'::JSONB
       ) THEN
        v_failures:=array_append(v_failures,'activation_rejection_v48');
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_attribute a
        LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
        WHERE a.attrelid='public.billing_subscriptions'::REGCLASS
          AND a.attname IN ('currency','billing_interval') AND NOT a.attisdropped
          AND a.atttypid='text'::REGTYPE AND NOT a.attnotnull AND d.oid IS NULL
          AND a.attidentity='' AND a.attgenerated='') IS DISTINCT FROM 2 THEN
        v_failures:=array_append(v_failures,'subscription_terms_v49');
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='billing_invoice_collection_facts_v1') <> 1
       OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure('public.billing_invoice_collection_facts_v1(uuid,uuid,date)')
          AND p.proowner='postgres'::REGROLE AND NOT p.prosecdef AND p.provolatile='s'
          AND p.prorettype='record'::REGTYPE AND p.proretset
          AND p.proconfig=ARRAY['search_path=""']::TEXT[]
          AND encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
              = '40d16d06464c028c1bd4a27089163181865cd65a8ce963b1738ee0abe3c5eacc'
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                         a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
              = '[ ["postgres","postgres","EXECUTE",false], ["service_role","postgres","EXECUTE",false] ]'::JSONB
       ) THEN
        v_failures:=array_append(v_failures,'invoice_collection_facts_v50');
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='billing_payer_balance_facts_v1') <> 1
       OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure('public.billing_payer_balance_facts_v1(uuid,uuid,date)')
          AND p.proowner='postgres'::REGROLE AND NOT p.prosecdef AND p.provolatile='s'
          AND p.prorettype='record'::REGTYPE AND p.proretset
          AND p.proconfig=ARRAY['search_path=""']::TEXT[]
          AND encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
              = 'f81f1d839e26e5fe0abe9bf84af7bcb58c654f88cea4107f4e97b1cf993492b4'
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                         a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
              = '[ ["postgres","postgres","EXECUTE",false], ["service_role","postgres","EXECUTE",false] ]'::JSONB
       ) THEN
        v_failures:=array_append(v_failures,'payer_collection_facts_v50');
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='list_billing_payers_v1') <> 1
       OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure('public.list_billing_payers_v1(uuid,uuid,date)')
          AND p.proowner='postgres'::REGROLE AND NOT p.prosecdef AND p.provolatile='s'
          AND p.prorettype='jsonb'::REGTYPE AND p.proretset
          AND p.proconfig=ARRAY['search_path=""']::TEXT[]
          AND encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
              = 'ca4a6d2d6657cf82900a315b492af687a42be2fd1a6a3cad296119f6be72ff8d'
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                         a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
              = '[ ["postgres","postgres","EXECUTE",false], ["service_role","postgres","EXECUTE",false] ]'::JSONB
       ) THEN
        v_failures:=array_append(v_failures,'payer_read_projection_v50');
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='billing_attention_count_v1') <> 1
       OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure('public.billing_attention_count_v1(uuid,date)')
          AND p.proowner='postgres'::REGROLE AND NOT p.prosecdef AND p.provolatile='s'
          AND p.prorettype='integer'::REGTYPE AND NOT p.proretset
          AND p.proconfig=ARRAY['search_path=""']::TEXT[]
          AND encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
              = '4e57973f97038e57ec411c502960453b07d5f59374ab0e2bc856a42ecbb7e036'
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                         a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
              = '[ ["postgres","postgres","EXECUTE",false], ["service_role","postgres","EXECUTE",false] ]'::JSONB
       ) THEN
        v_failures:=array_append(v_failures,'billing_attention_count_v50');
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='update_lead_atomic') <> 1
       OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure('public.update_lead_atomic(uuid,uuid,uuid,jsonb)')
          AND p.proowner='postgres'::REGROLE AND NOT p.prosecdef AND p.provolatile='v'
          AND p.prorettype='public.leads'::REGTYPE AND NOT p.proretset
          AND p.proconfig=ARRAY['search_path=""']::TEXT[]
          AND encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
              = '087249d003c83cf7fed72445b36499e3b7e01d492ad9de479d4e7f320ad5661f'
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                         a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
              = '[ ["postgres","postgres","EXECUTE",false], ["service_role","postgres","EXECUTE",false] ]'::JSONB
       ) THEN
        v_failures:=array_append(v_failures,'update_lead_atomic_v52');
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='follow_up_lead_atomic') <> 1
       OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure('public.follow_up_lead_atomic(uuid,uuid,uuid,uuid,jsonb)')
          AND p.proowner='postgres'::REGROLE AND NOT p.prosecdef AND p.provolatile='v'
          AND p.prorettype='public.leads'::REGTYPE AND NOT p.proretset
          AND p.proconfig=ARRAY['search_path=""']::TEXT[]
          AND encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
              = '85d7ed82167d8306a22f3bebe0b4f16b08455eb8b6c01a8a3a3beef747900235'
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                         a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
              = '[ ["postgres","postgres","EXECUTE",false], ["service_role","postgres","EXECUTE",false] ]'::JSONB
       ) THEN
        v_failures:=array_append(v_failures,'follow_up_lead_atomic_v55');
    END IF;
    IF (SELECT encode(extensions.digest(convert_to((SELECT jsonb_build_object(
            'owner',pg_catalog.pg_get_userbyid(relation.relowner),
            'rls',relation.relrowsecurity,'force_rls',relation.relforcerowsecurity,
            'columns',(SELECT jsonb_agg(jsonb_build_array(attribute.attname,
                pg_catalog.format_type(attribute.atttypid,attribute.atttypmod),attribute.attnotnull,
                pg_catalog.pg_get_expr(default_value.adbin,default_value.adrelid),
                attribute.attidentity,attribute.attgenerated,attribute.attacl IS NULL) ORDER BY attribute.attnum)
                FROM pg_catalog.pg_attribute attribute
                LEFT JOIN pg_catalog.pg_attrdef default_value
                  ON default_value.adrelid=attribute.attrelid AND default_value.adnum=attribute.attnum
                WHERE attribute.attrelid=relation.oid AND attribute.attnum>0 AND NOT attribute.attisdropped),
            'acl',(SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN acl.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(acl.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(acl.grantor)::TEXT,acl.privilege_type,acl.is_grantable)
                ORDER BY CASE WHEN acl.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(acl.grantee)::TEXT END COLLATE "C",
                         acl.privilege_type,acl.is_grantable)
                FROM pg_catalog.aclexplode(COALESCE(relation.relacl,pg_catalog.acldefault('r',relation.relowner))) acl),
            'constraints',(SELECT jsonb_agg(jsonb_build_array(constraint_row.conname,constraint_row.contype,
                constraint_row.convalidated,constraint_row.condeferrable,constraint_row.condeferred,
                pg_catalog.pg_get_constraintdef(constraint_row.oid)) ORDER BY constraint_row.conname COLLATE "C")
                FROM pg_catalog.pg_constraint constraint_row WHERE constraint_row.conrelid=relation.oid),
            'indexes',(SELECT jsonb_agg(jsonb_build_array(index_relation.relname,index_row.indisvalid,
                index_row.indisready,index_row.indisunique,index_row.indisprimary,pg_catalog.pg_get_indexdef(index_row.indexrelid))
                ORDER BY index_relation.relname COLLATE "C")
                FROM pg_catalog.pg_index index_row JOIN pg_catalog.pg_class index_relation ON index_relation.oid=index_row.indexrelid
                WHERE index_row.indrelid=relation.oid),
            'policies',(SELECT jsonb_agg(jsonb_build_array(policy.polname,policy.polcmd,policy.polpermissive,
                (SELECT jsonb_agg(pg_catalog.pg_get_userbyid(role_oid)::TEXT ORDER BY pg_catalog.pg_get_userbyid(role_oid)::TEXT COLLATE "C") FROM unnest(policy.polroles) role_oid),
                pg_catalog.pg_get_expr(policy.polqual,policy.polrelid),pg_catalog.pg_get_expr(policy.polwithcheck,policy.polrelid)) ORDER BY policy.polname COLLATE "C")
                FROM pg_catalog.pg_policy policy WHERE policy.polrelid=relation.oid),
            'no_user_triggers',NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger trigger_row
                WHERE trigger_row.tgrelid=relation.oid AND NOT trigger_row.tgisinternal))
        FROM pg_catalog.pg_class relation WHERE relation.oid=pg_catalog.to_regclass('public.lead_follow_up_operations')
          AND relation.relkind='r')::TEXT,'UTF8'),'sha256'),'hex'))
       IS DISTINCT FROM '796b4c0fe4d033966248b78138776b6695dfbc80bdab7e0e9026b6c9745318cb' THEN
        v_failures:=array_append(v_failures,'lead_follow_up_operations_v52');
    END IF;
    IF encode(extensions.digest(convert_to(pg_get_functiondef(
        'public.dashboard_summary_facts(uuid,text,text,date,text)'::REGPROCEDURE
    ), 'UTF8'), 'sha256'), 'hex')
       <> 'dd58f2a2c3c37fe7f1bdf08b71d3090757c0af077b36f04fd13f52218bdd3a66' THEN
        v_failures := array_append(v_failures, 'dashboard_summary_facts_v53');
    END IF;
    IF (SELECT encode(extensions.digest(convert_to((SELECT jsonb_build_object(
    'functions',(SELECT jsonb_agg(jsonb_build_object(
        'signature',required.signature,'exists',function.oid IS NOT NULL,
        'definition',pg_catalog.pg_get_functiondef(function.oid),'body',function.prosrc,
        'owner',pg_catalog.pg_get_userbyid(function.proowner),'language',language.lanname,
        'volatility',function.provolatile,'security_definer',function.prosecdef,
        'strict',function.proisstrict,'parallel',function.proparallel,
        'config',function.proconfig,'result',pg_catalog.pg_get_function_result(function.oid),
        'acl',(SELECT jsonb_agg(jsonb_build_array(
            CASE WHEN acl.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(acl.grantee)::TEXT END,
            pg_catalog.pg_get_userbyid(acl.grantor)::TEXT,acl.privilege_type,acl.is_grantable)
            ORDER BY CASE WHEN acl.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(acl.grantee)::TEXT END COLLATE "C",
                pg_catalog.pg_get_userbyid(acl.grantor)::TEXT COLLATE "C",acl.privilege_type,acl.is_grantable)
            FROM pg_catalog.aclexplode(COALESCE(function.proacl,pg_catalog.acldefault('f',function.proowner))) acl)
        ) ORDER BY required.signature COLLATE "C")
        FROM (VALUES
            ('public.student_business_date(uuid)'),
            ('public.validate_student_birth_date()'),
            ('public.set_student_is_minor()'),
            ('public.convert_lead_to_student_atomic(uuid,uuid,uuid,uuid,uuid,text,date,uuid,uuid)'),
            ('private.write_student_profile_atomic(uuid,uuid,uuid,jsonb,uuid[],jsonb,boolean,text)')
        ) required(signature)
        LEFT JOIN pg_catalog.pg_proc function ON function.oid=pg_catalog.to_regprocedure(required.signature)
        LEFT JOIN pg_catalog.pg_language language ON language.oid=function.prolang),
    'triggers',(SELECT jsonb_agg(jsonb_build_object(
        'name',required.name,'expected_function',required.signature,
        'exists',trigger_row.oid IS NOT NULL,
        'binding_matches',trigger_row.tgfoid=pg_catalog.to_regprocedure(required.signature),
        'definition',pg_catalog.pg_get_triggerdef(trigger_row.oid),
        'enabled',trigger_row.tgenabled,'type',trigger_row.tgtype,
        'arguments',encode(trigger_row.tgargs,'hex'),
        'internal',trigger_row.tgisinternal,'constraint',trigger_row.tgconstraint<>0,
        'deferrable',trigger_row.tgdeferrable,'initially_deferred',trigger_row.tginitdeferred
        ) ORDER BY required.name COLLATE "C")
        FROM (VALUES ('set_students_is_minor','public.set_student_is_minor()'),
            ('validate_students_birth_date','public.validate_student_birth_date()')) required(name,signature)
        LEFT JOIN pg_catalog.pg_trigger trigger_row
          ON trigger_row.tgrelid=pg_catalog.to_regclass('public.students') AND trigger_row.tgname=required.name)
    ))::TEXT,'UTF8'),'sha256'),'hex'))
       IS DISTINCT FROM '5019c71d16f8154cd54d17ac21ff9931f04c1050f436cfc6fa78ffe7cc18ea2f' THEN
        v_failures:=array_append(v_failures,'student_profile_facts_v55');
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='convert_lead_to_student_atomic') <> 1
       OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure('public.convert_lead_to_student_atomic(uuid,uuid,uuid,uuid,uuid,text,date,uuid,uuid)')
          AND p.proowner='postgres'::REGROLE AND NOT p.prosecdef AND p.provolatile='v'
          AND p.prorettype='public.leads'::REGTYPE AND NOT p.proretset
          AND p.proconfig=ARRAY['search_path=public, pg_temp']::TEXT[]
          AND encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
              = 'ce9cd28c7191ca26f8a931a79c729bfbafb545527ed0e38a23ce045fe3b0adb8'
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                         a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
              = '[ ["postgres","postgres","EXECUTE",false], ["service_role","postgres","EXECUTE",false] ]'::JSONB
       ) THEN
        v_failures:=array_append(v_failures,'convert_lead_to_student_atomic_v55');
    END IF;
    IF (SELECT encode(extensions.digest(convert_to((SELECT jsonb_agg(jsonb_build_object(
    'table',required.name,'exists',c.oid IS NOT NULL,'kind',c.relkind,'persistence',c.relpersistence,
    'owner',pg_catalog.pg_get_userbyid(c.relowner),'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,
    'acl',(SELECT jsonb_agg(jsonb_build_array(
        CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
        pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
        ORDER BY a.grantee::regrole::TEXT COLLATE "C",a.grantor::regrole::TEXT COLLATE "C",a.privilege_type,a.is_grantable)
        FROM pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) a),
    'columns',(SELECT jsonb_agg(jsonb_build_object(
        'name',a.attname,'position',a.attnum,'type',pg_catalog.format_type(a.atttypid,a.atttypmod),
        'not_null',a.attnotnull,'default',pg_catalog.pg_get_expr(d.adbin,d.adrelid),
        'identity',a.attidentity,'generated',a.attgenerated,
        'collation',(SELECT n.nspname||'.'||co.collname FROM pg_catalog.pg_collation co JOIN pg_catalog.pg_namespace n ON n.oid=co.collnamespace WHERE co.oid=a.attcollation),
        'acl',(SELECT jsonb_agg(jsonb_build_array(
            CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(x.grantee)::TEXT END,
            pg_catalog.pg_get_userbyid(x.grantor)::TEXT,x.privilege_type,x.is_grantable)
            ORDER BY x.grantee::regrole::TEXT COLLATE "C",x.grantor::regrole::TEXT COLLATE "C",x.privilege_type,x.is_grantable)
            FROM pg_catalog.aclexplode(a.attacl) x)
        ) ORDER BY a.attnum) FROM pg_catalog.pg_attribute a
        LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
        WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
    'constraints',(SELECT jsonb_agg(jsonb_build_object(
        'name',k.conname,'type',k.contype,'definition',pg_catalog.pg_get_constraintdef(k.oid),
        'validated',k.convalidated,'deferrable',k.condeferrable,'deferred',k.condeferred,
        'local',k.conislocal,'inheritance',k.coninhcount,'no_inherit',k.connoinherit,
        'foreign_table',k.confrelid::regclass::TEXT,'update',k.confupdtype,'delete',k.confdeltype,'match',k.confmatchtype
        ) ORDER BY k.conname COLLATE "C") FROM pg_catalog.pg_constraint k WHERE k.conrelid=c.oid),
    'indexes',(SELECT jsonb_agg(jsonb_build_object(
        'name',i.relname,'persistence',i.relpersistence,'definition',pg_catalog.pg_get_indexdef(x.indexrelid),
        'valid',x.indisvalid,'ready',x.indisready,'unique',x.indisunique,
        'primary',x.indisprimary,'exclusion',x.indisexclusion,'immediate',x.indimmediate,
        'nulls_not_distinct',x.indnullsnotdistinct,'live',x.indislive,
        'predicate',pg_catalog.pg_get_expr(x.indpred,x.indrelid)
        ) ORDER BY i.relname COLLATE "C") FROM pg_catalog.pg_index x JOIN pg_catalog.pg_class i ON i.oid=x.indexrelid WHERE x.indrelid=c.oid),
    'policies',(SELECT jsonb_agg(jsonb_build_object(
        'name',p.polname,'command',p.polcmd,'permissive',p.polpermissive,
        'roles',(SELECT jsonb_agg(r::regrole::TEXT ORDER BY r::regrole::TEXT COLLATE "C") FROM unnest(p.polroles) r),
        'using',pg_catalog.pg_get_expr(p.polqual,p.polrelid),'check',pg_catalog.pg_get_expr(p.polwithcheck,p.polrelid)
        ) ORDER BY p.polname COLLATE "C") FROM pg_catalog.pg_policy p WHERE p.polrelid=c.oid),
    'triggers',(SELECT jsonb_agg(jsonb_build_object(
        'name',t.tgname,'definition',pg_catalog.pg_get_triggerdef(t.oid),'function',t.tgfoid::regprocedure::TEXT,
        'enabled',t.tgenabled,'type',t.tgtype,'arguments',encode(t.tgargs,'hex'),
        'deferrable',t.tgdeferrable,'deferred',t.tginitdeferred,'constraint',t.tgconstraint<>0
        ) ORDER BY t.tgname COLLATE "C") FROM pg_catalog.pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal)
    ) ORDER BY required.name COLLATE "C")
FROM (VALUES ('public.automation_rules'),('public.automation_deliveries'),
    ('public.automation_suppressions'),('private.automation_email_credentials')) required(name)
LEFT JOIN pg_catalog.pg_class c ON c.oid=pg_catalog.to_regclass(required.name))::TEXT,'UTF8'),'sha256'),'hex'))
       IS DISTINCT FROM '2cac874e09752d14ad6ff1ca72bca38b278d9ffb05ad1b15c6e1b2c9c02afe53' THEN
        v_failures:=array_append(v_failures,'automation_tables_v56');
    END IF;
    IF (SELECT encode(extensions.digest(convert_to((SELECT jsonb_agg(jsonb_build_object(
    'signature',required.signature,'exists',p.oid IS NOT NULL,
    'definition',pg_catalog.pg_get_functiondef(p.oid),'body',p.prosrc,
    'owner',pg_catalog.pg_get_userbyid(p.proowner),'language',l.lanname,
    'kind',p.prokind,'volatility',p.provolatile,'security_definer',p.prosecdef,
    'strict',p.proisstrict,'parallel',p.proparallel,'leakproof',p.proleakproof,
    'config',p.proconfig,'result',pg_catalog.pg_get_function_result(p.oid),
    'arguments',pg_catalog.pg_get_function_arguments(p.oid),'returns_set',p.proretset,
    'overloads',(SELECT jsonb_agg(x.oid::regprocedure::TEXT ORDER BY x.oid::regprocedure::TEXT COLLATE "C")
        FROM pg_catalog.pg_proc x JOIN pg_catalog.pg_namespace n ON n.oid=x.pronamespace
        WHERE n.nspname=split_part(required.signature,'.',1)
          AND x.proname=split_part(split_part(required.signature,'.',2),'(',1)),
    'acl',(SELECT jsonb_agg(jsonb_build_array(
        CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
        pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
        ORDER BY a.grantee::regrole::TEXT COLLATE "C",a.grantor::regrole::TEXT COLLATE "C",a.privilege_type,a.is_grantable)
        FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
    ) ORDER BY required.signature COLLATE "C")
FROM (VALUES
    ('private.automation_delivery_immutable()'),
    ('private.automation_normalize_email(text)'),
    ('private.automation_require_admin(uuid,uuid)'),
    ('private.automation_core_entitled(uuid)'),
    ('private.automation_has_actionable_work(text[])'),
    ('private.missed_class_automation_candidates(uuid,integer,uuid,uuid,timestamp with time zone)'),
    ('public.get_missed_class_automation_rule_v1(uuid,uuid)'),
    ('public.save_missed_class_automation_rule_v1(uuid,uuid,bigint,boolean,integer,text,text,text)'),
    ('public.preview_missed_class_automation_v1(uuid,uuid,integer)'),
    ('public.get_missed_class_automation_activity_v1(uuid,uuid,integer)'),
    ('public.enqueue_missed_class_automations_v1(integer,text[])'),
    ('public.claim_missed_class_automations_v1(integer,text[])'),
    ('public.defer_missed_class_automation_studio_v1(uuid,uuid,text,text[])'),
    ('public.begin_missed_class_automation_v1(uuid,uuid,text[])'),
    ('public.settle_missed_class_automation_v1(uuid,uuid,text,text,text,integer)'),
    ('public.suppress_missed_class_automation_v1(text)'),
    ('public.get_automation_email_credential_v1(text)'),
    ('public.save_automation_email_credential_v1(text,bigint,text)')
) required(signature)
LEFT JOIN pg_catalog.pg_proc p ON p.oid=pg_catalog.to_regprocedure(required.signature)
LEFT JOIN pg_catalog.pg_language l ON l.oid=p.prolang)::TEXT,'UTF8'),'sha256'),'hex'))
       IS DISTINCT FROM 'c2a0138f8b46fc7659d6054af83ea9e69ae898f3499fea89cf807f25b6ffc51f' THEN
        v_failures:=array_append(v_failures,'automation_functions_v56');
    END IF;
    IF (SELECT encode(extensions.digest(convert_to((SELECT jsonb_agg(jsonb_build_object(
    'table',required.name,'exists',c.oid IS NOT NULL,'kind',c.relkind,'persistence',c.relpersistence,
    'owner',pg_catalog.pg_get_userbyid(c.relowner),'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,
    'acl',(SELECT jsonb_agg(jsonb_build_array(
        CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
        pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
        ORDER BY a.grantee::regrole::TEXT COLLATE "C",a.grantor::regrole::TEXT COLLATE "C",a.privilege_type,a.is_grantable)
        FROM pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) a),
    'columns',(SELECT jsonb_agg(jsonb_build_object(
        'name',a.attname,'position',a.attnum,'type',pg_catalog.format_type(a.atttypid,a.atttypmod),
        'not_null',a.attnotnull,'default',pg_catalog.pg_get_expr(d.adbin,d.adrelid),
        'identity',a.attidentity,'generated',a.attgenerated,
        'collation',(SELECT n.nspname||'.'||co.collname FROM pg_catalog.pg_collation co JOIN pg_catalog.pg_namespace n ON n.oid=co.collnamespace WHERE co.oid=a.attcollation),
        'acl',(SELECT jsonb_agg(jsonb_build_array(
            CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(x.grantee)::TEXT END,
            pg_catalog.pg_get_userbyid(x.grantor)::TEXT,x.privilege_type,x.is_grantable)
            ORDER BY x.grantee::regrole::TEXT COLLATE "C",x.grantor::regrole::TEXT COLLATE "C",x.privilege_type,x.is_grantable)
            FROM pg_catalog.aclexplode(a.attacl) x)
        ) ORDER BY a.attnum) FROM pg_catalog.pg_attribute a
        LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
        WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
    'constraints',(SELECT jsonb_agg(jsonb_build_object(
        'name',k.conname,'type',k.contype,'definition',pg_catalog.pg_get_constraintdef(k.oid),
        'validated',k.convalidated,'deferrable',k.condeferrable,'deferred',k.condeferred,
        'local',k.conislocal,'inheritance',k.coninhcount,'no_inherit',k.connoinherit,
        'foreign_table',k.confrelid::regclass::TEXT,'update',k.confupdtype,'delete',k.confdeltype,'match',k.confmatchtype
        ) ORDER BY k.conname COLLATE "C") FROM pg_catalog.pg_constraint k WHERE k.conrelid=c.oid),
    'indexes',(SELECT jsonb_agg(jsonb_build_object(
        'name',i.relname,'persistence',i.relpersistence,'definition',pg_catalog.pg_get_indexdef(x.indexrelid),
        'valid',x.indisvalid,'ready',x.indisready,'unique',x.indisunique,
        'primary',x.indisprimary,'exclusion',x.indisexclusion,'immediate',x.indimmediate,
        'nulls_not_distinct',x.indnullsnotdistinct,'live',x.indislive,
        'predicate',pg_catalog.pg_get_expr(x.indpred,x.indrelid)
        ) ORDER BY i.relname COLLATE "C") FROM pg_catalog.pg_index x JOIN pg_catalog.pg_class i ON i.oid=x.indexrelid WHERE x.indrelid=c.oid),
    'policies',(SELECT jsonb_agg(jsonb_build_object(
        'name',p.polname,'command',p.polcmd,'permissive',p.polpermissive,
        'roles',(SELECT jsonb_agg(r::regrole::TEXT ORDER BY r::regrole::TEXT COLLATE "C") FROM unnest(p.polroles) r),
        'using',pg_catalog.pg_get_expr(p.polqual,p.polrelid),'check',pg_catalog.pg_get_expr(p.polwithcheck,p.polrelid)
        ) ORDER BY p.polname COLLATE "C") FROM pg_catalog.pg_policy p WHERE p.polrelid=c.oid),
    'triggers',(SELECT jsonb_agg(jsonb_build_object(
        'name',t.tgname,'definition',pg_catalog.pg_get_triggerdef(t.oid),'function',t.tgfoid::regprocedure::TEXT,
        'enabled',t.tgenabled,'type',t.tgtype,'arguments',encode(t.tgargs,'hex'),
        'deferrable',t.tgdeferrable,'deferred',t.tginitdeferred,'constraint',t.tgconstraint<>0
        ) ORDER BY t.tgname COLLATE "C") FROM pg_catalog.pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal)
    ) ORDER BY required.name COLLATE "C")
FROM (VALUES ('private.automation_command_operations'),
    ('private.automation_email_attempt_reservations'),
    ('private.automation_email_credentials'),
    ('private.automation_sender_gate'),
    ('private.automation_sender_preparations'),
    ('private.automation_test_email_payloads'),
    ('private.automation_test_email_scopes'),
    ('private.automation_unsubscribe_token_bindings'),
    ('private.automation_workflow_dispatch_cursor'),
    ('private.automation_workflow_email_attempts'),
    ('private.automation_workflow_events'),
    ('private.automation_workflow_follow_up_actions'),
    ('private.automation_workflow_run_steps'),
    ('private.billing_invoice_retry_hash_capture_control_v33'),
    ('private.billing_invoice_retry_hash_ledger_v33'),
    ('private.koaryu_release_v26_expectations'),
    ('private.koaryu_release_v27_expectations'),
    ('private.koaryu_release_v28_expectations'),
    ('private.koaryu_release_v29_expectations'),
    ('private.koaryu_release_v30_expectations'),
    ('private.koaryu_release_v31_expectations'),
    ('private.koaryu_release_v35_expectations'),
    ('private.koaryu_release_v36_expectations'),
    ('private.koaryu_release_v37_expectations'),
    ('private.stripe_connect_account_identity_guards'),
    ('private.student_import_receipts'),
    ('private.studio_creation_requests'),
    ('private.timezone_names'),
    ('private.workflow_email_attempt_payloads'),
    ('private.workflow_email_unsubscribe_pins'),
    ('private.workflow_invoice_collection_episodes'),
    ('private.workflow_invoice_episode_pending'),
    ('private.workflow_invoice_episode_state'),
    ('private.workflow_invoice_settlement_authority'),
    ('private.workflow_payment_capture_markers'),
    ('private.workflow_payment_settlement_observations'),
    ('private.workflow_rank_contexts'),
    ('private.workflow_rank_pending_contexts'),
    ('private.workflow_rank_pending_events'),
    ('private.workflow_rank_scopes'),
    ('private.workflow_timer_activations'),
    ('private.workflow_timer_dispatch_cursor'),
    ('public.account_deletion_requests'),
    ('public.attendance'),
    ('public.audit_logs'),
    ('public.automation_deliveries'),
    ('public.automation_rules'),
    ('public.automation_suppressions'),
    ('public.automation_workflow_activations'),
    ('public.automation_workflow_runs'),
    ('public.automation_workflow_versions'),
    ('public.automation_workflows'),
    ('public.belt_ladders'),
    ('public.belt_ranks'),
    ('public.belt_test_events'),
    ('public.belt_test_recipients'),
    ('public.billing_adjustments'),
    ('public.billing_disputes'),
    ('public.billing_enrollment_transition_aliases'),
    ('public.billing_enrollment_transition_intents'),
    ('public.billing_invoice_items'),
    ('public.billing_invoice_mutation_owners'),
    ('public.billing_invoice_retry_operation_aliases'),
    ('public.billing_invoice_retry_operations'),
    ('public.billing_invoices'),
    ('public.billing_payer_payment_consents'),
    ('public.billing_payer_setup_requests'),
    ('public.billing_payers'),
    ('public.billing_payments'),
    ('public.billing_plan_prices'),
    ('public.billing_plan_programs'),
    ('public.billing_plans'),
    ('public.billing_provider_operation_resource_aliases'),
    ('public.billing_provider_operation_resources'),
    ('public.billing_provider_operation_steps'),
    ('public.billing_provider_operations'),
    ('public.billing_refunds'),
    ('public.billing_subscriptions'),
    ('public.class_sessions'),
    ('public.class_templates'),
    ('public.email_usage_events'),
    ('public.export_jobs'),
    ('public.guardians'),
    ('public.lead_activities'),
    ('public.lead_follow_up_operations'),
    ('public.lead_trial_appointments'),
    ('public.leads'),
    ('public.operational_alert_audit_events'),
    ('public.operational_alert_delivery_attempts'),
    ('public.operational_alert_delivery_outcomes'),
    ('public.operational_alert_episodes'),
    ('public.operational_alert_heartbeats'),
    ('public.operational_alert_outbox'),
    ('public.programs'),
    ('public.promotions'),
    ('public.staff_profiles'),
    ('public.staff_roles'),
    ('public.stripe_connect_account_dispositions'),
    ('public.stripe_connect_onboarding_bootstraps'),
    ('public.stripe_events'),
    ('public.stripe_live_billing_reconciliation_account_evidence'),
    ('public.stripe_live_billing_reconciliation_checkpoints'),
    ('public.stripe_live_billing_reconciliation_checkpoints_v3'),
    ('public.student_billing_enrollments'),
    ('public.student_guardians'),
    ('public.student_import_runs'),
    ('public.student_program_memberships'),
    ('public.students'),
    ('public.studio_live_billing_authorizations'),
    ('public.studio_payment_accounts'),
    ('public.studio_subscriptions'),
    ('public.studios'),
    ('public.support_ticket_events'),
    ('public.support_tickets')) required(name)
LEFT JOIN pg_catalog.pg_class c ON c.oid=pg_catalog.to_regclass(required.name))::TEXT,'UTF8'),'sha256'),'hex'))
       NOT IN ('581ff4d1d33ae5ac6304379974c09a937bb860a7489d274a9d6d47f07b7c1cac','0f2241b5e718a7588150522da917e022f7fc10241ed3288dab941bda5b96a2cb','f69561f2b9c928643586f4f9d0fcef15775f2a2b91e840be43a85132a13bf66a','66f451e8ba6ab29033a557e0ce0bf36976c052c525535c011e7cf2ef5ab26ca5')
       OR (SELECT array_agg(n.nspname||'.'||c.relname ORDER BY (n.nspname||'.'||c.relname) COLLATE "C")
           FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
           WHERE n.nspname IN ('public','private') AND c.relkind IN ('r','p'))
          IS DISTINCT FROM ARRAY['private.automation_command_operations','private.automation_email_attempt_reservations','private.automation_email_credentials','private.automation_sender_gate','private.automation_sender_preparations','private.automation_test_email_payloads','private.automation_test_email_scopes','private.automation_unsubscribe_token_bindings','private.automation_workflow_dispatch_cursor','private.automation_workflow_email_attempts','private.automation_workflow_events','private.automation_workflow_follow_up_actions','private.automation_workflow_run_steps','private.billing_invoice_retry_hash_capture_control_v33','private.billing_invoice_retry_hash_ledger_v33','private.koaryu_release_v26_expectations','private.koaryu_release_v27_expectations','private.koaryu_release_v28_expectations','private.koaryu_release_v29_expectations','private.koaryu_release_v30_expectations','private.koaryu_release_v31_expectations','private.koaryu_release_v35_expectations','private.koaryu_release_v36_expectations','private.koaryu_release_v37_expectations','private.stripe_connect_account_identity_guards','private.student_import_receipts','private.studio_creation_requests','private.timezone_names','private.workflow_email_attempt_payloads','private.workflow_email_unsubscribe_pins','private.workflow_invoice_collection_episodes','private.workflow_invoice_episode_pending','private.workflow_invoice_episode_state','private.workflow_invoice_settlement_authority','private.workflow_payment_capture_markers','private.workflow_payment_settlement_observations','private.workflow_rank_contexts','private.workflow_rank_pending_contexts','private.workflow_rank_pending_events','private.workflow_rank_scopes','private.workflow_timer_activations','private.workflow_timer_dispatch_cursor','public.account_deletion_requests','public.attendance','public.audit_logs','public.automation_deliveries','public.automation_rules','public.automation_suppressions','public.automation_workflow_activations','public.automation_workflow_runs','public.automation_workflow_versions','public.automation_workflows','public.belt_ladders','public.belt_ranks','public.belt_test_events','public.belt_test_recipients','public.billing_adjustments','public.billing_disputes','public.billing_enrollment_transition_aliases','public.billing_enrollment_transition_intents','public.billing_invoice_items','public.billing_invoice_mutation_owners','public.billing_invoice_retry_operation_aliases','public.billing_invoice_retry_operations','public.billing_invoices','public.billing_payer_payment_consents','public.billing_payer_setup_requests','public.billing_payers','public.billing_payments','public.billing_plan_prices','public.billing_plan_programs','public.billing_plans','public.billing_provider_operation_resource_aliases','public.billing_provider_operation_resources','public.billing_provider_operation_steps','public.billing_provider_operations','public.billing_refunds','public.billing_subscriptions','public.class_sessions','public.class_templates','public.email_usage_events','public.export_jobs','public.guardians','public.lead_activities','public.lead_follow_up_operations','public.lead_trial_appointments','public.leads','public.operational_alert_audit_events','public.operational_alert_delivery_attempts','public.operational_alert_delivery_outcomes','public.operational_alert_episodes','public.operational_alert_heartbeats','public.operational_alert_outbox','public.programs','public.promotions','public.staff_profiles','public.staff_roles','public.stripe_connect_account_dispositions','public.stripe_connect_onboarding_bootstraps','public.stripe_events','public.stripe_live_billing_reconciliation_account_evidence','public.stripe_live_billing_reconciliation_checkpoints','public.stripe_live_billing_reconciliation_checkpoints_v3','public.student_billing_enrollments','public.student_guardians','public.student_import_runs','public.student_program_memberships','public.students','public.studio_live_billing_authorizations','public.studio_payment_accounts','public.studio_subscriptions','public.studios','public.support_ticket_events','public.support_tickets']::TEXT[] THEN
        v_failures:=array_append(v_failures,'timezone_tables_v59');
    END IF;
    IF (SELECT encode(extensions.digest(convert_to((SELECT jsonb_agg(jsonb_build_object(
    'signature',required.signature,'exists',p.oid IS NOT NULL,
    'definition',pg_catalog.pg_get_functiondef(p.oid),'body',p.prosrc,
    'owner',pg_catalog.pg_get_userbyid(p.proowner),'language',l.lanname,
    'kind',p.prokind,'volatility',p.provolatile,'security_definer',p.prosecdef,
    'strict',p.proisstrict,'parallel',p.proparallel,'leakproof',p.proleakproof,
    'config',p.proconfig,'result',pg_catalog.pg_get_function_result(p.oid),
    'arguments',pg_catalog.pg_get_function_arguments(p.oid),'returns_set',p.proretset,
    'overloads',(SELECT jsonb_agg(x.oid::regprocedure::TEXT ORDER BY x.oid::regprocedure::TEXT COLLATE "C")
        FROM pg_catalog.pg_proc x JOIN pg_catalog.pg_namespace n ON n.oid=x.pronamespace
        WHERE n.nspname=split_part(required.signature,'.',1)
          AND x.proname=split_part(split_part(required.signature,'.',2),'(',1)),
    'acl',(SELECT jsonb_agg(jsonb_build_array(
        CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
        pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
        ORDER BY a.grantee::regrole::TEXT COLLATE "C",a.grantor::regrole::TEXT COLLATE "C",a.privilege_type,a.is_grantable)
        FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
    ) ORDER BY required.signature COLLATE "C")
FROM (VALUES ('private.assert_billing_enrollment_transition_current_v1(public.billing_enrollment_transition_intents)'),
    ('private.automation_bind_unsubscribe_token_v1(uuid,text,text)'),
    ('private.automation_clear_statement_fence_v1()'),
    ('private.automation_core_entitled(uuid)'),
    ('private.automation_delivery_immutable()'),
    ('private.automation_delivery_result_v1(jsonb,bigint)'),
    ('private.automation_email_attempt_begin_v1(uuid,text,uuid,text,uuid,uuid,text,uuid,uuid,uuid,integer)'),
    ('private.automation_email_attempt_expire_v1(uuid)'),
    ('private.automation_email_attempt_identity_v1()'),
    ('private.automation_email_attempt_settle_v1(uuid,uuid,jsonb)'),
    ('private.automation_email_scope_lock_v1(uuid,text,uuid,text,text)'),
    ('private.automation_expire_orphaned_legacy_attempts_v1(integer)'),
    ('private.automation_has_actionable_work(text[])'),
    ('private.automation_instant_v1(jsonb)'),
    ('private.automation_legacy_begin_v1(uuid,uuid,text[],uuid,uuid,uuid)'),
    ('private.automation_legacy_delivery_delete_v1()'),
    ('private.automation_legacy_delivery_result_v1(jsonb)'),
    ('private.automation_legacy_delivery_transition_v1()'),
    ('private.automation_legacy_projection_pin_v1(uuid,uuid,jsonb)'),
    ('private.automation_legacy_projection_valid_v1(jsonb)'),
    ('private.automation_legacy_settle_v1(uuid,uuid,uuid,jsonb)'),
    ('private.automation_legacy_terminal_v1(jsonb,integer)'),
    ('private.automation_normalize_email(text)'),
    ('private.automation_require_admin(uuid,uuid)'),
    ('private.automation_sender_claim_v1(uuid,text,text,uuid)'),
    ('private.automation_sender_failure_v1(text,text,bigint,integer,timestamp with time zone)'),
    ('private.automation_sender_gate_identity_v1()'),
    ('private.automation_sender_gate_lock_v1()'),
    ('private.automation_sender_instant_v1(timestamp with time zone)'),
    ('private.automation_sender_preparation_identity_v1()'),
    ('private.automation_sender_preparation_reply_v1(uuid,private.automation_sender_gate,private.automation_sender_preparations,text,text)'),
    ('private.automation_sender_preparation_result_valid_v1(jsonb)'),
    ('private.automation_sender_preparation_settle_v1(uuid,uuid,jsonb)'),
    ('private.automation_sender_release_orphan_probe_v1()'),
    ('private.automation_sender_release_probe_v1(uuid,uuid,uuid)'),
    ('private.automation_sender_retry_at_v1(private.automation_sender_gate,timestamp with time zone)'),
    ('private.automation_test_actor_v1(uuid,uuid)'),
    ('private.automation_test_allowed_v1(text[])'),
    ('private.automation_test_clear_owned_v1(uuid)'),
    ('private.automation_test_execution_v1(private.automation_test_email_scopes,jsonb)'),
    ('private.automation_test_expire_v1(private.automation_test_email_scopes)'),
    ('private.automation_test_fail_v1(private.automation_test_email_scopes,text)'),
    ('private.automation_test_invalidate_queued_v1(uuid)'),
    ('private.automation_test_original_v1(uuid,uuid,uuid)'),
    ('private.automation_test_own_v1(uuid,uuid,uuid,uuid,text[])'),
    ('private.automation_test_payload_delete_v1()'),
    ('private.automation_test_payload_identity_v1()'),
    ('private.automation_test_rendered_valid_v1(jsonb)'),
    ('private.automation_test_result_v1(private.automation_test_email_scopes)'),
    ('private.automation_test_scope_identity_v1()'),
    ('private.automation_test_verified_email_v1(uuid)'),
    ('private.automation_timezone_v1(jsonb)'),
    ('private.automation_unsubscribe_binding_identity_v1()'),
    ('private.automation_utc_text_v1(timestamp with time zone)'),
    ('private.belt_test_cancel_recipient_runs_v1(uuid,uuid[],timestamp with time zone)'),
    ('private.belt_test_event_payload_v1(public.belt_test_events)'),
    ('private.belt_test_lock_recipient_runs_v1(uuid,uuid[])'),
    ('private.belt_test_name_v1(jsonb)'),
    ('private.belt_test_recipient_identity_v1()'),
    ('private.belt_test_recipient_payload_v1(public.belt_test_recipients)'),
    ('private.billing_enrollment_item_schedule_completed_v31(public.billing_provider_operations,public.billing_enrollment_transition_intents)'),
    ('private.billing_enrollment_item_schedule_phase_succeeded_v31(public.billing_provider_operations,public.billing_enrollment_transition_intents)'),
    ('private.billing_enrollment_item_schedule_pre_provider_rejected_v31(public.billing_provider_operations)'),
    ('private.billing_enrollment_transition_json_v1(public.billing_enrollment_transition_intents,text,text)'),
    ('private.billing_invoice_retry_base_hash_v33(uuid,uuid,text,text,integer)'),
    ('private.billing_invoice_retry_preread_zero_evidence_v33(public.billing_provider_operations,text)'),
    ('private.billing_operation_resource_version_v31(text,public.billing_payments,public.billing_payers,text,integer)'),
    ('private.billing_payer_payment_consent_json_v1(public.billing_payer_payment_consents,text)'),
    ('private.billing_payer_setup_request_json_v1(public.billing_payer_setup_requests,text)'),
    ('private.billing_plan_resource_version_v31(public.billing_plans,text,integer)'),
    ('private.billing_provider_operation_json_v1(public.billing_provider_operations,text)'),
    ('private.billing_provider_operation_resource_json_v1(public.billing_provider_operation_resources,public.billing_provider_operations,text,text)'),
    ('private.billing_provider_operation_step_json_v1(public.billing_provider_operation_steps)'),
    ('private.billing_provider_operation_step_plan_json_v1(public.billing_provider_operations,text)'),
    ('private.billing_provider_operation_step_result_json_v1(public.billing_provider_operations,public.billing_provider_operation_steps,text)'),
    ('private.bind_live_billing_authorization_checkpoint()'),
    ('private.can_read_staff_profile(uuid)'),
    ('private.capture_billing_invoice_retry_alias_v33()'),
    ('private.capture_billing_invoice_retry_hash_v33(uuid,uuid,uuid,uuid,uuid,text)'),
    ('private.capture_billing_invoice_retry_resource_v33()'),
    ('private.claim_billing_invoice_mutation_v31(uuid,uuid,text,text,uuid,uuid,text,text,text,integer,uuid,integer)'),
    ('private.claim_billing_invoice_retry_v33(uuid,uuid,uuid,uuid,text,text,text,integer,uuid,integer)'),
    ('private.claim_payment_payer_operation_resource_v31(uuid,uuid,text,text,uuid,uuid,text,text,text,integer,uuid,integer)'),
    ('private.claim_student_import_run_owned(uuid,uuid,text,text,text,text,boolean,integer)'),
    ('private.clear_studio_operational_data_v2(uuid,boolean)'),
    ('private.connect_onboarding_bootstrap_link_checkpoint(uuid,text)'),
    ('private.connect_onboarding_ga_initial_link_eligible_v58(uuid,text)'),
    ('private.current_connect_account_generation(jsonb)'),
    ('private.deterministic_import_uuid(uuid,text)'),
    ('private.enforce_billing_payer_connect_identity_v1()'),
    ('private.enforce_billing_payment_refundable_amount_v31()'),
    ('private.enforce_billing_provider_step_parent_v1()'),
    ('private.enforce_live_billing_checkpoint_processed_events()'),
    ('private.enforce_single_studio_membership()'),
    ('private.handle_invoice_retry_consent_change_v33(uuid,uuid)'),
    ('private.has_unambiguous_studio_membership()'),
    ('private.import_student_row_atomic(jsonb,uuid,uuid,text,integer,text,text,text,text,uuid[])'),
    ('private.is_admin_in_studio(uuid)'),
    ('private.is_admin_or_front_desk_in_studio(uuid)'),
    ('private.is_staff_in_studio(uuid)'),
    ('private.koaryu_release_adjustment_trigger_guard_manifest_v37()'),
    ('private.koaryu_release_critical_surface_manifest_v14()'),
    ('private.koaryu_release_critical_surface_manifest_v15()'),
    ('private.koaryu_release_critical_surface_manifest_v16()'),
    ('private.koaryu_release_critical_surface_manifest_v17()'),
    ('private.koaryu_release_critical_surface_manifest_v18()'),
    ('private.koaryu_release_enrollment_transition_manifest_v29()'),
    ('private.koaryu_release_invoice_retry_closeout_manifest_v34()'),
    ('private.koaryu_release_invoice_retry_compatibility_manifest_v33()'),
    ('private.koaryu_release_invoice_retry_preread_manifest_v32()'),
    ('private.koaryu_release_live_billing_v3_manifest_v25()'),
    ('private.koaryu_release_operational_contract_v25()'),
    ('private.koaryu_release_operational_contract_v26()'),
    ('private.koaryu_release_operational_contract_v27()'),
    ('private.koaryu_release_operational_contract_v28()'),
    ('private.koaryu_release_operational_contract_v29()'),
    ('private.koaryu_release_operational_contract_v30()'),
    ('private.koaryu_release_operational_contract_v31()'),
    ('private.koaryu_release_operational_manifest_v10()'),
    ('private.koaryu_release_operational_manifest_v11()'),
    ('private.koaryu_release_operational_manifest_v12()'),
    ('private.koaryu_release_operational_manifest_v2()'),
    ('private.koaryu_release_operational_manifest_v2_base()'),
    ('private.koaryu_release_operational_manifest_v4()'),
    ('private.koaryu_release_operational_manifest_v5()'),
    ('private.koaryu_release_operational_manifest_v6()'),
    ('private.koaryu_release_operational_manifest_v7()'),
    ('private.koaryu_release_operational_manifest_v8()'),
    ('private.koaryu_release_operational_manifest_v9()'),
    ('private.koaryu_release_payer_setup_recovery_manifest_v36()'),
    ('private.koaryu_release_payment_adjustment_manifest_v26()'),
    ('private.koaryu_release_payments_replay_repairs_manifest_v30()'),
    ('private.koaryu_release_provider_operation_steps_manifest_v28()'),
    ('private.koaryu_release_provider_operations_manifest_v27()'),
    ('private.koaryu_release_resource_ownership_manifest_v31()'),
    ('private.koaryu_release_schedule_window_manifest_v1()'),
    ('private.koaryu_release_schema_preflight_v14_snapshot_v34()'),
    ('private.koaryu_release_starting_belt_manifest_v9()'),
    ('private.koaryu_release_stripe_rehearsal_evidence_manifest_v35()'),
    ('private.koaryu_release_student_rank_writer_manifest_v11()'),
    ('private.koaryu_release_student_rank_writer_manifest_v12()'),
    ('private.koaryu_release_student_rank_writer_manifest_v13()'),
    ('private.live_billing_event_is_in_scope(text,text)'),
    ('private.live_billing_ga_events_clear_v58()'),
    ('private.live_billing_ga_operations_v58(text)'),
    ('private.live_billing_operation_set_is_canonical_v1(text,text[])'),
    ('private.lock_student_import_actor(uuid)'),
    ('private.lock_student_import_run(uuid,uuid,text)'),
    ('private.maintain_billing_invoice_mutation_owner_v31()'),
    ('private.missed_class_automation_candidates(uuid,integer,uuid,uuid,timestamp with time zone)'),
    ('private.preserve_billing_enrollment_transition_identity_v1()'),
    ('private.preserve_billing_invoice_mutation_owner_v31()'),
    ('private.preserve_billing_invoice_retry_hash_ledger_v33()'),
    ('private.preserve_billing_payer_payment_consent_v1()'),
    ('private.preserve_billing_payer_setup_request_v1()'),
    ('private.preserve_billing_provider_operation_identity_v1()'),
    ('private.preserve_billing_provider_operation_resource_alias_v1()'),
    ('private.preserve_billing_provider_operation_resource_v1()'),
    ('private.preserve_billing_provider_operation_step_v1()'),
    ('private.prevent_account_deletion_orphan()'),
    ('private.prevent_staff_admin_orphan()'),
    ('private.rank_transition_fingerprint_v1(uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text)'),
    ('private.recompute_billing_payment_adjustment_totals(uuid)'),
    ('private.recompute_payment_after_adjustment_change()'),
    ('private.record_student_rank_transition_v2(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,uuid)'),
    ('private.record_student_rank_transition_v3(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,uuid,boolean)'),
    ('private.reject_billing_enrollment_transition_alias_mutation_v1()'),
    ('private.reject_consent_change_during_invoice_retry_v31()'),
    ('private.reject_payer_change_during_invoice_retry_v31()'),
    ('private.resolve_billing_invoice_retry_identity_v33(uuid,uuid,uuid,uuid)'),
    ('private.set_audit_actor_legal_name()'),
    ('private.stripe_rehearsal_manifest_ids_v35(jsonb,text,boolean)'),
    ('private.sync_connect_identity_exclusion_guard()'),
    ('private.sync_connect_identity_mapping_guard()'),
    ('private.timezone_name_known(text)'),
    ('private.timezone_name_or_utc(text)'),
    ('private.trial_appointment_payload_v1(public.lead_trial_appointments)'),
    ('private.trial_rebooking_marker_v1()'),
    ('private.validate_billing_adjustment_payment_identity()'),
    ('private.validate_billing_payment_identity_change()'),
    ('private.workflow_activation_immutable_v1()'),
    ('private.workflow_apply_lead_follow_up_v1(uuid,uuid,uuid,text,uuid,jsonb,timestamp with time zone)'),
    ('private.workflow_blank_v1(jsonb)'),
    ('private.workflow_cancel_pending_v1(uuid,uuid,timestamp with time zone,text)'),
    ('private.workflow_cancel_runs_v1(uuid,uuid[],timestamp with time zone,text)'),
    ('private.workflow_cancel_settled_invoice_runs_v1(uuid,uuid[])'),
    ('private.workflow_cancel_source_pending_v1(uuid,text,uuid,timestamp with time zone,text)'),
    ('private.workflow_capture_events_v1(uuid,jsonb,jsonb)'),
    ('private.workflow_capture_payment_failure_v1()'),
    ('private.workflow_catalog_v1()'),
    ('private.workflow_condition_result_v1(text,text,jsonb,jsonb)'),
    ('private.workflow_current_rank_authority_v1(uuid,uuid,uuid)'),
    ('private.workflow_current_source_facts_v1(uuid,text,uuid,jsonb,jsonb,timestamp with time zone,text[])'),
    ('private.workflow_current_staff_recipient_v1(uuid,uuid)'),
    ('private.workflow_defer_owned_run_v1(uuid,uuid,timestamp with time zone,text)'),
    ('private.workflow_delay_due_identity_v1()'),
    ('private.workflow_detail_v1(uuid,uuid)'),
    ('private.workflow_email_attempt_identity_v1()'),
    ('private.workflow_email_attempt_payload_v1(private.automation_workflow_email_attempts)'),
    ('private.workflow_email_fingerprint_v1(jsonb,jsonb)'),
    ('private.workflow_email_finish_step_v1(uuid,uuid,uuid,text,timestamp with time zone,text,text,boolean)'),
    ('private.workflow_email_own_v1(uuid,uuid,uuid,text,text,text[],text,text)'),
    ('private.workflow_email_parameters_valid_v1(text,text[],text,text)'),
    ('private.workflow_email_payload_delete_v1()'),
    ('private.workflow_email_payload_identity_v1()'),
    ('private.workflow_email_plan_v1(public.automation_workflow_runs,private.automation_workflow_events,jsonb,jsonb,timestamp with time zone,text,text[],text,text)'),
    ('private.workflow_email_project_settlement_v1(uuid,boolean)'),
    ('private.workflow_email_rendered_valid_v1(jsonb)'),
    ('private.workflow_email_selected_values_v1(jsonb,jsonb)'),
    ('private.workflow_email_source_inventory_v1(uuid,private.automation_workflow_events,jsonb,text)'),
    ('private.workflow_enroll_timed_occurrence_v1(uuid,uuid,uuid,timestamp with time zone,timestamp with time zone,timestamp with time zone)'),
    ('private.workflow_expire_email_attempts_v1(integer)'),
    ('private.workflow_fact_text_v1(text)'),
    ('private.workflow_finalize_invoice_episode_deferred_v1()'),
    ('private.workflow_finalize_invoice_episodes_v1()'),
    ('private.workflow_finalize_rank_deferred_v1()'),
    ('private.workflow_financial_identity_valid_v1(public.billing_invoices,public.billing_payers,public.studio_payment_accounts,public.billing_payments)'),
    ('private.workflow_follow_up_receipt_identity_v1()'),
    ('private.workflow_graph_read_issues_v1(uuid,jsonb)'),
    ('private.workflow_hash_v1(jsonb)'),
    ('private.workflow_immutable_record_v1()'),
    ('private.workflow_integer_v1(jsonb,bigint,bigint)'),
    ('private.workflow_invoice_episode_context_valid_v1(jsonb)'),
    ('private.workflow_invoice_episode_identity_v1()'),
    ('private.workflow_invoice_episode_pending_identity_v1()'),
    ('private.workflow_invoice_episode_projection_v1(public.billing_invoices,public.billing_payers)'),
    ('private.workflow_invoice_episode_state_identity_v1()'),
    ('private.workflow_invoice_episode_threshold_v1(date,text)'),
    ('private.workflow_invoice_financial_context_v1(uuid,uuid,uuid)'),
    ('private.workflow_invoice_settlement_identity_v1()'),
    ('private.workflow_invoice_settlement_seed_v1()'),
    ('private.workflow_json_keys_v1(jsonb,text[],text[])'),
    ('private.workflow_lock_email_sources_v1(uuid,private.automation_workflow_events,jsonb,text)'),
    ('private.workflow_lock_financial_sources_v1(uuid,uuid,uuid[])'),
    ('private.workflow_lock_lead_assignee_v1(uuid)'),
    ('private.workflow_lock_recipient_auth_v1(uuid)'),
    ('private.workflow_lock_run_sources_v1(uuid,private.automation_workflow_events,jsonb)'),
    ('private.workflow_lock_timed_sources_v1(jsonb)'),
    ('private.workflow_mark_invoice_episode_v1()'),
    ('private.workflow_mark_payer_episode_demo_v1()'),
    ('private.workflow_mutate_v1(uuid,uuid,uuid,uuid,bigint,text,text,text,jsonb,jsonb,boolean,boolean)'),
    ('private.workflow_observe_payment_settlement_v1(uuid,uuid)'),
    ('private.workflow_payment_evidence_v1(public.billing_payments)'),
    ('private.workflow_payment_evidence_valid_v1(jsonb)'),
    ('private.workflow_payment_settlement_valid_v1(uuid,uuid)'),
    ('private.workflow_prepare_capture_v1(uuid,uuid[],boolean)'),
    ('private.workflow_prepare_financial_context_v1(uuid,uuid,uuid)'),
    ('private.workflow_queue_invoice_episode_v1(uuid,uuid,boolean,boolean,boolean,text)'),
    ('private.workflow_rank_compare_pending_v1(uuid,uuid)'),
    ('private.workflow_rank_context_generation_v1(uuid,uuid,uuid)'),
    ('private.workflow_rank_context_identity_v1()'),
    ('private.workflow_rank_finalize_pending_v1(uuid)'),
    ('private.workflow_rank_mark_dirty_v1(uuid,uuid,uuid,boolean)'),
    ('private.workflow_rank_scope_enter_v1(uuid,uuid,text)'),
    ('private.workflow_rank_scope_finish_v1(uuid,uuid,jsonb)'),
    ('private.workflow_rank_tuple_v1(uuid,uuid,uuid)'),
    ('private.workflow_require_actor_v1(uuid,uuid,boolean)'),
    ('private.workflow_require_graph_tenant_v1(uuid,jsonb)'),
    ('private.workflow_run_detail_v1(uuid,uuid)'),
    ('private.workflow_run_identity_v1()'),
    ('private.workflow_run_position_v1(public.automation_workflow_runs)'),
    ('private.workflow_run_step_identity_v1()'),
    ('private.workflow_run_step_payload_v1(private.automation_workflow_run_steps)'),
    ('private.workflow_run_subject_label_v1(private.automation_workflow_events)'),
    ('private.workflow_run_summary_payload_v1(public.automation_workflow_runs,private.automation_workflow_events,public.automation_workflow_versions,text)'),
    ('private.workflow_semantic_graph_v1(jsonb)'),
    ('private.workflow_settlement_observation_identity_v1()'),
    ('private.workflow_simulation_projection_v1(uuid,uuid,jsonb,jsonb,timestamp with time zone)'),
    ('private.workflow_staff_auth_email_v1(uuid,uuid)'),
    ('private.workflow_student_enrollment_event_v1(uuid,uuid,jsonb)'),
    ('private.workflow_timed_candidates_v1(integer,timestamp with time zone)'),
    ('private.workflow_timer_activation_identity_v1()'),
    ('private.workflow_timer_activation_insert_v1()'),
    ('private.workflow_transition_owned_v1(uuid,uuid,uuid,integer,text)'),
    ('private.workflow_trigger_event_type_v1(jsonb)'),
    ('private.workflow_typed_value_v1(jsonb,jsonb)'),
    ('private.workflow_validate_v1(jsonb,jsonb,boolean)'),
    ('private.write_student_profile_atomic(uuid,uuid,uuid,jsonb,uuid[],jsonb,boolean,text)'),
    ('public.accept_billing_payer_payment_consent_v1(uuid,uuid,uuid,text,text,text,integer,text,timestamp with time zone)'),
    ('public.accept_core_checkout_completion_atomic(uuid,uuid,bigint,text,bigint)'),
    ('public.accept_core_checkout_subscription_atomic(uuid,uuid,bigint,text,text,bigint)'),
    ('public.acknowledge_connect_onboarding_bootstrap_initial_link_delivery(uuid,text,text)'),
    ('public.acknowledge_operational_alert(text,uuid,text,text)'),
    ('public.advance_automation_workflow_run_v1(uuid,uuid,uuid,integer)'),
    ('public.approve_belt_test_recipients_v1(uuid,uuid,uuid,uuid,bigint,jsonb)'),
    ('public.archive_students_bulk_atomic(uuid,uuid,uuid[])'),
    ('public.authorize_billing_enrollment_transition_recovery_v1(uuid,uuid,uuid,bigint,uuid,bigint,text,text,uuid,integer)'),
    ('public.authorize_billing_provider_operation_recovery_v1(uuid,uuid,uuid,text,text,text,text,integer,uuid,text,text,uuid,integer,bigint)'),
    ('public.authorize_billing_provider_operation_recovery_v2(uuid,uuid,uuid,text,text,text,text,integer,uuid,text,text,text,uuid,integer,bigint)'),
    ('public.authorize_billing_provider_operation_step_recovery_v1(uuid,uuid,uuid,text,text,text,text,integer,text,integer,text,text,text,text,uuid,text,text,uuid,integer,bigint)'),
    ('public.authorize_connect_onboarding_bootstrap_account_create(uuid,text,integer,text,text,text,text,text)'),
    ('public.authorize_connect_onboarding_bootstrap_account_create_v2(uuid,uuid,text,integer,text,text)'),
    ('public.authorize_connect_onboarding_bootstrap_initial_link(uuid,text,integer,text,text,text,text,text)'),
    ('public.authorize_connect_onboarding_bootstrap_initial_link_v2(uuid,uuid,text,integer,text,text,text,text)'),
    ('public.authorize_studio_live_billing_mutation_atomic(uuid,text,text,text,text)'),
    ('public.authorize_studio_live_billing_scope_v3(uuid,text,text,text,text)'),
    ('public.backfill_starting_belt_after_rank_delete()'),
    ('public.backfill_starting_belt_for_program()'),
    ('public.begin_automation_test_email_v1(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text[],text,jsonb)'),
    ('public.begin_billing_enrollment_activation_v1(uuid,uuid,uuid,text,text,text,text,integer,uuid,bigint,uuid,text,text)'),
    ('public.begin_missed_class_automation_v1(uuid,uuid,text[])'),
    ('public.begin_missed_class_automation_v2(uuid,uuid,uuid,uuid,text[],uuid)'),
    ('public.begin_workflow_email_v1(uuid,uuid,uuid,text,text,text,text[],text,text,jsonb,uuid,uuid,uuid)'),
    ('public.billing_attention_count_v1(uuid,date)'),
    ('public.billing_invoice_collection_facts_v1(uuid,uuid,date)'),
    ('public.billing_landing_aggregates(uuid,timestamp with time zone,timestamp with time zone)'),
    ('public.billing_payer_balance_facts_v1(uuid,uuid,date)'),
    ('public.billing_payment_cohort(uuid,timestamp with time zone,timestamp with time zone)'),
    ('public.billing_webhook_health(text,boolean,timestamp with time zone)'),
    ('public.bind_billing_payer_setup_session_v1(uuid,uuid,uuid,uuid,text,text,integer,bigint)'),
    ('public.bind_connect_onboarding_bootstrap_account(uuid,text,integer,text,text,text)'),
    ('public.bind_connect_onboarding_bootstrap_account_v2(uuid,uuid,text,integer,text,text)'),
    ('public.bind_student_import_rank_v1(uuid,uuid,text,uuid,text,uuid)'),
    ('public.cancel_automation_workflow_run_v1(uuid,uuid,uuid,uuid,bigint)'),
    ('public.claim_automation_sender_preparation_v1(text,uuid,text)'),
    ('public.claim_automation_test_sender_preparation_v1(uuid,uuid,uuid,uuid,uuid,text,text[])'),
    ('public.claim_automation_workflow_runs_v1(integer)'),
    ('public.claim_billing_enrollment_transition_v1(uuid,uuid,text,text,text,uuid,uuid,uuid,text,text,text,integer,timestamp with time zone,integer,integer,integer,integer,text,text,uuid,integer)'),
    ('public.claim_billing_enrollment_transition_v29(uuid,uuid,text,text,text,uuid,uuid,uuid,text,text,text,integer,timestamp with time zone,integer,integer,integer,integer,text,text,uuid,integer)'),
    ('public.claim_billing_invoice_closeout_operation_v1(uuid,uuid,text,text,uuid,uuid,text,text,text,integer,uuid,integer)'),
    ('public.claim_billing_invoice_closeout_operation_v30(uuid,uuid,text,text,uuid,uuid,text,text,text,integer,uuid,integer)'),
    ('public.claim_billing_provider_operation_resource_v1(uuid,uuid,text,text,uuid,uuid,text,text,text,integer,uuid,integer)'),
    ('public.claim_billing_provider_operation_resource_v30(uuid,uuid,text,text,uuid,uuid,text,text,text,integer,uuid,integer)'),
    ('public.claim_billing_provider_operation_step_v1(uuid,uuid,uuid,text,text,text,text,integer,text,integer,text,text,text,text,uuid,integer)'),
    ('public.claim_billing_provider_operation_v1(uuid,uuid,text,text,text,text,integer,uuid,integer)'),
    ('public.claim_billing_subscription_quantity_sync(uuid,uuid,text,integer)'),
    ('public.claim_due_account_deletion_requests(integer,text,integer)'),
    ('public.claim_due_billing_enrollment_transitions_v1(uuid,integer,integer)'),
    ('public.claim_missed_class_automations_v1(integer,text[])'),
    ('public.claim_operational_alert_delivery(text,text,uuid,integer)'),
    ('public.claim_stripe_event_for_processing(text,text,boolean,text,jsonb,text,integer)'),
    ('public.claim_student_import_run(uuid,uuid,text,text,text,text,integer)'),
    ('public.claim_student_import_run_v2(uuid,uuid,text,text,text,text,integer)'),
    ('public.clear_studio_comp_for_billing_event(uuid,bigint)'),
    ('public.clear_studio_operational_data_atomic(uuid,boolean)'),
    ('public.clear_studio_operational_data_v2(uuid,boolean)'),
    ('public.close_billing_payer_setup_request_v1(uuid,uuid,uuid,uuid,text,text,integer,text,text)'),
    ('public.command_automation_workflow_v1(uuid,uuid,uuid,uuid,bigint,text,boolean,boolean)'),
    ('public.complete_billing_payer_payment_consent_v1(uuid,uuid,uuid,text,text,text,integer,timestamp with time zone)'),
    ('public.complete_billing_provider_operation_provider_phase_v1(uuid,uuid,uuid,text,text,text,text,integer,text,integer,bigint)'),
    ('public.complete_billing_provider_operation_provider_phase_v31(uuid,uuid,uuid,text,text,text,text,integer,text,integer,bigint,uuid)'),
    ('public.complete_billing_provider_operation_v1(uuid,uuid,uuid,text,text,text,text,integer,uuid,bigint,text,text)'),
    ('public.complete_due_billing_enrollment_item_transition_v31(uuid,uuid,uuid,bigint,text,jsonb)'),
    ('public.complete_due_billing_enrollment_transition_v1(uuid,uuid,bigint,text,text)'),
    ('public.complete_operational_alert_delivery(uuid,text,text)'),
    ('public.convert_lead_to_student_atomic(uuid,uuid,uuid,uuid,uuid,text,date,uuid,uuid)'),
    ('public.create_automation_test_email_v1(uuid,uuid,uuid,uuid,jsonb,text,jsonb,boolean)'),
    ('public.create_automation_workflow_v1(uuid,uuid,uuid,text,text,jsonb,jsonb)'),
    ('public.create_lead_atomic_v1(uuid,uuid,uuid,jsonb)'),
    ('public.create_studio_onboarding(uuid,text,text,text)'),
    ('public.create_support_ticket(uuid,uuid,text,text,text,text,text,text,text,text,jsonb)'),
    ('public.dashboard_summary_facts(uuid,text,text,date,text)'),
    ('public.defer_automation_workflow_run_v1(uuid,uuid,uuid,text)'),
    ('public.defer_missed_class_automation_studio_v1(uuid,uuid,text,text[])'),
    ('public.delete_recurring_class_series_atomic(uuid,uuid,uuid)'),
    ('public.disable_billing_payer_autopay_v1(uuid,uuid,uuid,timestamp with time zone,text)'),
    ('public.enforce_operational_alert_sent_receipt()'),
    ('public.enqueue_missed_class_automations_v1(integer,text[])'),
    ('public.evaluate_operational_alert(text,text,bigint,integer,integer,text,text,integer,text,text,text)'),
    ('public.evaluate_operational_alert(text,text,bigint,integer,integer,text,text,text,text)'),
    ('public.fail_operational_alert_delivery(uuid,text,text,integer)'),
    ('public.finalize_billing_invoice_retry_hash_capture_v33(bigint,text,text)'),
    ('public.finalize_billing_payer_setup_projection_v1(uuid,uuid,uuid,uuid,uuid,text,text,text,integer)'),
    ('public.finish_account_deletion_request(uuid,text,text,text)'),
    ('public.finish_automation_test_email_preflight_v1(uuid,uuid,uuid,text)'),
    ('public.finish_billing_subscription_quantity_sync(uuid,uuid,text)'),
    ('public.finish_stripe_event_processing(uuid,text,text,text)'),
    ('public.finish_stripe_event_processing_v2(uuid,text,text,text,text)'),
    ('public.finish_student_import_run(uuid,text,text,jsonb,text)'),
    ('public.follow_up_lead_atomic(uuid,uuid,uuid,uuid,jsonb)'),
    ('public.get_automation_email_credential_v1(text)'),
    ('public.get_automation_operation_v1(uuid,uuid,uuid)'),
    ('public.get_automation_sender_status_v1(text)'),
    ('public.get_automation_test_email_v1(uuid,uuid,uuid)'),
    ('public.get_automation_workflow_run_v1(uuid,uuid,uuid)'),
    ('public.get_automation_workflow_simulation_facts_v1(uuid,uuid,uuid,jsonb,jsonb)'),
    ('public.get_automation_workflow_v1(uuid,uuid,uuid)'),
    ('public.get_belt_test_event_v1(uuid,uuid,uuid)'),
    ('public.get_belt_test_recipient_v1(uuid,uuid,uuid,uuid)'),
    ('public.get_lead_trial_appointment_v1(uuid,uuid,uuid,uuid)'),
    ('public.get_missed_class_automation_activity_v1(uuid,uuid,integer)'),
    ('public.get_missed_class_automation_rule_v1(uuid,uuid)'),
    ('public.get_workflow_email_plan_v1(uuid,uuid,uuid,text,text,text[],text,text)'),
    ('public.heartbeat_student_import_run(uuid,text)'),
    ('public.import_student_row_atomic(jsonb,uuid,uuid,text,integer,text,text,text,text,uuid[])'),
    ('public.invalidate_core_checkout_on_comp_grant()'),
    ('public.koaryu_release_schema_preflight()'),
    ('public.koaryu_release_schema_preflight_v10()'),
    ('public.koaryu_release_schema_preflight_v11()'),
    ('public.koaryu_release_schema_preflight_v12()'),
    ('public.koaryu_release_schema_preflight_v13()'),
    ('public.koaryu_release_schema_preflight_v14()'),
    ('public.koaryu_release_schema_preflight_v15()'),
    ('public.koaryu_release_schema_preflight_v16()'),
    ('public.koaryu_release_schema_preflight_v17()'),
    ('public.koaryu_release_schema_preflight_v18()'),
    ('public.koaryu_release_schema_preflight_v19()'),
    ('public.koaryu_release_schema_preflight_v2()'),
    ('public.koaryu_release_schema_preflight_v20()'),
    ('public.koaryu_release_schema_preflight_v21()'),
    ('public.koaryu_release_schema_preflight_v22()'),
    ('public.koaryu_release_schema_preflight_v23()'),
    ('public.koaryu_release_schema_preflight_v24()'),
    ('public.koaryu_release_schema_preflight_v25()'),
    ('public.koaryu_release_schema_preflight_v26()'),
    ('public.koaryu_release_schema_preflight_v27()'),
    ('public.koaryu_release_schema_preflight_v28()'),
    ('public.koaryu_release_schema_preflight_v29()'),
    ('public.koaryu_release_schema_preflight_v3()'),
    ('public.koaryu_release_schema_preflight_v30()'),
    ('public.koaryu_release_schema_preflight_v31()'),
    ('public.koaryu_release_schema_preflight_v32()'),
    ('public.koaryu_release_schema_preflight_v33()'),
    ('public.koaryu_release_schema_preflight_v34()'),
    ('public.koaryu_release_schema_preflight_v35()'),
    ('public.koaryu_release_schema_preflight_v36()'),
    ('public.koaryu_release_schema_preflight_v37()'),
    ('public.koaryu_release_schema_preflight_v38()'),
    ('public.koaryu_release_schema_preflight_v39()'),
    ('public.koaryu_release_schema_preflight_v4()'),
    ('public.koaryu_release_schema_preflight_v5()'),
    ('public.koaryu_release_schema_preflight_v6()'),
    ('public.koaryu_release_schema_preflight_v7()'),
    ('public.koaryu_release_schema_preflight_v8()'),
    ('public.koaryu_release_schema_preflight_v9()'),
    ('public.list_automation_workflow_runs_v1(uuid,uuid,uuid,integer,jsonb)'),
    ('public.list_automation_workflows_v1(uuid,uuid,integer,jsonb)'),
    ('public.list_belt_test_events_v1(uuid,uuid,integer,jsonb)'),
    ('public.list_belt_test_recipients_v1(uuid,uuid,uuid,integer,jsonb)'),
    ('public.list_billing_enrollment_scheduled_transitions_v1(uuid,uuid[])'),
    ('public.list_billing_payers_v1(uuid,uuid,date)'),
    ('public.list_lead_trial_appointments_v1(uuid,uuid,uuid,integer,jsonb)'),
    ('public.list_student_ids_for_program_filter(uuid,uuid,text,text,text,text,integer,integer)'),
    ('public.list_student_roster(uuid,text,text,uuid,integer,text,date,text,text,integer,text,uuid,text)'),
    ('public.load_connect_onboarding_bootstrap_recovery_context(uuid,text)'),
    ('public.mark_billing_enrollment_due_pre_provider_reconciliation_v1(uuid,uuid,uuid,bigint,text,text)'),
    ('public.mark_billing_enrollment_due_readback_reconciliation_v1(uuid,uuid,uuid,bigint,text,text)'),
    ('public.mark_billing_payer_setup_reconciliation_v1(uuid,uuid,text,text,text,integer,text)'),
    ('public.mark_billing_provider_recovery_reconciliation_v2(uuid,uuid,uuid,text,text,text,text,integer,uuid,bigint,text)'),
    ('public.materialize_recurring_class_sessions(uuid,date,date)'),
    ('public.mutate_belt_test_event_v1(uuid,uuid,uuid,uuid,bigint,jsonb)'),
    ('public.mutate_lead_trial_appointment_v1(uuid,uuid,uuid,uuid,uuid,bigint,jsonb)'),
    ('public.mutate_student_program_membership_atomic(uuid,uuid,uuid,text,uuid,jsonb)'),
    ('public.mutate_students_bulk_atomic(uuid,uuid,uuid[],text,text[],text[],text)'),
    ('public.operational_alert_heartbeats(text)'),
    ('public.operational_alert_metric_counts()'),
    ('public.preflight_connect_onboarding_bootstrap_begin(uuid,text)'),
    ('public.preflight_connect_onboarding_bootstrap_resume(uuid,text)'),
    ('public.prepare_billing_payer_setup_request_v1(uuid,uuid,uuid,uuid,uuid,text,text,integer,uuid,bigint,timestamp with time zone)'),
    ('public.prepare_connect_onboarding_bootstrap_atomic(uuid,text,integer,jsonb,text,text,text,text)'),
    ('public.prepare_student_import_belts_v1(uuid,uuid,text,uuid,uuid,jsonb,boolean)'),
    ('public.prepare_student_import_program_v1(uuid,uuid,text,text,uuid,text,uuid,boolean,boolean)'),
    ('public.preserve_billing_invoice_retry_operation_created_at()'),
    ('public.preserve_studio_comp_provenance()'),
    ('public.prevent_operational_alert_append_only_mutation()'),
    ('public.preview_missed_class_automation_v1(uuid,uuid,integer)'),
    ('public.process_automation_workflow_occurrences_v1(integer)'),
    ('public.publish_core_checkout_atomic(uuid,uuid,bigint,text,text,bigint)'),
    ('public.read_active_billing_payer_payment_consent_v1(uuid,uuid,text,text,integer)'),
    ('public.read_billing_enrollment_item_schedule_identity_v31(uuid,uuid)'),
    ('public.read_billing_enrollment_transition_by_key_v1(uuid,uuid,text,text,text,uuid)'),
    ('public.read_billing_payer_setup_request_v1(uuid,uuid,uuid,text,integer)'),
    ('public.read_billing_payer_setup_webhook_v1(uuid,text,text,integer)'),
    ('public.read_billing_provider_operation_step_plan_v1(uuid,uuid,uuid,text,text,text,text,integer,text)'),
    ('public.read_billing_provider_operation_v1(uuid,uuid,uuid,text,text,text,text,integer)'),
    ('public.read_stripe_rehearsal_local_evidence_v1(uuid,text,integer,timestamp with time zone,timestamp with time zone,jsonb,uuid[],uuid,text[],text[])'),
    ('public.reassign_memberships_before_belt_rank_delete()'),
    ('public.recompute_billing_invoice_external_payment_totals(uuid,uuid)'),
    ('public.recompute_billing_payer_balance_v1(uuid,uuid)'),
    ('public.record_connect_onboarding_bootstrap_initial_link_response(uuid,uuid,text,integer,text,text,text,text,text,text)'),
    ('public.record_core_checkout_compensation_required_atomic(uuid,text,text,bigint,text,boolean)'),
    ('public.record_external_payment_v1(uuid,uuid,uuid,integer,text,text,text,text,text)'),
    ('public.record_operational_alert_heartbeat(text,text,text)'),
    ('public.record_stripe_live_billing_reconciliation_checkpoint(text,integer,integer,integer,integer,integer,integer,timestamp with time zone,timestamp with time zone,integer,integer,boolean,boolean,timestamp with time zone,text,text,uuid,text)'),
    ('public.record_stripe_live_billing_reconciliation_checkpoint_v2(jsonb,timestamp with time zone,text,text,uuid,text)'),
    ('public.record_stripe_live_billing_reconciliation_checkpoint_v3(jsonb,timestamp with time zone,text,text,uuid,text)'),
    ('public.record_student_demotion(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text)'),
    ('public.record_student_demotion_v2(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,uuid)'),
    ('public.record_student_promotion(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text)'),
    ('public.record_student_promotion_v2(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,uuid)'),
    ('public.record_student_rank_transition_v3(uuid,uuid,uuid,uuid,uuid,uuid,text,text,uuid)'),
    ('public.register_billing_provider_operation_step_plan_v1(uuid,uuid,uuid,text,text,text,text,integer,uuid,bigint,text,integer,jsonb)'),
    ('public.reject_billing_autopay_activation_without_provider_v31(uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,integer,uuid,text,text,bigint)'),
    ('public.reject_billing_payer_setup_without_provider_v1(uuid,uuid,uuid,uuid,uuid,text,text,text,integer,uuid,bigint,bigint)'),
    ('public.reject_billing_provider_recovery_source_drift_v2(uuid,uuid,uuid,text,text,text,text,integer,uuid,bigint,text)'),
    ('public.release_billing_invoice_retry_preread_lease_v32(uuid,uuid,uuid,text,text,text,integer,uuid,bigint)'),
    ('public.release_billing_invoice_retry_preread_lease_v33(uuid,uuid,uuid,text,text,text,integer,uuid,bigint,text)'),
    ('public.release_core_checkout_reservation_atomic(uuid,uuid,bigint)'),
    ('public.reserve_billing_autopay_activation_v31(uuid,uuid,uuid,uuid,uuid,text,integer,text,text,numeric)'),
    ('public.reserve_core_checkout_atomic(uuid)'),
    ('public.reserve_core_checkout_v2_atomic(uuid)'),
    ('public.reset_stripe_connect_account_atomic_v58(uuid,uuid,text,integer)'),
    ('public.resolve_workflow_email_without_attempt_v1(uuid,uuid,uuid,text,text,text,text[],text,text,jsonb)'),
    ('public.revoke_belt_test_recipient_v1(uuid,uuid,uuid,uuid,uuid,bigint)'),
    ('public.revoke_billing_enrollment_transition_v1(uuid,uuid,uuid,bigint,text,text,text,uuid,integer)'),
    ('public.revoke_billing_enrollment_transition_v29(uuid,uuid,uuid,bigint,text,text,text,uuid,integer)'),
    ('public.revoke_billing_payer_payment_consent_v1(uuid,uuid,uuid,text,integer,timestamp with time zone,uuid,text,text)'),
    ('public.save_automation_email_credential_v1(text,bigint,text)'),
    ('public.save_automation_workflow_v1(uuid,uuid,uuid,uuid,bigint,text,text,jsonb,jsonb)'),
    ('public.save_missed_class_automation_rule_v1(uuid,uuid,bigint,boolean,integer,text,text,text)'),
    ('public.schedule_window_read(uuid,date,date,text)'),
    ('public.set_stripe_connect_account_exclusion_atomic(text,boolean,text,uuid,text)'),
    ('public.set_student_is_minor()'),
    ('public.set_studio_comp_atomic(uuid,boolean,text,uuid,text,boolean)'),
    ('public.set_studio_comp_v2_atomic(uuid,boolean,text,uuid,text,boolean)'),
    ('public.set_studio_live_billing_authorization_atomic(uuid,text,boolean,timestamp with time zone,text,uuid,text,text)'),
    ('public.set_studio_live_billing_authorization_operations_v1(uuid,text,boolean,timestamp with time zone,text,uuid,text[],text,text)'),
    ('public.set_studio_live_billing_authorization_scope_v3(uuid,text,boolean,timestamp with time zone,text,uuid,text,text)'),
    ('public.settle_automation_sender_preparation_v1(uuid,uuid,jsonb)'),
    ('public.settle_automation_test_email_v1(uuid,uuid,uuid,uuid,jsonb)'),
    ('public.settle_missed_class_automation_v1(uuid,uuid,text,text,text,integer)'),
    ('public.settle_missed_class_automation_v2(uuid,uuid,uuid,jsonb)'),
    ('public.settle_workflow_email_v1(uuid,uuid,uuid,jsonb)'),
    ('public.snapshot_promotion_rank_identity()'),
    ('public.soft_delete_student_atomic(uuid,uuid,uuid)'),
    ('public.start_due_billing_enrollment_transition_v1(uuid,uuid,bigint,integer)'),
    ('public.student_business_date(uuid)'),
    ('public.studio_live_billing_supported_operations_v58(uuid,text)'),
    ('public.sum_email_usage_for_period(uuid,timestamp with time zone,timestamp with time zone)'),
    ('public.support_triage_digest(integer)'),
    ('public.support_triage_list_tickets(text[],text[],text[],integer)'),
    ('public.support_triage_update_ticket(uuid,text,text,jsonb)'),
    ('public.suppress_missed_class_automation_v1(text)'),
    ('public.sync_belt_ladder_ranks(uuid,uuid,text,jsonb)'),
    ('public.sync_belt_ladder_ranks_internal(uuid,uuid,text,jsonb)'),
    ('public.sync_belt_ladder_ranks_v2(uuid,uuid,uuid,uuid,text,jsonb)'),
    ('public.sync_primary_student_rank_from_membership()'),
    ('public.transition_billing_enrollment_transition_v1(uuid,uuid,uuid,bigint,uuid,bigint,text,text)'),
    ('public.transition_billing_enrollment_transition_v29(uuid,uuid,uuid,bigint,uuid,bigint,text,text)'),
    ('public.transition_billing_provider_operation_step_v1(uuid,uuid,uuid,text,text,text,text,integer,text,integer,text,text,text,text,uuid,bigint,text,text,text,text,text,text,text)'),
    ('public.transition_billing_provider_operation_v1(uuid,uuid,uuid,text,text,text,text,integer,uuid,bigint,text,text,text,text,text,text,text,text,text)'),
    ('public.update_lead_atomic(uuid,uuid,uuid,jsonb)'),
    ('public.update_updated_at_column()'),
    ('public.validate_attendance_program_integrity()'),
    ('public.validate_automation_workflow_v1(uuid,uuid,jsonb,jsonb)'),
    ('public.validate_billing_adjustment_refs()'),
    ('public.validate_billing_dispute_refs()'),
    ('public.validate_billing_invoice_item_refs()'),
    ('public.validate_billing_invoice_refs()'),
    ('public.validate_billing_payer_guardian()'),
    ('public.validate_billing_payment_refs()'),
    ('public.validate_billing_plan_program()'),
    ('public.validate_billing_refund_refs()'),
    ('public.validate_billing_subscription_refs()'),
    ('public.validate_class_session_program_integrity()'),
    ('public.validate_class_template_program_integrity()'),
    ('public.validate_lead_program_integrity()'),
    ('public.validate_student_billing_enrollment()'),
    ('public.validate_student_birth_date()'),
    ('public.validate_student_guardian_tenant_integrity()'),
    ('public.validate_student_profile_tenant_integrity()'),
    ('public.validate_student_program_membership()'),
    ('public.write_billing_plan_v1(uuid,uuid,uuid,jsonb,uuid[])'),
    ('public.write_student_profile_atomic(uuid,uuid,uuid,jsonb,uuid[],jsonb,boolean,text)'),
    ('public.write_student_profile_v2_atomic(uuid,uuid,uuid,jsonb,uuid[],jsonb,boolean,text)')) required(signature)
LEFT JOIN pg_catalog.pg_proc p ON p.oid=pg_catalog.to_regprocedure(required.signature)
LEFT JOIN pg_catalog.pg_language l ON l.oid=p.prolang)::TEXT,'UTF8'),'sha256'),'hex'))
       IS DISTINCT FROM '8b3e0397ebf350213feca1848151f4a5f2f65f055ceb28c1c9e14558531871b3'
       OR (SELECT array_agg(p.oid::REGPROCEDURE::TEXT ORDER BY p.oid::REGPROCEDURE::TEXT COLLATE "C")
           FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
           WHERE n.nspname IN ('public','private') AND p.prokind='f'
             AND p.oid <> pg_catalog.to_regprocedure('public.koaryu_release_schema_preflight_v40()'))
          IS DISTINCT FROM ARRAY['private.assert_billing_enrollment_transition_current_v1(public.billing_enrollment_transition_intents)','private.automation_bind_unsubscribe_token_v1(uuid,text,text)','private.automation_clear_statement_fence_v1()','private.automation_core_entitled(uuid)','private.automation_delivery_immutable()','private.automation_delivery_result_v1(jsonb,bigint)','private.automation_email_attempt_begin_v1(uuid,text,uuid,text,uuid,uuid,text,uuid,uuid,uuid,integer)','private.automation_email_attempt_expire_v1(uuid)','private.automation_email_attempt_identity_v1()','private.automation_email_attempt_settle_v1(uuid,uuid,jsonb)','private.automation_email_scope_lock_v1(uuid,text,uuid,text,text)','private.automation_expire_orphaned_legacy_attempts_v1(integer)','private.automation_has_actionable_work(text[])','private.automation_instant_v1(jsonb)','private.automation_legacy_begin_v1(uuid,uuid,text[],uuid,uuid,uuid)','private.automation_legacy_delivery_delete_v1()','private.automation_legacy_delivery_result_v1(jsonb)','private.automation_legacy_delivery_transition_v1()','private.automation_legacy_projection_pin_v1(uuid,uuid,jsonb)','private.automation_legacy_projection_valid_v1(jsonb)','private.automation_legacy_settle_v1(uuid,uuid,uuid,jsonb)','private.automation_legacy_terminal_v1(jsonb,integer)','private.automation_normalize_email(text)','private.automation_require_admin(uuid,uuid)','private.automation_sender_claim_v1(uuid,text,text,uuid)','private.automation_sender_failure_v1(text,text,bigint,integer,timestamp with time zone)','private.automation_sender_gate_identity_v1()','private.automation_sender_gate_lock_v1()','private.automation_sender_instant_v1(timestamp with time zone)','private.automation_sender_preparation_identity_v1()','private.automation_sender_preparation_reply_v1(uuid,private.automation_sender_gate,private.automation_sender_preparations,text,text)','private.automation_sender_preparation_result_valid_v1(jsonb)','private.automation_sender_preparation_settle_v1(uuid,uuid,jsonb)','private.automation_sender_release_orphan_probe_v1()','private.automation_sender_release_probe_v1(uuid,uuid,uuid)','private.automation_sender_retry_at_v1(private.automation_sender_gate,timestamp with time zone)','private.automation_test_actor_v1(uuid,uuid)','private.automation_test_allowed_v1(text[])','private.automation_test_clear_owned_v1(uuid)','private.automation_test_execution_v1(private.automation_test_email_scopes,jsonb)','private.automation_test_expire_v1(private.automation_test_email_scopes)','private.automation_test_fail_v1(private.automation_test_email_scopes,text)','private.automation_test_invalidate_queued_v1(uuid)','private.automation_test_original_v1(uuid,uuid,uuid)','private.automation_test_own_v1(uuid,uuid,uuid,uuid,text[])','private.automation_test_payload_delete_v1()','private.automation_test_payload_identity_v1()','private.automation_test_rendered_valid_v1(jsonb)','private.automation_test_result_v1(private.automation_test_email_scopes)','private.automation_test_scope_identity_v1()','private.automation_test_verified_email_v1(uuid)','private.automation_timezone_v1(jsonb)','private.automation_unsubscribe_binding_identity_v1()','private.automation_utc_text_v1(timestamp with time zone)','private.belt_test_cancel_recipient_runs_v1(uuid,uuid[],timestamp with time zone)','private.belt_test_event_payload_v1(public.belt_test_events)','private.belt_test_lock_recipient_runs_v1(uuid,uuid[])','private.belt_test_name_v1(jsonb)','private.belt_test_recipient_identity_v1()','private.belt_test_recipient_payload_v1(public.belt_test_recipients)','private.billing_enrollment_item_schedule_completed_v31(public.billing_provider_operations,public.billing_enrollment_transition_intents)','private.billing_enrollment_item_schedule_phase_succeeded_v31(public.billing_provider_operations,public.billing_enrollment_transition_intents)','private.billing_enrollment_item_schedule_pre_provider_rejected_v31(public.billing_provider_operations)','private.billing_enrollment_transition_json_v1(public.billing_enrollment_transition_intents,text,text)','private.billing_invoice_retry_base_hash_v33(uuid,uuid,text,text,integer)','private.billing_invoice_retry_preread_zero_evidence_v33(public.billing_provider_operations,text)','private.billing_operation_resource_version_v31(text,public.billing_payments,public.billing_payers,text,integer)','private.billing_payer_payment_consent_json_v1(public.billing_payer_payment_consents,text)','private.billing_payer_setup_request_json_v1(public.billing_payer_setup_requests,text)','private.billing_plan_resource_version_v31(public.billing_plans,text,integer)','private.billing_provider_operation_json_v1(public.billing_provider_operations,text)','private.billing_provider_operation_resource_json_v1(public.billing_provider_operation_resources,public.billing_provider_operations,text,text)','private.billing_provider_operation_step_json_v1(public.billing_provider_operation_steps)','private.billing_provider_operation_step_plan_json_v1(public.billing_provider_operations,text)','private.billing_provider_operation_step_result_json_v1(public.billing_provider_operations,public.billing_provider_operation_steps,text)','private.bind_live_billing_authorization_checkpoint()','private.can_read_staff_profile(uuid)','private.capture_billing_invoice_retry_alias_v33()','private.capture_billing_invoice_retry_hash_v33(uuid,uuid,uuid,uuid,uuid,text)','private.capture_billing_invoice_retry_resource_v33()','private.claim_billing_invoice_mutation_v31(uuid,uuid,text,text,uuid,uuid,text,text,text,integer,uuid,integer)','private.claim_billing_invoice_retry_v33(uuid,uuid,uuid,uuid,text,text,text,integer,uuid,integer)','private.claim_payment_payer_operation_resource_v31(uuid,uuid,text,text,uuid,uuid,text,text,text,integer,uuid,integer)','private.claim_student_import_run_owned(uuid,uuid,text,text,text,text,boolean,integer)','private.clear_studio_operational_data_v2(uuid,boolean)','private.connect_onboarding_bootstrap_link_checkpoint(uuid,text)','private.connect_onboarding_ga_initial_link_eligible_v58(uuid,text)','private.current_connect_account_generation(jsonb)','private.deterministic_import_uuid(uuid,text)','private.enforce_billing_payer_connect_identity_v1()','private.enforce_billing_payment_refundable_amount_v31()','private.enforce_billing_provider_step_parent_v1()','private.enforce_live_billing_checkpoint_processed_events()','private.enforce_single_studio_membership()','private.handle_invoice_retry_consent_change_v33(uuid,uuid)','private.has_unambiguous_studio_membership()','private.import_student_row_atomic(jsonb,uuid,uuid,text,integer,text,text,text,text,uuid[])','private.is_admin_in_studio(uuid)','private.is_admin_or_front_desk_in_studio(uuid)','private.is_staff_in_studio(uuid)','private.koaryu_release_adjustment_trigger_guard_manifest_v37()','private.koaryu_release_critical_surface_manifest_v14()','private.koaryu_release_critical_surface_manifest_v15()','private.koaryu_release_critical_surface_manifest_v16()','private.koaryu_release_critical_surface_manifest_v17()','private.koaryu_release_critical_surface_manifest_v18()','private.koaryu_release_enrollment_transition_manifest_v29()','private.koaryu_release_invoice_retry_closeout_manifest_v34()','private.koaryu_release_invoice_retry_compatibility_manifest_v33()','private.koaryu_release_invoice_retry_preread_manifest_v32()','private.koaryu_release_live_billing_v3_manifest_v25()','private.koaryu_release_operational_contract_v25()','private.koaryu_release_operational_contract_v26()','private.koaryu_release_operational_contract_v27()','private.koaryu_release_operational_contract_v28()','private.koaryu_release_operational_contract_v29()','private.koaryu_release_operational_contract_v30()','private.koaryu_release_operational_contract_v31()','private.koaryu_release_operational_manifest_v10()','private.koaryu_release_operational_manifest_v11()','private.koaryu_release_operational_manifest_v12()','private.koaryu_release_operational_manifest_v2()','private.koaryu_release_operational_manifest_v2_base()','private.koaryu_release_operational_manifest_v4()','private.koaryu_release_operational_manifest_v5()','private.koaryu_release_operational_manifest_v6()','private.koaryu_release_operational_manifest_v7()','private.koaryu_release_operational_manifest_v8()','private.koaryu_release_operational_manifest_v9()','private.koaryu_release_payer_setup_recovery_manifest_v36()','private.koaryu_release_payment_adjustment_manifest_v26()','private.koaryu_release_payments_replay_repairs_manifest_v30()','private.koaryu_release_provider_operation_steps_manifest_v28()','private.koaryu_release_provider_operations_manifest_v27()','private.koaryu_release_resource_ownership_manifest_v31()','private.koaryu_release_schedule_window_manifest_v1()','private.koaryu_release_schema_preflight_v14_snapshot_v34()','private.koaryu_release_starting_belt_manifest_v9()','private.koaryu_release_stripe_rehearsal_evidence_manifest_v35()','private.koaryu_release_student_rank_writer_manifest_v11()','private.koaryu_release_student_rank_writer_manifest_v12()','private.koaryu_release_student_rank_writer_manifest_v13()','private.live_billing_event_is_in_scope(text,text)','private.live_billing_ga_events_clear_v58()','private.live_billing_ga_operations_v58(text)','private.live_billing_operation_set_is_canonical_v1(text,text[])','private.lock_student_import_actor(uuid)','private.lock_student_import_run(uuid,uuid,text)','private.maintain_billing_invoice_mutation_owner_v31()','private.missed_class_automation_candidates(uuid,integer,uuid,uuid,timestamp with time zone)','private.preserve_billing_enrollment_transition_identity_v1()','private.preserve_billing_invoice_mutation_owner_v31()','private.preserve_billing_invoice_retry_hash_ledger_v33()','private.preserve_billing_payer_payment_consent_v1()','private.preserve_billing_payer_setup_request_v1()','private.preserve_billing_provider_operation_identity_v1()','private.preserve_billing_provider_operation_resource_alias_v1()','private.preserve_billing_provider_operation_resource_v1()','private.preserve_billing_provider_operation_step_v1()','private.prevent_account_deletion_orphan()','private.prevent_staff_admin_orphan()','private.rank_transition_fingerprint_v1(uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text)','private.recompute_billing_payment_adjustment_totals(uuid)','private.recompute_payment_after_adjustment_change()','private.record_student_rank_transition_v2(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,uuid)','private.record_student_rank_transition_v3(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,uuid,boolean)','private.reject_billing_enrollment_transition_alias_mutation_v1()','private.reject_consent_change_during_invoice_retry_v31()','private.reject_payer_change_during_invoice_retry_v31()','private.resolve_billing_invoice_retry_identity_v33(uuid,uuid,uuid,uuid)','private.set_audit_actor_legal_name()','private.stripe_rehearsal_manifest_ids_v35(jsonb,text,boolean)','private.sync_connect_identity_exclusion_guard()','private.sync_connect_identity_mapping_guard()','private.timezone_name_known(text)','private.timezone_name_or_utc(text)','private.trial_appointment_payload_v1(public.lead_trial_appointments)','private.trial_rebooking_marker_v1()','private.validate_billing_adjustment_payment_identity()','private.validate_billing_payment_identity_change()','private.workflow_activation_immutable_v1()','private.workflow_apply_lead_follow_up_v1(uuid,uuid,uuid,text,uuid,jsonb,timestamp with time zone)','private.workflow_blank_v1(jsonb)','private.workflow_cancel_pending_v1(uuid,uuid,timestamp with time zone,text)','private.workflow_cancel_runs_v1(uuid,uuid[],timestamp with time zone,text)','private.workflow_cancel_settled_invoice_runs_v1(uuid,uuid[])','private.workflow_cancel_source_pending_v1(uuid,text,uuid,timestamp with time zone,text)','private.workflow_capture_events_v1(uuid,jsonb,jsonb)','private.workflow_capture_payment_failure_v1()','private.workflow_catalog_v1()','private.workflow_condition_result_v1(text,text,jsonb,jsonb)','private.workflow_current_rank_authority_v1(uuid,uuid,uuid)','private.workflow_current_source_facts_v1(uuid,text,uuid,jsonb,jsonb,timestamp with time zone,text[])','private.workflow_current_staff_recipient_v1(uuid,uuid)','private.workflow_defer_owned_run_v1(uuid,uuid,timestamp with time zone,text)','private.workflow_delay_due_identity_v1()','private.workflow_detail_v1(uuid,uuid)','private.workflow_email_attempt_identity_v1()','private.workflow_email_attempt_payload_v1(private.automation_workflow_email_attempts)','private.workflow_email_fingerprint_v1(jsonb,jsonb)','private.workflow_email_finish_step_v1(uuid,uuid,uuid,text,timestamp with time zone,text,text,boolean)','private.workflow_email_own_v1(uuid,uuid,uuid,text,text,text[],text,text)','private.workflow_email_parameters_valid_v1(text,text[],text,text)','private.workflow_email_payload_delete_v1()','private.workflow_email_payload_identity_v1()','private.workflow_email_plan_v1(public.automation_workflow_runs,private.automation_workflow_events,jsonb,jsonb,timestamp with time zone,text,text[],text,text)','private.workflow_email_project_settlement_v1(uuid,boolean)','private.workflow_email_rendered_valid_v1(jsonb)','private.workflow_email_selected_values_v1(jsonb,jsonb)','private.workflow_email_source_inventory_v1(uuid,private.automation_workflow_events,jsonb,text)','private.workflow_enroll_timed_occurrence_v1(uuid,uuid,uuid,timestamp with time zone,timestamp with time zone,timestamp with time zone)','private.workflow_expire_email_attempts_v1(integer)','private.workflow_fact_text_v1(text)','private.workflow_finalize_invoice_episode_deferred_v1()','private.workflow_finalize_invoice_episodes_v1()','private.workflow_finalize_rank_deferred_v1()','private.workflow_financial_identity_valid_v1(public.billing_invoices,public.billing_payers,public.studio_payment_accounts,public.billing_payments)','private.workflow_follow_up_receipt_identity_v1()','private.workflow_graph_read_issues_v1(uuid,jsonb)','private.workflow_hash_v1(jsonb)','private.workflow_immutable_record_v1()','private.workflow_integer_v1(jsonb,bigint,bigint)','private.workflow_invoice_episode_context_valid_v1(jsonb)','private.workflow_invoice_episode_identity_v1()','private.workflow_invoice_episode_pending_identity_v1()','private.workflow_invoice_episode_projection_v1(public.billing_invoices,public.billing_payers)','private.workflow_invoice_episode_state_identity_v1()','private.workflow_invoice_episode_threshold_v1(date,text)','private.workflow_invoice_financial_context_v1(uuid,uuid,uuid)','private.workflow_invoice_settlement_identity_v1()','private.workflow_invoice_settlement_seed_v1()','private.workflow_json_keys_v1(jsonb,text[],text[])','private.workflow_lock_email_sources_v1(uuid,private.automation_workflow_events,jsonb,text)','private.workflow_lock_financial_sources_v1(uuid,uuid,uuid[])','private.workflow_lock_lead_assignee_v1(uuid)','private.workflow_lock_recipient_auth_v1(uuid)','private.workflow_lock_run_sources_v1(uuid,private.automation_workflow_events,jsonb)','private.workflow_lock_timed_sources_v1(jsonb)','private.workflow_mark_invoice_episode_v1()','private.workflow_mark_payer_episode_demo_v1()','private.workflow_mutate_v1(uuid,uuid,uuid,uuid,bigint,text,text,text,jsonb,jsonb,boolean,boolean)','private.workflow_observe_payment_settlement_v1(uuid,uuid)','private.workflow_payment_evidence_v1(public.billing_payments)','private.workflow_payment_evidence_valid_v1(jsonb)','private.workflow_payment_settlement_valid_v1(uuid,uuid)','private.workflow_prepare_capture_v1(uuid,uuid[],boolean)','private.workflow_prepare_financial_context_v1(uuid,uuid,uuid)','private.workflow_queue_invoice_episode_v1(uuid,uuid,boolean,boolean,boolean,text)','private.workflow_rank_compare_pending_v1(uuid,uuid)','private.workflow_rank_context_generation_v1(uuid,uuid,uuid)','private.workflow_rank_context_identity_v1()','private.workflow_rank_finalize_pending_v1(uuid)','private.workflow_rank_mark_dirty_v1(uuid,uuid,uuid,boolean)','private.workflow_rank_scope_enter_v1(uuid,uuid,text)','private.workflow_rank_scope_finish_v1(uuid,uuid,jsonb)','private.workflow_rank_tuple_v1(uuid,uuid,uuid)','private.workflow_require_actor_v1(uuid,uuid,boolean)','private.workflow_require_graph_tenant_v1(uuid,jsonb)','private.workflow_run_detail_v1(uuid,uuid)','private.workflow_run_identity_v1()','private.workflow_run_position_v1(public.automation_workflow_runs)','private.workflow_run_step_identity_v1()','private.workflow_run_step_payload_v1(private.automation_workflow_run_steps)','private.workflow_run_subject_label_v1(private.automation_workflow_events)','private.workflow_run_summary_payload_v1(public.automation_workflow_runs,private.automation_workflow_events,public.automation_workflow_versions,text)','private.workflow_semantic_graph_v1(jsonb)','private.workflow_settlement_observation_identity_v1()','private.workflow_simulation_projection_v1(uuid,uuid,jsonb,jsonb,timestamp with time zone)','private.workflow_staff_auth_email_v1(uuid,uuid)','private.workflow_student_enrollment_event_v1(uuid,uuid,jsonb)','private.workflow_timed_candidates_v1(integer,timestamp with time zone)','private.workflow_timer_activation_identity_v1()','private.workflow_timer_activation_insert_v1()','private.workflow_transition_owned_v1(uuid,uuid,uuid,integer,text)','private.workflow_trigger_event_type_v1(jsonb)','private.workflow_typed_value_v1(jsonb,jsonb)','private.workflow_validate_v1(jsonb,jsonb,boolean)','private.write_student_profile_atomic(uuid,uuid,uuid,jsonb,uuid[],jsonb,boolean,text)','public.accept_billing_payer_payment_consent_v1(uuid,uuid,uuid,text,text,text,integer,text,timestamp with time zone)','public.accept_core_checkout_completion_atomic(uuid,uuid,bigint,text,bigint)','public.accept_core_checkout_subscription_atomic(uuid,uuid,bigint,text,text,bigint)','public.acknowledge_connect_onboarding_bootstrap_initial_link_delivery(uuid,text,text)','public.acknowledge_operational_alert(text,uuid,text,text)','public.advance_automation_workflow_run_v1(uuid,uuid,uuid,integer)','public.approve_belt_test_recipients_v1(uuid,uuid,uuid,uuid,bigint,jsonb)','public.archive_students_bulk_atomic(uuid,uuid,uuid[])','public.authorize_billing_enrollment_transition_recovery_v1(uuid,uuid,uuid,bigint,uuid,bigint,text,text,uuid,integer)','public.authorize_billing_provider_operation_recovery_v1(uuid,uuid,uuid,text,text,text,text,integer,uuid,text,text,uuid,integer,bigint)','public.authorize_billing_provider_operation_recovery_v2(uuid,uuid,uuid,text,text,text,text,integer,uuid,text,text,text,uuid,integer,bigint)','public.authorize_billing_provider_operation_step_recovery_v1(uuid,uuid,uuid,text,text,text,text,integer,text,integer,text,text,text,text,uuid,text,text,uuid,integer,bigint)','public.authorize_connect_onboarding_bootstrap_account_create(uuid,text,integer,text,text,text,text,text)','public.authorize_connect_onboarding_bootstrap_account_create_v2(uuid,uuid,text,integer,text,text)','public.authorize_connect_onboarding_bootstrap_initial_link(uuid,text,integer,text,text,text,text,text)','public.authorize_connect_onboarding_bootstrap_initial_link_v2(uuid,uuid,text,integer,text,text,text,text)','public.authorize_studio_live_billing_mutation_atomic(uuid,text,text,text,text)','public.authorize_studio_live_billing_scope_v3(uuid,text,text,text,text)','public.backfill_starting_belt_after_rank_delete()','public.backfill_starting_belt_for_program()','public.begin_automation_test_email_v1(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text[],text,jsonb)','public.begin_billing_enrollment_activation_v1(uuid,uuid,uuid,text,text,text,text,integer,uuid,bigint,uuid,text,text)','public.begin_missed_class_automation_v1(uuid,uuid,text[])','public.begin_missed_class_automation_v2(uuid,uuid,uuid,uuid,text[],uuid)','public.begin_workflow_email_v1(uuid,uuid,uuid,text,text,text,text[],text,text,jsonb,uuid,uuid,uuid)','public.billing_attention_count_v1(uuid,date)','public.billing_invoice_collection_facts_v1(uuid,uuid,date)','public.billing_landing_aggregates(uuid,timestamp with time zone,timestamp with time zone)','public.billing_payer_balance_facts_v1(uuid,uuid,date)','public.billing_payment_cohort(uuid,timestamp with time zone,timestamp with time zone)','public.billing_webhook_health(text,boolean,timestamp with time zone)','public.bind_billing_payer_setup_session_v1(uuid,uuid,uuid,uuid,text,text,integer,bigint)','public.bind_connect_onboarding_bootstrap_account(uuid,text,integer,text,text,text)','public.bind_connect_onboarding_bootstrap_account_v2(uuid,uuid,text,integer,text,text)','public.bind_student_import_rank_v1(uuid,uuid,text,uuid,text,uuid)','public.cancel_automation_workflow_run_v1(uuid,uuid,uuid,uuid,bigint)','public.claim_automation_sender_preparation_v1(text,uuid,text)','public.claim_automation_test_sender_preparation_v1(uuid,uuid,uuid,uuid,uuid,text,text[])','public.claim_automation_workflow_runs_v1(integer)','public.claim_billing_enrollment_transition_v1(uuid,uuid,text,text,text,uuid,uuid,uuid,text,text,text,integer,timestamp with time zone,integer,integer,integer,integer,text,text,uuid,integer)','public.claim_billing_enrollment_transition_v29(uuid,uuid,text,text,text,uuid,uuid,uuid,text,text,text,integer,timestamp with time zone,integer,integer,integer,integer,text,text,uuid,integer)','public.claim_billing_invoice_closeout_operation_v1(uuid,uuid,text,text,uuid,uuid,text,text,text,integer,uuid,integer)','public.claim_billing_invoice_closeout_operation_v30(uuid,uuid,text,text,uuid,uuid,text,text,text,integer,uuid,integer)','public.claim_billing_provider_operation_resource_v1(uuid,uuid,text,text,uuid,uuid,text,text,text,integer,uuid,integer)','public.claim_billing_provider_operation_resource_v30(uuid,uuid,text,text,uuid,uuid,text,text,text,integer,uuid,integer)','public.claim_billing_provider_operation_step_v1(uuid,uuid,uuid,text,text,text,text,integer,text,integer,text,text,text,text,uuid,integer)','public.claim_billing_provider_operation_v1(uuid,uuid,text,text,text,text,integer,uuid,integer)','public.claim_billing_subscription_quantity_sync(uuid,uuid,text,integer)','public.claim_due_account_deletion_requests(integer,text,integer)','public.claim_due_billing_enrollment_transitions_v1(uuid,integer,integer)','public.claim_missed_class_automations_v1(integer,text[])','public.claim_operational_alert_delivery(text,text,uuid,integer)','public.claim_stripe_event_for_processing(text,text,boolean,text,jsonb,text,integer)','public.claim_student_import_run(uuid,uuid,text,text,text,text,integer)','public.claim_student_import_run_v2(uuid,uuid,text,text,text,text,integer)','public.clear_studio_comp_for_billing_event(uuid,bigint)','public.clear_studio_operational_data_atomic(uuid,boolean)','public.clear_studio_operational_data_v2(uuid,boolean)','public.close_billing_payer_setup_request_v1(uuid,uuid,uuid,uuid,text,text,integer,text,text)','public.command_automation_workflow_v1(uuid,uuid,uuid,uuid,bigint,text,boolean,boolean)','public.complete_billing_payer_payment_consent_v1(uuid,uuid,uuid,text,text,text,integer,timestamp with time zone)','public.complete_billing_provider_operation_provider_phase_v1(uuid,uuid,uuid,text,text,text,text,integer,text,integer,bigint)','public.complete_billing_provider_operation_provider_phase_v31(uuid,uuid,uuid,text,text,text,text,integer,text,integer,bigint,uuid)','public.complete_billing_provider_operation_v1(uuid,uuid,uuid,text,text,text,text,integer,uuid,bigint,text,text)','public.complete_due_billing_enrollment_item_transition_v31(uuid,uuid,uuid,bigint,text,jsonb)','public.complete_due_billing_enrollment_transition_v1(uuid,uuid,bigint,text,text)','public.complete_operational_alert_delivery(uuid,text,text)','public.convert_lead_to_student_atomic(uuid,uuid,uuid,uuid,uuid,text,date,uuid,uuid)','public.create_automation_test_email_v1(uuid,uuid,uuid,uuid,jsonb,text,jsonb,boolean)','public.create_automation_workflow_v1(uuid,uuid,uuid,text,text,jsonb,jsonb)','public.create_lead_atomic_v1(uuid,uuid,uuid,jsonb)','public.create_studio_onboarding(uuid,text,text,text)','public.create_support_ticket(uuid,uuid,text,text,text,text,text,text,text,text,jsonb)','public.dashboard_summary_facts(uuid,text,text,date,text)','public.defer_automation_workflow_run_v1(uuid,uuid,uuid,text)','public.defer_missed_class_automation_studio_v1(uuid,uuid,text,text[])','public.delete_recurring_class_series_atomic(uuid,uuid,uuid)','public.disable_billing_payer_autopay_v1(uuid,uuid,uuid,timestamp with time zone,text)','public.enforce_operational_alert_sent_receipt()','public.enqueue_missed_class_automations_v1(integer,text[])','public.evaluate_operational_alert(text,text,bigint,integer,integer,text,text,integer,text,text,text)','public.evaluate_operational_alert(text,text,bigint,integer,integer,text,text,text,text)','public.fail_operational_alert_delivery(uuid,text,text,integer)','public.finalize_billing_invoice_retry_hash_capture_v33(bigint,text,text)','public.finalize_billing_payer_setup_projection_v1(uuid,uuid,uuid,uuid,uuid,text,text,text,integer)','public.finish_account_deletion_request(uuid,text,text,text)','public.finish_automation_test_email_preflight_v1(uuid,uuid,uuid,text)','public.finish_billing_subscription_quantity_sync(uuid,uuid,text)','public.finish_stripe_event_processing(uuid,text,text,text)','public.finish_stripe_event_processing_v2(uuid,text,text,text,text)','public.finish_student_import_run(uuid,text,text,jsonb,text)','public.follow_up_lead_atomic(uuid,uuid,uuid,uuid,jsonb)','public.get_automation_email_credential_v1(text)','public.get_automation_operation_v1(uuid,uuid,uuid)','public.get_automation_sender_status_v1(text)','public.get_automation_test_email_v1(uuid,uuid,uuid)','public.get_automation_workflow_run_v1(uuid,uuid,uuid)','public.get_automation_workflow_simulation_facts_v1(uuid,uuid,uuid,jsonb,jsonb)','public.get_automation_workflow_v1(uuid,uuid,uuid)','public.get_belt_test_event_v1(uuid,uuid,uuid)','public.get_belt_test_recipient_v1(uuid,uuid,uuid,uuid)','public.get_lead_trial_appointment_v1(uuid,uuid,uuid,uuid)','public.get_missed_class_automation_activity_v1(uuid,uuid,integer)','public.get_missed_class_automation_rule_v1(uuid,uuid)','public.get_workflow_email_plan_v1(uuid,uuid,uuid,text,text,text[],text,text)','public.heartbeat_student_import_run(uuid,text)','public.import_student_row_atomic(jsonb,uuid,uuid,text,integer,text,text,text,text,uuid[])','public.invalidate_core_checkout_on_comp_grant()','public.koaryu_release_schema_preflight()','public.koaryu_release_schema_preflight_v10()','public.koaryu_release_schema_preflight_v11()','public.koaryu_release_schema_preflight_v12()','public.koaryu_release_schema_preflight_v13()','public.koaryu_release_schema_preflight_v14()','public.koaryu_release_schema_preflight_v15()','public.koaryu_release_schema_preflight_v16()','public.koaryu_release_schema_preflight_v17()','public.koaryu_release_schema_preflight_v18()','public.koaryu_release_schema_preflight_v19()','public.koaryu_release_schema_preflight_v2()','public.koaryu_release_schema_preflight_v20()','public.koaryu_release_schema_preflight_v21()','public.koaryu_release_schema_preflight_v22()','public.koaryu_release_schema_preflight_v23()','public.koaryu_release_schema_preflight_v24()','public.koaryu_release_schema_preflight_v25()','public.koaryu_release_schema_preflight_v26()','public.koaryu_release_schema_preflight_v27()','public.koaryu_release_schema_preflight_v28()','public.koaryu_release_schema_preflight_v29()','public.koaryu_release_schema_preflight_v3()','public.koaryu_release_schema_preflight_v30()','public.koaryu_release_schema_preflight_v31()','public.koaryu_release_schema_preflight_v32()','public.koaryu_release_schema_preflight_v33()','public.koaryu_release_schema_preflight_v34()','public.koaryu_release_schema_preflight_v35()','public.koaryu_release_schema_preflight_v36()','public.koaryu_release_schema_preflight_v37()','public.koaryu_release_schema_preflight_v38()','public.koaryu_release_schema_preflight_v39()','public.koaryu_release_schema_preflight_v4()','public.koaryu_release_schema_preflight_v5()','public.koaryu_release_schema_preflight_v6()','public.koaryu_release_schema_preflight_v7()','public.koaryu_release_schema_preflight_v8()','public.koaryu_release_schema_preflight_v9()','public.list_automation_workflow_runs_v1(uuid,uuid,uuid,integer,jsonb)','public.list_automation_workflows_v1(uuid,uuid,integer,jsonb)','public.list_belt_test_events_v1(uuid,uuid,integer,jsonb)','public.list_belt_test_recipients_v1(uuid,uuid,uuid,integer,jsonb)','public.list_billing_enrollment_scheduled_transitions_v1(uuid,uuid[])','public.list_billing_payers_v1(uuid,uuid,date)','public.list_lead_trial_appointments_v1(uuid,uuid,uuid,integer,jsonb)','public.list_student_ids_for_program_filter(uuid,uuid,text,text,text,text,integer,integer)','public.list_student_roster(uuid,text,text,uuid,integer,text,date,text,text,integer,text,uuid,text)','public.load_connect_onboarding_bootstrap_recovery_context(uuid,text)','public.mark_billing_enrollment_due_pre_provider_reconciliation_v1(uuid,uuid,uuid,bigint,text,text)','public.mark_billing_enrollment_due_readback_reconciliation_v1(uuid,uuid,uuid,bigint,text,text)','public.mark_billing_payer_setup_reconciliation_v1(uuid,uuid,text,text,text,integer,text)','public.mark_billing_provider_recovery_reconciliation_v2(uuid,uuid,uuid,text,text,text,text,integer,uuid,bigint,text)','public.materialize_recurring_class_sessions(uuid,date,date)','public.mutate_belt_test_event_v1(uuid,uuid,uuid,uuid,bigint,jsonb)','public.mutate_lead_trial_appointment_v1(uuid,uuid,uuid,uuid,uuid,bigint,jsonb)','public.mutate_student_program_membership_atomic(uuid,uuid,uuid,text,uuid,jsonb)','public.mutate_students_bulk_atomic(uuid,uuid,uuid[],text,text[],text[],text)','public.operational_alert_heartbeats(text)','public.operational_alert_metric_counts()','public.preflight_connect_onboarding_bootstrap_begin(uuid,text)','public.preflight_connect_onboarding_bootstrap_resume(uuid,text)','public.prepare_billing_payer_setup_request_v1(uuid,uuid,uuid,uuid,uuid,text,text,integer,uuid,bigint,timestamp with time zone)','public.prepare_connect_onboarding_bootstrap_atomic(uuid,text,integer,jsonb,text,text,text,text)','public.prepare_student_import_belts_v1(uuid,uuid,text,uuid,uuid,jsonb,boolean)','public.prepare_student_import_program_v1(uuid,uuid,text,text,uuid,text,uuid,boolean,boolean)','public.preserve_billing_invoice_retry_operation_created_at()','public.preserve_studio_comp_provenance()','public.prevent_operational_alert_append_only_mutation()','public.preview_missed_class_automation_v1(uuid,uuid,integer)','public.process_automation_workflow_occurrences_v1(integer)','public.publish_core_checkout_atomic(uuid,uuid,bigint,text,text,bigint)','public.read_active_billing_payer_payment_consent_v1(uuid,uuid,text,text,integer)','public.read_billing_enrollment_item_schedule_identity_v31(uuid,uuid)','public.read_billing_enrollment_transition_by_key_v1(uuid,uuid,text,text,text,uuid)','public.read_billing_payer_setup_request_v1(uuid,uuid,uuid,text,integer)','public.read_billing_payer_setup_webhook_v1(uuid,text,text,integer)','public.read_billing_provider_operation_step_plan_v1(uuid,uuid,uuid,text,text,text,text,integer,text)','public.read_billing_provider_operation_v1(uuid,uuid,uuid,text,text,text,text,integer)','public.read_stripe_rehearsal_local_evidence_v1(uuid,text,integer,timestamp with time zone,timestamp with time zone,jsonb,uuid[],uuid,text[],text[])','public.reassign_memberships_before_belt_rank_delete()','public.recompute_billing_invoice_external_payment_totals(uuid,uuid)','public.recompute_billing_payer_balance_v1(uuid,uuid)','public.record_connect_onboarding_bootstrap_initial_link_response(uuid,uuid,text,integer,text,text,text,text,text,text)','public.record_core_checkout_compensation_required_atomic(uuid,text,text,bigint,text,boolean)','public.record_external_payment_v1(uuid,uuid,uuid,integer,text,text,text,text,text)','public.record_operational_alert_heartbeat(text,text,text)','public.record_stripe_live_billing_reconciliation_checkpoint(text,integer,integer,integer,integer,integer,integer,timestamp with time zone,timestamp with time zone,integer,integer,boolean,boolean,timestamp with time zone,text,text,uuid,text)','public.record_stripe_live_billing_reconciliation_checkpoint_v2(jsonb,timestamp with time zone,text,text,uuid,text)','public.record_stripe_live_billing_reconciliation_checkpoint_v3(jsonb,timestamp with time zone,text,text,uuid,text)','public.record_student_demotion(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text)','public.record_student_demotion_v2(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,uuid)','public.record_student_promotion(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text)','public.record_student_promotion_v2(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,uuid)','public.record_student_rank_transition_v3(uuid,uuid,uuid,uuid,uuid,uuid,text,text,uuid)','public.register_billing_provider_operation_step_plan_v1(uuid,uuid,uuid,text,text,text,text,integer,uuid,bigint,text,integer,jsonb)','public.reject_billing_autopay_activation_without_provider_v31(uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,integer,uuid,text,text,bigint)','public.reject_billing_payer_setup_without_provider_v1(uuid,uuid,uuid,uuid,uuid,text,text,text,integer,uuid,bigint,bigint)','public.reject_billing_provider_recovery_source_drift_v2(uuid,uuid,uuid,text,text,text,text,integer,uuid,bigint,text)','public.release_billing_invoice_retry_preread_lease_v32(uuid,uuid,uuid,text,text,text,integer,uuid,bigint)','public.release_billing_invoice_retry_preread_lease_v33(uuid,uuid,uuid,text,text,text,integer,uuid,bigint,text)','public.release_core_checkout_reservation_atomic(uuid,uuid,bigint)','public.reserve_billing_autopay_activation_v31(uuid,uuid,uuid,uuid,uuid,text,integer,text,text,numeric)','public.reserve_core_checkout_atomic(uuid)','public.reserve_core_checkout_v2_atomic(uuid)','public.reset_stripe_connect_account_atomic_v58(uuid,uuid,text,integer)','public.resolve_workflow_email_without_attempt_v1(uuid,uuid,uuid,text,text,text,text[],text,text,jsonb)','public.revoke_belt_test_recipient_v1(uuid,uuid,uuid,uuid,uuid,bigint)','public.revoke_billing_enrollment_transition_v1(uuid,uuid,uuid,bigint,text,text,text,uuid,integer)','public.revoke_billing_enrollment_transition_v29(uuid,uuid,uuid,bigint,text,text,text,uuid,integer)','public.revoke_billing_payer_payment_consent_v1(uuid,uuid,uuid,text,integer,timestamp with time zone,uuid,text,text)','public.save_automation_email_credential_v1(text,bigint,text)','public.save_automation_workflow_v1(uuid,uuid,uuid,uuid,bigint,text,text,jsonb,jsonb)','public.save_missed_class_automation_rule_v1(uuid,uuid,bigint,boolean,integer,text,text,text)','public.schedule_window_read(uuid,date,date,text)','public.set_stripe_connect_account_exclusion_atomic(text,boolean,text,uuid,text)','public.set_student_is_minor()','public.set_studio_comp_atomic(uuid,boolean,text,uuid,text,boolean)','public.set_studio_comp_v2_atomic(uuid,boolean,text,uuid,text,boolean)','public.set_studio_live_billing_authorization_atomic(uuid,text,boolean,timestamp with time zone,text,uuid,text,text)','public.set_studio_live_billing_authorization_operations_v1(uuid,text,boolean,timestamp with time zone,text,uuid,text[],text,text)','public.set_studio_live_billing_authorization_scope_v3(uuid,text,boolean,timestamp with time zone,text,uuid,text,text)','public.settle_automation_sender_preparation_v1(uuid,uuid,jsonb)','public.settle_automation_test_email_v1(uuid,uuid,uuid,uuid,jsonb)','public.settle_missed_class_automation_v1(uuid,uuid,text,text,text,integer)','public.settle_missed_class_automation_v2(uuid,uuid,uuid,jsonb)','public.settle_workflow_email_v1(uuid,uuid,uuid,jsonb)','public.snapshot_promotion_rank_identity()','public.soft_delete_student_atomic(uuid,uuid,uuid)','public.start_due_billing_enrollment_transition_v1(uuid,uuid,bigint,integer)','public.student_business_date(uuid)','public.studio_live_billing_supported_operations_v58(uuid,text)','public.sum_email_usage_for_period(uuid,timestamp with time zone,timestamp with time zone)','public.support_triage_digest(integer)','public.support_triage_list_tickets(text[],text[],text[],integer)','public.support_triage_update_ticket(uuid,text,text,jsonb)','public.suppress_missed_class_automation_v1(text)','public.sync_belt_ladder_ranks(uuid,uuid,text,jsonb)','public.sync_belt_ladder_ranks_internal(uuid,uuid,text,jsonb)','public.sync_belt_ladder_ranks_v2(uuid,uuid,uuid,uuid,text,jsonb)','public.sync_primary_student_rank_from_membership()','public.transition_billing_enrollment_transition_v1(uuid,uuid,uuid,bigint,uuid,bigint,text,text)','public.transition_billing_enrollment_transition_v29(uuid,uuid,uuid,bigint,uuid,bigint,text,text)','public.transition_billing_provider_operation_step_v1(uuid,uuid,uuid,text,text,text,text,integer,text,integer,text,text,text,text,uuid,bigint,text,text,text,text,text,text,text)','public.transition_billing_provider_operation_v1(uuid,uuid,uuid,text,text,text,text,integer,uuid,bigint,text,text,text,text,text,text,text,text,text)','public.update_lead_atomic(uuid,uuid,uuid,jsonb)','public.update_updated_at_column()','public.validate_attendance_program_integrity()','public.validate_automation_workflow_v1(uuid,uuid,jsonb,jsonb)','public.validate_billing_adjustment_refs()','public.validate_billing_dispute_refs()','public.validate_billing_invoice_item_refs()','public.validate_billing_invoice_refs()','public.validate_billing_payer_guardian()','public.validate_billing_payment_refs()','public.validate_billing_plan_program()','public.validate_billing_refund_refs()','public.validate_billing_subscription_refs()','public.validate_class_session_program_integrity()','public.validate_class_template_program_integrity()','public.validate_lead_program_integrity()','public.validate_student_billing_enrollment()','public.validate_student_birth_date()','public.validate_student_guardian_tenant_integrity()','public.validate_student_profile_tenant_integrity()','public.validate_student_program_membership()','public.write_billing_plan_v1(uuid,uuid,uuid,jsonb,uuid[])','public.write_student_profile_atomic(uuid,uuid,uuid,jsonb,uuid[],jsonb,boolean,text)','public.write_student_profile_v2_atomic(uuid,uuid,uuid,jsonb,uuid[],jsonb,boolean,text)']::TEXT[] THEN
        v_failures:=array_append(v_failures,'timezone_functions_v59');
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='koaryu_release_schema_preflight_v40') <> 1
       OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure('public.koaryu_release_schema_preflight_v40()')
          AND p.proowner='postgres'::REGROLE AND p.prosecdef AND p.provolatile='s'
          AND p.proretset AND p.proconfig=ARRAY['search_path=pg_catalog','TimeZone=UTC','DateStyle=ISO, YMD','IntervalStyle=postgres']::TEXT[]
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                    a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
             = '[["postgres","postgres","EXECUTE",false],["service_role","postgres","EXECUTE",false]]'::JSONB) THEN
        v_failures:=array_append(v_failures,'preflight_security_v59');
    END IF;
 RETURN QUERY SELECT cardinality(v_failures) = 0,
        v_count, v_head, COALESCE(v_pending, ARRAY[]::TEXT[]), v_failures,
        'release-db-attestation-v59'::TEXT;
END;
$function$;

CREATE OR REPLACE FUNCTION public.koaryu_release_schema_preflight_v39()
RETURNS TABLE (ready BOOLEAN, migration_count INTEGER, migration_head TEXT,
    pending_versions TEXT[], security_failures TEXT[], manifest_version TEXT)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE v RECORD;
BEGIN
    SELECT * INTO v FROM public.koaryu_release_schema_preflight_v40();
    IF v.ready IS TRUE AND v.migration_count = 154 AND v.migration_head = '20261014083106'
       AND v.manifest_version = 'release-db-attestation-v59'
       AND cardinality(v.security_failures) = 0 AND cardinality(v.pending_versions) = 70
       AND v.pending_versions[cardinality(v.pending_versions)] = '20261014083106' THEN
        RETURN QUERY SELECT TRUE, 153, '20261013013243'::TEXT,
            v.pending_versions[1:cardinality(v.pending_versions)-1],
            ARRAY[]::TEXT[], 'release-db-attestation-v58'::TEXT;
        RETURN;
    END IF;
    RETURN QUERY SELECT FALSE, v.migration_count, v.migration_head,
        v.pending_versions, v.security_failures, 'release-db-attestation-v58'::TEXT;
END;
$function$;

ALTER FUNCTION public.koaryu_release_schema_preflight_v40() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.koaryu_release_schema_preflight_v40() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.koaryu_release_schema_preflight_v40() TO service_role;

ALTER FUNCTION public.koaryu_release_schema_preflight_v39() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.koaryu_release_schema_preflight_v39() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.koaryu_release_schema_preflight_v39() TO service_role;

DO $installed$
DECLARE v RECORD;
BEGIN
    SELECT * INTO v FROM public.koaryu_release_schema_preflight_v40();
    IF v.migration_count IS DISTINCT FROM 153 OR v.migration_head IS DISTINCT FROM '20261013013243'
       OR v.security_failures IS DISTINCT FROM ARRAY['migration_history_v59',
           'migration_history_sequence_v31','migration_history_sequence_v30']::TEXT[] THEN
        RAISE EXCEPTION 'V59 installed contracts did not verify before history registration: %',row_to_json(v);
    END IF;
END;
$installed$;
