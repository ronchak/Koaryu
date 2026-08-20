-- WS2 interactive roster read contract.
--
-- The endpoint calls this function once for each settled query.  The function
-- returns the page projection and its navigation metadata as one JSON value so
-- a zero-row page does not require a count or hydration query.  Cursor signing
-- and query binding are deliberately owned by the backend; the SQL receives
-- only the already-validated boundary values.

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;

CREATE INDEX IF NOT EXISTS idx_students_roster_name_keyset
    ON public.students (studio_id, legal_last_name, legal_first_name, id)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_students_roster_status_keyset
    ON public.students (studio_id, status, legal_last_name, legal_first_name, id)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_students_roster_membership_start_keyset
    ON public.students (studio_id, membership_start_date, legal_last_name, legal_first_name, id)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_students_roster_created_keyset
    ON public.students (studio_id, created_at, legal_last_name, legal_first_name, id)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_students_roster_search_trgm
    ON public.students USING gin (
        lower(
            COALESCE(legal_first_name, '') || ' ' ||
            COALESCE(legal_last_name, '') || ' ' ||
            COALESCE(preferred_name, '') || ' ' ||
            COALESCE(email, '') || ' ' ||
            COALESCE(phone, '')
        ) extensions.gin_trgm_ops
    )
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_programs_roster_search_trgm
    ON public.programs USING gin (lower(name) extensions.gin_trgm_ops);

CREATE OR REPLACE FUNCTION public.list_student_roster(
    p_studio_id UUID,
    p_search TEXT DEFAULT NULL,
    p_status TEXT DEFAULT NULL,
    p_program_id UUID DEFAULT NULL,
    p_inactivity_days INTEGER DEFAULT NULL,
    p_new_student_window TEXT DEFAULT NULL,
    p_today DATE DEFAULT NULL,
    p_sort_by TEXT DEFAULT 'name',
    p_sort_dir TEXT DEFAULT 'asc',
    p_page_size INTEGER DEFAULT 50,
    p_cursor_direction TEXT DEFAULT NULL,
    p_cursor_id UUID DEFAULT NULL,
    p_cursor_revision TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $list_student_roster$
DECLARE
    v_today DATE := COALESCE(p_today, CURRENT_DATE);
    v_search TEXT := NULLIF(BTRIM(REGEXP_REPLACE(COALESCE(p_search, ''), '[[:space:]]+', ' ', 'g')), '');
    v_result JSONB;
BEGIN
    IF p_studio_id IS NULL THEN
        RAISE EXCEPTION 'Roster studio is required' USING ERRCODE = '22004';
    END IF;
    IF p_status IS NOT NULL AND p_status NOT IN ('active', 'trialing', 'inactive', 'paused', 'canceled') THEN
        RAISE EXCEPTION 'Unsupported roster status: %', p_status USING ERRCODE = '22023';
    END IF;
    IF p_sort_by NOT IN ('name', 'status', 'membership_start_date', 'created_at') THEN
        RAISE EXCEPTION 'Unsupported roster sort: %', p_sort_by USING ERRCODE = '22023';
    END IF;
    IF p_sort_dir NOT IN ('asc', 'desc') THEN
        RAISE EXCEPTION 'Unsupported roster sort direction: %', p_sort_dir USING ERRCODE = '22023';
    END IF;
    IF p_page_size IS NULL OR p_page_size < 1 OR p_page_size > 200 THEN
        RAISE EXCEPTION 'Roster page size must be between 1 and 200' USING ERRCODE = '22023';
    END IF;
    IF p_inactivity_days IS NOT NULL AND p_inactivity_days NOT IN (14, 30, 90) THEN
        RAISE EXCEPTION 'Unsupported inactivity window: %', p_inactivity_days USING ERRCODE = '22023';
    END IF;
    IF p_new_student_window IS NOT NULL AND p_new_student_window NOT IN ('14', '30', '90', 'ytd') THEN
        RAISE EXCEPTION 'Unsupported new-student window: %', p_new_student_window USING ERRCODE = '22023';
    END IF;
    IF p_cursor_direction IS NOT NULL AND p_cursor_direction NOT IN ('next', 'previous') THEN
        RAISE EXCEPTION 'Unsupported roster cursor direction: %', p_cursor_direction USING ERRCODE = '22023';
    END IF;
    IF p_cursor_id IS NULL AND (p_cursor_direction IS NOT NULL OR p_cursor_revision IS NOT NULL) THEN
        RAISE EXCEPTION 'Roster cursor boundary is incomplete' USING ERRCODE = '22023';
    END IF;
    IF p_cursor_id IS NOT NULL AND (p_cursor_direction IS NULL OR p_cursor_revision IS NULL) THEN
        RAISE EXCEPTION 'Roster cursor boundary is incomplete' USING ERRCODE = '22023';
    END IF;
    IF (p_inactivity_days IS NOT NULL OR p_new_student_window IS NOT NULL) AND p_today IS NULL THEN
        -- The backend normally supplies the studio-local date.  CURRENT_DATE
        -- is retained for direct service-role callers and is deterministic for
        -- the duration of this statement.
        v_today := CURRENT_DATE;
    END IF;

    WITH roster_candidates AS MATERIALIZED (
        SELECT
            student.id,
            student.legal_first_name,
            student.legal_last_name,
            student.preferred_name,
            student.status,
            student.membership_start_date,
            student.created_at,
            student.hold_start_date,
            student.hold_end_date,
            (
                student.status = 'paused'
                OR (
                    student.hold_start_date IS NOT NULL
                    AND student.hold_start_date <= v_today
                    AND (student.hold_end_date IS NULL OR student.hold_end_date >= v_today)
                )
            ) AS on_hold_now,
            -- Cursor revisions are student-owned.  Filtered anchor existence
            -- below still rejects deleted or no-longer-matching boundaries;
            -- relation and attendance facts are page enrichments, not cursor
            -- candidates and therefore must not be correlated here.
            COALESCE(student.updated_at::TEXT, '') AS anchor_revision,
            CASE
                WHEN p_sort_by = 'status' THEN student.status
                WHEN p_sort_by = 'membership_start_date' THEN student.membership_start_date::TEXT
                WHEN p_sort_by = 'created_at' THEN TO_CHAR(student.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')
                ELSE NULL
            END AS primary_sort_value,
            CASE
                WHEN p_sort_by = 'status' THEN FALSE
                WHEN p_sort_by = 'membership_start_date' THEN student.membership_start_date IS NULL
                WHEN p_sort_by = 'created_at' THEN student.created_at IS NULL
                ELSE FALSE
            END AS primary_sort_is_null
        FROM public.students AS student
        WHERE student.studio_id = p_studio_id
          AND student.deleted_at IS NULL
          AND (p_status IS NULL OR student.status = p_status)
          AND (
                v_search IS NULL
                OR LOWER(
                    COALESCE(student.legal_first_name, '') || ' ' ||
                    COALESCE(student.legal_last_name, '') || ' ' ||
                    COALESCE(student.preferred_name, '') || ' ' ||
                    COALESCE(student.email, '') || ' ' ||
                    COALESCE(student.phone, '')
                ) LIKE '%' || LOWER(v_search) || '%'
                OR EXISTS (
                    SELECT 1
                    FROM public.programs AS legacy_program
                    WHERE legacy_program.id = student.program_id
                      AND legacy_program.studio_id = p_studio_id
                      AND LOWER(legacy_program.name) LIKE '%' || LOWER(v_search) || '%'
                )
                OR EXISTS (
                    SELECT 1
                    FROM public.student_program_memberships AS search_membership
                    JOIN public.programs AS search_program
                      ON search_program.id = search_membership.program_id
                     AND search_program.studio_id = p_studio_id
                    WHERE search_membership.studio_id = p_studio_id
                      AND search_membership.student_id = student.id
                      AND search_membership.status IN ('active', 'paused')
                      AND search_membership.ended_at IS NULL
                      AND LOWER(search_program.name) LIKE '%' || LOWER(v_search) || '%'
                )
          )
          AND (
                p_program_id IS NULL
                OR student.program_id = p_program_id
                OR EXISTS (
                    SELECT 1
                    FROM public.student_program_memberships AS program_membership
                    WHERE program_membership.studio_id = p_studio_id
                      AND program_membership.student_id = student.id
                      AND program_membership.program_id = p_program_id
                      AND program_membership.status IN ('active', 'paused')
                      AND program_membership.ended_at IS NULL
                )
          )
          AND (
                p_new_student_window IS NULL
                OR (
                    student.status IN ('active', 'trialing', 'paused')
                    AND COALESCE(student.membership_start_date, (student.created_at AT TIME ZONE 'UTC')::DATE) BETWEEN
                        CASE p_new_student_window
                            WHEN '14' THEN v_today - 14
                            WHEN '30' THEN v_today - 30
                            WHEN '90' THEN v_today - 90
                            WHEN 'ytd' THEN make_date(EXTRACT(YEAR FROM v_today)::INTEGER, 1, 1)
                        END
                        AND v_today
                )
          )
    ),
    -- Inactivity is the one mode that needs attendance while deciding the
    -- eligible set.  It is a single studio-scoped grouped aggregate over the
    -- already-filtered population, never one correlated history scan per
    -- student.  The one-time parameter guard keeps this relation dormant for
    -- ordinary/status/program/search/new-student pages.
    inactivity_attendance AS MATERIALIZED (
        SELECT
            attendance.student_id,
            MAX(
                CASE
                    WHEN COALESCE(
                        class_session.date,
                        (attendance.checked_in_at AT TIME ZONE 'UTC')::DATE
                    ) <= v_today
                    THEN COALESCE(
                        class_session.date,
                        (attendance.checked_in_at AT TIME ZONE 'UTC')::DATE
                    )
                    ELSE NULL
                END
            ) AS last_attendance_date
        FROM public.attendance AS attendance
        JOIN roster_candidates AS candidate
          ON candidate.id = attendance.student_id
        LEFT JOIN public.class_sessions AS class_session
          ON class_session.id = attendance.session_id
         AND class_session.studio_id = p_studio_id
        WHERE p_inactivity_days IS NOT NULL
          AND attendance.studio_id = p_studio_id
          AND attendance.status <> 'absent'
        GROUP BY attendance.student_id
    ),
    filtered_keys AS MATERIALIZED (
        SELECT
            candidate.id,
            candidate.legal_first_name,
            candidate.legal_last_name,
            candidate.preferred_name,
            candidate.status,
            candidate.membership_start_date,
            candidate.created_at,
            candidate.hold_start_date,
            candidate.hold_end_date,
            candidate.on_hold_now,
            NULL::DATE AS last_attendance_date,
            COALESCE(
                candidate.membership_start_date,
                (candidate.created_at AT TIME ZONE 'UTC')::DATE
            ) AS reference_date,
            candidate.anchor_revision,
            candidate.primary_sort_value,
            candidate.primary_sort_is_null
        FROM roster_candidates AS candidate
        WHERE p_inactivity_days IS NULL

        UNION ALL

        SELECT
            candidate.id,
            candidate.legal_first_name,
            candidate.legal_last_name,
            candidate.preferred_name,
            candidate.status,
            candidate.membership_start_date,
            candidate.created_at,
            candidate.hold_start_date,
            candidate.hold_end_date,
            candidate.on_hold_now,
            attendance.last_attendance_date,
            COALESCE(
                attendance.last_attendance_date,
                candidate.membership_start_date,
                (candidate.created_at AT TIME ZONE 'UTC')::DATE
            ) AS reference_date,
            candidate.anchor_revision,
            candidate.primary_sort_value,
            candidate.primary_sort_is_null
        FROM roster_candidates AS candidate
        LEFT JOIN inactivity_attendance AS attendance
          ON attendance.student_id = candidate.id
        WHERE p_inactivity_days IS NOT NULL
          AND candidate.status IN ('active', 'trialing', 'paused')
          AND NOT candidate.on_hold_now
          AND v_today - COALESCE(
                attendance.last_attendance_date,
                candidate.membership_start_date,
                (candidate.created_at AT TIME ZONE 'UTC')::DATE
              ) >= p_inactivity_days
    ),
    cursor_anchor AS (
        SELECT filtered_keys.*
        FROM filtered_keys
        WHERE filtered_keys.id = p_cursor_id
    ),
    cursor_state AS (
        SELECT
            p_cursor_id IS NULL
            OR EXISTS (
                SELECT 1
                FROM cursor_anchor AS anchor
                WHERE anchor.anchor_revision IS NOT DISTINCT FROM p_cursor_revision
            ) AS valid
    ),
    total AS (
        SELECT COUNT(*)::INTEGER AS total_count
        FROM filtered_keys
    ),
    eligible_keys AS (
        SELECT filtered_keys.*
        FROM filtered_keys
        CROSS JOIN cursor_state
        LEFT JOIN cursor_anchor AS anchor ON TRUE
        WHERE cursor_state.valid
          AND (
                p_cursor_id IS NULL
                OR (
                    p_cursor_direction = 'next'
                    AND (
                        (
                            p_sort_by = 'name'
                            AND (
                                (p_sort_dir = 'asc' AND (
                                    filtered_keys.legal_last_name > anchor.legal_last_name
                                    OR (filtered_keys.legal_last_name = anchor.legal_last_name AND filtered_keys.legal_first_name > anchor.legal_first_name)
                                    OR (filtered_keys.legal_last_name = anchor.legal_last_name AND filtered_keys.legal_first_name = anchor.legal_first_name AND filtered_keys.id > anchor.id)
                                ))
                                OR (p_sort_dir = 'desc' AND (
                                    filtered_keys.legal_last_name < anchor.legal_last_name
                                    OR (filtered_keys.legal_last_name = anchor.legal_last_name AND filtered_keys.legal_first_name < anchor.legal_first_name)
                                    OR (filtered_keys.legal_last_name = anchor.legal_last_name AND filtered_keys.legal_first_name = anchor.legal_first_name AND filtered_keys.id < anchor.id)
                                ))
                            )
                        )
                        OR (
                            p_sort_by <> 'name'
                            AND (
                                (
                                    p_sort_dir = 'asc'
                                    AND (
                                        (filtered_keys.primary_sort_is_null AND NOT anchor.primary_sort_is_null)
                                        OR (NOT filtered_keys.primary_sort_is_null AND NOT anchor.primary_sort_is_null AND filtered_keys.primary_sort_value > anchor.primary_sort_value)
                                        OR (
                                            filtered_keys.primary_sort_is_null IS NOT DISTINCT FROM anchor.primary_sort_is_null
                                            AND filtered_keys.primary_sort_value IS NOT DISTINCT FROM anchor.primary_sort_value
                                            AND (
                                                filtered_keys.legal_last_name > anchor.legal_last_name
                                                OR (filtered_keys.legal_last_name = anchor.legal_last_name AND filtered_keys.legal_first_name > anchor.legal_first_name)
                                                OR (filtered_keys.legal_last_name = anchor.legal_last_name AND filtered_keys.legal_first_name = anchor.legal_first_name AND filtered_keys.id > anchor.id)
                                            )
                                        )
                                    )
                                )
                                OR (
                                    p_sort_dir = 'desc'
                                    AND (
                                        (NOT filtered_keys.primary_sort_is_null AND anchor.primary_sort_is_null)
                                        OR (NOT filtered_keys.primary_sort_is_null AND NOT anchor.primary_sort_is_null AND filtered_keys.primary_sort_value < anchor.primary_sort_value)
                                        OR (
                                            filtered_keys.primary_sort_is_null IS NOT DISTINCT FROM anchor.primary_sort_is_null
                                            AND filtered_keys.primary_sort_value IS NOT DISTINCT FROM anchor.primary_sort_value
                                            AND (
                                                filtered_keys.legal_last_name > anchor.legal_last_name
                                                OR (filtered_keys.legal_last_name = anchor.legal_last_name AND filtered_keys.legal_first_name > anchor.legal_first_name)
                                                OR (filtered_keys.legal_last_name = anchor.legal_last_name AND filtered_keys.legal_first_name = anchor.legal_first_name AND filtered_keys.id > anchor.id)
                                            )
                                        )
                                    )
                                )
                            )
                        )
                    )
                )
                OR (
                    p_cursor_direction = 'previous'
                    AND (
                        (
                            p_sort_by = 'name'
                            AND (
                                (p_sort_dir = 'asc' AND (
                                    filtered_keys.legal_last_name < anchor.legal_last_name
                                    OR (filtered_keys.legal_last_name = anchor.legal_last_name AND filtered_keys.legal_first_name < anchor.legal_first_name)
                                    OR (filtered_keys.legal_last_name = anchor.legal_last_name AND filtered_keys.legal_first_name = anchor.legal_first_name AND filtered_keys.id < anchor.id)
                                ))
                                OR (p_sort_dir = 'desc' AND (
                                    filtered_keys.legal_last_name > anchor.legal_last_name
                                    OR (filtered_keys.legal_last_name = anchor.legal_last_name AND filtered_keys.legal_first_name > anchor.legal_first_name)
                                    OR (filtered_keys.legal_last_name = anchor.legal_last_name AND filtered_keys.legal_first_name = anchor.legal_first_name AND filtered_keys.id > anchor.id)
                                ))
                            )
                        )
                        OR (
                            p_sort_by <> 'name'
                            AND (
                                (
                                    p_sort_dir = 'asc'
                                    AND (
                                        (NOT filtered_keys.primary_sort_is_null AND anchor.primary_sort_is_null)
                                        OR (NOT filtered_keys.primary_sort_is_null AND NOT anchor.primary_sort_is_null AND filtered_keys.primary_sort_value < anchor.primary_sort_value)
                                        OR (
                                            filtered_keys.primary_sort_is_null IS NOT DISTINCT FROM anchor.primary_sort_is_null
                                            AND filtered_keys.primary_sort_value IS NOT DISTINCT FROM anchor.primary_sort_value
                                            AND (
                                                filtered_keys.legal_last_name < anchor.legal_last_name
                                                OR (filtered_keys.legal_last_name = anchor.legal_last_name AND filtered_keys.legal_first_name < anchor.legal_first_name)
                                                OR (filtered_keys.legal_last_name = anchor.legal_last_name AND filtered_keys.legal_first_name = anchor.legal_first_name AND filtered_keys.id < anchor.id)
                                            )
                                        )
                                    )
                                )
                                OR (
                                    p_sort_dir = 'desc'
                                    AND (
                                        (filtered_keys.primary_sort_is_null AND NOT anchor.primary_sort_is_null)
                                        OR (NOT filtered_keys.primary_sort_is_null AND NOT anchor.primary_sort_is_null AND filtered_keys.primary_sort_value > anchor.primary_sort_value)
                                        OR (
                                            filtered_keys.primary_sort_is_null IS NOT DISTINCT FROM anchor.primary_sort_is_null
                                            AND filtered_keys.primary_sort_value IS NOT DISTINCT FROM anchor.primary_sort_value
                                            AND (
                                                filtered_keys.legal_last_name < anchor.legal_last_name
                                                OR (filtered_keys.legal_last_name = anchor.legal_last_name AND filtered_keys.legal_first_name < anchor.legal_first_name)
                                                OR (filtered_keys.legal_last_name = anchor.legal_last_name AND filtered_keys.legal_first_name = anchor.legal_first_name AND filtered_keys.id < anchor.id)
                                            )
                                        )
                                    )
                                )
                            )
                        )
                    )
                )
          )
    ),
    page_keys AS (
        SELECT
            eligible_keys.*,
            ROW_NUMBER() OVER (
                ORDER BY
                    CASE WHEN p_sort_by = 'name' AND p_sort_dir = 'asc' AND p_cursor_direction IS DISTINCT FROM 'previous' THEN eligible_keys.legal_last_name END ASC NULLS LAST,
                    CASE WHEN p_sort_by = 'name' AND p_sort_dir = 'asc' AND p_cursor_direction IS DISTINCT FROM 'previous' THEN eligible_keys.legal_first_name END ASC NULLS LAST,
                    CASE WHEN p_sort_by = 'name' AND p_sort_dir = 'asc' AND p_cursor_direction IS DISTINCT FROM 'previous' THEN eligible_keys.id END ASC NULLS LAST,
                    CASE WHEN p_sort_by = 'name' AND p_sort_dir = 'desc' AND p_cursor_direction IS DISTINCT FROM 'previous' THEN eligible_keys.legal_last_name END DESC NULLS LAST,
                    CASE WHEN p_sort_by = 'name' AND p_sort_dir = 'desc' AND p_cursor_direction IS DISTINCT FROM 'previous' THEN eligible_keys.legal_first_name END DESC NULLS LAST,
                    CASE WHEN p_sort_by = 'name' AND p_sort_dir = 'desc' AND p_cursor_direction IS DISTINCT FROM 'previous' THEN eligible_keys.id END DESC NULLS LAST,
                    CASE WHEN p_sort_by <> 'name' AND p_sort_dir = 'asc' AND p_cursor_direction IS DISTINCT FROM 'previous' THEN eligible_keys.primary_sort_is_null END ASC,
                    CASE WHEN p_sort_by <> 'name' AND p_sort_dir = 'asc' AND p_cursor_direction IS DISTINCT FROM 'previous' THEN eligible_keys.primary_sort_value END ASC NULLS LAST,
                    CASE WHEN p_sort_by <> 'name' AND p_sort_dir = 'desc' AND p_cursor_direction IS DISTINCT FROM 'previous' THEN eligible_keys.primary_sort_is_null END DESC,
                    CASE WHEN p_sort_by <> 'name' AND p_sort_dir = 'desc' AND p_cursor_direction IS DISTINCT FROM 'previous' THEN eligible_keys.primary_sort_value END DESC NULLS LAST,
                    CASE WHEN p_sort_by <> 'name' AND p_cursor_direction IS DISTINCT FROM 'previous' THEN eligible_keys.legal_last_name END ASC NULLS LAST,
                    CASE WHEN p_sort_by <> 'name' AND p_cursor_direction IS DISTINCT FROM 'previous' THEN eligible_keys.legal_first_name END ASC NULLS LAST,
                    CASE WHEN p_sort_by <> 'name' AND p_cursor_direction IS DISTINCT FROM 'previous' THEN eligible_keys.id END ASC NULLS LAST,
                    CASE WHEN p_sort_by = 'name' AND p_sort_dir = 'asc' AND p_cursor_direction = 'previous' THEN eligible_keys.legal_last_name END DESC NULLS LAST,
                    CASE WHEN p_sort_by = 'name' AND p_sort_dir = 'asc' AND p_cursor_direction = 'previous' THEN eligible_keys.legal_first_name END DESC NULLS LAST,
                    CASE WHEN p_sort_by = 'name' AND p_sort_dir = 'asc' AND p_cursor_direction = 'previous' THEN eligible_keys.id END DESC NULLS LAST,
                    CASE WHEN p_sort_by = 'name' AND p_sort_dir = 'desc' AND p_cursor_direction = 'previous' THEN eligible_keys.legal_last_name END ASC NULLS LAST,
                    CASE WHEN p_sort_by = 'name' AND p_sort_dir = 'desc' AND p_cursor_direction = 'previous' THEN eligible_keys.legal_first_name END ASC NULLS LAST,
                    CASE WHEN p_sort_by = 'name' AND p_sort_dir = 'desc' AND p_cursor_direction = 'previous' THEN eligible_keys.id END ASC NULLS LAST,
                    CASE WHEN p_sort_by <> 'name' AND p_sort_dir = 'asc' AND p_cursor_direction = 'previous' THEN eligible_keys.primary_sort_is_null END DESC,
                    CASE WHEN p_sort_by <> 'name' AND p_sort_dir = 'asc' AND p_cursor_direction = 'previous' THEN eligible_keys.primary_sort_value END DESC NULLS LAST,
                    CASE WHEN p_sort_by <> 'name' AND p_sort_dir = 'desc' AND p_cursor_direction = 'previous' THEN eligible_keys.primary_sort_is_null END ASC,
                    CASE WHEN p_sort_by <> 'name' AND p_sort_dir = 'desc' AND p_cursor_direction = 'previous' THEN eligible_keys.primary_sort_value END ASC NULLS LAST,
                    CASE WHEN p_sort_by <> 'name' AND p_cursor_direction = 'previous' THEN eligible_keys.legal_last_name END DESC NULLS LAST,
                    CASE WHEN p_sort_by <> 'name' AND p_cursor_direction = 'previous' THEN eligible_keys.legal_first_name END DESC NULLS LAST,
                    CASE WHEN p_sort_by <> 'name' AND p_cursor_direction = 'previous' THEN eligible_keys.id END DESC NULLS LAST
            ) AS traversal_order
        FROM eligible_keys
    ),
    selected_keys AS MATERIALIZED (
        SELECT *
        FROM page_keys
        WHERE page_keys.traversal_order <= p_page_size + 1
    ),
    page_rows AS MATERIALIZED (
        SELECT *
        FROM selected_keys
        WHERE selected_keys.traversal_order <= p_page_size
    ),
    -- Attendance is a bounded page enrichment for every non-inactivity mode.
    -- Inactivity already carries the one grouped attendance result used to
    -- decide eligibility, so the sentinel remains in selected_keys only and
    -- can never enter either aggregate or any relation projection below.
    page_attendance AS MATERIALIZED (
        SELECT
            attendance.student_id,
            MAX(
                CASE
                    WHEN COALESCE(
                        class_session.date,
                        (attendance.checked_in_at AT TIME ZONE 'UTC')::DATE
                    ) <= v_today
                    THEN COALESCE(
                        class_session.date,
                        (attendance.checked_in_at AT TIME ZONE 'UTC')::DATE
                    )
                    ELSE NULL
                END
            ) AS last_attendance_date
        FROM public.attendance AS attendance
        JOIN page_rows
          ON page_rows.id = attendance.student_id
        LEFT JOIN public.class_sessions AS class_session
          ON class_session.id = attendance.session_id
         AND class_session.studio_id = p_studio_id
        WHERE attendance.studio_id = p_studio_id
          AND p_inactivity_days IS NULL
          AND attendance.status <> 'absent'
        GROUP BY attendance.student_id
    ),
    page_metadata AS (
        SELECT
            (SELECT total_count FROM total) AS total_count,
            EXISTS (
                SELECT 1
                FROM selected_keys AS sentinel
                WHERE sentinel.traversal_order > p_page_size
            ) AS has_more,
            COALESCE(
                JSONB_AGG(
                    JSONB_BUILD_OBJECT(
                        'id', page_rows.id,
                        'studio_id', p_studio_id,
                        'legal_first_name', student.legal_first_name,
                        'legal_last_name', student.legal_last_name,
                        'preferred_name', student.preferred_name,
                        'date_of_birth', student.date_of_birth::TEXT,
                        'is_minor', student.is_minor,
                        'hold_start_date', student.hold_start_date::TEXT,
                        'hold_end_date', student.hold_end_date::TEXT,
                        'email', student.email,
                        'phone', student.phone,
                        'address_line1', student.address_line1,
                        'address_city', student.address_city,
                        'address_state', student.address_state,
                        'address_zip', student.address_zip,
                        'emergency_contact_name', student.emergency_contact_name,
                        'emergency_contact_phone', student.emergency_contact_phone,
                        'emergency_contact_relation', student.emergency_contact_relation,
                        'status', student.status,
                        'membership_start_date', student.membership_start_date::TEXT,
                        'program_id', student.program_id,
                        'current_belt_rank_id', student.current_belt_rank_id,
                        'photo_path', student.photo_path,
                        'photo_url', NULL,
                        'photo_updated_at', student.photo_updated_at::TEXT,
                        'notes', student.notes,
                        'tags', COALESCE(student.tags, ARRAY[]::TEXT[]),
                        'guardians', guardian_projection.guardians,
                        'guardian_email', guardian_projection.guardian_email,
                        'program_memberships', membership_projection.program_memberships,
                        'last_attendance_date', COALESCE(
                            page_rows.last_attendance_date,
                            page_attendance.last_attendance_date
                        )::TEXT,
                        'inactivity_days', CASE
                            WHEN page_rows.status IN ('active', 'trialing', 'paused') AND NOT page_rows.on_hold_now
                            THEN v_today - COALESCE(
                                page_rows.last_attendance_date,
                                page_attendance.last_attendance_date,
                                page_rows.reference_date
                            )
                            ELSE NULL
                        END,
                        'reference_date', COALESCE(
                            page_rows.last_attendance_date,
                            page_attendance.last_attendance_date,
                            page_rows.reference_date
                        )::TEXT,
                        'created_at', student.created_at::TEXT,
                        'updated_at', student.updated_at::TEXT
                    )
                    ORDER BY CASE WHEN p_cursor_direction = 'previous' THEN -page_rows.traversal_order ELSE page_rows.traversal_order END
                ) FILTER (WHERE page_rows.id IS NOT NULL),
                '[]'::JSONB
            ) AS items,
            COUNT(page_rows.id) AS page_count
        FROM page_rows
        LEFT JOIN public.students AS student
          ON student.id = page_rows.id
         AND student.studio_id = p_studio_id
        LEFT JOIN page_attendance
          ON page_attendance.student_id = page_rows.id
        LEFT JOIN LATERAL (
            SELECT
                COALESCE(
                    JSONB_AGG(
                        JSONB_BUILD_OBJECT(
                            'id', guardian.id,
                            'first_name', guardian.first_name,
                            'last_name', guardian.last_name,
                            'email', guardian.email,
                            'phone', guardian.phone,
                            'relation', guardian.relation,
                            'is_primary_contact', guardian.is_primary_contact
                        ) ORDER BY guardian.is_primary_contact DESC, guardian.created_at, guardian.id
                    ),
                    '[]'::JSONB
                ) AS guardians,
                (ARRAY_AGG(guardian.email ORDER BY guardian.is_primary_contact DESC, guardian.created_at, guardian.id))[1] AS guardian_email
            FROM public.student_guardians AS student_guardian
            JOIN public.students AS guardian_student
              ON guardian_student.id = student_guardian.student_id
             AND guardian_student.studio_id = p_studio_id
             AND guardian_student.deleted_at IS NULL
            JOIN public.guardians AS guardian
              ON guardian.id = student_guardian.guardian_id
             AND guardian.studio_id = p_studio_id
            WHERE student_guardian.student_id = page_rows.id
        ) AS guardian_projection ON TRUE
        LEFT JOIN LATERAL (
            SELECT COALESCE(
                JSONB_AGG(
                    JSONB_BUILD_OBJECT(
                        'id', membership.id,
                        'studio_id', membership.studio_id,
                        'student_id', membership.student_id,
                        'program_id', membership.program_id,
                        'program_name', program.name,
                        'program_color_hex', program.color_hex,
                        'status', membership.status,
                        'started_at', membership.started_at::TEXT,
                        'ended_at', membership.ended_at::TEXT,
                        'current_belt_rank_id', membership.current_belt_rank_id,
                        'current_belt_rank_name', belt_rank.name,
                        'current_belt_rank_color', belt_rank.color_hex,
                        'created_at', membership.created_at::TEXT,
                        'updated_at', membership.updated_at::TEXT
                    ) ORDER BY membership.created_at, membership.id
                ),
                '[]'::JSONB
            ) AS program_memberships
            FROM public.student_program_memberships AS membership
            LEFT JOIN public.programs AS program
              ON program.id = membership.program_id
             AND program.studio_id = p_studio_id
            LEFT JOIN public.belt_ranks AS belt_rank
              ON belt_rank.id = membership.current_belt_rank_id
             AND belt_rank.studio_id = p_studio_id
            WHERE membership.studio_id = p_studio_id
              AND membership.student_id = page_rows.id
        ) AS membership_projection ON TRUE
    )
    SELECT JSONB_BUILD_OBJECT(
        'items', page_metadata.items,
        'total', page_metadata.total_count,
        'page_size', p_page_size,
        -- Navigation is always expressed in the returned display order.  A
        -- previous scan is reversed before it reaches the client, so it still
        -- exposes the next boundary back toward the page just left.
        'has_next', CASE
            WHEN p_cursor_direction = 'previous' THEN p_cursor_id IS NOT NULL
            ELSE page_metadata.has_more
        END,
        'has_previous', CASE
            WHEN p_cursor_direction = 'previous' THEN page_metadata.has_more
            ELSE p_cursor_id IS NOT NULL
        END,
        'next_anchor', CASE
            WHEN (
                CASE
                    WHEN p_cursor_direction = 'previous' THEN p_cursor_id IS NOT NULL
                    ELSE page_metadata.has_more
                END
            ) AND page_metadata.page_count > 0 THEN (
                SELECT JSONB_BUILD_OBJECT(
                    'id', page_rows.id,
                    'revision', page_rows.anchor_revision
                )
                FROM page_rows
                ORDER BY CASE WHEN p_cursor_direction = 'previous'
                              THEN page_rows.traversal_order END ASC NULLS LAST,
                         CASE WHEN p_cursor_direction IS DISTINCT FROM 'previous'
                              THEN page_rows.traversal_order END DESC NULLS LAST
                LIMIT 1
            )
            ELSE NULL
        END,
        'previous_anchor', CASE
            WHEN (
                CASE
                    WHEN p_cursor_direction = 'previous' THEN page_metadata.has_more
                    ELSE p_cursor_id IS NOT NULL
                END
            ) AND page_metadata.page_count > 0 THEN (
                SELECT JSONB_BUILD_OBJECT(
                    'id', page_rows.id,
                    'revision', page_rows.anchor_revision
                )
                FROM page_rows
                ORDER BY CASE WHEN p_cursor_direction = 'previous'
                              THEN page_rows.traversal_order END DESC NULLS LAST,
                         CASE WHEN p_cursor_direction IS DISTINCT FROM 'previous'
                              THEN page_rows.traversal_order END ASC NULLS LAST
                LIMIT 1
            )
            ELSE NULL
        END,
        'cursor_error', CASE
            WHEN NOT EXISTS (SELECT 1 FROM cursor_state WHERE valid) THEN JSONB_BUILD_OBJECT('code', 'stale_cursor')
            ELSE NULL
        END
    )
    INTO v_result
    FROM page_metadata;

    RETURN v_result;
END;
$list_student_roster$;

REVOKE ALL ON FUNCTION public.list_student_roster(UUID, TEXT, TEXT, UUID, INTEGER, TEXT, DATE, TEXT, TEXT, INTEGER, TEXT, UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.list_student_roster(UUID, TEXT, TEXT, UUID, INTEGER, TEXT, DATE, TEXT, TEXT, INTEGER, TEXT, UUID, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.list_student_roster(UUID, TEXT, TEXT, UUID, INTEGER, TEXT, DATE, TEXT, TEXT, INTEGER, TEXT, UUID, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.list_student_roster(UUID, TEXT, TEXT, UUID, INTEGER, TEXT, DATE, TEXT, TEXT, INTEGER, TEXT, UUID, TEXT) TO service_role;

-- The current release readiness function is versioned by the migration
-- inventory.  Keep the preflight query on the current additive head so the
-- local and hosted rollout gates cannot certify the prior schema.
CREATE OR REPLACE FUNCTION public.koaryu_release_schema_preflight_v4()
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
AS $schema_preflight_v4_roster$
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

    IF v_count <> 113 OR v_head <> '20260820025759' THEN
        v_failures := array_append(v_failures, 'migration_history_v20');
    END IF;
    IF COALESCE(v_pending, ARRAY[]::TEXT[]) IS DISTINCT FROM ARRAY[
        '20260727100000','20260727110000','20260801050957','20260801060000',
        '20260801070000','20260801080000','20260801090000','20260801091000',
        '20260801092000','20260801093000','20260801094000','20260801105313',
        '20260801112153','20260801115044','20260801123112','20260801131844',
        '20260814043325','20260814103046','20260814105424','20260814114500',
        '20260814152000','20260814170000','20260814183000','20260814200000',
        '20260814213000','20260815220402','20260816012723','20260820012533',
        '20260820025759'
    ]::TEXT[] THEN
        v_failures := array_append(v_failures, 'migration_history_sequence_v20');
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
       <> '0:cf1b1a4403e539721172d4a8cfec64540e4f5dcec2aab12eafbcfb51fbd84b3a' THEN
        v_failures := array_append(v_failures, 'critical_surface_manifest_v18');
    END IF;

    RETURN QUERY SELECT cardinality(v_failures) = 0, v_count, v_head,
        COALESCE(v_pending, ARRAY[]::TEXT[]), v_failures, 'release-db-attestation-v20';
END;
$schema_preflight_v4_roster$;

ALTER FUNCTION public.koaryu_release_schema_preflight_v4() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.koaryu_release_schema_preflight_v4()
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.koaryu_release_schema_preflight_v4() TO service_role;

-- Preserve the deployed V7-shaped compatibility response while making its
-- readiness decision depend on the current exact-head preflight.
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
AS $schema_preflight_v2_roster$
DECLARE
    v_current RECORD;
BEGIN
    SELECT * INTO v_current FROM public.koaryu_release_schema_preflight_v4();
    IF v_current.ready IS TRUE THEN
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
    RETURN QUERY SELECT FALSE, v_current.migration_count, v_current.migration_head,
        v_current.pending_versions, v_current.security_failures, 'release-db-attestation-v7'::TEXT;
END;
$schema_preflight_v2_roster$;

ALTER FUNCTION public.koaryu_release_schema_preflight_v2() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.koaryu_release_schema_preflight_v2()
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.koaryu_release_schema_preflight_v2() TO service_role;
