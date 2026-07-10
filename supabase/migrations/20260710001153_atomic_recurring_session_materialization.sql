-- ==========================================
-- Koaryu v1 - Atomic recurring session materialization
-- ==========================================

CREATE OR REPLACE FUNCTION public.materialize_recurring_class_sessions(
    p_studio_id UUID,
    p_start_date DATE,
    p_end_date DATE
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_template public.class_templates%ROWTYPE;
    v_inserted_count INTEGER;
    v_total_inserted INTEGER := 0;
BEGIN
    IF p_end_date < p_start_date THEN
        RAISE EXCEPTION 'end_date cannot be before start_date'
            USING ERRCODE = '22023';
    END IF;

    IF (p_end_date - p_start_date) + 1 > 93 THEN
        RAISE EXCEPTION 'Recurring session materialization date range cannot exceed 93 days'
            USING ERRCODE = '22023';
    END IF;

    -- Lock every applicable template in a stable order. Series deletion takes
    -- the same row lock, so either materialization commits first and deletion
    -- tombstones its new rows, or deletion commits first and this query no
    -- longer sees the inactive/out-of-window template.
    FOR v_template IN
        SELECT template.*
          FROM public.class_templates AS template
         WHERE template.studio_id = p_studio_id
           AND template.is_active = true
           AND template.start_date <= p_end_date
           AND (template.end_date IS NULL OR template.end_date >= p_start_date)
         ORDER BY template.id
         FOR UPDATE
    LOOP
        INSERT INTO public.class_sessions (
            studio_id,
            template_id,
            name,
            date,
            start_time,
            end_time,
            instructor_id,
            program_id,
            capacity
        )
        SELECT
            p_studio_id,
            v_template.id,
            v_template.name,
            occurrence_date::DATE,
            v_template.start_time,
            v_template.end_time,
            v_template.instructor_id,
            v_template.program_id,
            v_template.capacity
          FROM generate_series(
              greatest(p_start_date, v_template.start_date)::TIMESTAMP,
              least(p_end_date, coalesce(v_template.end_date, p_end_date))::TIMESTAMP,
              INTERVAL '1 day'
          ) AS occurrence(occurrence_date)
         WHERE extract(DOW FROM occurrence_date)::INTEGER = v_template.day_of_week
           AND NOT EXISTS (
               SELECT 1
                 FROM public.class_sessions AS existing
                WHERE existing.studio_id = p_studio_id
                  AND existing.template_id = v_template.id
                  AND existing.date = occurrence_date::DATE
           )
        ON CONFLICT DO NOTHING;

        GET DIAGNOSTICS v_inserted_count = ROW_COUNT;
        v_total_inserted := v_total_inserted + v_inserted_count;
    END LOOP;

    RETURN v_total_inserted;
END;
$$;

REVOKE ALL ON FUNCTION public.materialize_recurring_class_sessions(UUID, DATE, DATE)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.materialize_recurring_class_sessions(UUID, DATE, DATE)
TO service_role;
