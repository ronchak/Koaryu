-- =================================================
-- Koaryu v1 - Order billing events after studio comps
-- =================================================
--
-- Stripe watermarks order provider events against each other. Operator comp
-- provenance supplies the separate clock needed to stop an older provider
-- event from overriding a newer operator decision.
--
-- Two independent clocks can only bound that race, never settle it, so the
-- tie goes to the provider event: wrongly clearing a near-simultaneous grant
-- shows up in comp drift and is re-grantable, while letting a paying
-- subscription keep a free comp is silent, permanent, and costly.

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
            -- The block contains only the cast so an unexpected cast failure
            -- preserves the operator decision without hiding later RPC faults.
            WHEN OTHERS THEN
                RETURN false;
        END;

        IF NOT isfinite(v_granted_at) THEN
            RETURN false;
        END IF;

        -- These timestamps come from independent clocks and only bound the
        -- race. A strictly older event loses. On equality, clearing a grant is
        -- visible in drift and recoverable; preserving a free comp alongside a
        -- live paid subscription can be silent, permanent, and costly.
        IF to_timestamp(p_event_created) < date_trunc('second', v_granted_at) THEN
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
