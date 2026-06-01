-- Serialize Stripe subscription item quantity mutations across backend workers.
-- The app keeps the lock only around the Stripe mutation and releases it
-- immediately; stale locks expire so crashed workers do not block billing.

CREATE OR REPLACE FUNCTION public.claim_billing_subscription_quantity_sync(
    p_studio_id UUID,
    p_billing_subscription_id UUID,
    p_lock_token TEXT,
    p_stale_after_seconds INTEGER DEFAULT 120
)
RETURNS TABLE(claimed BOOLEAN, lock_owner TEXT, locked_at TIMESTAMPTZ)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_subscription public.billing_subscriptions%ROWTYPE;
    v_metadata JSONB;
    v_lock JSONB;
    v_lock_owner TEXT;
    v_locked_at TIMESTAMPTZ;
    v_now TIMESTAMPTZ := now();
    v_stale_after INTERVAL := (GREATEST(COALESCE(p_stale_after_seconds, 1), 1) * INTERVAL '1 second');
BEGIN
    IF p_lock_token IS NULL OR btrim(p_lock_token) = '' THEN
        RAISE EXCEPTION 'lock token is required' USING ERRCODE = '22023';
    END IF;

    SELECT *
      INTO v_subscription
      FROM public.billing_subscriptions
     WHERE id = p_billing_subscription_id
       AND studio_id = p_studio_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Billing subscription not found' USING ERRCODE = 'P0002';
    END IF;

    v_metadata := COALESCE(v_subscription.metadata, '{}'::JSONB);
    v_lock := v_metadata->'stripe_quantity_sync_lock';
    v_lock_owner := v_lock->>'token';
    v_locked_at := NULLIF(v_lock->>'locked_at', '')::TIMESTAMPTZ;

    IF v_lock IS NULL
       OR v_lock_owner IS NULL
       OR v_lock_owner = p_lock_token
       OR v_locked_at IS NULL
       OR v_locked_at <= v_now - v_stale_after THEN
        UPDATE public.billing_subscriptions
           SET metadata = jsonb_set(
                   v_metadata,
                   '{stripe_quantity_sync_lock}',
                   jsonb_build_object('token', p_lock_token, 'locked_at', v_now),
                   true
               ),
               updated_at = v_now
         WHERE id = p_billing_subscription_id
           AND studio_id = p_studio_id;

        RETURN QUERY SELECT true, p_lock_token, v_now;
        RETURN;
    END IF;

    RETURN QUERY SELECT false, v_lock_owner, v_locked_at;
END;
$$;

CREATE OR REPLACE FUNCTION public.finish_billing_subscription_quantity_sync(
    p_studio_id UUID,
    p_billing_subscription_id UUID,
    p_lock_token TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_subscription public.billing_subscriptions%ROWTYPE;
    v_metadata JSONB;
BEGIN
    IF p_lock_token IS NULL OR btrim(p_lock_token) = '' THEN
        RAISE EXCEPTION 'lock token is required' USING ERRCODE = '22023';
    END IF;

    SELECT *
      INTO v_subscription
      FROM public.billing_subscriptions
     WHERE id = p_billing_subscription_id
       AND studio_id = p_studio_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Billing subscription not found' USING ERRCODE = 'P0002';
    END IF;

    v_metadata := COALESCE(v_subscription.metadata, '{}'::JSONB);
    IF v_metadata->'stripe_quantity_sync_lock'->>'token' IS DISTINCT FROM p_lock_token THEN
        RETURN false;
    END IF;

    UPDATE public.billing_subscriptions
       SET metadata = v_metadata - 'stripe_quantity_sync_lock',
           updated_at = now()
     WHERE id = p_billing_subscription_id
       AND studio_id = p_studio_id;

    RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_billing_subscription_quantity_sync(UUID, UUID, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finish_billing_subscription_quantity_sync(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.claim_billing_subscription_quantity_sync(UUID, UUID, TEXT, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_billing_subscription_quantity_sync(UUID, UUID, TEXT) TO service_role;
