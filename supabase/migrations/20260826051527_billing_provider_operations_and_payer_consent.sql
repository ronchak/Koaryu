-- Durable replay ownership for connected-provider mutations and payer-owned
-- recurring-payment consent. This migration creates no live grant and performs
-- no provider mutation.

DO $v26_preflight_guard$
DECLARE
    v_preflight RECORD;
BEGIN
    SELECT * INTO v_preflight
    FROM public.koaryu_release_schema_preflight_v7();

    IF v_preflight.ready IS DISTINCT FROM true
       OR v_preflight.migration_count IS DISTINCT FROM 121
       OR v_preflight.migration_head IS DISTINCT FROM '20260826030249'
       OR v_preflight.manifest_version IS DISTINCT FROM 'release-db-attestation-v26'
       OR private.koaryu_release_schedule_window_manifest_v1()
          IS DISTINCT FROM '0:f4c66d3098dcb3210ac6cc92e1831eebaf9f2ed74b210e84ec773cb1d8e854a7'
       OR COALESCE(v_preflight.security_failures, ARRAY[]::TEXT[]) <> ARRAY[]::TEXT[] THEN
        RAISE EXCEPTION 'Billing provider operations require the exact ready 121/V26 predecessor.';
    END IF;
END;
$v26_preflight_guard$;

CREATE TABLE public.billing_provider_operations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    studio_id UUID NOT NULL REFERENCES public.studios(id) ON DELETE CASCADE,
    actor_id UUID NOT NULL,
    operation_type TEXT NOT NULL,
    caller_request_key TEXT NOT NULL,
    request_sha256 TEXT NOT NULL,
    stripe_connected_account_id TEXT NOT NULL,
    connect_account_generation INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'started',
    provider_request_attempt_count INTEGER NOT NULL DEFAULT 0,
    lease_owner UUID,
    lease_acquired_at TIMESTAMPTZ,
    lease_expires_at TIMESTAMPTZ,
    provider_object_id TEXT,
    provider_secondary_object_id TEXT,
    provider_request_id TEXT,
    result_code TEXT,
    result_summary TEXT,
    error_code TEXT,
    error_summary TEXT,
    reconciliation_reason_code TEXT,
    recovery_proof_sha256 TEXT,
    recovery_outcome TEXT,
    recovery_actor_id UUID,
    recovery_authorized_at TIMESTAMPTZ,
    revision BIGINT NOT NULL DEFAULT 1,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    provider_request_in_flight_at TIMESTAMPTZ,
    provider_succeeded_at TIMESTAMPTZ,
    projected_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    reconciliation_required_at TIMESTAMPTZ,
    definitive_failed_at TIMESTAMPTZ,
    definitive_rejected_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT billing_provider_operations_studio_key_unique
        UNIQUE (studio_id, operation_type, caller_request_key),
    CONSTRAINT billing_provider_operations_id_studio_unique
        UNIQUE (id, studio_id),
    CONSTRAINT billing_provider_operations_type_exact CHECK (operation_type IN (
        'payer.sync',
        'payer.setup',
        'plan.sync',
        'plan.archive',
        'enrollment.activate.autopay',
        'enrollment.activate.invoice',
        'invoice.create',
        'invoice.retry',
        'invoice.void',
        'payment.refund',
        'payer.reconcile',
        'enrollment.cancel.period_end.schedule',
        'enrollment.cancel.period_end.execute',
        'enrollment.cancel.period_end.revoke',
        'enrollment.cancel.immediate'
    )),
    CONSTRAINT billing_provider_operations_request_key_bytes
        CHECK (octet_length(caller_request_key) BETWEEN 1 AND 255),
    CONSTRAINT billing_provider_operations_request_hash_shape
        CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT billing_provider_operations_account_bytes
        CHECK (octet_length(stripe_connected_account_id) BETWEEN 1 AND 255),
    CONSTRAINT billing_provider_operations_generation_positive
        CHECK (connect_account_generation > 0),
    CONSTRAINT billing_provider_operations_state_exact CHECK (state IN (
        'started', 'provider_request_in_flight', 'provider_succeeded',
        'recovery_authorized', 'projected', 'completed', 'reconciliation_required',
        'definitive_failed', 'definitive_rejected'
    )),
    CONSTRAINT billing_provider_operations_attempt_bounded
        CHECK (provider_request_attempt_count BETWEEN 0 AND 2),
    CONSTRAINT billing_provider_operations_recovery_outcome_exact CHECK (
        recovery_outcome IS NULL OR recovery_outcome IN (
            'provider_no_object_safe_to_retry',
            'provider_succeeded_reconcile_only'
        )
    ),
    CONSTRAINT billing_provider_operations_revision_positive CHECK (revision > 0),
    CONSTRAINT billing_provider_operations_lease_complete CHECK (
        (lease_owner IS NULL AND lease_acquired_at IS NULL AND lease_expires_at IS NULL)
        OR (
            lease_owner IS NOT NULL
            AND lease_acquired_at IS NOT NULL
            AND lease_expires_at IS NOT NULL
            AND lease_expires_at > lease_acquired_at
        )
    ),
    CONSTRAINT billing_provider_operations_provider_id_bytes CHECK (
        (provider_object_id IS NULL OR octet_length(provider_object_id) BETWEEN 1 AND 255)
        AND (
            provider_secondary_object_id IS NULL
            OR octet_length(provider_secondary_object_id) BETWEEN 1 AND 255
        )
        AND (provider_request_id IS NULL OR octet_length(provider_request_id) BETWEEN 1 AND 255)
    ),
    CONSTRAINT billing_provider_operations_result_error_bytes CHECK (
        (result_code IS NULL OR result_code ~ '^[a-z0-9][a-z0-9_.:-]{0,127}$')
        AND (result_summary IS NULL OR result_summary ~ '^[a-z0-9][a-z0-9_.:-]{0,127}$')
        AND (error_code IS NULL OR error_code ~ '^[a-z0-9][a-z0-9_.:-]{0,127}$')
        AND (error_summary IS NULL OR error_summary ~ '^[a-z0-9][a-z0-9_.:-]{0,127}$')
        AND (
            reconciliation_reason_code IS NULL
            OR octet_length(reconciliation_reason_code) BETWEEN 1 AND 128
        )
        AND (recovery_proof_sha256 IS NULL OR recovery_proof_sha256 ~ '^[0-9a-f]{64}$')
    ),
    CONSTRAINT billing_provider_operations_no_url_or_secret_summary CHECK (
        COALESCE(result_summary, '') !~* '(https?://|sk_(live|test)_|rk_(live|test)_|pk_(live|test)_|whsec_)'
        AND COALESCE(error_summary, '') !~* '(https?://|sk_(live|test)_|rk_(live|test)_|pk_(live|test)_|whsec_)'
        AND COALESCE(result_summary, '') !~* '(bearer|client_secret|_secret_|[0-9]{13,}|@)'
        AND COALESCE(error_summary, '') !~* '(bearer|client_secret|_secret_|[0-9]{13,}|@)'
    ),
    CONSTRAINT billing_provider_operations_state_evidence CHECK (
        (state = 'started' AND provider_request_attempt_count = 0)
        OR (state = 'provider_request_in_flight' AND provider_request_attempt_count BETWEEN 1 AND 2
            AND provider_request_in_flight_at IS NOT NULL)
        OR (state IN ('provider_succeeded', 'projected', 'completed')
            AND provider_request_attempt_count BETWEEN 1 AND 2
            AND provider_object_id IS NOT NULL
            AND provider_succeeded_at IS NOT NULL)
        OR (state = 'reconciliation_required'
            AND provider_request_attempt_count BETWEEN 1 AND 2
            AND reconciliation_reason_code IS NOT NULL
            AND reconciliation_required_at IS NOT NULL)
        OR (state = 'recovery_authorized'
            AND provider_request_attempt_count BETWEEN 1 AND 2
            AND recovery_proof_sha256 IS NOT NULL
            AND recovery_outcome IS NOT NULL
            AND recovery_actor_id IS NOT NULL
            AND recovery_authorized_at IS NOT NULL)
        OR (state = 'definitive_failed'
            AND error_code IS NOT NULL AND definitive_failed_at IS NOT NULL)
        OR (state = 'definitive_rejected'
            AND error_code IS NOT NULL AND definitive_rejected_at IS NOT NULL)
    ),
    CONSTRAINT billing_provider_operations_state_timestamp CHECK (
        (projected_at IS NULL OR provider_succeeded_at IS NOT NULL)
        AND (completed_at IS NULL OR projected_at IS NOT NULL)
    )
);

CREATE INDEX billing_provider_operations_studio_created_idx
    ON public.billing_provider_operations (studio_id, created_at DESC);
CREATE INDEX billing_provider_operations_account_generation_idx
    ON public.billing_provider_operations (
        stripe_connected_account_id,
        connect_account_generation,
        created_at DESC
    );
CREATE INDEX billing_provider_operations_resumable_idx
    ON public.billing_provider_operations (state, lease_expires_at, created_at)
    WHERE state IN ('started', 'recovery_authorized', 'provider_succeeded', 'projected');
CREATE INDEX billing_provider_operations_reconciliation_idx
    ON public.billing_provider_operations (studio_id, reconciliation_required_at)
    WHERE state = 'reconciliation_required';

CREATE TABLE public.billing_payer_setup_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    operation_id UUID NOT NULL,
    studio_id UUID NOT NULL REFERENCES public.studios(id) ON DELETE CASCADE,
    payer_id UUID NOT NULL REFERENCES public.billing_payers(id) ON DELETE RESTRICT,
    initiated_by UUID NOT NULL,
    terms_version TEXT NOT NULL,
    stripe_checkout_session_id TEXT,
    stripe_setup_intent_id TEXT,
    stripe_connected_account_id TEXT NOT NULL,
    connect_account_generation INTEGER NOT NULL,
    setup_request_expires_at TIMESTAMPTZ NOT NULL,
    accepted_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    superseded_at TIMESTAMPTZ,
    closed_at TIMESTAMPTZ,
    close_reason_code TEXT,
    provider_read_proof_sha256 TEXT,
    revision BIGINT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT billing_payer_setup_requests_operation_unique UNIQUE (operation_id),
    CONSTRAINT billing_payer_setup_requests_operation_identity_fkey
        FOREIGN KEY (operation_id, studio_id)
        REFERENCES public.billing_provider_operations(id, studio_id) ON DELETE RESTRICT,
    CONSTRAINT billing_payer_setup_requests_terms_bytes
        CHECK (octet_length(terms_version) BETWEEN 1 AND 128),
    CONSTRAINT billing_payer_setup_requests_provider_id_bytes CHECK (
        (stripe_checkout_session_id IS NULL OR octet_length(stripe_checkout_session_id) BETWEEN 1 AND 255)
        AND (stripe_setup_intent_id IS NULL OR octet_length(stripe_setup_intent_id) BETWEEN 1 AND 255)
        AND octet_length(stripe_connected_account_id) BETWEEN 1 AND 255
    ),
    CONSTRAINT billing_payer_setup_requests_generation_positive
        CHECK (connect_account_generation > 0),
    CONSTRAINT billing_payer_setup_requests_revision_positive CHECK (revision > 0),
    CONSTRAINT billing_payer_setup_requests_close_evidence CHECK (
        (
            closed_at IS NULL
            AND close_reason_code IS NULL
            AND provider_read_proof_sha256 IS NULL
        )
        OR (
            closed_at IS NOT NULL
            AND closed_at = superseded_at
            AND close_reason_code IN (
                'checkout_session_expired',
                'checkout_session_terminal_unusable'
            )
            AND provider_read_proof_sha256 ~ '^[0-9a-f]{64}$'
        )
    ),
    CONSTRAINT billing_payer_setup_requests_expiry_order CHECK (setup_request_expires_at > created_at),
    CONSTRAINT billing_payer_setup_requests_lifecycle_order CHECK (
        (accepted_at IS NULL OR accepted_at <= setup_request_expires_at)
        AND (completed_at IS NULL OR (accepted_at IS NOT NULL AND completed_at >= accepted_at))
        AND (revoked_at IS NULL OR revoked_at >= created_at)
        AND (superseded_at IS NULL OR superseded_at >= created_at)
        AND NOT (revoked_at IS NOT NULL AND superseded_at IS NOT NULL)
    )
);

CREATE UNIQUE INDEX billing_payer_setup_requests_checkout_unique
    ON public.billing_payer_setup_requests (
        stripe_connected_account_id,
        connect_account_generation,
        stripe_checkout_session_id
    ) WHERE stripe_checkout_session_id IS NOT NULL;
CREATE UNIQUE INDEX billing_payer_setup_requests_setup_intent_unique
    ON public.billing_payer_setup_requests (
        stripe_connected_account_id,
        connect_account_generation,
        stripe_setup_intent_id
    ) WHERE stripe_setup_intent_id IS NOT NULL;
CREATE INDEX billing_payer_setup_requests_payer_created_idx
    ON public.billing_payer_setup_requests (studio_id, payer_id, created_at DESC);
CREATE INDEX billing_payer_setup_requests_open_expiry_idx
    ON public.billing_payer_setup_requests (setup_request_expires_at, studio_id)
    WHERE completed_at IS NULL AND revoked_at IS NULL AND superseded_at IS NULL;
CREATE UNIQUE INDEX billing_payer_setup_requests_one_open
    ON public.billing_payer_setup_requests (
        studio_id, payer_id, stripe_connected_account_id, connect_account_generation
    ) WHERE completed_at IS NULL AND revoked_at IS NULL AND superseded_at IS NULL;

CREATE TABLE public.billing_payer_payment_consents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    setup_request_id UUID NOT NULL REFERENCES public.billing_payer_setup_requests(id) ON DELETE RESTRICT,
    studio_id UUID NOT NULL REFERENCES public.studios(id) ON DELETE CASCADE,
    payer_id UUID NOT NULL REFERENCES public.billing_payers(id) ON DELETE RESTRICT,
    terms_version TEXT NOT NULL,
    stripe_checkout_session_id TEXT NOT NULL,
    stripe_setup_intent_id TEXT,
    stripe_connected_account_id TEXT NOT NULL,
    connect_account_generation INTEGER NOT NULL,
    acceptance_proof_sha256 TEXT NOT NULL,
    accepted_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    revoked_by UUID,
    revocation_reason_code TEXT,
    revocation_proof_sha256 TEXT,
    superseded_at TIMESTAMPTZ,
    setup_request_expires_at TIMESTAMPTZ NOT NULL,
    revision BIGINT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT billing_payer_payment_consents_setup_unique UNIQUE (setup_request_id),
    CONSTRAINT billing_payer_payment_consents_checkout_unique UNIQUE (
        stripe_connected_account_id,
        connect_account_generation,
        stripe_checkout_session_id
    ),
    CONSTRAINT billing_payer_payment_consents_terms_bytes
        CHECK (octet_length(terms_version) BETWEEN 1 AND 128),
    CONSTRAINT billing_payer_payment_consents_proof_shape
        CHECK (acceptance_proof_sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT billing_payer_payment_consents_provider_id_bytes CHECK (
        octet_length(stripe_checkout_session_id) BETWEEN 1 AND 255
        AND (stripe_setup_intent_id IS NULL OR octet_length(stripe_setup_intent_id) BETWEEN 1 AND 255)
        AND octet_length(stripe_connected_account_id) BETWEEN 1 AND 255
    ),
    CONSTRAINT billing_payer_payment_consents_generation_positive
        CHECK (connect_account_generation > 0),
    CONSTRAINT billing_payer_payment_consents_revision_positive CHECK (revision > 0),
    CONSTRAINT billing_payer_payment_consents_revocation_evidence CHECK (
        (revoked_at IS NULL AND revoked_by IS NULL AND revocation_reason_code IS NULL AND revocation_proof_sha256 IS NULL)
        OR (
            revoked_at IS NOT NULL
            AND revocation_reason_code ~ '^[a-z0-9][a-z0-9_.:-]{0,127}$'
            AND ((revoked_by IS NOT NULL)::INTEGER + (revocation_proof_sha256 IS NOT NULL)::INTEGER) = 1
            AND (revocation_proof_sha256 IS NULL OR revocation_proof_sha256 ~ '^[0-9a-f]{64}$')
        )
    ),
    CONSTRAINT billing_payer_payment_consents_lifecycle_order CHECK (
        accepted_at <= setup_request_expires_at
        AND (completed_at IS NULL OR completed_at >= accepted_at)
        AND (completed_at IS NULL OR stripe_setup_intent_id IS NOT NULL)
        AND (revoked_at IS NULL OR revoked_at >= accepted_at)
        AND (superseded_at IS NULL OR superseded_at >= accepted_at)
        AND NOT (revoked_at IS NOT NULL AND superseded_at IS NOT NULL)
    )
);

CREATE UNIQUE INDEX billing_payer_payment_consents_setup_intent_unique
    ON public.billing_payer_payment_consents (
        stripe_connected_account_id,
        connect_account_generation,
        stripe_setup_intent_id
    ) WHERE stripe_setup_intent_id IS NOT NULL;
CREATE UNIQUE INDEX billing_payer_payment_consents_one_active
    ON public.billing_payer_payment_consents (
        studio_id,
        payer_id,
        stripe_connected_account_id,
        connect_account_generation
    ) WHERE completed_at IS NOT NULL AND revoked_at IS NULL AND superseded_at IS NULL;
CREATE INDEX billing_payer_payment_consents_payer_created_idx
    ON public.billing_payer_payment_consents (studio_id, payer_id, created_at DESC);

ALTER TABLE public.billing_provider_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_payer_setup_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_payer_payment_consents ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.billing_provider_operations FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.billing_payer_setup_requests FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.billing_payer_payment_consents FROM PUBLIC, anon, authenticated, service_role;

CREATE POLICY billing_provider_operations_no_client_access
    ON public.billing_provider_operations AS RESTRICTIVE FOR ALL TO anon, authenticated
    USING (false) WITH CHECK (false);
CREATE POLICY billing_payer_setup_requests_no_client_access
    ON public.billing_payer_setup_requests AS RESTRICTIVE FOR ALL TO anon, authenticated
    USING (false) WITH CHECK (false);
CREATE POLICY billing_payer_payment_consents_no_client_access
    ON public.billing_payer_payment_consents AS RESTRICTIVE FOR ALL TO anon, authenticated
    USING (false) WITH CHECK (false);
CREATE POLICY reject_ambiguous_staff_membership_access
    ON public.billing_provider_operations AS RESTRICTIVE FOR ALL TO authenticated
    USING ((SELECT private.has_unambiguous_studio_membership()))
    WITH CHECK ((SELECT private.has_unambiguous_studio_membership()));
CREATE POLICY reject_ambiguous_staff_membership_access
    ON public.billing_payer_setup_requests AS RESTRICTIVE FOR ALL TO authenticated
    USING ((SELECT private.has_unambiguous_studio_membership()))
    WITH CHECK ((SELECT private.has_unambiguous_studio_membership()));
CREATE POLICY reject_ambiguous_staff_membership_access
    ON public.billing_payer_payment_consents AS RESTRICTIVE FOR ALL TO authenticated
    USING ((SELECT private.has_unambiguous_studio_membership()))
    WITH CHECK ((SELECT private.has_unambiguous_studio_membership()));

CREATE FUNCTION private.billing_provider_operation_json_v1(
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
        'operation', jsonb_build_object(
            'id', p_operation.id,
            'studio_id', p_operation.studio_id,
            'actor_id', p_operation.actor_id,
            'operation_type', p_operation.operation_type,
            'caller_request_key', p_operation.caller_request_key,
            'request_sha256', p_operation.request_sha256,
            'stripe_connected_account_id', p_operation.stripe_connected_account_id,
            'connect_account_generation', p_operation.connect_account_generation,
            'state', p_operation.state,
            'provider_request_attempt_count', p_operation.provider_request_attempt_count,
            'lease_owner', p_operation.lease_owner,
            'lease_acquired_at', p_operation.lease_acquired_at,
            'lease_expires_at', p_operation.lease_expires_at,
            'provider_object_id', p_operation.provider_object_id,
            'provider_secondary_object_id', p_operation.provider_secondary_object_id,
            'provider_request_id', p_operation.provider_request_id,
            'result_code', p_operation.result_code,
            'result_summary', p_operation.result_summary,
            'error_code', p_operation.error_code,
            'error_summary', p_operation.error_summary,
            'reconciliation_reason_code', p_operation.reconciliation_reason_code,
            'recovery_proof_sha256', p_operation.recovery_proof_sha256,
            'recovery_outcome', p_operation.recovery_outcome,
            'recovery_actor_id', p_operation.recovery_actor_id,
            'recovery_authorized_at', p_operation.recovery_authorized_at,
            'revision', p_operation.revision,
            'started_at', p_operation.started_at,
            'provider_request_in_flight_at', p_operation.provider_request_in_flight_at,
            'provider_succeeded_at', p_operation.provider_succeeded_at,
            'projected_at', p_operation.projected_at,
            'completed_at', p_operation.completed_at,
            'reconciliation_required_at', p_operation.reconciliation_required_at,
            'definitive_failed_at', p_operation.definitive_failed_at,
            'definitive_rejected_at', p_operation.definitive_rejected_at,
            'created_at', p_operation.created_at,
            'updated_at', p_operation.updated_at
        )
    );
$$;

ALTER FUNCTION private.billing_provider_operation_json_v1(
    public.billing_provider_operations,
    TEXT
) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.billing_provider_operation_json_v1(
    public.billing_provider_operations,
    TEXT
) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION private.preserve_billing_provider_operation_identity_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
    IF OLD.id IS DISTINCT FROM NEW.id
       OR OLD.studio_id IS DISTINCT FROM NEW.studio_id
       OR OLD.actor_id IS DISTINCT FROM NEW.actor_id
       OR OLD.operation_type IS DISTINCT FROM NEW.operation_type
       OR OLD.caller_request_key IS DISTINCT FROM NEW.caller_request_key
       OR OLD.request_sha256 IS DISTINCT FROM NEW.request_sha256
       OR OLD.stripe_connected_account_id IS DISTINCT FROM NEW.stripe_connected_account_id
       OR OLD.connect_account_generation IS DISTINCT FROM NEW.connect_account_generation
       OR OLD.started_at IS DISTINCT FROM NEW.started_at
       OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
        RAISE EXCEPTION USING ERRCODE = '23514',
            MESSAGE = 'billing_provider_operation_identity_immutable';
    END IF;
    IF NEW.revision IS DISTINCT FROM OLD.revision + 1 THEN
        RAISE EXCEPTION USING ERRCODE = '23514',
            MESSAGE = 'billing_provider_operation_revision_invalid';
    END IF;
    RETURN NEW;
END;
$$;

ALTER FUNCTION private.preserve_billing_provider_operation_identity_v1() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.preserve_billing_provider_operation_identity_v1()
    FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER preserve_billing_provider_operation_identity_v1
    BEFORE UPDATE ON public.billing_provider_operations
    FOR EACH ROW EXECUTE FUNCTION private.preserve_billing_provider_operation_identity_v1();

CREATE FUNCTION public.claim_billing_provider_operation_v1(
    p_studio_id UUID,
    p_actor_id UUID,
    p_operation_type TEXT,
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
    v_operation public.billing_provider_operations%ROWTYPE;
    v_now TIMESTAMPTZ := clock_timestamp();
    v_outcome TEXT;
BEGIN
    IF p_studio_id IS NULL OR p_actor_id IS NULL OR p_lease_owner IS NULL
       OR p_operation_type IS NULL OR p_caller_request_key IS NULL
       OR p_request_sha256 IS NULL OR p_stripe_connected_account_id IS NULL
       OR p_connect_account_generation IS NULL
       OR p_lease_seconds NOT BETWEEN 5 AND 300 THEN
        RAISE EXCEPTION USING ERRCODE = '22023',
            MESSAGE = 'billing_provider_operation_invalid_claim';
    END IF;

    IF p_operation_type IN (
        'enrollment.cancel.period_end.schedule',
        'enrollment.cancel.period_end.execute',
        'enrollment.cancel.period_end.revoke',
        'enrollment.cancel.immediate'
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '0A000',
            MESSAGE = 'billing_provider_operation_reserved';
    END IF;

    IF p_operation_type NOT IN (
        'payer.sync', 'payer.setup', 'plan.sync', 'plan.archive',
        'enrollment.activate.autopay', 'enrollment.activate.invoice',
        'invoice.create', 'invoice.retry', 'invoice.void',
        'payment.refund', 'payer.reconcile'
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '22023',
            MESSAGE = 'billing_provider_operation_unknown_type';
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

    INSERT INTO public.billing_provider_operations (
        studio_id, actor_id, operation_type, caller_request_key,
        request_sha256, stripe_connected_account_id,
        connect_account_generation, lease_owner,
        lease_acquired_at, lease_expires_at, started_at, created_at, updated_at
    ) VALUES (
        p_studio_id, p_actor_id, p_operation_type, p_caller_request_key,
        p_request_sha256, p_stripe_connected_account_id,
        p_connect_account_generation, p_lease_owner,
        v_now, v_now + make_interval(secs => p_lease_seconds), v_now, v_now, v_now
    )
    ON CONFLICT (studio_id, operation_type, caller_request_key) DO NOTHING
    RETURNING * INTO v_operation;

    IF FOUND THEN
        RETURN private.billing_provider_operation_json_v1(v_operation, 'claimed');
    END IF;

    SELECT * INTO v_operation
    FROM public.billing_provider_operations
    WHERE studio_id = p_studio_id
      AND operation_type = p_operation_type
      AND caller_request_key = p_caller_request_key
    FOR UPDATE;

    IF v_operation.actor_id IS DISTINCT FROM p_actor_id
       OR v_operation.operation_type IS DISTINCT FROM p_operation_type
       OR v_operation.request_sha256 IS DISTINCT FROM p_request_sha256
       OR v_operation.stripe_connected_account_id IS DISTINCT FROM p_stripe_connected_account_id
       OR v_operation.connect_account_generation IS DISTINCT FROM p_connect_account_generation THEN
        RAISE EXCEPTION USING ERRCODE = '23505',
            MESSAGE = 'billing_provider_operation_request_conflict';
    END IF;

    IF v_operation.state IN ('completed', 'definitive_failed', 'definitive_rejected') THEN
        RETURN private.billing_provider_operation_json_v1(v_operation, 'replay');
    ELSIF v_operation.state = 'provider_request_in_flight' THEN
        RETURN private.billing_provider_operation_json_v1(v_operation, 'provider_request_in_flight');
    ELSIF v_operation.state = 'reconciliation_required' THEN
        RETURN private.billing_provider_operation_json_v1(v_operation, 'reconciliation_required');
    ELSIF v_operation.lease_owner IS DISTINCT FROM p_lease_owner
          AND v_operation.lease_expires_at > v_now THEN
        RETURN private.billing_provider_operation_json_v1(v_operation, 'busy');
    END IF;

    v_outcome := CASE WHEN v_operation.state = 'started' THEN 'claimed' ELSE 'continued' END;
    UPDATE public.billing_provider_operations
    SET lease_owner = p_lease_owner,
        lease_acquired_at = v_now,
        lease_expires_at = v_now + make_interval(secs => p_lease_seconds),
        revision = revision + 1,
        updated_at = v_now
    WHERE id = v_operation.id
    RETURNING * INTO v_operation;

    RETURN private.billing_provider_operation_json_v1(v_operation, v_outcome);
END;
$$;

CREATE FUNCTION public.read_billing_provider_operation_v1(
    p_operation_id UUID,
    p_studio_id UUID,
    p_reader_id UUID,
    p_operation_type TEXT,
    p_caller_request_key TEXT,
    p_request_sha256 TEXT,
    p_stripe_connected_account_id TEXT,
    p_connect_account_generation INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
DECLARE
    v_operation public.billing_provider_operations%ROWTYPE;
BEGIN
    SELECT * INTO v_operation
    FROM public.billing_provider_operations
    WHERE id = p_operation_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0002',
            MESSAGE = 'billing_provider_operation_not_found';
    END IF;
    IF v_operation.studio_id IS DISTINCT FROM p_studio_id
       OR v_operation.operation_type IS DISTINCT FROM p_operation_type
       OR v_operation.caller_request_key IS DISTINCT FROM p_caller_request_key
       OR v_operation.request_sha256 IS DISTINCT FROM p_request_sha256
       OR v_operation.stripe_connected_account_id IS DISTINCT FROM p_stripe_connected_account_id
       OR v_operation.connect_account_generation IS DISTINCT FROM p_connect_account_generation THEN
        RAISE EXCEPTION USING ERRCODE = '23514',
            MESSAGE = 'billing_provider_operation_identity_mismatch';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM public.staff_roles AS membership
        WHERE membership.studio_id = p_studio_id
          AND membership.user_id = p_reader_id
          AND membership.archived_at IS NULL
          AND membership.role IN ('admin', 'front_desk')
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'billing_provider_operation_reader_not_active';
    END IF;
    RETURN private.billing_provider_operation_json_v1(v_operation, 'read');
END;
$$;

CREATE FUNCTION public.transition_billing_provider_operation_v1(
    p_operation_id UUID,
    p_studio_id UUID,
    p_actor_id UUID,
    p_operation_type TEXT,
    p_caller_request_key TEXT,
    p_request_sha256 TEXT,
    p_stripe_connected_account_id TEXT,
    p_connect_account_generation INTEGER,
    p_lease_owner UUID,
    p_expected_revision BIGINT,
    p_to_state TEXT,
    p_provider_object_id TEXT DEFAULT NULL,
    p_provider_secondary_object_id TEXT DEFAULT NULL,
    p_provider_request_id TEXT DEFAULT NULL,
    p_result_code TEXT DEFAULT NULL,
    p_result_summary TEXT DEFAULT NULL,
    p_error_code TEXT DEFAULT NULL,
    p_error_summary TEXT DEFAULT NULL,
    p_reconciliation_reason_code TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_operation public.billing_provider_operations%ROWTYPE;
    v_now TIMESTAMPTZ := clock_timestamp();
    v_legal BOOLEAN := false;
BEGIN
    SELECT * INTO v_operation
    FROM public.billing_provider_operations
    WHERE id = p_operation_id
    FOR UPDATE;
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
    IF v_operation.state = p_to_state
       AND v_operation.state IN ('completed', 'definitive_failed', 'definitive_rejected') THEN
        RETURN private.billing_provider_operation_json_v1(v_operation, 'replay');
    END IF;
    IF v_operation.revision IS DISTINCT FROM p_expected_revision THEN
        RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'billing_provider_operation_stale_revision';
    END IF;
    IF v_operation.state <> 'reconciliation_required'
       AND v_operation.lease_owner IS DISTINCT FROM p_lease_owner THEN
        RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'billing_provider_operation_lease_owner_mismatch';
    END IF;

    v_legal := CASE v_operation.state
        WHEN 'started' THEN p_to_state IN ('provider_request_in_flight', 'definitive_failed', 'definitive_rejected')
        WHEN 'provider_request_in_flight' THEN p_to_state IN ('provider_succeeded', 'reconciliation_required', 'definitive_failed', 'definitive_rejected')
        WHEN 'recovery_authorized' THEN (
            (v_operation.recovery_outcome = 'provider_no_object_safe_to_retry'
                AND p_to_state = 'provider_request_in_flight')
            OR (v_operation.recovery_outcome = 'provider_succeeded_reconcile_only'
                AND p_to_state = 'provider_succeeded')
        )
        WHEN 'provider_succeeded' THEN p_to_state IN ('projected', 'reconciliation_required')
        WHEN 'projected' THEN p_to_state IN ('completed', 'reconciliation_required')
        WHEN 'reconciliation_required' THEN p_to_state IN ('provider_succeeded', 'projected', 'definitive_failed', 'definitive_rejected')
        ELSE false
    END;
    IF NOT v_legal THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'billing_provider_operation_invalid_transition';
    END IF;
    IF p_to_state = 'provider_request_in_flight'
       AND v_operation.provider_request_attempt_count <> 0
       AND v_operation.state <> 'recovery_authorized' THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'billing_provider_operation_second_provider_attempt_denied';
    END IF;
    IF p_to_state IN ('provider_succeeded', 'projected')
       AND COALESCE(p_provider_object_id, v_operation.provider_object_id) IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'billing_provider_operation_provider_object_required';
    END IF;
    IF p_to_state = 'reconciliation_required' AND p_reconciliation_reason_code IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'billing_provider_operation_reconciliation_reason_required';
    END IF;
    IF p_to_state IN ('definitive_failed', 'definitive_rejected') AND p_error_code IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'billing_provider_operation_error_code_required';
    END IF;

    UPDATE public.billing_provider_operations
    SET state = p_to_state,
        provider_request_attempt_count = CASE
            WHEN p_to_state = 'provider_request_in_flight' THEN provider_request_attempt_count + 1
            ELSE provider_request_attempt_count
        END,
        provider_object_id = COALESCE(p_provider_object_id, provider_object_id),
        provider_secondary_object_id = COALESCE(p_provider_secondary_object_id, provider_secondary_object_id),
        provider_request_id = COALESCE(p_provider_request_id, provider_request_id),
        result_code = COALESCE(p_result_code, result_code),
        result_summary = COALESCE(p_result_summary, result_summary),
        error_code = CASE WHEN p_to_state IN ('definitive_failed', 'definitive_rejected') THEN p_error_code ELSE error_code END,
        error_summary = CASE WHEN p_to_state IN ('definitive_failed', 'definitive_rejected') THEN p_error_summary ELSE error_summary END,
        reconciliation_reason_code = CASE WHEN p_to_state = 'reconciliation_required' THEN p_reconciliation_reason_code ELSE NULL END,
        provider_request_in_flight_at = CASE WHEN p_to_state = 'provider_request_in_flight' THEN v_now ELSE provider_request_in_flight_at END,
        provider_succeeded_at = CASE WHEN p_to_state = 'provider_succeeded' THEN COALESCE(provider_succeeded_at, v_now) ELSE provider_succeeded_at END,
        projected_at = CASE WHEN p_to_state = 'projected' THEN COALESCE(projected_at, v_now) ELSE projected_at END,
        reconciliation_required_at = CASE WHEN p_to_state = 'reconciliation_required' THEN v_now ELSE reconciliation_required_at END,
        definitive_failed_at = CASE WHEN p_to_state = 'definitive_failed' THEN v_now ELSE definitive_failed_at END,
        definitive_rejected_at = CASE WHEN p_to_state = 'definitive_rejected' THEN v_now ELSE definitive_rejected_at END,
        lease_owner = CASE WHEN p_to_state IN ('reconciliation_required', 'definitive_failed', 'definitive_rejected') THEN NULL ELSE lease_owner END,
        lease_acquired_at = CASE WHEN p_to_state IN ('reconciliation_required', 'definitive_failed', 'definitive_rejected') THEN NULL ELSE lease_acquired_at END,
        lease_expires_at = CASE WHEN p_to_state IN ('reconciliation_required', 'definitive_failed', 'definitive_rejected') THEN NULL ELSE lease_expires_at END,
        revision = revision + 1,
        updated_at = v_now
    WHERE id = v_operation.id
    RETURNING * INTO v_operation;
    RETURN private.billing_provider_operation_json_v1(v_operation, 'transitioned');
END;
$$;

CREATE FUNCTION public.complete_billing_provider_operation_v1(
    p_operation_id UUID,
    p_studio_id UUID,
    p_actor_id UUID,
    p_operation_type TEXT,
    p_caller_request_key TEXT,
    p_request_sha256 TEXT,
    p_stripe_connected_account_id TEXT,
    p_connect_account_generation INTEGER,
    p_lease_owner UUID,
    p_expected_revision BIGINT,
    p_result_code TEXT DEFAULT NULL,
    p_result_summary TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_operation public.billing_provider_operations%ROWTYPE;
    v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
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
    IF v_operation.state = 'completed' THEN
        RETURN private.billing_provider_operation_json_v1(v_operation, 'replay');
    END IF;
    IF v_operation.revision IS DISTINCT FROM p_expected_revision THEN
        RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'billing_provider_operation_stale_revision';
    END IF;
    IF v_operation.state <> 'projected' THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'billing_provider_operation_invalid_transition';
    END IF;
    IF v_operation.lease_owner IS DISTINCT FROM p_lease_owner THEN
        RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'billing_provider_operation_lease_owner_mismatch';
    END IF;
    UPDATE public.billing_provider_operations
    SET state = 'completed',
        result_code = COALESCE(p_result_code, result_code),
        result_summary = COALESCE(p_result_summary, result_summary),
        completed_at = v_now,
        lease_owner = NULL,
        lease_acquired_at = NULL,
        lease_expires_at = NULL,
        revision = revision + 1,
        updated_at = v_now
    WHERE id = v_operation.id RETURNING * INTO v_operation;
    RETURN private.billing_provider_operation_json_v1(v_operation, 'completed');
END;
$$;

ALTER FUNCTION public.claim_billing_provider_operation_v1(UUID, UUID, TEXT, TEXT, TEXT, TEXT, INTEGER, UUID, INTEGER) OWNER TO postgres;
ALTER FUNCTION public.read_billing_provider_operation_v1(UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, INTEGER) OWNER TO postgres;
ALTER FUNCTION public.transition_billing_provider_operation_v1(UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, INTEGER, UUID, BIGINT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) OWNER TO postgres;
ALTER FUNCTION public.complete_billing_provider_operation_v1(UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, INTEGER, UUID, BIGINT, TEXT, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.claim_billing_provider_operation_v1(UUID, UUID, TEXT, TEXT, TEXT, TEXT, INTEGER, UUID, INTEGER) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.read_billing_provider_operation_v1(UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, INTEGER) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.transition_billing_provider_operation_v1(UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, INTEGER, UUID, BIGINT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.complete_billing_provider_operation_v1(UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, INTEGER, UUID, BIGINT, TEXT, TEXT) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.claim_billing_provider_operation_v1(UUID, UUID, TEXT, TEXT, TEXT, TEXT, INTEGER, UUID, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.read_billing_provider_operation_v1(UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.transition_billing_provider_operation_v1(UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, INTEGER, UUID, BIGINT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_billing_provider_operation_v1(UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, INTEGER, UUID, BIGINT, TEXT, TEXT) TO service_role;

CREATE FUNCTION public.authorize_billing_provider_operation_recovery_v1(
    p_operation_id UUID,
    p_studio_id UUID,
    p_actor_id UUID,
    p_operation_type TEXT,
    p_caller_request_key TEXT,
    p_request_sha256 TEXT,
    p_stripe_connected_account_id TEXT,
    p_connect_account_generation INTEGER,
    p_recovery_actor_id UUID,
    p_recovery_proof_sha256 TEXT,
    p_recovery_outcome TEXT,
    p_lease_owner UUID,
    p_lease_seconds INTEGER,
    p_expected_revision BIGINT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_operation public.billing_provider_operations%ROWTYPE;
    v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
    IF p_recovery_proof_sha256 !~ '^[0-9a-f]{64}$'
       OR p_recovery_outcome NOT IN (
            'provider_no_object_safe_to_retry',
            'provider_succeeded_reconcile_only'
       )
       OR p_lease_owner IS NULL OR p_lease_seconds NOT BETWEEN 5 AND 300 THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'billing_provider_operation_recovery_invalid';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM public.staff_roles AS membership
        WHERE membership.studio_id = p_studio_id
          AND membership.user_id = p_recovery_actor_id
          AND membership.archived_at IS NULL
          AND membership.role = 'admin'
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'billing_provider_operation_recovery_actor_not_admin';
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
    IF v_operation.state = 'recovery_authorized'
       AND v_operation.recovery_proof_sha256 = p_recovery_proof_sha256
       AND v_operation.recovery_outcome = p_recovery_outcome
       AND v_operation.recovery_actor_id = p_recovery_actor_id THEN
        RETURN private.billing_provider_operation_json_v1(v_operation, 'replay');
    END IF;
    IF v_operation.revision IS DISTINCT FROM p_expected_revision THEN
        RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'billing_provider_operation_stale_revision';
    END IF;
    IF v_operation.state NOT IN ('provider_request_in_flight', 'reconciliation_required') THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'billing_provider_operation_recovery_state_invalid';
    END IF;
    IF p_recovery_outcome = 'provider_no_object_safe_to_retry'
       AND v_operation.provider_request_attempt_count >= 2 THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'billing_provider_operation_retry_limit_reached';
    END IF;
    UPDATE public.billing_provider_operations
    SET state = 'recovery_authorized',
        recovery_proof_sha256 = p_recovery_proof_sha256,
        recovery_outcome = p_recovery_outcome,
        recovery_actor_id = p_recovery_actor_id,
        recovery_authorized_at = v_now,
        reconciliation_reason_code = NULL,
        lease_owner = p_lease_owner,
        lease_acquired_at = v_now,
        lease_expires_at = v_now + make_interval(secs => p_lease_seconds),
        revision = revision + 1,
        updated_at = v_now
    WHERE id = v_operation.id RETURNING * INTO v_operation;
    RETURN private.billing_provider_operation_json_v1(v_operation, 'recovery_authorized');
END;
$$;

ALTER FUNCTION public.authorize_billing_provider_operation_recovery_v1(UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, INTEGER, UUID, TEXT, TEXT, UUID, INTEGER, BIGINT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.authorize_billing_provider_operation_recovery_v1(UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, INTEGER, UUID, TEXT, TEXT, UUID, INTEGER, BIGINT) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.authorize_billing_provider_operation_recovery_v1(UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, INTEGER, UUID, TEXT, TEXT, UUID, INTEGER, BIGINT) TO service_role;

CREATE FUNCTION private.billing_payer_setup_request_json_v1(
    p_request public.billing_payer_setup_requests,
    p_outcome TEXT
)
RETURNS JSONB LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
    SELECT jsonb_build_object('outcome', p_outcome, 'setup_request', to_jsonb(p_request));
$$;
CREATE FUNCTION private.billing_payer_payment_consent_json_v1(
    p_consent public.billing_payer_payment_consents,
    p_outcome TEXT
)
RETURNS JSONB LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
    SELECT jsonb_build_object('outcome', p_outcome, 'consent', to_jsonb(p_consent));
$$;
ALTER FUNCTION private.billing_payer_setup_request_json_v1(public.billing_payer_setup_requests, TEXT) OWNER TO postgres;
ALTER FUNCTION private.billing_payer_payment_consent_json_v1(public.billing_payer_payment_consents, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.billing_payer_setup_request_json_v1(public.billing_payer_setup_requests, TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.billing_payer_payment_consent_json_v1(public.billing_payer_payment_consents, TEXT) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION private.preserve_billing_payer_setup_request_v1()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
    IF OLD.id IS DISTINCT FROM NEW.id OR OLD.operation_id IS DISTINCT FROM NEW.operation_id
       OR OLD.studio_id IS DISTINCT FROM NEW.studio_id OR OLD.payer_id IS DISTINCT FROM NEW.payer_id
       OR OLD.initiated_by IS DISTINCT FROM NEW.initiated_by OR OLD.terms_version IS DISTINCT FROM NEW.terms_version
       OR OLD.stripe_connected_account_id IS DISTINCT FROM NEW.stripe_connected_account_id
       OR OLD.connect_account_generation IS DISTINCT FROM NEW.connect_account_generation
       OR OLD.setup_request_expires_at IS DISTINCT FROM NEW.setup_request_expires_at OR OLD.created_at IS DISTINCT FROM NEW.created_at
       OR (OLD.stripe_checkout_session_id IS NOT NULL AND OLD.stripe_checkout_session_id IS DISTINCT FROM NEW.stripe_checkout_session_id)
       OR (OLD.stripe_setup_intent_id IS NOT NULL AND OLD.stripe_setup_intent_id IS DISTINCT FROM NEW.stripe_setup_intent_id)
       OR (OLD.accepted_at IS NOT NULL AND OLD.accepted_at IS DISTINCT FROM NEW.accepted_at)
       OR (OLD.completed_at IS NOT NULL AND OLD.completed_at IS DISTINCT FROM NEW.completed_at)
       OR (OLD.revoked_at IS NOT NULL AND OLD.revoked_at IS DISTINCT FROM NEW.revoked_at)
       OR (OLD.superseded_at IS NOT NULL AND OLD.superseded_at IS DISTINCT FROM NEW.superseded_at)
       OR (OLD.closed_at IS NOT NULL AND OLD.closed_at IS DISTINCT FROM NEW.closed_at)
       OR (OLD.close_reason_code IS NOT NULL AND OLD.close_reason_code IS DISTINCT FROM NEW.close_reason_code)
       OR (
            OLD.provider_read_proof_sha256 IS NOT NULL
            AND OLD.provider_read_proof_sha256 IS DISTINCT FROM NEW.provider_read_proof_sha256
       ) THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'billing_payer_setup_request_identity_immutable';
    END IF;
    IF NEW.revision IS DISTINCT FROM OLD.revision + 1 OR NEW.updated_at <= OLD.updated_at THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'billing_payer_setup_request_revision_invalid';
    END IF;
    RETURN NEW;
END;
$$;

CREATE FUNCTION private.preserve_billing_payer_payment_consent_v1()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
    IF OLD.id IS DISTINCT FROM NEW.id OR OLD.setup_request_id IS DISTINCT FROM NEW.setup_request_id
       OR OLD.studio_id IS DISTINCT FROM NEW.studio_id OR OLD.payer_id IS DISTINCT FROM NEW.payer_id
       OR OLD.terms_version IS DISTINCT FROM NEW.terms_version
       OR OLD.stripe_checkout_session_id IS DISTINCT FROM NEW.stripe_checkout_session_id
       OR OLD.stripe_connected_account_id IS DISTINCT FROM NEW.stripe_connected_account_id
       OR OLD.connect_account_generation IS DISTINCT FROM NEW.connect_account_generation
       OR OLD.acceptance_proof_sha256 IS DISTINCT FROM NEW.acceptance_proof_sha256
       OR OLD.accepted_at IS DISTINCT FROM NEW.accepted_at
       OR OLD.setup_request_expires_at IS DISTINCT FROM NEW.setup_request_expires_at
       OR OLD.created_at IS DISTINCT FROM NEW.created_at
       OR (OLD.stripe_setup_intent_id IS NOT NULL AND OLD.stripe_setup_intent_id IS DISTINCT FROM NEW.stripe_setup_intent_id)
       OR (OLD.completed_at IS NOT NULL AND OLD.completed_at IS DISTINCT FROM NEW.completed_at)
       OR (OLD.revoked_at IS NOT NULL AND OLD.revoked_at IS DISTINCT FROM NEW.revoked_at)
       OR (OLD.revoked_by IS NOT NULL AND OLD.revoked_by IS DISTINCT FROM NEW.revoked_by)
       OR (OLD.revocation_reason_code IS NOT NULL AND OLD.revocation_reason_code IS DISTINCT FROM NEW.revocation_reason_code)
       OR (OLD.revocation_proof_sha256 IS NOT NULL AND OLD.revocation_proof_sha256 IS DISTINCT FROM NEW.revocation_proof_sha256)
       OR (OLD.superseded_at IS NOT NULL AND OLD.superseded_at IS DISTINCT FROM NEW.superseded_at) THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'billing_payer_payment_consent_identity_immutable';
    END IF;
    IF NEW.revision IS DISTINCT FROM OLD.revision + 1 OR NEW.updated_at <= OLD.updated_at THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'billing_payer_payment_consent_revision_invalid';
    END IF;
    RETURN NEW;
END;
$$;

ALTER FUNCTION private.preserve_billing_payer_setup_request_v1() OWNER TO postgres;
ALTER FUNCTION private.preserve_billing_payer_payment_consent_v1() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.preserve_billing_payer_setup_request_v1() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.preserve_billing_payer_payment_consent_v1() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER preserve_billing_payer_setup_request_v1 BEFORE UPDATE ON public.billing_payer_setup_requests
    FOR EACH ROW EXECUTE FUNCTION private.preserve_billing_payer_setup_request_v1();
CREATE TRIGGER preserve_billing_payer_payment_consent_v1 BEFORE UPDATE ON public.billing_payer_payment_consents
    FOR EACH ROW EXECUTE FUNCTION private.preserve_billing_payer_payment_consent_v1();

CREATE FUNCTION public.prepare_billing_payer_setup_request_v1(
    p_operation_id UUID,
    p_setup_request_id UUID,
    p_studio_id UUID,
    p_actor_id UUID,
    p_payer_id UUID,
    p_terms_version TEXT,
    p_stripe_connected_account_id TEXT,
    p_connect_account_generation INTEGER,
    p_lease_owner UUID,
    p_expected_operation_revision BIGINT,
    p_expires_at TIMESTAMPTZ
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_operation public.billing_provider_operations%ROWTYPE;
    v_request public.billing_payer_setup_requests%ROWTYPE;
    v_now TIMESTAMPTZ := clock_timestamp();
    v_request_id UUID := COALESCE(p_setup_request_id, gen_random_uuid());
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM public.staff_roles AS membership
        WHERE membership.studio_id = p_studio_id AND membership.user_id = p_actor_id
          AND membership.archived_at IS NULL AND membership.role IN ('admin', 'front_desk')
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'billing_payer_setup_tenant_actor_invalid';
    END IF;
    PERFORM 1
    FROM public.billing_provider_operations AS locked_operation
    WHERE locked_operation.id = p_operation_id
       OR locked_operation.id IN (
            SELECT existing_request.operation_id
            FROM public.billing_payer_setup_requests AS existing_request
            WHERE existing_request.studio_id = p_studio_id
              AND existing_request.payer_id = p_payer_id
              AND existing_request.stripe_connected_account_id = p_stripe_connected_account_id
              AND existing_request.connect_account_generation = p_connect_account_generation
              AND existing_request.completed_at IS NULL
              AND existing_request.revoked_at IS NULL
              AND existing_request.superseded_at IS NULL
       )
    ORDER BY locked_operation.id FOR UPDATE;
    PERFORM 1 FROM public.billing_payers AS payer
    WHERE payer.id = p_payer_id AND payer.studio_id = p_studio_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'billing_payer_setup_tenant_actor_invalid';
    END IF;
    -- Refresh and lock any request that committed while this call waited for the
    -- payer row. Every operation lock is still acquired in UUID order.
    PERFORM 1
    FROM public.billing_provider_operations AS locked_operation
    JOIN public.billing_payer_setup_requests AS existing_request
      ON existing_request.operation_id = locked_operation.id
    WHERE existing_request.studio_id = p_studio_id
      AND existing_request.payer_id = p_payer_id
      AND existing_request.stripe_connected_account_id = p_stripe_connected_account_id
      AND existing_request.connect_account_generation = p_connect_account_generation
      AND existing_request.completed_at IS NULL
      AND existing_request.revoked_at IS NULL
      AND existing_request.superseded_at IS NULL
    ORDER BY locked_operation.id FOR UPDATE OF locked_operation;
    SELECT * INTO v_operation FROM public.billing_provider_operations WHERE id = p_operation_id;
    IF NOT FOUND OR v_operation.studio_id IS DISTINCT FROM p_studio_id
       OR v_operation.actor_id IS DISTINCT FROM p_actor_id OR v_operation.operation_type <> 'payer.setup'
       OR v_operation.stripe_connected_account_id IS DISTINCT FROM p_stripe_connected_account_id
       OR v_operation.connect_account_generation IS DISTINCT FROM p_connect_account_generation THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'billing_payer_setup_operation_identity_mismatch';
    END IF;
    SELECT * INTO v_request FROM public.billing_payer_setup_requests
    WHERE operation_id = p_operation_id FOR UPDATE;
    IF FOUND THEN
        IF v_request.id IS DISTINCT FROM v_request_id OR v_request.studio_id IS DISTINCT FROM p_studio_id
           OR v_request.payer_id IS DISTINCT FROM p_payer_id OR v_request.initiated_by IS DISTINCT FROM p_actor_id
           OR v_request.terms_version IS DISTINCT FROM p_terms_version
           OR v_request.stripe_connected_account_id IS DISTINCT FROM p_stripe_connected_account_id
           OR v_request.connect_account_generation IS DISTINCT FROM p_connect_account_generation
           OR v_request.setup_request_expires_at IS DISTINCT FROM p_expires_at THEN
            RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'billing_payer_setup_request_conflict';
        END IF;
        IF v_request.revoked_at IS NOT NULL OR v_request.superseded_at IS NOT NULL THEN
            RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'billing_payer_setup_request_closed';
        END IF;
        IF v_request.setup_request_expires_at <= v_now THEN
            RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'billing_payer_setup_request_expired';
        END IF;
        IF v_operation.state IN ('definitive_failed', 'definitive_rejected') THEN
            RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'billing_payer_setup_operation_terminal';
        END IF;
        RETURN private.billing_payer_setup_request_json_v1(v_request, 'replay');
    END IF;
    IF v_operation.state <> 'started' OR v_operation.lease_owner IS DISTINCT FROM p_lease_owner
       OR v_operation.revision IS DISTINCT FROM p_expected_operation_revision THEN
        RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'billing_payer_setup_operation_not_claimed';
    END IF;
    IF p_expires_at <= v_now + interval '5 minutes' OR p_expires_at > v_now + interval '24 hours' THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'billing_payer_setup_expiry_invalid';
    END IF;

    PERFORM 1 FROM public.billing_payer_setup_requests AS existing_request
    WHERE existing_request.studio_id = p_studio_id
      AND existing_request.payer_id = p_payer_id
      AND existing_request.stripe_connected_account_id = p_stripe_connected_account_id
      AND existing_request.connect_account_generation = p_connect_account_generation
      AND existing_request.completed_at IS NULL
      AND existing_request.revoked_at IS NULL
      AND existing_request.superseded_at IS NULL
    ORDER BY existing_request.id FOR UPDATE;
    IF EXISTS (
        SELECT 1
        FROM public.billing_payer_setup_requests AS existing_request
        JOIN public.billing_provider_operations AS existing_operation
          ON existing_operation.id = existing_request.operation_id
        WHERE existing_request.studio_id = p_studio_id
          AND existing_request.payer_id = p_payer_id
          AND existing_request.stripe_connected_account_id = p_stripe_connected_account_id
          AND existing_request.connect_account_generation = p_connect_account_generation
          AND existing_request.operation_id <> p_operation_id
          AND existing_request.completed_at IS NULL
          AND existing_request.revoked_at IS NULL
          AND existing_request.superseded_at IS NULL
          AND NOT (
                existing_operation.provider_request_attempt_count = 0
                AND existing_operation.provider_object_id IS NULL
                AND existing_request.stripe_checkout_session_id IS NULL
                AND existing_operation.state IN ('started', 'definitive_rejected')
          )
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'billing_payer_setup_existing_operation_ambiguous';
    END IF;
    PERFORM 1 FROM public.billing_payer_payment_consents AS existing_consent
    WHERE existing_consent.studio_id = p_studio_id
      AND existing_consent.payer_id = p_payer_id
      AND existing_consent.stripe_connected_account_id = p_stripe_connected_account_id
      AND existing_consent.connect_account_generation = p_connect_account_generation
      AND existing_consent.completed_at IS NULL
      AND existing_consent.revoked_at IS NULL
      AND existing_consent.superseded_at IS NULL
    ORDER BY existing_consent.id FOR UPDATE;
    UPDATE public.billing_provider_operations AS existing_operation
    SET state = 'definitive_rejected',
        error_code = 'superseded_before_provider',
        error_summary = 'superseded_before_provider',
        definitive_rejected_at = v_now,
        lease_owner = NULL, lease_acquired_at = NULL, lease_expires_at = NULL,
        revision = existing_operation.revision + 1,
        updated_at = v_now
    FROM public.billing_payer_setup_requests AS existing_request
    WHERE existing_request.operation_id = existing_operation.id
      AND existing_request.studio_id = p_studio_id
      AND existing_request.payer_id = p_payer_id
      AND existing_request.stripe_connected_account_id = p_stripe_connected_account_id
      AND existing_request.connect_account_generation = p_connect_account_generation
      AND existing_request.operation_id <> p_operation_id
      AND existing_request.completed_at IS NULL
      AND existing_request.revoked_at IS NULL
      AND existing_request.superseded_at IS NULL
      AND existing_operation.state = 'started';
    UPDATE public.billing_payer_payment_consents
    SET superseded_at = v_now, revision = revision + 1, updated_at = v_now
    WHERE studio_id = p_studio_id AND payer_id = p_payer_id
      AND stripe_connected_account_id = p_stripe_connected_account_id
      AND connect_account_generation = p_connect_account_generation
      AND completed_at IS NULL AND revoked_at IS NULL AND superseded_at IS NULL;
    UPDATE public.billing_payer_setup_requests
    SET superseded_at = v_now, revision = revision + 1, updated_at = v_now
    WHERE studio_id = p_studio_id AND payer_id = p_payer_id
      AND stripe_connected_account_id = p_stripe_connected_account_id
      AND connect_account_generation = p_connect_account_generation
      AND completed_at IS NULL AND revoked_at IS NULL AND superseded_at IS NULL;
    INSERT INTO public.billing_payer_setup_requests (
        id, operation_id, studio_id, payer_id, initiated_by, terms_version,
        stripe_connected_account_id, connect_account_generation,
        setup_request_expires_at, created_at, updated_at
    ) VALUES (
        v_request_id, p_operation_id, p_studio_id, p_payer_id, p_actor_id, p_terms_version,
        p_stripe_connected_account_id, p_connect_account_generation,
        p_expires_at, v_now, v_now
    )
    ON CONFLICT (operation_id) DO NOTHING RETURNING * INTO v_request;
    IF NOT FOUND THEN
        SELECT * INTO v_request FROM public.billing_payer_setup_requests WHERE operation_id = p_operation_id;
        IF v_request.id IS DISTINCT FROM v_request_id OR v_request.studio_id IS DISTINCT FROM p_studio_id
           OR v_request.payer_id IS DISTINCT FROM p_payer_id OR v_request.initiated_by IS DISTINCT FROM p_actor_id
           OR v_request.terms_version IS DISTINCT FROM p_terms_version
           OR v_request.stripe_connected_account_id IS DISTINCT FROM p_stripe_connected_account_id
           OR v_request.connect_account_generation IS DISTINCT FROM p_connect_account_generation
           OR v_request.setup_request_expires_at IS DISTINCT FROM p_expires_at THEN
            RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'billing_payer_setup_request_conflict';
        END IF;
        RETURN private.billing_payer_setup_request_json_v1(v_request, 'replay');
    END IF;
    RETURN private.billing_payer_setup_request_json_v1(v_request, 'prepared');
END;
$$;

CREATE FUNCTION public.bind_billing_payer_setup_session_v1(
    p_setup_request_id UUID,
    p_operation_id UUID,
    p_studio_id UUID,
    p_payer_id UUID,
    p_stripe_checkout_session_id TEXT,
    p_stripe_connected_account_id TEXT,
    p_connect_account_generation INTEGER,
    p_expected_setup_revision BIGINT
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_operation public.billing_provider_operations%ROWTYPE;
    v_request public.billing_payer_setup_requests%ROWTYPE;
    v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
    SELECT * INTO v_operation FROM public.billing_provider_operations WHERE id = p_operation_id FOR UPDATE;
    PERFORM 1 FROM public.billing_payers WHERE id = p_payer_id AND studio_id = p_studio_id FOR UPDATE;
    SELECT * INTO v_request FROM public.billing_payer_setup_requests WHERE id = p_setup_request_id FOR UPDATE;
    IF NOT FOUND OR v_operation.id IS NULL OR v_request.operation_id IS DISTINCT FROM p_operation_id
       OR v_request.studio_id IS DISTINCT FROM p_studio_id OR v_request.payer_id IS DISTINCT FROM p_payer_id
       OR v_request.stripe_connected_account_id IS DISTINCT FROM p_stripe_connected_account_id
       OR v_request.connect_account_generation IS DISTINCT FROM p_connect_account_generation
       OR v_operation.operation_type <> 'payer.setup'
       OR v_operation.provider_object_id IS DISTINCT FROM p_stripe_checkout_session_id
       OR v_operation.state NOT IN ('provider_succeeded', 'projected', 'completed') THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'billing_payer_setup_session_identity_mismatch';
    END IF;
    IF v_request.stripe_checkout_session_id = p_stripe_checkout_session_id THEN
        RETURN private.billing_payer_setup_request_json_v1(v_request, 'replay');
    END IF;
    IF v_request.stripe_checkout_session_id IS NOT NULL OR v_request.revision <> p_expected_setup_revision THEN
        RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'billing_payer_setup_session_stale_revision';
    END IF;
    UPDATE public.billing_payer_setup_requests
    SET stripe_checkout_session_id = p_stripe_checkout_session_id,
        revision = revision + 1, updated_at = v_now
    WHERE id = v_request.id RETURNING * INTO v_request;
    RETURN private.billing_payer_setup_request_json_v1(v_request, 'bound');
END;
$$;

CREATE FUNCTION public.read_billing_payer_setup_request_v1(
    p_setup_request_id UUID, p_studio_id UUID, p_payer_id UUID,
    p_stripe_connected_account_id TEXT, p_connect_account_generation INTEGER
)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_request public.billing_payer_setup_requests%ROWTYPE;
BEGIN
    SELECT * INTO v_request FROM public.billing_payer_setup_requests WHERE id = p_setup_request_id;
    IF NOT FOUND OR v_request.studio_id IS DISTINCT FROM p_studio_id
       OR v_request.payer_id IS DISTINCT FROM p_payer_id
       OR v_request.stripe_connected_account_id IS DISTINCT FROM p_stripe_connected_account_id
       OR v_request.connect_account_generation IS DISTINCT FROM p_connect_account_generation THEN
        RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'billing_payer_setup_request_not_found';
    END IF;
    RETURN private.billing_payer_setup_request_json_v1(v_request, 'read');
END;
$$;

CREATE FUNCTION public.read_billing_payer_setup_webhook_v1(
    p_setup_request_id UUID, p_stripe_checkout_session_id TEXT,
    p_stripe_connected_account_id TEXT, p_connect_account_generation INTEGER
)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_request public.billing_payer_setup_requests%ROWTYPE;
    v_operation public.billing_provider_operations%ROWTYPE;
BEGIN
    SELECT * INTO v_request FROM public.billing_payer_setup_requests WHERE id = p_setup_request_id;
    IF NOT FOUND OR v_request.stripe_checkout_session_id IS DISTINCT FROM p_stripe_checkout_session_id
       OR v_request.stripe_connected_account_id IS DISTINCT FROM p_stripe_connected_account_id
       OR v_request.connect_account_generation IS DISTINCT FROM p_connect_account_generation THEN
        RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'billing_payer_setup_webhook_not_found';
    END IF;
    SELECT * INTO v_operation FROM public.billing_provider_operations WHERE id = v_request.operation_id;
    IF NOT FOUND OR v_operation.operation_type <> 'payer.setup'
       OR v_operation.provider_object_id IS DISTINCT FROM p_stripe_checkout_session_id THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'billing_payer_setup_webhook_operation_mismatch';
    END IF;
    RETURN private.billing_payer_setup_request_json_v1(v_request, 'read') || jsonb_build_object(
        'operation', jsonb_build_object(
            'id', v_operation.id, 'state', v_operation.state,
            'operation_type', v_operation.operation_type,
            'provider_object_id', v_operation.provider_object_id,
            'provider_secondary_object_id', v_operation.provider_secondary_object_id,
            'revision', v_operation.revision
        )
    );
END;
$$;

CREATE FUNCTION public.accept_billing_payer_payment_consent_v1(
    p_setup_request_id UUID, p_studio_id UUID, p_payer_id UUID, p_terms_version TEXT,
    p_stripe_checkout_session_id TEXT, p_stripe_connected_account_id TEXT,
    p_connect_account_generation INTEGER, p_acceptance_proof_sha256 TEXT,
    p_accepted_at TIMESTAMPTZ
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_operation_id UUID;
    v_operation public.billing_provider_operations%ROWTYPE;
    v_request public.billing_payer_setup_requests%ROWTYPE;
    v_consent public.billing_payer_payment_consents%ROWTYPE;
    v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
    SELECT operation_id INTO v_operation_id FROM public.billing_payer_setup_requests WHERE id = p_setup_request_id;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'billing_payer_setup_request_not_found'; END IF;
    SELECT * INTO v_operation FROM public.billing_provider_operations WHERE id = v_operation_id FOR UPDATE;
    PERFORM 1 FROM public.billing_payers WHERE id = p_payer_id AND studio_id = p_studio_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'billing_payer_consent_tenant_mismatch'; END IF;
    SELECT * INTO v_request FROM public.billing_payer_setup_requests WHERE id = p_setup_request_id FOR UPDATE;
    IF v_operation.id IS NULL OR v_operation.operation_type <> 'payer.setup'
       OR v_operation.state NOT IN ('provider_succeeded', 'projected', 'completed', 'reconciliation_required')
       OR v_operation.provider_object_id IS DISTINCT FROM p_stripe_checkout_session_id
       OR v_operation.stripe_connected_account_id IS DISTINCT FROM p_stripe_connected_account_id
       OR v_operation.connect_account_generation IS DISTINCT FROM p_connect_account_generation
       OR v_request.studio_id IS DISTINCT FROM p_studio_id OR v_request.payer_id IS DISTINCT FROM p_payer_id
       OR v_request.terms_version IS DISTINCT FROM p_terms_version
       OR v_request.stripe_checkout_session_id IS DISTINCT FROM p_stripe_checkout_session_id
       OR v_request.stripe_connected_account_id IS DISTINCT FROM p_stripe_connected_account_id
       OR v_request.connect_account_generation IS DISTINCT FROM p_connect_account_generation
       OR v_request.completed_at IS NOT NULL OR v_request.revoked_at IS NOT NULL OR v_request.superseded_at IS NOT NULL
       OR p_accepted_at < v_request.created_at OR p_accepted_at > v_request.setup_request_expires_at
       OR p_accepted_at > v_now + interval '5 minutes'
       OR p_acceptance_proof_sha256 !~ '^[0-9a-f]{64}$' THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'billing_payer_consent_acceptance_invalid';
    END IF;
    INSERT INTO public.billing_payer_payment_consents (
        setup_request_id, studio_id, payer_id, terms_version,
        stripe_checkout_session_id, stripe_connected_account_id,
        connect_account_generation, acceptance_proof_sha256,
        accepted_at, setup_request_expires_at, created_at, updated_at
    ) VALUES (
        p_setup_request_id, p_studio_id, p_payer_id, p_terms_version,
        p_stripe_checkout_session_id, p_stripe_connected_account_id,
        p_connect_account_generation, p_acceptance_proof_sha256,
        p_accepted_at, v_request.setup_request_expires_at, v_now, v_now
    ) ON CONFLICT (setup_request_id) DO NOTHING RETURNING * INTO v_consent;
    IF NOT FOUND THEN
        SELECT * INTO v_consent FROM public.billing_payer_payment_consents WHERE setup_request_id = p_setup_request_id;
        IF v_consent.acceptance_proof_sha256 IS DISTINCT FROM p_acceptance_proof_sha256
           OR v_consent.accepted_at IS DISTINCT FROM p_accepted_at THEN
            RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'billing_payer_consent_acceptance_conflict';
        END IF;
        RETURN private.billing_payer_payment_consent_json_v1(v_consent, 'replay');
    END IF;
    UPDATE public.billing_payer_setup_requests SET accepted_at = p_accepted_at,
        revision = revision + 1, updated_at = v_now WHERE id = p_setup_request_id;
    RETURN private.billing_payer_payment_consent_json_v1(v_consent, 'accepted');
END;
$$;

CREATE FUNCTION public.complete_billing_payer_payment_consent_v1(
    p_consent_id UUID, p_setup_request_id UUID, p_operation_id UUID,
    p_stripe_checkout_session_id TEXT, p_stripe_setup_intent_id TEXT,
    p_stripe_connected_account_id TEXT, p_connect_account_generation INTEGER,
    p_completed_at TIMESTAMPTZ
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_operation public.billing_provider_operations%ROWTYPE;
    v_request public.billing_payer_setup_requests%ROWTYPE;
    v_consent public.billing_payer_payment_consents%ROWTYPE;
    v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
    SELECT * INTO v_operation FROM public.billing_provider_operations WHERE id = p_operation_id FOR UPDATE;
    SELECT * INTO v_request FROM public.billing_payer_setup_requests WHERE id = p_setup_request_id;
    PERFORM 1 FROM public.billing_payers
    WHERE id = v_request.payer_id AND studio_id = v_request.studio_id FOR UPDATE;
    SELECT * INTO v_request FROM public.billing_payer_setup_requests WHERE id = p_setup_request_id FOR UPDATE;
    PERFORM 1 FROM public.billing_payer_payment_consents AS locked_consent
    WHERE locked_consent.studio_id = v_request.studio_id
      AND locked_consent.payer_id = v_request.payer_id
      AND locked_consent.stripe_connected_account_id = p_stripe_connected_account_id
      AND locked_consent.connect_account_generation = p_connect_account_generation
    ORDER BY locked_consent.id FOR UPDATE;
    SELECT * INTO v_consent FROM public.billing_payer_payment_consents WHERE id = p_consent_id FOR UPDATE;
    IF v_operation.id IS NULL OR v_request.id IS NULL OR v_consent.id IS NULL
       OR v_request.operation_id IS DISTINCT FROM p_operation_id
       OR v_consent.setup_request_id IS DISTINCT FROM p_setup_request_id
       OR v_operation.operation_type <> 'payer.setup'
       OR v_operation.state NOT IN ('provider_succeeded', 'reconciliation_required', 'projected')
       OR v_operation.provider_object_id IS DISTINCT FROM p_stripe_checkout_session_id
       OR v_request.stripe_checkout_session_id IS DISTINCT FROM p_stripe_checkout_session_id
       OR v_consent.stripe_checkout_session_id IS DISTINCT FROM p_stripe_checkout_session_id
       OR v_request.stripe_connected_account_id IS DISTINCT FROM p_stripe_connected_account_id
       OR v_consent.stripe_connected_account_id IS DISTINCT FROM p_stripe_connected_account_id
       OR v_request.connect_account_generation IS DISTINCT FROM p_connect_account_generation
       OR v_consent.connect_account_generation IS DISTINCT FROM p_connect_account_generation
       OR v_request.revoked_at IS NOT NULL OR v_request.superseded_at IS NOT NULL
       OR v_consent.revoked_at IS NOT NULL OR v_consent.superseded_at IS NOT NULL
       OR p_completed_at < v_consent.accepted_at OR p_completed_at > v_now + interval '5 minutes'
       OR octet_length(p_stripe_setup_intent_id) NOT BETWEEN 1 AND 255 THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'billing_payer_consent_completion_invalid';
    END IF;
    IF v_operation.state = 'projected' THEN
        IF v_operation.provider_secondary_object_id IS DISTINCT FROM p_stripe_setup_intent_id
           OR v_consent.completed_at IS NULL
           OR v_consent.stripe_setup_intent_id IS DISTINCT FROM p_stripe_setup_intent_id THEN
            RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'billing_payer_consent_completion_conflict';
        END IF;
        RETURN private.billing_payer_payment_consent_json_v1(v_consent, 'replay')
            || jsonb_build_object('operation', (private.billing_provider_operation_json_v1(v_operation, 'replay')->'operation'));
    END IF;

    UPDATE public.billing_payer_payment_consents
    SET superseded_at = p_completed_at,
        revision = revision + 1,
        updated_at = v_now
    WHERE studio_id = v_consent.studio_id
      AND payer_id = v_consent.payer_id
      AND stripe_connected_account_id = p_stripe_connected_account_id
      AND connect_account_generation = p_connect_account_generation
      AND id <> v_consent.id
      AND completed_at IS NOT NULL
      AND revoked_at IS NULL
      AND superseded_at IS NULL;

    UPDATE public.billing_payer_payment_consents
    SET stripe_setup_intent_id = p_stripe_setup_intent_id,
        completed_at = p_completed_at,
        revision = revision + 1,
        updated_at = v_now
    WHERE id = v_consent.id RETURNING * INTO v_consent;
    UPDATE public.billing_payer_setup_requests
    SET stripe_setup_intent_id = p_stripe_setup_intent_id,
        completed_at = p_completed_at,
        revision = revision + 1,
        updated_at = v_now
    WHERE id = v_request.id;
    UPDATE public.billing_provider_operations
    SET state = 'projected',
        provider_secondary_object_id = p_stripe_setup_intent_id,
        projected_at = COALESCE(projected_at, p_completed_at),
        reconciliation_reason_code = NULL,
        lease_owner = NULL, lease_acquired_at = NULL, lease_expires_at = NULL,
        revision = revision + 1, updated_at = v_now
    WHERE id = v_operation.id RETURNING * INTO v_operation;
    RETURN private.billing_payer_payment_consent_json_v1(v_consent, 'completed')
        || jsonb_build_object('operation', (private.billing_provider_operation_json_v1(v_operation, 'projected')->'operation'));
END;
$$;

CREATE FUNCTION public.finalize_billing_payer_setup_projection_v1(
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
    SELECT * INTO v_operation FROM public.billing_provider_operations WHERE id = p_operation_id FOR UPDATE;
    SELECT * INTO v_payer FROM public.billing_payers
    WHERE id = p_payer_id AND studio_id = p_studio_id FOR UPDATE;
    SELECT * INTO v_request FROM public.billing_payer_setup_requests WHERE id = p_setup_request_id FOR UPDATE;
    PERFORM 1 FROM public.billing_payer_payment_consents AS locked_consent
    WHERE locked_consent.studio_id = p_studio_id AND locked_consent.payer_id = p_payer_id
      AND locked_consent.stripe_connected_account_id = p_stripe_connected_account_id
      AND locked_consent.connect_account_generation = p_connect_account_generation
    ORDER BY locked_consent.id FOR UPDATE;
    SELECT * INTO v_consent FROM public.billing_payer_payment_consents WHERE id = p_consent_id;
    IF v_payer.id IS NULL OR v_operation.id IS NULL OR v_request.id IS NULL OR v_consent.id IS NULL
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
       OR v_request.payer_id IS DISTINCT FROM p_payer_id OR v_consent.payer_id IS DISTINCT FROM p_payer_id
       OR v_operation.stripe_connected_account_id IS DISTINCT FROM p_stripe_connected_account_id
       OR v_request.stripe_connected_account_id IS DISTINCT FROM p_stripe_connected_account_id
       OR v_consent.stripe_connected_account_id IS DISTINCT FROM p_stripe_connected_account_id
       OR v_operation.connect_account_generation IS DISTINCT FROM p_connect_account_generation
       OR v_request.connect_account_generation IS DISTINCT FROM p_connect_account_generation
       OR v_consent.connect_account_generation IS DISTINCT FROM p_connect_account_generation
       OR v_request.completed_at IS NULL OR v_consent.completed_at IS NULL
       OR v_consent.revoked_at IS NOT NULL OR v_consent.superseded_at IS NOT NULL THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'billing_payer_setup_projection_identity_mismatch';
    END IF;
    IF v_operation.state = 'completed' THEN
        RETURN private.billing_payer_payment_consent_json_v1(v_consent, 'replay')
            || jsonb_build_object(
                'setup_request', to_jsonb(v_request),
                'operation', private.billing_provider_operation_json_v1(v_operation, 'replay')->'operation'
            );
    END IF;
    IF v_operation.state <> 'projected'
       OR v_payer.stripe_account_id IS DISTINCT FROM p_stripe_connected_account_id
       OR v_payer.default_payment_method_id IS NULL
       OR v_payer.autopay_status <> 'enabled'
       OR v_payer.autopay_authorized_at IS DISTINCT FROM v_consent.completed_at
       OR v_payer.autopay_terms_accepted_at IS DISTINCT FROM v_consent.accepted_at THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'billing_payer_setup_projection_not_converged';
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

CREATE FUNCTION public.mark_billing_payer_setup_reconciliation_v1(
    p_setup_request_id UUID, p_operation_id UUID,
    p_stripe_checkout_session_id TEXT, p_stripe_setup_intent_id TEXT,
    p_stripe_connected_account_id TEXT, p_connect_account_generation INTEGER,
    p_reconciliation_reason_code TEXT
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_operation public.billing_provider_operations%ROWTYPE;
    v_request public.billing_payer_setup_requests%ROWTYPE;
    v_payer public.billing_payers%ROWTYPE;
    v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
    SELECT * INTO v_operation FROM public.billing_provider_operations WHERE id = p_operation_id FOR UPDATE;
    SELECT * INTO v_request FROM public.billing_payer_setup_requests WHERE id = p_setup_request_id;
    SELECT * INTO v_payer FROM public.billing_payers
    WHERE id = v_request.payer_id AND studio_id = v_request.studio_id FOR UPDATE;
    SELECT * INTO v_request FROM public.billing_payer_setup_requests WHERE id = p_setup_request_id FOR UPDATE;
    IF v_operation.id IS NULL OR v_request.id IS NULL OR v_payer.id IS NULL
       OR v_request.operation_id IS DISTINCT FROM p_operation_id
       OR v_operation.operation_type <> 'payer.setup'
       OR v_operation.state NOT IN (
            'provider_succeeded', 'projected', 'completed', 'reconciliation_required'
       )
       OR v_operation.studio_id IS DISTINCT FROM v_request.studio_id
       OR v_payer.studio_id IS DISTINCT FROM v_request.studio_id
       OR v_operation.provider_object_id IS DISTINCT FROM p_stripe_checkout_session_id
       OR (
            v_request.stripe_checkout_session_id IS NOT NULL
            AND v_request.stripe_checkout_session_id IS DISTINCT FROM p_stripe_checkout_session_id
       )
       OR v_operation.stripe_connected_account_id IS DISTINCT FROM p_stripe_connected_account_id
       OR v_request.stripe_connected_account_id IS DISTINCT FROM p_stripe_connected_account_id
       OR v_operation.connect_account_generation IS DISTINCT FROM p_connect_account_generation
       OR v_request.connect_account_generation IS DISTINCT FROM p_connect_account_generation
       OR octet_length(p_stripe_checkout_session_id) NOT BETWEEN 1 AND 255
       OR (
            p_stripe_setup_intent_id IS NOT NULL
            AND (
                (v_operation.provider_secondary_object_id IS NOT NULL
                    AND v_operation.provider_secondary_object_id IS DISTINCT FROM p_stripe_setup_intent_id)
                OR (v_request.stripe_setup_intent_id IS NOT NULL
                    AND v_request.stripe_setup_intent_id IS DISTINCT FROM p_stripe_setup_intent_id)
            )
       )
       OR p_reconciliation_reason_code IS NULL
       OR octet_length(p_reconciliation_reason_code) NOT BETWEEN 1 AND 128
       OR p_reconciliation_reason_code !~ '^[a-z0-9][a-z0-9_.:-]{0,127}$' THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'billing_payer_setup_reconciliation_invalid';
    END IF;
    IF v_request.stripe_checkout_session_id IS NULL
       OR (p_stripe_setup_intent_id IS NOT NULL AND v_request.stripe_setup_intent_id IS NULL) THEN
        UPDATE public.billing_payer_setup_requests
        SET stripe_checkout_session_id = COALESCE(stripe_checkout_session_id, p_stripe_checkout_session_id),
            stripe_setup_intent_id = COALESCE(stripe_setup_intent_id, p_stripe_setup_intent_id),
            revision = revision + 1,
            updated_at = v_now
        WHERE id = v_request.id
        RETURNING * INTO v_request;
    END IF;
    IF v_operation.state = 'reconciliation_required' THEN
        IF v_operation.reconciliation_reason_code IS DISTINCT FROM p_reconciliation_reason_code
           OR (p_stripe_setup_intent_id IS NOT NULL
               AND v_operation.provider_secondary_object_id IS DISTINCT FROM p_stripe_setup_intent_id) THEN
            RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'billing_payer_setup_reconciliation_conflict';
        END IF;
        RETURN private.billing_provider_operation_json_v1(v_operation, 'replay');
    END IF;
    UPDATE public.billing_provider_operations
    SET state = 'reconciliation_required',
        provider_secondary_object_id = COALESCE(p_stripe_setup_intent_id, provider_secondary_object_id),
        reconciliation_reason_code = p_reconciliation_reason_code,
        reconciliation_required_at = v_now,
        completed_at = NULL,
        lease_owner = NULL, lease_acquired_at = NULL, lease_expires_at = NULL,
        revision = revision + 1, updated_at = v_now
    WHERE id = v_operation.id RETURNING * INTO v_operation;
    RETURN private.billing_provider_operation_json_v1(v_operation, 'reconciliation_required');
END;
$$;

CREATE FUNCTION public.close_billing_payer_setup_request_v1(
    p_setup_request_id UUID,
    p_operation_id UUID,
    p_studio_id UUID,
    p_payer_id UUID,
    p_stripe_checkout_session_id TEXT,
    p_stripe_connected_account_id TEXT,
    p_connect_account_generation INTEGER,
    p_close_reason_code TEXT,
    p_provider_read_proof_sha256 TEXT
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_operation public.billing_provider_operations%ROWTYPE;
    v_request public.billing_payer_setup_requests%ROWTYPE;
    v_payer public.billing_payers%ROWTYPE;
    v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
    SELECT * INTO v_operation
    FROM public.billing_provider_operations
    WHERE id = p_operation_id
    FOR UPDATE;
    SELECT * INTO v_payer
    FROM public.billing_payers
    WHERE id = p_payer_id AND studio_id = p_studio_id
    FOR UPDATE;
    SELECT * INTO v_request
    FROM public.billing_payer_setup_requests
    WHERE id = p_setup_request_id
    FOR UPDATE;
    PERFORM 1
    FROM public.billing_payer_payment_consents AS locked_consent
    WHERE locked_consent.studio_id = p_studio_id
      AND locked_consent.payer_id = p_payer_id
      AND locked_consent.stripe_connected_account_id = p_stripe_connected_account_id
      AND locked_consent.connect_account_generation = p_connect_account_generation
      AND locked_consent.completed_at IS NULL
      AND locked_consent.revoked_at IS NULL
      AND locked_consent.superseded_at IS NULL
    ORDER BY locked_consent.id
    FOR UPDATE;

    IF v_operation.id IS NULL OR v_request.id IS NULL OR v_payer.id IS NULL
       OR v_request.operation_id IS DISTINCT FROM p_operation_id
       OR v_operation.operation_type <> 'payer.setup'
       OR v_operation.studio_id IS DISTINCT FROM p_studio_id
       OR v_request.studio_id IS DISTINCT FROM p_studio_id
       OR v_request.payer_id IS DISTINCT FROM p_payer_id
       OR v_operation.stripe_connected_account_id IS DISTINCT FROM p_stripe_connected_account_id
       OR v_request.stripe_connected_account_id IS DISTINCT FROM p_stripe_connected_account_id
       OR v_operation.connect_account_generation IS DISTINCT FROM p_connect_account_generation
       OR v_request.connect_account_generation IS DISTINCT FROM p_connect_account_generation
       OR p_stripe_checkout_session_id IS NULL
       OR octet_length(p_stripe_checkout_session_id) NOT BETWEEN 1 AND 255
       OR v_operation.provider_object_id IS DISTINCT FROM p_stripe_checkout_session_id
       OR v_request.stripe_checkout_session_id IS DISTINCT FROM p_stripe_checkout_session_id
       OR p_close_reason_code IS NULL
       OR p_close_reason_code NOT IN (
            'checkout_session_expired',
            'checkout_session_terminal_unusable'
       )
       OR p_provider_read_proof_sha256 IS NULL
       OR p_provider_read_proof_sha256 !~ '^[0-9a-f]{64}$' THEN
        RAISE EXCEPTION USING ERRCODE = '23514',
            MESSAGE = 'billing_payer_setup_close_invalid';
    END IF;

    IF v_request.closed_at IS NOT NULL THEN
        IF v_request.close_reason_code IS DISTINCT FROM p_close_reason_code
           OR v_request.provider_read_proof_sha256 IS DISTINCT FROM p_provider_read_proof_sha256
           OR v_request.superseded_at IS DISTINCT FROM v_request.closed_at
           OR v_operation.state <> 'definitive_rejected'
           OR v_operation.error_code <> 'payer_setup_session_closed'
           OR v_operation.error_summary IS DISTINCT FROM p_close_reason_code THEN
            RAISE EXCEPTION USING ERRCODE = '23505',
                MESSAGE = 'billing_payer_setup_close_conflict';
        END IF;
        RETURN private.billing_payer_setup_request_json_v1(v_request, 'replay')
            || jsonb_build_object(
                'operation', private.billing_provider_operation_json_v1(
                    v_operation,
                    'replay'
                )->'operation'
            );
    END IF;

    IF v_operation.state NOT IN ('provider_succeeded', 'reconciliation_required')
       OR v_operation.provider_request_attempt_count NOT BETWEEN 1 AND 2
       OR v_request.completed_at IS NOT NULL
       OR v_request.revoked_at IS NOT NULL
       OR v_request.superseded_at IS NOT NULL
       OR EXISTS (
            SELECT 1
            FROM public.billing_payer_payment_consents AS consent
            WHERE consent.setup_request_id = p_setup_request_id
              AND consent.completed_at IS NOT NULL
       ) THEN
        RAISE EXCEPTION USING ERRCODE = '23514',
            MESSAGE = 'billing_payer_setup_close_invalid';
    END IF;

    UPDATE public.billing_payer_payment_consents
    SET superseded_at = v_now,
        revision = revision + 1,
        updated_at = v_now
    WHERE setup_request_id = p_setup_request_id
      AND completed_at IS NULL
      AND revoked_at IS NULL
      AND superseded_at IS NULL;

    UPDATE public.billing_payer_setup_requests
    SET superseded_at = v_now,
        closed_at = v_now,
        close_reason_code = p_close_reason_code,
        provider_read_proof_sha256 = p_provider_read_proof_sha256,
        revision = revision + 1,
        updated_at = v_now
    WHERE id = p_setup_request_id
    RETURNING * INTO v_request;

    UPDATE public.billing_provider_operations
    SET state = 'definitive_rejected',
        error_code = 'payer_setup_session_closed',
        error_summary = p_close_reason_code,
        reconciliation_reason_code = NULL,
        completed_at = NULL,
        definitive_rejected_at = v_now,
        lease_owner = NULL,
        lease_acquired_at = NULL,
        lease_expires_at = NULL,
        revision = revision + 1,
        updated_at = v_now
    WHERE id = p_operation_id
    RETURNING * INTO v_operation;

    RETURN private.billing_payer_setup_request_json_v1(v_request, 'closed')
        || jsonb_build_object(
            'operation', private.billing_provider_operation_json_v1(
                v_operation,
                'definitive_rejected'
            )->'operation'
        );
END;
$$;

CREATE FUNCTION public.read_active_billing_payer_payment_consent_v1(
    p_studio_id UUID, p_payer_id UUID, p_terms_version TEXT,
    p_stripe_connected_account_id TEXT, p_connect_account_generation INTEGER
)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_consent public.billing_payer_payment_consents%ROWTYPE;
BEGIN
    SELECT * INTO v_consent FROM public.billing_payer_payment_consents
    WHERE studio_id = p_studio_id AND payer_id = p_payer_id
      AND terms_version = p_terms_version
      AND stripe_connected_account_id = p_stripe_connected_account_id
      AND connect_account_generation = p_connect_account_generation
      AND completed_at IS NOT NULL AND revoked_at IS NULL AND superseded_at IS NULL;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'billing_payer_active_consent_not_found'; END IF;
    RETURN private.billing_payer_payment_consent_json_v1(v_consent, 'read');
END;
$$;

CREATE FUNCTION public.revoke_billing_payer_payment_consent_v1(
    p_consent_id UUID, p_studio_id UUID, p_payer_id UUID,
    p_stripe_connected_account_id TEXT, p_connect_account_generation INTEGER,
    p_revoked_at TIMESTAMPTZ, p_revoked_by UUID,
    p_revocation_reason_code TEXT, p_revocation_proof_sha256 TEXT DEFAULT NULL
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_operation_id UUID;
    v_consent public.billing_payer_payment_consents%ROWTYPE;
    v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
    SELECT request.operation_id INTO v_operation_id
    FROM public.billing_payer_payment_consents consent
    JOIN public.billing_payer_setup_requests request ON request.id = consent.setup_request_id
    WHERE consent.id = p_consent_id;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'billing_payer_consent_not_found'; END IF;
    PERFORM 1 FROM public.billing_provider_operations WHERE id = v_operation_id FOR UPDATE;
    PERFORM 1 FROM public.billing_payers WHERE id = p_payer_id AND studio_id = p_studio_id FOR UPDATE;
    SELECT * INTO v_consent FROM public.billing_payer_payment_consents WHERE id = p_consent_id FOR UPDATE;
    IF v_consent.studio_id IS DISTINCT FROM p_studio_id OR v_consent.payer_id IS DISTINCT FROM p_payer_id
       OR v_consent.stripe_connected_account_id IS DISTINCT FROM p_stripe_connected_account_id
       OR v_consent.connect_account_generation IS DISTINCT FROM p_connect_account_generation
       OR v_consent.superseded_at IS NOT NULL OR p_revoked_at < v_consent.accepted_at
       OR p_revoked_at > v_now + interval '5 minutes'
       OR p_revocation_reason_code !~ '^[a-z0-9][a-z0-9_.:-]{0,127}$'
       OR ((p_revoked_by IS NOT NULL)::INTEGER + (p_revocation_proof_sha256 IS NOT NULL)::INTEGER) <> 1
       OR (p_revocation_proof_sha256 IS NOT NULL AND p_revocation_proof_sha256 !~ '^[0-9a-f]{64}$') THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'billing_payer_consent_revocation_invalid';
    END IF;
    IF p_revoked_by IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.staff_roles AS membership
        WHERE membership.studio_id = p_studio_id AND membership.user_id = p_revoked_by
          AND membership.archived_at IS NULL AND membership.role IN ('admin', 'front_desk')
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'billing_payer_consent_revocation_actor_invalid';
    END IF;
    IF v_consent.revoked_at IS NOT NULL THEN
        IF v_consent.revoked_at IS DISTINCT FROM p_revoked_at
           OR v_consent.revoked_by IS DISTINCT FROM p_revoked_by
           OR v_consent.revocation_reason_code IS DISTINCT FROM p_revocation_reason_code
           OR v_consent.revocation_proof_sha256 IS DISTINCT FROM p_revocation_proof_sha256 THEN
            RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'billing_payer_consent_revocation_conflict';
        END IF;
        RETURN private.billing_payer_payment_consent_json_v1(v_consent, 'replay');
    END IF;
    UPDATE public.billing_payer_payment_consents
    SET revoked_at = p_revoked_at, revoked_by = p_revoked_by,
        revocation_reason_code = p_revocation_reason_code,
        revocation_proof_sha256 = p_revocation_proof_sha256,
        revision = revision + 1, updated_at = v_now
    WHERE id = v_consent.id RETURNING * INTO v_consent;
    UPDATE public.billing_payer_setup_requests
    SET revoked_at = p_revoked_at, revision = revision + 1, updated_at = v_now
    WHERE id = v_consent.setup_request_id AND revoked_at IS NULL AND superseded_at IS NULL;
    RETURN private.billing_payer_payment_consent_json_v1(v_consent, 'revoked');
END;
$$;

ALTER FUNCTION public.prepare_billing_payer_setup_request_v1(UUID, UUID, UUID, UUID, UUID, TEXT, TEXT, INTEGER, UUID, BIGINT, TIMESTAMPTZ) OWNER TO postgres;
ALTER FUNCTION public.bind_billing_payer_setup_session_v1(UUID, UUID, UUID, UUID, TEXT, TEXT, INTEGER, BIGINT) OWNER TO postgres;
ALTER FUNCTION public.read_billing_payer_setup_request_v1(UUID, UUID, UUID, TEXT, INTEGER) OWNER TO postgres;
ALTER FUNCTION public.read_billing_payer_setup_webhook_v1(UUID, TEXT, TEXT, INTEGER) OWNER TO postgres;
ALTER FUNCTION public.accept_billing_payer_payment_consent_v1(UUID, UUID, UUID, TEXT, TEXT, TEXT, INTEGER, TEXT, TIMESTAMPTZ) OWNER TO postgres;
ALTER FUNCTION public.complete_billing_payer_payment_consent_v1(UUID, UUID, UUID, TEXT, TEXT, TEXT, INTEGER, TIMESTAMPTZ) OWNER TO postgres;
ALTER FUNCTION public.finalize_billing_payer_setup_projection_v1(UUID, UUID, UUID, UUID, UUID, TEXT, TEXT, TEXT, INTEGER) OWNER TO postgres;
ALTER FUNCTION public.mark_billing_payer_setup_reconciliation_v1(UUID, UUID, TEXT, TEXT, TEXT, INTEGER, TEXT) OWNER TO postgres;
ALTER FUNCTION public.close_billing_payer_setup_request_v1(UUID, UUID, UUID, UUID, TEXT, TEXT, INTEGER, TEXT, TEXT) OWNER TO postgres;
ALTER FUNCTION public.read_active_billing_payer_payment_consent_v1(UUID, UUID, TEXT, TEXT, INTEGER) OWNER TO postgres;
ALTER FUNCTION public.revoke_billing_payer_payment_consent_v1(UUID, UUID, UUID, TEXT, INTEGER, TIMESTAMPTZ, UUID, TEXT, TEXT) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.prepare_billing_payer_setup_request_v1(UUID, UUID, UUID, UUID, UUID, TEXT, TEXT, INTEGER, UUID, BIGINT, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.bind_billing_payer_setup_session_v1(UUID, UUID, UUID, UUID, TEXT, TEXT, INTEGER, BIGINT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.read_billing_payer_setup_request_v1(UUID, UUID, UUID, TEXT, INTEGER) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.read_billing_payer_setup_webhook_v1(UUID, TEXT, TEXT, INTEGER) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.accept_billing_payer_payment_consent_v1(UUID, UUID, UUID, TEXT, TEXT, TEXT, INTEGER, TEXT, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.complete_billing_payer_payment_consent_v1(UUID, UUID, UUID, TEXT, TEXT, TEXT, INTEGER, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.finalize_billing_payer_setup_projection_v1(UUID, UUID, UUID, UUID, UUID, TEXT, TEXT, TEXT, INTEGER) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.mark_billing_payer_setup_reconciliation_v1(UUID, UUID, TEXT, TEXT, TEXT, INTEGER, TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.close_billing_payer_setup_request_v1(UUID, UUID, UUID, UUID, TEXT, TEXT, INTEGER, TEXT, TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.read_active_billing_payer_payment_consent_v1(UUID, UUID, TEXT, TEXT, INTEGER) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.revoke_billing_payer_payment_consent_v1(UUID, UUID, UUID, TEXT, INTEGER, TIMESTAMPTZ, UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.prepare_billing_payer_setup_request_v1(UUID, UUID, UUID, UUID, UUID, TEXT, TEXT, INTEGER, UUID, BIGINT, TIMESTAMPTZ) TO service_role;
GRANT EXECUTE ON FUNCTION public.bind_billing_payer_setup_session_v1(UUID, UUID, UUID, UUID, TEXT, TEXT, INTEGER, BIGINT) TO service_role;
GRANT EXECUTE ON FUNCTION public.read_billing_payer_setup_request_v1(UUID, UUID, UUID, TEXT, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.read_billing_payer_setup_webhook_v1(UUID, TEXT, TEXT, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.accept_billing_payer_payment_consent_v1(UUID, UUID, UUID, TEXT, TEXT, TEXT, INTEGER, TEXT, TIMESTAMPTZ) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_billing_payer_payment_consent_v1(UUID, UUID, UUID, TEXT, TEXT, TEXT, INTEGER, TIMESTAMPTZ) TO service_role;
GRANT EXECUTE ON FUNCTION public.finalize_billing_payer_setup_projection_v1(UUID, UUID, UUID, UUID, UUID, TEXT, TEXT, TEXT, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_billing_payer_setup_reconciliation_v1(UUID, UUID, TEXT, TEXT, TEXT, INTEGER, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.close_billing_payer_setup_request_v1(UUID, UUID, UUID, UUID, TEXT, TEXT, INTEGER, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.read_active_billing_payer_payment_consent_v1(UUID, UUID, TEXT, TEXT, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.revoke_billing_payer_payment_consent_v1(UUID, UUID, UUID, TEXT, INTEGER, TIMESTAMPTZ, UUID, TEXT, TEXT) TO service_role;

COMMENT ON TABLE public.billing_provider_operations IS
    'Service-only idempotency, lease, outcome, and reconciliation ownership for one product billing workflow. It stores no provider payload, URL, card data, or secret.';
COMMENT ON TABLE public.billing_payer_setup_requests IS
    'Short-lived payer setup request. Checkout metadata carries only this row ID and its operation ID; the hosted URL and token are never stored.';
COMMENT ON TABLE public.billing_payer_payment_consents IS
    'Versioned payer-owned recurring-payment consent. Setup expiry bounds acceptance only; completed consent remains active until revoked or superseded.';

CREATE FUNCTION private.koaryu_release_provider_operations_manifest_v27()
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $manifest$
DECLARE
    v_invalid INTEGER := 0;
    v_serialized TEXT;
BEGIN
    WITH required_tables(schema_name, table_name) AS (
        VALUES
            ('public', 'billing_provider_operations'),
            ('public', 'billing_payer_setup_requests'),
            ('public', 'billing_payer_payment_consents')
    ),
    required_functions(signature, security_definer, service_execute) AS (
        VALUES
            ('public.claim_billing_provider_operation_v1(uuid,uuid,text,text,text,text,integer,uuid,integer)', true, true),
            ('public.read_billing_provider_operation_v1(uuid,uuid,uuid,text,text,text,text,integer)', true, true),
            ('public.transition_billing_provider_operation_v1(uuid,uuid,uuid,text,text,text,text,integer,uuid,bigint,text,text,text,text,text,text,text,text,text)', true, true),
            ('public.complete_billing_provider_operation_v1(uuid,uuid,uuid,text,text,text,text,integer,uuid,bigint,text,text)', true, true),
            ('public.authorize_billing_provider_operation_recovery_v1(uuid,uuid,uuid,text,text,text,text,integer,uuid,text,text,uuid,integer,bigint)', true, true),
            ('public.prepare_billing_payer_setup_request_v1(uuid,uuid,uuid,uuid,uuid,text,text,integer,uuid,bigint,timestamp with time zone)', true, true),
            ('public.bind_billing_payer_setup_session_v1(uuid,uuid,uuid,uuid,text,text,integer,bigint)', true, true),
            ('public.read_billing_payer_setup_request_v1(uuid,uuid,uuid,text,integer)', true, true),
            ('public.read_billing_payer_setup_webhook_v1(uuid,text,text,integer)', true, true),
            ('public.accept_billing_payer_payment_consent_v1(uuid,uuid,uuid,text,text,text,integer,text,timestamp with time zone)', true, true),
            ('public.complete_billing_payer_payment_consent_v1(uuid,uuid,uuid,text,text,text,integer,timestamp with time zone)', true, true),
            ('public.finalize_billing_payer_setup_projection_v1(uuid,uuid,uuid,uuid,uuid,text,text,text,integer)', true, true),
            ('public.mark_billing_payer_setup_reconciliation_v1(uuid,uuid,text,text,text,integer,text)', true, true),
            ('public.close_billing_payer_setup_request_v1(uuid,uuid,uuid,uuid,text,text,integer,text,text)', true, true),
            ('public.read_active_billing_payer_payment_consent_v1(uuid,uuid,text,text,integer)', true, true),
            ('public.revoke_billing_payer_payment_consent_v1(uuid,uuid,uuid,text,integer,timestamp with time zone,uuid,text,text)', true, true),
            ('private.billing_provider_operation_json_v1(public.billing_provider_operations,text)', false, false),
            ('private.preserve_billing_provider_operation_identity_v1()', false, false),
            ('private.billing_payer_setup_request_json_v1(public.billing_payer_setup_requests,text)', false, false),
            ('private.billing_payer_payment_consent_json_v1(public.billing_payer_payment_consents,text)', false, false),
            ('private.preserve_billing_payer_setup_request_v1()', false, false),
            ('private.preserve_billing_payer_payment_consent_v1()', false, false)
    ),
    relation_state AS (
        SELECT required.schema_name, required.table_name, relation.oid,
               owner.rolname AS owner_name, relation.relrowsecurity,
               COALESCE(array_to_string(relation.relacl, ','), '') AS acl_state
        FROM required_tables required
        LEFT JOIN pg_namespace namespace ON namespace.nspname = required.schema_name
        LEFT JOIN pg_class relation ON relation.relnamespace = namespace.oid
                                   AND relation.relname = required.table_name
                                   AND relation.relkind = 'r'
        LEFT JOIN pg_roles owner ON owner.oid = relation.relowner
    ),
    function_state AS (
        SELECT required.signature, required.security_definer, required.service_execute,
               procedure.oid, owner.rolname AS owner_name, procedure.prosecdef,
               COALESCE(array_to_string(procedure.proconfig, ','), '') AS configuration,
               has_function_privilege('service_role', procedure.oid, 'EXECUTE') AS actual_service_execute,
               has_function_privilege('anon', procedure.oid, 'EXECUTE') AS anon_execute,
               has_function_privilege('authenticated', procedure.oid, 'EXECUTE') AS authenticated_execute,
               EXISTS (
                   SELECT 1 FROM aclexplode(COALESCE(procedure.proacl, acldefault('f', procedure.proowner))) privilege
                   WHERE privilege.grantee = 0 AND privilege.privilege_type = 'EXECUTE'
               ) AS public_execute,
               COALESCE(pg_get_functiondef(procedure.oid), '') AS definition
        FROM required_functions required
        LEFT JOIN pg_proc procedure ON procedure.oid = to_regprocedure(required.signature)
        LEFT JOIN pg_roles owner ON owner.oid = procedure.proowner
    ),
    object_state AS (
        SELECT 'tables' AS category,
               string_agg(schema_name || '.' || table_name || ':' || COALESCE(owner_name, '') || ':' ||
                   COALESCE(relrowsecurity::TEXT, '') || ':' || acl_state,
                   '|' ORDER BY schema_name COLLATE "C", table_name COLLATE "C") AS value
        FROM relation_state
        UNION ALL
        SELECT 'columns', string_agg(
            namespace.nspname || '.' || relation.relname || '.' || attribute.attname || ':' ||
            format_type(attribute.atttypid, attribute.atttypmod) || ':' || attribute.attnotnull::TEXT || ':' ||
            COALESCE(pg_get_expr(default_value.adbin, default_value.adrelid), ''),
            '|' ORDER BY namespace.nspname COLLATE "C", relation.relname COLLATE "C", attribute.attnum)
        FROM pg_attribute attribute
        JOIN pg_class relation ON relation.oid = attribute.attrelid
        JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        JOIN required_tables required ON required.schema_name = namespace.nspname AND required.table_name = relation.relname
        LEFT JOIN pg_attrdef default_value ON default_value.adrelid = relation.oid AND default_value.adnum = attribute.attnum
        WHERE attribute.attnum > 0 AND NOT attribute.attisdropped
        UNION ALL
        SELECT 'constraints', string_agg(
            namespace.nspname || '.' || relation.relname || '.' || constraint_state.conname || ':' ||
            constraint_state.contype::TEXT || ':' || constraint_state.convalidated::TEXT || ':' ||
            pg_get_constraintdef(constraint_state.oid),
            '|' ORDER BY namespace.nspname COLLATE "C", relation.relname COLLATE "C", constraint_state.conname COLLATE "C")
        FROM pg_constraint constraint_state
        JOIN pg_class relation ON relation.oid = constraint_state.conrelid
        JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        JOIN required_tables required ON required.schema_name = namespace.nspname AND required.table_name = relation.relname
        UNION ALL
        SELECT 'indexes', string_agg(
            namespace.nspname || '.' || relation.relname || '.' || index_relation.relname || ':' ||
            index_state.indisvalid::TEXT || ':' || index_state.indisready::TEXT || ':' ||
            pg_get_indexdef(index_state.indexrelid),
            '|' ORDER BY namespace.nspname COLLATE "C", relation.relname COLLATE "C", index_relation.relname COLLATE "C")
        FROM pg_index index_state
        JOIN pg_class relation ON relation.oid = index_state.indrelid
        JOIN pg_class index_relation ON index_relation.oid = index_state.indexrelid
        JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        JOIN required_tables required ON required.schema_name = namespace.nspname AND required.table_name = relation.relname
        UNION ALL
        SELECT 'functions', string_agg(
            signature || ':' || COALESCE(owner_name, '') || ':' || COALESCE(prosecdef::TEXT, '') || ':' ||
            configuration || ':' || COALESCE(actual_service_execute::TEXT, '') || ':' ||
            encode(extensions.digest(convert_to(definition, 'UTF8'), 'sha256'), 'hex'),
            '|' ORDER BY signature COLLATE "C")
        FROM function_state
        UNION ALL
        SELECT 'triggers', string_agg(
            namespace.nspname || '.' || relation.relname || '.' || trigger.tgname || ':' ||
            trigger.tgenabled::TEXT || ':' || pg_get_triggerdef(trigger.oid),
            '|' ORDER BY namespace.nspname COLLATE "C", relation.relname COLLATE "C", trigger.tgname COLLATE "C")
        FROM pg_trigger trigger
        JOIN pg_class relation ON relation.oid = trigger.tgrelid
        JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        JOIN required_tables required ON required.schema_name = namespace.nspname AND required.table_name = relation.relname
        WHERE NOT trigger.tgisinternal
        UNION ALL
        SELECT 'policies', string_agg(
            namespace.nspname || '.' || relation.relname || '.' || policy.polname || ':' ||
            policy.polpermissive::TEXT || ':' || policy.polcmd::TEXT || ':' ||
            COALESCE(pg_get_expr(policy.polqual, policy.polrelid), '') || ':' ||
            COALESCE(pg_get_expr(policy.polwithcheck, policy.polrelid), ''),
            '|' ORDER BY namespace.nspname COLLATE "C", relation.relname COLLATE "C", policy.polname COLLATE "C")
        FROM pg_policy policy
        JOIN pg_class relation ON relation.oid = policy.polrelid
        JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        JOIN required_tables required ON required.schema_name = namespace.nspname AND required.table_name = relation.relname
    )
    SELECT
        (SELECT count(*) FILTER (
            WHERE oid IS NULL OR owner_name <> 'postgres' OR relrowsecurity IS DISTINCT FROM true
               OR has_table_privilege('service_role', oid, 'SELECT,INSERT,UPDATE,DELETE')
               OR has_table_privilege('anon', oid, 'SELECT,INSERT,UPDATE,DELETE')
               OR has_table_privilege('authenticated', oid, 'SELECT,INSERT,UPDATE,DELETE')
        ) FROM relation_state)
        + (SELECT count(*) FILTER (
            WHERE oid IS NULL OR owner_name <> 'postgres' OR prosecdef IS DISTINCT FROM security_definer
               OR configuration <> 'search_path=""'
               OR actual_service_execute IS DISTINCT FROM service_execute
               OR anon_execute OR authenticated_execute OR public_execute
        ) FROM function_state)
        + (SELECT abs(count(*) - 6) FROM pg_policy policy
           JOIN pg_class relation ON relation.oid = policy.polrelid
           JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
           JOIN required_tables required ON required.schema_name = namespace.nspname AND required.table_name = relation.relname)
        + (SELECT count(*) FROM pg_constraint constraint_state
           JOIN pg_class relation ON relation.oid = constraint_state.conrelid
           JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
           JOIN required_tables required ON required.schema_name = namespace.nspname AND required.table_name = relation.relname
           WHERE NOT constraint_state.convalidated),
        string_agg(category || '=' || COALESCE(value, ''), ';' ORDER BY category COLLATE "C")
    INTO v_invalid, v_serialized
    FROM object_state;

    RETURN v_invalid::TEXT || ':' || encode(
        extensions.digest(convert_to(COALESCE(v_serialized, ''), 'UTF8'), 'sha256'),
        'hex'
    );
END;
$manifest$;

ALTER FUNCTION private.koaryu_release_provider_operations_manifest_v27() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.koaryu_release_provider_operations_manifest_v27() FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION private.koaryu_release_operational_contract_v27()
RETURNS TEXT LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = pg_catalog SET TimeZone = 'UTC' AS $$
    SELECT '0:' || encode(
        extensions.digest(
            convert_to(
                private.koaryu_release_operational_contract_v26() || '|' ||
                private.koaryu_release_provider_operations_manifest_v27(),
                'UTF8'
            ),
            'sha256'
        ),
        'hex'
    );
$$;
ALTER FUNCTION private.koaryu_release_operational_contract_v27() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.koaryu_release_operational_contract_v27() FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE private.koaryu_release_v27_expectations (
    expectation_key TEXT PRIMARY KEY,
    expected_sha256 TEXT NOT NULL,
    CONSTRAINT koaryu_release_v27_expectation_key_exact CHECK (expectation_key = 'operational_contract_v27'),
    CONSTRAINT koaryu_release_v27_expectation_digest_shape CHECK (expected_sha256 ~ '^[0-9a-f]{64}$')
);
ALTER TABLE private.koaryu_release_v27_expectations OWNER TO postgres;
ALTER TABLE private.koaryu_release_v27_expectations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE private.koaryu_release_v27_expectations FROM PUBLIC, anon, authenticated, service_role;
INSERT INTO private.koaryu_release_v27_expectations(expectation_key, expected_sha256)
VALUES ('operational_contract_v27', '4941584e8e00ddcd4aab5c8f9020d9972b1b349e164696c6f0120f25fcfbbd66');

CREATE OR REPLACE FUNCTION public.koaryu_release_schema_preflight_v8()
RETURNS TABLE (
    ready BOOLEAN, migration_count INTEGER, migration_head TEXT,
    pending_versions TEXT[], security_failures TEXT[], manifest_version TEXT
)
LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = pg_catalog AS $$
DECLARE
    v_count INTEGER;
    v_head TEXT;
    v_pending TEXT[];
    v_failures TEXT[] := ARRAY[]::TEXT[];
    v_expected TEXT;
    v_expected_v26 TEXT;
BEGIN
    SELECT count(*)::INTEGER, max(version),
           array_agg(version ORDER BY version COLLATE "C") FILTER (WHERE version >= '20260727100000')
    INTO v_count, v_head, v_pending FROM supabase_migrations.schema_migrations;
    IF v_count <> 122 OR v_head <> '20260826051527' THEN
        v_failures := array_append(v_failures, 'migration_history_v27');
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
        '20260826030249','20260826051527'
    ]::TEXT[] THEN
        v_failures := array_append(v_failures, 'migration_history_sequence_v27');
    END IF;
    IF private.koaryu_release_provider_operations_manifest_v27() <> '0:33ef02ac5db886e340359ee735d5dd3d152cda3538be270903a2302dba3d29f8' THEN
        v_failures := array_append(v_failures, 'provider_operations_manifest_v27');
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
       <> '0:85921b516e77f025a3548356e70ade4d78a9bdc1635ec7713df4f883beb8709b' THEN
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
    SELECT expected_sha256 INTO v_expected_v26
    FROM private.koaryu_release_v26_expectations
    WHERE expectation_key = 'operational_contract_v26';
    IF NOT FOUND OR (SELECT count(*) FROM private.koaryu_release_v26_expectations) <> 1
       OR private.koaryu_release_operational_contract_v26() IS DISTINCT FROM '0:' || v_expected_v26 THEN
        v_failures := array_append(v_failures, 'operational_contract_v26');
    END IF;
    SELECT expected_sha256 INTO v_expected FROM private.koaryu_release_v27_expectations
    WHERE expectation_key = 'operational_contract_v27';
    IF NOT FOUND OR (SELECT count(*) FROM private.koaryu_release_v27_expectations) <> 1
       OR private.koaryu_release_operational_contract_v27() IS DISTINCT FROM '0:' || v_expected THEN
        v_failures := array_append(v_failures, 'operational_contract_v27');
    END IF;
    RETURN QUERY SELECT cardinality(v_failures) = 0, v_count, v_head,
        COALESCE(v_pending, ARRAY[]::TEXT[]), v_failures, 'release-db-attestation-v27'::TEXT;
END;
$$;
ALTER FUNCTION public.koaryu_release_schema_preflight_v8() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.koaryu_release_schema_preflight_v8() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.koaryu_release_schema_preflight_v8() TO service_role;

CREATE OR REPLACE FUNCTION public.koaryu_release_schema_preflight_v7()
RETURNS TABLE (
    ready BOOLEAN, migration_count INTEGER, migration_head TEXT,
    pending_versions TEXT[], security_failures TEXT[], manifest_version TEXT
)
LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = pg_catalog AS $$
DECLARE v_current RECORD;
BEGIN
    SELECT * INTO v_current FROM public.koaryu_release_schema_preflight_v8();
    IF v_current.ready IS TRUE AND v_current.migration_count = 122
       AND v_current.migration_head = '20260826051527'
       AND v_current.manifest_version = 'release-db-attestation-v27'
       AND cardinality(v_current.security_failures) = 0 THEN
        RETURN QUERY SELECT true, 121, '20260826030249'::TEXT,
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
                '20260826030234','20260826030249'
            ]::TEXT[], ARRAY[]::TEXT[], 'release-db-attestation-v26'::TEXT;
        RETURN;
    END IF;
    RETURN QUERY SELECT false, v_current.migration_count, v_current.migration_head,
        v_current.pending_versions,
        COALESCE(v_current.security_failures, ARRAY['v27_compatibility_preflight']::TEXT[]),
        'release-db-attestation-v26'::TEXT;
END;
$$;
ALTER FUNCTION public.koaryu_release_schema_preflight_v7() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.koaryu_release_schema_preflight_v7() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.koaryu_release_schema_preflight_v7() TO service_role;

-- V7 is intentionally replaced above so the already-deployed V26 backend can
-- survive the database-first V27 cutover. Re-pin the private V26 expectation to
-- that exact compatibility definition; the V25-to-V26 restored proof runs
-- before this migration and retains the predecessor pin.
UPDATE private.koaryu_release_v26_expectations
SET expected_sha256 = 'dedde884fbb24696f5d8006417fd0de4cf292c6e1ed9ffe38afc04e514196e10'
WHERE expectation_key = 'operational_contract_v26';

CREATE FUNCTION private.koaryu_release_operational_manifest_v8()
RETURNS TEXT LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog AS $$
    SELECT encode(
        extensions.digest(
            convert_to(
                private.koaryu_release_operational_manifest_v7() || '|' ||
                private.koaryu_release_operational_contract_v27(),
                'UTF8'
            ),
            'sha256'
        ),
        'hex'
    );
$$;
ALTER FUNCTION private.koaryu_release_operational_manifest_v8() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.koaryu_release_operational_manifest_v8() FROM PUBLIC, anon, authenticated, service_role;

DO $diagnostics$
BEGIN
    RAISE NOTICE 'KOARYU_V27_COMPAT_V26_OPERATIONAL_CONTRACT=%', private.koaryu_release_operational_contract_v26();
    RAISE NOTICE 'KOARYU_V27_PROVIDER_MANIFEST=%', private.koaryu_release_provider_operations_manifest_v27();
    RAISE NOTICE 'KOARYU_V27_OPERATIONAL_CONTRACT=%', private.koaryu_release_operational_contract_v27();
    RAISE NOTICE 'KOARYU_V27_OPERATIONAL_MANIFEST=%', private.koaryu_release_operational_manifest_v8();
END;
$diagnostics$;
