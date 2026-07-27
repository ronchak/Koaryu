-- =================================================
-- Koaryu v1 - Order billing events after studio comps
-- =================================================
--
-- Stripe watermarks order provider events against each other. Operator comp
-- provenance supplies the separate clock needed to stop an older provider
-- event from overriding a newer operator decision.

CREATE OR REPLACE FUNCTION public.clear_studio_comp_for_billing_event(
    p_studio_id UUID,
    p_event_created BIGINT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_existing public.studio_subscriptions%ROWTYPE;
    v_granted_at TIMESTAMPTZ;
    v_granted_at_text TEXT;
BEGIN
    SELECT *
      INTO v_existing
      FROM public.studio_subscriptions
     WHERE studio_id = p_studio_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Studio subscription not found.'
            USING ERRCODE = 'P0002';
    END IF;

    IF NOT v_existing.comped THEN
        RETURN false;
    END IF;

    IF v_existing.metadata->'comp'->>'state' = 'granted' THEN
        v_granted_at_text := v_existing.metadata->'comp'->>'at';
        IF p_event_created IS NULL OR v_granted_at_text IS NULL THEN
            RETURN false;
        END IF;

        BEGIN
            v_granted_at := v_granted_at_text::TIMESTAMPTZ;
        EXCEPTION
            WHEN invalid_datetime_format OR datetime_field_overflow THEN
                RETURN false;
        END;

        -- Stripe timestamps have second precision. Equality is therefore an
        -- ambiguous overlap, and the explicit operator decision wins.
        IF to_timestamp(p_event_created) <= v_granted_at THEN
            RETURN false;
        END IF;
    END IF;

    UPDATE public.studio_subscriptions
       SET comped = false
     WHERE studio_id = p_studio_id;

    RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.clear_studio_comp_for_billing_event(UUID, BIGINT)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.clear_studio_comp_for_billing_event(UUID, BIGINT)
    TO service_role;
