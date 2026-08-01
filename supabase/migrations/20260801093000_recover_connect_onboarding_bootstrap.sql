-- Make the one-generation Connect bootstrap recoverable without creating a
-- second permit. Recovery context and handles remain service-only; browser
-- clients receive only the derived boolean capability from the backend.

ALTER TABLE public.stripe_connect_onboarding_bootstraps
    ADD COLUMN recovery_context JSONB,
    ADD COLUMN recovery_expires_at TIMESTAMPTZ;

ALTER TABLE public.stripe_connect_onboarding_bootstraps
    ADD CONSTRAINT stripe_connect_onboarding_bootstraps_recovery_pair
    CHECK ((recovery_context IS NULL) = (recovery_expires_at IS NULL)),
    ADD CONSTRAINT stripe_connect_onboarding_bootstraps_recovery_context_object
    CHECK (recovery_context IS NULL OR jsonb_typeof(recovery_context) = 'object'),
    ADD CONSTRAINT stripe_connect_onboarding_bootstraps_recovery_expiry
    CHECK (
        recovery_expires_at IS NULL
        OR (recovery_expires_at > authorized_at
            AND recovery_expires_at <= authorized_at + INTERVAL '24 hours')
    );

-- The v1 token functions stay present for migration compatibility but are no
-- longer callable by the application role. New code uses the stable row id and
-- exact stored context through the v2 functions below.
REVOKE EXECUTE ON FUNCTION public.authorize_connect_onboarding_bootstrap_account_create(
    UUID, TEXT, INTEGER, TEXT, TEXT, TEXT, TEXT, TEXT
) FROM service_role;
REVOKE EXECUTE ON FUNCTION public.bind_connect_onboarding_bootstrap_account(
    UUID, TEXT, INTEGER, TEXT, TEXT, TEXT
) FROM service_role;
REVOKE EXECUTE ON FUNCTION public.authorize_connect_onboarding_bootstrap_initial_link(
    UUID, TEXT, INTEGER, TEXT, TEXT, TEXT, TEXT, TEXT
) FROM service_role;

CREATE FUNCTION private.connect_onboarding_bootstrap_link_checkpoint(
    p_bootstrap_id UUID,
    p_candidate_sha TEXT
)
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT checkpoint.id
      FROM public.stripe_connect_onboarding_bootstraps bootstrap
      JOIN public.studio_live_billing_authorizations authz
        ON authz.studio_id = bootstrap.studio_id
       AND authz.scope = 'connect_onboarding'
      JOIN public.stripe_live_billing_reconciliation_checkpoints checkpoint
        ON checkpoint.id = authz.reconciliation_checkpoint_id
      JOIN public.studio_payment_accounts account
        ON account.studio_id = bootstrap.studio_id
     WHERE bootstrap.id = p_bootstrap_id
       AND bootstrap.candidate_sha = p_candidate_sha
       AND bootstrap.reconciliation_checkpoint_id = checkpoint.id
       AND bootstrap.recovery_context IS NOT NULL
       AND bootstrap.recovery_expires_at > now()
       AND bootstrap.aborted_at IS NULL
       AND bootstrap.stripe_livemode
       AND bootstrap.stripe_connected_account_id IS NOT NULL
       AND bootstrap.account_bound_at IS NOT NULL
       AND account.stripe_connected_account_id = bootstrap.stripe_connected_account_id
       AND private.current_connect_account_generation(account.metadata)
            = bootstrap.connect_account_generation
       AND authz.enabled
       AND authz.expires_at > now()
       AND authz.connect_account_generation = bootstrap.connect_account_generation
       AND (authz.stripe_connected_account_id IS NULL
            OR authz.stripe_connected_account_id = bootstrap.stripe_connected_account_id)
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
                  mapped.studio_id = bootstrap.studio_id
                  AND mapped.stripe_connected_account_id = bootstrap.stripe_connected_account_id
                  AND private.current_connect_account_generation(mapped.metadata)
                        = bootstrap.connect_account_generation
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
           SELECT 1
             FROM public.stripe_events event
            WHERE event.livemode
              AND event.created_at >= TIMESTAMPTZ '2026-07-13 00:00:00+00'
              AND private.live_billing_event_is_in_scope(event.stripe_account_id, event.type)
              AND event.processing_status IS DISTINCT FROM 'processed'
       )
       AND NOT EXISTS (
           SELECT 1
             FROM public.stripe_events event
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
           SELECT 1
             FROM public.stripe_events event
            WHERE event.livemode
              AND event.live_billing_ingest_sequence > authz.local_event_ingest_watermark
              AND (
                  (private.live_billing_event_is_in_scope(event.stripe_account_id, event.type)
                   AND event.processing_status IS DISTINCT FROM 'processed')
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
     LIMIT 1
$$;

REVOKE ALL ON FUNCTION private.connect_onboarding_bootstrap_link_checkpoint(UUID, TEXT)
    FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.preflight_connect_onboarding_bootstrap_begin(
    p_studio_id UUID,
    p_candidate_sha TEXT
)
RETURNS TABLE(eligible BOOLEAN, studio_id UUID, connect_account_generation INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_account public.studio_payment_accounts%ROWTYPE;
    v_authorization RECORD;
BEGIN
    IF p_studio_id IS NULL OR p_candidate_sha !~ '^[0-9a-f]{40}$' THEN
        RETURN QUERY SELECT false, p_studio_id, NULL::INTEGER;
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
    IF NOT FOUND OR v_account.stripe_connected_account_id IS NOT NULL THEN
        RETURN QUERY SELECT false, p_studio_id, NULL::INTEGER;
        RETURN;
    END IF;
    IF EXISTS (
        SELECT 1 FROM public.stripe_connect_onboarding_bootstraps bootstrap
         WHERE bootstrap.studio_id = p_studio_id
           AND bootstrap.connect_account_generation
                = private.current_connect_account_generation(v_account.metadata)
    ) THEN
        RETURN QUERY SELECT false, p_studio_id,
            private.current_connect_account_generation(v_account.metadata);
        RETURN;
    END IF;
    SELECT * INTO v_authorization
      FROM public.authorize_studio_live_billing_mutation_atomic(
          p_studio_id, 'connect_account.create', 'connect_onboarding', NULL, p_candidate_sha
      );
    RETURN QUERY SELECT FOUND, p_studio_id,
        private.current_connect_account_generation(v_account.metadata);
END;
$$;

CREATE FUNCTION public.preflight_connect_onboarding_bootstrap_resume(
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
    v_phase TEXT;
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
    SELECT * INTO v_bootstrap
      FROM public.stripe_connect_onboarding_bootstraps bootstrap
     WHERE bootstrap.studio_id = p_studio_id
       AND bootstrap.connect_account_generation
            = private.current_connect_account_generation(v_account.metadata);
    IF NOT FOUND THEN
        RETURN QUERY SELECT false, p_studio_id,
            private.current_connect_account_generation(v_account.metadata),
            'none'::TEXT;
        RETURN;
    END IF;
    IF v_bootstrap.candidate_sha <> p_candidate_sha
       OR v_bootstrap.recovery_context IS NULL
       OR v_bootstrap.recovery_expires_at <= now()
       OR v_bootstrap.aborted_at IS NOT NULL
       OR (v_bootstrap.stripe_connected_account_id IS NULL
           AND v_account.stripe_connected_account_id IS NOT NULL)
       OR (v_bootstrap.stripe_connected_account_id IS NOT NULL
           AND v_account.stripe_connected_account_id IS DISTINCT FROM v_bootstrap.stripe_connected_account_id) THEN
        RETURN QUERY SELECT false, p_studio_id,
            private.current_connect_account_generation(v_account.metadata),
            'support_required'::TEXT;
        RETURN;
    END IF;
    IF v_bootstrap.stripe_connected_account_id IS NULL THEN
        SELECT * INTO v_authorization
          FROM public.authorize_studio_live_billing_mutation_atomic(
              p_studio_id, 'connect_account.create', 'connect_onboarding', NULL, p_candidate_sha
          );
        v_phase := 'account_create';
        RETURN QUERY SELECT FOUND, p_studio_id, v_bootstrap.connect_account_generation, v_phase;
        RETURN;
    END IF;
    v_checkpoint := private.connect_onboarding_bootstrap_link_checkpoint(v_bootstrap.id, p_candidate_sha);
    v_phase := CASE
        WHEN v_bootstrap.initial_link_claimed_at IS NULL THEN 'initial_link'
        ELSE 'initial_link_retry'
    END;
    RETURN QUERY SELECT v_checkpoint IS NOT NULL, p_studio_id,
        v_bootstrap.connect_account_generation, v_phase;
END;
$$;

CREATE FUNCTION public.prepare_connect_onboarding_bootstrap_atomic(
    p_studio_id UUID,
    p_candidate_sha TEXT,
    p_connect_account_generation INTEGER,
    p_recovery_context JSONB,
    p_account_create_payload_sha256 TEXT,
    p_initial_link_context_sha256 TEXT,
    p_account_create_idempotency_key TEXT,
    p_initial_link_idempotency_key TEXT
)
RETURNS TABLE(
    bootstrap_id UUID,
    studio_id UUID,
    connect_account_generation INTEGER,
    recovery_context JSONB,
    account_create_idempotency_key TEXT,
    initial_link_idempotency_key TEXT,
    stripe_connected_account_id TEXT,
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
    v_recovery_expires_at TIMESTAMPTZ;
BEGIN
    IF p_studio_id IS NULL
       OR p_candidate_sha !~ '^[0-9a-f]{40}$'
       OR p_connect_account_generation <= 0
       OR jsonb_typeof(p_recovery_context) <> 'object'
       OR NOT (p_recovery_context ?& ARRAY[
           'business_name', 'contact_email', 'business_entity_type', 'refresh_url', 'return_url'
       ])
       OR EXISTS (
           SELECT 1
             FROM jsonb_object_keys(p_recovery_context) key
            WHERE key <> ALL (ARRAY[
                'business_name', 'contact_email', 'business_entity_type', 'refresh_url', 'return_url'
            ]::TEXT[])
       )
       OR jsonb_typeof(p_recovery_context -> 'business_name') <> 'string'
       OR p_recovery_context ->> 'business_name' = ''
       OR (jsonb_typeof(p_recovery_context -> 'contact_email') NOT IN ('string', 'null'))
       OR p_recovery_context ->> 'business_entity_type' NOT IN ('company', 'individual')
       OR jsonb_typeof(p_recovery_context -> 'refresh_url') <> 'string'
       OR jsonb_typeof(p_recovery_context -> 'return_url') <> 'string'
       OR p_recovery_context ->> 'refresh_url' = ''
       OR p_recovery_context ->> 'return_url' = ''
       OR p_account_create_payload_sha256 !~ '^[0-9a-f]{64}$'
       OR p_initial_link_context_sha256 !~ '^[0-9a-f]{64}$'
       OR p_account_create_idempotency_key !~ '^koaryu-connect-account-[0-9a-f-]+-g[1-9][0-9]*$'
       OR p_initial_link_idempotency_key !~ '^koaryu-connect-onboarding-[0-9a-f-]+-g[1-9][0-9]*-[0-9a-f]{24}$' THEN
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
    SELECT * INTO v_account
      FROM public.studio_payment_accounts account
     WHERE account.studio_id = p_studio_id
       AND private.current_connect_account_generation(account.metadata)
            = p_connect_account_generation;
    IF NOT FOUND THEN
        RETURN;
    END IF;
    SELECT * INTO v_bootstrap
      FROM public.stripe_connect_onboarding_bootstraps bootstrap
     WHERE bootstrap.studio_id = p_studio_id
       AND bootstrap.connect_account_generation = p_connect_account_generation;
    IF FOUND THEN
        IF v_bootstrap.candidate_sha <> p_candidate_sha
           OR v_bootstrap.recovery_context IS DISTINCT FROM p_recovery_context
           OR v_bootstrap.account_create_payload_sha256 <> p_account_create_payload_sha256
           OR v_bootstrap.initial_link_context_sha256 <> p_initial_link_context_sha256
           OR v_bootstrap.account_create_idempotency_key <> p_account_create_idempotency_key
           OR v_bootstrap.initial_link_idempotency_key <> p_initial_link_idempotency_key
           OR v_bootstrap.recovery_expires_at <= now()
           OR v_bootstrap.aborted_at IS NOT NULL
           OR (v_bootstrap.stripe_connected_account_id IS NULL
               AND v_account.stripe_connected_account_id IS NOT NULL)
           OR (v_bootstrap.stripe_connected_account_id IS NOT NULL
               AND v_account.stripe_connected_account_id IS DISTINCT FROM v_bootstrap.stripe_connected_account_id) THEN
            RETURN;
        END IF;
    ELSE
        IF v_account.stripe_connected_account_id IS NOT NULL THEN
            RETURN;
        END IF;
        SELECT * INTO v_authorization
          FROM public.authorize_studio_live_billing_mutation_atomic(
              p_studio_id, 'connect_account.create', 'connect_onboarding', NULL, p_candidate_sha
          );
        IF NOT FOUND THEN
            RETURN;
        END IF;
        SELECT LEAST(checkpoint.expires_at, authz.expires_at, now() + INTERVAL '24 hours')
          INTO v_recovery_expires_at
          FROM public.stripe_live_billing_reconciliation_checkpoints checkpoint
          JOIN public.studio_live_billing_authorizations authz
            ON authz.reconciliation_checkpoint_id = checkpoint.id
           AND authz.studio_id = p_studio_id
           AND authz.scope = 'connect_onboarding'
         WHERE checkpoint.id = v_authorization.checkpoint_id;
        IF v_recovery_expires_at IS NULL OR v_recovery_expires_at <= now() THEN
            RETURN;
        END IF;
        INSERT INTO public.stripe_connect_onboarding_bootstraps(
            studio_id, connect_account_generation, bootstrap_token_sha256,
            account_create_payload_sha256, initial_link_context_sha256,
            account_create_idempotency_key, initial_link_idempotency_key,
            candidate_sha, reconciliation_checkpoint_id, stripe_livemode,
            expires_at, recovery_context, recovery_expires_at
        ) VALUES (
            p_studio_id, p_connect_account_generation,
            encode(extensions.digest(convert_to(extensions.gen_random_uuid()::TEXT || clock_timestamp()::TEXT, 'UTF8'), 'sha256'), 'hex'),
            p_account_create_payload_sha256, p_initial_link_context_sha256,
            p_account_create_idempotency_key, p_initial_link_idempotency_key,
            p_candidate_sha, v_authorization.checkpoint_id, true,
            now() + INTERVAL '5 minutes', p_recovery_context, v_recovery_expires_at
        ) RETURNING * INTO v_bootstrap;
    END IF;
    RETURN QUERY SELECT
        v_bootstrap.id, v_bootstrap.studio_id, v_bootstrap.connect_account_generation,
        v_bootstrap.recovery_context, v_bootstrap.account_create_idempotency_key,
        v_bootstrap.initial_link_idempotency_key, v_bootstrap.stripe_connected_account_id,
        CASE
            WHEN v_bootstrap.stripe_connected_account_id IS NULL THEN 'account_create'
            WHEN v_bootstrap.initial_link_claimed_at IS NULL THEN 'initial_link'
            ELSE 'initial_link_retry'
        END;
END;
$$;

CREATE FUNCTION public.load_connect_onboarding_bootstrap_recovery_context(
    p_studio_id UUID,
    p_candidate_sha TEXT
)
RETURNS TABLE(
    bootstrap_id UUID,
    studio_id UUID,
    connect_account_generation INTEGER,
    recovery_context JSONB,
    account_create_idempotency_key TEXT,
    initial_link_idempotency_key TEXT,
    stripe_connected_account_id TEXT,
    phase TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_preflight RECORD;
BEGIN
    SELECT * INTO v_preflight
      FROM public.preflight_connect_onboarding_bootstrap_resume(p_studio_id, p_candidate_sha);
    IF NOT FOUND OR NOT v_preflight.eligible THEN
        RETURN;
    END IF;
    RETURN QUERY
    SELECT bootstrap.id, bootstrap.studio_id, bootstrap.connect_account_generation,
           bootstrap.recovery_context, bootstrap.account_create_idempotency_key,
           bootstrap.initial_link_idempotency_key, bootstrap.stripe_connected_account_id,
           v_preflight.phase
      FROM public.stripe_connect_onboarding_bootstraps bootstrap
     WHERE bootstrap.studio_id = p_studio_id
       AND bootstrap.connect_account_generation = v_preflight.connect_account_generation
       AND bootstrap.candidate_sha = p_candidate_sha
       AND bootstrap.recovery_context IS NOT NULL
       AND bootstrap.recovery_expires_at > now()
       AND bootstrap.aborted_at IS NULL;
END;
$$;

CREATE FUNCTION public.authorize_connect_onboarding_bootstrap_account_create_v2(
    p_bootstrap_id UUID,
    p_studio_id UUID,
    p_candidate_sha TEXT,
    p_connect_account_generation INTEGER,
    p_account_create_payload_sha256 TEXT,
    p_account_create_idempotency_key TEXT
)
RETURNS TABLE(authorized BOOLEAN, studio_id UUID, checkpoint_id UUID, bootstrap_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_bootstrap public.stripe_connect_onboarding_bootstraps%ROWTYPE;
    v_authorization RECORD;
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
       AND bootstrap.account_create_payload_sha256 = p_account_create_payload_sha256
       AND bootstrap.account_create_idempotency_key = p_account_create_idempotency_key
       AND bootstrap.recovery_context IS NOT NULL
       AND bootstrap.recovery_expires_at > now()
       AND bootstrap.aborted_at IS NULL
       AND bootstrap.stripe_connected_account_id IS NULL;
    IF NOT FOUND THEN
        RETURN;
    END IF;
    SELECT * INTO v_authorization
      FROM public.authorize_studio_live_billing_mutation_atomic(
          p_studio_id, 'connect_account.create', 'connect_onboarding', NULL, p_candidate_sha
      );
    IF NOT FOUND OR v_authorization.checkpoint_id <> v_bootstrap.reconciliation_checkpoint_id THEN
        RETURN;
    END IF;
    RETURN QUERY SELECT true, p_studio_id, v_authorization.checkpoint_id, v_bootstrap.id;
END;
$$;

CREATE FUNCTION public.bind_connect_onboarding_bootstrap_account_v2(
    p_bootstrap_id UUID,
    p_studio_id UUID,
    p_candidate_sha TEXT,
    p_connect_account_generation INTEGER,
    p_stripe_connected_account_id TEXT,
    p_business_entity_type TEXT
)
RETURNS public.studio_payment_accounts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_bootstrap public.stripe_connect_onboarding_bootstraps%ROWTYPE;
    v_account public.studio_payment_accounts%ROWTYPE;
BEGIN
    IF p_stripe_connected_account_id !~ '^acct_[A-Za-z0-9]+$'
       OR p_business_entity_type NOT IN ('company', 'individual') THEN
        RAISE EXCEPTION 'Invalid Connect bootstrap binding context.' USING ERRCODE = '22023';
    END IF;
    LOCK TABLE public.studio_payment_accounts, public.stripe_connect_onboarding_bootstraps
        IN SHARE ROW EXCLUSIVE MODE;
    SELECT * INTO v_bootstrap
      FROM public.stripe_connect_onboarding_bootstraps bootstrap
     WHERE bootstrap.id = p_bootstrap_id
       AND bootstrap.studio_id = p_studio_id
       AND bootstrap.connect_account_generation = p_connect_account_generation
       AND bootstrap.candidate_sha = p_candidate_sha
       AND bootstrap.recovery_context IS NOT NULL
       AND bootstrap.recovery_context ->> 'business_entity_type' = p_business_entity_type
       AND bootstrap.recovery_expires_at > now()
       AND bootstrap.aborted_at IS NULL;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Connect bootstrap is not recoverable.' USING ERRCODE = 'P0B21';
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
        RAISE EXCEPTION 'Connect account mapping changed during recovery.' USING ERRCODE = 'P0B22';
    END IF;
    UPDATE public.studio_payment_accounts
       SET stripe_connected_account_id = p_stripe_connected_account_id,
           status = 'onboarding_incomplete',
           metadata = COALESCE(metadata, '{}'::JSONB) || jsonb_build_object(
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

CREATE FUNCTION public.authorize_connect_onboarding_bootstrap_initial_link_v2(
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
       AND (bootstrap.initial_link_payload_sha256 IS NULL
            OR bootstrap.initial_link_payload_sha256 = p_initial_link_payload_sha256)
     FOR UPDATE;
    IF NOT FOUND THEN
        RETURN;
    END IF;
    v_checkpoint := private.connect_onboarding_bootstrap_link_checkpoint(v_bootstrap.id, p_candidate_sha);
    IF v_checkpoint IS NULL THEN
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

REVOKE ALL ON FUNCTION public.preflight_connect_onboarding_bootstrap_begin(UUID, TEXT)
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.preflight_connect_onboarding_bootstrap_resume(UUID, TEXT)
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.prepare_connect_onboarding_bootstrap_atomic(
    UUID, TEXT, INTEGER, JSONB, TEXT, TEXT, TEXT, TEXT
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.load_connect_onboarding_bootstrap_recovery_context(UUID, TEXT)
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.authorize_connect_onboarding_bootstrap_account_create_v2(
    UUID, UUID, TEXT, INTEGER, TEXT, TEXT
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.bind_connect_onboarding_bootstrap_account_v2(
    UUID, UUID, TEXT, INTEGER, TEXT, TEXT
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.authorize_connect_onboarding_bootstrap_initial_link_v2(
    UUID, UUID, TEXT, INTEGER, TEXT, TEXT, TEXT, TEXT
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.preflight_connect_onboarding_bootstrap_begin(UUID, TEXT)
    TO service_role;
GRANT EXECUTE ON FUNCTION public.preflight_connect_onboarding_bootstrap_resume(UUID, TEXT)
    TO service_role;
GRANT EXECUTE ON FUNCTION public.prepare_connect_onboarding_bootstrap_atomic(
    UUID, TEXT, INTEGER, JSONB, TEXT, TEXT, TEXT, TEXT
) TO service_role;
GRANT EXECUTE ON FUNCTION public.load_connect_onboarding_bootstrap_recovery_context(UUID, TEXT)
    TO service_role;
GRANT EXECUTE ON FUNCTION public.authorize_connect_onboarding_bootstrap_account_create_v2(
    UUID, UUID, TEXT, INTEGER, TEXT, TEXT
) TO service_role;
GRANT EXECUTE ON FUNCTION public.bind_connect_onboarding_bootstrap_account_v2(
    UUID, UUID, TEXT, INTEGER, TEXT, TEXT
) TO service_role;
GRANT EXECUTE ON FUNCTION public.authorize_connect_onboarding_bootstrap_initial_link_v2(
    UUID, UUID, TEXT, INTEGER, TEXT, TEXT, TEXT, TEXT
) TO service_role;

COMMENT ON COLUMN public.stripe_connect_onboarding_bootstraps.recovery_context IS
    'Service-only canonical Connect onboarding inputs; never expose in client responses or logs.';
COMMENT ON COLUMN public.stripe_connect_onboarding_bootstraps.recovery_expires_at IS
    'Final same-row recovery boundary, capped by the original grant and checkpoint expiry.';
