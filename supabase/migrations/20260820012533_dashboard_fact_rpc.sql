-- WS2 dashboard aggregate pilot. This is an additive fact read only: the
-- FastAPI dashboard endpoint deliberately does not call it yet.

CREATE FUNCTION public.dashboard_summary_facts(
    p_studio_id UUID,
    p_visibility TEXT,
    p_timezone_name TEXT,
    p_local_date DATE,
    p_formula_version TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $dashboard_summary_facts$
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
        WHEN EXISTS (
            SELECT 1
            FROM pg_catalog.pg_timezone_names AS timezone_name
            WHERE timezone_name.name = p_timezone_name
        ) THEN p_timezone_name
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
        SELECT attendance.student_id,
               MAX(attendance.checked_in_at) AS last_checked_in_at
        FROM public.attendance AS attendance
        WHERE attendance.studio_id = p_studio_id
          AND attendance.status <> 'absent'
          AND attendance.checked_in_at >= (
              (v_lookback_90::TIMESTAMP AT TIME ZONE v_timezone)
          )
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
                      (attendance_last.last_checked_in_at AT TIME ZONE v_timezone)::DATE,
                      student.start_date
                  ) <= p_local_date - 14
            )::INTEGER AS watch_14,
            COUNT(*) FILTER (
                WHERE student.status IN ('active', 'trialing', 'paused')
                  AND NOT student.on_hold_now
                  AND COALESCE(
                      (attendance_last.last_checked_in_at AT TIME ZONE v_timezone)::DATE,
                      student.start_date
                  ) <= p_local_date - 30
            )::INTEGER AS watch_30,
            COUNT(*) FILTER (
                WHERE student.status IN ('active', 'trialing', 'paused')
                  AND NOT student.on_hold_now
                  AND COALESCE(
                      (attendance_last.last_checked_in_at AT TIME ZONE v_timezone)::DATE,
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
            (
                (SELECT COUNT(*) FROM public.billing_payers AS payer WHERE payer.studio_id = p_studio_id AND payer.billing_status IN ('past_due', 'failed', 'unpaid'))
                + (SELECT COUNT(*) FROM public.billing_invoices AS invoice WHERE invoice.studio_id = p_studio_id AND invoice.status = 'uncollectible')
                + (SELECT COUNT(*) FROM public.billing_invoices AS invoice WHERE invoice.studio_id = p_studio_id AND invoice.status = 'open' AND invoice.due_date <= p_local_date)
            )::INTEGER AS payment_attention_count,
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
$dashboard_summary_facts$;

ALTER FUNCTION public.dashboard_summary_facts(UUID, TEXT, TEXT, DATE, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.dashboard_summary_facts(UUID, TEXT, TEXT, DATE, TEXT)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dashboard_summary_facts(UUID, TEXT, TEXT, DATE, TEXT)
TO service_role;

-- Current-head release evidence is versioned alongside the additive RPC. The
-- historical V17/V18 readiness functions remain unchanged for replay and
-- predecessor diagnosis.
CREATE FUNCTION private.koaryu_release_critical_surface_manifest_v18()
RETURNS TEXT
LANGUAGE plpgsql
SECURITY INVOKER
STABLE
SET search_path = pg_catalog
AS $critical_surface_manifest_v18$
DECLARE
    v_v17 TEXT;
    v_invalid INTEGER;
    v_serialized TEXT;
BEGIN
    v_v17 := private.koaryu_release_critical_surface_manifest_v17();
    v_invalid := COALESCE(NULLIF(split_part(v_v17, ':', 1), '')::INTEGER, 1);

    WITH function_state AS (
        SELECT
            function_state_row.oid,
            COALESCE(owner.rolname, '') AS owner_name,
            COALESCE(function_state_row.provolatile::TEXT, '') AS volatility,
            COALESCE(function_state_row.prosecdef::TEXT, '') AS security_definer,
            COALESCE(array_to_string(function_state_row.proconfig, ','), '') AS configuration,
            has_function_privilege('service_role', function_state_row.oid, 'EXECUTE') AS service_execute,
            has_function_privilege('anon', function_state_row.oid, 'EXECUTE') AS anon_execute,
            has_function_privilege('authenticated', function_state_row.oid, 'EXECUTE') AS authenticated_execute,
            EXISTS (
                SELECT 1
                FROM aclexplode(COALESCE(function_state_row.proacl, acldefault('f', function_state_row.proowner))) AS privilege
                WHERE privilege.privilege_type = 'EXECUTE'
                  AND privilege.grantee <> function_state_row.proowner
                  AND NOT (
                      privilege.grantee = (SELECT oid FROM pg_roles WHERE rolname = 'service_role')
                      AND NOT privilege.is_grantable
                  )
            ) AS unexpected_execute_grant,
            COALESCE(pg_get_functiondef(function_state_row.oid), '') AS definition
        FROM pg_proc AS function_state_row
        LEFT JOIN pg_roles AS owner ON owner.oid = function_state_row.proowner
        WHERE function_state_row.oid = to_regprocedure('public.dashboard_summary_facts(uuid,text,text,date,text)')
    ), serialized AS (
        SELECT
            'f:public.dashboard_summary_facts(uuid,text,text,date,text):' ||
            definition || ':' || owner_name || ':' || volatility || ':' || security_definer || ':' ||
            configuration || ':' || service_execute::TEXT || ':' || anon_execute::TEXT || ':' ||
            authenticated_execute::TEXT AS value,
            (
                oid IS NULL
                OR owner_name <> 'postgres'
                OR volatility <> 's'
                OR security_definer <> 'false'
                OR configuration <> 'search_path=pg_catalog'
                OR service_execute IS DISTINCT FROM true
                OR anon_execute
                OR authenticated_execute
                OR unexpected_execute_grant
            )::INTEGER AS invalid
        FROM function_state
    )
    SELECT
        v_invalid + COALESCE(SUM(invalid), 0)::INTEGER,
        'v17:' || COALESCE(v_v17, '') || '|' || COALESCE(string_agg(value, '|' ORDER BY value COLLATE "C"), '')
    INTO v_invalid, v_serialized
    FROM serialized;

    RETURN v_invalid::TEXT || ':' || encode(
        extensions.digest(convert_to(v_serialized, 'UTF8'), 'sha256'),
        'hex'
    );
END;
$critical_surface_manifest_v18$;

ALTER FUNCTION private.koaryu_release_critical_surface_manifest_v18() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.koaryu_release_critical_surface_manifest_v18()
FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.koaryu_release_schema_preflight_v4()
RETURNS TABLE (
    ready BOOLEAN,
    migration_count INTEGER,
    migration_head TEXT,
    pending_versions TEXT[],
    security_failures TEXT[],
    manifest_version TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog
AS $schema_preflight_v4$
DECLARE
    v_count INTEGER;
    v_head TEXT;
    v_pending TEXT[];
    v_failures TEXT[] := ARRAY[]::TEXT[];
BEGIN
    SELECT count(*)::INTEGER, max(version),
           array_agg(version ORDER BY version COLLATE "C") FILTER (WHERE version >= '20260727100000')
    INTO v_count, v_head, v_pending
    FROM supabase_migrations.schema_migrations;

    IF v_count <> 112 OR v_head <> '20260820012533' THEN
        v_failures := array_append(v_failures, 'migration_history_v19');
    END IF;
    IF COALESCE(v_pending, ARRAY[]::TEXT[]) IS DISTINCT FROM ARRAY[
        '20260727100000','20260727110000','20260801050957','20260801060000',
        '20260801070000','20260801080000','20260801090000','20260801091000',
        '20260801092000','20260801093000','20260801094000','20260801105313',
        '20260801112153','20260801115044','20260801123112','20260801131844',
        '20260814043325','20260814103046','20260814105424','20260814114500',
        '20260814152000','20260814170000','20260814183000','20260814200000',
        '20260814213000','20260815220402','20260816012723','20260820012533'
    ]::TEXT[] THEN
        v_failures := array_append(v_failures, 'migration_history_sequence_v19');
    END IF;
    IF private.koaryu_release_operational_manifest_v7()
       <> 'd621d0bfa18b21571132a51108dd418e66996944fb7723bd3aeb624da7fe0e79' THEN
        v_failures := array_append(v_failures, 'operational_semantic_acl_manifest_v7');
    END IF;
    IF private.koaryu_release_starting_belt_manifest_v9()
       <> '0:9c1c8ea5e7ab6ce0d34d5654d17b056faba89234f0f2b945ff147c0462711be9' THEN
        v_failures := array_append(v_failures, 'starting_belt_invariant_manifest_v9');
    END IF;
    IF private.koaryu_release_student_rank_writer_manifest_v13()
       <> '0:27cdc692d92fb49f696521e7ab6f3d0b7717c30a232ba6ce4ba057df9e5b30f7' THEN
        v_failures := array_append(v_failures, 'student_rank_writer_manifest_v13');
    END IF;
    IF private.koaryu_release_critical_surface_manifest_v18()
       <> '0:6c7f4eb2d78e203c0054fd0701398c373089e3409473e7f123ee90965ff161b1' THEN
        v_failures := array_append(v_failures, 'critical_surface_manifest_v18');
    END IF;

    RETURN QUERY SELECT cardinality(v_failures) = 0, v_count, v_head,
        COALESCE(v_pending, ARRAY[]::TEXT[]), v_failures, 'release-db-attestation-v19';
END;
$schema_preflight_v4$;

ALTER FUNCTION public.koaryu_release_schema_preflight_v4() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.koaryu_release_schema_preflight_v4()
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.koaryu_release_schema_preflight_v4() TO service_role;

-- Keep the deployed V7-shaped compatibility response available at the current
-- head while binding its readiness proof to the versioned V19 preflight.
CREATE OR REPLACE FUNCTION public.koaryu_release_schema_preflight_v2()
RETURNS TABLE (
    ready BOOLEAN,
    migration_count INTEGER,
    migration_head TEXT,
    pending_versions TEXT[],
    security_failures TEXT[],
    manifest_version TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog
AS $schema_preflight_v2_current$
DECLARE
    v_current_head RECORD;
    v_current RECORD;
    v_failures TEXT[];
BEGIN
    SELECT * INTO v_current_head
    FROM public.koaryu_release_schema_preflight_v4();
    IF NOT v_current_head.ready THEN
        RETURN QUERY SELECT
            FALSE,
            v_current_head.migration_count,
            v_current_head.migration_head,
            v_current_head.pending_versions,
            v_current_head.security_failures,
            'release-db-attestation-v7'::TEXT;
        RETURN;
    END IF;

    SELECT * INTO v_current
    FROM public.koaryu_release_schema_preflight_v3();

    -- V2 remains the deployed V7-shaped compatibility surface. Its
    -- historical V18 head and V17 manifest failures are expected after the
    -- additive current-head pilot; all other failures remain actionable.
    v_failures := array_remove(
        array_remove(
            array_remove(COALESCE(v_current.security_failures, ARRAY[]::TEXT[]), 'migration_history_v18'),
            'migration_history_sequence_v18'
        ),
        'critical_surface_manifest_v17'
    );

    IF cardinality(v_failures) = 0 THEN
        RETURN QUERY SELECT
            TRUE,
            100,
            '20260801131844'::TEXT,
            ARRAY[
                '20260727100000','20260727110000','20260801050957','20260801060000',
                '20260801070000','20260801080000','20260801090000','20260801091000',
                '20260801092000','20260801093000','20260801094000','20260801105313',
                '20260801112153','20260801115044','20260801123112','20260801131844'
            ]::TEXT[],
            ARRAY[]::TEXT[],
            'release-db-attestation-v7'::TEXT;
        RETURN;
    END IF;

    RETURN QUERY SELECT
        FALSE,
        v_current.migration_count,
        v_current.migration_head,
        v_current.pending_versions,
        COALESCE(v_failures, ARRAY['v18_compatibility_preflight']::TEXT[]),
        'release-db-attestation-v7'::TEXT;
END;
$schema_preflight_v2_current$;

ALTER FUNCTION public.koaryu_release_schema_preflight_v2() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.koaryu_release_schema_preflight_v2()
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.koaryu_release_schema_preflight_v2() TO service_role;
