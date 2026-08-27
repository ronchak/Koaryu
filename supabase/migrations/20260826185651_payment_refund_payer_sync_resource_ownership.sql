DO $v30_guard$
DECLARE v_preflight RECORD;
BEGIN
    SELECT * INTO v_preflight FROM public.koaryu_release_schema_preflight_v11();
    IF v_preflight.ready IS DISTINCT FROM true
       OR v_preflight.migration_count IS DISTINCT FROM 125
       OR v_preflight.migration_head IS DISTINCT FROM '20260826155911'
       OR v_preflight.manifest_version IS DISTINCT FROM 'release-db-attestation-v30'
       OR cardinality(v_preflight.security_failures) <> 0
       OR private.koaryu_release_schedule_window_manifest_v1()
            IS DISTINCT FROM '0:f4c66d3098dcb3210ac6cc92e1831eebaf9f2ed74b210e84ec773cb1d8e854a7' THEN
        RAISE EXCEPTION 'Resource ownership V31 requires exact ready 125/V30 with the schedule-window contract.';
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

-- Existing linked payers predate the generation column. A payer can inherit the
-- current generation only when its stored account ID is the studio's exact current
-- account; mismatched or partial identities stop the migration for reconciliation.
DO $generation_backfills$
BEGIN
    EXECUTE 'LOCK TABLE public.billing_invoices IN SHARE ROW EXCLUSIVE MODE';
    EXECUTE 'LOCK TABLE public.billing_payers IN SHARE ROW EXCLUSIVE MODE';
    EXECUTE 'LOCK TABLE public.studio_payment_accounts IN SHARE ROW EXCLUSIVE MODE';

    UPDATE public.billing_payers AS payer
    SET connect_account_generation =
            private.current_connect_account_generation(account.metadata),
        updated_at = clock_timestamp()
    FROM public.studio_payment_accounts AS account
    WHERE payer.studio_id = account.studio_id
      AND payer.stripe_account_id = account.stripe_connected_account_id
      AND payer.stripe_customer_id IS NOT NULL
      AND payer.connect_account_generation IS NULL
      AND private.current_connect_account_generation(account.metadata) > 0;

    IF EXISTS (
        SELECT 1
        FROM public.billing_payers AS payer
        LEFT JOIN public.studio_payment_accounts AS account
          ON account.studio_id = payer.studio_id
        WHERE NOT (
            (
                payer.stripe_account_id IS NULL
                AND payer.stripe_customer_id IS NULL
                AND payer.connect_account_generation IS NULL
            )
            OR (
                payer.stripe_account_id IS NOT NULL
                AND payer.stripe_customer_id IS NOT NULL
                AND payer.connect_account_generation IS NOT NULL
                AND payer.stripe_account_id = account.stripe_connected_account_id
                AND payer.connect_account_generation =
                    private.current_connect_account_generation(account.metadata)
                AND payer.connect_account_generation > 0
            )
        )
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '23514',
            MESSAGE = 'billing_payer_connect_generation_backfill_incomplete';
    END IF;

    -- Invoices created before provider-generation metadata was introduced may
    -- adopt the current generation only when every stored provider identity
    -- agrees exactly. Ambiguous or stale identities remain fail-closed.
    UPDATE public.billing_invoices AS invoice
    SET metadata = jsonb_set(
            COALESCE(invoice.metadata, '{}'::JSONB),
            '{connect_account_generation}',
            to_jsonb(payer.connect_account_generation),
            true
        ),
        updated_at = clock_timestamp()
    FROM public.billing_payers AS payer
    JOIN public.studio_payment_accounts AS account
      ON account.studio_id = payer.studio_id
    WHERE invoice.studio_id = payer.studio_id
      AND invoice.payer_id = payer.id
      AND invoice.external IS FALSE
      AND invoice.stripe_invoice_id IS NOT NULL
      AND btrim(invoice.stripe_invoice_id) <> ''
      AND invoice.stripe_account_id = account.stripe_connected_account_id
      AND invoice.stripe_account_id = payer.stripe_account_id
      AND btrim(invoice.stripe_account_id) <> ''
      AND invoice.stripe_customer_id = payer.stripe_customer_id
      AND btrim(invoice.stripe_customer_id) <> ''
      AND payer.connect_account_generation =
            private.current_connect_account_generation(account.metadata)
      AND payer.connect_account_generation > 0
      AND jsonb_typeof(invoice.metadata) = 'object'
      AND NOT (invoice.metadata ? 'connect_account_generation');

    IF EXISTS (
        SELECT 1
        FROM public.billing_invoices AS invoice
        JOIN public.billing_payers AS payer
          ON payer.studio_id = invoice.studio_id
         AND payer.id = invoice.payer_id
        JOIN public.studio_payment_accounts AS account
          ON account.studio_id = invoice.studio_id
        WHERE invoice.stripe_invoice_id IS NOT NULL
          AND invoice.external IS FALSE
          AND btrim(invoice.stripe_invoice_id) <> ''
          AND invoice.stripe_account_id = account.stripe_connected_account_id
          AND invoice.stripe_account_id = payer.stripe_account_id
          AND btrim(invoice.stripe_account_id) <> ''
          AND invoice.stripe_customer_id = payer.stripe_customer_id
          AND btrim(invoice.stripe_customer_id) <> ''
          AND payer.connect_account_generation =
                private.current_connect_account_generation(account.metadata)
          AND payer.connect_account_generation > 0
          AND jsonb_typeof(invoice.metadata) = 'object'
          AND NOT (invoice.metadata ? 'connect_account_generation')
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '23514',
            MESSAGE = 'billing_invoice_connect_generation_backfill_incomplete';
    END IF;
END;
$generation_backfills$;

CREATE FUNCTION public.list_billing_enrollment_scheduled_transitions_v1(
    p_studio_id UUID,
    p_enrollment_ids UUID[]
) RETURNS TABLE(
    enrollment_id UUID,
    intent_id UUID,
    revision BIGINT
) LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF p_studio_id IS NULL
       OR p_enrollment_ids IS NULL
       OR cardinality(p_enrollment_ids) NOT BETWEEN 1 AND 300
       OR EXISTS (
            SELECT 1 FROM unnest(p_enrollment_ids) AS requested(id)
            WHERE requested.id IS NULL
       )
       OR (
            SELECT count(DISTINCT requested.id)
            FROM unnest(p_enrollment_ids) AS requested(id)
       ) <> cardinality(p_enrollment_ids) THEN
        RAISE EXCEPTION USING ERRCODE = '22023',
            MESSAGE = 'billing_enrollment_scheduled_transition_list_invalid';
    END IF;

    RETURN QUERY
    SELECT
        intent.enrollment_id,
        intent.id AS intent_id,
        intent.revision
    FROM public.billing_enrollment_transition_intents AS intent
    WHERE intent.studio_id = p_studio_id
      AND intent.enrollment_id = ANY(p_enrollment_ids)
      AND intent.transition_kind = 'schedule_period_end'
      AND intent.state = 'scheduled'
    ORDER BY intent.enrollment_id;
END;
$$;

ALTER FUNCTION public.list_billing_enrollment_scheduled_transitions_v1(UUID, UUID[])
    OWNER TO postgres;
REVOKE ALL ON FUNCTION public.list_billing_enrollment_scheduled_transitions_v1(UUID, UUID[])
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.list_billing_enrollment_scheduled_transitions_v1(UUID, UUID[])
    TO service_role;

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
    ALTER COLUMN payer_id DROP NOT NULL,
    ADD COLUMN resource_version_sha256 TEXT,
    ADD CONSTRAINT billing_provider_operation_resources_version_exact CHECK (
        CASE
            WHEN (operation_type, resource_type) IN (
                ('payment.refund', 'payment'),
                ('payer.sync', 'payer'),
                ('plan.sync', 'plan')
            ) THEN resource_version_sha256 ~ '^[0-9a-f]{64}$'
            ELSE resource_version_sha256 IS NULL
        END
    );
ALTER TABLE public.billing_provider_operation_resource_aliases
    ALTER COLUMN payer_id DROP NOT NULL;
ALTER TABLE public.billing_provider_operation_resources
    ADD CONSTRAINT billing_provider_operation_resources_alias_identity_v31_unique
        UNIQUE (id, studio_id, operation_type, resource_type, resource_id);
ALTER TABLE public.billing_provider_operation_resource_aliases
    ADD CONSTRAINT billing_provider_operation_resource_aliases_resource_v31_fkey
        FOREIGN KEY (
            resource_claim_id, studio_id, operation_type, resource_type, resource_id
        ) REFERENCES public.billing_provider_operation_resources(
            id, studio_id, operation_type, resource_type, resource_id
        ) ON DELETE RESTRICT;

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

CREATE FUNCTION private.billing_plan_resource_version_v31(
    p_plan public.billing_plans,
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
        jsonb_build_object(
            'studio_id', p_plan.studio_id,
            'plan_id', p_plan.id,
            'stripe_connected_account_id', p_stripe_connected_account_id,
            'connect_account_generation', p_connect_account_generation,
            'name', p_plan.name,
            'description', p_plan.description,
            'amount_cents', COALESCE(p_plan.amount_cents, 0),
            'currency', COALESCE(p_plan.currency, 'usd'),
            'billing_interval', COALESCE(p_plan.billing_interval, 'monthly')
        )::TEXT,
        'UTF8'
    ), 'sha256'), 'hex');
$$;
ALTER FUNCTION private.billing_plan_resource_version_v31(
    public.billing_plans,TEXT,INTEGER
) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.billing_plan_resource_version_v31(
    public.billing_plans,TEXT,INTEGER
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
            OR (
                v_old_state = 'completed'
                AND OLD.operation_type = 'payment.refund'
                AND OLD.resource_version_sha256 IS NOT NULL
                AND NEW.resource_version_sha256 IS NOT DISTINCT FROM
                    OLD.resource_version_sha256
                AND EXISTS (
                    SELECT 1
                    FROM public.billing_provider_operations AS operation
                    JOIN public.billing_refunds AS refund
                      ON refund.studio_id = OLD.studio_id
                     AND refund.payment_id = OLD.resource_id
                     AND refund.stripe_refund_id = operation.provider_object_id
                    WHERE operation.id = OLD.operation_id
                      AND refund.status IN ('failed', 'canceled')
                      AND refund.reconciliation_required IS NOT TRUE
                )
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
        (operation_type = 'plan.sync' AND resource_type = 'plan' AND payer_id IS NULL)
        OR (payer_id IS NOT NULL AND (
        (operation_type = 'invoice.retry' AND resource_type = 'invoice')
        OR (operation_type = 'invoice.finalize' AND resource_type = 'invoice_finalize')
        OR (operation_type = 'invoice.void' AND resource_type = 'invoice_void')
        OR (operation_type = 'payment.refund' AND resource_type = 'payment')
        OR (operation_type = 'payer.sync' AND resource_type = 'payer')
        OR (operation_type IN ('enrollment.activate.autopay','enrollment.activate.invoice')
            AND resource_type = 'enrollment')
        ))
    );
ALTER TABLE public.billing_provider_operation_resource_aliases
    DROP CONSTRAINT billing_provider_operation_resource_aliases_pair_exact,
    ADD CONSTRAINT billing_provider_operation_resource_aliases_pair_exact CHECK (
        (operation_type = 'plan.sync' AND resource_type = 'plan' AND payer_id IS NULL)
        OR (payer_id IS NOT NULL AND (
        (operation_type = 'invoice.retry' AND resource_type = 'invoice')
        OR (operation_type = 'invoice.finalize' AND resource_type = 'invoice_finalize')
        OR (operation_type = 'invoice.void' AND resource_type = 'invoice_void')
        OR (operation_type = 'payment.refund' AND resource_type = 'payment')
        OR (operation_type = 'payer.sync' AND resource_type = 'payer')
        OR (operation_type IN ('enrollment.activate.autopay','enrollment.activate.invoice')
            AND resource_type = 'enrollment')
        ))
    );

ALTER TABLE public.billing_invoices
    ADD CONSTRAINT billing_invoices_mutation_owner_identity_v31_unique
        UNIQUE (id,studio_id,payer_id);

CREATE TABLE public.billing_invoice_mutation_owners(
    studio_id UUID NOT NULL REFERENCES public.studios(id) ON DELETE CASCADE,
    invoice_id UUID NOT NULL,
    payer_id UUID NOT NULL REFERENCES public.billing_payers(id) ON DELETE RESTRICT,
    operation_id UUID NOT NULL,
    resource_claim_id UUID NOT NULL,
    operation_type TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (studio_id,invoice_id),
    CONSTRAINT billing_invoice_mutation_owners_pair_exact CHECK (
        (operation_type='invoice.retry' AND resource_type='invoice')
        OR (operation_type='invoice.finalize' AND resource_type='invoice_finalize')
        OR (operation_type='invoice.void' AND resource_type='invoice_void')
    ),
    CONSTRAINT billing_invoice_mutation_owners_operation_fkey
        FOREIGN KEY (operation_id,studio_id,operation_type)
        REFERENCES public.billing_provider_operations(id,studio_id,operation_type)
        ON DELETE RESTRICT,
    CONSTRAINT billing_invoice_mutation_owners_invoice_fkey
        FOREIGN KEY (invoice_id,studio_id,payer_id)
        REFERENCES public.billing_invoices(id,studio_id,payer_id)
        ON DELETE RESTRICT,
    CONSTRAINT billing_invoice_mutation_owners_resource_fkey
        FOREIGN KEY (
            resource_claim_id,studio_id,operation_type,resource_type,invoice_id,payer_id
        ) REFERENCES public.billing_provider_operation_resources(
            id,studio_id,operation_type,resource_type,resource_id,payer_id
        ) ON DELETE RESTRICT
);
ALTER TABLE public.billing_invoice_mutation_owners OWNER TO postgres;
ALTER TABLE public.billing_invoice_mutation_owners ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.billing_invoice_mutation_owners
    FROM PUBLIC,anon,authenticated,service_role;
CREATE POLICY billing_invoice_mutation_owners_no_client_access
    ON public.billing_invoice_mutation_owners AS RESTRICTIVE
    FOR ALL TO anon,authenticated USING (false) WITH CHECK (false);
CREATE POLICY reject_ambiguous_staff_membership_access
    ON public.billing_invoice_mutation_owners AS RESTRICTIVE
    FOR ALL TO authenticated
    USING ((SELECT private.has_unambiguous_studio_membership()))
    WITH CHECK ((SELECT private.has_unambiguous_studio_membership()));

CREATE FUNCTION private.maintain_billing_invoice_mutation_owner_v31()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path=''
AS $$
DECLARE
    v_owner public.billing_invoice_mutation_owners%ROWTYPE;
    v_old_state TEXT;
    v_new_state TEXT;
BEGIN
    IF (NEW.operation_type,NEW.resource_type) NOT IN (
        ('invoice.retry','invoice'),
        ('invoice.finalize','invoice_finalize'),
        ('invoice.void','invoice_void')
    ) THEN
        RETURN NEW;
    END IF;
    SELECT state INTO v_new_state
    FROM public.billing_provider_operations WHERE id=NEW.operation_id;
    IF v_new_state IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='23514',
            MESSAGE='billing_invoice_mutation_owner_operation_missing';
    END IF;
    SELECT * INTO v_owner
    FROM public.billing_invoice_mutation_owners
    WHERE studio_id=NEW.studio_id AND invoice_id=NEW.resource_id
    FOR UPDATE;
    IF v_owner.operation_id IS NULL THEN
        INSERT INTO public.billing_invoice_mutation_owners(
            studio_id,invoice_id,payer_id,operation_id,resource_claim_id,
            operation_type,resource_type,created_at,updated_at
        ) VALUES(
            NEW.studio_id,NEW.resource_id,NEW.payer_id,NEW.operation_id,NEW.id,
            NEW.operation_type,NEW.resource_type,clock_timestamp(),clock_timestamp()
        );
        RETURN NEW;
    END IF;
    IF v_owner.operation_id IS NOT DISTINCT FROM NEW.operation_id THEN
        RETURN NEW;
    END IF;
    SELECT state INTO v_old_state
    FROM public.billing_provider_operations WHERE id=v_owner.operation_id;
    IF v_old_state IN ('completed','definitive_failed','definitive_rejected')
       AND v_new_state='started' THEN
        UPDATE public.billing_invoice_mutation_owners SET
            operation_id=NEW.operation_id,
            resource_claim_id=NEW.id,
            operation_type=NEW.operation_type,
            resource_type=NEW.resource_type,
            revision=revision+1,
            updated_at=clock_timestamp()
        WHERE studio_id=NEW.studio_id AND invoice_id=NEW.resource_id;
        RETURN NEW;
    END IF;
    RAISE EXCEPTION USING ERRCODE='23514',
        MESSAGE='billing_invoice_mutation_owner_overlap';
END;
$$;
ALTER FUNCTION private.maintain_billing_invoice_mutation_owner_v31()
    OWNER TO postgres;
REVOKE ALL ON FUNCTION private.maintain_billing_invoice_mutation_owner_v31()
    FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER maintain_billing_invoice_mutation_owner_v31
    AFTER INSERT OR UPDATE OF operation_id
    ON public.billing_provider_operation_resources
    FOR EACH ROW EXECUTE FUNCTION private.maintain_billing_invoice_mutation_owner_v31();

DO $invoice_owner_backfill$
BEGIN
    EXECUTE 'LOCK TABLE public.billing_provider_operation_resources IN SHARE ROW EXCLUSIVE MODE';

    IF EXISTS (
        SELECT resource.studio_id,resource.resource_id
        FROM public.billing_provider_operation_resources AS resource
        JOIN public.billing_provider_operations AS operation
          ON operation.id=resource.operation_id
        WHERE (resource.operation_type,resource.resource_type) IN (
            ('invoice.retry','invoice'),
            ('invoice.finalize','invoice_finalize'),
            ('invoice.void','invoice_void')
        )
          AND operation.state NOT IN (
              'completed','definitive_failed','definitive_rejected'
          )
        GROUP BY resource.studio_id,resource.resource_id
        HAVING count(*)>1
    ) THEN
        RAISE EXCEPTION USING ERRCODE='23514',
            MESSAGE='billing_invoice_mutation_owner_backfill_ambiguous';
    END IF;

    INSERT INTO public.billing_invoice_mutation_owners(
        studio_id,invoice_id,payer_id,operation_id,resource_claim_id,
        operation_type,resource_type,created_at,updated_at
    )
    SELECT DISTINCT ON (resource.studio_id,resource.resource_id)
        resource.studio_id,resource.resource_id,resource.payer_id,
        operation.id,resource.id,resource.operation_type,resource.resource_type,
        clock_timestamp(),clock_timestamp()
    FROM public.billing_provider_operation_resources AS resource
    JOIN public.billing_provider_operations AS operation
      ON operation.id=resource.operation_id
    WHERE (resource.operation_type,resource.resource_type) IN (
        ('invoice.retry','invoice'),
        ('invoice.finalize','invoice_finalize'),
        ('invoice.void','invoice_void')
    )
    ORDER BY resource.studio_id,resource.resource_id,
        (operation.state NOT IN (
            'completed','definitive_failed','definitive_rejected'
        )) DESC,
        operation.created_at DESC,operation.id DESC;
END;
$invoice_owner_backfill$;

CREATE FUNCTION private.preserve_billing_invoice_mutation_owner_v31()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path=''
AS $$
DECLARE
    v_old_state TEXT;
    v_new_state TEXT;
    v_resource_operation UUID;
BEGIN
    IF OLD.studio_id IS DISTINCT FROM NEW.studio_id
       OR OLD.invoice_id IS DISTINCT FROM NEW.invoice_id
       OR OLD.payer_id IS DISTINCT FROM NEW.payer_id
       OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
        RAISE EXCEPTION USING ERRCODE='23514',
            MESSAGE='billing_invoice_mutation_owner_identity_immutable';
    END IF;
    IF OLD.operation_id IS NOT DISTINCT FROM NEW.operation_id
       OR NEW.revision IS DISTINCT FROM OLD.revision+1
       OR NEW.updated_at<=OLD.updated_at THEN
        RAISE EXCEPTION USING ERRCODE='23514',
            MESSAGE='billing_invoice_mutation_owner_revision_invalid';
    END IF;
    SELECT state INTO v_old_state
    FROM public.billing_provider_operations WHERE id=OLD.operation_id;
    SELECT state INTO v_new_state
    FROM public.billing_provider_operations WHERE id=NEW.operation_id;
    SELECT operation_id INTO v_resource_operation
    FROM public.billing_provider_operation_resources
    WHERE id=NEW.resource_claim_id
      AND studio_id=NEW.studio_id
      AND operation_type=NEW.operation_type
      AND resource_type=NEW.resource_type
      AND resource_id=NEW.invoice_id
      AND payer_id=NEW.payer_id;
    IF v_old_state NOT IN ('completed','definitive_failed','definitive_rejected')
       OR v_new_state IS DISTINCT FROM 'started'
       OR v_resource_operation IS DISTINCT FROM NEW.operation_id THEN
        RAISE EXCEPTION USING ERRCODE='23514',
            MESSAGE='billing_invoice_mutation_owner_advance_invalid';
    END IF;
    RETURN NEW;
END;
$$;
ALTER FUNCTION private.preserve_billing_invoice_mutation_owner_v31()
    OWNER TO postgres;
REVOKE ALL ON FUNCTION private.preserve_billing_invoice_mutation_owner_v31()
    FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER preserve_billing_invoice_mutation_owner_v31
    BEFORE UPDATE ON public.billing_invoice_mutation_owners
    FOR EACH ROW EXECUTE FUNCTION private.preserve_billing_invoice_mutation_owner_v31();

ALTER FUNCTION public.claim_billing_provider_operation_resource_v1(
    UUID,UUID,TEXT,TEXT,UUID,UUID,TEXT,TEXT,TEXT,INTEGER,UUID,INTEGER
) RENAME TO claim_billing_provider_operation_resource_v30;
REVOKE ALL ON FUNCTION public.claim_billing_provider_operation_resource_v30(
    UUID,UUID,TEXT,TEXT,UUID,UUID,TEXT,TEXT,TEXT,INTEGER,UUID,INTEGER
) FROM PUBLIC,anon,authenticated,service_role;
ALTER FUNCTION public.claim_billing_invoice_closeout_operation_v1(
    UUID,UUID,TEXT,TEXT,UUID,UUID,TEXT,TEXT,TEXT,INTEGER,UUID,INTEGER
) RENAME TO claim_billing_invoice_closeout_operation_v30;
REVOKE ALL ON FUNCTION public.claim_billing_invoice_closeout_operation_v30(
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
    v_plan public.billing_plans%ROWTYPE;
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
       OR p_lease_owner IS NULL
       OR NOT ((p_operation_type='payment.refund' AND p_resource_type='payment')
            OR (p_operation_type='payer.sync' AND p_resource_type='payer')
            OR (p_operation_type='plan.sync' AND p_resource_type='plan'))
       OR (p_resource_type='plan' AND p_payer_id IS NOT NULL)
       OR (p_resource_type<>'plan' AND p_payer_id IS NULL)
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

    IF p_resource_type='plan' THEN
        SELECT * INTO v_plan FROM public.billing_plans
        WHERE id=p_resource_id AND studio_id=p_studio_id FOR UPDATE;
        IF v_plan.id IS NULL OR v_plan.status='archived' OR v_plan.archived_at IS NOT NULL
           OR (
                v_plan.stripe_account_id IS NOT NULL
                AND v_plan.stripe_account_id IS DISTINCT FROM
                    p_stripe_connected_account_id
           ) THEN
            RAISE EXCEPTION USING ERRCODE='23514',
                MESSAGE='billing_provider_operation_resource_plan_identity_mismatch';
        END IF;
    ELSIF p_resource_type='payment' THEN
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
    IF p_resource_type<>'plan' THEN
        SELECT * INTO v_payer FROM public.billing_payers
        WHERE id=p_payer_id AND studio_id=p_studio_id FOR UPDATE;
    END IF;
    SELECT * INTO v_account FROM public.studio_payment_accounts
    WHERE studio_id=p_studio_id FOR UPDATE;
    IF v_account.studio_id IS NULL
       OR v_account.stripe_connected_account_id IS DISTINCT FROM p_stripe_connected_account_id
       OR private.current_connect_account_generation(v_account.metadata)
            IS DISTINCT FROM p_connect_account_generation
       OR (p_resource_type<>'plan' AND v_payer.id IS NULL)
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
    v_current_resource_version := CASE
        WHEN p_resource_type='plan' THEN private.billing_plan_resource_version_v31(
            v_plan,
            p_stripe_connected_account_id,
            p_connect_account_generation
        )
        ELSE private.billing_operation_resource_version_v31(
            p_operation_type,
            v_payment,
            v_payer,
            p_stripe_connected_account_id,
            p_connect_account_generation
        )
    END;
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
    IF v_operation.state='completed' AND p_resource_type='payment' THEN
        SELECT * INTO v_refund FROM public.billing_refunds
        WHERE studio_id=p_studio_id
          AND payment_id=p_resource_id
          AND stripe_refund_id=v_operation.provider_object_id
          AND stripe_account_id=p_stripe_connected_account_id
          AND connect_account_generation=p_connect_account_generation
          AND reconciliation_required IS NOT TRUE
        ORDER BY created_at,id
        LIMIT 1
        FOR UPDATE;
    END IF;
    IF v_operation.actor_id IS DISTINCT FROM p_actor_id
       AND NOT (
            v_operation.state = 'completed'
            AND EXISTS (
                SELECT 1
                FROM public.staff_roles AS membership
                WHERE membership.studio_id = p_studio_id
                  AND membership.user_id = p_actor_id
                  AND membership.archived_at IS NULL
                  AND membership.role = 'admin'
            )
            AND (
                v_resource.resource_version_sha256 IS DISTINCT FROM
                    v_current_resource_version
                OR (
                    p_resource_type = 'payment'
                    AND v_refund.status IN ('failed', 'canceled')
                )
            )
       ) THEN
        RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='billing_provider_operation_resource_actor_conflict';
    END IF;
    IF v_operation.state='completed' AND p_resource_type='payment' THEN
        IF v_resource.resource_version_sha256 IS NOT DISTINCT FROM
           v_current_resource_version
           AND v_operation.request_sha256 IS DISTINCT FROM p_request_sha256 THEN
            RAISE EXCEPTION USING ERRCODE='23505',
                MESSAGE='billing_provider_operation_resource_request_conflict';
        END IF;
        IF v_refund.id IS NULL THEN
            RAISE EXCEPTION USING ERRCODE='23514',
                MESSAGE='billing_provider_operation_resource_prior_projection_unverified';
        END IF;
        IF v_resource.resource_version_sha256 IS NOT DISTINCT FROM
           v_current_resource_version
           AND v_refund.status NOT IN ('failed','canceled') THEN
            RAISE EXCEPTION USING ERRCODE='55000',
                MESSAGE='billing_provider_operation_resource_prior_refund_unsettled';
        END IF;
    END IF;
    IF v_operation.state='completed' AND (
        v_resource.resource_version_sha256 IS DISTINCT FROM v_current_resource_version
        OR (
            p_resource_type='payment'
            AND v_refund.status IN ('failed','canceled')
        )
    ) THEN
        IF p_resource_type='payment' THEN
            IF v_refund.id IS NULL THEN
                RAISE EXCEPTION USING ERRCODE='23514',
                    MESSAGE='billing_provider_operation_resource_prior_projection_unverified';
            END IF;
        ELSIF p_resource_type='plan' THEN
            PERFORM 1
            FROM public.billing_provider_operation_steps AS step
            WHERE step.operation_id=v_operation.id
            ORDER BY step.step_order
            FOR UPDATE;
            IF v_operation.result_code IS DISTINCT FROM 'plan_sync_completed' THEN
                RAISE EXCEPTION USING ERRCODE='23514',
                    MESSAGE='billing_provider_operation_resource_prior_projection_unverified';
            ELSIF v_operation.result_summary='plan_sync_mode:product_update_only' THEN
                IF v_operation.provider_object_id IS NULL
                   OR v_plan.stripe_product_id IS DISTINCT FROM v_operation.provider_object_id
                   OR v_operation.provider_step_plan_sha256 IS NOT NULL
                   OR v_operation.provider_step_expected_count IS NOT NULL
                   OR EXISTS (
                        SELECT 1 FROM public.billing_provider_operation_steps AS step
                        WHERE step.operation_id=v_operation.id
                   ) THEN
                    RAISE EXCEPTION USING ERRCODE='23514',
                        MESSAGE='billing_provider_operation_resource_prior_projection_unverified';
                END IF;
            ELSIF v_operation.result_summary='plan_sync_mode:product_price_steps' THEN
                IF v_operation.provider_step_plan_sha256 !~ '^[0-9a-f]{64}$'
                   OR v_operation.provider_step_expected_count IS DISTINCT FROM 2
                   OR v_operation.provider_object_id IS DISTINCT FROM v_plan.stripe_price_id
                   OR (SELECT count(*) FROM public.billing_provider_operation_steps AS step
                       WHERE step.operation_id=v_operation.id) <> 2
                   OR NOT EXISTS (
                        SELECT 1
                        FROM public.billing_provider_operation_steps AS step
                        WHERE step.operation_id=v_operation.id
                          AND step.step_order=1
                          AND step.step_name='product'
                          AND step.provider_operation IN (
                              'connected_product.create','connected_product.update'
                          )
                          AND step.state='provider_succeeded'
                          AND step.provider_request_attempt_count=1
                          AND step.result_code='plan_sync_product_succeeded'
                          AND step.provider_object_id=v_plan.stripe_product_id
                    )
                   OR NOT EXISTS (
                        SELECT 1
                        FROM public.billing_provider_operation_steps AS step
                        WHERE step.operation_id=v_operation.id
                          AND step.step_order=2
                          AND step.step_name='price'
                          AND step.provider_operation='connected_price.create'
                          AND step.state='provider_succeeded'
                          AND step.provider_request_attempt_count=1
                          AND step.result_code='plan_sync_price_succeeded'
                          AND step.provider_object_id=v_plan.stripe_price_id
                    ) THEN
                    RAISE EXCEPTION USING ERRCODE='23514',
                        MESSAGE='billing_provider_operation_resource_prior_projection_unverified';
                END IF;
            ELSE
                RAISE EXCEPTION USING ERRCODE='23514',
                    MESSAGE='billing_provider_operation_resource_prior_projection_unverified';
            END IF;
        ELSIF p_resource_type='payer'
              AND v_payer.stripe_customer_id IS DISTINCT FROM v_operation.provider_object_id THEN
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

CREATE FUNCTION private.claim_billing_invoice_mutation_v31(
    p_studio_id UUID,p_actor_id UUID,p_operation_type TEXT,p_resource_type TEXT,
    p_resource_id UUID,p_payer_id UUID,p_caller_request_key TEXT,p_request_sha256 TEXT,
    p_stripe_connected_account_id TEXT,p_connect_account_generation INTEGER,
    p_lease_owner UUID,p_lease_seconds INTEGER DEFAULT 30
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
    v_invoice public.billing_invoices%ROWTYPE;
    v_owner public.billing_invoice_mutation_owners%ROWTYPE;
    v_owner_operation public.billing_provider_operations%ROWTYPE;
    v_alias public.billing_provider_operation_resource_aliases%ROWTYPE;
    v_alias_resource public.billing_provider_operation_resources%ROWTYPE;
    v_alias_operation public.billing_provider_operations%ROWTYPE;
    v_terminal_resource public.billing_provider_operation_resources%ROWTYPE;
    v_replacement_operation public.billing_provider_operations%ROWTYPE;
    v_result JSONB;
    v_candidate_operation_id UUID;
    v_candidate_resource_id UUID;
    v_candidate_state TEXT;
    v_now TIMESTAMPTZ:=clock_timestamp();
BEGIN
    IF p_studio_id IS NULL OR p_actor_id IS NULL OR p_resource_id IS NULL
       OR p_payer_id IS NULL OR p_lease_owner IS NULL
       OR NOT ((p_operation_type='invoice.retry' AND p_resource_type='invoice')
            OR (p_operation_type='invoice.finalize' AND p_resource_type='invoice_finalize')
            OR (p_operation_type='invoice.void' AND p_resource_type='invoice_void'))
       OR p_request_sha256 !~ '^[0-9a-f]{64}$'
       OR p_connect_account_generation<=0
       OR octet_length(p_stripe_connected_account_id) NOT BETWEEN 1 AND 255
       OR octet_length(p_caller_request_key) NOT BETWEEN 1 AND 255
       OR p_caller_request_key IS DISTINCT FROM btrim(p_caller_request_key)
       OR p_caller_request_key~'[[:cntrl:]]'
       OR p_lease_seconds NOT BETWEEN 5 AND 300 THEN
        RAISE EXCEPTION USING ERRCODE='22023',
            MESSAGE='billing_invoice_mutation_claim_invalid';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM public.staff_roles AS membership
        WHERE membership.studio_id=p_studio_id
          AND membership.user_id=p_actor_id
          AND membership.archived_at IS NULL
          AND membership.role='admin'
    ) THEN
        RAISE EXCEPTION USING ERRCODE='42501',
            MESSAGE='billing_invoice_mutation_actor_forbidden';
    END IF;
    SELECT * INTO v_invoice
    FROM public.billing_invoices
    WHERE id=p_resource_id AND studio_id=p_studio_id
    FOR UPDATE;
    IF v_invoice.id IS NULL OR v_invoice.payer_id IS DISTINCT FROM p_payer_id THEN
        RAISE EXCEPTION USING ERRCODE='23514',
            MESSAGE='billing_invoice_mutation_identity_mismatch';
    END IF;
    SELECT * INTO v_owner
    FROM public.billing_invoice_mutation_owners
    WHERE studio_id=p_studio_id AND invoice_id=p_resource_id
    FOR UPDATE;

    SELECT * INTO v_alias
    FROM public.billing_provider_operation_resource_aliases
    WHERE studio_id=p_studio_id
      AND operation_type=p_operation_type
      AND caller_request_key=p_caller_request_key
    FOR UPDATE;
    IF FOUND THEN
        SELECT * INTO v_alias_resource
        FROM public.billing_provider_operation_resources
        WHERE id=v_alias.resource_claim_id
        FOR UPDATE;
        SELECT * INTO v_alias_operation
        FROM public.billing_provider_operations
        WHERE id=v_alias.operation_id
        FOR UPDATE;
        IF v_alias_resource.id IS NULL OR v_alias_operation.id IS NULL
           OR v_alias.resource_type IS DISTINCT FROM p_resource_type
           OR v_alias.resource_id IS DISTINCT FROM p_resource_id
           OR v_alias.payer_id IS DISTINCT FROM p_payer_id
           OR v_alias_operation.actor_id IS DISTINCT FROM p_actor_id
           OR v_alias_operation.request_sha256 IS DISTINCT FROM p_request_sha256
           OR v_alias_operation.stripe_connected_account_id
                IS DISTINCT FROM p_stripe_connected_account_id
           OR v_alias_operation.connect_account_generation
                IS DISTINCT FROM p_connect_account_generation THEN
            RAISE EXCEPTION USING ERRCODE='23505',
                MESSAGE='billing_invoice_mutation_request_conflict';
        END IF;
        IF v_alias_operation.state IN (
            'completed','definitive_failed','definitive_rejected'
        ) THEN
            RETURN private.billing_provider_operation_resource_json_v1(
                v_alias_resource,v_alias_operation,p_caller_request_key,'replay'
            );
        END IF;
        IF v_owner.operation_id IS DISTINCT FROM v_alias_operation.id THEN
            RAISE EXCEPTION USING ERRCODE='55P03',
                MESSAGE='billing_invoice_mutation_in_progress';
        END IF;
    END IF;

    IF v_owner.operation_id IS NOT NULL THEN
        SELECT * INTO v_owner_operation
        FROM public.billing_provider_operations
        WHERE id=v_owner.operation_id
        FOR UPDATE;
        IF v_owner_operation.id IS NULL THEN
            RAISE EXCEPTION USING ERRCODE='23514',
                MESSAGE='billing_invoice_mutation_owner_invalid';
        END IF;
        IF v_owner_operation.state NOT IN (
            'completed','definitive_failed','definitive_rejected'
        ) AND v_owner.operation_type IS DISTINCT FROM p_operation_type THEN
            RAISE EXCEPTION USING ERRCODE='55P03',
                MESSAGE='billing_invoice_mutation_in_progress';
        END IF;
    END IF;

    IF v_owner.operation_id IS NOT NULL
       AND v_owner.operation_type=p_operation_type
       AND v_owner_operation.state IN ('definitive_failed','definitive_rejected') THEN
        SELECT * INTO v_terminal_resource
        FROM public.billing_provider_operation_resources
        WHERE id=v_owner.resource_claim_id
        FOR UPDATE;
        IF v_terminal_resource.id IS NULL
           OR v_terminal_resource.operation_id IS DISTINCT FROM v_owner.operation_id
           OR v_terminal_resource.studio_id IS DISTINCT FROM p_studio_id
           OR v_terminal_resource.operation_type IS DISTINCT FROM p_operation_type
           OR v_terminal_resource.resource_type IS DISTINCT FROM p_resource_type
           OR v_terminal_resource.resource_id IS DISTINCT FROM p_resource_id
           OR v_terminal_resource.payer_id IS DISTINCT FROM p_payer_id THEN
            RAISE EXCEPTION USING ERRCODE='23514',
                MESSAGE='billing_invoice_mutation_owner_invalid';
        END IF;
        INSERT INTO public.billing_provider_operations(
            studio_id,actor_id,operation_type,caller_request_key,request_sha256,
            stripe_connected_account_id,connect_account_generation,lease_owner,
            lease_acquired_at,lease_expires_at,started_at,created_at,updated_at
        ) VALUES(
            p_studio_id,p_actor_id,p_operation_type,p_caller_request_key,
            p_request_sha256,p_stripe_connected_account_id,
            p_connect_account_generation,p_lease_owner,v_now,
            v_now+make_interval(secs=>p_lease_seconds),v_now,v_now,v_now
        ) RETURNING * INTO v_replacement_operation;
        UPDATE public.billing_provider_operation_resources SET
            operation_id=v_replacement_operation.id,
            revision=revision+1,
            updated_at=v_now
        WHERE id=v_terminal_resource.id
        RETURNING * INTO v_terminal_resource;
        INSERT INTO public.billing_provider_operation_resource_aliases(
            resource_claim_id,operation_id,studio_id,operation_type,resource_type,
            resource_id,payer_id,caller_request_key,created_at
        ) VALUES(
            v_terminal_resource.id,v_replacement_operation.id,p_studio_id,
            p_operation_type,p_resource_type,p_resource_id,p_payer_id,
            p_caller_request_key,v_now
        );
        v_result:=private.billing_provider_operation_resource_json_v1(
            v_terminal_resource,v_replacement_operation,p_caller_request_key,'replaced'
        );
    ELSIF p_operation_type IN ('invoice.finalize','invoice.void') THEN
        v_result:=public.claim_billing_invoice_closeout_operation_v30(
            p_studio_id,p_actor_id,p_operation_type,p_resource_type,p_resource_id,
            p_payer_id,p_caller_request_key,p_request_sha256,
            p_stripe_connected_account_id,p_connect_account_generation,
            p_lease_owner,p_lease_seconds
        );
    ELSE
        v_result:=public.claim_billing_provider_operation_resource_v30(
            p_studio_id,p_actor_id,p_operation_type,p_resource_type,p_resource_id,
            p_payer_id,p_caller_request_key,p_request_sha256,
            p_stripe_connected_account_id,p_connect_account_generation,
            p_lease_owner,p_lease_seconds
        );
    END IF;
    v_candidate_operation_id:=(v_result->'operation'->>'id')::UUID;
    v_candidate_resource_id:=(v_result->'resource'->>'id')::UUID;
    v_candidate_state:=v_result->'operation'->>'state';
    IF v_candidate_operation_id IS NULL OR v_candidate_resource_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='23514',
            MESSAGE='billing_invoice_mutation_claim_result_invalid';
    END IF;
    SELECT * INTO v_owner
    FROM public.billing_invoice_mutation_owners
    WHERE studio_id=p_studio_id AND invoice_id=p_resource_id
    FOR UPDATE;
    IF v_owner.operation_id IS NULL THEN
        INSERT INTO public.billing_invoice_mutation_owners(
            studio_id,invoice_id,payer_id,operation_id,resource_claim_id,
            operation_type,resource_type,created_at,updated_at
        ) VALUES(
            p_studio_id,p_resource_id,p_payer_id,v_candidate_operation_id,
            v_candidate_resource_id,p_operation_type,p_resource_type,v_now,v_now
        );
    ELSIF v_owner.operation_id IS DISTINCT FROM v_candidate_operation_id
          AND v_candidate_state='started' THEN
        UPDATE public.billing_invoice_mutation_owners SET
            operation_id=v_candidate_operation_id,
            resource_claim_id=v_candidate_resource_id,
            operation_type=p_operation_type,
            resource_type=p_resource_type,
            revision=revision+1,
            updated_at=v_now
        WHERE studio_id=p_studio_id AND invoice_id=p_resource_id;
    ELSIF v_owner.operation_id IS DISTINCT FROM v_candidate_operation_id
          AND v_candidate_state NOT IN (
              'completed','definitive_failed','definitive_rejected'
          ) THEN
        RAISE EXCEPTION USING ERRCODE='23514',
            MESSAGE='billing_invoice_mutation_owner_result_invalid';
    END IF;
    RETURN v_result;
END;
$$;
ALTER FUNCTION private.claim_billing_invoice_mutation_v31(
    UUID,UUID,TEXT,TEXT,UUID,UUID,TEXT,TEXT,TEXT,INTEGER,UUID,INTEGER
) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.claim_billing_invoice_mutation_v31(
    UUID,UUID,TEXT,TEXT,UUID,UUID,TEXT,TEXT,TEXT,INTEGER,UUID,INTEGER
) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.claim_billing_provider_operation_resource_v1(
    p_studio_id UUID,p_actor_id UUID,p_operation_type TEXT,p_resource_type TEXT,
    p_resource_id UUID,p_payer_id UUID,p_caller_request_key TEXT,p_request_sha256 TEXT,
    p_stripe_connected_account_id TEXT,p_connect_account_generation INTEGER,
    p_lease_owner UUID,p_lease_seconds INTEGER DEFAULT 30
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
    IF (p_operation_type,p_resource_type)=('invoice.retry','invoice') THEN
        RETURN private.claim_billing_invoice_mutation_v31(p_studio_id,p_actor_id,
            p_operation_type,p_resource_type,p_resource_id,p_payer_id,p_caller_request_key,
            p_request_sha256,p_stripe_connected_account_id,p_connect_account_generation,
            p_lease_owner,p_lease_seconds);
    END IF;
    IF (p_operation_type,p_resource_type) IN (
        ('payment.refund','payment'),('payer.sync','payer'),('plan.sync','plan')) THEN
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

CREATE FUNCTION public.claim_billing_invoice_closeout_operation_v1(
    p_studio_id UUID,p_actor_id UUID,p_operation_type TEXT,p_resource_type TEXT,
    p_resource_id UUID,p_payer_id UUID,p_caller_request_key TEXT,p_request_sha256 TEXT,
    p_stripe_connected_account_id TEXT,p_connect_account_generation INTEGER,
    p_lease_owner UUID,p_lease_seconds INTEGER DEFAULT 30
) RETURNS JSONB LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
    SELECT private.claim_billing_invoice_mutation_v31(
        p_studio_id,p_actor_id,p_operation_type,p_resource_type,p_resource_id,
        p_payer_id,p_caller_request_key,p_request_sha256,
        p_stripe_connected_account_id,p_connect_account_generation,
        p_lease_owner,p_lease_seconds
    );
$$;
ALTER FUNCTION public.claim_billing_invoice_closeout_operation_v1(
    UUID,UUID,TEXT,TEXT,UUID,UUID,TEXT,TEXT,TEXT,INTEGER,UUID,INTEGER
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.claim_billing_invoice_closeout_operation_v1(
    UUID,UUID,TEXT,TEXT,UUID,UUID,TEXT,TEXT,TEXT,INTEGER,UUID,INTEGER
) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.claim_billing_invoice_closeout_operation_v1(
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
            ('private.billing_plan_resource_version_v31(public.billing_plans,text,integer)', false, false, 'search_path=pg_catalog'),
            ('private.claim_billing_invoice_mutation_v31(uuid,uuid,text,text,uuid,uuid,text,text,text,integer,uuid,integer)', true, false, 'search_path=""'),
            ('private.claim_payment_payer_operation_resource_v31(uuid,uuid,text,text,uuid,uuid,text,text,text,integer,uuid,integer)', true, false, 'search_path=""'),
            ('private.enforce_billing_payer_connect_identity_v1()', true, false, 'search_path=""'),
            ('private.enforce_billing_provider_step_parent_v1()', false, false, 'search_path=""'),
            ('private.maintain_billing_invoice_mutation_owner_v31()', false, false, 'search_path=""'),
            ('private.preserve_billing_provider_operation_resource_alias_v1()', false, false, 'search_path=""'),
            ('private.preserve_billing_provider_operation_resource_v1()', false, false, 'search_path=""'),
            ('private.preserve_billing_provider_operation_step_v1()', false, false, 'search_path=""'),
            ('private.preserve_billing_invoice_mutation_owner_v31()', false, false, 'search_path=""'),
            ('private.koaryu_release_schedule_window_manifest_v1()', false, false, 'search_path=pg_catalog'),
            ('private.validate_billing_payment_identity_change()', false, false, 'search_path=""'),
            ('public.claim_billing_invoice_closeout_operation_v1(uuid,uuid,text,text,uuid,uuid,text,text,text,integer,uuid,integer)', true, true, 'search_path=""'),
            ('public.claim_billing_invoice_closeout_operation_v30(uuid,uuid,text,text,uuid,uuid,text,text,text,integer,uuid,integer)', true, false, 'search_path=""'),
            ('public.claim_billing_provider_operation_resource_v1(uuid,uuid,text,text,uuid,uuid,text,text,text,integer,uuid,integer)', true, true, 'search_path=""'),
            ('public.claim_billing_provider_operation_resource_v30(uuid,uuid,text,text,uuid,uuid,text,text,text,integer,uuid,integer)', true, false, 'search_path=""'),
            ('public.claim_due_billing_enrollment_transitions_v1(uuid,integer,integer)', true, true, 'search_path=""'),
            ('public.disable_billing_payer_autopay_v1(uuid,uuid,uuid,timestamp with time zone,text)', true, true, 'search_path=""'),
            ('public.finalize_billing_payer_setup_projection_v1(uuid,uuid,uuid,uuid,uuid,text,text,text,integer)', true, true, 'search_path=""'),
            ('public.schedule_window_read(uuid,date,date,text)', false, true, 'search_path=pg_catalog')
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
            COALESCE((
                SELECT string_agg(
                    COALESCE(grantor_role.rolname, 'PUBLIC') || '>' ||
                    COALESCE(grantee_role.rolname, 'PUBLIC') || ':' ||
                    privilege.privilege_type || ':' || privilege.is_grantable::TEXT,
                    ',' ORDER BY
                                 COALESCE(grantor_role.rolname, 'PUBLIC') COLLATE "C",
                                 COALESCE(grantee_role.rolname, 'PUBLIC') COLLATE "C",
                                 privilege.privilege_type COLLATE "C",
                                 privilege.is_grantable
                )
                FROM aclexplode(COALESCE(
                    procedure.proacl,
                    acldefault('f', procedure.proowner)
                )) AS privilege
                LEFT JOIN pg_roles AS grantor_role
                  ON grantor_role.oid=privilege.grantor
                LEFT JOIN pg_roles AS grantee_role
                  ON grantee_role.oid=privilege.grantee
            ), '') AS acl_state,
            EXISTS (
                SELECT 1
                FROM aclexplode(COALESCE(
                    procedure.proacl,
                    acldefault('f', procedure.proowner)
                )) AS privilege
                LEFT JOIN pg_roles AS grantee_role
                  ON grantee_role.oid=privilege.grantee
                WHERE privilege.privilege_type='EXECUTE'
                  AND privilege.grantee<>procedure.proowner
                  AND NOT (
                      required.service_execute
                      AND grantee_role.rolname='service_role'
                      AND NOT privilege.is_grantable
                  )
            ) AS unexpected_execute,
            EXISTS (
                SELECT 1
                FROM aclexplode(COALESCE(
                    procedure.proacl,
                    acldefault('f', procedure.proowner)
                )) AS privilege
                JOIN pg_roles AS grantee_role
                  ON grantee_role.oid=privilege.grantee
                WHERE grantee_role.rolname='service_role'
                  AND privilege.privilege_type='EXECUTE'
                  AND privilege.is_grantable
            ) AS service_execute_grant_option,
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
            'billing_provider_operation_resources_version_exact',
            'billing_provider_operation_resources_alias_identity_v31_unique',
            'billing_provider_operation_resource_aliases_resource_v31_fkey',
            'billing_invoice_mutation_owners_pair_exact',
            'billing_invoice_mutation_owners_operation_fkey',
            'billing_invoice_mutation_owners_resource_fkey',
            'billing_invoice_mutation_owners_invoice_fkey',
            'billing_invoices_mutation_owner_identity_v31_unique',
            'billing_invoice_mutation_owners_pkey',
            'billing_invoice_mutation_owners_studio_id_fkey',
            'billing_invoice_mutation_owners_payer_id_fkey',
            'billing_invoice_mutation_owners_revision_check'
        )
    ), required_invoice_owner_columns(
        column_name,expected_type,expected_not_null,expected_default
    ) AS (
        VALUES
            ('studio_id','uuid',true,''),
            ('invoice_id','uuid',true,''),
            ('payer_id','uuid',true,''),
            ('operation_id','uuid',true,''),
            ('resource_claim_id','uuid',true,''),
            ('operation_type','text',true,''),
            ('resource_type','text',true,''),
            ('revision','bigint',true,'1'),
            ('created_at','timestamp with time zone',true,'now()'),
            ('updated_at','timestamp with time zone',true,'now()')
    ), invoice_owner_column_state AS (
        SELECT
            required.column_name,
            required.expected_type,
            required.expected_not_null,
            required.expected_default,
            format_type(attribute.atttypid,attribute.atttypmod) AS actual_type,
            attribute.attnotnull AS actual_not_null,
            COALESCE(pg_get_expr(default_value.adbin,default_value.adrelid),'')
                AS actual_default,
            attribute.attidentity,
            attribute.attgenerated
        FROM required_invoice_owner_columns AS required
        LEFT JOIN pg_attribute AS attribute
          ON attribute.attrelid='public.billing_invoice_mutation_owners'::REGCLASS
         AND attribute.attname=required.column_name
         AND attribute.attnum>0
         AND NOT attribute.attisdropped
        LEFT JOIN pg_attrdef AS default_value
          ON default_value.adrelid=attribute.attrelid
         AND default_value.adnum=attribute.attnum
    ), invoice_owner_table_state AS (
        SELECT
            owner.rolname AS owner_name,
            relation.relrowsecurity,
            has_table_privilege('service_role',relation.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS service_access,
            has_table_privilege('authenticated',relation.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS auth_access,
            has_table_privilege('anon',relation.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS anon_access,
            EXISTS (
                SELECT 1
                FROM aclexplode(COALESCE(
                    relation.relacl,
                    acldefault('r',relation.relowner)
                )) AS privilege
                WHERE privilege.grantee=0
            ) AS public_privilege,
            EXISTS (
                SELECT 1
                FROM aclexplode(COALESCE(
                    relation.relacl,
                    acldefault('r',relation.relowner)
                )) AS privilege
                WHERE privilege.grantee<>relation.relowner
            ) AS unexpected_privilege,
            COALESCE((
                SELECT string_agg(
                    COALESCE(grantor_role.rolname, 'PUBLIC') || '>' ||
                    COALESCE(grantee_role.rolname, 'PUBLIC') || ':' ||
                    privilege.privilege_type || ':' || privilege.is_grantable::TEXT,
                    ',' ORDER BY
                                 COALESCE(grantor_role.rolname, 'PUBLIC') COLLATE "C",
                                 COALESCE(grantee_role.rolname, 'PUBLIC') COLLATE "C",
                                 privilege.privilege_type COLLATE "C",privilege.is_grantable
                )
                FROM aclexplode(COALESCE(
                    relation.relacl,
                    acldefault('r',relation.relowner)
                )) AS privilege
                LEFT JOIN pg_roles AS grantor_role
                  ON grantor_role.oid=privilege.grantor
                LEFT JOIN pg_roles AS grantee_role
                  ON grantee_role.oid=privilege.grantee
            ),'') AS acl_state
        FROM pg_class AS relation
        JOIN pg_namespace AS namespace ON namespace.oid=relation.relnamespace
        JOIN pg_roles AS owner ON owner.oid=relation.relowner
        WHERE namespace.nspname='public'
          AND relation.relname='billing_invoice_mutation_owners'
          AND relation.relkind='r'
    ), required_invoice_owner_triggers(
        table_name,trigger_name,function_signature,expected_tgtype
    ) AS (
        VALUES
            ('billing_invoice_mutation_owners',
             'preserve_billing_invoice_mutation_owner_v31',
             'private.preserve_billing_invoice_mutation_owner_v31()',19),
            ('billing_provider_operation_resources',
             'maintain_billing_invoice_mutation_owner_v31',
             'private.maintain_billing_invoice_mutation_owner_v31()',21)
    ), invoice_owner_trigger_state AS (
        SELECT
            required.trigger_name,
            required.expected_tgtype,
            trigger.tgenabled,
            trigger.tgtype::INTEGER AS actual_tgtype,
            trigger.tgfoid=to_regprocedure(required.function_signature)
                AS function_matches,
            encode(extensions.digest(convert_to(
                COALESCE(pg_get_triggerdef(trigger.oid),''),'UTF8'
            ),'sha256'),'hex') AS definition_sha256
        FROM required_invoice_owner_triggers AS required
        LEFT JOIN pg_class AS relation
          ON relation.relname=required.table_name
         AND relation.relnamespace='public'::REGNAMESPACE
        LEFT JOIN pg_trigger AS trigger
          ON trigger.tgrelid=relation.oid
         AND trigger.tgname=required.trigger_name
         AND NOT trigger.tgisinternal
    ), invoice_owner_policy_state AS (
        SELECT
            policy.polname,
            policy.polpermissive,
            policy.polcmd,
            (SELECT string_agg(role.rolname,',' ORDER BY role.rolname COLLATE "C")
             FROM unnest(policy.polroles) AS role_oid
             JOIN pg_roles AS role ON role.oid=role_oid) AS role_names,
            regexp_replace(
                COALESCE(pg_get_expr(policy.polqual,policy.polrelid),''),
                '[[:space:]()]','','g'
            ) AS using_expression,
            regexp_replace(
                COALESCE(pg_get_expr(policy.polwithcheck,policy.polrelid),''),
                '[[:space:]()]','','g'
            ) AS check_expression
        FROM pg_policy AS policy
        WHERE policy.polrelid='public.billing_invoice_mutation_owners'::REGCLASS
    ), object_state(category, value) AS (
        SELECT 'functions', string_agg(
            signature || ':' || COALESCE(owner_name, '') || ':' ||
            COALESCE(prosecdef::TEXT, '') || ':' || configuration || ':' ||
            COALESCE(service_execute::TEXT, '') || ':' ||
            COALESCE(anon_execute::TEXT, '') || ':' ||
            COALESCE(auth_execute::TEXT, '') || ':' ||
            COALESCE(public_execute::TEXT, '') || ':' || acl_state || ':' ||
            COALESCE(unexpected_execute::TEXT, '') || ':' ||
            COALESCE(service_execute_grant_option::TEXT, '') || ':' || definition,
            '|' ORDER BY signature COLLATE "C"
        ) FROM function_state
        UNION ALL
        SELECT 'constraints', string_agg(
            definition, '|' ORDER BY definition COLLATE "C"
        ) FROM constraint_state
        UNION ALL
        SELECT 'invoice_owner_table', string_agg(
            owner_name || ':' || relrowsecurity::TEXT || ':' ||
            service_access::TEXT || ':' || auth_access::TEXT || ':' ||
            anon_access::TEXT || ':' || public_privilege::TEXT || ':' ||
            unexpected_privilege::TEXT || ':' || acl_state,
            '|' ORDER BY owner_name COLLATE "C"
        ) FROM invoice_owner_table_state
        UNION ALL
        SELECT 'invoice_owner_trigger', string_agg(
            trigger_name || ':' || COALESCE(tgenabled::TEXT,'') || ':' ||
            COALESCE(actual_tgtype::TEXT,'') || ':' ||
            COALESCE(function_matches::TEXT,'') || ':' || definition_sha256,
            '|' ORDER BY trigger_name COLLATE "C"
        ) FROM invoice_owner_trigger_state
        UNION ALL
        SELECT 'invoice_owner_columns', string_agg(
            column_name || ':' || COALESCE(actual_type,'') || ':' ||
            COALESCE(actual_not_null::TEXT,'') || ':' || actual_default || ':' ||
            COALESCE(attidentity::TEXT,'') || ':' || COALESCE(attgenerated::TEXT,''),
            '|' ORDER BY column_name COLLATE "C"
        ) FROM invoice_owner_column_state
        UNION ALL
        SELECT 'invoice_owner_policies', string_agg(
            polname || ':' || polpermissive::TEXT || ':' || polcmd::TEXT || ':' ||
            COALESCE(role_names,'') || ':' || using_expression || ':' || check_expression,
            '|' ORDER BY polname COLLATE "C"
        ) FROM invoice_owner_policy_state
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
            ('schedule_window_v1', private.koaryu_release_schedule_window_manifest_v1()),
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
             OR anon_execute OR auth_execute OR public_execute
             OR unexpected_execute OR service_execute_grant_option)
        + CASE WHEN (SELECT count(*) FROM constraint_state) = 14 THEN 0 ELSE 1 END
        + CASE WHEN (
            SELECT count(*)=1
               AND bool_and(owner_name='postgres')
               AND bool_and(relrowsecurity)
               AND NOT bool_or(
                    service_access OR auth_access OR anon_access
                    OR public_privilege OR unexpected_privilege
               )
            FROM invoice_owner_table_state
          ) THEN 0 ELSE 1 END
        + CASE WHEN (
            SELECT count(*)=10 AND bool_and(
                actual_type=expected_type
                AND actual_not_null IS NOT DISTINCT FROM expected_not_null
                AND actual_default=expected_default
                AND attidentity=''
                AND attgenerated=''
            ) FROM invoice_owner_column_state
          ) THEN 0 ELSE 1 END
        + CASE WHEN (
            SELECT count(*)=10
            FROM pg_attribute
            WHERE attrelid='public.billing_invoice_mutation_owners'::REGCLASS
              AND attnum>0 AND NOT attisdropped
          ) THEN 0 ELSE 1 END
        + CASE WHEN (
            SELECT count(*)=2
               AND count(*) FILTER (
                    WHERE polname='billing_invoice_mutation_owners_no_client_access'
                      AND NOT polpermissive AND polcmd='*'
                      AND role_names='anon,authenticated'
                      AND using_expression='false' AND check_expression='false'
               )=1
               AND count(*) FILTER (
                    WHERE polname='reject_ambiguous_staff_membership_access'
                      AND NOT polpermissive AND polcmd='*'
                      AND role_names='authenticated'
                      AND regexp_replace(
                          using_expression,'AShas_unambiguous_studio_membership$',''
                      )='SELECTprivate.has_unambiguous_studio_membership'
                      AND regexp_replace(
                          check_expression,'AShas_unambiguous_studio_membership$',''
                      )='SELECTprivate.has_unambiguous_studio_membership'
               )=1
            FROM invoice_owner_policy_state
          ) THEN 0 ELSE 1 END
        + CASE WHEN (
            SELECT count(*)=2
               AND bool_and(tgenabled='O')
               AND bool_and(actual_tgtype=expected_tgtype)
               AND bool_and(function_matches)
            FROM invoice_owner_trigger_state
          ) THEN 0 ELSE 1 END
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
    '0fafb4fe07bb2eb83d770efeb2acde63925b4185c23eac669c06783eb8f41a4e'
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
        '330d873570885be3aee2109ce2b492fbc494bf47addd3bdcd573b9829453b264' || '|' ||
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

CREATE FUNCTION public.koaryu_release_schema_preflight_v12()
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
    IF v_count <> 126 OR v_head <> '20260826185651' THEN
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
        '20260824190500','20260825042838','20260825043911','20260826030234',
        '20260826030249','20260826051527',
        '20260826073728','20260826102840','20260826155911','20260826185651'
    ]::TEXT[] THEN
        v_failures := array_append(v_failures, 'migration_history_sequence_v31');
        v_failures := array_append(v_failures, 'migration_history_sequence_v30');
    END IF;
    IF private.koaryu_release_resource_ownership_manifest_v31()
       <> '0:fb34bb3fb5e77d686b72e2bb413d6502d75b6042a437caa03344e4d2f5fa5be0' THEN
        v_failures := array_append(v_failures, 'resource_ownership_manifest_v31');
    END IF;
    IF private.koaryu_release_schedule_window_manifest_v1()
       <> '0:f4c66d3098dcb3210ac6cc92e1831eebaf9f2ed74b210e84ec773cb1d8e854a7' THEN
        v_failures := array_append(v_failures, 'schedule_window_manifest_v1');
    END IF;
    IF encode(extensions.digest(convert_to(pg_get_functiondef(
        'private.koaryu_release_schedule_window_manifest_v1()'::REGPROCEDURE
    ), 'UTF8'), 'sha256'), 'hex')
       <> '8df0d054a33defc36a16f802283cd815a6e5cfd9b1633d7aef288daa4b8158f0' THEN
        v_failures := array_append(v_failures, 'schedule_window_manifest_v1_function');
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
    IF NOT EXISTS (
        SELECT 1
        FROM pg_class AS relation
        JOIN pg_namespace AS namespace ON namespace.oid=relation.relnamespace
        JOIN pg_roles AS owner ON owner.oid=relation.relowner
        WHERE namespace.nspname='private'
          AND relation.relname='koaryu_release_v31_expectations'
          AND relation.relkind='r'
          AND owner.rolname='postgres'
          AND relation.relrowsecurity
    )
       OR has_table_privilege(
            'service_role','private.koaryu_release_v31_expectations',
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
       )
       OR has_table_privilege(
            'authenticated','private.koaryu_release_v31_expectations',
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
       )
       OR has_table_privilege(
            'anon','private.koaryu_release_v31_expectations',
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
       )
       OR EXISTS (
            SELECT 1
            FROM pg_class AS relation
            CROSS JOIN LATERAL aclexplode(COALESCE(
                relation.relacl,
                acldefault('r',relation.relowner)
            )) AS privilege
            WHERE relation.oid='private.koaryu_release_v31_expectations'::REGCLASS
              AND privilege.grantee<>relation.relowner
    ) THEN
        v_failures := array_append(v_failures, 'operational_contract_v31_expectation_acl');
    END IF;
    IF EXISTS (
        WITH required_expectation_tables(table_name) AS (
            VALUES
                ('koaryu_release_v27_expectations'),
                ('koaryu_release_v28_expectations'),
                ('koaryu_release_v29_expectations'),
                ('koaryu_release_v30_expectations')
        ), expectation_table_state AS (
            SELECT
                required.table_name,
                relation.oid,
                relation.relkind,
                relation.relrowsecurity,
                owner.rolname AS owner_name,
                COALESCE((
                    SELECT count(DISTINCT privilege.privilege_type)
                    FROM aclexplode(COALESCE(
                        relation.relacl,
                        acldefault('r', relation.relowner)
                    )) AS privilege
                    WHERE privilege.grantee=relation.relowner
                      AND NOT privilege.is_grantable
                      AND privilege.privilege_type IN (
                          'SELECT','INSERT','UPDATE','DELETE',
                          'TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'
                      )
                ), 0) AS owner_privilege_count,
                EXISTS (
                    SELECT 1
                    FROM aclexplode(COALESCE(
                        relation.relacl,
                        acldefault('r', relation.relowner)
                    )) AS privilege
                    WHERE privilege.grantee<>relation.relowner
                       OR privilege.is_grantable
                       OR privilege.privilege_type NOT IN (
                          'SELECT','INSERT','UPDATE','DELETE',
                          'TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'
                       )
                ) AS unexpected_privilege
            FROM required_expectation_tables AS required
            LEFT JOIN pg_class AS relation
              ON relation.relname=required.table_name
             AND relation.relnamespace='private'::REGNAMESPACE
            LEFT JOIN pg_roles AS owner ON owner.oid=relation.relowner
        )
        SELECT 1
        FROM expectation_table_state
        WHERE oid IS NULL
           OR relkind<>'r'
           OR owner_name<>'postgres'
           OR NOT relrowsecurity
           OR owner_privilege_count<>8
           OR unexpected_privilege
    ) THEN
        v_failures := array_append(
            v_failures,
            'inherited_operational_contract_expectation_acl'
        );
    END IF;
    SELECT expected_sha256 INTO v_expected
    FROM private.koaryu_release_v30_expectations
    WHERE expectation_key = 'operational_contract_v30';
    IF NOT FOUND
       OR (SELECT count(*) FROM private.koaryu_release_v30_expectations) <> 1
       OR v_expected <> '6396d71a8da8966ca50d412e6d5caccb7dc624775e69aef993b61e303f5d0400' THEN
        v_failures := array_append(v_failures, 'operational_contract_v30_expectation');
    END IF;
    SELECT expected_sha256 INTO v_expected
    FROM private.koaryu_release_v26_expectations
    WHERE expectation_key = 'operational_contract_v26';
    IF NOT FOUND
       OR (SELECT count(*) FROM private.koaryu_release_v26_expectations) <> 1
       OR v_expected <> '4eafa8402fd37c9003a5e0d4bbb961bf344fc4170fac7ad1e1f5bd3b9b55de5c'
       OR has_table_privilege('service_role', 'private.koaryu_release_v26_expectations', 'SELECT')
       OR has_table_privilege('authenticated', 'private.koaryu_release_v26_expectations', 'SELECT')
       OR has_table_privilege('anon', 'private.koaryu_release_v26_expectations', 'SELECT') THEN
        v_failures := array_append(v_failures, 'operational_contract_v26_expectation');
    END IF;
    IF encode(extensions.digest(convert_to(
        (SELECT prosrc FROM pg_proc
         WHERE oid = 'public.koaryu_release_schema_preflight_v7()'::REGPROCEDURE),
        'UTF8'
    ), 'sha256'), 'hex')
       <> '8ce5a3a090a1fc1d29dab85c65fe8be07d6efa9639950732d13cf88e854f91f1' THEN
        v_failures := array_append(v_failures, 'schema_preflight_v7_body');
    END IF;
    IF encode(extensions.digest(convert_to(
        (SELECT prosrc FROM pg_proc
         WHERE oid = 'public.koaryu_release_schema_preflight_v8()'::REGPROCEDURE),
        'UTF8'
    ), 'sha256'), 'hex')
       <> '245040e7bfe42122a551d112ec9d411999b519866e59c8cd537de02c85f9889a' THEN
        v_failures := array_append(v_failures, 'schema_preflight_v8_body');
    END IF;
    IF encode(extensions.digest(convert_to(
        (SELECT prosrc FROM pg_proc
         WHERE oid = 'public.koaryu_release_schema_preflight_v9()'::REGPROCEDURE),
        'UTF8'
    ), 'sha256'), 'hex')
       <> '0f34947cbc4126a929b69db07690ca4bc73fe8b5b9982190ebb6fe2ebbb2d179' THEN
        v_failures := array_append(v_failures, 'schema_preflight_v9_body');
    END IF;
    IF encode(extensions.digest(convert_to(
        (SELECT prosrc FROM pg_proc
         WHERE oid = 'public.koaryu_release_schema_preflight_v10()'::REGPROCEDURE),
        'UTF8'
    ), 'sha256'), 'hex')
       <> '6b14a7594f511f258d6b94863c369a67f08e142dc721429adc7cdab4d4e64f86' THEN
        v_failures := array_append(v_failures, 'schema_preflight_v10_body');
    END IF;
    IF encode(extensions.digest(convert_to(
        (SELECT prosrc FROM pg_proc
         WHERE oid = 'public.koaryu_release_schema_preflight_v11()'::REGPROCEDURE),
        'UTF8'
    ), 'sha256'), 'hex')
       <> '8270ab9a1a4ee091e700dc6fd2d33f2af5fa79dc1de34f3afd391c626e076843' THEN
        v_failures := array_append(v_failures, 'schema_preflight_v11_body');
    END IF;
    IF private.koaryu_release_operational_contract_v26()
       <> '0:c16c9c7c4dea83db72d774d29fbc785178b8c53b1df51549b27057849ff852ec' THEN
        v_failures := array_append(v_failures, 'operational_contract_v26');
    END IF;
    IF private.koaryu_release_operational_contract_v27()
       <> '0:c86c9569398ab09a3c5bf8c71f2558b24d454ab7be486356ae7a5b142d002863' THEN
        v_failures := array_append(v_failures, 'operational_contract_v27');
    END IF;
    IF private.koaryu_release_operational_contract_v28()
       <> '0:bad1e55d7938106e61b9799435f236cee26e06cc9e7827efe6436ecefeaf9f38' THEN
        v_failures := array_append(v_failures, 'operational_contract_v28');
    END IF;
    IF private.koaryu_release_operational_contract_v29()
       <> '0:e88193588365450a20fc05d1d50bae43d21ac9f38002e8bc8daa7dd8ac1f7276' THEN
        v_failures := array_append(v_failures, 'operational_contract_v29');
    END IF;
    IF private.koaryu_release_operational_contract_v30()
       <> '0:83cdec2d99ff624fa580d3c96a36699b7d8a04222cbeb6d6d9fcaa9a521d8af3' THEN
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
       <> '330d873570885be3aee2109ce2b492fbc494bf47addd3bdcd573b9829453b264' THEN
        v_failures := array_append(v_failures, 'operational_manifest_v11');
    END IF;
    IF private.koaryu_release_provider_operation_steps_manifest_v28()
       <> '0:c38b23cb021f0a70e900d42f40df6f6efcc7c95567038052ebc97ea4352a7869' THEN
        v_failures := array_append(v_failures, 'provider_operation_steps_manifest_v28');
        v_failures := array_append(v_failures, 'operational_contract_v28');
    END IF;
    IF encode(extensions.digest(convert_to(pg_get_functiondef(
        'private.koaryu_release_resource_ownership_manifest_v31()'::REGPROCEDURE
    ), 'UTF8'), 'sha256'), 'hex')
       <> 'bd73decc2f8a0a2137d930f8a3df727d48d83e27ef43167f0f712e78830ac9bb' THEN
        v_failures:=array_append(v_failures,'resource_ownership_manifest_v31_function');
    END IF;
    IF encode(extensions.digest(convert_to(pg_get_functiondef(
        'private.koaryu_release_operational_contract_v31()'::REGPROCEDURE
    ), 'UTF8'), 'sha256'), 'hex')
       <> '6b54e02534f38bcd7bb6e6e811d9e01c9782958319514fee3f0a2f1d4ed167d4' THEN
        v_failures:=array_append(v_failures,'operational_contract_v31_function');
    END IF;
    IF encode(extensions.digest(convert_to(pg_get_functiondef(
        'private.koaryu_release_provider_operation_steps_manifest_v28()'::REGPROCEDURE
    ), 'UTF8'), 'sha256'), 'hex')
       <> 'b16b633c6f78a2d5cf7d63f1d32679563ff2429197cc92a4d94e826b33a26035' THEN
        v_failures:=array_append(v_failures,'provider_operation_steps_manifest_v28_function');
    END IF;
    IF private.koaryu_release_live_billing_v3_manifest_v25()
       <> '0:3c2a6854c73a6e9c9704fabed38dac85b56eb26076add20c00ee97bed5bdc527' THEN
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
       <> '601e0bfa142286b2cbe13d9536f981e873d7e9359cf59a2dc2d055abde549293' THEN
        v_failures := array_append(v_failures, 'operational_manifest_v12');
    END IF;
    IF encode(extensions.digest(convert_to(pg_get_functiondef(
        'private.koaryu_release_operational_manifest_v12()'::REGPROCEDURE
    ), 'UTF8'), 'sha256'), 'hex')
       <> 'e9620730988075628439069b437f14d676cc108f21a0f420aaec65c9169f3d51' THEN
        v_failures := array_append(v_failures, 'operational_manifest_v12_function');
    END IF;
    RETURN QUERY SELECT cardinality(v_failures) = 0,
        v_count, v_head, COALESCE(v_pending, ARRAY[]::TEXT[]), v_failures,
        'release-db-attestation-v31'::TEXT;
END;
$$;
ALTER FUNCTION public.koaryu_release_schema_preflight_v12() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.koaryu_release_schema_preflight_v12()
    FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.koaryu_release_schema_preflight_v12()
    TO service_role;

CREATE OR REPLACE FUNCTION public.koaryu_release_schema_preflight_v11()
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
    SELECT * INTO v_current FROM public.koaryu_release_schema_preflight_v12();
    SELECT expected_sha256 INTO v_expected
    FROM private.koaryu_release_v30_expectations
    WHERE expectation_key = 'operational_contract_v30';
    IF NOT FOUND
       OR (SELECT count(*) FROM private.koaryu_release_v30_expectations) <> 1
       OR v_expected <> '6396d71a8da8966ca50d412e6d5caccb7dc624775e69aef993b61e303f5d0400' THEN
        v_failures := array_append(v_failures, 'operational_contract_v30_expectation');
    END IF;
    IF v_current.ready
       AND cardinality(v_failures) = 0
       AND v_current.migration_count = 126
       AND v_current.migration_head = '20260826185651' THEN
        RETURN QUERY SELECT true, 125, '20260826155911'::TEXT,
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
ALTER FUNCTION public.koaryu_release_schema_preflight_v11() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.koaryu_release_schema_preflight_v11()
    FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.koaryu_release_schema_preflight_v11()
    TO service_role;

CREATE OR REPLACE FUNCTION public.koaryu_release_schema_preflight_v10()
RETURNS TABLE(ready BOOLEAN,migration_count INTEGER,migration_head TEXT,
    pending_versions TEXT[],security_failures TEXT[],manifest_version TEXT)
LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path=pg_catalog AS $$
DECLARE v_current RECORD;
BEGIN
    SELECT * INTO v_current FROM public.koaryu_release_schema_preflight_v11();
    IF v_current.ready
       AND v_current.migration_count = 125
       AND v_current.migration_head = '20260826155911' THEN
        RETURN QUERY SELECT true, 124, '20260826102840'::TEXT,
            v_current.pending_versions[1:cardinality(v_current.pending_versions)-1],
            ARRAY[]::TEXT[], 'release-db-attestation-v29'::TEXT;
        RETURN;
    END IF;
    RETURN QUERY SELECT false,v_current.migration_count,v_current.migration_head,
        v_current.pending_versions,v_current.security_failures,
        'release-db-attestation-v29'::TEXT;
END;
$$;
ALTER FUNCTION public.koaryu_release_schema_preflight_v10() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.koaryu_release_schema_preflight_v10()
    FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.koaryu_release_schema_preflight_v10() TO service_role;

CREATE OR REPLACE FUNCTION public.koaryu_release_schema_preflight_v9()
RETURNS TABLE(ready BOOLEAN,migration_count INTEGER,migration_head TEXT,
    pending_versions TEXT[],security_failures TEXT[],manifest_version TEXT)
LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path=pg_catalog AS $$
DECLARE v_current RECORD;
BEGIN
    SELECT * INTO v_current FROM public.koaryu_release_schema_preflight_v10();
    IF v_current.ready
       AND v_current.migration_count = 124
       AND v_current.migration_head = '20260826102840' THEN
        RETURN QUERY SELECT true, 123, '20260826073728'::TEXT,
            v_current.pending_versions[1:cardinality(v_current.pending_versions)-1],
            ARRAY[]::TEXT[], 'release-db-attestation-v28'::TEXT;
        RETURN;
    END IF;
    RETURN QUERY SELECT false,v_current.migration_count,v_current.migration_head,
        v_current.pending_versions,v_current.security_failures,
        'release-db-attestation-v28'::TEXT;
END;
$$;
ALTER FUNCTION public.koaryu_release_schema_preflight_v9() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.koaryu_release_schema_preflight_v9()
    FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.koaryu_release_schema_preflight_v9() TO service_role;

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
    RAISE NOTICE 'KOARYU_V31_RESOURCE_MANIFEST_FUNCTION_SHA256=%',
        encode(extensions.digest(convert_to(pg_get_functiondef(
            'private.koaryu_release_resource_ownership_manifest_v31()'::REGPROCEDURE
        ), 'UTF8'), 'sha256'), 'hex');
    RAISE NOTICE 'KOARYU_V31_OPERATIONAL_CONTRACT_FUNCTION_SHA256=%',
        encode(extensions.digest(convert_to(pg_get_functiondef(
            'private.koaryu_release_operational_contract_v31()'::REGPROCEDURE
        ), 'UTF8'), 'sha256'), 'hex');
    RAISE NOTICE 'KOARYU_V31_PROVIDER_STEPS_MANIFEST_FUNCTION_SHA256=%',
        encode(extensions.digest(convert_to(pg_get_functiondef(
            'private.koaryu_release_provider_operation_steps_manifest_v28()'::REGPROCEDURE
        ), 'UTF8'), 'sha256'), 'hex');
    RAISE NOTICE 'KOARYU_V31_OPERATION_AUTHORIZATION_WRITER_FUNCTION_SHA256=%',
        encode(extensions.digest(convert_to(pg_get_functiondef(
            'public.set_studio_live_billing_authorization_operations_v1(uuid,text,boolean,timestamp with time zone,text,uuid,text[],text,text)'::REGPROCEDURE
        ), 'UTF8'), 'sha256'), 'hex');
    RAISE NOTICE 'KOARYU_V31_PREDECESSOR_REPLAY_MANIFEST_V30_FUNCTION_SHA256=%',
        encode(extensions.digest(convert_to(pg_get_functiondef(
            'private.koaryu_release_payments_replay_repairs_manifest_v30()'::REGPROCEDURE
        ), 'UTF8'), 'sha256'), 'hex');
    RAISE NOTICE 'KOARYU_V31_SCHEMA_PREFLIGHT_V7_PROSRC_SHA256=%',
        encode(extensions.digest(convert_to((
            SELECT prosrc FROM pg_proc
            WHERE oid = 'public.koaryu_release_schema_preflight_v7()'::REGPROCEDURE
        ), 'UTF8'), 'sha256'), 'hex');
    RAISE NOTICE 'KOARYU_V31_SCHEMA_PREFLIGHT_V8_PROSRC_SHA256=%',
        encode(extensions.digest(convert_to((
            SELECT prosrc FROM pg_proc
            WHERE oid = 'public.koaryu_release_schema_preflight_v8()'::REGPROCEDURE
        ), 'UTF8'), 'sha256'), 'hex');
    RAISE NOTICE 'KOARYU_V31_SCHEMA_PREFLIGHT_V9_PROSRC_SHA256=%',
        encode(extensions.digest(convert_to((
            SELECT prosrc FROM pg_proc
            WHERE oid = 'public.koaryu_release_schema_preflight_v9()'::REGPROCEDURE
        ), 'UTF8'), 'sha256'), 'hex');
    RAISE NOTICE 'KOARYU_V31_SCHEMA_PREFLIGHT_V10_PROSRC_SHA256=%',
        encode(extensions.digest(convert_to((
            SELECT prosrc FROM pg_proc
            WHERE oid = 'public.koaryu_release_schema_preflight_v10()'::REGPROCEDURE
        ), 'UTF8'), 'sha256'), 'hex');
    RAISE NOTICE 'KOARYU_V31_SCHEMA_PREFLIGHT_V11_PROSRC_SHA256=%',
        encode(extensions.digest(convert_to((
            SELECT prosrc FROM pg_proc
            WHERE oid = 'public.koaryu_release_schema_preflight_v11()'::REGPROCEDURE
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
    RAISE NOTICE 'KOARYU_V31_COMPAT_V28_PROVIDER_MANIFEST=%',
        private.koaryu_release_provider_operation_steps_manifest_v28();
    RAISE NOTICE 'KOARYU_V31_CRITICAL_SURFACE_MANIFEST=%',
        private.koaryu_release_critical_surface_manifest_v18();
END;
$v31_observation$;
