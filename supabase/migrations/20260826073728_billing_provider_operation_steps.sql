-- Optional ordered provider-call steps for multi-call billing workflows.
-- Single-call workflows continue to use the V27 parent operation directly.

DO $v27_preflight_guard$
DECLARE
    v_preflight RECORD;
BEGIN
    SELECT * INTO v_preflight
    FROM public.koaryu_release_schema_preflight_v8();
    IF v_preflight.ready IS DISTINCT FROM true
       OR v_preflight.migration_count IS DISTINCT FROM 122
       OR v_preflight.migration_head IS DISTINCT FROM '20260826051527'
       OR v_preflight.manifest_version IS DISTINCT FROM 'release-db-attestation-v27'
       OR private.koaryu_release_schedule_window_manifest_v1()
          IS DISTINCT FROM '0:f4c66d3098dcb3210ac6cc92e1831eebaf9f2ed74b210e84ec773cb1d8e854a7'
       OR COALESCE(v_preflight.security_failures, ARRAY[]::TEXT[]) <> ARRAY[]::TEXT[] THEN
        RAISE EXCEPTION 'Billing provider operation steps require the exact ready 122/V27 predecessor.';
    END IF;
END;
$v27_preflight_guard$;

ALTER TABLE public.billing_payers
    ADD COLUMN connect_account_generation INTEGER,
    ADD CONSTRAINT billing_payers_connect_account_generation_positive
        CHECK (connect_account_generation > 0);

CREATE FUNCTION private.enforce_billing_payer_connect_identity_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_account public.studio_payment_accounts%ROWTYPE;
    v_current_generation INTEGER;
BEGIN
    IF OLD.stripe_account_id IS NOT DISTINCT FROM NEW.stripe_account_id
       AND OLD.stripe_customer_id IS NOT DISTINCT FROM NEW.stripe_customer_id
       AND OLD.connect_account_generation IS NOT DISTINCT FROM NEW.connect_account_generation THEN
        RETURN NEW;
    END IF;

    IF NEW.stripe_account_id IS NULL
       AND NEW.stripe_customer_id IS NULL
       AND NEW.connect_account_generation IS NULL THEN
        RETURN NEW;
    END IF;

    IF NEW.stripe_account_id IS NULL
       OR NEW.stripe_customer_id IS NULL
       OR NEW.connect_account_generation IS NULL
       OR NEW.connect_account_generation <= 0 THEN
        RAISE EXCEPTION USING ERRCODE = '23514',
            MESSAGE = 'billing_payer_connect_identity_incomplete';
    END IF;

    SELECT * INTO v_account
    FROM public.studio_payment_accounts AS account
    WHERE account.studio_id = NEW.studio_id
    FOR UPDATE;
    v_current_generation := private.current_connect_account_generation(v_account.metadata);
    IF v_account.studio_id IS NULL
       OR v_account.stripe_connected_account_id IS DISTINCT FROM NEW.stripe_account_id
       OR v_current_generation IS NULL
       OR v_current_generation IS DISTINCT FROM NEW.connect_account_generation THEN
        RAISE EXCEPTION USING ERRCODE = '23514',
            MESSAGE = 'billing_payer_connect_identity_not_current';
    END IF;
    RETURN NEW;
END;
$$;

ALTER FUNCTION private.enforce_billing_payer_connect_identity_v1() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.enforce_billing_payer_connect_identity_v1()
    FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER enforce_billing_payer_connect_identity_v1
    BEFORE UPDATE OF stripe_account_id, stripe_customer_id, connect_account_generation
    ON public.billing_payers
    FOR EACH ROW
    EXECUTE FUNCTION private.enforce_billing_payer_connect_identity_v1();

CREATE OR REPLACE FUNCTION public.finalize_billing_payer_setup_projection_v1(
    p_consent_id UUID, p_setup_request_id UUID, p_operation_id UUID,
    p_studio_id UUID, p_payer_id UUID,
    p_stripe_checkout_session_id TEXT, p_stripe_setup_intent_id TEXT,
    p_stripe_connected_account_id TEXT, p_connect_account_generation INTEGER
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_operation public.billing_provider_operations%ROWTYPE;
    v_request public.billing_payer_setup_requests%ROWTYPE;
    v_consent public.billing_payer_payment_consents%ROWTYPE;
    v_payer public.billing_payers%ROWTYPE;
    v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
    SELECT * INTO v_operation FROM public.billing_provider_operations
    WHERE id = p_operation_id FOR UPDATE;
    SELECT * INTO v_payer FROM public.billing_payers
    WHERE id = p_payer_id AND studio_id = p_studio_id FOR UPDATE;
    SELECT * INTO v_request FROM public.billing_payer_setup_requests
    WHERE id = p_setup_request_id FOR UPDATE;
    PERFORM 1 FROM public.billing_payer_payment_consents AS locked_consent
    WHERE locked_consent.studio_id = p_studio_id
      AND locked_consent.payer_id = p_payer_id
      AND locked_consent.stripe_connected_account_id = p_stripe_connected_account_id
      AND locked_consent.connect_account_generation = p_connect_account_generation
    ORDER BY locked_consent.id FOR UPDATE;
    SELECT * INTO v_consent FROM public.billing_payer_payment_consents
    WHERE id = p_consent_id;
    IF v_payer.id IS NULL OR v_operation.id IS NULL
       OR v_request.id IS NULL OR v_consent.id IS NULL
       OR v_operation.operation_type <> 'payer.setup'
       OR v_request.operation_id IS DISTINCT FROM p_operation_id
       OR v_consent.setup_request_id IS DISTINCT FROM p_setup_request_id
       OR v_operation.provider_object_id IS DISTINCT FROM p_stripe_checkout_session_id
       OR v_operation.provider_secondary_object_id IS DISTINCT FROM p_stripe_setup_intent_id
       OR v_request.stripe_checkout_session_id IS DISTINCT FROM p_stripe_checkout_session_id
       OR v_request.stripe_setup_intent_id IS DISTINCT FROM p_stripe_setup_intent_id
       OR v_consent.stripe_checkout_session_id IS DISTINCT FROM p_stripe_checkout_session_id
       OR v_consent.stripe_setup_intent_id IS DISTINCT FROM p_stripe_setup_intent_id
       OR v_operation.studio_id IS DISTINCT FROM p_studio_id
       OR v_request.studio_id IS DISTINCT FROM p_studio_id
       OR v_consent.studio_id IS DISTINCT FROM p_studio_id
       OR v_request.payer_id IS DISTINCT FROM p_payer_id
       OR v_consent.payer_id IS DISTINCT FROM p_payer_id
       OR v_operation.stripe_connected_account_id IS DISTINCT FROM p_stripe_connected_account_id
       OR v_request.stripe_connected_account_id IS DISTINCT FROM p_stripe_connected_account_id
       OR v_consent.stripe_connected_account_id IS DISTINCT FROM p_stripe_connected_account_id
       OR v_operation.connect_account_generation IS DISTINCT FROM p_connect_account_generation
       OR v_request.connect_account_generation IS DISTINCT FROM p_connect_account_generation
       OR v_consent.connect_account_generation IS DISTINCT FROM p_connect_account_generation
       OR v_payer.stripe_account_id IS DISTINCT FROM p_stripe_connected_account_id
       OR v_request.completed_at IS NULL OR v_consent.completed_at IS NULL
       OR v_consent.revoked_at IS NOT NULL OR v_consent.superseded_at IS NOT NULL THEN
        RAISE EXCEPTION USING ERRCODE = '23514',
            MESSAGE = 'billing_payer_setup_projection_identity_mismatch';
    END IF;
    IF v_operation.state NOT IN ('projected', 'completed')
       OR v_payer.default_payment_method_id IS NULL
       OR v_payer.autopay_status <> 'enabled'
       OR v_payer.autopay_authorized_at IS DISTINCT FROM v_consent.completed_at
       OR v_payer.autopay_terms_accepted_at IS DISTINCT FROM v_consent.accepted_at THEN
        RAISE EXCEPTION USING ERRCODE = '55000',
            MESSAGE = 'billing_payer_setup_projection_not_converged';
    END IF;
    UPDATE public.billing_payers
    SET connect_account_generation = p_connect_account_generation
    WHERE id = v_payer.id
    RETURNING * INTO v_payer;
    IF v_operation.state = 'completed' THEN
        RETURN private.billing_payer_payment_consent_json_v1(v_consent, 'replay')
            || jsonb_build_object(
                'setup_request', to_jsonb(v_request),
                'operation', private.billing_provider_operation_json_v1(v_operation, 'replay')->'operation'
            );
    END IF;
    UPDATE public.billing_provider_operations
    SET state = 'completed', completed_at = v_now,
        lease_owner = NULL, lease_acquired_at = NULL, lease_expires_at = NULL,
        revision = revision + 1, updated_at = v_now
    WHERE id = v_operation.id RETURNING * INTO v_operation;
    RETURN private.billing_payer_payment_consent_json_v1(v_consent, 'completed')
        || jsonb_build_object(
            'setup_request', to_jsonb(v_request),
            'operation', private.billing_provider_operation_json_v1(v_operation, 'completed')->'operation'
        );
END;
$$;

ALTER FUNCTION public.finalize_billing_payer_setup_projection_v1(
    UUID, UUID, UUID, UUID, UUID, TEXT, TEXT, TEXT, INTEGER
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.finalize_billing_payer_setup_projection_v1(
    UUID, UUID, UUID, UUID, UUID, TEXT, TEXT, TEXT, INTEGER
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.finalize_billing_payer_setup_projection_v1(
    UUID, UUID, UUID, UUID, UUID, TEXT, TEXT, TEXT, INTEGER
) TO service_role;

ALTER TABLE public.billing_provider_operations
    ADD COLUMN provider_step_plan_sha256 TEXT,
    ADD COLUMN provider_step_expected_count INTEGER,
    ADD COLUMN provider_step_plan_registered_at TIMESTAMPTZ,
    ADD CONSTRAINT billing_provider_operations_step_plan_evidence CHECK (
        (
            provider_step_plan_sha256 IS NULL
            AND provider_step_expected_count IS NULL
            AND provider_step_plan_registered_at IS NULL
        )
        OR (
            provider_step_plan_sha256 ~ '^[0-9a-f]{64}$'
            AND provider_step_expected_count BETWEEN 2 AND 32
            AND provider_step_plan_registered_at IS NOT NULL
            AND provider_step_plan_registered_at >= created_at
        )
    ),
    ADD CONSTRAINT billing_provider_operations_step_identity_unique UNIQUE (
        id,
        studio_id,
        stripe_connected_account_id,
        connect_account_generation
    ),
    ADD CONSTRAINT billing_provider_operations_resource_identity_unique UNIQUE (
        id,
        studio_id,
        operation_type
    );

CREATE TABLE public.billing_provider_operation_steps (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    operation_id UUID NOT NULL,
    studio_id UUID NOT NULL,
    stripe_connected_account_id TEXT NOT NULL,
    connect_account_generation INTEGER NOT NULL,
    step_order INTEGER NOT NULL,
    step_name TEXT NOT NULL,
    provider_operation TEXT NOT NULL,
    request_sha256 TEXT NOT NULL,
    stripe_idempotency_key TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending',
    provider_request_attempt_count INTEGER NOT NULL DEFAULT 0,
    lease_owner UUID,
    lease_acquired_at TIMESTAMPTZ,
    lease_expires_at TIMESTAMPTZ,
    provider_object_id TEXT,
    provider_secondary_object_id TEXT,
    provider_request_id TEXT,
    result_code TEXT,
    error_code TEXT,
    reconciliation_reason_code TEXT,
    recovery_proof_sha256 TEXT,
    recovery_outcome TEXT,
    recovery_actor_id UUID,
    recovery_authorized_at TIMESTAMPTZ,
    revision BIGINT NOT NULL DEFAULT 1,
    provider_request_in_flight_at TIMESTAMPTZ,
    provider_succeeded_at TIMESTAMPTZ,
    reconciliation_required_at TIMESTAMPTZ,
    definitive_failed_at TIMESTAMPTZ,
    definitive_rejected_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT billing_provider_operation_steps_parent_identity_fkey
        FOREIGN KEY (
            operation_id,
            studio_id,
            stripe_connected_account_id,
            connect_account_generation
        ) REFERENCES public.billing_provider_operations (
            id,
            studio_id,
            stripe_connected_account_id,
            connect_account_generation
        ) ON DELETE RESTRICT,
    CONSTRAINT billing_provider_operation_steps_order_unique UNIQUE (operation_id, step_order),
    CONSTRAINT billing_provider_operation_steps_name_unique UNIQUE (operation_id, step_name),
    CONSTRAINT billing_provider_operation_steps_idempotency_unique UNIQUE (
        stripe_connected_account_id,
        connect_account_generation,
        stripe_idempotency_key
    ),
    CONSTRAINT billing_provider_operation_steps_order_bounded CHECK (step_order BETWEEN 1 AND 32),
    CONSTRAINT billing_provider_operation_steps_name_shape
        CHECK (step_name ~ '^[a-z0-9][a-z0-9_.:-]{0,127}$'),
    CONSTRAINT billing_provider_operation_steps_provider_operation_shape
        CHECK (provider_operation ~ '^[a-z0-9][a-z0-9_.:-]{0,127}$'),
    CONSTRAINT billing_provider_operation_steps_request_hash_shape
        CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT billing_provider_operation_steps_idempotency_key_safe CHECK (
        octet_length(stripe_idempotency_key) BETWEEN 1 AND 255
        AND stripe_idempotency_key !~ '[[:cntrl:]]'
        AND stripe_idempotency_key !~* '(https?://|sk_(live|test)_|rk_(live|test)_|whsec_|client_secret|bearer)'
    ),
    CONSTRAINT billing_provider_operation_steps_account_bytes
        CHECK (octet_length(stripe_connected_account_id) BETWEEN 1 AND 255),
    CONSTRAINT billing_provider_operation_steps_generation_positive
        CHECK (connect_account_generation > 0),
    CONSTRAINT billing_provider_operation_steps_state_exact CHECK (state IN (
        'pending', 'provider_request_in_flight', 'provider_succeeded',
        'recovery_authorized', 'reconciliation_required',
        'definitive_failed', 'definitive_rejected'
    )),
    CONSTRAINT billing_provider_operation_steps_attempt_bounded
        CHECK (provider_request_attempt_count BETWEEN 0 AND 2),
    CONSTRAINT billing_provider_operation_steps_revision_positive CHECK (revision > 0),
    CONSTRAINT billing_provider_operation_steps_lease_complete CHECK (
        (lease_owner IS NULL AND lease_acquired_at IS NULL AND lease_expires_at IS NULL)
        OR (
            lease_owner IS NOT NULL
            AND lease_acquired_at IS NOT NULL
            AND lease_expires_at IS NOT NULL
            AND lease_expires_at > lease_acquired_at
        )
    ),
    CONSTRAINT billing_provider_operation_steps_provider_ids_bounded CHECK (
        (provider_object_id IS NULL
            OR provider_object_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,254}$')
        AND (provider_secondary_object_id IS NULL
            OR provider_secondary_object_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,254}$')
        AND (provider_request_id IS NULL
            OR provider_request_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,254}$')
        AND COALESCE(provider_object_id, '')
            !~* '(sk_(live|test)_|rk_(live|test)_|whsec_|client_secret|bearer|[0-9]{13,}|@)'
        AND COALESCE(provider_secondary_object_id, '')
            !~* '(sk_(live|test)_|rk_(live|test)_|whsec_|client_secret|bearer|[0-9]{13,}|@)'
        AND COALESCE(provider_request_id, '')
            !~* '(sk_(live|test)_|rk_(live|test)_|whsec_|client_secret|bearer|[0-9]{13,}|@)'
    ),
    CONSTRAINT billing_provider_operation_steps_codes_safe CHECK (
        (result_code IS NULL OR result_code ~ '^[a-z0-9][a-z0-9_.:-]{0,127}$')
        AND (error_code IS NULL OR error_code ~ '^[a-z0-9][a-z0-9_.:-]{0,127}$')
        AND (reconciliation_reason_code IS NULL
            OR reconciliation_reason_code ~ '^[a-z0-9][a-z0-9_.:-]{0,127}$')
        AND (recovery_proof_sha256 IS NULL OR recovery_proof_sha256 ~ '^[0-9a-f]{64}$')
    ),
    CONSTRAINT billing_provider_operation_steps_recovery_outcome_exact CHECK (
        recovery_outcome IS NULL OR recovery_outcome IN (
            'provider_no_object_safe_to_retry',
            'provider_succeeded_reconcile_only'
        )
    ),
    CONSTRAINT billing_provider_operation_steps_state_evidence CHECK (
        (state = 'pending' AND provider_request_attempt_count = 0)
        OR (state = 'provider_request_in_flight'
            AND provider_request_attempt_count BETWEEN 1 AND 2
            AND provider_request_in_flight_at IS NOT NULL)
        OR (state = 'provider_succeeded'
            AND provider_request_attempt_count BETWEEN 1 AND 2
            AND provider_succeeded_at IS NOT NULL
            AND (provider_object_id IS NOT NULL OR provider_request_id IS NOT NULL))
        OR (state = 'recovery_authorized'
            AND provider_request_attempt_count BETWEEN 1 AND 2
            AND recovery_proof_sha256 IS NOT NULL
            AND recovery_outcome IS NOT NULL
            AND recovery_actor_id IS NOT NULL
            AND recovery_authorized_at IS NOT NULL)
        OR (state = 'reconciliation_required'
            AND provider_request_attempt_count BETWEEN 1 AND 2
            AND reconciliation_reason_code IS NOT NULL
            AND reconciliation_required_at IS NOT NULL)
        OR (state = 'definitive_failed'
            AND error_code IS NOT NULL AND definitive_failed_at IS NOT NULL)
        OR (state = 'definitive_rejected'
            AND error_code IS NOT NULL AND definitive_rejected_at IS NOT NULL)
    )
);

CREATE INDEX billing_provider_operation_steps_parent_order_idx
    ON public.billing_provider_operation_steps (operation_id, step_order);
CREATE INDEX billing_provider_operation_steps_studio_created_idx
    ON public.billing_provider_operation_steps (studio_id, created_at DESC);
CREATE INDEX billing_provider_operation_steps_reconciliation_idx
    ON public.billing_provider_operation_steps (studio_id, reconciliation_required_at)
    WHERE state = 'reconciliation_required';

ALTER TABLE public.billing_provider_operation_steps ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.billing_provider_operation_steps
    FROM PUBLIC, anon, authenticated, service_role;
CREATE POLICY billing_provider_operation_steps_no_client_access
    ON public.billing_provider_operation_steps AS RESTRICTIVE
    FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
CREATE POLICY reject_ambiguous_staff_membership_access
    ON public.billing_provider_operation_steps AS RESTRICTIVE
    FOR ALL TO authenticated
    USING ((SELECT private.has_unambiguous_studio_membership()))
    WITH CHECK ((SELECT private.has_unambiguous_studio_membership()));

CREATE TABLE public.billing_provider_operation_resources (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    operation_id UUID NOT NULL,
    studio_id UUID NOT NULL REFERENCES public.studios(id) ON DELETE CASCADE,
    operation_type TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id UUID NOT NULL,
    payer_id UUID NOT NULL REFERENCES public.billing_payers(id) ON DELETE RESTRICT,
    revision BIGINT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT billing_provider_operation_resources_parent_fkey
        FOREIGN KEY (operation_id, studio_id, operation_type)
        REFERENCES public.billing_provider_operations(id, studio_id, operation_type)
        ON DELETE CASCADE,
    CONSTRAINT billing_provider_operation_resources_identity_unique
        UNIQUE (studio_id, resource_type, resource_id),
    CONSTRAINT billing_provider_operation_resources_operation_unique
        UNIQUE (operation_id),
    CONSTRAINT billing_provider_operation_resources_alias_identity_unique
        UNIQUE (id, studio_id, operation_type, resource_type, resource_id, payer_id),
    CONSTRAINT billing_provider_operation_resources_pair_exact CHECK (
        (operation_type = 'invoice.retry' AND resource_type = 'invoice')
        OR (
            operation_type IN (
                'enrollment.activate.autopay',
                'enrollment.activate.invoice'
            )
            AND resource_type = 'enrollment'
        )
    ),
    CONSTRAINT billing_provider_operation_resources_revision_positive
        CHECK (revision > 0)
);

CREATE TABLE public.billing_provider_operation_resource_aliases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    resource_claim_id UUID NOT NULL,
    operation_id UUID NOT NULL,
    studio_id UUID NOT NULL REFERENCES public.studios(id) ON DELETE CASCADE,
    operation_type TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id UUID NOT NULL,
    payer_id UUID NOT NULL REFERENCES public.billing_payers(id) ON DELETE RESTRICT,
    caller_request_key TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT billing_provider_operation_resource_aliases_resource_fkey
        FOREIGN KEY (
            resource_claim_id,
            studio_id,
            operation_type,
            resource_type,
            resource_id,
            payer_id
        ) REFERENCES public.billing_provider_operation_resources(
            id,
            studio_id,
            operation_type,
            resource_type,
            resource_id,
            payer_id
        ) ON DELETE RESTRICT,
    CONSTRAINT billing_provider_operation_resource_aliases_parent_fkey
        FOREIGN KEY (operation_id, studio_id, operation_type)
        REFERENCES public.billing_provider_operations(id, studio_id, operation_type)
        ON DELETE RESTRICT,
    CONSTRAINT billing_provider_operation_resource_aliases_key_unique
        UNIQUE (studio_id, operation_type, caller_request_key),
    CONSTRAINT billing_provider_operation_resource_aliases_resource_key_unique
        UNIQUE (resource_claim_id, caller_request_key),
    CONSTRAINT billing_provider_operation_resource_aliases_pair_exact CHECK (
        (operation_type = 'invoice.retry' AND resource_type = 'invoice')
        OR (
            operation_type IN (
                'enrollment.activate.autopay',
                'enrollment.activate.invoice'
            )
            AND resource_type = 'enrollment'
        )
    ),
    CONSTRAINT billing_provider_operation_resource_aliases_key_safe CHECK (
        octet_length(caller_request_key) BETWEEN 1 AND 255
        AND caller_request_key = btrim(caller_request_key)
        AND caller_request_key !~ '[[:cntrl:]]'
    )
);

CREATE INDEX billing_provider_operation_resources_operation_idx
    ON public.billing_provider_operation_resources(operation_id);
CREATE INDEX billing_provider_operation_resource_aliases_operation_idx
    ON public.billing_provider_operation_resource_aliases(operation_id, created_at);
CREATE INDEX billing_provider_operation_resource_aliases_resource_idx
    ON public.billing_provider_operation_resource_aliases(resource_claim_id, created_at);

ALTER TABLE public.billing_provider_operation_resources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_provider_operation_resource_aliases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.billing_provider_operation_resources
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.billing_provider_operation_resource_aliases
    FROM PUBLIC, anon, authenticated, service_role;
CREATE POLICY billing_provider_operation_resources_no_client_access
    ON public.billing_provider_operation_resources AS RESTRICTIVE
    FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
CREATE POLICY billing_provider_operation_resource_aliases_no_client_access
    ON public.billing_provider_operation_resource_aliases AS RESTRICTIVE
    FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
CREATE POLICY reject_ambiguous_staff_membership_access
    ON public.billing_provider_operation_resources AS RESTRICTIVE
    FOR ALL TO authenticated
    USING ((SELECT private.has_unambiguous_studio_membership()))
    WITH CHECK ((SELECT private.has_unambiguous_studio_membership()));
CREATE POLICY reject_ambiguous_staff_membership_access
    ON public.billing_provider_operation_resource_aliases AS RESTRICTIVE
    FOR ALL TO authenticated
    USING ((SELECT private.has_unambiguous_studio_membership()))
    WITH CHECK ((SELECT private.has_unambiguous_studio_membership()));

CREATE FUNCTION private.preserve_billing_provider_operation_resource_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
    v_old_state TEXT;
    v_new_state TEXT;
BEGIN
    IF OLD.id IS DISTINCT FROM NEW.id
       OR OLD.studio_id IS DISTINCT FROM NEW.studio_id
       OR OLD.operation_type IS DISTINCT FROM NEW.operation_type
       OR OLD.resource_type IS DISTINCT FROM NEW.resource_type
       OR OLD.resource_id IS DISTINCT FROM NEW.resource_id
       OR OLD.payer_id IS DISTINCT FROM NEW.payer_id
       OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
        RAISE EXCEPTION USING ERRCODE = '23514',
            MESSAGE = 'billing_provider_operation_resource_identity_immutable';
    END IF;
    IF OLD.operation_id IS NOT DISTINCT FROM NEW.operation_id
       OR NEW.revision IS DISTINCT FROM OLD.revision + 1
       OR NEW.updated_at <= OLD.updated_at THEN
        RAISE EXCEPTION USING ERRCODE = '23514',
            MESSAGE = 'billing_provider_operation_resource_revision_invalid';
    END IF;
    SELECT operation.state INTO v_old_state
    FROM public.billing_provider_operations AS operation
    WHERE operation.id = OLD.operation_id;
    SELECT operation.state INTO v_new_state
    FROM public.billing_provider_operations AS operation
    WHERE operation.id = NEW.operation_id
      AND operation.studio_id = NEW.studio_id
      AND operation.operation_type = NEW.operation_type;
    IF v_old_state NOT IN ('definitive_failed', 'definitive_rejected')
       OR v_new_state IS DISTINCT FROM 'started' THEN
        RAISE EXCEPTION USING ERRCODE = '23514',
            MESSAGE = 'billing_provider_operation_resource_replacement_invalid';
    END IF;
    RETURN NEW;
END;
$$;

CREATE FUNCTION private.preserve_billing_provider_operation_resource_alias_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
    RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'billing_provider_operation_resource_alias_immutable';
END;
$$;

ALTER FUNCTION private.preserve_billing_provider_operation_resource_v1()
    OWNER TO postgres;
ALTER FUNCTION private.preserve_billing_provider_operation_resource_alias_v1()
    OWNER TO postgres;
REVOKE ALL ON FUNCTION private.preserve_billing_provider_operation_resource_v1()
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.preserve_billing_provider_operation_resource_alias_v1()
    FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER preserve_billing_provider_operation_resource_v1
    BEFORE UPDATE ON public.billing_provider_operation_resources
    FOR EACH ROW EXECUTE FUNCTION private.preserve_billing_provider_operation_resource_v1();
CREATE TRIGGER preserve_billing_provider_operation_resource_alias_v1
    BEFORE UPDATE ON public.billing_provider_operation_resource_aliases
    FOR EACH ROW EXECUTE FUNCTION private.preserve_billing_provider_operation_resource_alias_v1();

CREATE FUNCTION private.billing_provider_operation_resource_json_v1(
    p_resource public.billing_provider_operation_resources,
    p_operation public.billing_provider_operations,
    p_requested_caller_request_key TEXT,
    p_outcome TEXT
)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
    SELECT private.billing_provider_operation_json_v1(p_operation, p_outcome)
        || jsonb_build_object(
            'requested_caller_request_key', p_requested_caller_request_key,
            'canonical_caller_request_key', p_operation.caller_request_key,
            'resource', jsonb_build_object(
                'id', p_resource.id,
                'studio_id', p_resource.studio_id,
                'operation_type', p_resource.operation_type,
                'resource_type', p_resource.resource_type,
                'resource_id', p_resource.resource_id,
                'payer_id', p_resource.payer_id,
                'operation_id', p_operation.id,
                'revision', p_resource.revision,
                'created_at', p_resource.created_at,
                'updated_at', p_resource.updated_at
            )
        );
$$;

ALTER FUNCTION private.billing_provider_operation_resource_json_v1(
    public.billing_provider_operation_resources,
    public.billing_provider_operations,
    TEXT,
    TEXT
) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.billing_provider_operation_resource_json_v1(
    public.billing_provider_operation_resources,
    public.billing_provider_operations,
    TEXT,
    TEXT
) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.claim_billing_provider_operation_resource_v1(
    p_studio_id UUID,
    p_actor_id UUID,
    p_operation_type TEXT,
    p_resource_type TEXT,
    p_resource_id UUID,
    p_payer_id UUID,
    p_caller_request_key TEXT,
    p_request_sha256 TEXT,
    p_stripe_connected_account_id TEXT,
    p_connect_account_generation INTEGER,
    p_lease_owner UUID,
    p_lease_seconds INTEGER DEFAULT 30
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_alias public.billing_provider_operation_resource_aliases%ROWTYPE;
    v_resource public.billing_provider_operation_resources%ROWTYPE;
    v_operation public.billing_provider_operations%ROWTYPE;
    v_payer public.billing_payers%ROWTYPE;
    v_resource_payer_id UUID;
    v_existing_key_operation_id UUID;
    v_now TIMESTAMPTZ := clock_timestamp();
    v_outcome TEXT;
BEGIN
    IF p_studio_id IS NULL OR p_actor_id IS NULL OR p_resource_id IS NULL
       OR p_payer_id IS NULL
       OR p_lease_owner IS NULL OR p_caller_request_key IS NULL
       OR p_request_sha256 IS NULL
       OR p_stripe_connected_account_id IS NULL
       OR p_connect_account_generation IS NULL
       OR p_lease_seconds IS NULL
       OR NOT (
            (p_operation_type = 'invoice.retry' AND p_resource_type = 'invoice')
            OR (
                p_operation_type IN (
                    'enrollment.activate.autopay',
                    'enrollment.activate.invoice'
                )
                AND p_resource_type = 'enrollment'
            )
       )
       OR p_request_sha256 !~ '^[0-9a-f]{64}$'
       OR p_connect_account_generation <= 0
       OR octet_length(p_stripe_connected_account_id) NOT BETWEEN 1 AND 255
       OR octet_length(p_caller_request_key) NOT BETWEEN 1 AND 255
       OR p_caller_request_key IS DISTINCT FROM btrim(p_caller_request_key)
       OR p_caller_request_key ~ '[[:cntrl:]]'
       OR p_lease_seconds NOT BETWEEN 5 AND 300 THEN
        RAISE EXCEPTION USING ERRCODE = '22023',
            MESSAGE = 'billing_provider_operation_resource_claim_invalid';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM public.staff_roles AS membership
        WHERE membership.studio_id = p_studio_id
          AND membership.user_id = p_actor_id
          AND membership.archived_at IS NULL
          AND membership.role IN ('admin', 'front_desk')
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '42501',
            MESSAGE = 'billing_provider_operation_actor_not_active';
    END IF;

    IF p_resource_type = 'invoice' THEN
        SELECT invoice.payer_id INTO v_resource_payer_id
        FROM public.billing_invoices AS invoice
        WHERE invoice.id = p_resource_id AND invoice.studio_id = p_studio_id
        FOR UPDATE;
    ELSE
        SELECT enrollment.payer_id INTO v_resource_payer_id
        FROM public.student_billing_enrollments AS enrollment
        WHERE enrollment.id = p_resource_id
          AND enrollment.studio_id = p_studio_id
        FOR UPDATE;
    END IF;
    IF v_resource_payer_id IS NULL
       OR v_resource_payer_id IS DISTINCT FROM p_payer_id THEN
        RAISE EXCEPTION USING ERRCODE = '23514',
            MESSAGE = 'billing_provider_operation_resource_tenant_mismatch';
    END IF;

    SELECT * INTO v_payer
    FROM public.billing_payers AS payer
    WHERE payer.id = p_payer_id AND payer.studio_id = p_studio_id
    FOR UPDATE;
    IF NOT FOUND
       OR v_payer.stripe_account_id IS DISTINCT FROM p_stripe_connected_account_id
       OR v_payer.connect_account_generation IS DISTINCT FROM p_connect_account_generation THEN
        RAISE EXCEPTION USING ERRCODE = '23514',
            MESSAGE = 'billing_provider_operation_resource_payer_identity_mismatch';
    END IF;

    SELECT * INTO v_resource
    FROM public.billing_provider_operation_resources AS resource
    WHERE resource.studio_id = p_studio_id
      AND resource.resource_type = p_resource_type
      AND resource.resource_id = p_resource_id
    FOR UPDATE;

    IF v_resource.id IS NOT NULL
       AND (
            v_resource.operation_type IS DISTINCT FROM p_operation_type
            OR v_resource.payer_id IS DISTINCT FROM p_payer_id
       ) THEN
        RAISE EXCEPTION USING ERRCODE = '23505',
            MESSAGE = 'billing_provider_operation_resource_request_conflict';
    END IF;

    SELECT * INTO v_alias
    FROM public.billing_provider_operation_resource_aliases AS alias
    WHERE alias.studio_id = p_studio_id
      AND alias.operation_type = p_operation_type
      AND alias.caller_request_key = p_caller_request_key
    FOR UPDATE;
    IF FOUND THEN
        IF v_resource.id IS NULL
           OR v_alias.resource_claim_id IS DISTINCT FROM v_resource.id
           OR v_alias.resource_type IS DISTINCT FROM p_resource_type
           OR v_alias.resource_id IS DISTINCT FROM p_resource_id
           OR v_alias.payer_id IS DISTINCT FROM p_payer_id THEN
            RAISE EXCEPTION USING ERRCODE = '23505',
                MESSAGE = 'billing_provider_operation_resource_alias_conflict';
        END IF;
        SELECT * INTO v_operation
        FROM public.billing_provider_operations AS operation
        WHERE operation.id = v_alias.operation_id
        FOR UPDATE;
        IF v_operation.actor_id IS DISTINCT FROM p_actor_id THEN
            RAISE EXCEPTION USING ERRCODE = '23505',
                MESSAGE = 'billing_provider_operation_resource_actor_conflict';
        END IF;
        IF v_operation.request_sha256 IS DISTINCT FROM p_request_sha256
           OR v_operation.stripe_connected_account_id
                IS DISTINCT FROM p_stripe_connected_account_id
           OR v_operation.connect_account_generation
                IS DISTINCT FROM p_connect_account_generation THEN
            RAISE EXCEPTION USING ERRCODE = '23505',
                MESSAGE = 'billing_provider_operation_resource_request_conflict';
        END IF;
        IF v_operation.state IN (
            'started', 'recovery_authorized', 'provider_succeeded', 'projected'
        ) AND (
            v_operation.lease_owner IS NULL
            OR v_operation.lease_owner = p_lease_owner
            OR v_operation.lease_expires_at <= v_now
        ) THEN
            UPDATE public.billing_provider_operations
            SET lease_owner = p_lease_owner,
                lease_acquired_at = v_now,
                lease_expires_at = v_now + make_interval(secs => p_lease_seconds),
                revision = revision + 1,
                updated_at = v_now
            WHERE id = v_operation.id
            RETURNING * INTO v_operation;
        END IF;
        RETURN private.billing_provider_operation_resource_json_v1(
            v_resource, v_operation, p_caller_request_key, 'replay'
        );
    END IF;

    IF v_resource.id IS NULL THEN
        BEGIN
            INSERT INTO public.billing_provider_operations (
                studio_id, actor_id, operation_type, caller_request_key,
                request_sha256, stripe_connected_account_id,
                connect_account_generation, lease_owner,
                lease_acquired_at, lease_expires_at, started_at,
                created_at, updated_at
            ) VALUES (
                p_studio_id, p_actor_id, p_operation_type, p_caller_request_key,
                p_request_sha256, p_stripe_connected_account_id,
                p_connect_account_generation, p_lease_owner,
                v_now, v_now + make_interval(secs => p_lease_seconds), v_now,
                v_now, v_now
            ) RETURNING * INTO v_operation;
            INSERT INTO public.billing_provider_operation_resources (
                operation_id, studio_id, operation_type, resource_type,
                resource_id, payer_id, created_at, updated_at
            ) VALUES (
                v_operation.id, p_studio_id, p_operation_type, p_resource_type,
                p_resource_id, p_payer_id, v_now, v_now
            ) RETURNING * INTO v_resource;
            INSERT INTO public.billing_provider_operation_resource_aliases (
                resource_claim_id, operation_id, studio_id, operation_type,
                resource_type, resource_id, payer_id, caller_request_key, created_at
            ) VALUES (
                v_resource.id, v_operation.id, p_studio_id, p_operation_type,
                p_resource_type, p_resource_id, p_payer_id,
                p_caller_request_key, v_now
            );
        EXCEPTION WHEN unique_violation THEN
            RAISE EXCEPTION USING ERRCODE = '23505',
                MESSAGE = 'billing_provider_operation_resource_alias_conflict';
        END;
        RETURN private.billing_provider_operation_resource_json_v1(
            v_resource, v_operation, p_caller_request_key, 'claimed'
        );
    END IF;

    SELECT * INTO v_operation
    FROM public.billing_provider_operations AS operation
    WHERE operation.id = v_resource.operation_id
    FOR UPDATE;
    IF v_operation.state IN ('definitive_failed', 'definitive_rejected') THEN
        BEGIN
            INSERT INTO public.billing_provider_operations (
                studio_id, actor_id, operation_type, caller_request_key,
                request_sha256, stripe_connected_account_id,
                connect_account_generation, lease_owner,
                lease_acquired_at, lease_expires_at, started_at,
                created_at, updated_at
            ) VALUES (
                p_studio_id, p_actor_id, p_operation_type, p_caller_request_key,
                p_request_sha256, p_stripe_connected_account_id,
                p_connect_account_generation, p_lease_owner,
                v_now, v_now + make_interval(secs => p_lease_seconds), v_now,
                v_now, v_now
            ) RETURNING * INTO v_operation;
            UPDATE public.billing_provider_operation_resources
            SET operation_id = v_operation.id,
                revision = revision + 1,
                updated_at = v_now
            WHERE id = v_resource.id
            RETURNING * INTO v_resource;
            INSERT INTO public.billing_provider_operation_resource_aliases (
                resource_claim_id, operation_id, studio_id, operation_type,
                resource_type, resource_id, payer_id, caller_request_key, created_at
            ) VALUES (
                v_resource.id, v_operation.id, p_studio_id, p_operation_type,
                p_resource_type, p_resource_id, p_payer_id,
                p_caller_request_key, v_now
            );
        EXCEPTION WHEN unique_violation THEN
            RAISE EXCEPTION USING ERRCODE = '23505',
                MESSAGE = 'billing_provider_operation_resource_alias_conflict';
        END;
        RETURN private.billing_provider_operation_resource_json_v1(
            v_resource, v_operation, p_caller_request_key, 'replaced'
        );
    END IF;

    IF v_operation.actor_id IS DISTINCT FROM p_actor_id THEN
        RAISE EXCEPTION USING ERRCODE = '23505',
            MESSAGE = 'billing_provider_operation_resource_actor_conflict';
    END IF;
    IF v_operation.request_sha256 IS DISTINCT FROM p_request_sha256
       OR v_operation.stripe_connected_account_id
            IS DISTINCT FROM p_stripe_connected_account_id
       OR v_operation.connect_account_generation
            IS DISTINCT FROM p_connect_account_generation THEN
        RAISE EXCEPTION USING ERRCODE = '23505',
            MESSAGE = 'billing_provider_operation_resource_request_conflict';
    END IF;
    SELECT operation.id INTO v_existing_key_operation_id
    FROM public.billing_provider_operations AS operation
    WHERE operation.studio_id = p_studio_id
      AND operation.operation_type = p_operation_type
      AND operation.caller_request_key = p_caller_request_key;
    IF v_existing_key_operation_id IS NOT NULL
       AND v_existing_key_operation_id IS DISTINCT FROM v_operation.id THEN
        RAISE EXCEPTION USING ERRCODE = '23505',
            MESSAGE = 'billing_provider_operation_resource_alias_conflict';
    END IF;
    IF (
        SELECT count(*) FROM public.billing_provider_operation_resource_aliases AS alias
        WHERE alias.operation_id = v_operation.id
    ) >= 64 THEN
        RAISE EXCEPTION USING ERRCODE = '54000',
            MESSAGE = 'billing_provider_operation_resource_alias_limit';
    END IF;
    BEGIN
        INSERT INTO public.billing_provider_operation_resource_aliases (
            resource_claim_id, operation_id, studio_id, operation_type,
            resource_type, resource_id, payer_id, caller_request_key, created_at
        ) VALUES (
            v_resource.id, v_operation.id, p_studio_id, p_operation_type,
            p_resource_type, p_resource_id, p_payer_id,
            p_caller_request_key, v_now
        );
    EXCEPTION WHEN unique_violation THEN
        RAISE EXCEPTION USING ERRCODE = '23505',
            MESSAGE = 'billing_provider_operation_resource_alias_conflict';
    END;
    IF v_operation.state IN (
        'started', 'recovery_authorized', 'provider_succeeded', 'projected'
    ) AND (
        v_operation.lease_owner IS NULL
        OR v_operation.lease_owner = p_lease_owner
        OR v_operation.lease_expires_at <= v_now
    ) THEN
        UPDATE public.billing_provider_operations
        SET lease_owner = p_lease_owner,
            lease_acquired_at = v_now,
            lease_expires_at = v_now + make_interval(secs => p_lease_seconds),
            revision = revision + 1,
            updated_at = v_now
        WHERE id = v_operation.id
        RETURNING * INTO v_operation;
    END IF;
    RETURN private.billing_provider_operation_resource_json_v1(
        v_resource, v_operation, p_caller_request_key, 'adopted'
    );
END;
$$;

ALTER FUNCTION public.claim_billing_provider_operation_resource_v1(
    UUID, UUID, TEXT, TEXT, UUID, UUID, TEXT, TEXT, TEXT, INTEGER, UUID, INTEGER
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.claim_billing_provider_operation_resource_v1(
    UUID, UUID, TEXT, TEXT, UUID, UUID, TEXT, TEXT, TEXT, INTEGER, UUID, INTEGER
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.claim_billing_provider_operation_resource_v1(
    UUID, UUID, TEXT, TEXT, UUID, UUID, TEXT, TEXT, TEXT, INTEGER, UUID, INTEGER
) TO service_role;

CREATE FUNCTION private.preserve_billing_provider_operation_step_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
    IF OLD.id IS DISTINCT FROM NEW.id
       OR OLD.operation_id IS DISTINCT FROM NEW.operation_id
       OR OLD.studio_id IS DISTINCT FROM NEW.studio_id
       OR OLD.stripe_connected_account_id IS DISTINCT FROM NEW.stripe_connected_account_id
       OR OLD.connect_account_generation IS DISTINCT FROM NEW.connect_account_generation
       OR OLD.step_order IS DISTINCT FROM NEW.step_order
       OR OLD.step_name IS DISTINCT FROM NEW.step_name
       OR OLD.provider_operation IS DISTINCT FROM NEW.provider_operation
       OR OLD.request_sha256 IS DISTINCT FROM NEW.request_sha256
       OR OLD.stripe_idempotency_key IS DISTINCT FROM NEW.stripe_idempotency_key
       OR OLD.created_at IS DISTINCT FROM NEW.created_at
       OR (OLD.provider_object_id IS NOT NULL
           AND OLD.provider_object_id IS DISTINCT FROM NEW.provider_object_id)
       OR (OLD.provider_secondary_object_id IS NOT NULL
           AND OLD.provider_secondary_object_id IS DISTINCT FROM NEW.provider_secondary_object_id)
       OR (OLD.provider_request_id IS NOT NULL
           AND OLD.provider_request_id IS DISTINCT FROM NEW.provider_request_id)
       OR NEW.provider_request_attempt_count < OLD.provider_request_attempt_count THEN
        RAISE EXCEPTION USING ERRCODE = '23514',
            MESSAGE = 'billing_provider_operation_step_identity_immutable';
    END IF;
    IF NEW.revision IS DISTINCT FROM OLD.revision + 1
       OR NEW.updated_at <= OLD.updated_at THEN
        RAISE EXCEPTION USING ERRCODE = '23514',
            MESSAGE = 'billing_provider_operation_step_revision_invalid';
    END IF;
    RETURN NEW;
END;
$$;

ALTER FUNCTION private.preserve_billing_provider_operation_step_v1() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.preserve_billing_provider_operation_step_v1()
    FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER preserve_billing_provider_operation_step_v1
    BEFORE UPDATE ON public.billing_provider_operation_steps
    FOR EACH ROW EXECUTE FUNCTION private.preserve_billing_provider_operation_step_v1();

CREATE FUNCTION private.enforce_billing_provider_step_parent_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
    v_step_count INTEGER;
    v_succeeded_count INTEGER;
    v_final_provider_evidence TEXT;
BEGIN
    IF OLD.provider_step_plan_sha256 IS NOT NULL
       AND (
            OLD.provider_step_plan_sha256 IS DISTINCT FROM NEW.provider_step_plan_sha256
            OR OLD.provider_step_expected_count IS DISTINCT FROM NEW.provider_step_expected_count
            OR OLD.provider_step_plan_registered_at IS DISTINCT FROM NEW.provider_step_plan_registered_at
       ) THEN
        RAISE EXCEPTION USING ERRCODE = '23514',
            MESSAGE = 'billing_provider_operation_step_plan_immutable';
    END IF;

    IF OLD.provider_step_plan_sha256 IS NULL
       AND NEW.provider_step_plan_sha256 IS NOT NULL
       AND (
            OLD.state <> 'started'
            OR NEW.state <> 'started'
            OR OLD.provider_request_attempt_count <> 0
            OR NEW.provider_request_attempt_count <> 0
       ) THEN
        RAISE EXCEPTION USING ERRCODE = '23514',
            MESSAGE = 'billing_provider_operation_step_plan_registration_invalid';
    END IF;

    IF OLD.provider_step_plan_sha256 IS NULL THEN
        RETURN NEW;
    END IF;

    IF NEW.state IN ('provider_request_in_flight', 'recovery_authorized') THEN
        RAISE EXCEPTION USING ERRCODE = '23514',
            MESSAGE = 'billing_provider_operation_step_plan_requires_step_rpc';
    END IF;

    IF NEW.state IN ('started', 'definitive_failed', 'definitive_rejected')
       AND NEW.provider_request_attempt_count <> 0 THEN
        RAISE EXCEPTION USING ERRCODE = '23514',
            MESSAGE = 'billing_provider_operation_step_parent_attempt_invalid';
    END IF;

    IF NEW.state IN (
        'provider_succeeded', 'projected', 'completed', 'reconciliation_required'
    ) AND NEW.provider_request_attempt_count <> 1 THEN
        RAISE EXCEPTION USING ERRCODE = '23514',
            MESSAGE = 'billing_provider_operation_step_parent_attempt_invalid';
    END IF;

    IF OLD.state IS DISTINCT FROM NEW.state AND NEW.state = 'provider_succeeded' THEN
        SELECT count(*),
               count(*) FILTER (WHERE step.state = 'provider_succeeded')
          INTO v_step_count, v_succeeded_count
          FROM public.billing_provider_operation_steps AS step
         WHERE step.operation_id = OLD.id;
        SELECT COALESCE(step.provider_object_id, step.provider_request_id)
          INTO v_final_provider_evidence
          FROM public.billing_provider_operation_steps AS step
         WHERE step.operation_id = OLD.id
         ORDER BY step.step_order DESC
         LIMIT 1;
        IF v_step_count IS DISTINCT FROM OLD.provider_step_expected_count
           OR v_succeeded_count IS DISTINCT FROM OLD.provider_step_expected_count
           OR v_final_provider_evidence IS NULL
           OR NEW.provider_object_id IS DISTINCT FROM v_final_provider_evidence THEN
            RAISE EXCEPTION USING ERRCODE = '23514',
                MESSAGE = 'billing_provider_operation_step_phase_incomplete';
        END IF;
    END IF;

    IF OLD.state IS DISTINCT FROM NEW.state
       AND NEW.state = 'reconciliation_required'
       AND OLD.state NOT IN ('provider_succeeded', 'projected', 'completed')
       AND NOT EXISTS (
            SELECT 1
              FROM public.billing_provider_operation_steps AS step
             WHERE step.operation_id = OLD.id
               AND (
                    step.state NOT IN ('pending', 'provider_succeeded')
                    OR step.provider_request_attempt_count > 0
               )
       ) THEN
        RAISE EXCEPTION USING ERRCODE = '23514',
            MESSAGE = 'billing_provider_operation_step_reconciliation_without_evidence';
    END IF;

    RETURN NEW;
END;
$$;

ALTER FUNCTION private.enforce_billing_provider_step_parent_v1() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.enforce_billing_provider_step_parent_v1()
    FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER enforce_billing_provider_step_parent_v1
    BEFORE UPDATE ON public.billing_provider_operations
    FOR EACH ROW EXECUTE FUNCTION private.enforce_billing_provider_step_parent_v1();

CREATE FUNCTION private.billing_provider_operation_step_json_v1(
    p_step public.billing_provider_operation_steps
)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
    SELECT jsonb_build_object(
        'id', p_step.id,
        'operation_id', p_step.operation_id,
        'studio_id', p_step.studio_id,
        'stripe_connected_account_id', p_step.stripe_connected_account_id,
        'connect_account_generation', p_step.connect_account_generation,
        'step_order', p_step.step_order,
        'step_name', p_step.step_name,
        'provider_operation', p_step.provider_operation,
        'request_sha256', p_step.request_sha256,
        'stripe_idempotency_key', p_step.stripe_idempotency_key,
        'state', p_step.state,
        'provider_request_attempt_count', p_step.provider_request_attempt_count,
        'lease_owner', p_step.lease_owner,
        'lease_acquired_at', p_step.lease_acquired_at,
        'lease_expires_at', p_step.lease_expires_at,
        'provider_object_id', p_step.provider_object_id,
        'provider_secondary_object_id', p_step.provider_secondary_object_id,
        'provider_request_id', p_step.provider_request_id,
        'result_code', p_step.result_code,
        'error_code', p_step.error_code,
        'reconciliation_reason_code', p_step.reconciliation_reason_code,
        'recovery_proof_sha256', p_step.recovery_proof_sha256,
        'recovery_outcome', p_step.recovery_outcome,
        'recovery_actor_id', p_step.recovery_actor_id,
        'recovery_authorized_at', p_step.recovery_authorized_at,
        'revision', p_step.revision,
        'provider_request_in_flight_at', p_step.provider_request_in_flight_at,
        'provider_succeeded_at', p_step.provider_succeeded_at,
        'reconciliation_required_at', p_step.reconciliation_required_at,
        'definitive_failed_at', p_step.definitive_failed_at,
        'definitive_rejected_at', p_step.definitive_rejected_at,
        'created_at', p_step.created_at,
        'updated_at', p_step.updated_at
    );
$$;

CREATE FUNCTION private.billing_provider_operation_step_plan_json_v1(
    p_operation public.billing_provider_operations,
    p_outcome TEXT
)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
    SELECT jsonb_build_object(
        'outcome', p_outcome,
        'operation',
            (private.billing_provider_operation_json_v1(p_operation, p_outcome)->'operation')
            || jsonb_build_object(
                'provider_step_plan_sha256', p_operation.provider_step_plan_sha256,
                'provider_step_expected_count', p_operation.provider_step_expected_count,
                'provider_step_plan_registered_at', p_operation.provider_step_plan_registered_at
            ),
        'steps', COALESCE(
            (
                SELECT jsonb_agg(
                    private.billing_provider_operation_step_json_v1(step)
                    ORDER BY step.step_order
                )
                FROM public.billing_provider_operation_steps AS step
                WHERE step.operation_id = p_operation.id
            ),
            '[]'::JSONB
        )
    );
$$;

ALTER FUNCTION private.billing_provider_operation_step_json_v1(
    public.billing_provider_operation_steps
) OWNER TO postgres;
ALTER FUNCTION private.billing_provider_operation_step_plan_json_v1(
    public.billing_provider_operations,
    TEXT
) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.billing_provider_operation_step_json_v1(
    public.billing_provider_operation_steps
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.billing_provider_operation_step_plan_json_v1(
    public.billing_provider_operations,
    TEXT
) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.register_billing_provider_operation_step_plan_v1(
    p_operation_id UUID, p_studio_id UUID, p_actor_id UUID,
    p_operation_type TEXT, p_caller_request_key TEXT, p_request_sha256 TEXT,
    p_stripe_connected_account_id TEXT, p_connect_account_generation INTEGER,
    p_lease_owner UUID, p_expected_parent_revision BIGINT,
    p_plan_sha256 TEXT, p_expected_step_count INTEGER, p_steps JSONB
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_operation public.billing_provider_operations%ROWTYPE;
    v_now TIMESTAMPTZ := clock_timestamp();
    v_actual_plan_sha256 TEXT;
    v_existing_plan JSONB;
BEGIN
    IF p_plan_sha256 IS NULL OR p_plan_sha256 !~ '^[0-9a-f]{64}$'
       OR p_expected_step_count NOT BETWEEN 2 AND 32
       OR jsonb_typeof(p_steps) IS DISTINCT FROM 'array'
       OR jsonb_array_length(p_steps) IS DISTINCT FROM p_expected_step_count THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'billing_provider_operation_step_plan_invalid';
    END IF;
    IF EXISTS (
        SELECT 1 FROM jsonb_array_elements(p_steps) AS plan_step(value)
        WHERE jsonb_typeof(plan_step.value) IS DISTINCT FROM 'object'
           OR (SELECT array_agg(key ORDER BY key COLLATE "C")
               FROM jsonb_object_keys(plan_step.value) AS object_key(key))
              IS DISTINCT FROM ARRAY['provider_operation','request_sha256','step_name','stripe_idempotency_key']::TEXT[]
           OR plan_step.value->>'step_name' IS NULL
           OR plan_step.value->>'step_name' !~ '^[a-z0-9][a-z0-9_.:-]{0,127}$'
           OR plan_step.value->>'provider_operation' IS NULL
           OR plan_step.value->>'provider_operation' !~ '^[a-z0-9][a-z0-9_.:-]{0,127}$'
           OR plan_step.value->>'request_sha256' IS NULL
           OR plan_step.value->>'request_sha256' !~ '^[0-9a-f]{64}$'
           OR plan_step.value->>'stripe_idempotency_key' IS NULL
           OR octet_length(plan_step.value->>'stripe_idempotency_key') NOT BETWEEN 1 AND 255
           OR plan_step.value->>'stripe_idempotency_key' ~ '[[:cntrl:]]'
           OR plan_step.value->>'stripe_idempotency_key' ~* '(https?://|sk_(live|test)_|rk_(live|test)_|whsec_|client_secret|bearer)'
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'billing_provider_operation_step_plan_invalid';
    END IF;
    IF EXISTS (
        SELECT 1 FROM jsonb_array_elements(p_steps) AS plan_step(value)
        GROUP BY plan_step.value->>'step_name' HAVING count(*) > 1
    ) OR EXISTS (
        SELECT 1 FROM jsonb_array_elements(p_steps) AS plan_step(value)
        GROUP BY plan_step.value->>'stripe_idempotency_key' HAVING count(*) > 1
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'billing_provider_operation_step_plan_duplicate_identity';
    END IF;
    v_actual_plan_sha256 := encode(
        extensions.digest(convert_to(p_steps::TEXT, 'UTF8'), 'sha256'), 'hex'
    );
    IF v_actual_plan_sha256 IS DISTINCT FROM p_plan_sha256 THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'billing_provider_operation_step_plan_hash_mismatch';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM public.staff_roles AS membership
        WHERE membership.studio_id = p_studio_id AND membership.user_id = p_actor_id
          AND membership.archived_at IS NULL AND membership.role IN ('admin', 'front_desk')
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'billing_provider_operation_step_actor_not_active';
    END IF;
    SELECT * INTO v_operation FROM public.billing_provider_operations
    WHERE id = p_operation_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'billing_provider_operation_not_found';
    END IF;
    IF v_operation.studio_id IS DISTINCT FROM p_studio_id
       OR v_operation.actor_id IS DISTINCT FROM p_actor_id
       OR v_operation.operation_type IS DISTINCT FROM p_operation_type
       OR v_operation.caller_request_key IS DISTINCT FROM p_caller_request_key
       OR v_operation.request_sha256 IS DISTINCT FROM p_request_sha256
       OR v_operation.stripe_connected_account_id IS DISTINCT FROM p_stripe_connected_account_id
       OR v_operation.connect_account_generation IS DISTINCT FROM p_connect_account_generation THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'billing_provider_operation_identity_mismatch';
    END IF;
    IF v_operation.provider_step_plan_sha256 IS NOT NULL THEN
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
            'step_name', step.step_name,
            'provider_operation', step.provider_operation,
            'request_sha256', step.request_sha256,
            'stripe_idempotency_key', step.stripe_idempotency_key
        ) ORDER BY step.step_order), '[]'::JSONB)
        INTO v_existing_plan
        FROM public.billing_provider_operation_steps AS step
        WHERE step.operation_id = p_operation_id;
        IF v_operation.provider_step_plan_sha256 IS DISTINCT FROM p_plan_sha256
           OR v_operation.provider_step_expected_count IS DISTINCT FROM p_expected_step_count
           OR v_existing_plan IS DISTINCT FROM p_steps THEN
            RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'billing_provider_operation_step_plan_conflict';
        END IF;
        RETURN private.billing_provider_operation_step_plan_json_v1(v_operation, 'replay');
    END IF;
    IF v_operation.state <> 'started' OR v_operation.provider_request_attempt_count <> 0
       OR v_operation.lease_owner IS DISTINCT FROM p_lease_owner
       OR v_operation.revision IS DISTINCT FROM p_expected_parent_revision THEN
        RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'billing_provider_operation_step_plan_parent_not_claimed';
    END IF;
    UPDATE public.billing_provider_operations
    SET provider_step_plan_sha256 = p_plan_sha256,
        provider_step_expected_count = p_expected_step_count,
        provider_step_plan_registered_at = v_now,
        revision = revision + 1,
        updated_at = v_now
    WHERE id = p_operation_id RETURNING * INTO v_operation;
    BEGIN
        INSERT INTO public.billing_provider_operation_steps (
            operation_id, studio_id, stripe_connected_account_id,
            connect_account_generation, step_order, step_name, provider_operation,
            request_sha256, stripe_idempotency_key, created_at, updated_at
        )
        SELECT p_operation_id, p_studio_id, p_stripe_connected_account_id,
               p_connect_account_generation, plan_step.ordinality::INTEGER,
               plan_step.value->>'step_name', plan_step.value->>'provider_operation',
               plan_step.value->>'request_sha256', plan_step.value->>'stripe_idempotency_key',
               v_now, v_now
        FROM jsonb_array_elements(p_steps) WITH ORDINALITY AS plan_step(value, ordinality);
    EXCEPTION WHEN unique_violation THEN
        RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'billing_provider_operation_step_idempotency_conflict';
    END;
    RETURN private.billing_provider_operation_step_plan_json_v1(v_operation, 'registered');
END;
$$;

ALTER FUNCTION public.register_billing_provider_operation_step_plan_v1(
    UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, INTEGER, UUID, BIGINT, TEXT, INTEGER, JSONB
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.register_billing_provider_operation_step_plan_v1(
    UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, INTEGER, UUID, BIGINT, TEXT, INTEGER, JSONB
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.register_billing_provider_operation_step_plan_v1(
    UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, INTEGER, UUID, BIGINT, TEXT, INTEGER, JSONB
) TO service_role;

CREATE FUNCTION public.read_billing_provider_operation_step_plan_v1(
    p_operation_id UUID, p_studio_id UUID, p_reader_id UUID,
    p_operation_type TEXT, p_caller_request_key TEXT, p_request_sha256 TEXT,
    p_stripe_connected_account_id TEXT, p_connect_account_generation INTEGER,
    p_plan_sha256 TEXT
)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_operation public.billing_provider_operations%ROWTYPE;
BEGIN
    SELECT * INTO v_operation FROM public.billing_provider_operations
    WHERE id = p_operation_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'billing_provider_operation_not_found';
    END IF;
    IF v_operation.studio_id IS DISTINCT FROM p_studio_id
       OR v_operation.operation_type IS DISTINCT FROM p_operation_type
       OR v_operation.caller_request_key IS DISTINCT FROM p_caller_request_key
       OR v_operation.request_sha256 IS DISTINCT FROM p_request_sha256
       OR v_operation.stripe_connected_account_id IS DISTINCT FROM p_stripe_connected_account_id
       OR v_operation.connect_account_generation IS DISTINCT FROM p_connect_account_generation
       OR v_operation.provider_step_plan_sha256 IS DISTINCT FROM p_plan_sha256 THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'billing_provider_operation_step_plan_identity_mismatch';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM public.staff_roles AS membership
        WHERE membership.studio_id = p_studio_id AND membership.user_id = p_reader_id
          AND membership.archived_at IS NULL AND membership.role IN ('admin', 'front_desk')
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'billing_provider_operation_step_reader_not_active';
    END IF;
    RETURN private.billing_provider_operation_step_plan_json_v1(v_operation, 'read');
END;
$$;

ALTER FUNCTION public.read_billing_provider_operation_step_plan_v1(
    UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.read_billing_provider_operation_step_plan_v1(
    UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.read_billing_provider_operation_step_plan_v1(
    UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT
) TO service_role;

CREATE FUNCTION private.billing_provider_operation_step_result_json_v1(
    p_operation public.billing_provider_operations,
    p_step public.billing_provider_operation_steps,
    p_outcome TEXT
)
RETURNS JSONB LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
    SELECT jsonb_build_object(
        'outcome', p_outcome,
        'operation',
            (private.billing_provider_operation_json_v1(p_operation, p_outcome)->'operation')
            || jsonb_build_object(
                'provider_step_plan_sha256', p_operation.provider_step_plan_sha256,
                'provider_step_expected_count', p_operation.provider_step_expected_count,
                'provider_step_plan_registered_at', p_operation.provider_step_plan_registered_at
            ),
        'step', private.billing_provider_operation_step_json_v1(p_step)
    );
$$;
ALTER FUNCTION private.billing_provider_operation_step_result_json_v1(
    public.billing_provider_operations,
    public.billing_provider_operation_steps,
    TEXT
) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.billing_provider_operation_step_result_json_v1(
    public.billing_provider_operations,
    public.billing_provider_operation_steps,
    TEXT
) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.claim_billing_provider_operation_step_v1(
    p_operation_id UUID, p_studio_id UUID, p_actor_id UUID,
    p_operation_type TEXT, p_caller_request_key TEXT, p_parent_request_sha256 TEXT,
    p_stripe_connected_account_id TEXT, p_connect_account_generation INTEGER,
    p_plan_sha256 TEXT, p_step_order INTEGER, p_step_name TEXT,
    p_provider_operation TEXT, p_step_request_sha256 TEXT,
    p_stripe_idempotency_key TEXT, p_lease_owner UUID,
    p_lease_seconds INTEGER DEFAULT 30
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_operation public.billing_provider_operations%ROWTYPE;
    v_step public.billing_provider_operation_steps%ROWTYPE;
    v_now TIMESTAMPTZ := clock_timestamp();
    v_outcome TEXT;
BEGIN
    IF p_lease_owner IS NULL OR p_lease_seconds NOT BETWEEN 5 AND 300 THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'billing_provider_operation_step_claim_invalid';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM public.staff_roles AS membership
        WHERE membership.studio_id = p_studio_id AND membership.user_id = p_actor_id
          AND membership.archived_at IS NULL AND membership.role IN ('admin', 'front_desk')
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'billing_provider_operation_step_actor_not_active';
    END IF;
    SELECT * INTO v_operation FROM public.billing_provider_operations
    WHERE id = p_operation_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'billing_provider_operation_not_found';
    END IF;
    SELECT * INTO v_step FROM public.billing_provider_operation_steps
    WHERE operation_id = p_operation_id AND step_order = p_step_order FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'billing_provider_operation_step_not_found';
    END IF;
    IF v_operation.studio_id IS DISTINCT FROM p_studio_id
       OR v_operation.actor_id IS DISTINCT FROM p_actor_id
       OR v_operation.operation_type IS DISTINCT FROM p_operation_type
       OR v_operation.caller_request_key IS DISTINCT FROM p_caller_request_key
       OR v_operation.request_sha256 IS DISTINCT FROM p_parent_request_sha256
       OR v_operation.stripe_connected_account_id IS DISTINCT FROM p_stripe_connected_account_id
       OR v_operation.connect_account_generation IS DISTINCT FROM p_connect_account_generation
       OR v_operation.provider_step_plan_sha256 IS DISTINCT FROM p_plan_sha256
       OR v_step.studio_id IS DISTINCT FROM p_studio_id
       OR v_step.stripe_connected_account_id IS DISTINCT FROM p_stripe_connected_account_id
       OR v_step.connect_account_generation IS DISTINCT FROM p_connect_account_generation
       OR v_step.step_name IS DISTINCT FROM p_step_name
       OR v_step.provider_operation IS DISTINCT FROM p_provider_operation
       OR v_step.request_sha256 IS DISTINCT FROM p_step_request_sha256
       OR v_step.stripe_idempotency_key IS DISTINCT FROM p_stripe_idempotency_key THEN
        RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'billing_provider_operation_step_request_conflict';
    END IF;
    IF v_operation.state NOT IN ('started', 'reconciliation_required', 'provider_succeeded') THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'billing_provider_operation_step_parent_state_invalid';
    END IF;
    IF EXISTS (
        SELECT 1 FROM public.billing_provider_operation_steps AS prior_step
        WHERE prior_step.operation_id = p_operation_id
          AND prior_step.step_order < p_step_order
          AND prior_step.state <> 'provider_succeeded'
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'billing_provider_operation_step_predecessor_incomplete';
    END IF;
    IF v_step.state IN ('provider_succeeded', 'definitive_failed', 'definitive_rejected') THEN
        RETURN private.billing_provider_operation_step_result_json_v1(v_operation, v_step, 'replay');
    ELSIF v_step.state = 'provider_request_in_flight' THEN
        RETURN private.billing_provider_operation_step_result_json_v1(
            v_operation, v_step, 'provider_request_in_flight'
        );
    ELSIF v_step.state = 'reconciliation_required' THEN
        RETURN private.billing_provider_operation_step_result_json_v1(
            v_operation, v_step, 'reconciliation_required'
        );
    ELSIF v_operation.state = 'provider_succeeded' THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'billing_provider_operation_step_parent_already_succeeded';
    ELSIF v_step.lease_owner IS DISTINCT FROM p_lease_owner
          AND v_step.lease_expires_at > v_now THEN
        RETURN private.billing_provider_operation_step_result_json_v1(v_operation, v_step, 'busy');
    END IF;
    v_outcome := CASE WHEN v_step.state = 'pending' THEN 'claimed' ELSE 'continued' END;
    UPDATE public.billing_provider_operation_steps
    SET lease_owner = p_lease_owner,
        lease_acquired_at = v_now,
        lease_expires_at = v_now + make_interval(secs => p_lease_seconds),
        revision = revision + 1,
        updated_at = v_now
    WHERE id = v_step.id RETURNING * INTO v_step;
    RETURN private.billing_provider_operation_step_result_json_v1(v_operation, v_step, v_outcome);
END;
$$;

ALTER FUNCTION public.claim_billing_provider_operation_step_v1(
    UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT, INTEGER,
    TEXT, TEXT, TEXT, TEXT, UUID, INTEGER
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.claim_billing_provider_operation_step_v1(
    UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT, INTEGER,
    TEXT, TEXT, TEXT, TEXT, UUID, INTEGER
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.claim_billing_provider_operation_step_v1(
    UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT, INTEGER,
    TEXT, TEXT, TEXT, TEXT, UUID, INTEGER
) TO service_role;

CREATE FUNCTION public.transition_billing_provider_operation_step_v1(
    p_operation_id UUID, p_studio_id UUID, p_actor_id UUID,
    p_operation_type TEXT, p_caller_request_key TEXT, p_parent_request_sha256 TEXT,
    p_stripe_connected_account_id TEXT, p_connect_account_generation INTEGER,
    p_plan_sha256 TEXT, p_step_order INTEGER, p_step_name TEXT,
    p_provider_operation TEXT, p_step_request_sha256 TEXT,
    p_stripe_idempotency_key TEXT, p_lease_owner UUID,
    p_expected_step_revision BIGINT, p_to_state TEXT,
    p_provider_object_id TEXT DEFAULT NULL,
    p_provider_secondary_object_id TEXT DEFAULT NULL,
    p_provider_request_id TEXT DEFAULT NULL,
    p_result_code TEXT DEFAULT NULL,
    p_error_code TEXT DEFAULT NULL,
    p_reconciliation_reason_code TEXT DEFAULT NULL
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_operation public.billing_provider_operations%ROWTYPE;
    v_step public.billing_provider_operation_steps%ROWTYPE;
    v_now TIMESTAMPTZ := clock_timestamp();
    v_legal BOOLEAN := false;
BEGIN
    SELECT * INTO v_operation FROM public.billing_provider_operations
    WHERE id = p_operation_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'billing_provider_operation_not_found';
    END IF;
    SELECT * INTO v_step FROM public.billing_provider_operation_steps
    WHERE operation_id = p_operation_id AND step_order = p_step_order FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'billing_provider_operation_step_not_found';
    END IF;
    IF v_operation.studio_id IS DISTINCT FROM p_studio_id
       OR v_operation.actor_id IS DISTINCT FROM p_actor_id
       OR v_operation.operation_type IS DISTINCT FROM p_operation_type
       OR v_operation.caller_request_key IS DISTINCT FROM p_caller_request_key
       OR v_operation.request_sha256 IS DISTINCT FROM p_parent_request_sha256
       OR v_operation.stripe_connected_account_id IS DISTINCT FROM p_stripe_connected_account_id
       OR v_operation.connect_account_generation IS DISTINCT FROM p_connect_account_generation
       OR v_operation.provider_step_plan_sha256 IS DISTINCT FROM p_plan_sha256
       OR v_step.step_name IS DISTINCT FROM p_step_name
       OR v_step.provider_operation IS DISTINCT FROM p_provider_operation
       OR v_step.request_sha256 IS DISTINCT FROM p_step_request_sha256
       OR v_step.stripe_idempotency_key IS DISTINCT FROM p_stripe_idempotency_key THEN
        RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'billing_provider_operation_step_request_conflict';
    END IF;
    IF v_operation.state NOT IN ('started', 'reconciliation_required') THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'billing_provider_operation_step_parent_state_invalid';
    END IF;
    IF v_step.state = p_to_state
       AND v_step.state IN (
            'provider_succeeded', 'reconciliation_required',
            'definitive_failed', 'definitive_rejected'
       ) THEN
        IF (p_provider_object_id IS NOT NULL
                AND v_step.provider_object_id IS DISTINCT FROM p_provider_object_id)
           OR (p_provider_secondary_object_id IS NOT NULL
                AND v_step.provider_secondary_object_id IS DISTINCT FROM p_provider_secondary_object_id)
           OR (p_provider_request_id IS NOT NULL
                AND v_step.provider_request_id IS DISTINCT FROM p_provider_request_id)
           OR (p_reconciliation_reason_code IS NOT NULL
                AND v_step.reconciliation_reason_code IS DISTINCT FROM p_reconciliation_reason_code)
           OR (p_error_code IS NOT NULL AND v_step.error_code IS DISTINCT FROM p_error_code) THEN
            RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'billing_provider_operation_step_transition_conflict';
        END IF;
        RETURN private.billing_provider_operation_step_result_json_v1(v_operation, v_step, 'replay');
    END IF;
    IF v_step.revision IS DISTINCT FROM p_expected_step_revision THEN
        RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'billing_provider_operation_step_stale_revision';
    END IF;
    IF v_step.state <> 'reconciliation_required'
       AND v_step.lease_owner IS DISTINCT FROM p_lease_owner THEN
        RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'billing_provider_operation_step_lease_owner_mismatch';
    END IF;
    v_legal := CASE v_step.state
        WHEN 'pending' THEN p_to_state IN (
            'provider_request_in_flight', 'definitive_failed', 'definitive_rejected'
        )
        WHEN 'provider_request_in_flight' THEN p_to_state IN (
            'provider_succeeded', 'reconciliation_required',
            'definitive_failed', 'definitive_rejected'
        )
        WHEN 'recovery_authorized' THEN (
            (v_step.recovery_outcome = 'provider_no_object_safe_to_retry'
                AND p_to_state = 'provider_request_in_flight')
            OR (v_step.recovery_outcome = 'provider_succeeded_reconcile_only'
                AND p_to_state = 'provider_succeeded')
        )
        WHEN 'reconciliation_required' THEN p_to_state IN (
            'definitive_failed', 'definitive_rejected'
        )
        ELSE false
    END;
    IF NOT v_legal THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'billing_provider_operation_step_invalid_transition';
    END IF;
    IF p_to_state = 'provider_request_in_flight'
       AND v_step.provider_request_attempt_count <> 0
       AND v_step.state <> 'recovery_authorized' THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'billing_provider_operation_step_second_attempt_denied';
    END IF;
    IF p_to_state = 'provider_request_in_flight'
       AND v_step.provider_request_attempt_count >= 2 THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'billing_provider_operation_step_retry_limit_reached';
    END IF;
    IF p_to_state = 'provider_succeeded'
       AND COALESCE(p_provider_object_id, v_step.provider_object_id,
                    p_provider_request_id, v_step.provider_request_id) IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'billing_provider_operation_step_provider_evidence_required';
    END IF;
    IF p_to_state = 'reconciliation_required'
       AND (p_reconciliation_reason_code IS NULL
            OR p_reconciliation_reason_code !~ '^[a-z0-9][a-z0-9_.:-]{0,127}$') THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'billing_provider_operation_step_reconciliation_reason_required';
    END IF;
    IF p_to_state IN ('definitive_failed', 'definitive_rejected')
       AND (p_error_code IS NULL OR p_error_code !~ '^[a-z0-9][a-z0-9_.:-]{0,127}$') THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'billing_provider_operation_step_error_code_required';
    END IF;
    UPDATE public.billing_provider_operation_steps
    SET state = p_to_state,
        provider_request_attempt_count = CASE
            WHEN p_to_state = 'provider_request_in_flight'
                THEN provider_request_attempt_count + 1
            ELSE provider_request_attempt_count
        END,
        provider_object_id = COALESCE(p_provider_object_id, provider_object_id),
        provider_secondary_object_id = COALESCE(
            p_provider_secondary_object_id, provider_secondary_object_id
        ),
        provider_request_id = COALESCE(p_provider_request_id, provider_request_id),
        result_code = COALESCE(p_result_code, result_code),
        error_code = CASE
            WHEN p_to_state IN ('definitive_failed', 'definitive_rejected')
                THEN p_error_code
            ELSE error_code
        END,
        reconciliation_reason_code = CASE
            WHEN p_to_state = 'reconciliation_required'
                THEN p_reconciliation_reason_code
            ELSE NULL
        END,
        provider_request_in_flight_at = CASE
            WHEN p_to_state = 'provider_request_in_flight' THEN v_now
            ELSE provider_request_in_flight_at
        END,
        provider_succeeded_at = CASE
            WHEN p_to_state = 'provider_succeeded' THEN COALESCE(provider_succeeded_at, v_now)
            ELSE provider_succeeded_at
        END,
        reconciliation_required_at = CASE
            WHEN p_to_state = 'reconciliation_required' THEN v_now
            ELSE reconciliation_required_at
        END,
        definitive_failed_at = CASE
            WHEN p_to_state = 'definitive_failed' THEN v_now ELSE definitive_failed_at
        END,
        definitive_rejected_at = CASE
            WHEN p_to_state = 'definitive_rejected' THEN v_now ELSE definitive_rejected_at
        END,
        lease_owner = CASE
            WHEN p_to_state IN (
                'provider_succeeded', 'reconciliation_required',
                'definitive_failed', 'definitive_rejected'
            ) THEN NULL ELSE lease_owner
        END,
        lease_acquired_at = CASE
            WHEN p_to_state IN (
                'provider_succeeded', 'reconciliation_required',
                'definitive_failed', 'definitive_rejected'
            ) THEN NULL ELSE lease_acquired_at
        END,
        lease_expires_at = CASE
            WHEN p_to_state IN (
                'provider_succeeded', 'reconciliation_required',
                'definitive_failed', 'definitive_rejected'
            ) THEN NULL ELSE lease_expires_at
        END,
        revision = revision + 1,
        updated_at = v_now
    WHERE id = v_step.id RETURNING * INTO v_step;

    IF p_to_state IN (
        'reconciliation_required', 'definitive_failed', 'definitive_rejected'
    ) THEN
        UPDATE public.billing_provider_operations
        SET state = 'reconciliation_required',
            provider_request_attempt_count = 1,
            reconciliation_reason_code = CASE
                WHEN p_to_state = 'reconciliation_required'
                    THEN 'provider_step_reconciliation_required'
                ELSE 'provider_step_definitive_failure'
            END,
            reconciliation_required_at = COALESCE(reconciliation_required_at, v_now),
            lease_owner = NULL,
            lease_acquired_at = NULL,
            lease_expires_at = NULL,
            revision = revision + 1,
            updated_at = v_now
        WHERE id = p_operation_id
        RETURNING * INTO v_operation;
    END IF;
    RETURN private.billing_provider_operation_step_result_json_v1(v_operation, v_step, 'transitioned');
END;
$$;

ALTER FUNCTION public.transition_billing_provider_operation_step_v1(
    UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT, INTEGER,
    TEXT, TEXT, TEXT, TEXT, UUID, BIGINT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.transition_billing_provider_operation_step_v1(
    UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT, INTEGER,
    TEXT, TEXT, TEXT, TEXT, UUID, BIGINT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.transition_billing_provider_operation_step_v1(
    UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT, INTEGER,
    TEXT, TEXT, TEXT, TEXT, UUID, BIGINT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT
) TO service_role;

CREATE FUNCTION public.authorize_billing_provider_operation_step_recovery_v1(
    p_operation_id UUID, p_studio_id UUID, p_actor_id UUID,
    p_operation_type TEXT, p_caller_request_key TEXT, p_parent_request_sha256 TEXT,
    p_stripe_connected_account_id TEXT, p_connect_account_generation INTEGER,
    p_plan_sha256 TEXT, p_step_order INTEGER, p_step_name TEXT,
    p_provider_operation TEXT, p_step_request_sha256 TEXT,
    p_stripe_idempotency_key TEXT, p_recovery_actor_id UUID,
    p_recovery_proof_sha256 TEXT, p_recovery_outcome TEXT,
    p_lease_owner UUID, p_lease_seconds INTEGER, p_expected_step_revision BIGINT
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_operation public.billing_provider_operations%ROWTYPE;
    v_step public.billing_provider_operation_steps%ROWTYPE;
    v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
    IF p_recovery_proof_sha256 IS NULL
       OR p_recovery_proof_sha256 !~ '^[0-9a-f]{64}$'
       OR p_recovery_outcome NOT IN (
            'provider_no_object_safe_to_retry',
            'provider_succeeded_reconcile_only'
       )
       OR p_lease_owner IS NULL OR p_lease_seconds NOT BETWEEN 5 AND 300 THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'billing_provider_operation_step_recovery_invalid';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM public.staff_roles AS membership
        WHERE membership.studio_id = p_studio_id
          AND membership.user_id = p_recovery_actor_id
          AND membership.archived_at IS NULL
          AND membership.role = 'admin'
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'billing_provider_operation_step_recovery_actor_not_admin';
    END IF;
    SELECT * INTO v_operation FROM public.billing_provider_operations
    WHERE id = p_operation_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'billing_provider_operation_not_found';
    END IF;
    SELECT * INTO v_step FROM public.billing_provider_operation_steps
    WHERE operation_id = p_operation_id AND step_order = p_step_order FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'billing_provider_operation_step_not_found';
    END IF;
    IF v_operation.studio_id IS DISTINCT FROM p_studio_id
       OR v_operation.actor_id IS DISTINCT FROM p_actor_id
       OR v_operation.operation_type IS DISTINCT FROM p_operation_type
       OR v_operation.caller_request_key IS DISTINCT FROM p_caller_request_key
       OR v_operation.request_sha256 IS DISTINCT FROM p_parent_request_sha256
       OR v_operation.stripe_connected_account_id IS DISTINCT FROM p_stripe_connected_account_id
       OR v_operation.connect_account_generation IS DISTINCT FROM p_connect_account_generation
       OR v_operation.provider_step_plan_sha256 IS DISTINCT FROM p_plan_sha256
       OR v_step.step_name IS DISTINCT FROM p_step_name
       OR v_step.provider_operation IS DISTINCT FROM p_provider_operation
       OR v_step.request_sha256 IS DISTINCT FROM p_step_request_sha256
       OR v_step.stripe_idempotency_key IS DISTINCT FROM p_stripe_idempotency_key THEN
        RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'billing_provider_operation_step_request_conflict';
    END IF;
    IF v_step.state = 'recovery_authorized'
       AND v_step.recovery_actor_id IS NOT DISTINCT FROM p_recovery_actor_id
       AND v_step.recovery_proof_sha256 IS NOT DISTINCT FROM p_recovery_proof_sha256
       AND v_step.recovery_outcome IS NOT DISTINCT FROM p_recovery_outcome THEN
        RETURN private.billing_provider_operation_step_result_json_v1(v_operation, v_step, 'replay');
    END IF;
    IF v_step.revision IS DISTINCT FROM p_expected_step_revision THEN
        RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'billing_provider_operation_step_stale_revision';
    END IF;
    IF v_step.state NOT IN ('provider_request_in_flight', 'reconciliation_required') THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'billing_provider_operation_step_recovery_state_invalid';
    END IF;
    IF p_recovery_outcome = 'provider_no_object_safe_to_retry'
       AND v_step.provider_request_attempt_count >= 2 THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'billing_provider_operation_step_retry_limit_reached';
    END IF;
    UPDATE public.billing_provider_operation_steps
    SET state = 'recovery_authorized',
        recovery_actor_id = p_recovery_actor_id,
        recovery_proof_sha256 = p_recovery_proof_sha256,
        recovery_outcome = p_recovery_outcome,
        recovery_authorized_at = v_now,
        reconciliation_reason_code = NULL,
        lease_owner = p_lease_owner,
        lease_acquired_at = v_now,
        lease_expires_at = v_now + make_interval(secs => p_lease_seconds),
        revision = revision + 1,
        updated_at = v_now
    WHERE id = v_step.id RETURNING * INTO v_step;
    UPDATE public.billing_provider_operations
    SET state = 'reconciliation_required',
        provider_request_attempt_count = 1,
        reconciliation_reason_code = 'provider_step_recovery_authorized',
        reconciliation_required_at = COALESCE(reconciliation_required_at, v_now),
        lease_owner = NULL,
        lease_acquired_at = NULL,
        lease_expires_at = NULL,
        revision = revision + 1,
        updated_at = v_now
    WHERE id = p_operation_id
    RETURNING * INTO v_operation;
    RETURN private.billing_provider_operation_step_result_json_v1(
        v_operation, v_step, 'recovery_authorized'
    );
END;
$$;

ALTER FUNCTION public.authorize_billing_provider_operation_step_recovery_v1(
    UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT, INTEGER,
    TEXT, TEXT, TEXT, TEXT, UUID, TEXT, TEXT, UUID, INTEGER, BIGINT
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.authorize_billing_provider_operation_step_recovery_v1(
    UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT, INTEGER,
    TEXT, TEXT, TEXT, TEXT, UUID, TEXT, TEXT, UUID, INTEGER, BIGINT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.authorize_billing_provider_operation_step_recovery_v1(
    UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT, INTEGER,
    TEXT, TEXT, TEXT, TEXT, UUID, TEXT, TEXT, UUID, INTEGER, BIGINT
) TO service_role;

CREATE FUNCTION public.complete_billing_provider_operation_provider_phase_v1(
    p_operation_id UUID, p_studio_id UUID, p_actor_id UUID,
    p_operation_type TEXT, p_caller_request_key TEXT, p_parent_request_sha256 TEXT,
    p_stripe_connected_account_id TEXT, p_connect_account_generation INTEGER,
    p_plan_sha256 TEXT, p_expected_step_count INTEGER,
    p_expected_parent_revision BIGINT
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_operation public.billing_provider_operations%ROWTYPE;
    v_now TIMESTAMPTZ := clock_timestamp();
    v_step_count INTEGER;
    v_succeeded_count INTEGER;
    v_attempted_count INTEGER;
    v_final_provider_evidence TEXT;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM public.staff_roles AS membership
        WHERE membership.studio_id = p_studio_id AND membership.user_id = p_actor_id
          AND membership.archived_at IS NULL AND membership.role IN ('admin', 'front_desk')
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'billing_provider_operation_step_actor_not_active';
    END IF;
    SELECT * INTO v_operation FROM public.billing_provider_operations
    WHERE id = p_operation_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'billing_provider_operation_not_found';
    END IF;
    PERFORM 1 FROM public.billing_provider_operation_steps AS step
    WHERE step.operation_id = p_operation_id ORDER BY step.step_order FOR UPDATE;
    IF v_operation.studio_id IS DISTINCT FROM p_studio_id
       OR v_operation.actor_id IS DISTINCT FROM p_actor_id
       OR v_operation.operation_type IS DISTINCT FROM p_operation_type
       OR v_operation.caller_request_key IS DISTINCT FROM p_caller_request_key
       OR v_operation.request_sha256 IS DISTINCT FROM p_parent_request_sha256
       OR v_operation.stripe_connected_account_id IS DISTINCT FROM p_stripe_connected_account_id
       OR v_operation.connect_account_generation IS DISTINCT FROM p_connect_account_generation
       OR v_operation.provider_step_plan_sha256 IS DISTINCT FROM p_plan_sha256
       OR v_operation.provider_step_expected_count IS DISTINCT FROM p_expected_step_count THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'billing_provider_operation_step_plan_identity_mismatch';
    END IF;
    SELECT count(*),
           count(*) FILTER (WHERE step.state = 'provider_succeeded'),
           count(*) FILTER (WHERE step.provider_request_attempt_count > 0)
      INTO v_step_count, v_succeeded_count, v_attempted_count
      FROM public.billing_provider_operation_steps AS step
     WHERE step.operation_id = p_operation_id;
    SELECT COALESCE(step.provider_object_id, step.provider_request_id)
      INTO v_final_provider_evidence
      FROM public.billing_provider_operation_steps AS step
     WHERE step.operation_id = p_operation_id
     ORDER BY step.step_order DESC LIMIT 1;
    IF v_step_count IS DISTINCT FROM p_expected_step_count THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'billing_provider_operation_step_plan_incomplete';
    END IF;
    IF v_operation.state = 'provider_succeeded' THEN
        IF v_succeeded_count IS DISTINCT FROM p_expected_step_count
           OR v_operation.provider_object_id IS DISTINCT FROM v_final_provider_evidence THEN
            RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'billing_provider_operation_step_phase_incomplete';
        END IF;
        RETURN private.billing_provider_operation_step_plan_json_v1(v_operation, 'replay');
    END IF;
    IF v_operation.revision IS DISTINCT FROM p_expected_parent_revision THEN
        RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'billing_provider_operation_stale_revision';
    END IF;
    IF v_operation.state NOT IN ('started', 'reconciliation_required') THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'billing_provider_operation_step_parent_state_invalid';
    END IF;
    IF v_succeeded_count = p_expected_step_count THEN
        IF v_final_provider_evidence IS NULL THEN
            RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'billing_provider_operation_step_final_evidence_missing';
        END IF;
        UPDATE public.billing_provider_operations
        SET state = 'provider_succeeded',
            provider_request_attempt_count = 1,
            provider_object_id = v_final_provider_evidence,
            result_code = 'provider_step_phase_completed',
            provider_succeeded_at = COALESCE(provider_succeeded_at, v_now),
            reconciliation_reason_code = NULL,
            lease_owner = NULL,
            lease_acquired_at = NULL,
            lease_expires_at = NULL,
            revision = revision + 1,
            updated_at = v_now
        WHERE id = p_operation_id RETURNING * INTO v_operation;
        RETURN private.billing_provider_operation_step_plan_json_v1(
            v_operation, 'provider_succeeded'
        );
    END IF;
    IF v_attempted_count = 0 THEN
        RETURN private.billing_provider_operation_step_plan_json_v1(v_operation, 'incomplete');
    END IF;
    IF v_operation.state = 'reconciliation_required'
       AND v_operation.reconciliation_reason_code = 'provider_step_phase_incomplete' THEN
        RETURN private.billing_provider_operation_step_plan_json_v1(
            v_operation, 'reconciliation_required'
        );
    END IF;
    UPDATE public.billing_provider_operations
    SET state = 'reconciliation_required',
        provider_request_attempt_count = 1,
        reconciliation_reason_code = 'provider_step_phase_incomplete',
        reconciliation_required_at = COALESCE(reconciliation_required_at, v_now),
        lease_owner = NULL,
        lease_acquired_at = NULL,
        lease_expires_at = NULL,
        revision = revision + 1,
        updated_at = v_now
    WHERE id = p_operation_id RETURNING * INTO v_operation;
    RETURN private.billing_provider_operation_step_plan_json_v1(
        v_operation, 'reconciliation_required'
    );
END;
$$;

ALTER FUNCTION public.complete_billing_provider_operation_provider_phase_v1(
    UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT, INTEGER, BIGINT
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.complete_billing_provider_operation_provider_phase_v1(
    UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT, INTEGER, BIGINT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.complete_billing_provider_operation_provider_phase_v1(
    UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT, INTEGER, BIGINT
) TO service_role;

CREATE FUNCTION private.koaryu_release_provider_operation_steps_manifest_v28()
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $manifest$
DECLARE
    v_invalid INTEGER;
    v_serialized TEXT;
BEGIN
    WITH required_functions(signature, security_definer, service_execute) AS (
        VALUES
            ('public.register_billing_provider_operation_step_plan_v1(uuid,uuid,uuid,text,text,text,text,integer,uuid,bigint,text,integer,jsonb)', true, true),
            ('public.read_billing_provider_operation_step_plan_v1(uuid,uuid,uuid,text,text,text,text,integer,text)', true, true),
            ('public.claim_billing_provider_operation_step_v1(uuid,uuid,uuid,text,text,text,text,integer,text,integer,text,text,text,text,uuid,integer)', true, true),
            ('public.transition_billing_provider_operation_step_v1(uuid,uuid,uuid,text,text,text,text,integer,text,integer,text,text,text,text,uuid,bigint,text,text,text,text,text,text,text)', true, true),
            ('public.authorize_billing_provider_operation_step_recovery_v1(uuid,uuid,uuid,text,text,text,text,integer,text,integer,text,text,text,text,uuid,text,text,uuid,integer,bigint)', true, true),
            ('public.complete_billing_provider_operation_provider_phase_v1(uuid,uuid,uuid,text,text,text,text,integer,text,integer,bigint)', true, true),
            ('public.claim_billing_provider_operation_resource_v1(uuid,uuid,text,text,uuid,uuid,text,text,text,integer,uuid,integer)', true, true),
            ('public.finalize_billing_payer_setup_projection_v1(uuid,uuid,uuid,uuid,uuid,text,text,text,integer)', true, true),
            ('private.billing_provider_operation_resource_json_v1(public.billing_provider_operation_resources,public.billing_provider_operations,text,text)', false, false),
            ('private.enforce_billing_payer_connect_identity_v1()', true, false),
            ('private.preserve_billing_provider_operation_resource_v1()', false, false),
            ('private.preserve_billing_provider_operation_resource_alias_v1()', false, false),
            ('private.preserve_billing_provider_operation_step_v1()', false, false),
            ('private.enforce_billing_provider_step_parent_v1()', false, false)
    ),
    function_state AS (
        SELECT required.signature,
               required.security_definer,
               required.service_execute AS expected_service_execute,
               procedure.oid,
               owner.rolname AS owner_name,
               procedure.prosecdef,
               COALESCE(array_to_string(procedure.proconfig, ','), '') AS configuration,
               has_function_privilege('service_role', procedure.oid, 'EXECUTE') AS service_execute,
               has_function_privilege('anon', procedure.oid, 'EXECUTE') AS anon_execute,
               has_function_privilege('authenticated', procedure.oid, 'EXECUTE') AS authenticated_execute,
               EXISTS (
                    SELECT 1
                    FROM aclexplode(COALESCE(
                        procedure.proacl,
                        acldefault('f', procedure.proowner)
                    )) AS privilege
                    WHERE privilege.grantee = 0
                      AND privilege.privilege_type = 'EXECUTE'
               ) AS public_execute,
               COALESCE(pg_get_functiondef(procedure.oid), '') AS definition
        FROM required_functions AS required
        LEFT JOIN pg_proc AS procedure
          ON procedure.oid = to_regprocedure(required.signature)
        LEFT JOIN pg_roles AS owner ON owner.oid = procedure.proowner
    ),
    object_state AS (
        SELECT 'columns' AS category,
               string_agg(
                    attribute.attname || ':' ||
                    format_type(attribute.atttypid, attribute.atttypmod) || ':' ||
                    attribute.attnotnull::TEXT || ':' ||
                    COALESCE(pg_get_expr(default_value.adbin, default_value.adrelid), ''),
                    '|' ORDER BY attribute.attnum
               ) AS value
        FROM pg_attribute AS attribute
        LEFT JOIN pg_attrdef AS default_value
          ON default_value.adrelid = attribute.attrelid
         AND default_value.adnum = attribute.attnum
        WHERE attribute.attrelid = 'public.billing_provider_operation_steps'::REGCLASS
          AND attribute.attnum > 0 AND NOT attribute.attisdropped
        UNION ALL
        SELECT 'resource_columns', string_agg(
            relation.relname || '.' || attribute.attname || ':' ||
            format_type(attribute.atttypid, attribute.atttypmod) || ':' ||
            attribute.attnotnull::TEXT || ':' ||
            COALESCE(pg_get_expr(default_value.adbin, default_value.adrelid), ''),
            '|' ORDER BY relation.relname COLLATE "C", attribute.attnum
        )
        FROM pg_attribute AS attribute
        JOIN pg_class AS relation ON relation.oid = attribute.attrelid
        LEFT JOIN pg_attrdef AS default_value
          ON default_value.adrelid = attribute.attrelid
         AND default_value.adnum = attribute.attnum
        WHERE attribute.attrelid IN (
            'public.billing_provider_operation_resources'::REGCLASS,
            'public.billing_provider_operation_resource_aliases'::REGCLASS
        ) AND attribute.attnum > 0 AND NOT attribute.attisdropped
        UNION ALL
        SELECT 'constraints', string_agg(
            constraint_state.conname || ':' || constraint_state.contype::TEXT || ':' ||
            constraint_state.convalidated::TEXT || ':' || pg_get_constraintdef(constraint_state.oid),
            '|' ORDER BY constraint_state.conname COLLATE "C"
        )
        FROM pg_constraint AS constraint_state
        WHERE constraint_state.conrelid = 'public.billing_provider_operation_steps'::REGCLASS
        UNION ALL
        SELECT 'resource_constraints', string_agg(
            relation.relname || '.' || constraint_state.conname || ':' ||
            constraint_state.contype::TEXT || ':' ||
            constraint_state.convalidated::TEXT || ':' ||
            pg_get_constraintdef(constraint_state.oid),
            '|' ORDER BY relation.relname COLLATE "C", constraint_state.conname COLLATE "C"
        )
        FROM pg_constraint AS constraint_state
        JOIN pg_class AS relation ON relation.oid = constraint_state.conrelid
        WHERE constraint_state.conrelid IN (
            'public.billing_provider_operation_resources'::REGCLASS,
            'public.billing_provider_operation_resource_aliases'::REGCLASS
        )
        UNION ALL
        SELECT 'functions', string_agg(
            signature || ':' || COALESCE(owner_name, '') || ':' ||
            COALESCE(prosecdef::TEXT, '') || ':' || configuration || ':' ||
            COALESCE(service_execute::TEXT, '') || ':' ||
            encode(extensions.digest(convert_to(definition, 'UTF8'), 'sha256'), 'hex'),
            '|' ORDER BY signature COLLATE "C"
        ) FROM function_state
        UNION ALL
        SELECT 'indexes', string_agg(
            index_relation.relname || ':' || pg_get_indexdef(index_state.indexrelid),
            '|' ORDER BY index_relation.relname COLLATE "C"
        )
        FROM pg_index AS index_state
        JOIN pg_class AS index_relation ON index_relation.oid = index_state.indexrelid
        WHERE index_state.indrelid = 'public.billing_provider_operation_steps'::REGCLASS
        UNION ALL
        SELECT 'resource_indexes', string_agg(
            relation.relname || '.' || index_relation.relname || ':' ||
            pg_get_indexdef(index_state.indexrelid),
            '|' ORDER BY relation.relname COLLATE "C", index_relation.relname COLLATE "C"
        )
        FROM pg_index AS index_state
        JOIN pg_class AS index_relation ON index_relation.oid = index_state.indexrelid
        JOIN pg_class AS relation ON relation.oid = index_state.indrelid
        WHERE index_state.indrelid IN (
            'public.billing_provider_operation_resources'::REGCLASS,
            'public.billing_provider_operation_resource_aliases'::REGCLASS
        )
        UNION ALL
        SELECT 'parent_columns', string_agg(
            attribute.attname || ':' || format_type(attribute.atttypid, attribute.atttypmod),
            '|' ORDER BY attribute.attname COLLATE "C"
        )
        FROM pg_attribute AS attribute
        WHERE attribute.attrelid = 'public.billing_provider_operations'::REGCLASS
          AND attribute.attname IN (
            'provider_step_plan_sha256',
            'provider_step_expected_count',
            'provider_step_plan_registered_at'
          )
          AND NOT attribute.attisdropped
        UNION ALL
        SELECT 'parent_resource_constraint', string_agg(
            constraint_state.conname || ':' || constraint_state.convalidated::TEXT || ':' ||
            pg_get_constraintdef(constraint_state.oid),
            '|' ORDER BY constraint_state.conname COLLATE "C"
        )
        FROM pg_constraint AS constraint_state
        WHERE constraint_state.conrelid = 'public.billing_provider_operations'::REGCLASS
          AND constraint_state.conname =
              'billing_provider_operations_resource_identity_unique'
        UNION ALL
        SELECT 'payer_generation',
               string_agg(
                    attribute.attname || ':' ||
                    format_type(attribute.atttypid, attribute.atttypmod) || ':' ||
                    attribute.attnotnull::TEXT || ':' ||
                    COALESCE(pg_get_expr(default_value.adbin, default_value.adrelid), ''),
                    '|' ORDER BY attribute.attname COLLATE "C"
               ) || '|' || COALESCE((
                    SELECT string_agg(
                        constraint_state.conname || ':' ||
                        constraint_state.convalidated::TEXT || ':' ||
                        pg_get_constraintdef(constraint_state.oid),
                        '|' ORDER BY constraint_state.conname COLLATE "C"
                    )
                    FROM pg_constraint AS constraint_state
                    WHERE constraint_state.conrelid = 'public.billing_payers'::REGCLASS
                      AND constraint_state.conname =
                          'billing_payers_connect_account_generation_positive'
               ), '')
        FROM pg_attribute AS attribute
        LEFT JOIN pg_attrdef AS default_value
          ON default_value.adrelid = attribute.attrelid
         AND default_value.adnum = attribute.attnum
        WHERE attribute.attrelid = 'public.billing_payers'::REGCLASS
          AND attribute.attname = 'connect_account_generation'
          AND NOT attribute.attisdropped
        UNION ALL
        SELECT 'policies', string_agg(
            policy.polname || ':' || policy.polpermissive::TEXT || ':' ||
            policy.polcmd::TEXT || ':' || COALESCE(pg_get_expr(policy.polqual, policy.polrelid), '') || ':' ||
            COALESCE(pg_get_expr(policy.polwithcheck, policy.polrelid), ''),
            '|' ORDER BY policy.polname COLLATE "C"
        )
        FROM pg_policy AS policy
        WHERE policy.polrelid = 'public.billing_provider_operation_steps'::REGCLASS
        UNION ALL
        SELECT 'resource_policies', string_agg(
            relation.relname || '.' || policy.polname || ':' ||
            policy.polpermissive::TEXT || ':' || policy.polcmd::TEXT || ':' ||
            COALESCE(pg_get_expr(policy.polqual, policy.polrelid), '') || ':' ||
            COALESCE(pg_get_expr(policy.polwithcheck, policy.polrelid), ''),
            '|' ORDER BY relation.relname COLLATE "C", policy.polname COLLATE "C"
        )
        FROM pg_policy AS policy
        JOIN pg_class AS relation ON relation.oid = policy.polrelid
        WHERE policy.polrelid IN (
            'public.billing_provider_operation_resources'::REGCLASS,
            'public.billing_provider_operation_resource_aliases'::REGCLASS
        )
        UNION ALL
        SELECT 'triggers', string_agg(
            relation.relname || '.' || trigger.tgname || ':' || pg_get_triggerdef(trigger.oid),
            '|' ORDER BY relation.relname COLLATE "C", trigger.tgname COLLATE "C"
        )
        FROM pg_trigger AS trigger
        JOIN pg_class AS relation ON relation.oid = trigger.tgrelid
        WHERE trigger.tgrelid IN (
            'public.billing_provider_operation_steps'::REGCLASS,
            'public.billing_provider_operations'::REGCLASS,
            'public.billing_payers'::REGCLASS,
            'public.billing_provider_operation_resources'::REGCLASS,
            'public.billing_provider_operation_resource_aliases'::REGCLASS
        ) AND NOT trigger.tgisinternal
    )
    SELECT
        (SELECT count(*) FILTER (
            WHERE oid IS NULL OR owner_name <> 'postgres'
               OR prosecdef IS DISTINCT FROM security_definer
               OR configuration <> 'search_path=""'
               OR service_execute IS DISTINCT FROM expected_service_execute
               OR anon_execute IS DISTINCT FROM false
               OR authenticated_execute IS DISTINCT FROM false
               OR public_execute IS DISTINCT FROM false
        ) FROM function_state)
        + (
            SELECT count(*)
            FROM (VALUES
                ('public.billing_provider_operation_steps'::REGCLASS),
                ('public.billing_provider_operation_resources'::REGCLASS),
                ('public.billing_provider_operation_resource_aliases'::REGCLASS)
            ) AS required_table(relation_id)
            WHERE NOT EXISTS (
                SELECT 1 FROM pg_class AS relation
                JOIN pg_roles AS owner ON owner.oid = relation.relowner
                WHERE relation.oid = required_table.relation_id
                  AND owner.rolname = 'postgres' AND relation.relrowsecurity
                  AND NOT has_table_privilege(
                      'service_role', relation.oid, 'SELECT,INSERT,UPDATE,DELETE'
                  )
                  AND NOT has_table_privilege(
                      'anon', relation.oid, 'SELECT,INSERT,UPDATE,DELETE'
                  )
                  AND NOT has_table_privilege(
                      'authenticated', relation.oid, 'SELECT,INSERT,UPDATE,DELETE'
                  )
            )
        ),
        string_agg(category || '=' || COALESCE(value, ''), E'\n' ORDER BY category COLLATE "C")
      INTO v_invalid, v_serialized
      FROM object_state;
    RETURN v_invalid::TEXT || ':' || encode(
        extensions.digest(convert_to(COALESCE(v_serialized, ''), 'UTF8'), 'sha256'),
        'hex'
    );
END;
$manifest$;

ALTER FUNCTION private.koaryu_release_provider_operation_steps_manifest_v28() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.koaryu_release_provider_operation_steps_manifest_v28()
    FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION private.koaryu_release_operational_contract_v28()
RETURNS TEXT LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = pg_catalog SET "TimeZone" = 'UTC' AS $$
    SELECT '0:' || encode(
        extensions.digest(
            convert_to(
                private.koaryu_release_operational_contract_v27() || '|' ||
                private.koaryu_release_provider_operation_steps_manifest_v28(),
                'UTF8'
            ),
            'sha256'
        ),
        'hex'
    );
$$;
ALTER FUNCTION private.koaryu_release_operational_contract_v28() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.koaryu_release_operational_contract_v28()
    FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE private.koaryu_release_v28_expectations (
    expectation_key TEXT PRIMARY KEY,
    expected_sha256 TEXT NOT NULL,
    CONSTRAINT koaryu_release_v28_expectation_key_exact
        CHECK (expectation_key = 'operational_contract_v28'),
    CONSTRAINT koaryu_release_v28_expectation_digest_shape
        CHECK (expected_sha256 ~ '^[0-9a-f]{64}$')
);
ALTER TABLE private.koaryu_release_v28_expectations OWNER TO postgres;
ALTER TABLE private.koaryu_release_v28_expectations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE private.koaryu_release_v28_expectations
    FROM PUBLIC, anon, authenticated, service_role;
INSERT INTO private.koaryu_release_v28_expectations(expectation_key, expected_sha256)
VALUES (
    'operational_contract_v28',
    'd3d60ab2e0e41154fa4236e7300a755f3a25caa0edf75c93f2697551e29bbbfa'
);

UPDATE private.koaryu_release_v27_expectations
SET expected_sha256 = '80984ee6df7f59b91cf1d60f2ea1330e25d3a47d77a9f112663046f89ea86280'
WHERE expectation_key = 'operational_contract_v27';

CREATE FUNCTION private.koaryu_release_operational_manifest_v9()
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
SET "TimeZone" = 'UTC'
AS $$
    SELECT encode(
        extensions.digest(
            convert_to(
                private.koaryu_release_live_billing_v3_manifest_v25() || '|' ||
                private.koaryu_release_payment_adjustment_manifest_v26() || '|' ||
                private.koaryu_release_operational_contract_v26() || '|' ||
                private.koaryu_release_operational_contract_v27() || '|' ||
                private.koaryu_release_provider_operation_steps_manifest_v28() || '|' ||
                private.koaryu_release_operational_contract_v28() || '|' ||
                private.koaryu_release_critical_surface_manifest_v18() || '|' ||
                (
                    SELECT COALESCE(
                        string_agg(
                            expectation_key || ':' || expected_sha256,
                            '|' ORDER BY expectation_key COLLATE "C"
                        ),
                        ''
                    )
                    FROM private.koaryu_release_v26_expectations
                ) || '|' ||
                (
                    SELECT COALESCE(
                        string_agg(
                            expectation_key || ':' || expected_sha256,
                            '|' ORDER BY expectation_key COLLATE "C"
                        ),
                        ''
                    )
                    FROM private.koaryu_release_v27_expectations
                ) || '|' ||
                (
                    SELECT COALESCE(
                        string_agg(
                            expectation_key || ':' || expected_sha256,
                            '|' ORDER BY expectation_key COLLATE "C"
                        ),
                        ''
                    )
                    FROM private.koaryu_release_v28_expectations
                ),
                'UTF8'
            ),
            'sha256'
        ),
        'hex'
    );
$$;

ALTER FUNCTION private.koaryu_release_operational_manifest_v9() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.koaryu_release_operational_manifest_v9()
    FROM PUBLIC, anon, authenticated, service_role;

DO $v28_observation$
BEGIN
    RAISE NOTICE 'KOARYU_V28_COMPAT_V27_PROVIDER_MANIFEST=%',
        private.koaryu_release_provider_operations_manifest_v27();
    RAISE NOTICE 'KOARYU_V28_COMPAT_V27_OPERATIONAL_CONTRACT=%',
        private.koaryu_release_operational_contract_v27();
    RAISE NOTICE 'KOARYU_V28_STEPS_MANIFEST=%',
        private.koaryu_release_provider_operation_steps_manifest_v28();
    RAISE NOTICE 'KOARYU_V28_OPERATIONAL_CONTRACT=%',
        private.koaryu_release_operational_contract_v28();
    RAISE NOTICE 'KOARYU_V28_OPERATIONAL_MANIFEST=%',
        private.koaryu_release_operational_manifest_v8();
    RAISE NOTICE 'KOARYU_V28_CANONICAL_MANIFEST=%',
        private.koaryu_release_operational_manifest_v9();
    RAISE NOTICE 'KOARYU_V28_V9_FUNCTION_SHA256=%', encode(
        extensions.digest(
            convert_to(
                pg_get_functiondef(
                    'private.koaryu_release_operational_manifest_v9()'::REGPROCEDURE
                ),
                'UTF8'
            ),
            'sha256'
        ),
        'hex'
    );
END;
$v28_observation$;

CREATE FUNCTION public.koaryu_release_schema_preflight_v9()
RETURNS TABLE (
    ready BOOLEAN,
    migration_count INTEGER,
    migration_head TEXT,
    pending_versions TEXT[],
    security_failures TEXT[],
    manifest_version TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog
AS $preflight$
DECLARE
    v_count INTEGER;
    v_head TEXT;
    v_pending TEXT[];
    v_failures TEXT[] := ARRAY[]::TEXT[];
    v_expected_v26 TEXT;
    v_expected_v27 TEXT;
    v_expected_v28 TEXT;
BEGIN
    SELECT
        count(*)::INTEGER,
        max(version),
        array_agg(version ORDER BY version COLLATE "C")
            FILTER (WHERE version >= '20260727100000')
    INTO v_count, v_head, v_pending
    FROM supabase_migrations.schema_migrations;

    IF v_count <> 123 OR v_head <> '20260826073728' THEN
        v_failures := array_append(v_failures, 'migration_history_v28');
    END IF;

    IF COALESCE(v_pending, ARRAY[]::TEXT[]) IS DISTINCT FROM ARRAY[
        '20260727100000','20260727110000','20260801050957','20260801060000',
        '20260801070000','20260801080000','20260801090000','20260801091000',
        '20260801092000','20260801093000','20260801094000','20260801105313',
        '20260801112153','20260801115044','20260801123112','20260801131844',
        '20260814043325','20260814103046','20260814105424','20260814114500',
        '20260814152000','20260814170000','20260814183000','20260814200000',
        '20260814213000','20260815220402','20260816012723','20260820012533',
        '20260820025759','20260820060216','20260822193000','20260823193155',
        '20260824190500','20260825042838','20260825043911','20260826030234',
        '20260826030249','20260826051527',
        '20260826073728'
    ]::TEXT[] THEN
        v_failures := array_append(v_failures, 'migration_history_sequence_v28');
    END IF;

    IF private.koaryu_release_provider_operation_steps_manifest_v28()
       <> '0:1de704b805b929154bf88e1727838d0d95c1c3da16246c3d48c3bdafafcb5931' THEN
        v_failures := array_append(v_failures, 'provider_operation_steps_manifest_v28');
    END IF;

    IF private.koaryu_release_operational_manifest_v9()
       <> 'bc0e88150f543978befadfa4711b4c7f1f376c386b75df1e1f5c741c295dba6a' THEN
        v_failures := array_append(v_failures, 'operational_manifest_v9');
    END IF;

    IF encode(
        extensions.digest(
            convert_to(
                pg_get_functiondef(
                    'private.koaryu_release_operational_manifest_v9()'::REGPROCEDURE
                ),
                'UTF8'
            ),
            'sha256'
        ),
        'hex'
    ) <> '911922f5e0400bc1dff67f219f0c59f256b64dc5593aaf57f01ae0ec8b831b6e' THEN
        v_failures := array_append(v_failures, 'operational_manifest_v9_function');
    END IF;

    IF private.koaryu_release_starting_belt_manifest_v9()
       <> '0:9c1c8ea5e7ab6ce0d34d5654d17b056faba89234f0f2b945ff147c0462711be9' THEN
        v_failures := array_append(v_failures, 'starting_belt_invariant_manifest_v9');
    END IF;

    IF private.koaryu_release_student_rank_writer_manifest_v13()
       <> '0:27cdc692d92fb49f696521e7ab6f3d0b7717c30a232ba6ce4ba057df9e5b30f7' THEN
        v_failures := array_append(v_failures, 'student_rank_writer_manifest_v13');
    END IF;

    IF private.koaryu_release_critical_surface_manifest_v18()
       <> '0:d203dd740f8311c4e1fa46c976a4fcb92998a0e11bf8794b4cac1768236b62a7' THEN
        v_failures := array_append(v_failures, 'critical_surface_manifest_v18');
    END IF;

    IF private.koaryu_release_live_billing_v3_manifest_v25()
       <> '0:f810f40507fd5be476a90be7915be9f926ea15aafca7588cbca76233cda8adfb' THEN
        v_failures := array_append(v_failures, 'live_billing_v3_manifest_v25');
    END IF;

    IF private.koaryu_release_payment_adjustment_manifest_v26()
       <> '0:b63f010f0b0111f38b72fc43009f77722d824d96c3775a9dc3d34e6c58a63657' THEN
        v_failures := array_append(v_failures, 'payment_adjustment_manifest_v26');
    END IF;

    IF private.koaryu_release_schedule_window_manifest_v1()
       <> '0:f4c66d3098dcb3210ac6cc92e1831eebaf9f2ed74b210e84ec773cb1d8e854a7' THEN
        v_failures := array_append(v_failures, 'schedule_window_manifest_v1');
    END IF;

    SELECT expected_sha256
    INTO v_expected_v26
    FROM private.koaryu_release_v26_expectations
    WHERE expectation_key = 'operational_contract_v26';
    IF NOT FOUND
       OR (SELECT count(*) FROM private.koaryu_release_v26_expectations) <> 1
       OR private.koaryu_release_operational_contract_v26()
          IS DISTINCT FROM '0:' || v_expected_v26 THEN
        v_failures := array_append(v_failures, 'operational_contract_v26');
    END IF;

    SELECT expected_sha256
    INTO v_expected_v27
    FROM private.koaryu_release_v27_expectations
    WHERE expectation_key = 'operational_contract_v27';
    IF NOT FOUND
       OR (SELECT count(*) FROM private.koaryu_release_v27_expectations) <> 1
       OR private.koaryu_release_operational_contract_v27()
          IS DISTINCT FROM '0:' || v_expected_v27 THEN
        v_failures := array_append(v_failures, 'operational_contract_v27');
    END IF;

    SELECT expected_sha256
    INTO v_expected_v28
    FROM private.koaryu_release_v28_expectations
    WHERE expectation_key = 'operational_contract_v28';
    IF NOT FOUND
       OR (SELECT count(*) FROM private.koaryu_release_v28_expectations) <> 1
       OR private.koaryu_release_operational_contract_v28()
          IS DISTINCT FROM '0:' || v_expected_v28 THEN
        v_failures := array_append(v_failures, 'operational_contract_v28');
    END IF;

    RETURN QUERY SELECT
        cardinality(v_failures) = 0,
        v_count,
        v_head,
        COALESCE(v_pending, ARRAY[]::TEXT[]),
        v_failures,
        'release-db-attestation-v28'::TEXT;
END;
$preflight$;

ALTER FUNCTION public.koaryu_release_schema_preflight_v9() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.koaryu_release_schema_preflight_v9()
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.koaryu_release_schema_preflight_v9()
    TO service_role;

CREATE OR REPLACE FUNCTION public.koaryu_release_schema_preflight_v8()
RETURNS TABLE (
    ready BOOLEAN,
    migration_count INTEGER,
    migration_head TEXT,
    pending_versions TEXT[],
    security_failures TEXT[],
    manifest_version TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog
AS $compatibility$
DECLARE
    v_current RECORD;
BEGIN
    SELECT * INTO v_current
    FROM public.koaryu_release_schema_preflight_v9();

    IF v_current.ready IS TRUE
       AND v_current.migration_count = 123
       AND v_current.migration_head = '20260826073728'
       AND v_current.manifest_version = 'release-db-attestation-v28'
       AND cardinality(v_current.security_failures) = 0 THEN
        RETURN QUERY SELECT
            true,
            122,
            '20260826051527'::TEXT,
            ARRAY[
                '20260727100000','20260727110000','20260801050957','20260801060000',
                '20260801070000','20260801080000','20260801090000','20260801091000',
                '20260801092000','20260801093000','20260801094000','20260801105313',
                '20260801112153','20260801115044','20260801123112','20260801131844',
                '20260814043325','20260814103046','20260814105424','20260814114500',
                '20260814152000','20260814170000','20260814183000','20260814200000',
                '20260814213000','20260815220402','20260816012723','20260820012533',
                '20260820025759','20260820060216','20260822193000','20260823193155',
                '20260824190500','20260825042838','20260825043911',
                '20260826030234','20260826030249','20260826051527'
            ]::TEXT[],
            ARRAY[]::TEXT[],
            'release-db-attestation-v27'::TEXT;
        RETURN;
    END IF;

    RETURN QUERY SELECT
        false,
        v_current.migration_count,
        v_current.migration_head,
        v_current.pending_versions,
        COALESCE(
            v_current.security_failures,
            ARRAY['v28_compatibility_preflight']::TEXT[]
        ),
        'release-db-attestation-v27'::TEXT;
END;
$compatibility$;

ALTER FUNCTION public.koaryu_release_schema_preflight_v8() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.koaryu_release_schema_preflight_v8()
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.koaryu_release_schema_preflight_v8()
    TO service_role;
