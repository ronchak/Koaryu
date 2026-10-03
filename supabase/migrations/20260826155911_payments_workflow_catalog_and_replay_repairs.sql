-- Additive replay and reconciliation repairs discovered while binding the V29
-- period-transition state machine to the application. This migration does not
-- authorize a studio, create a live grant, or mutate a provider.

DO $v29_guard$
DECLARE
    v_preflight RECORD;
BEGIN
    SELECT * INTO v_preflight
    FROM public.koaryu_release_schema_preflight_v10();
    IF v_preflight.ready IS DISTINCT FROM true
       OR v_preflight.migration_count IS DISTINCT FROM 124
       OR v_preflight.migration_head IS DISTINCT FROM '20260826102840'
       OR v_preflight.manifest_version IS DISTINCT FROM 'release-db-attestation-v29'
       OR cardinality(v_preflight.security_failures) <> 0
       OR private.koaryu_release_schedule_window_manifest_v1()
            IS DISTINCT FROM '0:f4c66d3098dcb3210ac6cc92e1831eebaf9f2ed74b210e84ec773cb1d8e854a7' THEN
        RAISE EXCEPTION 'Payments replay repairs require exact ready 124/V29.';
    END IF;
END;
$v29_guard$;

ALTER TABLE public.billing_provider_operations
    DROP CONSTRAINT billing_provider_operations_type_exact,
    ADD CONSTRAINT billing_provider_operations_type_exact CHECK (operation_type IN (
        'payer.sync', 'payer.setup', 'plan.sync', 'plan.archive',
        'enrollment.activate.autopay', 'enrollment.activate.invoice',
        'invoice.create', 'invoice.finalize', 'invoice.retry', 'invoice.void',
        'payment.refund', 'payer.reconcile',
        'enrollment.cancel.period_end.schedule',
        'enrollment.cancel.period_end.execute',
        'enrollment.cancel.period_end.revoke',
        'enrollment.cancel.immediate'
    ));

ALTER TABLE public.billing_provider_operation_resources
    DROP CONSTRAINT billing_provider_operation_resources_pair_exact,
    ADD CONSTRAINT billing_provider_operation_resources_pair_exact CHECK (
        (operation_type = 'invoice.retry' AND resource_type = 'invoice')
        OR (operation_type = 'invoice.finalize' AND resource_type = 'invoice_finalize')
        OR (operation_type = 'invoice.void' AND resource_type = 'invoice_void')
        OR (
            operation_type IN (
                'enrollment.activate.autopay',
                'enrollment.activate.invoice'
            )
            AND resource_type = 'enrollment'
        )
    );
ALTER TABLE public.billing_provider_operation_resource_aliases
    DROP CONSTRAINT billing_provider_operation_resource_aliases_pair_exact,
    ADD CONSTRAINT billing_provider_operation_resource_aliases_pair_exact CHECK (
        (operation_type = 'invoice.retry' AND resource_type = 'invoice')
        OR (operation_type = 'invoice.finalize' AND resource_type = 'invoice_finalize')
        OR (operation_type = 'invoice.void' AND resource_type = 'invoice_void')
        OR (
            operation_type IN (
                'enrollment.activate.autopay',
                'enrollment.activate.invoice'
            )
            AND resource_type = 'enrollment'
        )
    );

CREATE FUNCTION public.claim_billing_invoice_closeout_operation_v1(
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
    v_invoice public.billing_invoices%ROWTYPE;
    v_payer public.billing_payers%ROWTYPE;
    v_account public.studio_payment_accounts%ROWTYPE;
    v_existing_key_operation_id UUID;
    v_now TIMESTAMPTZ := clock_timestamp();
    v_outcome TEXT;
BEGIN
    IF p_studio_id IS NULL OR p_actor_id IS NULL OR p_resource_id IS NULL
       OR p_payer_id IS NULL OR p_lease_owner IS NULL
       OR NOT (
            (p_operation_type = 'invoice.finalize'
                AND p_resource_type = 'invoice_finalize')
            OR (p_operation_type = 'invoice.void'
                AND p_resource_type = 'invoice_void')
       )
       OR p_request_sha256 !~ '^[0-9a-f]{64}$'
       OR p_connect_account_generation <= 0
       OR octet_length(p_stripe_connected_account_id) NOT BETWEEN 1 AND 255
       OR octet_length(p_caller_request_key) NOT BETWEEN 1 AND 255
       OR p_caller_request_key IS DISTINCT FROM btrim(p_caller_request_key)
       OR p_caller_request_key ~ '[[:cntrl:]]'
       OR p_lease_seconds NOT BETWEEN 5 AND 300 THEN
        RAISE EXCEPTION USING ERRCODE = '22023',
            MESSAGE = 'billing_invoice_closeout_claim_invalid';
    END IF;
    IF NOT EXISTS (
        SELECT 1
        FROM public.staff_roles AS membership
        WHERE membership.studio_id = p_studio_id
          AND membership.user_id = p_actor_id
          AND membership.archived_at IS NULL
          AND membership.role = 'admin'
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '42501',
            MESSAGE = 'billing_invoice_closeout_actor_forbidden';
    END IF;

    SELECT * INTO v_invoice
    FROM public.billing_invoices AS invoice
    WHERE invoice.id = p_resource_id AND invoice.studio_id = p_studio_id
    FOR UPDATE;
    SELECT * INTO v_payer
    FROM public.billing_payers AS payer
    WHERE payer.id = p_payer_id AND payer.studio_id = p_studio_id
    FOR UPDATE;
    SELECT * INTO v_account
    FROM public.studio_payment_accounts AS account
    WHERE account.studio_id = p_studio_id
    FOR UPDATE;
    IF v_invoice.id IS NULL OR v_payer.id IS NULL OR v_account.studio_id IS NULL
       OR v_invoice.payer_id IS DISTINCT FROM p_payer_id
       OR v_invoice.stripe_invoice_id IS NULL
       OR v_invoice.stripe_customer_id IS NULL
       OR (p_operation_type = 'invoice.finalize' AND v_invoice.status <> 'draft')
       OR (p_operation_type = 'invoice.void' AND v_invoice.status NOT IN ('draft', 'open'))
       OR v_invoice.stripe_account_id IS DISTINCT FROM p_stripe_connected_account_id
       OR (v_invoice.metadata->>'connect_account_generation')::INTEGER
            IS DISTINCT FROM p_connect_account_generation
       OR v_payer.stripe_account_id IS DISTINCT FROM p_stripe_connected_account_id
       OR v_payer.connect_account_generation IS DISTINCT FROM p_connect_account_generation
       OR v_account.stripe_connected_account_id
            IS DISTINCT FROM p_stripe_connected_account_id
       OR private.current_connect_account_generation(v_account.metadata)
            IS DISTINCT FROM p_connect_account_generation THEN
        RAISE EXCEPTION USING ERRCODE = '23514',
            MESSAGE = 'billing_invoice_closeout_identity_mismatch';
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
            MESSAGE = 'billing_invoice_closeout_request_conflict';
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
                MESSAGE = 'billing_invoice_closeout_alias_conflict';
        END IF;
        SELECT * INTO v_operation
        FROM public.billing_provider_operations AS operation
        WHERE operation.id = v_alias.operation_id
        FOR UPDATE;
        IF v_operation.actor_id IS DISTINCT FROM p_actor_id
           OR v_operation.request_sha256 IS DISTINCT FROM p_request_sha256
           OR v_operation.stripe_connected_account_id
                IS DISTINCT FROM p_stripe_connected_account_id
           OR v_operation.connect_account_generation
                IS DISTINCT FROM p_connect_account_generation THEN
            RAISE EXCEPTION USING ERRCODE = '23505',
                MESSAGE = 'billing_invoice_closeout_request_conflict';
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
        INSERT INTO public.billing_provider_operations(
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
        INSERT INTO public.billing_provider_operation_resources(
            operation_id, studio_id, operation_type, resource_type,
            resource_id, payer_id, created_at, updated_at
        ) VALUES (
            v_operation.id, p_studio_id, p_operation_type, p_resource_type,
            p_resource_id, p_payer_id, v_now, v_now
        ) RETURNING * INTO v_resource;
        INSERT INTO public.billing_provider_operation_resource_aliases(
            resource_claim_id, operation_id, studio_id, operation_type,
            resource_type, resource_id, payer_id, caller_request_key, created_at
        ) VALUES (
            v_resource.id, v_operation.id, p_studio_id, p_operation_type,
            p_resource_type, p_resource_id, p_payer_id,
            p_caller_request_key, v_now
        );
        RETURN private.billing_provider_operation_resource_json_v1(
            v_resource, v_operation, p_caller_request_key, 'claimed'
        );
    END IF;

    SELECT * INTO v_operation
    FROM public.billing_provider_operations AS operation
    WHERE operation.id = v_resource.operation_id
    FOR UPDATE;
    IF v_operation.actor_id IS DISTINCT FROM p_actor_id
       OR v_operation.request_sha256 IS DISTINCT FROM p_request_sha256
       OR v_operation.stripe_connected_account_id
            IS DISTINCT FROM p_stripe_connected_account_id
       OR v_operation.connect_account_generation
            IS DISTINCT FROM p_connect_account_generation THEN
        RAISE EXCEPTION USING ERRCODE = '23505',
            MESSAGE = 'billing_invoice_closeout_request_conflict';
    END IF;
    SELECT operation.id INTO v_existing_key_operation_id
    FROM public.billing_provider_operations AS operation
    WHERE operation.studio_id = p_studio_id
      AND operation.operation_type = p_operation_type
      AND operation.caller_request_key = p_caller_request_key;
    IF v_existing_key_operation_id IS NOT NULL
       AND v_existing_key_operation_id IS DISTINCT FROM v_operation.id THEN
        RAISE EXCEPTION USING ERRCODE = '23505',
            MESSAGE = 'billing_invoice_closeout_alias_conflict';
    END IF;
    IF (
        SELECT count(*)
        FROM public.billing_provider_operation_resource_aliases AS alias
        WHERE alias.operation_id = v_operation.id
    ) >= 64 THEN
        RAISE EXCEPTION USING ERRCODE = '54000',
            MESSAGE = 'billing_invoice_closeout_alias_limit';
    END IF;
    INSERT INTO public.billing_provider_operation_resource_aliases(
        resource_claim_id, operation_id, studio_id, operation_type,
        resource_type, resource_id, payer_id, caller_request_key, created_at
    ) VALUES (
        v_resource.id, v_operation.id, p_studio_id, p_operation_type,
        p_resource_type, p_resource_id, p_payer_id,
        p_caller_request_key, v_now
    );
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
    v_outcome := CASE
        WHEN v_operation.state = 'reconciliation_required'
            THEN 'reconciliation_required'
        WHEN v_operation.state = 'provider_request_in_flight'
            THEN 'provider_request_in_flight'
        ELSE 'adopted'
    END;
    RETURN private.billing_provider_operation_resource_json_v1(
        v_resource, v_operation, p_caller_request_key, v_outcome
    );
END;
$$;

ALTER FUNCTION public.claim_billing_invoice_closeout_operation_v1(
    UUID, UUID, TEXT, TEXT, UUID, UUID, TEXT, TEXT, TEXT, INTEGER, UUID, INTEGER
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.claim_billing_invoice_closeout_operation_v1(
    UUID, UUID, TEXT, TEXT, UUID, UUID, TEXT, TEXT, TEXT, INTEGER, UUID, INTEGER
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.claim_billing_invoice_closeout_operation_v1(
    UUID, UUID, TEXT, TEXT, UUID, UUID, TEXT, TEXT, TEXT, INTEGER, UUID, INTEGER
) TO service_role;

CREATE FUNCTION private.live_billing_operation_set_is_canonical_v1(
    p_scope TEXT,
    p_operations TEXT[]
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SECURITY INVOKER
SET search_path = ''
AS $$
    SELECT p_scope IN (
            'core_subscription', 'connect_onboarding', 'connect_payments'
        )
        AND p_operations IS NOT NULL
        AND cardinality(p_operations) BETWEEN 1 AND 32
        AND p_operations = ARRAY(
            SELECT operation
            FROM unnest(p_operations) AS operation
            ORDER BY operation COLLATE "C"
        )
        AND cardinality(p_operations) = (
            SELECT count(DISTINCT operation)
            FROM unnest(p_operations) AS operation
        )
        AND NOT EXISTS (
            SELECT 1
            FROM unnest(p_operations) AS operation
            WHERE operation IS NULL
               OR octet_length(operation) NOT BETWEEN 1 AND 128
               OR operation <> btrim(operation)
               OR operation ~ '[*%]'
               OR operation ~ '[[:cntrl:]]'
               OR NOT (
                    (p_scope = 'core_subscription' AND operation = ANY (ARRAY[
                        'core_checkout_session.create',
                        'customer.create',
                        'customer_portal_session.create'
                    ]::TEXT[]))
                    OR (p_scope = 'connect_onboarding' AND operation = ANY (ARRAY[
                        'connect_account.branding.update',
                        'connect_account.create',
                        'connect_branding_file.create',
                        'connect_dashboard_login_link.create',
                        'connect_onboarding_link.create'
                    ]::TEXT[]))
                    OR (p_scope = 'connect_payments' AND operation = ANY (ARRAY[
                        'connected_capability.readiness',
                        'connected_customer.create',
                        'connected_customer.default_payment_method.update',
                        'connected_customer.update',
                        'connected_invoice.create',
                        'connected_invoice.finalize',
                        'connected_invoice.pay',
                        'connected_invoice.send',
                        'connected_invoice.void',
                        'connected_invoice_item.create',
                        'connected_price.create',
                        'connected_product.create',
                        'connected_product.update',
                        'connected_refund.create',
                        'connected_setup_checkout_session.create',
                        'connected_subscription.cancel',
                        'connected_subscription.create',
                        'connected_subscription.update',
                        'connected_subscription_item.create',
                        'connected_subscription_item.delete',
                        'connected_subscription_item.update'
                    ]::TEXT[]))
               )
        );
$$;

ALTER FUNCTION private.live_billing_operation_set_is_canonical_v1(TEXT, TEXT[])
    OWNER TO postgres;
REVOKE ALL ON FUNCTION private.live_billing_operation_set_is_canonical_v1(TEXT, TEXT[])
    FROM PUBLIC, anon, authenticated, service_role;

ALTER TABLE public.studio_live_billing_authorizations
    ADD COLUMN allowed_operations TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
UPDATE public.studio_live_billing_authorizations
SET allowed_operations = CASE scope
    WHEN 'core_subscription' THEN ARRAY[
        'core_checkout_session.create',
        'customer.create',
        'customer_portal_session.create'
    ]::TEXT[]
    WHEN 'connect_onboarding' THEN ARRAY[
        'connect_account.branding.update',
        'connect_account.create',
        'connect_branding_file.create',
        'connect_dashboard_login_link.create',
        'connect_onboarding_link.create'
    ]::TEXT[]
    ELSE ARRAY[]::TEXT[]
END
WHERE enabled;
ALTER TABLE public.studio_live_billing_authorizations
    ADD CONSTRAINT studio_live_billing_authorizations_operation_set_exact CHECK (
        allowed_operations = ARRAY[]::TEXT[]
        OR private.live_billing_operation_set_is_canonical_v1(
            scope, allowed_operations
        )
    );

CREATE FUNCTION public.read_billing_enrollment_transition_by_key_v1(
    p_studio_id UUID,
    p_actor_id UUID,
    p_transition_kind TEXT,
    p_caller_request_key TEXT,
    p_request_sha256 TEXT,
    p_enrollment_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
DECLARE
    v_alias public.billing_enrollment_transition_aliases%ROWTYPE;
    v_intent public.billing_enrollment_transition_intents%ROWTYPE;
BEGIN
    IF p_studio_id IS NULL OR p_actor_id IS NULL OR p_enrollment_id IS NULL
       OR p_transition_kind NOT IN (
            'schedule_period_end', 'revoke_scheduled',
            'execute_due', 'immediate_cancel'
       )
       OR p_request_sha256 !~ '^[0-9a-f]{64}$'
       OR octet_length(p_caller_request_key) NOT BETWEEN 1 AND 255
       OR p_caller_request_key IS DISTINCT FROM btrim(p_caller_request_key)
       OR p_caller_request_key ~ '[[:cntrl:]]' THEN
        RAISE EXCEPTION USING ERRCODE = '22023',
            MESSAGE = 'billing_enrollment_transition_read_invalid';
    END IF;
    IF NOT EXISTS (
        SELECT 1
        FROM public.staff_roles AS membership
        WHERE membership.studio_id = p_studio_id
          AND membership.user_id = p_actor_id
          AND membership.archived_at IS NULL
          AND membership.role IN ('admin', 'front_desk')
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '42501',
            MESSAGE = 'billing_enrollment_transition_actor_forbidden';
    END IF;
    SELECT * INTO v_alias
    FROM public.billing_enrollment_transition_aliases AS alias
    WHERE alias.studio_id = p_studio_id
      AND alias.transition_kind = p_transition_kind
      AND alias.caller_request_key = p_caller_request_key;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0002',
            MESSAGE = 'billing_enrollment_transition_not_found';
    END IF;
    SELECT * INTO v_intent
    FROM public.billing_enrollment_transition_intents AS intent
    WHERE intent.id = v_alias.intent_id
      AND intent.studio_id = p_studio_id
      AND intent.transition_kind = p_transition_kind;
    IF NOT FOUND
       OR v_alias.actor_id IS DISTINCT FROM p_actor_id
       OR v_alias.request_sha256 IS DISTINCT FROM p_request_sha256
       OR v_intent.initiated_by IS DISTINCT FROM p_actor_id
       OR v_intent.request_sha256 IS DISTINCT FROM p_request_sha256
       OR v_intent.enrollment_id IS DISTINCT FROM p_enrollment_id THEN
        RAISE EXCEPTION USING ERRCODE = '23514',
            MESSAGE = 'billing_enrollment_transition_read_identity_mismatch';
    END IF;
    RETURN private.billing_enrollment_transition_json_v1(
        v_intent, 'read', p_caller_request_key
    );
END;
$$;

ALTER FUNCTION public.read_billing_enrollment_transition_by_key_v1(
    UUID, UUID, TEXT, TEXT, TEXT, UUID
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.read_billing_enrollment_transition_by_key_v1(
    UUID, UUID, TEXT, TEXT, TEXT, UUID
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.read_billing_enrollment_transition_by_key_v1(
    UUID, UUID, TEXT, TEXT, TEXT, UUID
) TO service_role;

CREATE FUNCTION public.mark_billing_enrollment_due_readback_reconciliation_v1(
    p_intent_id UUID,
    p_studio_id UUID,
    p_worker_id UUID,
    p_expected_revision BIGINT,
    p_provider_evidence_sha256 TEXT,
    p_reconciliation_reason_code TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_source public.billing_enrollment_transition_intents%ROWTYPE;
    v_intent public.billing_enrollment_transition_intents%ROWTYPE;
    v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
    SELECT * INTO v_intent
    FROM public.billing_enrollment_transition_intents
    WHERE id = p_intent_id AND studio_id = p_studio_id
    FOR UPDATE;
    IF v_intent.source_intent_id IS NOT NULL THEN
        SELECT * INTO v_source
        FROM public.billing_enrollment_transition_intents
        WHERE id = v_intent.source_intent_id AND studio_id = p_studio_id
        FOR UPDATE;
    END IF;
    IF v_intent.id IS NULL OR v_source.id IS NULL
       OR v_intent.transition_kind <> 'execute_due'
       OR v_intent.mutation_strategy <> 'subscription_cancel_at_period_end'
       OR v_intent.provider_operation_id IS NOT NULL
       OR v_intent.state <> 'due_claimed'
       OR v_source.state <> 'due_claimed'
       OR v_intent.lease_owner IS DISTINCT FROM p_worker_id
       OR v_intent.revision IS DISTINCT FROM p_expected_revision
       OR p_provider_evidence_sha256 !~ '^[0-9a-f]{64}$'
       OR p_reconciliation_reason_code !~ '^[a-z0-9][a-z0-9_.:-]{0,127}$' THEN
        RAISE EXCEPTION USING ERRCODE = '23514',
            MESSAGE = 'billing_enrollment_due_readback_reconciliation_invalid';
    END IF;
    UPDATE public.billing_enrollment_transition_intents
    SET state = 'reconciliation_required',
        provider_evidence_sha256 = p_provider_evidence_sha256,
        reconciliation_reason_code = p_reconciliation_reason_code,
        reconciliation_required_at = v_now,
        lease_owner = NULL,
        lease_acquired_at = NULL,
        lease_expires_at = NULL,
        revision = revision + 1,
        updated_at = v_now
    WHERE id = v_intent.id
    RETURNING * INTO v_intent;
    UPDATE public.billing_enrollment_transition_intents
    SET state = 'reconciliation_required',
        provider_evidence_sha256 = p_provider_evidence_sha256,
        reconciliation_reason_code = p_reconciliation_reason_code,
        reconciliation_required_at = v_now,
        revision = revision + 1,
        updated_at = v_now
    WHERE id = v_source.id;
    RETURN private.billing_enrollment_transition_json_v1(
        v_intent, 'reconciliation_required', NULL
    );
END;
$$;

ALTER FUNCTION public.mark_billing_enrollment_due_readback_reconciliation_v1(
    UUID, UUID, UUID, BIGINT, TEXT, TEXT
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.mark_billing_enrollment_due_readback_reconciliation_v1(
    UUID, UUID, UUID, BIGINT, TEXT, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mark_billing_enrollment_due_readback_reconciliation_v1(
    UUID, UUID, UUID, BIGINT, TEXT, TEXT
) TO service_role;

CREATE FUNCTION public.mark_billing_enrollment_due_pre_provider_reconciliation_v1(
    p_intent_id UUID,
    p_studio_id UUID,
    p_worker_id UUID,
    p_expected_revision BIGINT,
    p_provider_evidence_sha256 TEXT,
    p_reconciliation_reason_code TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_source public.billing_enrollment_transition_intents%ROWTYPE;
    v_intent public.billing_enrollment_transition_intents%ROWTYPE;
    v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
    SELECT * INTO v_intent
    FROM public.billing_enrollment_transition_intents
    WHERE id = p_intent_id AND studio_id = p_studio_id
    FOR UPDATE;
    IF v_intent.source_intent_id IS NOT NULL THEN
        SELECT * INTO v_source
        FROM public.billing_enrollment_transition_intents
        WHERE id = v_intent.source_intent_id AND studio_id = p_studio_id
        FOR UPDATE;
    END IF;
    IF v_intent.id IS NULL OR v_source.id IS NULL
       OR v_intent.transition_kind <> 'execute_due'
       OR v_intent.mutation_strategy <> 'subscription_item_delete_at_period_end'
       OR v_intent.provider_operation_id IS NOT NULL
       OR v_intent.state <> 'due_claimed'
       OR v_source.state <> 'due_claimed'
       OR v_intent.lease_owner IS DISTINCT FROM p_worker_id
       OR v_intent.revision IS DISTINCT FROM p_expected_revision
       OR p_provider_evidence_sha256 !~ '^[0-9a-f]{64}$'
       OR p_reconciliation_reason_code !~ '^[a-z0-9][a-z0-9_.:-]{0,127}$' THEN
        RAISE EXCEPTION USING ERRCODE = '23514',
            MESSAGE = 'billing_enrollment_due_pre_provider_reconciliation_invalid';
    END IF;
    UPDATE public.billing_enrollment_transition_intents
    SET state = 'reconciliation_required',
        provider_evidence_sha256 = p_provider_evidence_sha256,
        reconciliation_reason_code = p_reconciliation_reason_code,
        reconciliation_required_at = v_now,
        lease_owner = NULL,
        lease_acquired_at = NULL,
        lease_expires_at = NULL,
        revision = revision + 1,
        updated_at = v_now
    WHERE id = v_intent.id
    RETURNING * INTO v_intent;
    UPDATE public.billing_enrollment_transition_intents
    SET state = 'reconciliation_required',
        provider_evidence_sha256 = p_provider_evidence_sha256,
        reconciliation_reason_code = p_reconciliation_reason_code,
        reconciliation_required_at = v_now,
        revision = revision + 1,
        updated_at = v_now
    WHERE id = v_source.id;
    RETURN private.billing_enrollment_transition_json_v1(
        v_intent, 'reconciliation_required', NULL
    );
END;
$$;

ALTER FUNCTION public.mark_billing_enrollment_due_pre_provider_reconciliation_v1(
    UUID, UUID, UUID, BIGINT, TEXT, TEXT
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.mark_billing_enrollment_due_pre_provider_reconciliation_v1(
    UUID, UUID, UUID, BIGINT, TEXT, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mark_billing_enrollment_due_pre_provider_reconciliation_v1(
    UUID, UUID, UUID, BIGINT, TEXT, TEXT
) TO service_role;

ALTER FUNCTION public.authorize_studio_live_billing_mutation_atomic(
    UUID, TEXT, TEXT, TEXT, TEXT
) RENAME TO authorize_studio_live_billing_scope_v3;
REVOKE ALL ON FUNCTION public.authorize_studio_live_billing_scope_v3(
    UUID, TEXT, TEXT, TEXT, TEXT
) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.authorize_studio_live_billing_mutation_atomic(
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
    IF NOT EXISTS (
        SELECT 1
        FROM public.studio_live_billing_authorizations AS authz
        WHERE authz.studio_id = p_studio_id
          AND authz.scope = p_scope
          AND authz.enabled
          AND private.live_billing_operation_set_is_canonical_v1(
              authz.scope, authz.allowed_operations
          )
          AND p_operation = ANY(authz.allowed_operations)
    ) THEN
        RETURN;
    END IF;
    RETURN QUERY
    SELECT scope_result.authorized,
           scope_result.studio_id,
           scope_result.checkpoint_id
    FROM public.authorize_studio_live_billing_scope_v3(
        p_studio_id,
        p_operation,
        p_scope,
        p_stripe_connected_account_id,
        p_candidate_sha
    ) AS scope_result;
END;
$$;

ALTER FUNCTION public.authorize_studio_live_billing_mutation_atomic(
    UUID, TEXT, TEXT, TEXT, TEXT
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.authorize_studio_live_billing_mutation_atomic(
    UUID, TEXT, TEXT, TEXT, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.authorize_studio_live_billing_mutation_atomic(
    UUID, TEXT, TEXT, TEXT, TEXT
) TO service_role;

ALTER FUNCTION public.set_studio_live_billing_authorization_atomic(
    UUID, TEXT, BOOLEAN, TIMESTAMPTZ, TEXT, UUID, TEXT, TEXT
) RENAME TO set_studio_live_billing_authorization_scope_v3;
REVOKE ALL ON FUNCTION public.set_studio_live_billing_authorization_scope_v3(
    UUID, TEXT, BOOLEAN, TIMESTAMPTZ, TEXT, UUID, TEXT, TEXT
) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.set_studio_live_billing_authorization_operations_v1(
    p_studio_id UUID,
    p_scope TEXT,
    p_enabled BOOLEAN,
    p_expires_at TIMESTAMPTZ,
    p_reason TEXT,
    p_actor_id UUID,
    p_allowed_operations TEXT[],
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
    allowed_operations TEXT[],
    expires_at TIMESTAMPTZ,
    revision BIGINT,
    changed_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_scope_result RECORD;
    v_operations TEXT[] := COALESCE(p_allowed_operations, ARRAY[]::TEXT[]);
BEGIN
    IF p_enabled IS NULL
       OR (p_enabled AND NOT private.live_billing_operation_set_is_canonical_v1(
            p_scope, v_operations
       ))
       OR (NOT p_enabled AND cardinality(v_operations) <> 0) THEN
        RAISE EXCEPTION USING ERRCODE = '22023',
            MESSAGE = 'live_billing_operation_set_invalid';
    END IF;
    SELECT * INTO v_scope_result
    FROM public.set_studio_live_billing_authorization_scope_v3(
        p_studio_id,
        p_scope,
        p_enabled,
        p_expires_at,
        p_reason,
        p_actor_id,
        p_actor_email,
        p_stripe_connected_account_id
    );
    UPDATE public.studio_live_billing_authorizations AS authz
    SET allowed_operations = v_operations
    WHERE authz.studio_id = p_studio_id
      AND authz.scope = p_scope;
    RETURN QUERY
    SELECT v_scope_result.outcome,
           v_scope_result.studio_id,
           v_scope_result.scope,
           v_scope_result.enabled,
           v_scope_result.stripe_connected_account_id,
           v_scope_result.connect_account_generation,
           v_operations,
           v_scope_result.expires_at,
           v_scope_result.revision,
           v_scope_result.changed_at;
END;
$$;

ALTER FUNCTION public.set_studio_live_billing_authorization_operations_v1(
    UUID, TEXT, BOOLEAN, TIMESTAMPTZ, TEXT, UUID, TEXT[], TEXT, TEXT
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.set_studio_live_billing_authorization_operations_v1(
    UUID, TEXT, BOOLEAN, TIMESTAMPTZ, TEXT, UUID, TEXT[], TEXT, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_studio_live_billing_authorization_operations_v1(
    UUID, TEXT, BOOLEAN, TIMESTAMPTZ, TEXT, UUID, TEXT[], TEXT, TEXT
) TO service_role;

CREATE FUNCTION public.set_studio_live_billing_authorization_atomic(
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
BEGIN
    IF p_enabled IS DISTINCT FROM false THEN
        RAISE EXCEPTION USING ERRCODE = '0A000',
            MESSAGE = 'operation_bounded_live_authorization_required';
    END IF;
    RETURN QUERY
    SELECT mutation.outcome,
           mutation.studio_id,
           mutation.scope,
           mutation.enabled,
           mutation.stripe_connected_account_id,
           mutation.connect_account_generation,
           mutation.expires_at,
           mutation.revision,
           mutation.changed_at
    FROM public.set_studio_live_billing_authorization_operations_v1(
        p_studio_id,
        p_scope,
        false,
        p_expires_at,
        p_reason,
        p_actor_id,
        ARRAY[]::TEXT[],
        p_actor_email,
        p_stripe_connected_account_id
    ) AS mutation;
END;
$$;
ALTER FUNCTION public.set_studio_live_billing_authorization_atomic(
    UUID, TEXT, BOOLEAN, TIMESTAMPTZ, TEXT, UUID, TEXT, TEXT
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.set_studio_live_billing_authorization_atomic(
    UUID, TEXT, BOOLEAN, TIMESTAMPTZ, TEXT, UUID, TEXT, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_studio_live_billing_authorization_atomic(
    UUID, TEXT, BOOLEAN, TIMESTAMPTZ, TEXT, UUID, TEXT, TEXT
) TO service_role;

UPDATE private.koaryu_release_v29_expectations
SET expected_sha256 = '982fdf3857f160204c92badb9d7cd5269eadef78238fbe9e2cd6f8cd7729a692'
WHERE expectation_key = 'operational_contract_v29';
UPDATE private.koaryu_release_v28_expectations
SET expected_sha256 = '1cd9763f68ad9f4657eb64dccec1efbc441544216b3a97804385684dad0444a0'
WHERE expectation_key = 'operational_contract_v28';
UPDATE private.koaryu_release_v27_expectations
SET expected_sha256 = '9778cbb1bf3584e9d8c83cfba6bd7ed955910dea2a1c3cad2cd18730755901bf'
WHERE expectation_key = 'operational_contract_v27';
UPDATE private.koaryu_release_v26_expectations
SET expected_sha256 = '4eafa8402fd37c9003a5e0d4bbb961bf344fc4170fac7ad1e1f5bd3b9b55de5c'
WHERE expectation_key = 'operational_contract_v26';

CREATE FUNCTION private.koaryu_release_payments_replay_repairs_manifest_v30()
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
SET "TimeZone" = 'UTC'
AS $$
DECLARE
    v_invalid INTEGER;
    v_serialized TEXT;
BEGIN
    WITH required_functions(
        signature, service_execute, security_definer, expected_config
    ) AS (
        VALUES
            ('private.live_billing_operation_set_is_canonical_v1(text,text[])', false, false, 'search_path=""'),
            ('public.claim_billing_invoice_closeout_operation_v1(uuid,uuid,text,text,uuid,uuid,text,text,text,integer,uuid,integer)', true, true, 'search_path=""'),
            ('public.read_billing_enrollment_transition_by_key_v1(uuid,uuid,text,text,text,uuid)', true, true, 'search_path=""'),
            ('public.mark_billing_enrollment_due_readback_reconciliation_v1(uuid,uuid,uuid,bigint,text,text)', true, true, 'search_path=""'),
            ('public.mark_billing_enrollment_due_pre_provider_reconciliation_v1(uuid,uuid,uuid,bigint,text,text)', true, true, 'search_path=""'),
            ('public.authorize_studio_live_billing_mutation_atomic(uuid,text,text,text,text)', true, true, 'search_path=""'),
            ('public.authorize_studio_live_billing_scope_v3(uuid,text,text,text,text)', false, true, 'search_path=""'),
            ('public.set_studio_live_billing_authorization_operations_v1(uuid,text,boolean,timestamp with time zone,text,uuid,text[],text,text)', true, true, 'search_path=""'),
            ('public.set_studio_live_billing_authorization_atomic(uuid,text,boolean,timestamp with time zone,text,uuid,text,text)', true, true, 'search_path=public, pg_temp'),
            ('public.set_studio_live_billing_authorization_scope_v3(uuid,text,boolean,timestamp with time zone,text,uuid,text,text)', false, true, 'search_path=public, pg_temp')
    ), function_state AS (
        SELECT required.signature,
               procedure.oid,
               owner.rolname,
               procedure.prosecdef,
               COALESCE(array_to_string(procedure.proconfig, ','), '') AS config,
               has_function_privilege('service_role', procedure.oid, 'EXECUTE') AS service_execute,
               has_function_privilege('anon', procedure.oid, 'EXECUTE') AS anon_execute,
               has_function_privilege('authenticated', procedure.oid, 'EXECUTE') AS auth_execute,
               required.service_execute AS expected_service_execute,
               required.security_definer AS expected_security_definer,
               required.expected_config,
               pg_get_functiondef(procedure.oid) AS definition
        FROM required_functions AS required
        LEFT JOIN pg_proc AS procedure ON procedure.oid = to_regprocedure(required.signature)
        LEFT JOIN pg_roles AS owner ON owner.oid = procedure.proowner
    ), constraint_state AS (
        SELECT relation.relname || '.' || constraint_state.conname || ':' ||
               pg_get_constraintdef(constraint_state.oid) AS definition
        FROM pg_constraint AS constraint_state
        JOIN pg_class AS relation ON relation.oid = constraint_state.conrelid
        WHERE constraint_state.conname IN (
            'billing_provider_operations_type_exact',
            'billing_provider_operation_resources_pair_exact',
            'billing_provider_operation_resource_aliases_pair_exact',
            'studio_live_billing_authorizations_operation_set_exact'
        )
    ), column_state AS (
        SELECT format_type(attribute.atttypid, attribute.atttypmod) AS data_type,
               attribute.attnotnull AS not_null,
               COALESCE(pg_get_expr(default_value.adbin, default_value.adrelid), '') AS default_value
        FROM pg_attribute AS attribute
        LEFT JOIN pg_attrdef AS default_value
          ON default_value.adrelid = attribute.attrelid
         AND default_value.adnum = attribute.attnum
        WHERE attribute.attrelid = 'public.studio_live_billing_authorizations'::REGCLASS
          AND attribute.attname = 'allowed_operations'
          AND NOT attribute.attisdropped
    ), object_state(category, value) AS (
        SELECT 'functions', string_agg(
            signature || ':' || COALESCE(rolname, '') || ':' ||
            COALESCE(prosecdef::TEXT, '') || ':' || config || ':' ||
            service_execute::TEXT || ':' || anon_execute::TEXT || ':' ||
            auth_execute::TEXT || ':' || COALESCE(definition, ''),
            '|' ORDER BY signature COLLATE "C"
        ) FROM function_state
        UNION ALL
        SELECT 'constraints', string_agg(definition, '|' ORDER BY definition COLLATE "C")
        FROM constraint_state
        UNION ALL
        SELECT 'allowed_operations_column',
               COALESCE(data_type, '') || ':' || COALESCE(not_null::TEXT, '') || ':' ||
               COALESCE(default_value, '')
        FROM column_state
    )
    SELECT
        (SELECT count(*) FROM function_state
          WHERE oid IS NULL OR rolname <> 'postgres'
             OR prosecdef IS DISTINCT FROM expected_security_definer
             OR config <> expected_config
             OR service_execute IS DISTINCT FROM expected_service_execute
             OR anon_execute OR auth_execute)
        + CASE WHEN (SELECT count(*) FROM constraint_state) = 4 THEN 0 ELSE 1 END
        + CASE WHEN (
            SELECT count(*) FROM column_state
            WHERE data_type = 'text[]' AND not_null
              AND default_value = 'ARRAY[]::text[]'
          ) = 1 THEN 0 ELSE 1 END,
        string_agg(category || '=' || COALESCE(value, ''), E'\n' ORDER BY category COLLATE "C")
    INTO v_invalid, v_serialized
    FROM object_state;
    RETURN v_invalid::TEXT || ':' || encode(
        extensions.digest(convert_to(COALESCE(v_serialized, ''), 'UTF8'), 'sha256'),
        'hex'
    );
END;
$$;

ALTER FUNCTION private.koaryu_release_payments_replay_repairs_manifest_v30()
    OWNER TO postgres;
REVOKE ALL ON FUNCTION private.koaryu_release_payments_replay_repairs_manifest_v30()
    FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION private.koaryu_release_operational_contract_v30()
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
SET "TimeZone" = 'UTC'
AS $$
    SELECT '0:' || encode(extensions.digest(convert_to(
        private.koaryu_release_operational_contract_v29() || '|' ||
        private.koaryu_release_payments_replay_repairs_manifest_v30(),
        'UTF8'
    ), 'sha256'), 'hex');
$$;

ALTER FUNCTION private.koaryu_release_operational_contract_v30() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.koaryu_release_operational_contract_v30()
    FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE private.koaryu_release_v30_expectations(
    expectation_key TEXT PRIMARY KEY
        CHECK (expectation_key = 'operational_contract_v30'),
    expected_sha256 TEXT NOT NULL CHECK (expected_sha256 ~ '^[0-9a-f]{64}$')
);
ALTER TABLE private.koaryu_release_v30_expectations OWNER TO postgres;
ALTER TABLE private.koaryu_release_v30_expectations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE private.koaryu_release_v30_expectations
    FROM PUBLIC, anon, authenticated, service_role;
INSERT INTO private.koaryu_release_v30_expectations(
    expectation_key, expected_sha256
) VALUES (
    'operational_contract_v30',
    '6396d71a8da8966ca50d412e6d5caccb7dc624775e69aef993b61e303f5d0400'
);

CREATE FUNCTION private.koaryu_release_operational_manifest_v11()
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
SET "TimeZone" = 'UTC'
AS $$
    SELECT encode(extensions.digest(convert_to(
        private.koaryu_release_operational_manifest_v10() || '|' ||
        private.koaryu_release_payments_replay_repairs_manifest_v30() || '|' ||
        private.koaryu_release_operational_contract_v30() || '|' ||
        (SELECT string_agg(expectation_key || ':' || expected_sha256, '|')
         FROM private.koaryu_release_v30_expectations),
        'UTF8'
    ), 'sha256'), 'hex');
$$;
ALTER FUNCTION private.koaryu_release_operational_manifest_v11() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.koaryu_release_operational_manifest_v11()
    FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.koaryu_release_schema_preflight_v11()
RETURNS TABLE(
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
AS $$
DECLARE
    v_count INTEGER;
    v_head TEXT;
    v_pending TEXT[];
    v_failures TEXT[] := ARRAY[]::TEXT[];
    v_expected TEXT;
BEGIN
    SELECT count(*)::INTEGER,
           max(version),
           array_agg(version ORDER BY version COLLATE "C")
               FILTER (WHERE version >= '20260727100000')
    INTO v_count, v_head, v_pending
    FROM supabase_migrations.schema_migrations;
    IF v_count <> 125 OR v_head <> '20260826155911' THEN
        v_failures := array_append(v_failures, 'migration_history_v30');
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
        '20260824190500','20260825042838','20260825043911',
        '20260826030234','20260826030249','20260826051527',
        '20260826073728','20260826102840','20260826155911'
    ]::TEXT[] THEN
        v_failures := array_append(v_failures, 'migration_history_sequence_v30');
    END IF;
    IF private.koaryu_release_payments_replay_repairs_manifest_v30()
       <> '0:bf7208ee6b49620e3ef146812c6e69fa8bc73058086d6d7df12c91ec41888f55' THEN
        v_failures := array_append(v_failures, 'payments_replay_repairs_manifest_v30');
    END IF;
    SELECT expected_sha256 INTO v_expected
    FROM private.koaryu_release_v30_expectations
    WHERE expectation_key = 'operational_contract_v30';
    IF NOT FOUND OR (SELECT count(*) FROM private.koaryu_release_v30_expectations) <> 1
       OR private.koaryu_release_operational_contract_v30()
            IS DISTINCT FROM '0:' || v_expected THEN
        v_failures := array_append(v_failures, 'operational_contract_v30');
    END IF;
    SELECT expected_sha256 INTO v_expected
    FROM private.koaryu_release_v29_expectations
    WHERE expectation_key = 'operational_contract_v29';
    IF NOT FOUND OR (SELECT count(*) FROM private.koaryu_release_v29_expectations) <> 1
       OR private.koaryu_release_operational_contract_v29()
            IS DISTINCT FROM '0:' || v_expected THEN
        v_failures := array_append(v_failures, 'operational_contract_v29');
    END IF;
    SELECT expected_sha256 INTO v_expected
    FROM private.koaryu_release_v28_expectations
    WHERE expectation_key = 'operational_contract_v28';
    IF NOT FOUND OR private.koaryu_release_operational_contract_v28()
            IS DISTINCT FROM '0:' || v_expected THEN
        v_failures := array_append(v_failures, 'operational_contract_v28');
    END IF;
    SELECT expected_sha256 INTO v_expected
    FROM private.koaryu_release_v27_expectations
    WHERE expectation_key = 'operational_contract_v27';
    IF NOT FOUND OR (SELECT count(*) FROM private.koaryu_release_v27_expectations) <> 1
       OR private.koaryu_release_operational_contract_v27()
            IS DISTINCT FROM '0:' || v_expected THEN
        v_failures := array_append(v_failures, 'operational_contract_v27');
    END IF;
    SELECT expected_sha256 INTO v_expected
    FROM private.koaryu_release_v26_expectations
    WHERE expectation_key = 'operational_contract_v26';
    IF NOT FOUND OR (SELECT count(*) FROM private.koaryu_release_v26_expectations) <> 1
       OR private.koaryu_release_operational_contract_v26()
            IS DISTINCT FROM '0:' || v_expected THEN
        v_failures := array_append(v_failures, 'operational_contract_v26');
    END IF;
    IF private.koaryu_release_enrollment_transition_manifest_v29()
       <> '0:118b8031e9393f0114f486d0704e71475099d326f7fba9ad5d7518ad5a6a2c60' THEN
        v_failures := array_append(v_failures, 'enrollment_transition_manifest_v29');
    END IF;
    IF private.koaryu_release_provider_operation_steps_manifest_v28()
       <> '0:fc27387abfcf7dfafb1c43552341f78c707b4b6c546f4bb1a02841fb88235fd8' THEN
        v_failures := array_append(v_failures, 'provider_operation_steps_manifest_v28');
    END IF;
    IF private.koaryu_release_operational_manifest_v10()
       <> '32107329f69000537b2e8167d12674a90f46a7a7c8978149b70b8dac5edc7e17' THEN
        v_failures := array_append(v_failures, 'operational_manifest_v10');
    END IF;
    IF encode(extensions.digest(convert_to(pg_get_functiondef(
        'private.koaryu_release_operational_manifest_v10()'::REGPROCEDURE
    ), 'UTF8'), 'sha256'), 'hex')
       <> 'd54e0db95e89d291927c3c070010b6fd8e50709c5a729ea207d9afac95166b94' THEN
        v_failures := array_append(v_failures, 'operational_manifest_v10_function');
    END IF;
    IF encode(extensions.digest(convert_to(pg_get_functiondef(
        'private.koaryu_release_operational_manifest_v7()'::REGPROCEDURE
    ), 'UTF8'), 'sha256'), 'hex')
       <> '2615e19ea37158de13259f072419f7047440a2ad1065288e7b0056d21439f57f' THEN
        v_failures := array_append(v_failures, 'operational_manifest_v7_function');
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
       <> '0:df60c194ff14dc5ea729ca41e469e21bb79acf33edf63edf857fb34e2a8f6628' THEN
        v_failures := array_append(v_failures, 'critical_surface_manifest_v18');
    END IF;
    IF private.koaryu_release_live_billing_v3_manifest_v25()
       <> '0:3c2a6854c73a6e9c9704fabed38dac85b56eb26076add20c00ee97bed5bdc527' THEN
        v_failures := array_append(v_failures, 'live_billing_v3_manifest_v25');
    END IF;
    IF private.koaryu_release_payment_adjustment_manifest_v26()
       <> '0:b63f010f0b0111f38b72fc43009f77722d824d96c3775a9dc3d34e6c58a63657' THEN
        v_failures := array_append(v_failures, 'payment_adjustment_manifest_v26');
    END IF;
    IF private.koaryu_release_schedule_window_manifest_v1()
       IS DISTINCT FROM '0:f4c66d3098dcb3210ac6cc92e1831eebaf9f2ed74b210e84ec773cb1d8e854a7' THEN
        v_failures := array_append(v_failures, 'schedule_window_manifest_v1');
    END IF;
    RETURN QUERY SELECT cardinality(v_failures) = 0,
        v_count, v_head, COALESCE(v_pending, ARRAY[]::TEXT[]), v_failures,
        'release-db-attestation-v30'::TEXT;
END;
$$;
ALTER FUNCTION public.koaryu_release_schema_preflight_v11() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.koaryu_release_schema_preflight_v11()
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.koaryu_release_schema_preflight_v11()
    TO service_role;

CREATE OR REPLACE FUNCTION public.koaryu_release_schema_preflight_v10()
RETURNS TABLE(ready BOOLEAN,migration_count INTEGER,migration_head TEXT,
    pending_versions TEXT[],security_failures TEXT[],manifest_version TEXT)
LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path=pg_catalog AS $$
DECLARE
    v_current RECORD;
    v_failures TEXT[] := ARRAY[]::TEXT[];
    v_expected TEXT;
BEGIN
    SELECT * INTO v_current FROM public.koaryu_release_schema_preflight_v11();
    SELECT expected_sha256 INTO v_expected
    FROM private.koaryu_release_v29_expectations
    WHERE expectation_key = 'operational_contract_v29';
    IF NOT FOUND OR (SELECT count(*) FROM private.koaryu_release_v29_expectations) <> 1
       OR private.koaryu_release_operational_contract_v29()
            IS DISTINCT FROM '0:' || v_expected THEN
        v_failures := array_append(v_failures, 'operational_contract_v29');
    END IF;
    IF v_current.ready AND cardinality(v_failures) = 0
       AND v_current.migration_count = 125
       AND v_current.migration_head = '20260826155911' THEN
        RETURN QUERY SELECT true, 124, '20260826102840'::TEXT,
            v_current.pending_versions[1:cardinality(v_current.pending_versions)-1],
            ARRAY[]::TEXT[], 'release-db-attestation-v29'::TEXT;
        RETURN;
    END IF;
    RETURN QUERY SELECT false, v_current.migration_count, v_current.migration_head,
        v_current.pending_versions,
        COALESCE(v_current.security_failures, ARRAY[]::TEXT[]) || v_failures,
        'release-db-attestation-v29'::TEXT;
END;
$$;
ALTER FUNCTION public.koaryu_release_schema_preflight_v10() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.koaryu_release_schema_preflight_v10()
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.koaryu_release_schema_preflight_v10() TO service_role;

DO $v30_observation$
BEGIN
    RAISE NOTICE 'KOARYU_V30_REPLAY_REPAIRS_MANIFEST=%',
        private.koaryu_release_payments_replay_repairs_manifest_v30();
    RAISE NOTICE 'KOARYU_V30_OPERATIONAL_CONTRACT=%',
        private.koaryu_release_operational_contract_v30();
    RAISE NOTICE 'KOARYU_V30_OPERATIONAL_MANIFEST=%',
        private.koaryu_release_operational_manifest_v11();
    RAISE NOTICE 'KOARYU_V30_PREDECESSOR_OPERATIONAL_MANIFEST_V10=%',
        private.koaryu_release_operational_manifest_v10();
    RAISE NOTICE 'KOARYU_V30_EXPECTATION_STATE=%',
        '1:' || encode(extensions.digest(convert_to(
            'operational_contract_v30:' || (
                SELECT expected_sha256
                FROM private.koaryu_release_v30_expectations
                WHERE expectation_key = 'operational_contract_v30'
            ), 'UTF8'
        ), 'sha256'), 'hex');
    RAISE NOTICE 'KOARYU_V30_OPERATIONAL_MANIFEST_V10_FUNCTION_SHA256=%',
        encode(extensions.digest(convert_to(pg_get_functiondef(
            'private.koaryu_release_operational_manifest_v10()'::REGPROCEDURE
        ), 'UTF8'), 'sha256'), 'hex');
    RAISE NOTICE 'KOARYU_V30_LEGACY_OPERATIONAL_MANIFEST_V7=%',
        private.koaryu_release_operational_manifest_v7();
    RAISE NOTICE 'KOARYU_V30_COMPAT_V29_OPERATIONAL_CONTRACT=%',
        private.koaryu_release_operational_contract_v29();
    RAISE NOTICE 'KOARYU_V30_COMPAT_V28_OPERATIONAL_CONTRACT=%',
        private.koaryu_release_operational_contract_v28();
    RAISE NOTICE 'KOARYU_V30_COMPAT_V27_OPERATIONAL_CONTRACT=%',
        private.koaryu_release_operational_contract_v27();
    RAISE NOTICE 'KOARYU_V30_COMPAT_V26_OPERATIONAL_CONTRACT=%',
        private.koaryu_release_operational_contract_v26();
    RAISE NOTICE 'KOARYU_V30_COMPAT_V28_STEPS_MANIFEST=%',
        private.koaryu_release_provider_operation_steps_manifest_v28();
    RAISE NOTICE 'KOARYU_V30_COMPAT_V25_LIVE_BILLING_MANIFEST=%',
        private.koaryu_release_live_billing_v3_manifest_v25();
    RAISE NOTICE 'KOARYU_V30_CRITICAL_SURFACE=%',
        private.koaryu_release_critical_surface_manifest_v18();
END;
$v30_observation$;
