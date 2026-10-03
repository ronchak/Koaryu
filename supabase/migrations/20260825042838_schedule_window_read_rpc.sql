-- Return the complete read-only Schedule projection for one bounded date
-- range. FastAPI resolves the authoritative studio before calling this
-- service-role-only function.

CREATE FUNCTION public.schedule_window_read(
    p_studio_id UUID,
    p_start_date DATE,
    p_end_date DATE,
    p_contract_version TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $schedule_window_read$
DECLARE
    v_result JSONB;
BEGIN
    IF p_contract_version IS DISTINCT FROM 'schedule-window-v1' THEN
        RAISE EXCEPTION 'Unsupported schedule window contract version: %', p_contract_version
            USING ERRCODE = '22023';
    END IF;
    IF p_studio_id IS NULL OR p_start_date IS NULL OR p_end_date IS NULL THEN
        RAISE EXCEPTION 'Schedule window studio and date range are required'
            USING ERRCODE = '22004';
    END IF;
    IF p_end_date < p_start_date THEN
        RAISE EXCEPTION 'end_date cannot be before start_date'
            USING ERRCODE = '22023';
    END IF;
    IF (p_end_date - p_start_date) + 1 > 93 THEN
        RAISE EXCEPTION 'Schedule window date range cannot exceed 93 days'
            USING ERRCODE = '22023';
    END IF;
    IF NOT EXISTS (
        SELECT 1
        FROM public.studios AS studio
        WHERE studio.id = p_studio_id
    ) THEN
        RAISE EXCEPTION 'Schedule window studio does not exist'
            USING ERRCODE = 'P0002';
    END IF;

    WITH selected_sessions AS MATERIALIZED (
        SELECT
            session.id,
            session.studio_id,
            session.template_id,
            session.name,
            session.date,
            session.start_time,
            session.end_time,
            session.instructor_id,
            session.program_id,
            session.capacity,
            session.status,
            session.notes,
            session.created_at
        FROM public.class_sessions AS session
        WHERE session.studio_id = p_studio_id
          AND session.deleted_at IS NULL
          AND session.date >= p_start_date
          AND session.date <= p_end_date
    ), attendance_counts AS MATERIALIZED (
        SELECT
            attendance.session_id,
            COUNT(*) FILTER (WHERE attendance.status <> 'absent')::INTEGER AS attendance_count
        FROM public.attendance AS attendance
        JOIN selected_sessions AS session
          ON session.id = attendance.session_id
        WHERE attendance.studio_id = p_studio_id
        GROUP BY attendance.session_id
    )
    SELECT jsonb_build_object(
        'contract_version', p_contract_version,
        'range', jsonb_build_object(
            'start_date', p_start_date,
            'end_date', p_end_date,
            'day_count', (p_end_date - p_start_date) + 1
        ),
        'templates', COALESCE((
            SELECT jsonb_agg(
                jsonb_build_object(
                    'id', template.id,
                    'studio_id', template.studio_id,
                    'name', template.name,
                    'day_of_week', template.day_of_week,
                    'start_time', template.start_time,
                    'end_time', template.end_time,
                    'start_date', template.start_date,
                    'end_date', template.end_date,
                    'instructor_id', template.instructor_id,
                    'program_id', template.program_id,
                    'capacity', template.capacity,
                    'is_active', template.is_active,
                    'created_at', template.created_at,
                    'updated_at', template.updated_at
                )
                ORDER BY template.day_of_week, template.start_time, template.id
            )
            FROM public.class_templates AS template
            WHERE template.studio_id = p_studio_id
              AND template.is_active = true
        ), '[]'::JSONB),
        'sessions', COALESCE((
            SELECT jsonb_agg(
                jsonb_build_object(
                    'id', session.id,
                    'studio_id', session.studio_id,
                    'template_id', session.template_id,
                    'name', session.name,
                    'date', session.date,
                    'start_time', session.start_time,
                    'end_time', session.end_time,
                    'instructor_id', session.instructor_id,
                    'program_id', session.program_id,
                    'capacity', session.capacity,
                    'status', session.status,
                    'notes', session.notes,
                    'created_at', session.created_at,
                    'attendance_count', COALESCE(attendance_count.attendance_count, 0)
                )
                ORDER BY session.date, session.start_time, session.id
            )
            FROM selected_sessions AS session
            LEFT JOIN attendance_counts AS attendance_count
              ON attendance_count.session_id = session.id
        ), '[]'::JSONB),
        'attendance', COALESCE((
            SELECT jsonb_agg(
                jsonb_build_object(
                    'id', attendance.id,
                    'studio_id', attendance.studio_id,
                    'session_id', attendance.session_id,
                    'student_id', attendance.student_id,
                    'status', attendance.status,
                    'checked_in_at', attendance.checked_in_at,
                    'checked_in_by', attendance.checked_in_by,
                    'is_cross_program', COALESCE(attendance.is_cross_program, false),
                    'counts_toward_eligibility', COALESCE(attendance.counts_toward_eligibility, true),
                    'override_reason', attendance.override_reason,
                    'student_name', btrim(concat_ws(
                        ' ',
                        NULLIF(COALESCE(NULLIF(student.preferred_name, ''), student.legal_first_name, ''), ''),
                        NULLIF(student.legal_last_name, '')
                    ))
                )
                ORDER BY attendance.session_id, attendance.checked_in_at, attendance.id
            )
            FROM public.attendance AS attendance
            JOIN selected_sessions AS session
              ON session.id = attendance.session_id
             AND session.status <> 'canceled'
            JOIN public.students AS student
              ON student.id = attendance.student_id
             AND student.studio_id = p_studio_id
            WHERE attendance.studio_id = p_studio_id
        ), '[]'::JSONB)
    )
    INTO v_result;

    RETURN v_result;
END;
$schedule_window_read$;

ALTER FUNCTION public.schedule_window_read(UUID, DATE, DATE, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.schedule_window_read(UUID, DATE, DATE, TEXT)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.schedule_window_read(UUID, DATE, DATE, TEXT)
TO service_role;
