-- Close the first-account Connect onboarding deadlock without weakening the
-- normal per-account reconciliation contract. A bootstrap is an expiring,
-- operation-specific permit: it can bind exactly one newly created account and
-- can authorize only that account generation's initial hosted Account Link.

CREATE TABLE public.stripe_connect_onboarding_bootstraps (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    studio_id UUID NOT NULL REFERENCES public.studios(id) ON DELETE CASCADE,
    connect_account_generation INTEGER NOT NULL CHECK (connect_account_generation > 0),
    bootstrap_token_sha256 TEXT NOT NULL UNIQUE CHECK (bootstrap_token_sha256 ~ '^[0-9a-f]{64}$'),
    account_create_payload_sha256 TEXT NOT NULL CHECK (account_create_payload_sha256 ~ '^[0-9a-f]{64}$'),
    initial_link_context_sha256 TEXT NOT NULL CHECK (initial_link_context_sha256 ~ '^[0-9a-f]{64}$'),
    initial_link_payload_sha256 TEXT CHECK (
        initial_link_payload_sha256 IS NULL OR initial_link_payload_sha256 ~ '^[0-9a-f]{64}$'
    ),
    account_create_idempotency_key TEXT NOT NULL,
    initial_link_idempotency_key TEXT NOT NULL,
    candidate_sha TEXT NOT NULL CHECK (candidate_sha ~ '^[0-9a-f]{40}$'),
    reconciliation_checkpoint_id UUID NOT NULL
        REFERENCES public.stripe_live_billing_reconciliation_checkpoints(id) ON DELETE RESTRICT,
    stripe_livemode BOOLEAN NOT NULL CHECK (stripe_livemode),
    stripe_connected_account_id TEXT CHECK (
        stripe_connected_account_id IS NULL OR stripe_connected_account_id ~ '^acct_[A-Za-z0-9]+$'
    ),
    authorized_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    account_bound_at TIMESTAMPTZ,
    initial_link_claimed_at TIMESTAMPTZ,
    initial_link_last_retry_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ NOT NULL,
    aborted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (studio_id, connect_account_generation, initial_link_idempotency_key),
    CHECK (expires_at > authorized_at AND expires_at <= authorized_at + INTERVAL '5 minutes'),
    CHECK ((stripe_connected_account_id IS NULL) = (account_bound_at IS NULL)),
    CHECK (initial_link_claimed_at IS NULL OR account_bound_at IS NOT NULL),
    CHECK (initial_link_last_retry_at IS NULL OR initial_link_claimed_at IS NOT NULL)
);

CREATE UNIQUE INDEX idx_stripe_connect_onboarding_bootstraps_generation_once
    ON public.stripe_connect_onboarding_bootstraps(studio_id, connect_account_generation);

ALTER TABLE public.stripe_connect_onboarding_bootstraps ENABLE ROW LEVEL SECURITY;

CREATE POLICY stripe_connect_onboarding_bootstraps_no_client_access
    ON public.stripe_connect_onboarding_bootstraps
    AS RESTRICTIVE
    FOR ALL
    TO anon, authenticated
    USING (false)
    WITH CHECK (false);

CREATE POLICY reject_ambiguous_staff_membership_access
    ON public.stripe_connect_onboarding_bootstraps
    AS RESTRICTIVE
    FOR ALL
    TO authenticated
    USING ((SELECT private.has_unambiguous_studio_membership()))
    WITH CHECK ((SELECT private.has_unambiguous_studio_membership()));

REVOKE ALL ON TABLE public.stripe_connect_onboarding_bootstraps
    FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER set_stripe_connect_onboarding_bootstraps_updated_at
    BEFORE UPDATE ON public.stripe_connect_onboarding_bootstraps
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE FUNCTION private.live_billing_event_is_in_scope(
    p_stripe_account_id TEXT,
    p_event_type TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    RETURN CASE
        WHEN p_stripe_account_id IS NULL THEN p_event_type = ANY (ARRAY[
            'checkout.session.completed', 'customer.subscription.created',
            'customer.subscription.updated', 'customer.subscription.deleted',
            'invoice.paid', 'invoice.payment_failed'
        ]::TEXT[])
        ELSE p_event_type = ANY (ARRAY[
            'account.updated', 'account.application.deauthorized',
            'checkout.session.completed', 'invoice.created', 'invoice.finalized',
            'invoice.paid', 'invoice.payment_failed', 'invoice.voided',
            'invoice.marked_uncollectible', 'payment_intent.processing',
            'payment_intent.succeeded', 'payment_intent.payment_failed',
            'charge.refunded', 'charge.refund.updated', 'refund.created',
            'refund.failed', 'refund.updated', 'charge.dispute.created',
            'charge.dispute.updated', 'charge.dispute.closed',
            'customer.subscription.created', 'customer.subscription.updated',
            'customer.subscription.deleted'
        ]::TEXT[])
        AND (
            EXISTS (
                SELECT 1 FROM public.studio_payment_accounts mapped
                 WHERE mapped.stripe_connected_account_id = p_stripe_account_id
            )
            OR NOT EXISTS (
                SELECT 1 FROM public.stripe_connect_account_dispositions disposition
                 WHERE disposition.stripe_connected_account_id = p_stripe_account_id
                   AND disposition.excluded
            )
        )
    END;
END;
$$;

REVOKE ALL ON FUNCTION private.live_billing_event_is_in_scope(TEXT, TEXT)
    FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION private.enforce_live_billing_checkpoint_processed_events()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF NEW.stripe_livemode AND EXISTS (
        SELECT 1
          FROM public.stripe_events event
         WHERE event.livemode
           AND event.created_at >= NEW.event_window_started_at
           AND event.created_at <= NEW.event_window_ended_at
           AND private.live_billing_event_is_in_scope(event.stripe_account_id, event.type)
           AND event.processing_status IS DISTINCT FROM 'processed'
    ) THEN
        RAISE EXCEPTION 'Every in-scope reconciliation event must be fully processed.'
            USING ERRCODE = 'P0B20';
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION private.enforce_live_billing_checkpoint_processed_events()
    FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER enforce_live_billing_checkpoint_processed_events
    BEFORE INSERT ON public.stripe_live_billing_reconciliation_checkpoints
    FOR EACH ROW
    EXECUTE FUNCTION private.enforce_live_billing_checkpoint_processed_events();

-- Replace the general mutation function in place so existing callers gain the
-- processing-state gate without accepting any new caller-provided eligibility.
CREATE OR REPLACE FUNCTION public.authorize_studio_live_billing_mutation_atomic(
    p_studio_id UUID,
    p_operation TEXT,
    p_scope TEXT,
    p_stripe_connected_account_id TEXT,
    p_candidate_sha TEXT
)
RETURNS TABLE(authorized BOOLEAN, studio_id UUID, checkpoint_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF p_studio_id IS NULL
       OR p_candidate_sha !~ '^[0-9a-f]{40}$'
       OR p_scope NOT IN ('core_subscription', 'connect_onboarding', 'connect_payments')
       OR NOT (
            (p_scope = 'core_subscription' AND p_operation = ANY (ARRAY[
                'customer.create', 'core_checkout_session.create',
                'customer_portal_session.create'
            ]::TEXT[]))
            OR (p_scope = 'connect_onboarding' AND p_operation = ANY (ARRAY[
                'connect_account.create', 'connect_account.branding.update',
                'connect_branding_file.create', 'connect_onboarding_link.create',
                'connect_dashboard_login_link.create'
            ]::TEXT[]))
            OR (p_scope = 'connect_payments' AND p_operation = ANY (ARRAY[
                'connected_customer.create', 'connected_customer.update',
                'connected_customer.default_payment_method.update',
                'connected_product.create', 'connected_product.update',
                'connected_price.create', 'connected_setup_checkout_session.create',
                'connected_subscription.create', 'connected_subscription_item.create',
                'connected_subscription_item.update', 'connected_subscription_item.delete',
                'connected_subscription.update', 'connected_subscription.cancel',
                'connected_invoice_item.create', 'connected_invoice.create',
                'connected_invoice.finalize', 'connected_invoice.send',
                'connected_invoice.pay', 'connected_invoice.void',
                'connected_refund.create', 'connected_capability.readiness'
            ]::TEXT[]))
       ) THEN
        RETURN;
    END IF;

    LOCK TABLE
        public.stripe_events,
        public.studio_payment_accounts,
        public.stripe_connect_account_dispositions,
        public.stripe_live_billing_reconciliation_checkpoints,
        public.stripe_live_billing_reconciliation_account_evidence,
        public.studio_live_billing_authorizations
        IN SHARE MODE;

    RETURN QUERY
    SELECT true, authz.studio_id, checkpoint.id
      FROM public.studio_live_billing_authorizations authz
      JOIN public.stripe_live_billing_reconciliation_checkpoints checkpoint
        ON checkpoint.id = authz.reconciliation_checkpoint_id
      LEFT JOIN public.studio_payment_accounts account
        ON account.studio_id = authz.studio_id
     WHERE authz.studio_id = p_studio_id
       AND authz.scope = p_scope
       AND authz.enabled
       AND authz.expires_at > now()
       AND authz.local_event_ingest_watermark = checkpoint.local_event_ingest_watermark
       AND checkpoint.stripe_livemode
       AND checkpoint.candidate_sha = p_candidate_sha
       AND checkpoint.deployment_ready_sha = p_candidate_sha
       AND checkpoint.evidence_source = 'provider_read'
       AND checkpoint.deployment_ready_url = 'https://koaryu.onrender.com/health/ready'
       AND checkpoint.deployment_ready_verified_at >= now() - INTERVAL '24 hours'
       AND checkpoint.expires_at > now()
       AND checkpoint.unresolved_account_count = 0
       AND checkpoint.failed_event_count = 0
       AND checkpoint.provider_only_event_count = 0
       AND checkpoint.local_only_event_count = 0
       AND checkpoint.enabled_platform_endpoint_count = 1
       AND checkpoint.enabled_connect_endpoint_count = 1
       AND checkpoint.unexpected_enabled_endpoint_count = 0
       AND checkpoint.platform_endpoint_contract_matched
       AND checkpoint.connect_endpoint_contract_matched
       AND checkpoint.platform_delivery_verified_at >= now() - INTERVAL '24 hours'
       AND checkpoint.account_evidence_count = (
           SELECT COUNT(*)
             FROM public.stripe_live_billing_reconciliation_account_evidence evidence
            WHERE evidence.checkpoint_id = checkpoint.id
       )
       AND checkpoint.account_evidence_count = (
           SELECT COUNT(*)
             FROM public.studio_payment_accounts mapped
            WHERE mapped.stripe_connected_account_id IS NOT NULL
       )
       AND NOT EXISTS (
           SELECT 1
             FROM public.studio_payment_accounts mapped
            WHERE mapped.stripe_connected_account_id IS NOT NULL
              AND NOT EXISTS (
                  SELECT 1
                    FROM public.stripe_live_billing_reconciliation_account_evidence evidence
                   WHERE evidence.checkpoint_id = checkpoint.id
                     AND evidence.studio_id = mapped.studio_id
                     AND evidence.stripe_connected_account_id = mapped.stripe_connected_account_id
                     AND evidence.connect_account_generation
                          = private.current_connect_account_generation(mapped.metadata)
                     AND evidence.delivery_verified_at >= now() - INTERVAL '24 hours'
              )
       )
       AND NOT EXISTS (
           SELECT 1 FROM public.stripe_events event
            WHERE event.livemode
              AND event.created_at >= TIMESTAMPTZ '2026-07-13 00:00:00+00'
              AND private.live_billing_event_is_in_scope(event.stripe_account_id, event.type)
              AND event.processing_status IS DISTINCT FROM 'processed'
       )
       AND NOT EXISTS (
           SELECT 1 FROM public.stripe_events event
            WHERE event.livemode
              AND event.created_at >= TIMESTAMPTZ '2026-07-13 00:00:00+00'
              AND event.stripe_account_id IS NOT NULL
              AND NOT EXISTS (
                  SELECT 1 FROM public.studio_payment_accounts mapped
                   WHERE mapped.stripe_connected_account_id = event.stripe_account_id
              )
              AND NOT EXISTS (
                  SELECT 1 FROM public.stripe_connect_account_dispositions disposition
                   WHERE disposition.stripe_connected_account_id = event.stripe_account_id
                     AND disposition.excluded
              )
       )
       AND NOT EXISTS (
           SELECT 1 FROM public.stripe_events event
            WHERE event.livemode
              AND event.live_billing_ingest_sequence > authz.local_event_ingest_watermark
              AND (
                  (
                      private.live_billing_event_is_in_scope(event.stripe_account_id, event.type)
                      AND event.processing_status IS DISTINCT FROM 'processed'
                  )
                  OR (
                      event.stripe_account_id IS NOT NULL
                      AND NOT EXISTS (
                          SELECT 1 FROM public.studio_payment_accounts mapped
                           WHERE mapped.stripe_connected_account_id = event.stripe_account_id
                      )
                      AND NOT EXISTS (
                          SELECT 1 FROM public.stripe_connect_account_dispositions disposition
                           WHERE disposition.stripe_connected_account_id = event.stripe_account_id
                             AND disposition.excluded
                      )
                  )
              )
       )
       AND (
           (p_scope = 'core_subscription'
                AND authz.stripe_connected_account_id IS NULL
                AND p_stripe_connected_account_id IS NULL)
           OR
           (p_scope = 'connect_onboarding'
                AND account.studio_id = p_studio_id
                AND authz.connect_account_generation
                    = private.current_connect_account_generation(account.metadata)
                AND (
                    (p_operation = 'connect_account.create'
                        AND p_stripe_connected_account_id IS NULL
                        AND account.stripe_connected_account_id IS NULL
                        AND authz.stripe_connected_account_id IS NULL)
                    OR
                    (p_operation = 'connect_branding_file.create'
                        AND p_stripe_connected_account_id IS NULL)
                    OR
                    (p_operation NOT IN ('connect_account.create', 'connect_branding_file.create')
                        AND p_stripe_connected_account_id IS NOT NULL
                        AND account.stripe_connected_account_id = p_stripe_connected_account_id
                        AND (authz.stripe_connected_account_id IS NULL
                            OR authz.stripe_connected_account_id = p_stripe_connected_account_id)
                        AND EXISTS (
                            SELECT 1
                              FROM public.stripe_live_billing_reconciliation_account_evidence evidence
                             WHERE evidence.checkpoint_id = checkpoint.id
                               AND evidence.studio_id = p_studio_id
                               AND evidence.stripe_connected_account_id = p_stripe_connected_account_id
                               AND evidence.connect_account_generation
                                    = private.current_connect_account_generation(account.metadata)
                               AND evidence.delivery_verified_at >= now() - INTERVAL '24 hours'
                        ))
                ))
           OR
           (p_scope = 'connect_payments'
                AND p_stripe_connected_account_id IS NOT NULL
                AND authz.stripe_connected_account_id = p_stripe_connected_account_id
                AND authz.connect_account_generation
                    = private.current_connect_account_generation(account.metadata)
                AND account.stripe_connected_account_id = p_stripe_connected_account_id
                AND account.status = 'charges_enabled'
                AND account.charges_enabled
                AND account.payouts_enabled
                AND account.details_submitted
                AND cardinality(account.requirements_due) = 0
                AND EXISTS (
                    SELECT 1
                      FROM public.stripe_live_billing_reconciliation_account_evidence evidence
                     WHERE evidence.checkpoint_id = checkpoint.id
                       AND evidence.studio_id = p_studio_id
                       AND evidence.stripe_connected_account_id = p_stripe_connected_account_id
                       AND evidence.connect_account_generation
                            = private.current_connect_account_generation(account.metadata)
                       AND evidence.delivery_verified_at >= now() - INTERVAL '24 hours'
                ))
       )
     LIMIT 1;
END;
$$;

CREATE FUNCTION public.authorize_connect_onboarding_bootstrap_account_create(
    p_studio_id UUID,
    p_candidate_sha TEXT,
    p_connect_account_generation INTEGER,
    p_bootstrap_token TEXT,
    p_account_create_payload_sha256 TEXT,
    p_initial_link_context_sha256 TEXT,
    p_account_create_idempotency_key TEXT,
    p_initial_link_idempotency_key TEXT
)
RETURNS TABLE(authorized BOOLEAN, studio_id UUID, checkpoint_id UUID, bootstrap_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_authorization RECORD;
    v_token_hash TEXT;
    v_existing public.stripe_connect_onboarding_bootstraps%ROWTYPE;
BEGIN
    IF p_bootstrap_token !~ '^[A-Za-z0-9_-]{43,128}$'
       OR p_account_create_payload_sha256 !~ '^[0-9a-f]{64}$'
       OR p_initial_link_context_sha256 !~ '^[0-9a-f]{64}$'
       OR p_account_create_idempotency_key !~ '^koaryu-connect-account-[0-9a-f-]+-g[1-9][0-9]*$'
       OR p_initial_link_idempotency_key !~ '^koaryu-connect-onboarding-[0-9a-f-]+-g[1-9][0-9]*-[0-9a-f]{24}$'
       OR p_connect_account_generation IS NULL
       OR p_connect_account_generation <= 0 THEN
        RETURN;
    END IF;
    v_token_hash := encode(extensions.digest(convert_to(p_bootstrap_token, 'UTF8'), 'sha256'), 'hex');

    LOCK TABLE
        public.stripe_events,
        public.studio_payment_accounts,
        public.stripe_connect_account_dispositions,
        public.stripe_live_billing_reconciliation_checkpoints,
        public.stripe_live_billing_reconciliation_account_evidence,
        public.studio_live_billing_authorizations,
        public.stripe_connect_onboarding_bootstraps
        IN SHARE ROW EXCLUSIVE MODE;
    SELECT * INTO v_authorization
      FROM public.authorize_studio_live_billing_mutation_atomic(
          p_studio_id, 'connect_account.create', 'connect_onboarding', NULL, p_candidate_sha
      );
    IF NOT FOUND THEN
        RETURN;
    END IF;

    SELECT * INTO v_existing
      FROM public.stripe_connect_onboarding_bootstraps bootstrap
     WHERE bootstrap.bootstrap_token_sha256 = v_token_hash;
    IF FOUND THEN
        IF v_existing.studio_id IS DISTINCT FROM p_studio_id
           OR v_existing.connect_account_generation IS DISTINCT FROM p_connect_account_generation
           OR v_existing.account_create_payload_sha256 IS DISTINCT FROM p_account_create_payload_sha256
           OR v_existing.initial_link_context_sha256 IS DISTINCT FROM p_initial_link_context_sha256
           OR v_existing.account_create_idempotency_key IS DISTINCT FROM p_account_create_idempotency_key
           OR v_existing.initial_link_idempotency_key IS DISTINCT FROM p_initial_link_idempotency_key
           OR v_existing.candidate_sha IS DISTINCT FROM p_candidate_sha
           OR v_existing.reconciliation_checkpoint_id IS DISTINCT FROM v_authorization.checkpoint_id
           OR v_existing.expires_at <= now()
           OR v_existing.aborted_at IS NOT NULL THEN
            RETURN;
        END IF;
        RETURN QUERY SELECT true, p_studio_id, v_authorization.checkpoint_id, v_existing.id;
        RETURN;
    END IF;

    -- Never mint a second account-create permit for a studio generation. An
    -- uncertain provider call may retry only through the exact stored token and
    -- context above, while the original short expiry remains current.
    IF EXISTS (
        SELECT 1
          FROM public.stripe_connect_onboarding_bootstraps bootstrap
         WHERE bootstrap.studio_id = p_studio_id
           AND bootstrap.connect_account_generation = p_connect_account_generation
    ) THEN
        RETURN;
    END IF;

    INSERT INTO public.stripe_connect_onboarding_bootstraps(
        studio_id, connect_account_generation, bootstrap_token_sha256,
        account_create_payload_sha256, initial_link_context_sha256,
        account_create_idempotency_key, initial_link_idempotency_key,
        candidate_sha, reconciliation_checkpoint_id, stripe_livemode, expires_at
    ) VALUES (
        p_studio_id, p_connect_account_generation, v_token_hash,
        p_account_create_payload_sha256, p_initial_link_context_sha256,
        p_account_create_idempotency_key, p_initial_link_idempotency_key,
        p_candidate_sha, v_authorization.checkpoint_id, true, now() + INTERVAL '5 minutes'
    )
    RETURNING id INTO v_existing.id;

    RETURN QUERY SELECT true, p_studio_id, v_authorization.checkpoint_id, v_existing.id;
END;
$$;

CREATE FUNCTION public.bind_connect_onboarding_bootstrap_account(
    p_studio_id UUID,
    p_candidate_sha TEXT,
    p_connect_account_generation INTEGER,
    p_bootstrap_token TEXT,
    p_stripe_connected_account_id TEXT,
    p_business_entity_type TEXT
)
RETURNS public.studio_payment_accounts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_token_hash TEXT;
    v_bootstrap public.stripe_connect_onboarding_bootstraps%ROWTYPE;
    v_account public.studio_payment_accounts%ROWTYPE;
BEGIN
    IF p_bootstrap_token !~ '^[A-Za-z0-9_-]{43,128}$'
       OR p_candidate_sha !~ '^[0-9a-f]{40}$'
       OR p_stripe_connected_account_id !~ '^acct_[A-Za-z0-9]+$'
       OR p_business_entity_type NOT IN ('company', 'individual') THEN
        RAISE EXCEPTION 'Invalid Connect bootstrap binding context.' USING ERRCODE = '22023';
    END IF;
    v_token_hash := encode(extensions.digest(convert_to(p_bootstrap_token, 'UTF8'), 'sha256'), 'hex');

    LOCK TABLE public.studio_payment_accounts, public.stripe_connect_onboarding_bootstraps
        IN SHARE ROW EXCLUSIVE MODE;
    SELECT * INTO v_bootstrap
      FROM public.stripe_connect_onboarding_bootstraps bootstrap
     WHERE bootstrap.bootstrap_token_sha256 = v_token_hash
       AND bootstrap.studio_id = p_studio_id
       AND bootstrap.connect_account_generation = p_connect_account_generation
       AND bootstrap.candidate_sha = p_candidate_sha
       AND bootstrap.expires_at > now()
       AND bootstrap.aborted_at IS NULL;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Connect bootstrap is not bindable.' USING ERRCODE = 'P0B21';
    END IF;

    SELECT * INTO v_account
      FROM public.studio_payment_accounts account
     WHERE account.studio_id = p_studio_id
       AND private.current_connect_account_generation(account.metadata) = p_connect_account_generation
     FOR UPDATE;
    IF NOT FOUND
       OR (v_account.stripe_connected_account_id IS NOT NULL
           AND v_account.stripe_connected_account_id <> p_stripe_connected_account_id)
       OR (v_bootstrap.stripe_connected_account_id IS NOT NULL
           AND v_bootstrap.stripe_connected_account_id <> p_stripe_connected_account_id) THEN
        RAISE EXCEPTION 'Connect account mapping changed during bootstrap.' USING ERRCODE = 'P0B22';
    END IF;

    UPDATE public.studio_payment_accounts
       SET stripe_connected_account_id = p_stripe_connected_account_id,
           status = 'onboarding_incomplete',
           metadata = COALESCE(metadata, '{}'::JSONB)
               || jsonb_build_object(
                    'business_entity_type', p_business_entity_type,
                    'connect_account_generation', p_connect_account_generation
               )
     WHERE studio_id = p_studio_id
     RETURNING * INTO v_account;

    UPDATE public.stripe_connect_onboarding_bootstraps
       SET stripe_connected_account_id = p_stripe_connected_account_id,
           account_bound_at = COALESCE(account_bound_at, now())
     WHERE id = v_bootstrap.id;
    RETURN v_account;
END;
$$;

CREATE FUNCTION public.authorize_connect_onboarding_bootstrap_initial_link(
    p_studio_id UUID,
    p_candidate_sha TEXT,
    p_connect_account_generation INTEGER,
    p_bootstrap_token TEXT,
    p_stripe_connected_account_id TEXT,
    p_initial_link_context_sha256 TEXT,
    p_initial_link_payload_sha256 TEXT,
    p_initial_link_idempotency_key TEXT
)
RETURNS TABLE(authorized BOOLEAN, studio_id UUID, checkpoint_id UUID, bootstrap_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_token_hash TEXT;
    v_bootstrap public.stripe_connect_onboarding_bootstraps%ROWTYPE;
    v_result RECORD;
BEGIN
    IF p_bootstrap_token !~ '^[A-Za-z0-9_-]{43,128}$'
       OR p_candidate_sha !~ '^[0-9a-f]{40}$'
       OR p_stripe_connected_account_id !~ '^acct_[A-Za-z0-9]+$'
       OR p_initial_link_context_sha256 !~ '^[0-9a-f]{64}$'
       OR p_initial_link_payload_sha256 !~ '^[0-9a-f]{64}$'
       OR p_initial_link_idempotency_key !~ '^koaryu-connect-onboarding-[0-9a-f-]+-g[1-9][0-9]*-[0-9a-f]{24}$' THEN
        RETURN;
    END IF;
    v_token_hash := encode(extensions.digest(convert_to(p_bootstrap_token, 'UTF8'), 'sha256'), 'hex');

    LOCK TABLE
        public.stripe_events,
        public.studio_payment_accounts,
        public.stripe_connect_account_dispositions,
        public.stripe_live_billing_reconciliation_checkpoints,
        public.stripe_live_billing_reconciliation_account_evidence,
        public.studio_live_billing_authorizations,
        public.stripe_connect_onboarding_bootstraps
        IN SHARE ROW EXCLUSIVE MODE;

    SELECT * INTO v_bootstrap
      FROM public.stripe_connect_onboarding_bootstraps bootstrap
     WHERE bootstrap.bootstrap_token_sha256 = v_token_hash
       AND bootstrap.studio_id = p_studio_id
       AND bootstrap.connect_account_generation = p_connect_account_generation
       AND bootstrap.stripe_connected_account_id = p_stripe_connected_account_id
       AND bootstrap.initial_link_context_sha256 = p_initial_link_context_sha256
       AND bootstrap.initial_link_idempotency_key = p_initial_link_idempotency_key
       AND bootstrap.candidate_sha = p_candidate_sha
       AND bootstrap.stripe_livemode
       AND bootstrap.account_bound_at IS NOT NULL
       AND bootstrap.expires_at > now()
       AND bootstrap.aborted_at IS NULL
       AND (bootstrap.initial_link_payload_sha256 IS NULL
            OR bootstrap.initial_link_payload_sha256 = p_initial_link_payload_sha256)
     FOR UPDATE;
    IF NOT FOUND THEN
        RETURN;
    END IF;

    SELECT true AS authorized, authz.studio_id, checkpoint.id AS checkpoint_id
      INTO v_result
      FROM public.studio_live_billing_authorizations authz
      JOIN public.stripe_live_billing_reconciliation_checkpoints checkpoint
        ON checkpoint.id = authz.reconciliation_checkpoint_id
      JOIN public.studio_payment_accounts account
        ON account.studio_id = authz.studio_id
     WHERE authz.studio_id = p_studio_id
       AND authz.scope = 'connect_onboarding'
       AND authz.enabled
       AND authz.expires_at > now()
       AND authz.local_event_ingest_watermark = checkpoint.local_event_ingest_watermark
       AND checkpoint.id = v_bootstrap.reconciliation_checkpoint_id
       AND checkpoint.stripe_livemode
       AND checkpoint.candidate_sha = p_candidate_sha
       AND checkpoint.deployment_ready_sha = p_candidate_sha
       AND checkpoint.evidence_source = 'provider_read'
       AND checkpoint.deployment_ready_url = 'https://koaryu.onrender.com/health/ready'
       AND checkpoint.deployment_ready_verified_at >= now() - INTERVAL '24 hours'
       AND checkpoint.expires_at > now()
       AND checkpoint.unresolved_account_count = 0
       AND checkpoint.failed_event_count = 0
       AND checkpoint.provider_only_event_count = 0
       AND checkpoint.local_only_event_count = 0
       AND checkpoint.enabled_platform_endpoint_count = 1
       AND checkpoint.enabled_connect_endpoint_count = 1
       AND checkpoint.unexpected_enabled_endpoint_count = 0
       AND checkpoint.platform_endpoint_contract_matched
       AND checkpoint.connect_endpoint_contract_matched
       AND checkpoint.platform_delivery_verified_at >= now() - INTERVAL '24 hours'
       AND account.stripe_connected_account_id = p_stripe_connected_account_id
       AND private.current_connect_account_generation(account.metadata) = p_connect_account_generation
       AND authz.connect_account_generation = p_connect_account_generation
       AND (authz.stripe_connected_account_id IS NULL
            OR authz.stripe_connected_account_id = p_stripe_connected_account_id)
       -- The only evidence waiver: exactly the bootstrap account/generation.
       AND checkpoint.account_evidence_count = (
           SELECT COUNT(*)
             FROM public.stripe_live_billing_reconciliation_account_evidence evidence
            WHERE evidence.checkpoint_id = checkpoint.id
       )
       AND checkpoint.account_evidence_count + 1 = (
           SELECT COUNT(*)
             FROM public.studio_payment_accounts mapped
            WHERE mapped.stripe_connected_account_id IS NOT NULL
       )
       AND NOT EXISTS (
           SELECT 1
             FROM public.studio_payment_accounts mapped
            WHERE mapped.stripe_connected_account_id IS NOT NULL
              AND NOT (
                  mapped.studio_id = p_studio_id
                  AND mapped.stripe_connected_account_id = p_stripe_connected_account_id
                  AND private.current_connect_account_generation(mapped.metadata) = p_connect_account_generation
              )
              AND NOT EXISTS (
                  SELECT 1
                    FROM public.stripe_live_billing_reconciliation_account_evidence evidence
                   WHERE evidence.checkpoint_id = checkpoint.id
                     AND evidence.studio_id = mapped.studio_id
                     AND evidence.stripe_connected_account_id = mapped.stripe_connected_account_id
                     AND evidence.connect_account_generation
                          = private.current_connect_account_generation(mapped.metadata)
                     AND evidence.delivery_verified_at >= now() - INTERVAL '24 hours'
              )
       )
       AND NOT EXISTS (
           SELECT 1 FROM public.stripe_events event
            WHERE event.livemode
              AND event.created_at >= TIMESTAMPTZ '2026-07-13 00:00:00+00'
              AND private.live_billing_event_is_in_scope(event.stripe_account_id, event.type)
              AND event.processing_status IS DISTINCT FROM 'processed'
       )
       AND NOT EXISTS (
           SELECT 1 FROM public.stripe_events event
            WHERE event.livemode
              AND event.created_at >= TIMESTAMPTZ '2026-07-13 00:00:00+00'
              AND event.stripe_account_id IS NOT NULL
              AND NOT EXISTS (
                  SELECT 1 FROM public.studio_payment_accounts mapped
                   WHERE mapped.stripe_connected_account_id = event.stripe_account_id
              )
              AND NOT EXISTS (
                  SELECT 1 FROM public.stripe_connect_account_dispositions disposition
                   WHERE disposition.stripe_connected_account_id = event.stripe_account_id
                     AND disposition.excluded
              )
       )
       AND NOT EXISTS (
           SELECT 1 FROM public.stripe_events event
            WHERE event.livemode
              AND event.live_billing_ingest_sequence > authz.local_event_ingest_watermark
              AND (
                  (
                      private.live_billing_event_is_in_scope(event.stripe_account_id, event.type)
                      AND event.processing_status IS DISTINCT FROM 'processed'
                  )
                  OR (
                      event.stripe_account_id IS NOT NULL
                      AND NOT EXISTS (
                          SELECT 1 FROM public.studio_payment_accounts mapped
                           WHERE mapped.stripe_connected_account_id = event.stripe_account_id
                      )
                      AND NOT EXISTS (
                          SELECT 1 FROM public.stripe_connect_account_dispositions disposition
                           WHERE disposition.stripe_connected_account_id = event.stripe_account_id
                             AND disposition.excluded
                      )
                  )
              )
       )
     LIMIT 1;
    IF NOT FOUND THEN
        RETURN;
    END IF;

    UPDATE public.stripe_connect_onboarding_bootstraps
       SET initial_link_payload_sha256 = COALESCE(initial_link_payload_sha256, p_initial_link_payload_sha256),
           initial_link_claimed_at = COALESCE(initial_link_claimed_at, now()),
           initial_link_last_retry_at = CASE
               WHEN initial_link_claimed_at IS NULL THEN initial_link_last_retry_at
               ELSE now()
           END
     WHERE id = v_bootstrap.id;

    RETURN QUERY SELECT true, p_studio_id, v_result.checkpoint_id, v_bootstrap.id;
END;
$$;

REVOKE ALL ON FUNCTION public.authorize_connect_onboarding_bootstrap_account_create(
    UUID, TEXT, INTEGER, TEXT, TEXT, TEXT, TEXT, TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.authorize_connect_onboarding_bootstrap_account_create(
    UUID, TEXT, INTEGER, TEXT, TEXT, TEXT, TEXT, TEXT
) TO service_role;

REVOKE ALL ON FUNCTION public.bind_connect_onboarding_bootstrap_account(
    UUID, TEXT, INTEGER, TEXT, TEXT, TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bind_connect_onboarding_bootstrap_account(
    UUID, TEXT, INTEGER, TEXT, TEXT, TEXT
) TO service_role;

REVOKE ALL ON FUNCTION public.authorize_connect_onboarding_bootstrap_initial_link(
    UUID, TEXT, INTEGER, TEXT, TEXT, TEXT, TEXT, TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.authorize_connect_onboarding_bootstrap_initial_link(
    UUID, TEXT, INTEGER, TEXT, TEXT, TEXT, TEXT, TEXT
) TO service_role;

COMMENT ON TABLE public.stripe_connect_onboarding_bootstraps IS
    'Short-lived, single-account permits for account creation through the first hosted Account Link; token material is stored only as SHA-256.';

CREATE OR REPLACE FUNCTION public.koaryu_release_schema_preflight()
RETURNS TABLE (
    ready BOOLEAN,
    migration_count INTEGER,
    migration_head TEXT,
    pending_versions TEXT[],
    security_failures TEXT[]
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog
AS $$
DECLARE
    v_count INTEGER;
    v_head TEXT;
    v_pending TEXT[];
    v_baseline TEXT;
    v_failures TEXT[] := ARRAY[]::TEXT[];
    v_required_tables CONSTANT TEXT[] := ARRAY[
        'operational_alert_audit_events',
        'operational_alert_delivery_attempts',
        'operational_alert_delivery_outcomes',
        'operational_alert_episodes',
        'operational_alert_heartbeats',
        'operational_alert_outbox',
        'stripe_connect_account_dispositions',
        'stripe_connect_onboarding_bootstraps',
        'stripe_live_billing_reconciliation_account_evidence',
        'stripe_live_billing_reconciliation_checkpoints',
        'studio_live_billing_authorizations'
    ];
    v_required_functions CONSTANT TEXT[] := ARRAY[
        'public.claim_operational_alert_delivery(text,text,uuid,integer)',
        'public.clear_studio_comp_for_billing_event(uuid,bigint)',
        'public.complete_operational_alert_delivery(uuid,text,text)',
        'public.enforce_operational_alert_sent_receipt()',
        'public.evaluate_operational_alert(text,text,bigint,integer,integer,text,text,text,text)',
        'public.evaluate_operational_alert(text,text,bigint,integer,integer,text,text,integer,text,text,text)',
        'public.fail_operational_alert_delivery(uuid,text,text,integer)',
        'public.finish_stripe_event_processing_v2(uuid,text,text,text,text)',
        'public.koaryu_release_schema_preflight()',
        'public.operational_alert_heartbeats(text)',
        'public.operational_alert_metric_counts()',
        'public.preserve_studio_comp_provenance()',
        'public.prevent_operational_alert_append_only_mutation()',
        'public.record_operational_alert_heartbeat(text,text,text)',
        'public.record_stripe_live_billing_reconciliation_checkpoint(text,integer,integer,integer,integer,integer,integer,timestamp with time zone,timestamp with time zone,integer,integer,boolean,boolean,timestamp with time zone,text,text,uuid,text)',
        'public.record_stripe_live_billing_reconciliation_checkpoint_v2(jsonb,timestamp with time zone,text,text,uuid,text)',
        'public.authorize_studio_live_billing_mutation_atomic(uuid,text,text,text,text)',
        'public.authorize_connect_onboarding_bootstrap_account_create(uuid,text,integer,text,text,text,text,text)',
        'public.bind_connect_onboarding_bootstrap_account(uuid,text,integer,text,text,text)',
        'public.authorize_connect_onboarding_bootstrap_initial_link(uuid,text,integer,text,text,text,text,text)',
        'private.live_billing_event_is_in_scope(text,text)',
        'private.enforce_live_billing_checkpoint_processed_events()',
        'public.acknowledge_operational_alert(text,uuid,text,text)',
        'private.current_connect_account_generation(jsonb)',
        'private.bind_live_billing_authorization_checkpoint()',
        'public.set_stripe_connect_account_exclusion_atomic(text,boolean,text,uuid,text)',
        'public.set_studio_comp_atomic(uuid,boolean,text,uuid,text,boolean)',
        'public.set_studio_live_billing_authorization_atomic(uuid,text,boolean,timestamp with time zone,text,uuid,text,text)'
    ];
    v_function TEXT;
    v_table TEXT;
BEGIN
    SELECT count(*)::INTEGER, max(version),
           array_agg(version ORDER BY version) FILTER (WHERE version >= '20260727100000'),
           count(*) FILTER (WHERE version < '20260727100000')::TEXT || ':' ||
             md5(string_agg(version || ':' || name, '|' ORDER BY version)
                 FILTER (WHERE version < '20260727100000'))
      INTO v_count, v_head, v_pending, v_baseline
      FROM supabase_migrations.schema_migrations;

    IF v_count <> 92
       OR v_head <> '20260801091000'
       OR v_pending IS DISTINCT FROM ARRAY[
           '20260727100000',
           '20260727110000',
           '20260801050957',
           '20260801060000',
           '20260801070000',
           '20260801080000',
           '20260801090000',
           '20260801091000'
       ]::TEXT[]
       OR v_baseline <> '84:57ae4269ef4d75c249d59ef297661a3a' THEN
        v_failures := array_append(v_failures, 'migration_history');
    END IF;

    FOREACH v_table IN ARRAY v_required_tables LOOP
        IF NOT EXISTS (
            SELECT 1
              FROM pg_class relation
              JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
             WHERE namespace.nspname = 'public'
               AND relation.relname = v_table
               AND relation.relkind = 'r'
               AND relation.relrowsecurity
               AND NOT EXISTS (
                   SELECT 1
                     FROM aclexplode(coalesce(
                         relation.relacl,
                         acldefault('r', relation.relowner)
                     )) acl
                    WHERE acl.grantee = 0
                      AND acl.privilege_type IN (
                          'SELECT', 'INSERT', 'UPDATE', 'DELETE',
                          'TRUNCATE', 'REFERENCES', 'TRIGGER'
                      )
               )
               AND NOT has_table_privilege('anon', relation.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
               AND NOT has_table_privilege('authenticated', relation.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        ) THEN
            v_failures := array_append(v_failures, 'table:' || v_table);
        END IF;
    END LOOP;

    IF EXISTS (
        WITH expected(
            table_name, policy_name, permissive, command_name,
            role_names, predicate_kind
        ) AS (
            VALUES
              ('studio_live_billing_authorizations', 'studio_live_billing_authorizations_no_client_access', false, '*', 'anon,authenticated', 'deny_all'),
              ('studio_live_billing_authorizations', 'reject_ambiguous_staff_membership_access', false, '*', 'authenticated', 'membership_guard'),
              ('stripe_live_billing_reconciliation_checkpoints', 'stripe_live_billing_reconciliation_checkpoints_no_client_access', false, '*', 'anon,authenticated', 'deny_all'),
              ('stripe_live_billing_reconciliation_checkpoints', 'reject_ambiguous_staff_membership_access', false, '*', 'authenticated', 'membership_guard'),
              ('stripe_connect_account_dispositions', 'stripe_connect_account_dispositions_no_client_access', false, '*', 'anon,authenticated', 'deny_all'),
              ('stripe_connect_account_dispositions', 'reject_ambiguous_staff_membership_access', false, '*', 'authenticated', 'membership_guard'),
              ('stripe_live_billing_reconciliation_account_evidence', 'stripe_live_billing_account_evidence_no_client_access', false, '*', 'anon,authenticated', 'deny_all'),
              ('stripe_live_billing_reconciliation_account_evidence', 'reject_ambiguous_staff_membership_access', false, '*', 'authenticated', 'membership_guard'),
              ('stripe_connect_onboarding_bootstraps', 'stripe_connect_onboarding_bootstraps_no_client_access', false, '*', 'anon,authenticated', 'deny_all'),
              ('stripe_connect_onboarding_bootstraps', 'reject_ambiguous_staff_membership_access', false, '*', 'authenticated', 'membership_guard'),
              ('operational_alert_episodes', 'reject_ambiguous_staff_membership_access', false, '*', 'authenticated', 'membership_guard'),
              ('operational_alert_outbox', 'reject_ambiguous_staff_membership_access', false, '*', 'authenticated', 'membership_guard'),
              ('operational_alert_delivery_attempts', 'reject_ambiguous_staff_membership_access', false, '*', 'authenticated', 'membership_guard'),
              ('operational_alert_delivery_outcomes', 'reject_ambiguous_staff_membership_access', false, '*', 'authenticated', 'membership_guard'),
              ('operational_alert_audit_events', 'reject_ambiguous_staff_membership_access', false, '*', 'authenticated', 'membership_guard'),
              ('operational_alert_heartbeats', 'reject_ambiguous_staff_membership_access', false, '*', 'authenticated', 'membership_guard')
        ),
        actual AS (
            SELECT relation.relname AS table_name,
                   policy.polname AS policy_name,
                   policy.polpermissive AS permissive,
                   policy.polcmd::TEXT AS command_name,
                   (
                       SELECT string_agg(role.rolname, ',' ORDER BY role.rolname)
                         FROM unnest(policy.polroles) role_oid
                         JOIN pg_roles role ON role.oid = role_oid
                   ) AS role_names,
                   CASE
                     WHEN regexp_replace(pg_get_expr(policy.polqual, policy.polrelid), '[[:space:]()]', '', 'g') = 'false'
                      AND regexp_replace(pg_get_expr(policy.polwithcheck, policy.polrelid), '[[:space:]()]', '', 'g') = 'false'
                       THEN 'deny_all'
                     WHEN regexp_replace(
                            regexp_replace(pg_get_expr(policy.polqual, policy.polrelid), '[[:space:]()]', '', 'g'),
                            'AShas_unambiguous_studio_membership$', ''
                          ) = 'SELECTprivate.has_unambiguous_studio_membership'
                      AND regexp_replace(
                            regexp_replace(pg_get_expr(policy.polwithcheck, policy.polrelid), '[[:space:]()]', '', 'g'),
                            'AShas_unambiguous_studio_membership$', ''
                          ) = 'SELECTprivate.has_unambiguous_studio_membership'
                       THEN 'membership_guard'
                     ELSE 'unexpected'
                   END AS predicate_kind
              FROM pg_policy policy
              JOIN pg_class relation ON relation.oid = policy.polrelid
              JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
             WHERE namespace.nspname = 'public'
               AND relation.relname = ANY(v_required_tables)
        ),
        compared AS (
            SELECT expected.table_name AS expected_table,
                   actual.table_name AS actual_table,
                   expected.policy_name AS expected_policy,
                   actual.policy_name AS actual_policy,
                   expected.permissive AS expected_permissive,
                   actual.permissive AS actual_permissive,
                   expected.command_name AS expected_command,
                   actual.command_name AS actual_command,
                   expected.role_names AS expected_roles,
                   actual.role_names AS actual_roles,
                   expected.predicate_kind AS expected_predicate,
                   actual.predicate_kind AS actual_predicate
              FROM expected
              FULL JOIN actual USING (table_name, policy_name)
        )
        SELECT 1
          FROM compared
         WHERE expected_table IS NULL
            OR actual_table IS NULL
            OR actual_permissive IS DISTINCT FROM expected_permissive
            OR actual_command IS DISTINCT FROM expected_command
            OR actual_roles IS DISTINCT FROM expected_roles
            OR actual_predicate IS DISTINCT FROM expected_predicate
    ) THEN
        v_failures := array_append(v_failures, 'policy_manifest');
    END IF;

    IF to_regclass('private.stripe_connect_account_identity_guards') IS NULL
       OR has_table_privilege('anon', 'private.stripe_connect_account_identity_guards', 'SELECT,INSERT,UPDATE,DELETE')
       OR has_table_privilege('authenticated', 'private.stripe_connect_account_identity_guards', 'SELECT,INSERT,UPDATE,DELETE')
       OR has_table_privilege('service_role', 'private.stripe_connect_account_identity_guards', 'SELECT,INSERT,UPDATE,DELETE')
       OR EXISTS (
           SELECT 1
             FROM pg_class relation
             JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
             CROSS JOIN LATERAL aclexplode(coalesce(
                 relation.relacl,
                 acldefault('r', relation.relowner)
             )) acl
            WHERE namespace.nspname = 'private'
              AND relation.relname = 'stripe_connect_account_identity_guards'
              AND acl.grantee = 0
       ) THEN
        v_failures := array_append(v_failures, 'private_identity_guard');
    END IF;

    IF pg_get_serial_sequence('public.stripe_live_billing_reconciliation_checkpoints', 'checkpoint_sequence') IS NULL
       OR pg_get_serial_sequence('public.operational_alert_audit_events', 'id') IS NULL
       OR pg_get_serial_sequence('public.stripe_events', 'live_billing_ingest_sequence') IS NULL
       OR has_sequence_privilege('anon', pg_get_serial_sequence('public.stripe_live_billing_reconciliation_checkpoints', 'checkpoint_sequence'), 'USAGE,SELECT,UPDATE')
       OR has_sequence_privilege('authenticated', pg_get_serial_sequence('public.stripe_live_billing_reconciliation_checkpoints', 'checkpoint_sequence'), 'USAGE,SELECT,UPDATE')
       OR has_sequence_privilege('anon', pg_get_serial_sequence('public.operational_alert_audit_events', 'id'), 'USAGE,SELECT,UPDATE')
       OR has_sequence_privilege('authenticated', pg_get_serial_sequence('public.operational_alert_audit_events', 'id'), 'USAGE,SELECT,UPDATE')
       OR has_sequence_privilege('anon', pg_get_serial_sequence('public.stripe_events', 'live_billing_ingest_sequence'), 'USAGE,SELECT,UPDATE')
       OR has_sequence_privilege('authenticated', pg_get_serial_sequence('public.stripe_events', 'live_billing_ingest_sequence'), 'USAGE,SELECT,UPDATE')
       OR NOT has_sequence_privilege('service_role', pg_get_serial_sequence('public.stripe_live_billing_reconciliation_checkpoints', 'checkpoint_sequence'), 'USAGE')
       OR NOT has_sequence_privilege('service_role', pg_get_serial_sequence('public.stripe_live_billing_reconciliation_checkpoints', 'checkpoint_sequence'), 'SELECT')
       OR has_sequence_privilege('service_role', pg_get_serial_sequence('public.stripe_live_billing_reconciliation_checkpoints', 'checkpoint_sequence'), 'UPDATE')
       OR NOT has_sequence_privilege('service_role', pg_get_serial_sequence('public.operational_alert_audit_events', 'id'), 'USAGE')
       OR NOT has_sequence_privilege('service_role', pg_get_serial_sequence('public.operational_alert_audit_events', 'id'), 'SELECT')
       OR has_sequence_privilege('service_role', pg_get_serial_sequence('public.operational_alert_audit_events', 'id'), 'UPDATE')
       OR NOT has_sequence_privilege('service_role', pg_get_serial_sequence('public.stripe_events', 'live_billing_ingest_sequence'), 'USAGE')
       OR NOT has_sequence_privilege('service_role', pg_get_serial_sequence('public.stripe_events', 'live_billing_ingest_sequence'), 'SELECT')
       OR has_sequence_privilege('service_role', pg_get_serial_sequence('public.stripe_events', 'live_billing_ingest_sequence'), 'UPDATE')
       OR EXISTS (
           SELECT 1
             FROM pg_class sequence
             JOIN pg_namespace namespace ON namespace.oid = sequence.relnamespace
             CROSS JOIN LATERAL aclexplode(coalesce(
                 sequence.relacl,
                 acldefault('S', sequence.relowner)
             )) acl
            WHERE namespace.nspname = 'public'
              AND sequence.oid IN (
                  to_regclass(pg_get_serial_sequence('public.stripe_live_billing_reconciliation_checkpoints', 'checkpoint_sequence')),
                  to_regclass(pg_get_serial_sequence('public.operational_alert_audit_events', 'id')),
                  to_regclass(pg_get_serial_sequence('public.stripe_events', 'live_billing_ingest_sequence'))
              )
              AND acl.grantee = 0
       ) THEN
        v_failures := array_append(v_failures, 'sequence_acl');
    END IF;

    FOREACH v_function IN ARRAY v_required_functions LOOP
        IF to_regprocedure(v_function) IS NULL
           OR has_function_privilege('anon', v_function, 'EXECUTE')
           OR has_function_privilege('authenticated', v_function, 'EXECUTE')
           OR EXISTS (
               SELECT 1
                 FROM pg_proc function
                WHERE function.oid = to_regprocedure(v_function)
                  AND EXISTS (
                      SELECT 1
                        FROM aclexplode(coalesce(
                            function.proacl,
                            acldefault('f', function.proowner)
                        )) acl
                       WHERE acl.grantee = 0
                         AND acl.privilege_type = 'EXECUTE'
                  )
           ) THEN
            v_failures := array_append(v_failures, 'function:' || v_function);
        END IF;
    END LOOP;

    IF NOT has_table_privilege('service_role', 'public.stripe_live_billing_reconciliation_account_evidence', 'SELECT')
       OR has_table_privilege('service_role', 'public.stripe_live_billing_reconciliation_account_evidence', 'INSERT,UPDATE,DELETE')
       OR has_table_privilege('service_role', 'public.stripe_connect_onboarding_bootstraps', 'SELECT,INSERT,UPDATE,DELETE') THEN
        v_failures := array_append(v_failures, 'billing_account_evidence_acl');
    END IF;

    IF EXISTS (
        WITH expected(signature, search_path_config, security_definer, service_execute) AS (
            VALUES
              ('public.record_stripe_live_billing_reconciliation_checkpoint(text, integer, integer, integer, integer, integer, integer, timestamp with time zone, timestamp with time zone, integer, integer, boolean, boolean, timestamp with time zone, text, text, uuid, text)', 'search_path=public, pg_temp', true, false),
              ('public.record_stripe_live_billing_reconciliation_checkpoint_v2(jsonb, timestamp with time zone, text, text, uuid, text)', 'search_path=""', true, true),
              ('public.authorize_studio_live_billing_mutation_atomic(uuid, text, text, text, text)', 'search_path=""', true, true),
              ('public.authorize_connect_onboarding_bootstrap_account_create(uuid, text, integer, text, text, text, text, text)', 'search_path=""', true, true),
              ('public.bind_connect_onboarding_bootstrap_account(uuid, text, integer, text, text, text)', 'search_path=""', true, true),
              ('public.authorize_connect_onboarding_bootstrap_initial_link(uuid, text, integer, text, text, text, text, text)', 'search_path=""', true, true),
              ('private.live_billing_event_is_in_scope(text, text)', 'search_path=""', true, false),
              ('private.enforce_live_billing_checkpoint_processed_events()', 'search_path=""', true, false),
              ('private.current_connect_account_generation(jsonb)', 'search_path=""', false, true),
              ('private.bind_live_billing_authorization_checkpoint()', 'search_path=""', true, false),
              ('public.evaluate_operational_alert(text, text, bigint, integer, integer, text, text, text, text)', 'search_path=public, pg_temp', false, false),
              ('public.evaluate_operational_alert(text, text, bigint, integer, integer, text, text, integer, text, text, text)', 'search_path=public, pg_temp', false, true),
              ('public.acknowledge_operational_alert(text, uuid, text, text)', 'search_path=public, pg_temp', false, true),
              ('public.claim_operational_alert_delivery(text, text, uuid, integer)', 'search_path=public, pg_temp', false, true),
              ('public.complete_operational_alert_delivery(uuid, text, text)', 'search_path=public, pg_temp', false, true),
              ('public.fail_operational_alert_delivery(uuid, text, text, integer)', 'search_path=public, pg_temp', false, true)
        ), actual AS (
            SELECT format('%I.%I(%s)', namespace.nspname, function.proname, oidvectortypes(function.proargtypes)) AS signature,
                   owner.rolname AS owner_name,
                   language.lanname AS language_name,
                   function.prosecdef AS security_definer,
                   coalesce(array_to_string(function.proconfig, ','), '') AS search_path_config,
                   has_function_privilege('service_role', function.oid, 'EXECUTE') AS service_execute
              FROM pg_proc function
              JOIN pg_namespace namespace ON namespace.oid = function.pronamespace
              JOIN pg_roles owner ON owner.oid = function.proowner
              JOIN pg_language language ON language.oid = function.prolang
        )
        SELECT 1 FROM expected
        LEFT JOIN actual USING (signature)
        WHERE actual.signature IS NULL
           OR actual.owner_name <> 'postgres'
           OR actual.language_name <> 'plpgsql'
           OR actual.security_definer IS DISTINCT FROM expected.security_definer
           OR actual.search_path_config IS DISTINCT FROM expected.search_path_config
           OR actual.service_execute IS DISTINCT FROM expected.service_execute
    ) THEN
        v_failures := array_append(v_failures, 'billing_alert_function_manifest');
    END IF;

    IF EXISTS (
        WITH expected(table_name, column_name, data_type, nullable, identity_column) AS (
            VALUES
              ('stripe_events', 'error_reference', 'text', true, false),
              ('stripe_events', 'live_billing_ingest_sequence', 'bigint', false, true),
              ('stripe_live_billing_reconciliation_checkpoints', 'evidence_source', 'text', true, false),
              ('stripe_live_billing_reconciliation_checkpoints', 'deployment_ready_url', 'text', true, false),
              ('stripe_live_billing_reconciliation_checkpoints', 'deployment_ready_sha', 'text', true, false),
              ('stripe_live_billing_reconciliation_checkpoints', 'deployment_ready_verified_at', 'timestamp with time zone', true, false),
              ('stripe_live_billing_reconciliation_checkpoints', 'event_window_started_at', 'timestamp with time zone', true, false),
              ('stripe_live_billing_reconciliation_checkpoints', 'event_window_ended_at', 'timestamp with time zone', true, false),
              ('stripe_live_billing_reconciliation_checkpoints', 'local_event_ingest_watermark', 'bigint', true, false),
              ('stripe_live_billing_reconciliation_checkpoints', 'bounded_provider_event_count', 'integer', true, false),
              ('stripe_live_billing_reconciliation_checkpoints', 'bounded_local_event_count', 'integer', true, false),
              ('stripe_live_billing_reconciliation_checkpoints', 'provider_only_event_count', 'integer', true, false),
              ('stripe_live_billing_reconciliation_checkpoints', 'local_only_event_count', 'integer', true, false),
              ('stripe_live_billing_reconciliation_checkpoints', 'platform_provider_event_count', 'integer', true, false),
              ('stripe_live_billing_reconciliation_checkpoints', 'platform_local_event_count', 'integer', true, false),
              ('stripe_live_billing_reconciliation_checkpoints', 'platform_delivery_verified_at', 'timestamp with time zone', true, false),
              ('stripe_live_billing_reconciliation_checkpoints', 'unexpected_enabled_endpoint_count', 'integer', true, false),
              ('stripe_live_billing_reconciliation_checkpoints', 'account_evidence_count', 'integer', true, false),
              ('studio_live_billing_authorizations', 'reconciliation_checkpoint_id', 'uuid', true, false),
              ('studio_live_billing_authorizations', 'local_event_ingest_watermark', 'bigint', true, false),
              ('stripe_connect_onboarding_bootstraps', 'bootstrap_token_sha256', 'text', false, false),
              ('stripe_connect_onboarding_bootstraps', 'connect_account_generation', 'integer', false, false),
              ('stripe_connect_onboarding_bootstraps', 'initial_link_payload_sha256', 'text', true, false),
              ('stripe_connect_onboarding_bootstraps', 'stripe_connected_account_id', 'text', true, false),
              ('stripe_connect_onboarding_bootstraps', 'expires_at', 'timestamp with time zone', false, false),
              ('stripe_connect_onboarding_bootstraps', 'initial_link_claimed_at', 'timestamp with time zone', true, false),
              ('operational_alert_episodes', 'backup_destination_id', 'text', false, false),
              ('operational_alert_episodes', 'escalation_after_minutes', 'integer', false, false),
              ('operational_alert_episodes', 'acknowledged_at', 'timestamp with time zone', true, false),
              ('operational_alert_episodes', 'acknowledged_by_role', 'text', true, false),
              ('operational_alert_episodes', 'acknowledged_actor_ref', 'text', true, false),
              ('operational_alert_outbox', 'event_kind', 'text', false, false),
              ('operational_alert_outbox', 'destination_role', 'text', false, false)
        )
        SELECT 1 FROM expected
        LEFT JOIN information_schema.columns actual
          ON actual.table_schema = 'public'
         AND actual.table_name = expected.table_name
         AND actual.column_name = expected.column_name
        WHERE actual.column_name IS NULL
           OR actual.data_type IS DISTINCT FROM expected.data_type
           OR (actual.is_nullable = 'YES') IS DISTINCT FROM expected.nullable
           OR (actual.is_identity = 'YES') IS DISTINCT FROM expected.identity_column
    ) THEN
        v_failures := array_append(v_failures, 'column_manifest');
    END IF;

    IF EXISTS (
        WITH expected(table_name, constraint_identity, constraint_type) AS (
            VALUES
              ('stripe_live_billing_reconciliation_checkpoints', 'stripe_live_checkpoint_source_contract', 'c'),
              ('stripe_live_billing_reconciliation_checkpoints', 'stripe_live_checkpoint_ready_url_contract', 'c'),
              ('stripe_live_billing_reconciliation_checkpoints', 'stripe_live_checkpoint_ready_sha_contract', 'c'),
              ('stripe_live_billing_reconciliation_checkpoints', 'stripe_live_checkpoint_window_contract', 'c'),
              ('stripe_live_billing_reconciliation_checkpoints', 'stripe_live_checkpoint_watermark_contract', 'c'),
              ('stripe_live_billing_reconciliation_checkpoints', 'stripe_live_checkpoint_gap_contract', 'c'),
              ('studio_live_billing_authorizations', 'studio_live_billing_checkpoint_binding', 'c'),
              ('stripe_live_billing_reconciliation_account_evidence', 'primary:checkpoint_id,stripe_connected_account_id', 'p'),
              ('stripe_live_billing_reconciliation_account_evidence', 'unique:checkpoint_id,studio_id', 'u'),
              ('operational_alert_episodes', 'operational_alert_episode_ack_complete', 'c'),
              ('operational_alert_outbox', 'operational_alert_outbox_episode_event_role_key', 'u'),
              ('operational_alert_audit_events', 'operational_alert_audit_events_event_type_check', 'c')
        ), actual AS (
            SELECT relation.relname AS table_name,
                   CASE
                     WHEN relation.relname = 'stripe_live_billing_reconciliation_account_evidence'
                      AND constraint_state.contype = 'p'
                       THEN 'primary:' || columns.column_names
                     WHEN relation.relname = 'stripe_live_billing_reconciliation_account_evidence'
                      AND constraint_state.contype = 'u'
                       THEN 'unique:' || columns.column_names
                     ELSE constraint_state.conname
                   END AS constraint_identity,
                   constraint_state.contype::TEXT AS constraint_type,
                   constraint_state.convalidated
              FROM pg_constraint constraint_state
              JOIN pg_class relation ON relation.oid = constraint_state.conrelid
              JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
              LEFT JOIN LATERAL (
                  SELECT string_agg(attribute.attname, ',' ORDER BY key_position.ordinality) AS column_names
                    FROM unnest(constraint_state.conkey) WITH ORDINALITY key_position(attnum, ordinality)
                    JOIN pg_attribute attribute
                      ON attribute.attrelid = constraint_state.conrelid
                     AND attribute.attnum = key_position.attnum
              ) columns ON true
             WHERE namespace.nspname = 'public'
        )
        SELECT 1 FROM expected
        LEFT JOIN actual USING (table_name, constraint_identity)
        WHERE actual.constraint_identity IS NULL
           OR actual.constraint_type IS DISTINCT FROM expected.constraint_type
           OR NOT actual.convalidated
    ) THEN
        v_failures := array_append(v_failures, 'constraint_manifest');
    END IF;

    IF NOT EXISTS (
        SELECT 1
          FROM pg_trigger trigger
          JOIN pg_class relation ON relation.oid = trigger.tgrelid
          JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
         WHERE namespace.nspname = 'public'
           AND relation.relname = 'studio_payment_accounts'
           AND trigger.tgname = 'sync_connect_identity_mapping_guard'
           AND trigger.tgenabled = 'O'
           AND NOT trigger.tgisinternal
    ) OR NOT EXISTS (
        SELECT 1
          FROM pg_trigger trigger
          JOIN pg_class relation ON relation.oid = trigger.tgrelid
          JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
         WHERE namespace.nspname = 'public'
           AND relation.relname = 'stripe_connect_account_dispositions'
           AND trigger.tgname = 'sync_connect_identity_exclusion_guard'
           AND trigger.tgenabled = 'O'
           AND NOT trigger.tgisinternal
    ) THEN
        v_failures := array_append(v_failures, 'identity_guard_triggers');
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger trigger
        WHERE trigger.tgrelid = 'public.studio_live_billing_authorizations'::REGCLASS
          AND trigger.tgname = 'bind_live_billing_authorization_checkpoint'
          AND trigger.tgfoid = 'private.bind_live_billing_authorization_checkpoint()'::REGPROCEDURE
          AND trigger.tgtype = 23 AND trigger.tgenabled = 'O' AND NOT trigger.tgisinternal
    ) OR NOT EXISTS (
        SELECT 1 FROM pg_index index_state
        WHERE index_state.indexrelid = 'public.idx_stripe_events_live_billing_ingest_sequence'::REGCLASS
          AND index_state.indrelid = 'public.stripe_events'::REGCLASS
          AND index_state.indisunique AND index_state.indisvalid AND index_state.indisready
    ) OR NOT EXISTS (
        SELECT 1 FROM pg_trigger trigger
        WHERE trigger.tgrelid = 'public.stripe_live_billing_reconciliation_checkpoints'::REGCLASS
          AND trigger.tgname = 'enforce_live_billing_checkpoint_processed_events'
          AND trigger.tgfoid = 'private.enforce_live_billing_checkpoint_processed_events()'::REGPROCEDURE
          AND trigger.tgenabled = 'O' AND NOT trigger.tgisinternal
    ) THEN
        v_failures := array_append(v_failures, 'billing_trigger_index_manifest');
    END IF;

    RETURN QUERY SELECT
        cardinality(v_failures) = 0,
        v_count,
        v_head,
        COALESCE(v_pending, ARRAY[]::TEXT[]),
        v_failures;
END;
$$;
