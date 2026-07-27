-- ==========================================
-- Koaryu v1 - Atomic studio comp management
-- ==========================================
--
-- Platform comps are owner-run access overrides. Keeping the entitlement
-- change, provenance patch, and audit row in one transaction prevents a
-- successful comp mutation from existing without its operator record.

CREATE OR REPLACE FUNCTION public.preserve_studio_comp_provenance()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
    -- Existing billing paths replace metadata from a client-side snapshot.
    -- Preserve operator provenance when one of those snapshots predates the
    -- comp transaction so drift remains detectable after either commit order.
    IF OLD.metadata ? 'comp'
       AND COALESCE(
           current_setting('koaryu.comp_provenance_write', true),
           ''
       ) <> 'allowed'
       AND NEW.metadata->'comp' IS DISTINCT FROM OLD.metadata->'comp' THEN
        NEW.metadata := jsonb_set(
            COALESCE(NEW.metadata, '{}'::JSONB),
            '{comp}',
            OLD.metadata->'comp',
            true
        );
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.preserve_studio_comp_provenance()
    FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS preserve_studio_comp_provenance_on_metadata_update
    ON public.studio_subscriptions;
CREATE TRIGGER preserve_studio_comp_provenance_on_metadata_update
    BEFORE UPDATE OF metadata ON public.studio_subscriptions
    FOR EACH ROW
    EXECUTE FUNCTION public.preserve_studio_comp_provenance();

CREATE OR REPLACE FUNCTION public.set_studio_comp_atomic(
    p_studio_id UUID,
    p_comped BOOLEAN,
    p_reason TEXT,
    p_actor_id UUID,
    p_actor_email TEXT DEFAULT NULL,
    p_allow_live_subscription BOOLEAN DEFAULT false
)
RETURNS TABLE(
    outcome TEXT,
    subscription_status TEXT,
    comped BOOLEAN,
    stripe_subscription_id TEXT,
    metadata JSONB,
    status_normalized BOOLEAN,
    provider_status_preserved BOOLEAN
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_existing public.studio_subscriptions%ROWTYPE;
    v_updated public.studio_subscriptions%ROWTYPE;
    v_reason TEXT := BTRIM(COALESCE(p_reason, ''));
    v_changed_at TIMESTAMPTZ := now();
    v_flag_needs_change BOOLEAN := false;
    v_status_normalized BOOLEAN := false;
    v_provider_status_preserved BOOLEAN := false;
    -- One-argument BTRIM strips spaces only, so a tab or newline would
    -- survive and make a blank identifier look present here while Python's
    -- str.strip() treats it as absent. Match Python's whitespace set, or the
    -- CLI and the database disagree about whether a subscription exists.
    WHITESPACE CONSTANT TEXT := E' \t\n\r\f\v';
    -- Keep this set aligned with
    -- platform_billing_service.LIVE_STRIPE_SUBSCRIPTION_STATUSES.
    v_live_subscription_statuses CONSTANT TEXT[] := ARRAY[
        'active',
        'trialing',
        'past_due',
        'unpaid',
        'paused'
    ]::TEXT[];
BEGIN
    IF p_comped IS NULL THEN
        RAISE EXCEPTION 'Requested comp state is required.'
            USING ERRCODE = '22023';
    END IF;

    IF v_reason = '' THEN
        RAISE EXCEPTION 'Comp reason is required.'
            USING ERRCODE = '22023';
    END IF;

    IF char_length(v_reason) > 500 THEN
        RAISE EXCEPTION 'Comp reason is too long.'
            USING ERRCODE = '22023';
    END IF;

    IF v_reason ~ '[[:cntrl:]]' THEN
        RAISE EXCEPTION 'Comp reason cannot contain control characters.'
            USING ERRCODE = '22023';
    END IF;

    SELECT *
      INTO v_existing
      FROM public.studio_subscriptions
     WHERE studio_id = p_studio_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Studio subscription not found.'
            USING ERRCODE = 'P0002';
    END IF;

    -- This repeats the CLI preflight under the subscription row lock. A
    -- provider projection committed before this lock is therefore authoritative
    -- and cannot race an unapproved comp grant.
    IF p_comped
       AND NOT COALESCE(p_allow_live_subscription, false)
       AND NULLIF(BTRIM(v_existing.stripe_subscription_id, WHITESPACE), '') IS NOT NULL
       AND v_existing.status = ANY(v_live_subscription_statuses) THEN
        RAISE EXCEPTION 'Live Stripe subscription requires explicit override.'
            USING ERRCODE = 'P0C01';
    END IF;

    v_flag_needs_change := v_existing.comped IS DISTINCT FROM p_comped;
    v_status_normalized := (
        NOT p_comped
        AND v_existing.status = 'comped'
        AND NULLIF(BTRIM(v_existing.stripe_subscription_id, WHITESPACE), '') IS NULL
    );
    v_provider_status_preserved := (
        NOT p_comped
        AND v_existing.status = 'comped'
        AND NULLIF(BTRIM(v_existing.stripe_subscription_id, WHITESPACE), '') IS NOT NULL
    );

    IF NOT v_flag_needs_change AND NOT v_status_normalized THEN
        RETURN QUERY
        SELECT
            'no_change'::TEXT,
            v_existing.status,
            v_existing.comped,
            v_existing.stripe_subscription_id,
            v_existing.metadata,
            false,
            false;
        RETURN;
    END IF;

    -- The metadata trigger rejects stale service snapshots that carry either
    -- no comp block or an older one. Only this locked transaction may replace
    -- the provenance block.
    PERFORM set_config('koaryu.comp_provenance_write', 'allowed', true);

    UPDATE public.studio_subscriptions AS subscription
       SET comped = p_comped,
           status = CASE
               WHEN v_status_normalized THEN 'incomplete'
               ELSE subscription.status
           END,
           metadata = jsonb_set(
               COALESCE(subscription.metadata, '{}'::JSONB),
               '{comp}',
               jsonb_build_object(
                   'state', CASE WHEN p_comped THEN 'granted' ELSE 'revoked' END,
                   'reason', v_reason,
                   'actor_id', p_actor_id,
                   'actor_email', p_actor_email,
                   'at', v_changed_at,
                   'source', 'comp_studio_cli',
                   'previous', v_existing.comped
               ),
               true
           )
     WHERE subscription.studio_id = p_studio_id
     RETURNING * INTO v_updated;

    PERFORM set_config('koaryu.comp_provenance_write', '', true);

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
        CASE WHEN p_comped THEN 'platform_comp.granted' ELSE 'platform_comp.revoked' END,
        'studio_subscription',
        p_studio_id,
        jsonb_build_object(
            'reason', v_reason,
            'actor_email', p_actor_email,
            'previous', v_existing.comped,
            'current', p_comped,
            'source', 'comp_studio_cli',
            'previous_status', v_existing.status,
            'current_status', v_updated.status,
            'status_normalized', v_status_normalized,
            'provider_status_preserved', v_provider_status_preserved
        )
    );

    RETURN QUERY
    SELECT
        'applied'::TEXT,
        v_updated.status,
        v_updated.comped,
        v_updated.stripe_subscription_id,
        v_updated.metadata,
        v_status_normalized,
        v_provider_status_preserved;
END;
$$;

REVOKE ALL ON FUNCTION public.set_studio_comp_atomic(
    UUID, BOOLEAN, TEXT, UUID, TEXT, BOOLEAN
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_studio_comp_atomic(
    UUID, BOOLEAN, TEXT, UUID, TEXT, BOOLEAN
) TO service_role;
