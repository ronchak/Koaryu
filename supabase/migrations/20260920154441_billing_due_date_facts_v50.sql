-- Classify invoices from their due dates without rewriting retained balances.
DO $predecessor$
DECLARE v RECORD;
BEGIN
    IF encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(
        pg_catalog.to_regprocedure('public.koaryu_release_schema_preflight_v30()')),'UTF8'),'sha256'),'hex')
        IS DISTINCT FROM '018d8a0db54391d88e3ba205525f1901d5c60e6e76099c907cc1391ee51023f4' THEN
        RAISE EXCEPTION 'V50 requires the reviewed full V49 readiness definition.';
    END IF;
    SELECT * INTO v FROM public.koaryu_release_schema_preflight_v30();
    IF v.ready IS DISTINCT FROM TRUE OR v.migration_count IS DISTINCT FROM 144
       OR v.migration_head IS DISTINCT FROM '20260920052705'
       OR v.manifest_version IS DISTINCT FROM 'release-db-attestation-v49'
       OR cardinality(v.security_failures) IS DISTINCT FROM 0
       OR cardinality(v.pending_versions) IS DISTINCT FROM 60
       OR v.pending_versions[60] IS DISTINCT FROM '20260920052705' THEN
        RAISE EXCEPTION 'V50 requires a fully verified V49 predecessor.';
    END IF;
END;
$predecessor$;

-- The payer balance is a stored compatibility snapshot; reads classify invoices today.
CREATE FUNCTION public.billing_invoice_collection_facts_v1(
    p_studio_id UUID,
    p_payer_id UUID DEFAULT NULL,
    p_today DATE DEFAULT NULL
)
RETURNS TABLE (
    invoice_id UUID, payer_id UUID, status TEXT,
    balance_cents BIGINT, overdue_balance_cents BIGINT, uncollectible_balance_cents BIGINT
)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
AS $function$
WITH business_day AS (
    SELECT COALESCE(p_today,
        (CURRENT_TIMESTAMP AT TIME ZONE COALESCE(NULLIF(studio.timezone, ''), 'UTC'))::DATE
    ) AS today
    FROM public.studios AS studio WHERE studio.id = p_studio_id
), amounts AS (
    SELECT invoice.id, invoice.payer_id, invoice.status, invoice.due_date,
        GREATEST(0::BIGINT, invoice.amount_remaining_cents::BIGINT) AS amount
    FROM public.billing_invoices AS invoice
    WHERE invoice.studio_id = p_studio_id
      AND (p_payer_id IS NULL OR invoice.payer_id = p_payer_id)
      AND invoice.status IN ('draft', 'open', 'uncollectible', 'partially_refunded')
)
SELECT amounts.id, amounts.payer_id, amounts.status, amounts.amount,
    CASE WHEN amounts.status IN ('open', 'partially_refunded')
              AND amounts.due_date < business_day.today THEN amounts.amount ELSE 0::BIGINT END,
    CASE WHEN amounts.status = 'uncollectible' THEN amounts.amount ELSE 0::BIGINT END
FROM amounts CROSS JOIN business_day;
$function$;

CREATE FUNCTION public.billing_payer_balance_facts_v1(
    p_studio_id UUID,
    p_payer_id UUID DEFAULT NULL,
    p_today DATE DEFAULT NULL
)
RETURNS TABLE (
    payer_id UUID,
    balance_cents BIGINT,
    overdue_balance_cents BIGINT,
    uncollectible_balance_cents BIGINT,
    billing_status TEXT
)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
AS $function$
WITH balances AS (
    SELECT payer.id, payer.billing_status AS stored_status,
        COALESCE(SUM(invoice.balance_cents), 0)::BIGINT AS balance,
        COALESCE(SUM(invoice.overdue_balance_cents), 0)::BIGINT AS overdue,
        COALESCE(SUM(invoice.uncollectible_balance_cents), 0)::BIGINT AS uncollectible
    FROM public.billing_payers AS payer
    LEFT JOIN public.billing_invoice_collection_facts_v1(p_studio_id,p_payer_id,p_today) AS invoice
        ON invoice.payer_id = payer.id
    WHERE payer.studio_id = p_studio_id
      AND (p_payer_id IS NULL OR payer.id = p_payer_id)
    GROUP BY payer.id, payer.billing_status
)
SELECT id, balance, overdue, uncollectible,
    CASE
        WHEN overdue > 0 THEN 'past_due'
        WHEN stored_status = 'failed' THEN 'failed'
        WHEN balance > uncollectible THEN 'outstanding'
        WHEN uncollectible > 0 THEN 'uncollectible'
        WHEN stored_status IN ('past_due', 'upcoming') THEN 'current'
        ELSE stored_status
    END
FROM balances;
$function$;

CREATE FUNCTION public.billing_attention_count_v1(p_studio_id UUID, p_today DATE DEFAULT NULL)
RETURNS INTEGER
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
AS $function$
WITH invoice_facts AS MATERIALIZED (
    SELECT * FROM public.billing_invoice_collection_facts_v1(p_studio_id,NULL,p_today)
)
-- Dashboard counts tuition issues, including invoices whose payer is not yet known.
SELECT (
    (SELECT COUNT(*) FROM public.billing_payer_balance_facts_v1(p_studio_id,NULL,p_today)
        WHERE billing_status IN ('past_due','failed','unpaid'))
    + (SELECT COUNT(*) FROM invoice_facts WHERE status='uncollectible')
    + (SELECT COUNT(*) FROM invoice_facts WHERE overdue_balance_cents>0)
)::INTEGER;
$function$;

CREATE FUNCTION public.list_billing_payers_v1(
    p_studio_id UUID,
    p_payer_id UUID DEFAULT NULL,
    p_today DATE DEFAULT NULL
)
RETURNS SETOF JSONB
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
AS $function$
SELECT pg_catalog.to_jsonb(payer) || (pg_catalog.to_jsonb(facts) - 'payer_id')
FROM public.billing_payers AS payer
JOIN public.billing_payer_balance_facts_v1(p_studio_id, p_payer_id, p_today) AS facts
    ON facts.payer_id = payer.id
WHERE payer.studio_id = p_studio_id
ORDER BY payer.display_name, payer.id;
$function$;

CREATE OR REPLACE FUNCTION public.recompute_billing_payer_balance_v1(
    p_studio_id UUID,
    p_payer_id UUID
)
RETURNS VOID
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE
    v_balance BIGINT;
    v_overdue BIGINT;
BEGIN
    IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
        RAISE EXCEPTION USING ERRCODE = '25001',
            MESSAGE = 'payer_balance_requires_read_committed';
    END IF;

    -- The invoice snapshot follows the payer lock, including after a lock wait.
    PERFORM 1 FROM public.billing_payers
    WHERE id = p_payer_id AND studio_id = p_studio_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RETURN;
    END IF;

    SELECT facts.balance_cents, facts.overdue_balance_cents
    INTO v_balance, v_overdue
    FROM public.billing_payer_balance_facts_v1(p_studio_id, p_payer_id) AS facts;

    -- Old callers still understand these statuses. Current reads carry richer facts.
    UPDATE public.billing_payers
    SET balance_cents = v_balance,
        billing_status = CASE WHEN v_overdue > 0 THEN 'past_due' ELSE 'current' END
    WHERE id = p_payer_id AND studio_id = p_studio_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.billing_landing_aggregates(
    p_studio_id UUID, p_period_start TIMESTAMPTZ, p_period_end TIMESTAMPTZ
)
RETURNS JSONB LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
AS $function$
WITH payer_balances AS MATERIALIZED (
    SELECT * FROM public.billing_payer_balance_facts_v1(p_studio_id)
)
SELECT jsonb_build_object(
 'active_student_count',(SELECT count(*) FROM public.students WHERE studio_id=p_studio_id AND status='active' AND deleted_at IS NULL),
 'active_subscription_count',(SELECT count(*) FROM public.billing_subscriptions WHERE studio_id=p_studio_id AND status IN ('active','trialing')),
 'failed_payer_count',(SELECT count(*) FROM payer_balances WHERE billing_status IN ('past_due','failed')),
 'open_invoice_amount_cents',(SELECT coalesce(sum(balance_cents),0) FROM public.billing_invoice_collection_facts_v1(p_studio_id)),
 'has_billing_plans',EXISTS(SELECT 1 FROM public.billing_plans WHERE studio_id=p_studio_id AND archived_at IS NULL),
 'has_family_accounts',EXISTS(SELECT 1 FROM public.billing_payers WHERE studio_id=p_studio_id),
 'has_student_billing',EXISTS(SELECT 1 FROM public.student_billing_enrollments WHERE studio_id=p_studio_id AND status NOT IN ('canceled','ended')),
 'has_collection_history',EXISTS(SELECT 1 FROM public.billing_invoices WHERE studio_id=p_studio_id) OR EXISTS(SELECT 1 FROM public.billing_payments WHERE studio_id=p_studio_id),
 'payment_cohort',public.billing_payment_cohort(p_studio_id,p_period_start,p_period_end));
$function$;

ALTER FUNCTION public.billing_payer_balance_facts_v1(UUID, UUID, DATE) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.billing_payer_balance_facts_v1(UUID, UUID, DATE) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.billing_payer_balance_facts_v1(UUID, UUID, DATE) TO service_role;
ALTER FUNCTION public.list_billing_payers_v1(UUID, UUID, DATE) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.list_billing_payers_v1(UUID, UUID, DATE) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_billing_payers_v1(UUID, UUID, DATE) TO service_role;
ALTER FUNCTION public.recompute_billing_payer_balance_v1(UUID, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.recompute_billing_payer_balance_v1(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recompute_billing_payer_balance_v1(UUID, UUID) TO service_role;
ALTER FUNCTION public.billing_landing_aggregates(UUID, TIMESTAMPTZ, TIMESTAMPTZ) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.billing_landing_aggregates(UUID, TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.billing_landing_aggregates(UUID, TIMESTAMPTZ, TIMESTAMPTZ) TO service_role;

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

ALTER FUNCTION public.billing_invoice_collection_facts_v1(UUID, UUID, DATE) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.billing_invoice_collection_facts_v1(UUID, UUID, DATE) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.billing_invoice_collection_facts_v1(UUID, UUID, DATE) TO service_role;
ALTER FUNCTION public.billing_attention_count_v1(UUID, DATE) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.billing_attention_count_v1(UUID, DATE) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.billing_attention_count_v1(UUID, DATE) TO service_role;

-- The existing manifest includes the Dashboard read definition.
DO $expectation$
BEGIN
    UPDATE private.koaryu_release_v31_expectations
    SET expected_sha256 = 'cf96bff39d8cd5a30cf3378222544644f733f300ea435df6de03ea5e176a9cf6'
    WHERE expectation_key = 'operational_contract_v31'
      AND expected_sha256 = '5ee824c0d79676832e8159093ce1ee4a49cd14e68821e54ca93ba5f0b32cbd7a';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'V50 operational expectation does not match its reviewed predecessor.';
    END IF;
END;
$expectation$;

CREATE FUNCTION public.koaryu_release_schema_preflight_v31()
 RETURNS TABLE(ready boolean, migration_count integer, migration_head text, pending_versions text[], security_failures text[], manifest_version text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
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
    IF v_count <> 145 OR v_head <> '20260920154441' THEN
        v_failures := array_append(v_failures, 'migration_history_v50');
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
        '20260826073728','20260826102840','20260826155911','20260826185651','20260830065627','20260830082610','20260830151714','20260831022021','20260831054918','20260902001000','20260905022339','20260908080420','20260908133504','20260908183744','20260910084231','20260910093958','20260910135133','20260910185031','20260914033337','20260914055301','20260920035023','20260920052705','20260920154441'
    ]::TEXT[] THEN
        v_failures := array_append(v_failures, 'migration_history_sequence_v31');
        v_failures := array_append(v_failures, 'migration_history_sequence_v30');
    END IF;
    IF private.koaryu_release_resource_ownership_manifest_v31()
       IS DISTINCT FROM '0:6a9ba91a4a426dd893efcd0038e37f175170abe3d5cf4dfc90a12754d2974c3c' THEN
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
       <> '0:556935a0c58b3aca9509dd355798100efb1d147830875225fd8464e9a9736136' THEN
        v_failures := array_append(v_failures, 'operational_contract_v26');
    END IF;
    IF private.koaryu_release_operational_contract_v27()
       <> '0:855d548e95744f3aede9b09986be342a935cef092ccd583e38e2febfba8fe6f6' THEN
        v_failures := array_append(v_failures, 'operational_contract_v27');
    END IF;
    IF private.koaryu_release_operational_contract_v28()
       <> '0:60fabacbd8f58f14d7ed25764fb6016ef44d6d3dfc926900793f52c1e3d7d13d' THEN
        v_failures := array_append(v_failures, 'operational_contract_v28');
    END IF;
    IF private.koaryu_release_operational_contract_v29()
       <> '0:32706cfae7047b70ee6b563048ffafa91d945bc824939e3000fa01631a459ecb' THEN
        v_failures := array_append(v_failures, 'operational_contract_v29');
    END IF;
    IF private.koaryu_release_operational_contract_v30()
       <> '0:2b57633cdd638418ca7837de9a496755e0a3620f381375657f099f6bcded8c23' THEN
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
       <> '5f7dada79a3390a33dbca4338dd8944d9b283584bc6d606526c81e8811a2b3f2' THEN
        v_failures := array_append(v_failures, 'operational_manifest_v11');
    END IF;
    IF private.koaryu_release_provider_operation_steps_manifest_v28()
       <> '0:6389e87cdb8a5db79c540f38da4fdc71aa56ed10fa5d5533518f470bf52f7dfc' THEN
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
       <> '0:3c2a6854c73a6e9c9704fabed38dac85b56eb26076add20c00ee97bed5bdc527' THEN
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
       IS DISTINCT FROM '474d0ab453b2589c2619f882ce522995881b064be9080aecabaee8088b0c6dc5' THEN
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
       <> '0:d054ae0cf5ce43ce2c241ca628e0724b5239bd696c323ba9c817b8bd21ee0eec' THEN
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
              = '9bc03bc31ae70310497bfa020088045b604e113550d79e1a9c6c754b58ec2876'
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
              = '8a735334eb60047f7dfd06490949b9286cc693eb1fd7990900aa58d8d8c9b661'
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
       IS DISTINCT FROM '0:4653774cb7fcf2f85c70dcb9284ee01d25051ebf4552520a0fa95eb929cafb9f' THEN
        v_failures := array_append(v_failures, 'import_rank_manifest_v45');
    END IF;
    IF encode(extensions.digest(convert_to(pg_get_functiondef(
        'private.koaryu_release_student_rank_writer_manifest_v13()'::REGPROCEDURE
    ), 'UTF8'), 'sha256'), 'hex')
       <> '7a1d1b52edfbda7d2ac942516bb0d2224af757a9d1278996d6225e8b94956578' THEN
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
 RETURN QUERY SELECT cardinality(v_failures) = 0,
        v_count, v_head, COALESCE(v_pending, ARRAY[]::TEXT[]), v_failures,
        'release-db-attestation-v50'::TEXT;
END;
$function$;

CREATE OR REPLACE FUNCTION public.koaryu_release_schema_preflight_v30()
RETURNS TABLE (ready BOOLEAN, migration_count INTEGER, migration_head TEXT,
    pending_versions TEXT[], security_failures TEXT[], manifest_version TEXT)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE v RECORD;
BEGIN
    SELECT * INTO v FROM public.koaryu_release_schema_preflight_v31();
    IF v.ready IS TRUE AND v.migration_count = 145 AND v.migration_head = '20260920154441'
       AND v.manifest_version = 'release-db-attestation-v50'
       AND cardinality(v.security_failures) = 0 AND cardinality(v.pending_versions) = 61
       AND v.pending_versions[cardinality(v.pending_versions)] = '20260920154441' THEN
        RETURN QUERY SELECT TRUE, 144, '20260920052705'::TEXT,
            v.pending_versions[1:cardinality(v.pending_versions)-1],
            ARRAY[]::TEXT[], 'release-db-attestation-v49'::TEXT;
        RETURN;
    END IF;
    RETURN QUERY SELECT FALSE, v.migration_count, v.migration_head,
        v.pending_versions, v.security_failures, 'release-db-attestation-v49'::TEXT;
END;
$function$;

ALTER FUNCTION public.koaryu_release_schema_preflight_v31() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.koaryu_release_schema_preflight_v31() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.koaryu_release_schema_preflight_v31() TO service_role;

ALTER FUNCTION public.koaryu_release_schema_preflight_v30() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.koaryu_release_schema_preflight_v30() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.koaryu_release_schema_preflight_v30() TO service_role;

DO $installed$
DECLARE v RECORD;
BEGIN
    SELECT * INTO v FROM public.koaryu_release_schema_preflight_v31();
    IF v.migration_count IS DISTINCT FROM 144 OR v.migration_head IS DISTINCT FROM '20260920052705'
       OR v.security_failures IS DISTINCT FROM ARRAY['migration_history_v50',
           'migration_history_sequence_v31','migration_history_sequence_v30']::TEXT[] THEN
        RAISE EXCEPTION 'V50 installed contracts did not verify before history registration: %',row_to_json(v);
    END IF;
END;
$installed$;
