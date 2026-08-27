DO $v30_guard$
DECLARE v_preflight RECORD;
BEGIN
    SELECT * INTO v_preflight FROM public.koaryu_release_schema_preflight_v10();
    IF v_preflight.ready IS DISTINCT FROM true
       OR v_preflight.migration_count IS DISTINCT FROM 123
       OR v_preflight.migration_head IS DISTINCT FROM '20260826155911'
       OR v_preflight.manifest_version IS DISTINCT FROM 'release-db-attestation-v30'
       OR cardinality(v_preflight.security_failures) <> 0 THEN
        RAISE EXCEPTION 'Resource ownership V31 requires exact ready 123/V30.';
    END IF;
END;
$v30_guard$;
CREATE OR REPLACE FUNCTION private.validate_billing_payment_identity_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
    NEW.payer_id := COALESCE(NEW.payer_id, OLD.payer_id);
    NEW.invoice_id := COALESCE(NEW.invoice_id, OLD.invoice_id);
    NEW.stripe_customer_id := COALESCE(
        NEW.stripe_customer_id,
        OLD.stripe_customer_id
    );
    NEW.stripe_invoice_id := COALESCE(
        NEW.stripe_invoice_id,
        OLD.stripe_invoice_id
    );
    NEW.stripe_payment_intent_id := COALESCE(
        NEW.stripe_payment_intent_id,
        OLD.stripe_payment_intent_id
    );
    NEW.stripe_charge_id := COALESCE(
        NEW.stripe_charge_id,
        OLD.stripe_charge_id
    );
    NEW.stripe_account_id := COALESCE(
        NEW.stripe_account_id,
        OLD.stripe_account_id
    );
    NEW.connect_account_generation := COALESCE(
        NEW.connect_account_generation,
        OLD.connect_account_generation
    );
    NEW.stripe_payment_method_id := COALESCE(
        NEW.stripe_payment_method_id,
        OLD.stripe_payment_method_id
    );

    IF OLD.id IS DISTINCT FROM NEW.id
       OR OLD.studio_id IS DISTINCT FROM NEW.studio_id
       OR (
            OLD.payer_id IS NOT NULL
            AND OLD.payer_id IS DISTINCT FROM NEW.payer_id
       )
       OR (
            OLD.invoice_id IS NOT NULL
            AND OLD.invoice_id IS DISTINCT FROM NEW.invoice_id
       )
       OR (
            OLD.stripe_customer_id IS NOT NULL
            AND OLD.stripe_customer_id IS DISTINCT FROM NEW.stripe_customer_id
       )
       OR (
            OLD.stripe_invoice_id IS NOT NULL
            AND OLD.stripe_invoice_id IS DISTINCT FROM NEW.stripe_invoice_id
       )
       OR (
            OLD.stripe_payment_intent_id IS NOT NULL
            AND OLD.stripe_payment_intent_id IS DISTINCT FROM NEW.stripe_payment_intent_id
       )
       OR (
            OLD.stripe_charge_id IS NOT NULL
            AND OLD.stripe_charge_id IS DISTINCT FROM NEW.stripe_charge_id
       )
       OR (
            OLD.stripe_account_id IS NOT NULL
            AND OLD.stripe_account_id IS DISTINCT FROM NEW.stripe_account_id
       )
       OR (
            OLD.connect_account_generation IS NOT NULL
            AND OLD.connect_account_generation IS DISTINCT FROM NEW.connect_account_generation
       )
       OR (
            OLD.stripe_payment_method_id IS NOT NULL
            AND OLD.stripe_payment_method_id IS DISTINCT FROM NEW.stripe_payment_method_id
       ) THEN
        RAISE EXCEPTION 'Established billing payment identity cannot change.'
            USING ERRCODE = '23514';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.billing_refunds AS refund
        WHERE refund.payment_id = OLD.id
          AND (
              refund.studio_id IS DISTINCT FROM NEW.studio_id
              OR refund.stripe_account_id IS DISTINCT FROM NEW.stripe_account_id
              OR refund.connect_account_generation IS DISTINCT FROM NEW.connect_account_generation
              OR refund.stripe_charge_id IS DISTINCT FROM NEW.stripe_charge_id
              OR refund.stripe_payment_intent_id IS DISTINCT FROM NEW.stripe_payment_intent_id
          )
    ) OR EXISTS (
        SELECT 1
        FROM public.billing_disputes AS dispute
        WHERE dispute.payment_id = OLD.id
          AND (
              dispute.studio_id IS DISTINCT FROM NEW.studio_id
              OR dispute.stripe_account_id IS DISTINCT FROM NEW.stripe_account_id
              OR dispute.connect_account_generation IS DISTINCT FROM NEW.connect_account_generation
              OR dispute.stripe_charge_id IS DISTINCT FROM NEW.stripe_charge_id
              OR dispute.stripe_payment_intent_id IS DISTINCT FROM NEW.stripe_payment_intent_id
          )
    ) THEN
        RAISE EXCEPTION 'Billing payment identity conflicts with a linked adjustment.'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$;

ALTER FUNCTION private.validate_billing_payment_identity_change()
    OWNER TO postgres;
REVOKE ALL ON FUNCTION private.validate_billing_payment_identity_change()
    FROM PUBLIC, anon, authenticated, service_role;

CREATE TEMP TABLE koaryu_v31_legacy_invoice_normalization
ON COMMIT DROP
AS
WITH payment_gross AS (
    SELECT
        payment.studio_id,
        payment.invoice_id,
        LEAST(
            invoice.amount_due_cents,
            COALESCE(SUM(GREATEST(payment.amount_cents, 0)), 0)
        )::BIGINT AS gross_paid_cents,
        MAX(COALESCE(payment.processed_at, payment.created_at)) AS latest_paid_at
    FROM public.billing_invoices AS invoice
    LEFT JOIN public.billing_payments AS payment
      ON payment.studio_id = invoice.studio_id
     AND payment.invoice_id = invoice.id
     AND payment.status IN (
        'succeeded', 'refunded', 'disputed', 'externally_recorded'
     )
    WHERE invoice.status IN ('partially_refunded', 'refunded')
    GROUP BY payment.studio_id, payment.invoice_id, invoice.amount_due_cents
)
SELECT
    invoice.id AS invoice_id,
    invoice.studio_id,
    invoice.payer_id,
    LEAST(
        invoice.amount_due_cents,
        COALESCE(payment_gross.gross_paid_cents, 0)
    )::BIGINT AS gross_paid_cents,
    GREATEST(
        invoice.amount_due_cents - COALESCE(payment_gross.gross_paid_cents, 0),
        0
    )::BIGINT AS remaining_cents,
    CASE
        WHEN invoice.amount_due_cents > 0
         AND COALESCE(payment_gross.gross_paid_cents, 0) >= invoice.amount_due_cents
            THEN 'paid'
        ELSE 'open'
    END::TEXT AS normalized_status,
    CASE
        WHEN invoice.amount_due_cents > 0
         AND COALESCE(payment_gross.gross_paid_cents, 0) >= invoice.amount_due_cents
            THEN COALESCE(invoice.paid_at, payment_gross.latest_paid_at)
        ELSE NULL
    END AS normalized_paid_at
FROM public.billing_invoices AS invoice
LEFT JOIN payment_gross
  ON payment_gross.studio_id = invoice.studio_id
 AND payment_gross.invoice_id = invoice.id
WHERE invoice.status IN ('partially_refunded', 'refunded');

UPDATE public.billing_invoices AS invoice
SET amount_paid_cents = normalization.gross_paid_cents,
    amount_remaining_cents = normalization.remaining_cents,
    status = normalization.normalized_status,
    paid_at = normalization.normalized_paid_at,
    updated_at = clock_timestamp()
FROM koaryu_v31_legacy_invoice_normalization AS normalization
WHERE invoice.id = normalization.invoice_id
  AND invoice.studio_id = normalization.studio_id;

WITH affected_payers AS (
    SELECT DISTINCT studio_id, payer_id
    FROM koaryu_v31_legacy_invoice_normalization
), payer_balances AS (
    SELECT
        affected.studio_id,
        affected.payer_id,
        COALESCE(SUM(
            GREATEST(invoice.amount_remaining_cents, 0)
        ) FILTER (
            WHERE invoice.status IN ('draft', 'open', 'uncollectible')
        ), 0)::BIGINT AS balance_cents
    FROM affected_payers AS affected
    LEFT JOIN public.billing_invoices AS invoice
      ON invoice.studio_id = affected.studio_id
     AND invoice.payer_id = affected.payer_id
    GROUP BY affected.studio_id, affected.payer_id
)
UPDATE public.billing_payers AS payer
SET balance_cents = balances.balance_cents,
    billing_status = CASE
        WHEN balances.balance_cents = 0 THEN 'current'
        ELSE 'past_due'
    END,
    updated_at = clock_timestamp()
FROM payer_balances AS balances
WHERE payer.id = balances.payer_id
  AND payer.studio_id = balances.studio_id;

DO $legacy_invoice_status_guard$
BEGIN
    IF EXISTS (
        SELECT 1 FROM public.billing_invoices
        WHERE status IN ('partially_refunded', 'refunded')
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '23514',
            MESSAGE = 'billing_invoice_legacy_refund_status_normalization_incomplete';
    END IF;
END;
$legacy_invoice_status_guard$;

ALTER TABLE public.billing_provider_operation_resources
    ADD COLUMN resource_version_sha256 TEXT,
    ADD CONSTRAINT billing_provider_operation_resources_version_exact CHECK (
        CASE
            WHEN (operation_type, resource_type) IN (
                ('payment.refund', 'payment'),
                ('payer.sync', 'payer')
            ) THEN resource_version_sha256 ~ '^[0-9a-f]{64}$'
            ELSE resource_version_sha256 IS NULL
        END
    );

CREATE FUNCTION private.billing_operation_resource_version_v31(
    p_operation_type TEXT,
    p_payment public.billing_payments,
    p_payer public.billing_payers,
    p_stripe_connected_account_id TEXT,
    p_connect_account_generation INTEGER
)
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
    SELECT encode(extensions.digest(convert_to(
        CASE p_operation_type
            WHEN 'payment.refund' THEN jsonb_build_object(
                'version', 1,
                'operation_type', p_operation_type,
                'studio_id', p_payment.studio_id,
                'payment_id', p_payment.id,
                'stripe_connected_account_id', p_stripe_connected_account_id,
                'connect_account_generation', p_connect_account_generation,
                'refunded_amount_cents', p_payment.refunded_amount_cents
            )::TEXT
            WHEN 'payer.sync' THEN jsonb_build_object(
                'version', 1,
                'operation_type', p_operation_type,
                'studio_id', p_payer.studio_id,
                'payer_id', p_payer.id,
                'stripe_connected_account_id', p_stripe_connected_account_id,
                'connect_account_generation', p_connect_account_generation,
                'display_name', p_payer.display_name,
                'email', p_payer.email,
                'phone', p_payer.phone,
                'address_line1', p_payer.address_line1,
                'address_city', p_payer.address_city,
                'address_state', p_payer.address_state,
                'address_zip', p_payer.address_zip
            )::TEXT
            ELSE NULL
        END,
        'UTF8'
    ), 'sha256'), 'hex');
$$;
ALTER FUNCTION private.billing_operation_resource_version_v31(
    TEXT,public.billing_payments,public.billing_payers,TEXT,INTEGER
) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.billing_operation_resource_version_v31(
    TEXT,public.billing_payments,public.billing_payers,TEXT,INTEGER
) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION private.preserve_billing_provider_operation_resource_v1()
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
    IF v_new_state IS DISTINCT FROM 'started'
       OR NOT (
            v_old_state IN ('definitive_failed', 'definitive_rejected')
            OR (
                v_old_state = 'completed'
                AND OLD.resource_version_sha256 IS NOT NULL
                AND NEW.resource_version_sha256 IS NOT NULL
                AND NEW.resource_version_sha256 IS DISTINCT FROM
                    OLD.resource_version_sha256
            )
       ) THEN
        RAISE EXCEPTION USING ERRCODE = '23514',
            MESSAGE = 'billing_provider_operation_resource_replacement_invalid';
    END IF;
    RETURN NEW;
END;
$$;
ALTER FUNCTION private.preserve_billing_provider_operation_resource_v1()
    OWNER TO postgres;
REVOKE ALL ON FUNCTION private.preserve_billing_provider_operation_resource_v1()
    FROM PUBLIC,anon,authenticated,service_role;

ALTER TABLE public.billing_provider_operation_resources
    DROP CONSTRAINT billing_provider_operation_resources_pair_exact,
    ADD CONSTRAINT billing_provider_operation_resources_pair_exact CHECK (
        (operation_type = 'invoice.retry' AND resource_type = 'invoice')
        OR (operation_type = 'invoice.finalize' AND resource_type = 'invoice_finalize')
        OR (operation_type = 'invoice.void' AND resource_type = 'invoice_void')
        OR (operation_type = 'payment.refund' AND resource_type = 'payment')
        OR (operation_type = 'payer.sync' AND resource_type = 'payer')
        OR (operation_type IN ('enrollment.activate.autopay','enrollment.activate.invoice')
            AND resource_type = 'enrollment')
    );
ALTER TABLE public.billing_provider_operation_resource_aliases
    DROP CONSTRAINT billing_provider_operation_resource_aliases_pair_exact,
    ADD CONSTRAINT billing_provider_operation_resource_aliases_pair_exact CHECK (
        (operation_type = 'invoice.retry' AND resource_type = 'invoice')
        OR (operation_type = 'invoice.finalize' AND resource_type = 'invoice_finalize')
        OR (operation_type = 'invoice.void' AND resource_type = 'invoice_void')
        OR (operation_type = 'payment.refund' AND resource_type = 'payment')
        OR (operation_type = 'payer.sync' AND resource_type = 'payer')
        OR (operation_type IN ('enrollment.activate.autopay','enrollment.activate.invoice')
            AND resource_type = 'enrollment')
    );

ALTER FUNCTION public.claim_billing_provider_operation_resource_v1(
    UUID,UUID,TEXT,TEXT,UUID,UUID,TEXT,TEXT,TEXT,INTEGER,UUID,INTEGER
) RENAME TO claim_billing_provider_operation_resource_v30;
REVOKE ALL ON FUNCTION public.claim_billing_provider_operation_resource_v30(
    UUID,UUID,TEXT,TEXT,UUID,UUID,TEXT,TEXT,TEXT,INTEGER,UUID,INTEGER
) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION private.claim_payment_payer_operation_resource_v31(
    p_studio_id UUID,p_actor_id UUID,p_operation_type TEXT,p_resource_type TEXT,
    p_resource_id UUID,p_payer_id UUID,p_caller_request_key TEXT,p_request_sha256 TEXT,
    p_stripe_connected_account_id TEXT,p_connect_account_generation INTEGER,
    p_lease_owner UUID,p_lease_seconds INTEGER DEFAULT 30
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
    v_payment public.billing_payments%ROWTYPE;
    v_refund public.billing_refunds%ROWTYPE;
    v_payer public.billing_payers%ROWTYPE;
    v_account public.studio_payment_accounts%ROWTYPE;
    v_resource public.billing_provider_operation_resources%ROWTYPE;
    v_alias public.billing_provider_operation_resource_aliases%ROWTYPE;
    v_operation public.billing_provider_operations%ROWTYPE;
    v_existing_key_operation_id UUID;
    v_current_resource_version TEXT;
    v_now TIMESTAMPTZ:=clock_timestamp();
    v_outcome TEXT;
BEGIN
    IF p_studio_id IS NULL OR p_actor_id IS NULL OR p_resource_id IS NULL
       OR p_payer_id IS NULL OR p_lease_owner IS NULL
       OR NOT ((p_operation_type='payment.refund' AND p_resource_type='payment')
            OR (p_operation_type='payer.sync' AND p_resource_type='payer'))
       OR p_request_sha256 !~ '^[0-9a-f]{64}$'
       OR p_connect_account_generation<=0
       OR octet_length(p_stripe_connected_account_id) NOT BETWEEN 1 AND 255
       OR octet_length(p_caller_request_key) NOT BETWEEN 1 AND 255
       OR p_caller_request_key IS DISTINCT FROM btrim(p_caller_request_key)
       OR p_caller_request_key~'[[:cntrl:]]'
       OR p_lease_seconds NOT BETWEEN 5 AND 300 THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='billing_provider_operation_resource_claim_invalid';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.staff_roles
        WHERE studio_id=p_studio_id AND user_id=p_actor_id
          AND archived_at IS NULL AND role='admin') THEN
        RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='billing_provider_operation_actor_not_active';
    END IF;

    IF p_resource_type='payment' THEN
        SELECT * INTO v_payment FROM public.billing_payments
        WHERE id=p_resource_id AND studio_id=p_studio_id FOR UPDATE;
        IF v_payment.id IS NULL OR v_payment.payer_id IS DISTINCT FROM p_payer_id
           OR v_payment.stripe_account_id IS DISTINCT FROM p_stripe_connected_account_id
           OR v_payment.connect_account_generation IS DISTINCT FROM p_connect_account_generation
           OR v_payment.stripe_charge_id IS NULL THEN
            RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='billing_provider_operation_resource_payment_identity_mismatch';
        END IF;
    ELSIF p_resource_id IS DISTINCT FROM p_payer_id THEN
        RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='billing_provider_operation_resource_payer_identity_mismatch';
    END IF;
    SELECT * INTO v_payer FROM public.billing_payers
    WHERE id=p_payer_id AND studio_id=p_studio_id FOR UPDATE;
    SELECT * INTO v_account FROM public.studio_payment_accounts
    WHERE studio_id=p_studio_id FOR UPDATE;
    IF v_payer.id IS NULL OR v_account.studio_id IS NULL
       OR v_account.stripe_connected_account_id IS DISTINCT FROM p_stripe_connected_account_id
       OR private.current_connect_account_generation(v_account.metadata)
            IS DISTINCT FROM p_connect_account_generation
       OR (p_resource_type='payment' AND (
            v_payer.stripe_account_id IS DISTINCT FROM p_stripe_connected_account_id
            OR v_payer.connect_account_generation IS DISTINCT FROM p_connect_account_generation))
       OR (p_resource_type='payer' AND NOT (
            (v_payer.stripe_account_id IS NULL AND v_payer.stripe_customer_id IS NULL
             AND v_payer.connect_account_generation IS NULL)
            OR (v_payer.stripe_account_id=p_stripe_connected_account_id
                AND v_payer.connect_account_generation=p_connect_account_generation))) THEN
        RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='billing_provider_operation_resource_payer_identity_mismatch';
    END IF;
    v_current_resource_version := private.billing_operation_resource_version_v31(
        p_operation_type,
        v_payment,
        v_payer,
        p_stripe_connected_account_id,
        p_connect_account_generation
    );
    IF v_current_resource_version !~ '^[0-9a-f]{64}$' THEN
        RAISE EXCEPTION USING ERRCODE='23514',
            MESSAGE='billing_provider_operation_resource_version_invalid';
    END IF;

    SELECT * INTO v_resource FROM public.billing_provider_operation_resources
    WHERE studio_id=p_studio_id AND resource_type=p_resource_type
      AND resource_id=p_resource_id FOR UPDATE;
    IF v_resource.id IS NOT NULL AND (
        v_resource.operation_type IS DISTINCT FROM p_operation_type
        OR v_resource.payer_id IS DISTINCT FROM p_payer_id) THEN
        RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='billing_provider_operation_resource_request_conflict';
    END IF;
    SELECT * INTO v_alias FROM public.billing_provider_operation_resource_aliases
    WHERE studio_id=p_studio_id AND operation_type=p_operation_type
      AND caller_request_key=p_caller_request_key FOR UPDATE;
    IF FOUND THEN
        IF v_resource.id IS NULL OR v_alias.resource_claim_id IS DISTINCT FROM v_resource.id
           OR v_alias.resource_type IS DISTINCT FROM p_resource_type
           OR v_alias.resource_id IS DISTINCT FROM p_resource_id
           OR v_alias.payer_id IS DISTINCT FROM p_payer_id THEN
            RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='billing_provider_operation_resource_alias_conflict';
        END IF;
        SELECT * INTO v_operation FROM public.billing_provider_operations
        WHERE id=v_alias.operation_id FOR UPDATE;
        IF v_operation.actor_id IS DISTINCT FROM p_actor_id THEN
            RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='billing_provider_operation_resource_actor_conflict';
        END IF;
        IF v_operation.request_sha256 IS DISTINCT FROM p_request_sha256
           OR v_operation.stripe_connected_account_id IS DISTINCT FROM p_stripe_connected_account_id
           OR v_operation.connect_account_generation IS DISTINCT FROM p_connect_account_generation THEN
            RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='billing_provider_operation_resource_request_conflict';
        END IF;
        IF v_operation.state IN ('started','recovery_authorized','provider_succeeded','projected')
           AND (v_operation.lease_owner IS NULL OR v_operation.lease_owner=p_lease_owner
                OR v_operation.lease_expires_at<=v_now) THEN
            UPDATE public.billing_provider_operations SET lease_owner=p_lease_owner,
                lease_acquired_at=v_now,lease_expires_at=v_now+make_interval(secs=>p_lease_seconds),
                revision=revision+1,updated_at=v_now WHERE id=v_operation.id
            RETURNING * INTO v_operation;
        END IF;
        RETURN private.billing_provider_operation_resource_json_v1(
            v_resource,v_operation,p_caller_request_key,'replay');
    END IF;

    IF v_resource.id IS NULL THEN
        INSERT INTO public.billing_provider_operations(studio_id,actor_id,operation_type,
            caller_request_key,request_sha256,stripe_connected_account_id,
            connect_account_generation,lease_owner,lease_acquired_at,lease_expires_at,
            started_at,created_at,updated_at)
        VALUES(p_studio_id,p_actor_id,p_operation_type,p_caller_request_key,p_request_sha256,
            p_stripe_connected_account_id,p_connect_account_generation,p_lease_owner,v_now,
            v_now+make_interval(secs=>p_lease_seconds),v_now,v_now,v_now)
        RETURNING * INTO v_operation;
        INSERT INTO public.billing_provider_operation_resources(operation_id,studio_id,
            operation_type,resource_type,resource_id,payer_id,
            resource_version_sha256,created_at,updated_at)
        VALUES(v_operation.id,p_studio_id,p_operation_type,p_resource_type,p_resource_id,
            p_payer_id,v_current_resource_version,v_now,v_now)
        RETURNING * INTO v_resource;
        INSERT INTO public.billing_provider_operation_resource_aliases(resource_claim_id,
            operation_id,studio_id,operation_type,resource_type,resource_id,payer_id,
            caller_request_key,created_at)
        VALUES(v_resource.id,v_operation.id,p_studio_id,p_operation_type,p_resource_type,
            p_resource_id,p_payer_id,p_caller_request_key,v_now);
        RETURN private.billing_provider_operation_resource_json_v1(
            v_resource,v_operation,p_caller_request_key,'claimed');
    END IF;

    SELECT * INTO v_operation FROM public.billing_provider_operations
    WHERE id=v_resource.operation_id FOR UPDATE;
    IF v_operation.state IN ('definitive_failed','definitive_rejected') THEN
        INSERT INTO public.billing_provider_operations(studio_id,actor_id,operation_type,
            caller_request_key,request_sha256,stripe_connected_account_id,
            connect_account_generation,lease_owner,lease_acquired_at,lease_expires_at,
            started_at,created_at,updated_at)
        VALUES(p_studio_id,p_actor_id,p_operation_type,p_caller_request_key,p_request_sha256,
            p_stripe_connected_account_id,p_connect_account_generation,p_lease_owner,v_now,
            v_now+make_interval(secs=>p_lease_seconds),v_now,v_now,v_now)
        RETURNING * INTO v_operation;
        UPDATE public.billing_provider_operation_resources SET operation_id=v_operation.id,
            resource_version_sha256=v_current_resource_version,
            revision=revision+1,updated_at=v_now
        WHERE id=v_resource.id RETURNING * INTO v_resource;
        INSERT INTO public.billing_provider_operation_resource_aliases(resource_claim_id,
            operation_id,studio_id,operation_type,resource_type,resource_id,payer_id,
            caller_request_key,created_at)
        VALUES(v_resource.id,v_operation.id,p_studio_id,p_operation_type,p_resource_type,
            p_resource_id,p_payer_id,p_caller_request_key,v_now);
        RETURN private.billing_provider_operation_resource_json_v1(
            v_resource,v_operation,p_caller_request_key,'replaced');
    END IF;
    IF v_operation.actor_id IS DISTINCT FROM p_actor_id THEN
        RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='billing_provider_operation_resource_actor_conflict';
    END IF;
    IF v_operation.state='completed'
       AND v_resource.resource_version_sha256 IS DISTINCT FROM
            v_current_resource_version THEN
        IF p_resource_type='payment' THEN
            SELECT * INTO v_refund FROM public.billing_refunds WHERE studio_id=p_studio_id
              AND payment_id=p_resource_id AND stripe_refund_id=v_operation.provider_object_id
              AND stripe_account_id=p_stripe_connected_account_id
              AND connect_account_generation=p_connect_account_generation
              AND reconciliation_required IS NOT TRUE ORDER BY created_at,id LIMIT 1 FOR UPDATE;
            IF v_refund.id IS NULL THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='billing_provider_operation_resource_prior_projection_unverified'; END IF;
        ELSIF v_payer.stripe_customer_id IS DISTINCT FROM v_operation.provider_object_id THEN
            RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='billing_provider_operation_resource_prior_projection_unverified';
        END IF;
        INSERT INTO public.billing_provider_operations(studio_id,actor_id,operation_type,caller_request_key,request_sha256,stripe_connected_account_id,connect_account_generation,lease_owner,lease_acquired_at,lease_expires_at,started_at,created_at,updated_at)
        VALUES(p_studio_id,p_actor_id,p_operation_type,p_caller_request_key,p_request_sha256,p_stripe_connected_account_id,p_connect_account_generation,p_lease_owner,v_now,v_now+make_interval(secs=>p_lease_seconds),v_now,v_now,v_now) RETURNING * INTO v_operation;
        UPDATE public.billing_provider_operation_resources
        SET operation_id=v_operation.id,
            resource_version_sha256=v_current_resource_version,
            revision=revision+1,
            updated_at=v_now
        WHERE id=v_resource.id RETURNING * INTO v_resource;
        INSERT INTO public.billing_provider_operation_resource_aliases(resource_claim_id,operation_id,studio_id,operation_type,resource_type,resource_id,payer_id,caller_request_key,created_at)
        VALUES(v_resource.id,v_operation.id,p_studio_id,p_operation_type,p_resource_type,p_resource_id,p_payer_id,p_caller_request_key,v_now);
        RETURN private.billing_provider_operation_resource_json_v1(v_resource,v_operation,p_caller_request_key,'replaced');
    END IF;
    IF v_resource.resource_version_sha256 IS DISTINCT FROM
       v_current_resource_version THEN
        RAISE EXCEPTION USING ERRCODE='23505',
            MESSAGE='billing_provider_operation_resource_version_conflict';
    END IF;
    IF v_operation.request_sha256 IS DISTINCT FROM p_request_sha256
       OR v_operation.stripe_connected_account_id IS DISTINCT FROM p_stripe_connected_account_id
       OR v_operation.connect_account_generation IS DISTINCT FROM p_connect_account_generation THEN
        RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='billing_provider_operation_resource_request_conflict';
    END IF;
    SELECT id INTO v_existing_key_operation_id FROM public.billing_provider_operations
    WHERE studio_id=p_studio_id AND operation_type=p_operation_type
      AND caller_request_key=p_caller_request_key;
    IF v_existing_key_operation_id IS NOT NULL
       AND v_existing_key_operation_id IS DISTINCT FROM v_operation.id THEN
        RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='billing_provider_operation_resource_alias_conflict';
    END IF;
    IF (SELECT count(*) FROM public.billing_provider_operation_resource_aliases
        WHERE operation_id=v_operation.id)>=64 THEN
        RAISE EXCEPTION USING ERRCODE='54000',MESSAGE='billing_provider_operation_resource_alias_limit';
    END IF;
    INSERT INTO public.billing_provider_operation_resource_aliases(resource_claim_id,
        operation_id,studio_id,operation_type,resource_type,resource_id,payer_id,
        caller_request_key,created_at)
    VALUES(v_resource.id,v_operation.id,p_studio_id,p_operation_type,p_resource_type,
        p_resource_id,p_payer_id,p_caller_request_key,v_now);
    IF v_operation.state IN ('started','recovery_authorized','provider_succeeded','projected')
       AND (v_operation.lease_owner IS NULL OR v_operation.lease_owner=p_lease_owner
            OR v_operation.lease_expires_at<=v_now) THEN
        UPDATE public.billing_provider_operations SET lease_owner=p_lease_owner,
            lease_acquired_at=v_now,lease_expires_at=v_now+make_interval(secs=>p_lease_seconds),
            revision=revision+1,updated_at=v_now WHERE id=v_operation.id
        RETURNING * INTO v_operation;
    END IF;
    v_outcome:=CASE WHEN v_operation.state='reconciliation_required' THEN 'reconciliation_required'
        WHEN v_operation.state='provider_request_in_flight' THEN 'provider_request_in_flight'
        ELSE 'adopted' END;
    RETURN private.billing_provider_operation_resource_json_v1(
        v_resource,v_operation,p_caller_request_key,v_outcome);
EXCEPTION WHEN unique_violation THEN
    IF SQLERRM IN (
        'billing_provider_operation_resource_request_conflict',
        'billing_provider_operation_resource_alias_conflict',
        'billing_provider_operation_resource_actor_conflict',
        'billing_provider_operation_resource_version_conflict'
    ) THEN
        RAISE;
    END IF;
    RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='billing_provider_operation_resource_alias_conflict';
END;
$$;
ALTER FUNCTION private.claim_payment_payer_operation_resource_v31(
    UUID,UUID,TEXT,TEXT,UUID,UUID,TEXT,TEXT,TEXT,INTEGER,UUID,INTEGER
) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.claim_payment_payer_operation_resource_v31(
    UUID,UUID,TEXT,TEXT,UUID,UUID,TEXT,TEXT,TEXT,INTEGER,UUID,INTEGER
) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.claim_billing_provider_operation_resource_v1(
    p_studio_id UUID,p_actor_id UUID,p_operation_type TEXT,p_resource_type TEXT,
    p_resource_id UUID,p_payer_id UUID,p_caller_request_key TEXT,p_request_sha256 TEXT,
    p_stripe_connected_account_id TEXT,p_connect_account_generation INTEGER,
    p_lease_owner UUID,p_lease_seconds INTEGER DEFAULT 30
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
    IF (p_operation_type,p_resource_type) IN (
        ('payment.refund','payment'),('payer.sync','payer')) THEN
        RETURN private.claim_payment_payer_operation_resource_v31(p_studio_id,p_actor_id,
            p_operation_type,p_resource_type,p_resource_id,p_payer_id,p_caller_request_key,
            p_request_sha256,p_stripe_connected_account_id,p_connect_account_generation,
            p_lease_owner,p_lease_seconds);
    END IF;
    RETURN public.claim_billing_provider_operation_resource_v30(p_studio_id,p_actor_id,
        p_operation_type,p_resource_type,p_resource_id,p_payer_id,p_caller_request_key,
        p_request_sha256,p_stripe_connected_account_id,p_connect_account_generation,
        p_lease_owner,p_lease_seconds);
END;
$$;
ALTER FUNCTION public.claim_billing_provider_operation_resource_v1(
    UUID,UUID,TEXT,TEXT,UUID,UUID,TEXT,TEXT,TEXT,INTEGER,UUID,INTEGER
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.claim_billing_provider_operation_resource_v1(
    UUID,UUID,TEXT,TEXT,UUID,UUID,TEXT,TEXT,TEXT,INTEGER,UUID,INTEGER
) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.claim_billing_provider_operation_resource_v1(
    UUID,UUID,TEXT,TEXT,UUID,UUID,TEXT,TEXT,TEXT,INTEGER,UUID,INTEGER
) TO service_role;

CREATE FUNCTION public.disable_billing_payer_autopay_v1(
    p_studio_id UUID,
    p_payer_id UUID,
    p_actor_id UUID,
    p_disabled_at TIMESTAMPTZ,
    p_reason_code TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_payer public.billing_payers%ROWTYPE;
    v_active_consent public.billing_payer_payment_consents%ROWTYPE;
    v_now TIMESTAMPTZ := clock_timestamp();
    v_outcome TEXT := 'disabled';
BEGIN
    IF p_studio_id IS NULL OR p_payer_id IS NULL OR p_actor_id IS NULL
       OR p_disabled_at IS NULL
       OR p_disabled_at < v_now - interval '5 minutes'
       OR p_disabled_at > v_now + interval '5 minutes'
       OR p_reason_code IS DISTINCT FROM 'staff_disabled_autopay' THEN
        RAISE EXCEPTION USING ERRCODE = '22023',
            MESSAGE = 'billing_payer_autopay_disable_invalid';
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
            MESSAGE = 'billing_payer_autopay_disable_actor_invalid';
    END IF;

    -- Match every payer-setup writer's operation -> payer -> request -> consent
    -- order. Multiple historical setup operations are locked by immutable UUID.
    PERFORM 1
    FROM public.billing_provider_operations AS operation
    JOIN public.billing_payer_setup_requests AS request
      ON request.operation_id = operation.id
    WHERE request.studio_id = p_studio_id
      AND request.payer_id = p_payer_id
    ORDER BY operation.id
    FOR UPDATE OF operation;

    SELECT * INTO v_payer
    FROM public.billing_payers AS payer
    WHERE payer.id = p_payer_id
      AND payer.studio_id = p_studio_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0002',
            MESSAGE = 'billing_payer_autopay_disable_payer_not_found';
    END IF;

    PERFORM 1
    FROM public.billing_payer_setup_requests AS request
    WHERE request.studio_id = p_studio_id
      AND request.payer_id = p_payer_id
    ORDER BY request.id
    FOR UPDATE;
    PERFORM 1
    FROM public.billing_payer_payment_consents AS consent
    WHERE consent.studio_id = p_studio_id
      AND consent.payer_id = p_payer_id
    ORDER BY consent.id
    FOR UPDATE;
    PERFORM 1
    FROM public.billing_subscriptions AS subscription
    WHERE subscription.studio_id = p_studio_id
      AND subscription.payer_id = p_payer_id
    ORDER BY subscription.id
    FOR UPDATE;

    IF EXISTS (
        SELECT 1
        FROM public.billing_subscriptions AS subscription
        WHERE subscription.studio_id = p_studio_id
          AND subscription.payer_id = p_payer_id
          AND subscription.collection_mode = 'autopay'
          AND subscription.status IN (
              'pending', 'trialing', 'active', 'incomplete', 'past_due'
          )
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '55000',
            MESSAGE = 'billing_payer_autopay_disable_subscription_active';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.billing_payer_setup_requests AS request
        JOIN public.billing_provider_operations AS operation
          ON operation.id = request.operation_id
        WHERE request.studio_id = p_studio_id
          AND request.payer_id = p_payer_id
          AND request.completed_at IS NULL
          AND request.revoked_at IS NULL
          AND request.superseded_at IS NULL
          AND (
              operation.state IN (
                  'provider_request_in_flight',
                  'reconciliation_required',
                  'recovery_authorized'
              )
              OR (
                  request.setup_request_expires_at > v_now
                  AND operation.state IN (
                      'started', 'provider_succeeded', 'projected'
                  )
              )
              OR EXISTS (
                  SELECT 1
                  FROM public.billing_payer_payment_consents AS consent
                  WHERE consent.setup_request_id = request.id
                    AND consent.completed_at IS NULL
                    AND consent.revoked_at IS NULL
                    AND consent.superseded_at IS NULL
              )
          )
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '55000',
            MESSAGE = 'billing_payer_autopay_disable_setup_pending';
    END IF;

    SELECT * INTO v_active_consent
    FROM public.billing_payer_payment_consents AS consent
    WHERE consent.studio_id = p_studio_id
      AND consent.payer_id = p_payer_id
      AND consent.completed_at IS NOT NULL
      AND consent.revoked_at IS NULL
      AND consent.superseded_at IS NULL
    ORDER BY consent.id
    LIMIT 1;

    IF v_payer.autopay_status = 'disabled'
       AND v_active_consent.id IS NULL THEN
        v_outcome := 'replay';
    ELSE
        IF v_active_consent.id IS NOT NULL THEN
            UPDATE public.billing_payer_payment_consents
            SET revoked_at = p_disabled_at,
                revoked_by = p_actor_id,
                revocation_reason_code = p_reason_code,
                revocation_proof_sha256 = NULL,
                revision = revision + 1,
                updated_at = v_now
            WHERE id = v_active_consent.id
            RETURNING * INTO v_active_consent;
            UPDATE public.billing_payer_setup_requests
            SET revoked_at = p_disabled_at,
                revision = revision + 1,
                updated_at = v_now
            WHERE id = v_active_consent.setup_request_id
              AND revoked_at IS NULL
              AND superseded_at IS NULL;
        END IF;
        UPDATE public.billing_payers
        SET autopay_status = 'disabled',
            autopay_disabled_at = p_disabled_at,
            updated_at = v_now
        WHERE id = p_payer_id
          AND studio_id = p_studio_id
        RETURNING * INTO v_payer;
    END IF;

    RETURN jsonb_build_object(
        'outcome', v_outcome,
        'payer', to_jsonb(v_payer),
        'revoked_consent_id', v_active_consent.id
    );
END;
$$;
ALTER FUNCTION public.disable_billing_payer_autopay_v1(
    UUID,UUID,UUID,TIMESTAMPTZ,TEXT
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.disable_billing_payer_autopay_v1(
    UUID,UUID,UUID,TIMESTAMPTZ,TEXT
) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.disable_billing_payer_autopay_v1(
    UUID,UUID,UUID,TIMESTAMPTZ,TEXT
) TO service_role;

CREATE OR REPLACE FUNCTION public.claim_due_billing_enrollment_transitions_v1(
    p_worker_id UUID, p_lease_seconds INTEGER DEFAULT 30, p_limit INTEGER DEFAULT 25
) RETURNS SETOF public.billing_enrollment_transition_intents
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
    v_candidate RECORD;
    v_enrollment public.student_billing_enrollments%ROWTYPE;
    v_schedule public.billing_enrollment_transition_intents%ROWTYPE;
    v_execute public.billing_enrollment_transition_intents%ROWTYPE;
    v_operation public.billing_provider_operations%ROWTYPE;
    v_now TIMESTAMPTZ;
    v_provider_key TEXT;
    v_provider_hash TEXT;
    v_returned INTEGER:=0;
BEGIN
    IF p_worker_id IS NULL OR p_lease_seconds NOT BETWEEN 5 AND 300
       OR p_limit NOT BETWEEN 1 AND 100 THEN
        RAISE EXCEPTION USING ERRCODE='22023',
            MESSAGE='billing_enrollment_transition_due_claim_invalid';
    END IF;
    FOR v_candidate IN
        SELECT intent.id,intent.enrollment_id
        FROM public.billing_enrollment_transition_intents AS intent
        WHERE intent.transition_kind='schedule_period_end'
          AND intent.state IN ('scheduled','due_claimed')
          AND intent.period_boundary<=clock_timestamp()
          AND NOT EXISTS (
            SELECT 1 FROM public.billing_enrollment_transition_intents AS revoke
            WHERE revoke.source_intent_id=intent.id
              AND revoke.transition_kind='revoke_scheduled'
              AND revoke.state NOT IN ('completed','revoked','definitive_rejected')
          )
        ORDER BY intent.period_boundary,intent.id
        LIMIT p_limit*4
    LOOP
        v_now:=clock_timestamp();
        SELECT * INTO v_enrollment FROM public.student_billing_enrollments
        WHERE id=v_candidate.enrollment_id FOR UPDATE SKIP LOCKED;
        IF NOT FOUND THEN
            CONTINUE;
        END IF;
        SELECT * INTO v_schedule
        FROM public.billing_enrollment_transition_intents AS intent
        WHERE intent.id=v_candidate.id
          AND intent.transition_kind='schedule_period_end'
          AND intent.state IN ('scheduled','due_claimed')
          AND intent.period_boundary<=v_now
          AND NOT EXISTS (
            SELECT 1 FROM public.billing_enrollment_transition_intents AS revoke
            WHERE revoke.source_intent_id=intent.id
              AND revoke.transition_kind='revoke_scheduled'
              AND revoke.state NOT IN ('completed','revoked','definitive_rejected')
          )
        FOR UPDATE SKIP LOCKED;
        IF NOT FOUND THEN
            CONTINUE;
        END IF;
        SELECT * INTO v_execute
        FROM public.billing_enrollment_transition_intents AS execute
        WHERE execute.source_intent_id=v_schedule.id
          AND execute.transition_kind='execute_due'
        ORDER BY execute.created_at DESC,execute.id DESC
        LIMIT 1 FOR UPDATE;
        IF FOUND THEN
            IF v_execute.state='due_claimed'
               AND v_execute.lease_expires_at<=v_now THEN
                IF v_execute.provider_operation_id IS NOT NULL THEN
                    SELECT * INTO v_operation FROM public.billing_provider_operations
                    WHERE id=v_execute.provider_operation_id
                      AND studio_id=v_execute.studio_id FOR UPDATE;
                    IF v_operation.id IS NULL
                       OR v_operation.operation_type<>'enrollment.cancel.period_end.execute'
                       OR v_operation.state NOT IN ('started','provider_succeeded','projected') THEN
                        CONTINUE;
                    END IF;
                    UPDATE public.billing_provider_operations
                    SET lease_owner=p_worker_id,lease_acquired_at=v_now,
                        lease_expires_at=v_now+make_interval(secs=>p_lease_seconds),
                        revision=revision+1,updated_at=v_now
                    WHERE id=v_operation.id;
                END IF;
                UPDATE public.billing_enrollment_transition_intents
                SET lease_owner=p_worker_id,lease_acquired_at=v_now,
                    lease_expires_at=v_now+make_interval(secs=>p_lease_seconds),
                    revision=revision+1,updated_at=v_now
                WHERE id=v_execute.id RETURNING * INTO v_execute;
                RETURN NEXT v_execute;
                v_returned:=v_returned+1;
                EXIT WHEN v_returned>=p_limit;
            END IF;
            CONTINUE;
        END IF;
        IF v_schedule.state<>'scheduled' THEN
            CONTINUE;
        END IF;
        v_provider_key:='enrollment-period-execute:'||v_schedule.id::TEXT;
        v_provider_hash:=encode(extensions.digest(convert_to(jsonb_build_object(
            'source_intent_id',v_schedule.id,
            'studio_id',v_schedule.studio_id,
            'enrollment_id',v_schedule.enrollment_id,
            'payer_id',v_schedule.payer_id,
            'billing_subscription_id',v_schedule.billing_subscription_id,
            'mutation_strategy',v_schedule.mutation_strategy,
            'stripe_connected_account_id',v_schedule.stripe_connected_account_id,
            'connect_account_generation',v_schedule.connect_account_generation,
            'stripe_subscription_id',v_schedule.stripe_subscription_id,
            'stripe_subscription_item_id',v_schedule.stripe_subscription_item_id,
            'period_boundary',v_schedule.period_boundary,
            'expected_quantity',v_schedule.expected_quantity,
            'expected_subscription_item_count',v_schedule.expected_subscription_item_count,
            'same_item_active_count',v_schedule.same_item_active_count,
            'provider_quantity',v_schedule.provider_quantity
        )::TEXT,'UTF8'),'sha256'),'hex');
        INSERT INTO public.billing_enrollment_transition_intents(
            studio_id,enrollment_id,payer_id,billing_subscription_id,
            source_intent_id,transition_kind,mutation_strategy,request_sha256,
            provider_caller_request_key,provider_request_sha256,
            stripe_connected_account_id,connect_account_generation,
            stripe_subscription_id,stripe_subscription_item_id,period_boundary,
            expected_quantity,expected_subscription_item_count,same_item_active_count,
            provider_quantity,initiated_by,reason_code,state,lease_owner,
            lease_acquired_at,lease_expires_at,due_claimed_at,created_at,updated_at
        ) VALUES (
            v_schedule.studio_id,v_schedule.enrollment_id,v_schedule.payer_id,
            v_schedule.billing_subscription_id,v_schedule.id,'execute_due',
            v_schedule.mutation_strategy,v_schedule.request_sha256,
            CASE WHEN v_schedule.mutation_strategy='subscription_item_delete_at_period_end'
                THEN v_provider_key END,
            CASE WHEN v_schedule.mutation_strategy='subscription_item_delete_at_period_end'
                THEN v_provider_hash END,
            v_schedule.stripe_connected_account_id,v_schedule.connect_account_generation,
            v_schedule.stripe_subscription_id,v_schedule.stripe_subscription_item_id,
            v_schedule.period_boundary,v_schedule.expected_quantity,
            v_schedule.expected_subscription_item_count,v_schedule.same_item_active_count,
            v_schedule.provider_quantity,v_schedule.initiated_by,v_schedule.reason_code,
            'due_claimed',p_worker_id,v_now,
            v_now+make_interval(secs=>p_lease_seconds),v_now,v_now,v_now
        ) RETURNING * INTO v_execute;
        UPDATE public.billing_enrollment_transition_intents
        SET state='due_claimed',due_claimed_at=v_now,revision=revision+1,updated_at=v_now
        WHERE id=v_schedule.id;
        RETURN NEXT v_execute;
        v_returned:=v_returned+1;
        EXIT WHEN v_returned>=p_limit;
    END LOOP;
END;
$$;
ALTER FUNCTION public.claim_due_billing_enrollment_transitions_v1(UUID,INTEGER,INTEGER)
    OWNER TO postgres;
REVOKE ALL ON FUNCTION public.claim_due_billing_enrollment_transitions_v1(
    UUID,INTEGER,INTEGER
) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.claim_due_billing_enrollment_transitions_v1(
    UUID,INTEGER,INTEGER
) TO service_role;

CREATE FUNCTION private.koaryu_release_resource_ownership_manifest_v31()
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
    WITH required_functions(
        signature, security_definer, service_execute, expected_configuration
    ) AS (
        VALUES
            ('private.billing_operation_resource_version_v31(text,public.billing_payments,public.billing_payers,text,integer)', false, false, 'search_path=pg_catalog'),
            ('private.claim_payment_payer_operation_resource_v31(uuid,uuid,text,text,uuid,uuid,text,text,text,integer,uuid,integer)', true, false, 'search_path=""'),
            ('private.enforce_billing_payer_connect_identity_v1()', true, false, 'search_path=""'),
            ('private.enforce_billing_provider_step_parent_v1()', false, false, 'search_path=""'),
            ('private.preserve_billing_provider_operation_resource_alias_v1()', false, false, 'search_path=""'),
            ('private.preserve_billing_provider_operation_resource_v1()', false, false, 'search_path=""'),
            ('private.preserve_billing_provider_operation_step_v1()', false, false, 'search_path=""'),
            ('private.validate_billing_payment_identity_change()', false, false, 'search_path=""'),
            ('public.claim_billing_provider_operation_resource_v1(uuid,uuid,text,text,uuid,uuid,text,text,text,integer,uuid,integer)', true, true, 'search_path=""'),
            ('public.claim_billing_provider_operation_resource_v30(uuid,uuid,text,text,uuid,uuid,text,text,text,integer,uuid,integer)', true, false, 'search_path=""'),
            ('public.claim_due_billing_enrollment_transitions_v1(uuid,integer,integer)', true, true, 'search_path=""'),
            ('public.disable_billing_payer_autopay_v1(uuid,uuid,uuid,timestamp with time zone,text)', true, true, 'search_path=""'),
            ('public.finalize_billing_payer_setup_projection_v1(uuid,uuid,uuid,uuid,uuid,text,text,text,integer)', true, true, 'search_path=""')
    ), function_state AS (
        SELECT
            required.signature,
            procedure.oid,
            owner.rolname AS owner_name,
            procedure.prosecdef,
            COALESCE(array_to_string(procedure.proconfig, ','), '') AS configuration,
            has_function_privilege('service_role', procedure.oid, 'EXECUTE') AS service_execute,
            has_function_privilege('anon', procedure.oid, 'EXECUTE') AS anon_execute,
            has_function_privilege('authenticated', procedure.oid, 'EXECUTE') AS auth_execute,
            EXISTS (
                SELECT 1
                FROM aclexplode(COALESCE(
                    procedure.proacl,
                    acldefault('f', procedure.proowner)
                )) AS privilege
                WHERE privilege.grantee = 0
                  AND privilege.privilege_type = 'EXECUTE'
            ) AS public_execute,
            required.security_definer AS expected_security_definer,
            required.service_execute AS expected_service_execute,
            required.expected_configuration,
            COALESCE(pg_get_functiondef(procedure.oid), '') AS definition
        FROM required_functions AS required
        LEFT JOIN pg_proc AS procedure
          ON procedure.oid = to_regprocedure(required.signature)
        LEFT JOIN pg_roles AS owner ON owner.oid = procedure.proowner
    ), constraint_state AS (
        SELECT
            relation.relname || '.' || constraint_state.conname || ':' ||
            pg_get_constraintdef(constraint_state.oid) AS definition
        FROM pg_constraint AS constraint_state
        JOIN pg_class AS relation ON relation.oid = constraint_state.conrelid
        WHERE constraint_state.conname IN (
            'billing_provider_operation_resources_pair_exact',
            'billing_provider_operation_resource_aliases_pair_exact',
            'billing_provider_operation_resources_version_exact'
        )
    ), object_state(category, value) AS (
        SELECT 'functions', string_agg(
            signature || ':' || COALESCE(owner_name, '') || ':' ||
            COALESCE(prosecdef::TEXT, '') || ':' || configuration || ':' ||
            COALESCE(service_execute::TEXT, '') || ':' ||
            COALESCE(anon_execute::TEXT, '') || ':' ||
            COALESCE(auth_execute::TEXT, '') || ':' ||
            COALESCE(public_execute::TEXT, '') || ':' || definition,
            '|' ORDER BY signature COLLATE "C"
        ) FROM function_state
        UNION ALL
        SELECT 'constraints', string_agg(
            definition, '|' ORDER BY definition COLLATE "C"
        ) FROM constraint_state
        UNION ALL
        SELECT 'legacy_invoice_status_count', count(*)::TEXT
        FROM public.billing_invoices
        WHERE status IN ('partially_refunded', 'refunded')
        UNION ALL
        SELECT 'inherited_manifests', string_agg(
            manifest_name || ':' || manifest_value,
            '|' ORDER BY manifest_name COLLATE "C"
        )
        FROM (VALUES
            ('critical_surface_v18', private.koaryu_release_critical_surface_manifest_v18()),
            ('enrollment_transition_v29', private.koaryu_release_enrollment_transition_manifest_v29()),
            ('live_billing_v25', private.koaryu_release_live_billing_v3_manifest_v25()),
            ('payment_adjustment_v26', private.koaryu_release_payment_adjustment_manifest_v26()),
            ('payments_replay_repairs_v30', private.koaryu_release_payments_replay_repairs_manifest_v30()),
            ('provider_operation_steps_v28', private.koaryu_release_provider_operation_steps_manifest_v28()),
            ('starting_belt_v9', private.koaryu_release_starting_belt_manifest_v9()),
            ('student_rank_writer_v13', private.koaryu_release_student_rank_writer_manifest_v13())
        ) AS inherited(manifest_name, manifest_value)
    )
    SELECT
        (SELECT count(*) FROM function_state
          WHERE oid IS NULL
             OR owner_name <> 'postgres'
             OR prosecdef IS DISTINCT FROM expected_security_definer
             OR configuration <> expected_configuration
             OR service_execute IS DISTINCT FROM expected_service_execute
             OR anon_execute OR auth_execute OR public_execute)
        + CASE WHEN (SELECT count(*) FROM constraint_state) = 3 THEN 0 ELSE 1 END
        + CASE WHEN EXISTS (
            SELECT 1 FROM public.billing_invoices
            WHERE status IN ('partially_refunded', 'refunded')
          ) THEN 1 ELSE 0 END,
        string_agg(
            category || '=' || COALESCE(value, ''),
            E'\n' ORDER BY category COLLATE "C"
        )
    INTO v_invalid, v_serialized
    FROM object_state;
    RETURN v_invalid::TEXT || ':' || encode(
        extensions.digest(
            convert_to(COALESCE(v_serialized, ''), 'UTF8'),
            'sha256'
        ),
        'hex'
    );
END;
$manifest$;
ALTER FUNCTION private.koaryu_release_resource_ownership_manifest_v31()
    OWNER TO postgres;
REVOKE ALL ON FUNCTION private.koaryu_release_resource_ownership_manifest_v31()
    FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION private.koaryu_release_operational_contract_v31()
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
SET "TimeZone" = 'UTC'
AS $$
    SELECT '0:' || encode(extensions.digest(convert_to(
        '0:' || (
            SELECT expected_sha256
            FROM private.koaryu_release_v30_expectations
            WHERE expectation_key = 'operational_contract_v30'
        ) || '|' ||
        private.koaryu_release_resource_ownership_manifest_v31(),
        'UTF8'
    ), 'sha256'), 'hex');
$$;
ALTER FUNCTION private.koaryu_release_operational_contract_v31() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.koaryu_release_operational_contract_v31()
    FROM PUBLIC,anon,authenticated,service_role;

CREATE TABLE private.koaryu_release_v31_expectations(
    expectation_key TEXT PRIMARY KEY
        CHECK (expectation_key = 'operational_contract_v31'),
    expected_sha256 TEXT NOT NULL CHECK (expected_sha256 ~ '^[0-9a-f]{64}$')
);
ALTER TABLE private.koaryu_release_v31_expectations OWNER TO postgres;
ALTER TABLE private.koaryu_release_v31_expectations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE private.koaryu_release_v31_expectations
    FROM PUBLIC,anon,authenticated,service_role;
INSERT INTO private.koaryu_release_v31_expectations(
    expectation_key, expected_sha256
) VALUES (
    'operational_contract_v31',
    'a6ba54bedd4ae2643cac443fad2abf684e406488e33330d401bb264a360e805a'
);

CREATE FUNCTION private.koaryu_release_operational_manifest_v12()
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
SET "TimeZone" = 'UTC'
AS $$
    SELECT encode(extensions.digest(convert_to(
        '1449e613ab87fea18e9f7678f96215d528b80b5d0c44c5da0f29323bdc392198' || '|' ||
        private.koaryu_release_resource_ownership_manifest_v31() || '|' ||
        private.koaryu_release_operational_contract_v31() || '|' ||
        (SELECT string_agg(
            expectation_key || ':' || expected_sha256,
            '|' ORDER BY expectation_key COLLATE "C"
         ) FROM private.koaryu_release_v31_expectations),
        'UTF8'
    ), 'sha256'), 'hex');
$$;
ALTER FUNCTION private.koaryu_release_operational_manifest_v12() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.koaryu_release_operational_manifest_v12()
    FROM PUBLIC,anon,authenticated,service_role;

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
    IF v_count <> 124 OR v_head <> '20260826185651' THEN
        v_failures := array_append(v_failures, 'migration_history_v31');
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
        '20260824190500','20260826030234','20260826030249','20260826051527',
        '20260826073728','20260826102840','20260826155911','20260826185651'
    ]::TEXT[] THEN
        v_failures := array_append(v_failures, 'migration_history_sequence_v31');
        v_failures := array_append(v_failures, 'migration_history_sequence_v30');
    END IF;
    IF private.koaryu_release_resource_ownership_manifest_v31()
       <> '0:88d995d82173f5ac5f42b424ec392ad1432000645265d68e9b71d2c0f829f36c' THEN
        v_failures := array_append(v_failures, 'resource_ownership_manifest_v31');
    END IF;
    SELECT expected_sha256 INTO v_expected
    FROM private.koaryu_release_v31_expectations
    WHERE expectation_key = 'operational_contract_v31';
    IF NOT FOUND
       OR (SELECT count(*) FROM private.koaryu_release_v31_expectations) <> 1
       OR private.koaryu_release_operational_contract_v31()
            IS DISTINCT FROM '0:' || v_expected THEN
        v_failures := array_append(v_failures, 'operational_contract_v31');
    END IF;
    SELECT expected_sha256 INTO v_expected
    FROM private.koaryu_release_v30_expectations
    WHERE expectation_key = 'operational_contract_v30';
    IF NOT FOUND
       OR (SELECT count(*) FROM private.koaryu_release_v30_expectations) <> 1
       OR v_expected <> '7d3b98ad5301ac1eb04eb1131f16f58158e37c3d4c7e01afbe427d46294ccd2a' THEN
        v_failures := array_append(v_failures, 'operational_contract_v30_expectation');
    END IF;
    SELECT expected_sha256 INTO v_expected
    FROM private.koaryu_release_v26_expectations
    WHERE expectation_key = 'operational_contract_v26';
    IF NOT FOUND
       OR (SELECT count(*) FROM private.koaryu_release_v26_expectations) <> 1
       OR v_expected <> '73cc55b6578a3c959ab117abecf8084f4b1e401cf4f31a410bb88389a1ee9aa0'
       OR has_table_privilege('service_role', 'private.koaryu_release_v26_expectations', 'SELECT')
       OR has_table_privilege('authenticated', 'private.koaryu_release_v26_expectations', 'SELECT')
       OR has_table_privilege('anon', 'private.koaryu_release_v26_expectations', 'SELECT') THEN
        v_failures := array_append(v_failures, 'operational_contract_v26_expectation');
    END IF;
    IF encode(extensions.digest(convert_to(
        (SELECT prosrc FROM pg_proc
         WHERE oid = 'public.koaryu_release_schema_preflight_v6()'::REGPROCEDURE),
        'UTF8'
    ), 'sha256'), 'hex')
       <> '7163977ae7d0a9436f3338f6a52622aaed46133e10036336f5dd9960fe6a6762' THEN
        v_failures := array_append(v_failures, 'schema_preflight_v6_body');
    END IF;
    IF private.koaryu_release_operational_contract_v26()
       <> '0:e8feb5956d506eb70db13babfc58a98ee9186bd85e3ee2e11d7a86fbb17c7ff4' THEN
        v_failures := array_append(v_failures, 'operational_contract_v26');
    END IF;
    IF private.koaryu_release_operational_contract_v27()
       <> '0:ce5468c6d727cb319654f89d347098c2107941b7597e7e4d50a22db4ce3ead9f' THEN
        v_failures := array_append(v_failures, 'operational_contract_v27');
    END IF;
    IF private.koaryu_release_operational_contract_v28()
       <> '0:473017cea92211b3525437654fd5f0a5c091ddc383c6609305bc443a86b6fb0d' THEN
        v_failures := array_append(v_failures, 'operational_contract_v28');
    END IF;
    IF private.koaryu_release_operational_contract_v29()
       <> '0:c59b390f0ce954c85ba5dececa24662ae8a00634101d7577b925d4e81f9e55ce' THEN
        v_failures := array_append(v_failures, 'operational_contract_v29');
    END IF;
    IF private.koaryu_release_operational_contract_v30()
       <> '0:7c44fe0cd9460e9c66fb4b83df08f377800c6f0ee27922979beadd18f8301948' THEN
        v_failures := array_append(v_failures, 'operational_contract_v30');
    END IF;
    IF encode(extensions.digest(convert_to(pg_get_functiondef(
        'private.koaryu_release_payments_replay_repairs_manifest_v30()'::REGPROCEDURE
    ), 'UTF8'), 'sha256'), 'hex')
       <> 'a70b46c8b13a88f51d795be3ae4bc759bcc14495fda1cab9629e5c9c86e66228' THEN
        v_failures := array_append(v_failures, 'payments_replay_repairs_manifest_v30_function');
    END IF;
    IF encode(extensions.digest(convert_to(pg_get_functiondef(
        'private.koaryu_release_operational_manifest_v11()'::REGPROCEDURE
    ), 'UTF8'), 'sha256'), 'hex')
       <> '79e338cb42307acf37e395647f29dbb88df57fa8d65443cc976a30c566cff6d2' THEN
        v_failures := array_append(v_failures, 'operational_manifest_v11_function');
    END IF;
    IF private.koaryu_release_operational_manifest_v11()
       <> '92efd06c3d43f6353aa72b7fd8a2b440ebeed8d200f15982f7ac809d78fa8498' THEN
        v_failures := array_append(v_failures, 'operational_manifest_v11');
    END IF;
    IF private.koaryu_release_provider_operation_steps_manifest_v28()
       <> '0:7f3821f26bcaf36cda41a699d66a29362537e82c28a04f1b23bc43a407b885be' THEN
        v_failures := array_append(v_failures, 'provider_operation_steps_manifest_v28');
        v_failures := array_append(v_failures, 'operational_contract_v28');
    END IF;
    IF private.koaryu_release_live_billing_v3_manifest_v25()
       <> '0:6934453003f86c2db9e84835d77a5261df6410fc93b24e8dfc78a332c815d265' THEN
        v_failures := array_append(v_failures, 'live_billing_v3_manifest_v25');
        v_failures := array_append(v_failures, 'operational_contract_v26');
        v_failures := array_append(v_failures, 'operational_contract_v27');
    END IF;
    IF encode(extensions.digest(convert_to(pg_get_functiondef(
        'private.koaryu_release_operational_manifest_v7()'::REGPROCEDURE
    ), 'UTF8'), 'sha256'), 'hex')
       <> '2615e19ea37158de13259f072419f7047440a2ad1065288e7b0056d21439f57f' THEN
        v_failures := array_append(v_failures, 'operational_manifest_v7_function');
    END IF;
    IF encode(extensions.digest(convert_to(pg_get_functiondef(
        'public.set_studio_live_billing_authorization_operations_v1(uuid,text,boolean,timestamp with time zone,text,uuid,text[],text,text)'::REGPROCEDURE
    ), 'UTF8'), 'sha256'), 'hex')
       <> '6500b8aaf8bb91cc91841f2bafaf3699b7ffa328ccaba4a0023721e3eb68f811' THEN
        v_failures := array_append(v_failures, 'operation_authorization_writer_function');
    END IF;
    IF has_function_privilege(
        'service_role',
        'public.set_studio_live_billing_authorization_scope_v3(uuid,text,boolean,timestamp with time zone,text,uuid,text,text)',
        'EXECUTE'
    ) THEN
        v_failures := array_append(v_failures, 'legacy_authorization_scope_execute');
    END IF;
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'public.studio_live_billing_authorizations'::REGCLASS
          AND conname = 'studio_live_billing_authorizations_operation_set_exact'
          AND convalidated
    ) THEN
        v_failures := array_append(v_failures, 'operation_allowlist_constraint');
    END IF;
    IF NOT EXISTS (
        SELECT 1
        FROM pg_attribute AS attribute
        LEFT JOIN pg_attrdef AS default_value
          ON default_value.adrelid = attribute.attrelid
         AND default_value.adnum = attribute.attnum
        WHERE attribute.attrelid = 'public.studio_live_billing_authorizations'::REGCLASS
          AND attribute.attname = 'allowed_operations'
          AND NOT attribute.attisdropped
          AND attribute.attnotnull
          AND format_type(attribute.atttypid, attribute.atttypmod) = 'text[]'
          AND pg_get_expr(default_value.adbin, default_value.adrelid) = 'ARRAY[]::text[]'
    ) THEN
        v_failures := array_append(v_failures, 'operation_allowlist_column');
    END IF;
    IF private.koaryu_release_operational_manifest_v12()
       <> 'd7b8f30fb72ad7b20308bf96711308d7d2d6b8ce4376c478cbb5b7f1eb3eb7e4' THEN
        v_failures := array_append(v_failures, 'operational_manifest_v12');
    END IF;
    IF encode(extensions.digest(convert_to(pg_get_functiondef(
        'private.koaryu_release_operational_manifest_v12()'::REGPROCEDURE
    ), 'UTF8'), 'sha256'), 'hex')
       <> '4922cbad03eff81973ea734ad9597a3608e8f1b08822e7eb21652ab57f219517' THEN
        v_failures := array_append(v_failures, 'operational_manifest_v12_function');
    END IF;
    RETURN QUERY SELECT cardinality(v_failures) = 0,
        v_count, v_head, COALESCE(v_pending, ARRAY[]::TEXT[]), v_failures,
        'release-db-attestation-v31'::TEXT;
END;
$$;
ALTER FUNCTION public.koaryu_release_schema_preflight_v11() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.koaryu_release_schema_preflight_v11()
    FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.koaryu_release_schema_preflight_v11()
    TO service_role;

CREATE OR REPLACE FUNCTION public.koaryu_release_schema_preflight_v10()
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
    v_current RECORD;
    v_expected TEXT;
    v_failures TEXT[] := ARRAY[]::TEXT[];
BEGIN
    SELECT * INTO v_current FROM public.koaryu_release_schema_preflight_v11();
    SELECT expected_sha256 INTO v_expected
    FROM private.koaryu_release_v30_expectations
    WHERE expectation_key = 'operational_contract_v30';
    IF NOT FOUND
       OR (SELECT count(*) FROM private.koaryu_release_v30_expectations) <> 1
       OR v_expected <> '7d3b98ad5301ac1eb04eb1131f16f58158e37c3d4c7e01afbe427d46294ccd2a' THEN
        v_failures := array_append(v_failures, 'operational_contract_v30_expectation');
    END IF;
    IF v_current.ready
       AND cardinality(v_failures) = 0
       AND v_current.migration_count = 124
       AND v_current.migration_head = '20260826185651' THEN
        RETURN QUERY SELECT true, 123, '20260826155911'::TEXT,
            v_current.pending_versions[1:cardinality(v_current.pending_versions)-1],
            ARRAY[]::TEXT[], 'release-db-attestation-v30'::TEXT;
        RETURN;
    END IF;
    RETURN QUERY SELECT false, v_current.migration_count, v_current.migration_head,
        v_current.pending_versions,
        COALESCE(v_current.security_failures, ARRAY[]::TEXT[]) || v_failures,
        'release-db-attestation-v30'::TEXT;
END;
$$;
ALTER FUNCTION public.koaryu_release_schema_preflight_v10() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.koaryu_release_schema_preflight_v10()
    FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.koaryu_release_schema_preflight_v10()
    TO service_role;

CREATE OR REPLACE FUNCTION public.koaryu_release_schema_preflight_v9()
RETURNS TABLE(ready BOOLEAN,migration_count INTEGER,migration_head TEXT,
    pending_versions TEXT[],security_failures TEXT[],manifest_version TEXT)
LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path=pg_catalog AS $$
DECLARE v_current RECORD;
BEGIN
    SELECT * INTO v_current FROM public.koaryu_release_schema_preflight_v10();
    IF v_current.ready
       AND v_current.migration_count = 123
       AND v_current.migration_head = '20260826155911' THEN
        RETURN QUERY SELECT true, 122, '20260826102840'::TEXT,
            v_current.pending_versions[1:cardinality(v_current.pending_versions)-1],
            ARRAY[]::TEXT[], 'release-db-attestation-v29'::TEXT;
        RETURN;
    END IF;
    RETURN QUERY SELECT false,v_current.migration_count,v_current.migration_head,
        v_current.pending_versions,v_current.security_failures,
        'release-db-attestation-v29'::TEXT;
END;
$$;
ALTER FUNCTION public.koaryu_release_schema_preflight_v9() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.koaryu_release_schema_preflight_v9()
    FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.koaryu_release_schema_preflight_v9() TO service_role;

CREATE OR REPLACE FUNCTION public.koaryu_release_schema_preflight_v8()
RETURNS TABLE(ready BOOLEAN,migration_count INTEGER,migration_head TEXT,
    pending_versions TEXT[],security_failures TEXT[],manifest_version TEXT)
LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path=pg_catalog AS $$
DECLARE v_current RECORD;
BEGIN
    SELECT * INTO v_current FROM public.koaryu_release_schema_preflight_v9();
    IF v_current.ready
       AND v_current.migration_count = 122
       AND v_current.migration_head = '20260826102840' THEN
        RETURN QUERY SELECT true, 121, '20260826073728'::TEXT,
            v_current.pending_versions[1:cardinality(v_current.pending_versions)-1],
            ARRAY[]::TEXT[], 'release-db-attestation-v28'::TEXT;
        RETURN;
    END IF;
    RETURN QUERY SELECT false,v_current.migration_count,v_current.migration_head,
        v_current.pending_versions,v_current.security_failures,
        'release-db-attestation-v28'::TEXT;
END;
$$;
ALTER FUNCTION public.koaryu_release_schema_preflight_v8() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.koaryu_release_schema_preflight_v8()
    FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.koaryu_release_schema_preflight_v8() TO service_role;

DO $v31_observation$
BEGIN
    RAISE NOTICE 'KOARYU_V31_RESOURCE_OWNERSHIP_MANIFEST=%',
        private.koaryu_release_resource_ownership_manifest_v31();
    RAISE NOTICE 'KOARYU_V31_OPERATIONAL_CONTRACT=%',
        private.koaryu_release_operational_contract_v31();
    RAISE NOTICE 'KOARYU_V31_OPERATIONAL_MANIFEST=%',
        private.koaryu_release_operational_manifest_v12();
    RAISE NOTICE 'KOARYU_V31_PREDECESSOR_OPERATIONAL_MANIFEST_V11=%',
        private.koaryu_release_operational_manifest_v11();
    RAISE NOTICE 'KOARYU_V31_PREDECESSOR_MANIFEST_V11_FUNCTION_SHA256=%',
        encode(extensions.digest(convert_to(pg_get_functiondef(
            'private.koaryu_release_operational_manifest_v11()'::REGPROCEDURE
        ), 'UTF8'), 'sha256'), 'hex');
    RAISE NOTICE 'KOARYU_V31_EXPECTATION_STATE=%',
        '1:' || encode(extensions.digest(convert_to(
            'operational_contract_v31:' || (
                SELECT expected_sha256
                FROM private.koaryu_release_v31_expectations
                WHERE expectation_key = 'operational_contract_v31'
            ), 'UTF8'
        ), 'sha256'), 'hex');
    RAISE NOTICE 'KOARYU_V31_OPERATIONAL_MANIFEST_V12_FUNCTION_SHA256=%',
        encode(extensions.digest(convert_to(pg_get_functiondef(
            'private.koaryu_release_operational_manifest_v12()'::REGPROCEDURE
        ), 'UTF8'), 'sha256'), 'hex');
    RAISE NOTICE 'KOARYU_V31_OPERATION_AUTHORIZATION_WRITER_FUNCTION_SHA256=%',
        encode(extensions.digest(convert_to(pg_get_functiondef(
            'public.set_studio_live_billing_authorization_operations_v1(uuid,text,boolean,timestamp with time zone,text,uuid,text[],text,text)'::REGPROCEDURE
        ), 'UTF8'), 'sha256'), 'hex');
    RAISE NOTICE 'KOARYU_V31_PREDECESSOR_REPLAY_MANIFEST_V30_FUNCTION_SHA256=%',
        encode(extensions.digest(convert_to(pg_get_functiondef(
            'private.koaryu_release_payments_replay_repairs_manifest_v30()'::REGPROCEDURE
        ), 'UTF8'), 'sha256'), 'hex');
    RAISE NOTICE 'KOARYU_V31_SCHEMA_PREFLIGHT_V6_PROSRC_SHA256=%',
        encode(extensions.digest(convert_to((
            SELECT prosrc FROM pg_proc
            WHERE oid = 'public.koaryu_release_schema_preflight_v6()'::REGPROCEDURE
        ), 'UTF8'), 'sha256'), 'hex');
    RAISE NOTICE 'KOARYU_V31_COMPAT_V26_OPERATIONAL_CONTRACT=%',
        private.koaryu_release_operational_contract_v26();
    RAISE NOTICE 'KOARYU_V31_COMPAT_V27_OPERATIONAL_CONTRACT=%',
        private.koaryu_release_operational_contract_v27();
    RAISE NOTICE 'KOARYU_V31_COMPAT_V28_OPERATIONAL_CONTRACT=%',
        private.koaryu_release_operational_contract_v28();
    RAISE NOTICE 'KOARYU_V31_COMPAT_V29_OPERATIONAL_CONTRACT=%',
        private.koaryu_release_operational_contract_v29();
    RAISE NOTICE 'KOARYU_V31_COMPAT_V30_OPERATIONAL_CONTRACT=%',
        private.koaryu_release_operational_contract_v30();
END;
$v31_observation$;
