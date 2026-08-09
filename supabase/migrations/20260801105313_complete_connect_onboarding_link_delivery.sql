-- Retire a one-generation Connect bootstrap only after the authenticated
-- browser has safely received and acknowledged the initial Account Link.
-- A delivery acknowledgement is not Stripe/KYC readiness and cannot authorize
-- a provider mutation. Raw receipts never enter persistent storage.

ALTER TABLE public.stripe_connect_onboarding_bootstraps
    ADD COLUMN initial_link_response_sha256 TEXT,
    ADD COLUMN initial_link_response_recorded_at TIMESTAMPTZ,
    ADD COLUMN initial_link_delivery_receipt_sha256 TEXT,
    ADD COLUMN initial_link_delivery_receipt_expires_at TIMESTAMPTZ,
    ADD COLUMN initial_link_delivered_at TIMESTAMPTZ,
    ADD COLUMN initial_link_support_required_at TIMESTAMPTZ;

ALTER TABLE public.stripe_connect_onboarding_bootstraps
    ADD CONSTRAINT stripe_connect_onboarding_bootstraps_response_hash
    CHECK (
        initial_link_response_sha256 IS NULL
        OR initial_link_response_sha256 ~ '^[0-9a-f]{64}$'
    ),
    ADD CONSTRAINT stripe_connect_onboarding_bootstraps_receipt_hash
    CHECK (
        initial_link_delivery_receipt_sha256 IS NULL
        OR initial_link_delivery_receipt_sha256 ~ '^[0-9a-f]{64}$'
    ),
    ADD CONSTRAINT stripe_connect_onboarding_bootstraps_response_pair
    CHECK (
        (initial_link_response_sha256 IS NULL)
        = (initial_link_response_recorded_at IS NULL)
    ),
    ADD CONSTRAINT stripe_connect_onboarding_bootstraps_receipt_pair
    CHECK (
        (initial_link_delivery_receipt_sha256 IS NULL)
        = (initial_link_delivery_receipt_expires_at IS NULL)
    ),
    ADD CONSTRAINT stripe_connect_onboarding_bootstraps_delivery_order
    CHECK (
        initial_link_response_recorded_at IS NULL
        OR (
            initial_link_claimed_at IS NOT NULL
            AND initial_link_response_recorded_at >= initial_link_claimed_at
        )
    ),
    ADD CONSTRAINT stripe_connect_onboarding_bootstraps_receipt_expiry
    CHECK (
        initial_link_delivery_receipt_expires_at IS NULL
        OR (
            initial_link_response_recorded_at IS NOT NULL
            AND initial_link_delivery_receipt_expires_at > initial_link_response_recorded_at
            AND initial_link_delivery_receipt_expires_at
                <= initial_link_response_recorded_at + INTERVAL '2 minutes'
        )
    ),
    ADD CONSTRAINT stripe_connect_onboarding_bootstraps_delivered_state
    CHECK (
        initial_link_delivered_at IS NULL
        OR (
            initial_link_response_recorded_at IS NOT NULL
            AND initial_link_delivery_receipt_sha256 IS NOT NULL
            AND initial_link_delivered_at >= initial_link_response_recorded_at
        )
    ),
    ADD CONSTRAINT stripe_connect_onboarding_bootstraps_terminal_state
    CHECK (
        initial_link_delivered_at IS NULL
        OR initial_link_support_required_at IS NULL
    );

CREATE UNIQUE INDEX idx_stripe_connect_onboarding_bootstraps_delivery_receipt
    ON public.stripe_connect_onboarding_bootstraps(
        studio_id,
        initial_link_delivery_receipt_sha256
    )
    WHERE initial_link_delivery_receipt_sha256 IS NOT NULL;

CREATE OR REPLACE FUNCTION public.preflight_connect_onboarding_bootstrap_resume(
    p_studio_id UUID,
    p_candidate_sha TEXT
)
RETURNS TABLE(
    eligible BOOLEAN,
    studio_id UUID,
    connect_account_generation INTEGER,
    phase TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_account public.studio_payment_accounts%ROWTYPE;
    v_bootstrap public.stripe_connect_onboarding_bootstraps%ROWTYPE;
    v_authorization RECORD;
    v_checkpoint UUID;
    v_generation INTEGER;
BEGIN
    IF p_studio_id IS NULL OR p_candidate_sha !~ '^[0-9a-f]{40}$' THEN
        RETURN QUERY SELECT false, p_studio_id, NULL::INTEGER, 'support_required'::TEXT;
        RETURN;
    END IF;
    LOCK TABLE
        public.stripe_events,
        public.studio_payment_accounts,
        public.stripe_connect_account_dispositions,
        public.stripe_live_billing_reconciliation_checkpoints,
        public.stripe_live_billing_reconciliation_account_evidence,
        public.studio_live_billing_authorizations,
        public.stripe_connect_onboarding_bootstraps
        IN SHARE MODE;
    SELECT * INTO v_account
      FROM public.studio_payment_accounts account
     WHERE account.studio_id = p_studio_id;
    IF NOT FOUND THEN
        RETURN QUERY SELECT false, p_studio_id, NULL::INTEGER, 'support_required'::TEXT;
        RETURN;
    END IF;
    v_generation := private.current_connect_account_generation(v_account.metadata);
    SELECT * INTO v_bootstrap
      FROM public.stripe_connect_onboarding_bootstraps bootstrap
     WHERE bootstrap.studio_id = p_studio_id
       AND bootstrap.connect_account_generation = v_generation;
    IF NOT FOUND THEN
        RETURN QUERY SELECT false, p_studio_id, v_generation, 'none'::TEXT;
        RETURN;
    END IF;

    -- Delivery retires only this generation's bootstrap. It intentionally does
    -- not assert that Stripe consumed the link or that onboarding is complete.
    IF v_bootstrap.initial_link_delivered_at IS NOT NULL THEN
        IF v_bootstrap.stripe_connected_account_id IS NOT NULL
           AND v_account.stripe_connected_account_id = v_bootstrap.stripe_connected_account_id THEN
            RETURN QUERY SELECT false, p_studio_id, v_generation, 'completed'::TEXT;
        ELSE
            RETURN QUERY SELECT false, p_studio_id, v_generation, 'support_required'::TEXT;
        END IF;
        RETURN;
    END IF;

    IF v_bootstrap.initial_link_support_required_at IS NOT NULL
       OR v_bootstrap.candidate_sha <> p_candidate_sha
       OR v_bootstrap.recovery_context IS NULL
       OR v_bootstrap.recovery_expires_at <= now()
       OR v_bootstrap.aborted_at IS NOT NULL
       OR (v_bootstrap.stripe_connected_account_id IS NULL
           AND v_account.stripe_connected_account_id IS NOT NULL)
       OR (v_bootstrap.stripe_connected_account_id IS NOT NULL
           AND v_account.stripe_connected_account_id IS DISTINCT FROM v_bootstrap.stripe_connected_account_id)
       OR (v_bootstrap.initial_link_response_recorded_at IS NOT NULL
           AND v_bootstrap.initial_link_delivery_receipt_expires_at <= now()) THEN
        RETURN QUERY SELECT false, p_studio_id, v_generation, 'support_required'::TEXT;
        RETURN;
    END IF;
    IF v_bootstrap.stripe_connected_account_id IS NULL THEN
        SELECT * INTO v_authorization
          FROM public.authorize_studio_live_billing_mutation_atomic(
              p_studio_id, 'connect_account.create', 'connect_onboarding', NULL, p_candidate_sha
          );
        RETURN QUERY SELECT FOUND, p_studio_id, v_generation, 'account_create'::TEXT;
        RETURN;
    END IF;
    v_checkpoint := private.connect_onboarding_bootstrap_link_checkpoint(v_bootstrap.id, p_candidate_sha);
    IF v_checkpoint IS NULL AND v_bootstrap.initial_link_claimed_at IS NOT NULL THEN
        RETURN QUERY SELECT false, p_studio_id, v_generation, 'support_required'::TEXT;
        RETURN;
    END IF;
    RETURN QUERY SELECT
        v_checkpoint IS NOT NULL,
        p_studio_id,
        v_generation,
        CASE
            WHEN v_bootstrap.initial_link_claimed_at IS NULL THEN 'initial_link'
            WHEN v_bootstrap.initial_link_response_recorded_at IS NULL THEN 'initial_link_retry'
            ELSE 'initial_link_delivery_pending'
        END;
END;
$$;

CREATE OR REPLACE FUNCTION public.authorize_connect_onboarding_bootstrap_initial_link_v2(
    p_bootstrap_id UUID,
    p_studio_id UUID,
    p_candidate_sha TEXT,
    p_connect_account_generation INTEGER,
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
    v_bootstrap public.stripe_connect_onboarding_bootstraps%ROWTYPE;
    v_checkpoint UUID;
BEGIN
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
     WHERE bootstrap.id = p_bootstrap_id
       AND bootstrap.studio_id = p_studio_id
       AND bootstrap.connect_account_generation = p_connect_account_generation
       AND bootstrap.candidate_sha = p_candidate_sha
       AND bootstrap.stripe_connected_account_id = p_stripe_connected_account_id
       AND bootstrap.initial_link_context_sha256 = p_initial_link_context_sha256
       AND bootstrap.initial_link_idempotency_key = p_initial_link_idempotency_key
       AND bootstrap.recovery_context IS NOT NULL
       AND bootstrap.recovery_expires_at > now()
       AND bootstrap.aborted_at IS NULL
       AND bootstrap.initial_link_delivered_at IS NULL
       AND bootstrap.initial_link_support_required_at IS NULL
       AND (bootstrap.initial_link_delivery_receipt_expires_at IS NULL
            OR bootstrap.initial_link_delivery_receipt_expires_at > now())
       AND (bootstrap.initial_link_payload_sha256 IS NULL
            OR bootstrap.initial_link_payload_sha256 = p_initial_link_payload_sha256)
     FOR UPDATE;
    IF NOT FOUND THEN
        RETURN;
    END IF;
    v_checkpoint := private.connect_onboarding_bootstrap_link_checkpoint(v_bootstrap.id, p_candidate_sha);
    IF v_checkpoint IS NULL THEN
        IF v_bootstrap.initial_link_claimed_at IS NOT NULL THEN
            UPDATE public.stripe_connect_onboarding_bootstraps
               SET initial_link_support_required_at = COALESCE(initial_link_support_required_at, now())
             WHERE id = v_bootstrap.id;
        END IF;
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
    RETURN QUERY SELECT true, p_studio_id, v_checkpoint, v_bootstrap.id;
END;
$$;

CREATE FUNCTION public.record_connect_onboarding_bootstrap_initial_link_response(
    p_bootstrap_id UUID,
    p_studio_id UUID,
    p_candidate_sha TEXT,
    p_connect_account_generation INTEGER,
    p_stripe_connected_account_id TEXT,
    p_initial_link_context_sha256 TEXT,
    p_initial_link_payload_sha256 TEXT,
    p_initial_link_idempotency_key TEXT,
    p_initial_link_response_sha256 TEXT,
    p_delivery_receipt_sha256 TEXT
)
RETURNS TABLE(recorded BOOLEAN, studio_id UUID, bootstrap_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_bootstrap public.stripe_connect_onboarding_bootstraps%ROWTYPE;
    v_checkpoint UUID;
BEGIN
    IF p_initial_link_response_sha256 !~ '^[0-9a-f]{64}$'
       OR p_delivery_receipt_sha256 !~ '^[0-9a-f]{64}$' THEN
        RETURN;
    END IF;
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
     WHERE bootstrap.id = p_bootstrap_id
       AND bootstrap.studio_id = p_studio_id
       AND bootstrap.connect_account_generation = p_connect_account_generation
       AND bootstrap.candidate_sha = p_candidate_sha
       AND bootstrap.stripe_connected_account_id = p_stripe_connected_account_id
       AND bootstrap.initial_link_context_sha256 = p_initial_link_context_sha256
       AND bootstrap.initial_link_payload_sha256 = p_initial_link_payload_sha256
       AND bootstrap.initial_link_idempotency_key = p_initial_link_idempotency_key
       AND bootstrap.initial_link_claimed_at IS NOT NULL
       AND bootstrap.initial_link_delivered_at IS NULL
       AND bootstrap.initial_link_support_required_at IS NULL
       AND bootstrap.recovery_context IS NOT NULL
       AND bootstrap.recovery_expires_at > now()
       AND bootstrap.aborted_at IS NULL
     FOR UPDATE;
    IF NOT FOUND THEN
        RETURN;
    END IF;
    IF v_bootstrap.initial_link_delivery_receipt_expires_at IS NOT NULL
       AND v_bootstrap.initial_link_delivery_receipt_expires_at <= now() THEN
        UPDATE public.stripe_connect_onboarding_bootstraps
           SET initial_link_support_required_at = now()
         WHERE id = v_bootstrap.id;
        RETURN;
    END IF;
    IF v_bootstrap.initial_link_response_sha256 IS NOT NULL
       AND v_bootstrap.initial_link_response_sha256 <> p_initial_link_response_sha256 THEN
        UPDATE public.stripe_connect_onboarding_bootstraps
           SET initial_link_support_required_at = now()
         WHERE id = v_bootstrap.id;
        RETURN;
    END IF;
    v_checkpoint := private.connect_onboarding_bootstrap_link_checkpoint(v_bootstrap.id, p_candidate_sha);
    IF v_checkpoint IS NULL THEN
        UPDATE public.stripe_connect_onboarding_bootstraps
           SET initial_link_support_required_at = now()
         WHERE id = v_bootstrap.id;
        RETURN;
    END IF;
    UPDATE public.stripe_connect_onboarding_bootstraps
       SET initial_link_response_sha256 = p_initial_link_response_sha256,
           initial_link_response_recorded_at = now(),
           initial_link_delivery_receipt_sha256 = p_delivery_receipt_sha256,
           initial_link_delivery_receipt_expires_at = now() + INTERVAL '2 minutes'
     WHERE id = v_bootstrap.id;
    RETURN QUERY SELECT true, p_studio_id, v_bootstrap.id;
END;
$$;

CREATE FUNCTION public.acknowledge_connect_onboarding_bootstrap_initial_link_delivery(
    p_studio_id UUID,
    p_candidate_sha TEXT,
    p_delivery_receipt_sha256 TEXT
)
RETURNS TABLE(acknowledged BOOLEAN, studio_id UUID, bootstrap_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_bootstrap public.stripe_connect_onboarding_bootstraps%ROWTYPE;
    v_account public.studio_payment_accounts%ROWTYPE;
    v_checkpoint UUID;
BEGIN
    IF p_studio_id IS NULL
       OR p_candidate_sha !~ '^[0-9a-f]{40}$'
       OR p_delivery_receipt_sha256 !~ '^[0-9a-f]{64}$' THEN
        RETURN;
    END IF;
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
     WHERE bootstrap.studio_id = p_studio_id
       AND bootstrap.candidate_sha = p_candidate_sha
       AND bootstrap.initial_link_delivery_receipt_sha256 = p_delivery_receipt_sha256
       AND bootstrap.initial_link_response_recorded_at IS NOT NULL
       AND bootstrap.initial_link_delivery_receipt_expires_at > now()
       AND bootstrap.initial_link_support_required_at IS NULL
       AND bootstrap.aborted_at IS NULL
     FOR UPDATE;
    IF NOT FOUND THEN
        RETURN;
    END IF;
    SELECT * INTO v_account
      FROM public.studio_payment_accounts account
     WHERE account.studio_id = p_studio_id
       AND account.stripe_connected_account_id = v_bootstrap.stripe_connected_account_id
       AND private.current_connect_account_generation(account.metadata)
            = v_bootstrap.connect_account_generation;
    IF NOT FOUND THEN
        UPDATE public.stripe_connect_onboarding_bootstraps
           SET initial_link_support_required_at = now()
         WHERE id = v_bootstrap.id;
        RETURN;
    END IF;
    IF v_bootstrap.initial_link_delivered_at IS NULL THEN
        v_checkpoint := private.connect_onboarding_bootstrap_link_checkpoint(v_bootstrap.id, p_candidate_sha);
        IF v_checkpoint IS NULL THEN
            UPDATE public.stripe_connect_onboarding_bootstraps
               SET initial_link_support_required_at = now()
             WHERE id = v_bootstrap.id;
            RETURN;
        END IF;
        UPDATE public.stripe_connect_onboarding_bootstraps
           SET initial_link_delivered_at = now()
         WHERE id = v_bootstrap.id;
    END IF;
    RETURN QUERY SELECT true, p_studio_id, v_bootstrap.id;
END;
$$;

REVOKE ALL ON FUNCTION public.record_connect_onboarding_bootstrap_initial_link_response(
    UUID, UUID, TEXT, INTEGER, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.acknowledge_connect_onboarding_bootstrap_initial_link_delivery(
    UUID, TEXT, TEXT
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.record_connect_onboarding_bootstrap_initial_link_response(
    UUID, UUID, TEXT, INTEGER, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT
) TO service_role;
GRANT EXECUTE ON FUNCTION public.acknowledge_connect_onboarding_bootstrap_initial_link_delivery(
    UUID, TEXT, TEXT
) TO service_role;

COMMENT ON COLUMN public.stripe_connect_onboarding_bootstraps.initial_link_delivery_receipt_sha256 IS
    'SHA-256 of the short-lived, non-authorizing browser delivery receipt; raw receipt is never persisted.';
COMMENT ON COLUMN public.stripe_connect_onboarding_bootstraps.initial_link_delivered_at IS
    'Authenticated browser acknowledged safe URL receipt; does not prove Stripe consumption, KYC, or readiness.';
COMMENT ON COLUMN public.stripe_connect_onboarding_bootstraps.initial_link_support_required_at IS
    'Terminal automatic-recovery boundary for ambiguous or drifted initial-link state.';
