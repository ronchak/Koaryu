-- Preserve deterministic ordering for program-filtered student list pages.
--
-- The previous RPC sorted rows inside the page CTE, then selected from that CTE
-- through a final join without an ORDER BY. This replacement carries an ordinal
-- out of the ordered set and orders the final result by that ordinal so the
-- backend can safely hydrate the returned student ids in page order.

CREATE OR REPLACE FUNCTION public.list_student_ids_for_program_filter(
    p_studio_id UUID,
    p_program_id UUID,
    p_search TEXT DEFAULT NULL,
    p_status TEXT DEFAULT NULL,
    p_sort_by TEXT DEFAULT 'name',
    p_sort_dir TEXT DEFAULT 'asc',
    p_limit INTEGER DEFAULT 50,
    p_offset INTEGER DEFAULT 0
)
RETURNS TABLE (
    student_id UUID,
    total_count BIGINT
)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
    WITH filtered AS (
        SELECT
            student.id,
            student.legal_first_name,
            student.legal_last_name,
            student.preferred_name,
            student.email,
            student.phone,
            student.status,
            student.membership_start_date,
            student.created_at
        FROM public.students student
        WHERE student.studio_id = p_studio_id
          AND student.deleted_at IS NULL
          AND (p_status IS NULL OR student.status = p_status)
          AND (
                NULLIF(BTRIM(COALESCE(p_search, '')), '') IS NULL
                OR student.legal_first_name ILIKE '%' || p_search || '%'
                OR student.legal_last_name ILIKE '%' || p_search || '%'
                OR student.preferred_name ILIKE '%' || p_search || '%'
                OR student.email ILIKE '%' || p_search || '%'
                OR student.phone ILIKE '%' || p_search || '%'
          )
          AND (
                student.program_id = p_program_id
                OR EXISTS (
                    SELECT 1
                    FROM public.student_program_memberships membership
                    WHERE membership.studio_id = p_studio_id
                      AND membership.student_id = student.id
                      AND membership.program_id = p_program_id
                      AND membership.status IN ('active', 'paused')
                      AND membership.ended_at IS NULL
                )
          )
    ),
    total AS (
        SELECT COUNT(*)::BIGINT AS total_count
        FROM filtered
    ),
    ordered_rows AS (
        SELECT
            filtered.id,
            row_number() OVER (
                ORDER BY
                    CASE WHEN p_sort_by = 'name' AND p_sort_dir = 'asc' THEN filtered.legal_last_name END ASC NULLS LAST,
                    CASE WHEN p_sort_by = 'name' AND p_sort_dir = 'asc' THEN filtered.legal_first_name END ASC NULLS LAST,
                    CASE WHEN p_sort_by = 'name' AND p_sort_dir = 'desc' THEN filtered.legal_last_name END DESC NULLS LAST,
                    CASE WHEN p_sort_by = 'name' AND p_sort_dir = 'desc' THEN filtered.legal_first_name END DESC NULLS LAST,
                    CASE WHEN p_sort_by = 'status' AND p_sort_dir = 'asc' THEN filtered.status END ASC NULLS LAST,
                    CASE WHEN p_sort_by = 'status' AND p_sort_dir = 'desc' THEN filtered.status END DESC NULLS LAST,
                    CASE WHEN p_sort_by = 'membership_start_date' AND p_sort_dir = 'asc' THEN filtered.membership_start_date END ASC NULLS LAST,
                    CASE WHEN p_sort_by = 'membership_start_date' AND p_sort_dir = 'desc' THEN filtered.membership_start_date END DESC NULLS LAST,
                    CASE WHEN p_sort_by = 'created_at' AND p_sort_dir = 'asc' THEN filtered.created_at END ASC NULLS LAST,
                    CASE WHEN p_sort_by = 'created_at' AND p_sort_dir = 'desc' THEN filtered.created_at END DESC NULLS LAST,
                    filtered.legal_last_name ASC NULLS LAST,
                    filtered.legal_first_name ASC NULLS LAST,
                    filtered.id ASC
            ) AS page_order
        FROM filtered
    ),
    page_rows AS (
        SELECT ordered_rows.id, ordered_rows.page_order
        FROM ordered_rows
        ORDER BY ordered_rows.page_order
        LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200)
        OFFSET GREATEST(COALESCE(p_offset, 0), 0)
    )
    SELECT page_rows.id AS student_id, total.total_count
    FROM total
    LEFT JOIN page_rows ON TRUE
    ORDER BY page_rows.page_order NULLS LAST;
$$;

REVOKE ALL ON FUNCTION public.list_student_ids_for_program_filter(UUID, UUID, TEXT, TEXT, TEXT, TEXT, INTEGER, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.list_student_ids_for_program_filter(UUID, UUID, TEXT, TEXT, TEXT, TEXT, INTEGER, INTEGER) FROM anon;
REVOKE ALL ON FUNCTION public.list_student_ids_for_program_filter(UUID, UUID, TEXT, TEXT, TEXT, TEXT, INTEGER, INTEGER) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.list_student_ids_for_program_filter(UUID, UUID, TEXT, TEXT, TEXT, TEXT, INTEGER, INTEGER) TO service_role;
