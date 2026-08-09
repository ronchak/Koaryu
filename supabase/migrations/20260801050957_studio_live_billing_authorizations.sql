-- Durable, owner-controlled authorization for Stripe live mutations.
--
-- LIVE_BILLING_ENABLED remains the environment-wide interlock. These rows are
-- the narrower, necessary studio scope and default to no authorization when
-- absent. Browser-facing roles receive no table or RPC access.

CREATE TABLE public.studio_live_billing_authorizations (
    studio_id UUID NOT NULL REFERENCES public.studios(id) ON DELETE CASCADE,
    scope TEXT NOT NULL CHECK (
        scope IN ('core_subscription', 'connect_onboarding', 'connect_payments')
    ),
    enabled BOOLEAN NOT NULL DEFAULT false,
    stripe_connected_account_id TEXT,
    connect_account_generation INTEGER CHECK (
        connect_account_generation IS NULL OR connect_account_generation > 0
    ),
    expires_at TIMESTAMPTZ,
    revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
    granted_at TIMESTAMPTZ,
    granted_by UUID REFERENCES auth.users(id) ON DELETE RESTRICT,
    granted_by_email TEXT,
    grant_reason TEXT,
    revoked_at TIMESTAMPTZ,
    revoked_by UUID REFERENCES auth.users(id) ON DELETE RESTRICT,
    revoked_by_email TEXT,
    revoke_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (studio_id, scope),
    CHECK (
        stripe_connected_account_id IS NULL
        OR stripe_connected_account_id ~ '^acct_[A-Za-z0-9]+$'
    ),
    CHECK (
        scope <> 'core_subscription'
        OR (
            stripe_connected_account_id IS NULL
            AND connect_account_generation IS NULL
        )
    ),
    CHECK (
        scope <> 'connect_payments'
        OR NOT enabled
        OR (
            stripe_connected_account_id IS NOT NULL
            AND connect_account_generation IS NOT NULL
        )
    ),
    CHECK (
        NOT enabled
        OR (
            granted_at IS NOT NULL
            AND granted_by IS NOT NULL
            AND grant_reason IS NOT NULL
            AND expires_at IS NOT NULL
            AND expires_at > granted_at
        )
    )
);

CREATE INDEX idx_studio_live_billing_authorizations_enabled
    ON public.studio_live_billing_authorizations(scope, studio_id)
    WHERE enabled;

DROP TRIGGER IF EXISTS set_studio_live_billing_authorizations_updated_at
    ON public.studio_live_billing_authorizations;
CREATE TRIGGER set_studio_live_billing_authorizations_updated_at
    BEFORE UPDATE ON public.studio_live_billing_authorizations
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.studio_live_billing_authorizations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS studio_live_billing_authorizations_no_client_access
    ON public.studio_live_billing_authorizations;
CREATE POLICY studio_live_billing_authorizations_no_client_access
    ON public.studio_live_billing_authorizations
    AS RESTRICTIVE
    FOR ALL
    TO anon, authenticated
    USING (false)
    WITH CHECK (false);

CREATE POLICY reject_ambiguous_staff_membership_access
    ON public.studio_live_billing_authorizations
    AS RESTRICTIVE
    FOR ALL
    TO authenticated
    USING ((SELECT private.has_unambiguous_studio_membership()))
    WITH CHECK ((SELECT private.has_unambiguous_studio_membership()));

REVOKE ALL ON TABLE public.studio_live_billing_authorizations
    FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT
    ON TABLE public.studio_live_billing_authorizations
    TO service_role;

-- A live grant is unusable until a short-lived, read-only reconciliation has
-- accounted for every provider account and every failed event. The reporter
-- computes this evidence; only this service-role RPC may persist it.
CREATE TABLE public.stripe_live_billing_reconciliation_checkpoints (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    checkpoint_sequence BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE NOT NULL,
    stripe_livemode BOOLEAN NOT NULL,
    candidate_sha TEXT NOT NULL CHECK (candidate_sha ~ '^[0-9a-f]{40}$'),
    provider_account_count INTEGER NOT NULL CHECK (provider_account_count >= 0),
    mapped_account_count INTEGER NOT NULL CHECK (mapped_account_count >= 0),
    excluded_account_count INTEGER NOT NULL CHECK (excluded_account_count >= 0),
    unresolved_account_count INTEGER NOT NULL CHECK (unresolved_account_count >= 0),
    event_count_since_cutoff INTEGER NOT NULL CHECK (event_count_since_cutoff >= 0),
    failed_event_count INTEGER NOT NULL CHECK (
        failed_event_count >= 0 AND failed_event_count <= event_count_since_cutoff
    ),
    latest_event_created_at TIMESTAMPTZ,
    webhook_delivery_verified_at TIMESTAMPTZ,
    enabled_platform_endpoint_count INTEGER NOT NULL CHECK (enabled_platform_endpoint_count >= 0),
    enabled_connect_endpoint_count INTEGER NOT NULL CHECK (enabled_connect_endpoint_count >= 0),
    platform_endpoint_contract_matched BOOLEAN NOT NULL,
    connect_endpoint_contract_matched BOOLEAN NOT NULL,
    verified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    source_report_sha256 TEXT NOT NULL CHECK (source_report_sha256 ~ '^[0-9a-f]{64}$'),
    reason TEXT NOT NULL,
    verified_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
    verified_by_email TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (
        provider_account_count = mapped_account_count
            + excluded_account_count
            + unresolved_account_count
    ),
    CHECK (expires_at > verified_at)
);

CREATE INDEX idx_stripe_live_billing_reconciliation_checkpoints_latest
    ON public.stripe_live_billing_reconciliation_checkpoints(
        verified_at DESC,
        checkpoint_sequence DESC
    );

ALTER TABLE public.stripe_live_billing_reconciliation_checkpoints ENABLE ROW LEVEL SECURITY;

CREATE POLICY stripe_live_billing_reconciliation_checkpoints_no_client_access
    ON public.stripe_live_billing_reconciliation_checkpoints
    AS RESTRICTIVE
    FOR ALL
    TO anon, authenticated
    USING (false)
    WITH CHECK (false);

CREATE POLICY reject_ambiguous_staff_membership_access
    ON public.stripe_live_billing_reconciliation_checkpoints
    AS RESTRICTIVE
    FOR ALL
    TO authenticated
    USING ((SELECT private.has_unambiguous_studio_membership()))
    WITH CHECK ((SELECT private.has_unambiguous_studio_membership()));

REVOKE ALL ON TABLE public.stripe_live_billing_reconciliation_checkpoints
    FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT
    ON TABLE public.stripe_live_billing_reconciliation_checkpoints
    TO service_role;

CREATE OR REPLACE FUNCTION public.record_stripe_live_billing_reconciliation_checkpoint(
    p_candidate_sha TEXT,
    p_provider_account_count INTEGER,
    p_mapped_account_count INTEGER,
    p_excluded_account_count INTEGER,
    p_unresolved_account_count INTEGER,
    p_event_count_since_cutoff INTEGER,
    p_failed_event_count INTEGER,
    p_latest_event_created_at TIMESTAMPTZ,
    p_webhook_delivery_verified_at TIMESTAMPTZ,
    p_enabled_platform_endpoint_count INTEGER,
    p_enabled_connect_endpoint_count INTEGER,
    p_platform_endpoint_contract_matched BOOLEAN,
    p_connect_endpoint_contract_matched BOOLEAN,
    p_expires_at TIMESTAMPTZ,
    p_source_report_sha256 TEXT,
    p_reason TEXT,
    p_actor_id UUID,
    p_actor_email TEXT DEFAULT NULL
)
RETURNS public.stripe_live_billing_reconciliation_checkpoints
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_checkpoint public.stripe_live_billing_reconciliation_checkpoints%ROWTYPE;
    v_now TIMESTAMPTZ := now();
    v_reason TEXT := BTRIM(COALESCE(p_reason, ''));
BEGIN
    IF p_candidate_sha !~ '^[0-9a-f]{40}$'
       OR p_source_report_sha256 !~ '^[0-9a-f]{64}$' THEN
        RAISE EXCEPTION 'Candidate SHA and report digest must be lowercase hex.'
            USING ERRCODE = '22023';
    END IF;
    IF p_actor_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM auth.users WHERE id = p_actor_id
    ) THEN
        RAISE EXCEPTION 'Reconciliation actor must be a real Auth user.'
            USING ERRCODE = '22023';
    END IF;
    IF v_reason = '' OR char_length(v_reason) > 500 OR v_reason ~ '[[:cntrl:]]' THEN
        RAISE EXCEPTION 'Reconciliation reason must be 1-500 characters without controls.'
            USING ERRCODE = '22023';
    END IF;
    IF p_provider_account_count IS NULL OR p_provider_account_count < 0
       OR p_mapped_account_count IS NULL OR p_mapped_account_count < 0
       OR p_excluded_account_count IS NULL OR p_excluded_account_count < 0
       OR p_unresolved_account_count IS NULL OR p_unresolved_account_count < 0
       OR p_provider_account_count <> p_mapped_account_count
            + p_excluded_account_count + p_unresolved_account_count
       OR p_event_count_since_cutoff IS NULL OR p_event_count_since_cutoff < 0
       OR p_failed_event_count IS NULL OR p_failed_event_count < 0
       OR p_failed_event_count > p_event_count_since_cutoff
       OR p_enabled_platform_endpoint_count IS NULL OR p_enabled_platform_endpoint_count < 0
       OR p_enabled_connect_endpoint_count IS NULL OR p_enabled_connect_endpoint_count < 0
       OR p_platform_endpoint_contract_matched IS NULL
       OR p_connect_endpoint_contract_matched IS NULL THEN
        RAISE EXCEPTION 'Invalid reconciliation counts.' USING ERRCODE = '22023';
    END IF;
    IF p_webhook_delivery_verified_at IS NULL
       OR p_webhook_delivery_verified_at < v_now - INTERVAL '24 hours'
       OR p_webhook_delivery_verified_at > v_now + INTERVAL '5 minutes'
       OR p_expires_at IS NULL
       OR p_expires_at <= v_now
       OR p_expires_at > v_now + INTERVAL '24 hours' THEN
        RAISE EXCEPTION 'Reconciliation proof must be current and expire within 24 hours.'
            USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.stripe_live_billing_reconciliation_checkpoints (
        stripe_livemode,
        candidate_sha,
        provider_account_count,
        mapped_account_count,
        excluded_account_count,
        unresolved_account_count,
        event_count_since_cutoff,
        failed_event_count,
        latest_event_created_at,
        webhook_delivery_verified_at,
        enabled_platform_endpoint_count,
        enabled_connect_endpoint_count,
        platform_endpoint_contract_matched,
        connect_endpoint_contract_matched,
        verified_at,
        expires_at,
        source_report_sha256,
        reason,
        verified_by,
        verified_by_email
    ) VALUES (
        true,
        p_candidate_sha,
        p_provider_account_count,
        p_mapped_account_count,
        p_excluded_account_count,
        p_unresolved_account_count,
        p_event_count_since_cutoff,
        p_failed_event_count,
        p_latest_event_created_at,
        p_webhook_delivery_verified_at,
        p_enabled_platform_endpoint_count,
        p_enabled_connect_endpoint_count,
        p_platform_endpoint_contract_matched,
        p_connect_endpoint_contract_matched,
        v_now,
        p_expires_at,
        p_source_report_sha256,
        v_reason,
        p_actor_id,
        NULLIF(BTRIM(COALESCE(p_actor_email, '')), '')
    ) RETURNING * INTO v_checkpoint;

    RETURN v_checkpoint;
END;
$$;

REVOKE ALL ON FUNCTION public.record_stripe_live_billing_reconciliation_checkpoint(
    TEXT, INTEGER, INTEGER, INTEGER, INTEGER, INTEGER, INTEGER,
    TIMESTAMPTZ, TIMESTAMPTZ, INTEGER, INTEGER, BOOLEAN, BOOLEAN,
    TIMESTAMPTZ, TEXT, TEXT, UUID, TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_stripe_live_billing_reconciliation_checkpoint(
    TEXT, INTEGER, INTEGER, INTEGER, INTEGER, INTEGER, INTEGER,
    TIMESTAMPTZ, TIMESTAMPTZ, INTEGER, INTEGER, BOOLEAN, BOOLEAN,
    TIMESTAMPTZ, TEXT, TEXT, UUID, TEXT
) TO service_role;

CREATE OR REPLACE FUNCTION public.set_studio_live_billing_authorization_atomic(
    p_studio_id UUID,
    p_scope TEXT,
    p_enabled BOOLEAN,
    p_expires_at TIMESTAMPTZ,
    p_reason TEXT,
    p_actor_id UUID,
    p_actor_email TEXT DEFAULT NULL,
    p_stripe_connected_account_id TEXT DEFAULT NULL
)
RETURNS TABLE(
    outcome TEXT,
    studio_id UUID,
    scope TEXT,
    enabled BOOLEAN,
    stripe_connected_account_id TEXT,
    connect_account_generation INTEGER,
    expires_at TIMESTAMPTZ,
    revision BIGINT,
    changed_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_existing public.studio_live_billing_authorizations%ROWTYPE;
    v_updated public.studio_live_billing_authorizations%ROWTYPE;
    v_payment_account public.studio_payment_accounts%ROWTYPE;
    v_reason TEXT := BTRIM(COALESCE(p_reason, ''));
    v_actor_email TEXT := NULLIF(BTRIM(COALESCE(p_actor_email, '')), '');
    v_requested_account_id TEXT := NULLIF(BTRIM(COALESCE(p_stripe_connected_account_id, '')), '');
    v_bound_account_id TEXT;
    v_generation INTEGER;
    v_changed_at TIMESTAMPTZ := now();
    v_generation_text TEXT;
    v_existing_found BOOLEAN := false;
BEGIN
    IF p_studio_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM public.studios WHERE id = p_studio_id
    ) THEN
        RAISE EXCEPTION 'Studio not found.' USING ERRCODE = 'P0002';
    END IF;

    IF p_scope IS NULL OR p_scope NOT IN (
        'core_subscription', 'connect_onboarding', 'connect_payments'
    ) THEN
        RAISE EXCEPTION 'Invalid live billing authorization scope.'
            USING ERRCODE = '22023';
    END IF;

    IF p_enabled IS NULL THEN
        RAISE EXCEPTION 'Requested authorization state is required.'
            USING ERRCODE = '22023';
    END IF;

    IF p_enabled AND (
        p_expires_at IS NULL
        OR p_expires_at <= v_changed_at
        OR p_expires_at > v_changed_at + INTERVAL '30 days'
    ) THEN
        RAISE EXCEPTION 'Enabled authorization must expire within 30 days.'
            USING ERRCODE = '22023';
    END IF;

    IF p_enabled AND NOT EXISTS (
        SELECT 1
          FROM (
              SELECT checkpoint.*
                FROM public.stripe_live_billing_reconciliation_checkpoints checkpoint
               WHERE checkpoint.stripe_livemode
               ORDER BY checkpoint.verified_at DESC, checkpoint.checkpoint_sequence DESC
               LIMIT 1
          ) latest
         WHERE latest.unresolved_account_count = 0
           AND latest.failed_event_count = 0
           AND latest.webhook_delivery_verified_at IS NOT NULL
           AND latest.enabled_platform_endpoint_count > 0
           AND latest.enabled_connect_endpoint_count > 0
           AND latest.platform_endpoint_contract_matched
           AND latest.connect_endpoint_contract_matched
           AND latest.expires_at > v_changed_at
    ) THEN
        RAISE EXCEPTION 'Current successful live Stripe reconciliation is required.'
            USING ERRCODE = 'P0B04';
    END IF;

    IF p_enabled AND EXISTS (
        SELECT 1
          FROM public.stripe_events event
         WHERE event.livemode
           AND event.created_at >= TIMESTAMPTZ '2026-07-13 00:00:00+00'
           AND event.stripe_account_id IS NOT NULL
           AND NOT EXISTS (
               SELECT 1
                 FROM public.studio_payment_accounts account
                WHERE account.stripe_connected_account_id = event.stripe_account_id
           )
           AND NOT EXISTS (
               SELECT 1
                 FROM public.stripe_connect_account_dispositions disposition
                WHERE disposition.stripe_connected_account_id = event.stripe_account_id
                  AND disposition.excluded
           )
    ) THEN
        RAISE EXCEPTION 'Unreconciled live Stripe event accounts block authorization.'
            USING ERRCODE = 'P0B05';
    END IF;

    IF p_enabled AND EXISTS (
        SELECT 1
          FROM public.stripe_events event
         WHERE event.livemode
           AND event.created_at >= TIMESTAMPTZ '2026-07-13 00:00:00+00'
           AND event.processing_status = 'failed'
    ) THEN
        RAISE EXCEPTION 'Failed live Stripe events block authorization.'
            USING ERRCODE = 'P0B06';
    END IF;

    IF v_reason = '' OR char_length(v_reason) > 500 OR v_reason ~ '[[:cntrl:]]' THEN
        RAISE EXCEPTION 'Authorization reason must be 1-500 characters without controls.'
            USING ERRCODE = '22023';
    END IF;

    IF p_actor_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM auth.users WHERE id = p_actor_id
    ) THEN
        RAISE EXCEPTION 'Authorization actor must be a real Auth user.'
            USING ERRCODE = '22023';
    END IF;

    IF v_requested_account_id IS NOT NULL
       AND v_requested_account_id !~ '^acct_[A-Za-z0-9]+$' THEN
        RAISE EXCEPTION 'Invalid Stripe connected account id.'
            USING ERRCODE = '22023';
    END IF;

    SELECT *
      INTO v_existing
      FROM public.studio_live_billing_authorizations authz
     WHERE authz.studio_id = p_studio_id
       AND authz.scope = p_scope
     FOR UPDATE;
    v_existing_found := FOUND;

    IF p_scope IN ('connect_onboarding', 'connect_payments') AND p_enabled THEN
        INSERT INTO public.studio_payment_accounts(studio_id)
        VALUES (p_studio_id)
        ON CONFLICT ON CONSTRAINT studio_payment_accounts_pkey DO NOTHING;

        SELECT *
          INTO v_payment_account
          FROM public.studio_payment_accounts account
         WHERE account.studio_id = p_studio_id
         FOR UPDATE;

        v_generation_text := v_payment_account.metadata->>'connect_account_generation';
        IF v_generation_text IS NULL OR v_generation_text = '' THEN
            v_generation := 1;
        ELSIF v_generation_text ~ '^[1-9][0-9]*$'
              AND v_generation_text::NUMERIC <= 2147483647 THEN
            v_generation := v_generation_text::INTEGER;
        ELSE
            RAISE EXCEPTION 'Stored Connect account generation is invalid.'
                USING ERRCODE = '22023';
        END IF;

        v_bound_account_id := NULLIF(
            BTRIM(COALESCE(v_payment_account.stripe_connected_account_id, '')),
            ''
        );

        IF v_requested_account_id IS NOT NULL
           AND v_requested_account_id IS DISTINCT FROM v_bound_account_id THEN
            RAISE EXCEPTION 'Requested Stripe account is not the studio mapping.'
                USING ERRCODE = 'P0B01';
        END IF;

        IF p_scope = 'connect_payments' AND (
            v_bound_account_id IS NULL
            OR v_payment_account.status <> 'charges_enabled'
            OR NOT v_payment_account.charges_enabled
            OR NOT v_payment_account.payouts_enabled
            OR NOT v_payment_account.details_submitted
            OR cardinality(v_payment_account.requirements_due) <> 0
        ) THEN
            RAISE EXCEPTION 'Connect account is not ready for live payments.'
                USING ERRCODE = 'P0B02';
        END IF;
    ELSIF p_scope = 'core_subscription' THEN
        IF v_requested_account_id IS NOT NULL THEN
            RAISE EXCEPTION 'Core subscription authorization cannot bind a Connect account.'
                USING ERRCODE = '22023';
        END IF;
        v_bound_account_id := NULL;
        v_generation := NULL;
    ELSE
        v_bound_account_id := v_existing.stripe_connected_account_id;
        v_generation := v_existing.connect_account_generation;
    END IF;

    IF v_existing_found
       AND v_existing.enabled IS NOT DISTINCT FROM p_enabled
       AND (
            NOT p_enabled
            OR (
                v_existing.stripe_connected_account_id IS NOT DISTINCT FROM v_bound_account_id
                AND v_existing.connect_account_generation IS NOT DISTINCT FROM v_generation
                AND v_existing.expires_at IS NOT DISTINCT FROM p_expires_at
            )
       ) THEN
        RETURN QUERY SELECT
            'no_change'::TEXT,
            v_existing.studio_id,
            v_existing.scope,
            v_existing.enabled,
            v_existing.stripe_connected_account_id,
            v_existing.connect_account_generation,
            v_existing.expires_at,
            v_existing.revision,
            v_existing.updated_at;
        RETURN;
    END IF;

    INSERT INTO public.studio_live_billing_authorizations AS authz (
        studio_id,
        scope,
        enabled,
        stripe_connected_account_id,
        connect_account_generation,
        expires_at,
        revision,
        granted_at,
        granted_by,
        granted_by_email,
        grant_reason,
        revoked_at,
        revoked_by,
        revoked_by_email,
        revoke_reason
    ) VALUES (
        p_studio_id,
        p_scope,
        p_enabled,
        v_bound_account_id,
        v_generation,
        CASE WHEN p_enabled THEN p_expires_at ELSE NULL END,
        1,
        CASE WHEN p_enabled THEN v_changed_at ELSE NULL END,
        CASE WHEN p_enabled THEN p_actor_id ELSE NULL END,
        CASE WHEN p_enabled THEN v_actor_email ELSE NULL END,
        CASE WHEN p_enabled THEN v_reason ELSE NULL END,
        CASE WHEN p_enabled THEN NULL ELSE v_changed_at END,
        CASE WHEN p_enabled THEN NULL ELSE p_actor_id END,
        CASE WHEN p_enabled THEN NULL ELSE v_actor_email END,
        CASE WHEN p_enabled THEN NULL ELSE v_reason END
    )
    ON CONFLICT ON CONSTRAINT studio_live_billing_authorizations_pkey DO UPDATE
       SET enabled = EXCLUDED.enabled,
           stripe_connected_account_id = CASE
               WHEN EXCLUDED.enabled THEN EXCLUDED.stripe_connected_account_id
               ELSE authz.stripe_connected_account_id
           END,
           connect_account_generation = CASE
               WHEN EXCLUDED.enabled THEN EXCLUDED.connect_account_generation
               ELSE authz.connect_account_generation
           END,
           expires_at = CASE WHEN EXCLUDED.enabled THEN EXCLUDED.expires_at ELSE NULL END,
           revision = authz.revision + 1,
           granted_at = CASE WHEN EXCLUDED.enabled THEN v_changed_at ELSE authz.granted_at END,
           granted_by = CASE WHEN EXCLUDED.enabled THEN p_actor_id ELSE authz.granted_by END,
           granted_by_email = CASE WHEN EXCLUDED.enabled THEN v_actor_email ELSE authz.granted_by_email END,
           grant_reason = CASE WHEN EXCLUDED.enabled THEN v_reason ELSE authz.grant_reason END,
           revoked_at = CASE WHEN EXCLUDED.enabled THEN NULL ELSE v_changed_at END,
           revoked_by = CASE WHEN EXCLUDED.enabled THEN NULL ELSE p_actor_id END,
           revoked_by_email = CASE WHEN EXCLUDED.enabled THEN NULL ELSE v_actor_email END,
           revoke_reason = CASE WHEN EXCLUDED.enabled THEN NULL ELSE v_reason END
    RETURNING authz.* INTO v_updated;

    INSERT INTO public.audit_logs (
        studio_id,
        actor_id,
        action,
        entity_type,
        entity_id,
        metadata
    ) VALUES (
        p_studio_id,
        p_actor_id,
        CASE
            WHEN p_enabled THEN 'live_billing.authorization_granted'
            ELSE 'live_billing.authorization_revoked'
        END,
        'studio_live_billing_authorization',
        p_studio_id,
        jsonb_build_object(
            'scope', p_scope,
            'reason', v_reason,
            'actor_email', v_actor_email,
            'stripe_connected_account_id', v_updated.stripe_connected_account_id,
            'connect_account_generation', v_updated.connect_account_generation,
            'expires_at', v_updated.expires_at,
            'revision', v_updated.revision,
            'source', 'authorize_live_billing_cli'
        )
    );

    RETURN QUERY SELECT
        'applied'::TEXT,
        v_updated.studio_id,
        v_updated.scope,
        v_updated.enabled,
        v_updated.stripe_connected_account_id,
        v_updated.connect_account_generation,
        v_updated.expires_at,
        v_updated.revision,
        v_changed_at;
END;
$$;

REVOKE ALL ON FUNCTION public.set_studio_live_billing_authorization_atomic(
    UUID, TEXT, BOOLEAN, TIMESTAMPTZ, TEXT, UUID, TEXT, TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_studio_live_billing_authorization_atomic(
    UUID, TEXT, BOOLEAN, TIMESTAMPTZ, TEXT, UUID, TEXT, TEXT
) TO service_role;

-- Explicit exclusions are a narrow escape hatch for verified non-Koaryu or
-- retired Connect accounts. Absence never means ignore, and mapped accounts
-- cannot be excluded. No Stripe payload or personal data is stored here.
CREATE TABLE public.stripe_connect_account_dispositions (
    stripe_connected_account_id TEXT PRIMARY KEY
        CHECK (stripe_connected_account_id ~ '^acct_[A-Za-z0-9]+$'),
    excluded BOOLEAN NOT NULL DEFAULT false,
    reason TEXT NOT NULL,
    actor_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
    actor_email TEXT,
    revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
    changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS set_stripe_connect_account_dispositions_updated_at
    ON public.stripe_connect_account_dispositions;
CREATE TRIGGER set_stripe_connect_account_dispositions_updated_at
    BEFORE UPDATE ON public.stripe_connect_account_dispositions
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.stripe_connect_account_dispositions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS stripe_connect_account_dispositions_no_client_access
    ON public.stripe_connect_account_dispositions;
CREATE POLICY stripe_connect_account_dispositions_no_client_access
    ON public.stripe_connect_account_dispositions
    AS RESTRICTIVE
    FOR ALL
    TO anon, authenticated
    USING (false)
    WITH CHECK (false);

CREATE POLICY reject_ambiguous_staff_membership_access
    ON public.stripe_connect_account_dispositions
    AS RESTRICTIVE
    FOR ALL
    TO authenticated
    USING ((SELECT private.has_unambiguous_studio_membership()))
    WITH CHECK ((SELECT private.has_unambiguous_studio_membership()));

REVOKE ALL ON TABLE public.stripe_connect_account_dispositions
    FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT
    ON TABLE public.stripe_connect_account_dispositions
    TO service_role;

CREATE OR REPLACE FUNCTION public.set_stripe_connect_account_exclusion_atomic(
    p_stripe_connected_account_id TEXT,
    p_excluded BOOLEAN,
    p_reason TEXT,
    p_actor_id UUID,
    p_actor_email TEXT DEFAULT NULL
)
RETURNS TABLE(
    outcome TEXT,
    stripe_connected_account_id TEXT,
    excluded BOOLEAN,
    revision BIGINT,
    changed_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_existing public.stripe_connect_account_dispositions%ROWTYPE;
    v_updated public.stripe_connect_account_dispositions%ROWTYPE;
    v_account_id TEXT := NULLIF(BTRIM(COALESCE(p_stripe_connected_account_id, '')), '');
    v_reason TEXT := BTRIM(COALESCE(p_reason, ''));
    v_actor_email TEXT := NULLIF(BTRIM(COALESCE(p_actor_email, '')), '');
    v_changed_at TIMESTAMPTZ := now();
    v_existing_found BOOLEAN := false;
BEGIN
    IF v_account_id IS NULL OR v_account_id !~ '^acct_[A-Za-z0-9]+$' THEN
        RAISE EXCEPTION 'Invalid Stripe connected account id.' USING ERRCODE = '22023';
    END IF;
    IF p_excluded IS NULL THEN
        RAISE EXCEPTION 'Requested exclusion state is required.' USING ERRCODE = '22023';
    END IF;
    IF v_reason = '' OR char_length(v_reason) > 500 OR v_reason ~ '[[:cntrl:]]' THEN
        RAISE EXCEPTION 'Exclusion reason must be 1-500 characters without controls.'
            USING ERRCODE = '22023';
    END IF;
    IF p_actor_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM auth.users WHERE id = p_actor_id
    ) THEN
        RAISE EXCEPTION 'Exclusion actor must be a real Auth user.'
            USING ERRCODE = '22023';
    END IF;
    IF p_excluded AND EXISTS (
        SELECT 1
          FROM public.studio_payment_accounts account
         WHERE account.stripe_connected_account_id = v_account_id
    ) THEN
        RAISE EXCEPTION 'A currently mapped Stripe account cannot be excluded.'
            USING ERRCODE = 'P0B03';
    END IF;

    SELECT *
      INTO v_existing
      FROM public.stripe_connect_account_dispositions disposition
     WHERE disposition.stripe_connected_account_id = v_account_id
     FOR UPDATE;
    v_existing_found := FOUND;

    IF v_existing_found AND v_existing.excluded IS NOT DISTINCT FROM p_excluded THEN
        RETURN QUERY SELECT
            'no_change'::TEXT,
            v_existing.stripe_connected_account_id,
            v_existing.excluded,
            v_existing.revision,
            v_existing.changed_at;
        RETURN;
    END IF;

    INSERT INTO public.stripe_connect_account_dispositions AS disposition (
        stripe_connected_account_id,
        excluded,
        reason,
        actor_id,
        actor_email,
        revision,
        changed_at
    ) VALUES (
        v_account_id,
        p_excluded,
        v_reason,
        p_actor_id,
        v_actor_email,
        1,
        v_changed_at
    )
    ON CONFLICT ON CONSTRAINT stripe_connect_account_dispositions_pkey DO UPDATE
       SET excluded = EXCLUDED.excluded,
           reason = EXCLUDED.reason,
           actor_id = EXCLUDED.actor_id,
           actor_email = EXCLUDED.actor_email,
           revision = disposition.revision + 1,
           changed_at = EXCLUDED.changed_at
    RETURNING disposition.* INTO v_updated;

    RETURN QUERY SELECT
        'applied'::TEXT,
        v_updated.stripe_connected_account_id,
        v_updated.excluded,
        v_updated.revision,
        v_updated.changed_at;
END;
$$;

REVOKE ALL ON FUNCTION public.set_stripe_connect_account_exclusion_atomic(
    TEXT, BOOLEAN, TEXT, UUID, TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_stripe_connect_account_exclusion_atomic(
    TEXT, BOOLEAN, TEXT, UUID, TEXT
) TO service_role;

ALTER TABLE public.stripe_events
    ADD COLUMN IF NOT EXISTS error_reference TEXT;

ALTER TABLE public.stripe_events
    DROP CONSTRAINT IF EXISTS stripe_events_error_reference_format;
ALTER TABLE public.stripe_events
    ADD CONSTRAINT stripe_events_error_reference_format
    CHECK (error_reference IS NULL OR error_reference ~ '^[0-9a-f]{32}$');

CREATE UNIQUE INDEX IF NOT EXISTS idx_stripe_events_error_reference
    ON public.stripe_events(error_reference)
    WHERE error_reference IS NOT NULL;

CREATE OR REPLACE FUNCTION public.finish_stripe_event_processing_v2(
    p_event_id UUID,
    p_processing_token TEXT,
    p_status TEXT,
    p_error TEXT DEFAULT NULL,
    p_error_reference TEXT DEFAULT NULL
)
RETURNS TABLE(updated BOOLEAN, event_row JSONB)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_event public.stripe_events%ROWTYPE;
BEGIN
    IF p_processing_token IS NULL OR btrim(p_processing_token) = '' THEN
        RAISE EXCEPTION 'processing token is required' USING ERRCODE = '22023';
    END IF;
    IF p_status NOT IN ('processed', 'failed', 'ignored') THEN
        RAISE EXCEPTION 'Invalid Stripe event finish status: %', p_status;
    END IF;
    IF p_status = 'failed' AND (
        p_error IS NULL
        OR p_error !~ '^[a-z0-9][a-z0-9_.:-]{0,79}$'
        OR p_error_reference IS NULL
        OR p_error_reference !~ '^[0-9a-f]{32}$'
    ) THEN
        RAISE EXCEPTION 'Failed Stripe events require a sanitized code and correlation reference.'
            USING ERRCODE = '22023';
    ELSIF p_status <> 'failed' AND (
        p_error IS NOT NULL OR p_error_reference IS NOT NULL
    ) THEN
        RAISE EXCEPTION 'Only failed Stripe events may store failure correlation.'
            USING ERRCODE = '22023';
    END IF;

    UPDATE public.stripe_events
       SET processing_status = p_status,
           processed_at = CASE WHEN p_status = 'processed' THEN now() ELSE processed_at END,
           error = CASE WHEN p_status = 'failed' THEN p_error ELSE NULL END,
           error_reference = CASE WHEN p_status = 'failed' THEN p_error_reference ELSE NULL END,
           processing_token = NULL,
           processing_started_at = NULL
     WHERE id = p_event_id
       AND processing_token = p_processing_token
     RETURNING * INTO v_event;

    IF FOUND THEN
        RETURN QUERY SELECT true, to_jsonb(v_event);
    ELSE
        RETURN QUERY SELECT false, NULL::JSONB;
    END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.finish_stripe_event_processing_v2(
    UUID, TEXT, TEXT, TEXT, TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finish_stripe_event_processing_v2(
    UUID, TEXT, TEXT, TEXT, TEXT
) TO service_role;
