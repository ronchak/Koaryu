-- Keep full-series deletion valid when the selected session is the template's
-- first occurrence. The schedule constraint forbids end_date < start_date, so
-- an inactive template that never had a retained occurrence uses start_date as
-- its closed boundary.

CREATE OR REPLACE FUNCTION public.delete_recurring_class_series_atomic(
    p_session_id UUID,
    p_studio_id UUID,
    p_actor_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_session public.class_sessions%ROWTYPE;
    v_template public.class_templates%ROWTYPE;
    v_series_end_date DATE;
    v_deleted_count INTEGER;
    v_deleted_at TIMESTAMPTZ := now();
BEGIN
    SELECT *
      INTO v_session
      FROM public.class_sessions
     WHERE id = p_session_id
       AND studio_id = p_studio_id
       AND deleted_at IS NULL
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Class session not found.'
            USING ERRCODE = 'P0001';
    END IF;

    IF v_session.template_id IS NULL THEN
        RAISE EXCEPTION 'Only recurring classes can be deleted for the full series.'
            USING ERRCODE = '22023';
    END IF;

    SELECT *
      INTO v_template
      FROM public.class_templates
     WHERE id = v_session.template_id
       AND studio_id = p_studio_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Class template not found.'
            USING ERRCODE = 'P0001';
    END IF;

    v_series_end_date := GREATEST(v_template.start_date, v_session.date - 1);
    IF v_template.end_date IS NOT NULL THEN
        v_series_end_date := LEAST(v_series_end_date, v_template.end_date);
    END IF;

    UPDATE public.class_templates
       SET is_active = false,
           end_date = v_series_end_date
     WHERE id = v_template.id
       AND studio_id = p_studio_id;

    UPDATE public.class_sessions
       SET deleted_at = v_deleted_at,
           status = 'canceled'
     WHERE studio_id = p_studio_id
       AND template_id = v_template.id
       AND date >= v_session.date
       AND deleted_at IS NULL;

    GET DIAGNOSTICS v_deleted_count = ROW_COUNT;

    IF v_deleted_count = 0 THEN
        RAISE EXCEPTION 'Failed to delete recurring class series.'
            USING ERRCODE = 'P0001';
    END IF;

    INSERT INTO public.audit_logs (
        studio_id,
        actor_id,
        action,
        entity_type,
        entity_id,
        metadata
    )
    VALUES (
        p_studio_id,
        p_actor_id,
        'class_series.deleted',
        'class_template',
        v_template.id,
        jsonb_build_object(
            'start_date', v_session.date,
            'session_name', v_session.name
        )
    );
END;
$$;

REVOKE ALL ON FUNCTION public.delete_recurring_class_series_atomic(UUID, UUID, UUID)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_recurring_class_series_atomic(UUID, UUID, UUID)
    TO service_role;
