-- Keep provider payment accounting separate from Stripe invoice receivables.
-- Refunds and disputes may change collected and refundable amounts, but they do
-- not create a new invoice balance or another collection attempt.

DO $payments_v25_preflight_guard$
DECLARE
    v_preflight RECORD;
BEGIN
    SELECT *
      INTO v_preflight
      FROM public.koaryu_release_schema_preflight_v6();

    IF v_preflight.ready IS DISTINCT FROM true
       OR v_preflight.migration_count IS DISTINCT FROM 120
       OR v_preflight.migration_head IS DISTINCT FROM '20260826030234'
       OR v_preflight.pending_versions IS DISTINCT FROM ARRAY[
            '20260727100000','20260727110000','20260801050957','20260801060000',
            '20260801070000','20260801080000','20260801090000','20260801091000',
            '20260801092000','20260801093000','20260801094000','20260801105313',
            '20260801112153','20260801115044','20260801123112','20260801131844',
            '20260814043325','20260814103046','20260814105424','20260814114500',
            '20260814152000','20260814170000','20260814183000','20260814200000',
            '20260814213000','20260815220402','20260816012723','20260820012533',
            '20260820025759','20260820060216','20260822193000','20260823193155',
            '20260824190500','20260825042838','20260825043911','20260826030234'
       ]::TEXT[]
       OR COALESCE(v_preflight.security_failures, ARRAY[]::TEXT[])
            <> ARRAY[]::TEXT[]
       OR v_preflight.manifest_version IS DISTINCT FROM
            'release-db-attestation-v25' THEN
        RAISE EXCEPTION
            'Payment adjustment convergence requires the exact ready 120/V25 predecessor.';
    END IF;
END;
$payments_v25_preflight_guard$;

ALTER TABLE public.billing_payments
    ADD COLUMN IF NOT EXISTS connect_account_generation INTEGER,
    ADD COLUMN IF NOT EXISTS gross_paid_amount_cents INTEGER
        GENERATED ALWAYS AS (
            CASE
                WHEN status IN ('succeeded', 'refunded', 'disputed', 'externally_recorded')
                    THEN amount_cents
                ELSE 0
            END
        ) STORED NOT NULL,
    ADD COLUMN IF NOT EXISTS disputed_amount_cents INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS net_collected_amount_cents INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS refundable_amount_cents INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS adjustment_reconciliation_required BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS adjustment_reconciliation_reason_code TEXT;

ALTER TABLE public.billing_payments
    DROP CONSTRAINT IF EXISTS billing_payments_connect_account_generation_check,
    ADD CONSTRAINT billing_payments_connect_account_generation_check
        CHECK (connect_account_generation IS NULL OR connect_account_generation > 0) NOT VALID,
    DROP CONSTRAINT IF EXISTS billing_payments_disputed_amount_cents_check,
    ADD CONSTRAINT billing_payments_disputed_amount_cents_check
        CHECK (disputed_amount_cents >= 0) NOT VALID,
    DROP CONSTRAINT IF EXISTS billing_payments_net_collected_amount_cents_check,
    ADD CONSTRAINT billing_payments_net_collected_amount_cents_check
        CHECK (net_collected_amount_cents >= 0) NOT VALID,
    DROP CONSTRAINT IF EXISTS billing_payments_refundable_amount_cents_check,
    ADD CONSTRAINT billing_payments_refundable_amount_cents_check
        CHECK (refundable_amount_cents >= 0) NOT VALID;

ALTER TABLE public.billing_payments
    DROP CONSTRAINT IF EXISTS billing_payments_adjustment_totals_check;

ALTER TABLE public.billing_refunds
    ADD COLUMN IF NOT EXISTS connect_account_generation INTEGER,
    ADD COLUMN IF NOT EXISTS last_stripe_event_created BIGINT,
    ADD COLUMN IF NOT EXISTS reconciliation_required BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS reconciliation_reason_code TEXT;

ALTER TABLE public.billing_refunds
    DROP CONSTRAINT IF EXISTS billing_refunds_connect_account_generation_check,
    ADD CONSTRAINT billing_refunds_connect_account_generation_check
        CHECK (connect_account_generation IS NULL OR connect_account_generation > 0) NOT VALID;

ALTER TABLE public.billing_disputes
    ADD COLUMN IF NOT EXISTS connect_account_generation INTEGER,
    ADD COLUMN IF NOT EXISTS state_category TEXT NOT NULL DEFAULT 'unknown',
    ADD COLUMN IF NOT EXISTS last_stripe_event_created BIGINT,
    ADD COLUMN IF NOT EXISTS reconciliation_required BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS reconciliation_reason_code TEXT;

ALTER TABLE public.billing_disputes
    DROP CONSTRAINT IF EXISTS billing_disputes_connect_account_generation_check,
    ADD CONSTRAINT billing_disputes_connect_account_generation_check
        CHECK (connect_account_generation IS NULL OR connect_account_generation > 0) NOT VALID,
    DROP CONSTRAINT IF EXISTS billing_disputes_state_category_check,
    ADD CONSTRAINT billing_disputes_state_category_check
        CHECK (state_category IN ('warning', 'active', 'won', 'lost', 'unknown')) NOT VALID;

WITH account_generations AS (
    SELECT
        studio_id,
        stripe_connected_account_id,
        CASE
            WHEN metadata->>'connect_account_generation' ~ '^[1-9][0-9]{0,9}$'
                 AND (metadata->>'connect_account_generation')::NUMERIC <= 2147483647
                THEN (metadata->>'connect_account_generation')::INTEGER
            ELSE 1
        END AS connect_account_generation
    FROM public.studio_payment_accounts
    WHERE stripe_connected_account_id IS NOT NULL
)
UPDATE public.billing_payments AS payment
SET connect_account_generation = account.connect_account_generation
FROM account_generations AS account
WHERE payment.studio_id = account.studio_id
  AND payment.stripe_account_id = account.stripe_connected_account_id
  AND payment.connect_account_generation IS NULL
  AND account.connect_account_generation = 1;

WITH account_generations AS (
    SELECT
        studio_id,
        stripe_connected_account_id,
        CASE
            WHEN metadata->>'connect_account_generation' ~ '^[1-9][0-9]{0,9}$'
                 AND (metadata->>'connect_account_generation')::NUMERIC <= 2147483647
                THEN (metadata->>'connect_account_generation')::INTEGER
            ELSE 1
        END AS connect_account_generation
    FROM public.studio_payment_accounts
    WHERE stripe_connected_account_id IS NOT NULL
)
UPDATE public.billing_refunds AS refund
SET connect_account_generation = account.connect_account_generation
FROM account_generations AS account
WHERE refund.studio_id = account.studio_id
  AND refund.stripe_account_id = account.stripe_connected_account_id
  AND refund.connect_account_generation IS NULL
  AND account.connect_account_generation = 1;

WITH account_generations AS (
    SELECT
        studio_id,
        stripe_connected_account_id,
        CASE
            WHEN metadata->>'connect_account_generation' ~ '^[1-9][0-9]{0,9}$'
                 AND (metadata->>'connect_account_generation')::NUMERIC <= 2147483647
                THEN (metadata->>'connect_account_generation')::INTEGER
            ELSE 1
        END AS connect_account_generation
    FROM public.studio_payment_accounts
    WHERE stripe_connected_account_id IS NOT NULL
)
UPDATE public.billing_disputes AS dispute
SET connect_account_generation = account.connect_account_generation
FROM account_generations AS account
WHERE dispute.studio_id = account.studio_id
  AND dispute.stripe_account_id = account.stripe_connected_account_id
  AND dispute.connect_account_generation IS NULL
  AND account.connect_account_generation = 1;

WITH account_generations AS (
    SELECT
        studio_id,
        stripe_connected_account_id,
        CASE
            WHEN metadata->>'connect_account_generation' ~ '^[1-9][0-9]{0,9}$'
                 AND (metadata->>'connect_account_generation')::NUMERIC <= 2147483647
                THEN (metadata->>'connect_account_generation')::INTEGER
            ELSE 1
        END AS connect_account_generation
    FROM public.studio_payment_accounts
    WHERE stripe_connected_account_id IS NOT NULL
)
UPDATE public.billing_payments AS payment
SET adjustment_reconciliation_required = true,
    adjustment_reconciliation_reason_code = 'historical_connect_generation_unknown'
FROM account_generations AS account
WHERE payment.studio_id = account.studio_id
  AND payment.stripe_account_id = account.stripe_connected_account_id
  AND payment.connect_account_generation IS NULL
  AND account.connect_account_generation > 1;

WITH account_generations AS (
    SELECT
        studio_id,
        stripe_connected_account_id,
        CASE
            WHEN metadata->>'connect_account_generation' ~ '^[1-9][0-9]{0,9}$'
                 AND (metadata->>'connect_account_generation')::NUMERIC <= 2147483647
                THEN (metadata->>'connect_account_generation')::INTEGER
            ELSE 1
        END AS connect_account_generation
    FROM public.studio_payment_accounts
    WHERE stripe_connected_account_id IS NOT NULL
)
UPDATE public.billing_refunds AS refund
SET reconciliation_required = true,
    reconciliation_reason_code = 'historical_connect_generation_unknown'
FROM account_generations AS account
WHERE refund.studio_id = account.studio_id
  AND refund.stripe_account_id = account.stripe_connected_account_id
  AND refund.connect_account_generation IS NULL
  AND account.connect_account_generation > 1;

WITH account_generations AS (
    SELECT
        studio_id,
        stripe_connected_account_id,
        CASE
            WHEN metadata->>'connect_account_generation' ~ '^[1-9][0-9]{0,9}$'
                 AND (metadata->>'connect_account_generation')::NUMERIC <= 2147483647
                THEN (metadata->>'connect_account_generation')::INTEGER
            ELSE 1
        END AS connect_account_generation
    FROM public.studio_payment_accounts
    WHERE stripe_connected_account_id IS NOT NULL
)
UPDATE public.billing_disputes AS dispute
SET reconciliation_required = true,
    reconciliation_reason_code = 'historical_connect_generation_unknown'
FROM account_generations AS account
WHERE dispute.studio_id = account.studio_id
  AND dispute.stripe_account_id = account.stripe_connected_account_id
  AND dispute.connect_account_generation IS NULL
  AND account.connect_account_generation > 1;

UPDATE public.billing_disputes
SET state_category = CASE
    WHEN status IN ('warning_needs_response', 'warning_under_review', 'warning_closed', 'prevented')
        THEN 'warning'
    WHEN status IN ('needs_response', 'under_review') THEN 'active'
    WHEN status = 'won' THEN 'won'
    WHEN status = 'lost' THEN 'lost'
    ELSE 'unknown'
END,
reconciliation_required = reconciliation_required OR status NOT IN (
        'warning_needs_response', 'warning_under_review', 'warning_closed', 'prevented',
        'needs_response', 'under_review', 'won', 'lost'
    ),
reconciliation_reason_code = CASE
    WHEN reconciliation_reason_code = 'historical_connect_generation_unknown'
        THEN reconciliation_reason_code
    WHEN status NOT IN (
        'warning_needs_response', 'warning_under_review', 'warning_closed', 'prevented',
        'needs_response', 'under_review', 'won', 'lost'
    ) THEN 'unknown_dispute_status'
    ELSE NULL
END;

CREATE OR REPLACE FUNCTION private.recompute_billing_payment_adjustment_totals(
    p_payment_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
    v_payment public.billing_payments%ROWTYPE;
    v_gross INTEGER := 0;
    v_raw_refunded BIGINT := 0;
    v_refunded INTEGER := 0;
    v_raw_disputed BIGINT := 0;
    v_disputed INTEGER := 0;
    v_net INTEGER := 0;
    v_unknown_dispute BOOLEAN := false;
    v_reason TEXT := NULL;
    v_status TEXT;
BEGIN
    SELECT *
    INTO v_payment
    FROM public.billing_payments
    WHERE id = p_payment_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN;
    END IF;

    v_gross := v_payment.gross_paid_amount_cents;

    SELECT COALESCE(SUM(GREATEST(refund.amount_cents, 0)), 0)
    INTO v_raw_refunded
    FROM public.billing_refunds AS refund
    WHERE refund.payment_id = v_payment.id
      AND refund.studio_id = v_payment.studio_id
      AND refund.stripe_account_id IS NOT DISTINCT FROM v_payment.stripe_account_id
      AND refund.connect_account_generation IS NOT DISTINCT FROM v_payment.connect_account_generation
      AND refund.status = 'succeeded';

    v_refunded := LEAST(v_gross::BIGINT, v_raw_refunded)::INTEGER;

    SELECT
        COALESCE(SUM(
            CASE
                WHEN dispute.state_category IN ('active', 'lost', 'unknown')
                    THEN GREATEST(dispute.amount_cents, 0)
                ELSE 0
            END
        ), 0),
        COALESCE(BOOL_OR(
            dispute.state_category = 'unknown' OR dispute.reconciliation_required
        ), false)
    INTO v_raw_disputed, v_unknown_dispute
    FROM public.billing_disputes AS dispute
    WHERE dispute.payment_id = v_payment.id
      AND dispute.studio_id = v_payment.studio_id
      AND dispute.stripe_account_id IS NOT DISTINCT FROM v_payment.stripe_account_id
      AND dispute.connect_account_generation IS NOT DISTINCT FROM v_payment.connect_account_generation;

    v_disputed := LEAST(
        GREATEST(v_gross - v_refunded, 0)::BIGINT,
        v_raw_disputed
    )::INTEGER;
    v_net := GREATEST(v_gross - v_refunded - v_disputed, 0);

    IF v_payment.adjustment_reconciliation_reason_code =
       'historical_connect_generation_unknown' THEN
        v_reason := 'historical_connect_generation_unknown';
    ELSIF v_raw_refunded > v_gross THEN
        v_reason := 'succeeded_refunds_exceed_payment';
    ELSIF v_unknown_dispute THEN
        v_reason := 'unknown_dispute_status';
    END IF;

    IF v_disputed > 0 THEN
        v_status := 'disputed';
    ELSIF v_gross > 0 AND v_refunded >= v_gross THEN
        v_status := 'refunded';
    ELSIF v_payment.status IN ('disputed', 'refunded', 'succeeded') THEN
        v_status := 'succeeded';
    ELSE
        v_status := v_payment.status;
    END IF;

    UPDATE public.billing_payments
    SET status = v_status,
        refunded_amount_cents = v_refunded,
        disputed_amount_cents = v_disputed,
        net_collected_amount_cents = v_net,
        refundable_amount_cents = CASE
            WHEN v_payment.stripe_charge_id IS NOT NULL THEN v_net
            ELSE 0
        END,
        adjustment_reconciliation_required = v_reason IS NOT NULL,
        adjustment_reconciliation_reason_code = v_reason
    WHERE id = v_payment.id;
END;
$$;

ALTER FUNCTION private.recompute_billing_payment_adjustment_totals(UUID)
    OWNER TO postgres;
REVOKE ALL ON FUNCTION private.recompute_billing_payment_adjustment_totals(UUID)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.recompute_billing_payment_adjustment_totals(UUID) TO service_role;

CREATE OR REPLACE FUNCTION private.validate_billing_payment_identity_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
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

    -- The payment row is already locked by the UPDATE. Child writers lock
    -- payment rows before validation, so an identity enrichment and a child
    -- link serialize on the parent without a parent-to-child lock inversion.
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

DROP TRIGGER IF EXISTS validate_billing_payment_identity_change ON public.billing_payments;
CREATE TRIGGER validate_billing_payment_identity_change
    BEFORE UPDATE OF
        id,
        studio_id,
        payer_id,
        invoice_id,
        stripe_customer_id,
        stripe_invoice_id,
        stripe_payment_intent_id,
        stripe_charge_id,
        stripe_account_id,
        connect_account_generation,
        stripe_payment_method_id
    ON public.billing_payments
    FOR EACH ROW EXECUTE FUNCTION private.validate_billing_payment_identity_change();

CREATE OR REPLACE FUNCTION private.validate_billing_adjustment_payment_identity()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
    v_payment public.billing_payments%ROWTYPE;
    v_old_payment_id UUID;
    v_new_payment_id UUID;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        v_old_payment_id := OLD.payment_id;
    END IF;

    v_new_payment_id := NEW.payment_id;

    -- A child move can touch two parents. Lock both in UUID order before the
    -- compatibility read so child moves and payment identity updates cannot
    -- commit an incompatible parent/child pair or form an AB-BA cycle.
    PERFORM 1
    FROM public.billing_payments AS payment
    WHERE payment.id = ANY (
        array_remove(ARRAY[v_old_payment_id, v_new_payment_id], NULL::UUID)
    )
    ORDER BY payment.id
    FOR UPDATE;

    IF TG_OP = 'UPDATE' THEN
        IF OLD.studio_id IS DISTINCT FROM NEW.studio_id
           OR (
                OLD.payment_id IS NOT NULL
                AND OLD.payment_id IS DISTINCT FROM NEW.payment_id
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
                OLD.stripe_charge_id IS NOT NULL
                AND OLD.stripe_charge_id IS DISTINCT FROM NEW.stripe_charge_id
           )
           OR (
                OLD.stripe_payment_intent_id IS NOT NULL
                AND OLD.stripe_payment_intent_id IS DISTINCT FROM NEW.stripe_payment_intent_id
           ) THEN
            RAISE EXCEPTION 'Established billing adjustment identity cannot change.'
                USING ERRCODE = '23514';
        END IF;

        IF TG_TABLE_NAME = 'billing_refunds'
           AND OLD.stripe_refund_id IS NOT NULL
           AND OLD.stripe_refund_id IS DISTINCT FROM NEW.stripe_refund_id THEN
            RAISE EXCEPTION 'Established billing adjustment identity cannot change.'
                USING ERRCODE = '23514';
        END IF;

        IF TG_TABLE_NAME = 'billing_disputes'
           AND OLD.stripe_dispute_id IS NOT NULL
           AND OLD.stripe_dispute_id IS DISTINCT FROM NEW.stripe_dispute_id THEN
            RAISE EXCEPTION 'Established billing adjustment identity cannot change.'
                USING ERRCODE = '23514';
        END IF;
    END IF;

    IF NEW.payment_id IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT *
    INTO v_payment
    FROM public.billing_payments
    WHERE id = NEW.payment_id;

    IF NOT FOUND
       OR v_payment.studio_id IS DISTINCT FROM NEW.studio_id
       OR v_payment.stripe_account_id IS DISTINCT FROM NEW.stripe_account_id
       OR v_payment.connect_account_generation IS DISTINCT FROM NEW.connect_account_generation
       OR v_payment.stripe_charge_id IS DISTINCT FROM NEW.stripe_charge_id
       OR v_payment.stripe_payment_intent_id IS DISTINCT FROM NEW.stripe_payment_intent_id THEN
        RAISE EXCEPTION 'Billing adjustment payment identity mismatch.'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

ALTER FUNCTION private.validate_billing_adjustment_payment_identity()
    OWNER TO postgres;
REVOKE ALL ON FUNCTION private.validate_billing_adjustment_payment_identity()
    FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS validate_billing_refund_payment_identity ON public.billing_refunds;
CREATE TRIGGER validate_billing_refund_payment_identity
    BEFORE INSERT OR UPDATE OF
        payment_id,
        studio_id,
        stripe_refund_id,
        stripe_charge_id,
        stripe_payment_intent_id,
        stripe_account_id,
        connect_account_generation
    ON public.billing_refunds
    FOR EACH ROW EXECUTE FUNCTION private.validate_billing_adjustment_payment_identity();

DROP TRIGGER IF EXISTS validate_billing_dispute_payment_identity ON public.billing_disputes;
CREATE TRIGGER validate_billing_dispute_payment_identity
    BEFORE INSERT OR UPDATE OF
        payment_id,
        studio_id,
        stripe_dispute_id,
        stripe_charge_id,
        stripe_payment_intent_id,
        stripe_account_id,
        connect_account_generation
    ON public.billing_disputes
    FOR EACH ROW EXECUTE FUNCTION private.validate_billing_adjustment_payment_identity();

CREATE OR REPLACE FUNCTION private.recompute_payment_after_adjustment_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
    v_old_payment_id UUID;
    v_new_payment_id UUID;
BEGIN
    IF TG_OP IN ('UPDATE', 'DELETE') THEN
        v_old_payment_id := OLD.payment_id;
    END IF;
    IF TG_OP IN ('INSERT', 'UPDATE') THEN
        v_new_payment_id := NEW.payment_id;
    END IF;

    -- An adjustment move may touch two payments. Lock both in UUID order before
    -- recomputing either so opposite concurrent moves cannot lock A then B and
    -- B then A.
    PERFORM 1
    FROM public.billing_payments AS payment
    WHERE payment.id = ANY (
        array_remove(ARRAY[v_old_payment_id, v_new_payment_id], NULL::UUID)
    )
    ORDER BY payment.id
    FOR UPDATE;

    IF v_old_payment_id IS NOT NULL
       AND v_old_payment_id IS DISTINCT FROM v_new_payment_id THEN
        PERFORM private.recompute_billing_payment_adjustment_totals(v_old_payment_id);
    END IF;
    IF v_new_payment_id IS NOT NULL THEN
        PERFORM private.recompute_billing_payment_adjustment_totals(v_new_payment_id);
    END IF;
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$;

ALTER FUNCTION private.recompute_payment_after_adjustment_change()
    OWNER TO postgres;
REVOKE ALL ON FUNCTION private.recompute_payment_after_adjustment_change()
    FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS recompute_payment_after_refund_change ON public.billing_refunds;
CREATE TRIGGER recompute_payment_after_refund_change
    AFTER INSERT OR UPDATE OR DELETE ON public.billing_refunds
    FOR EACH ROW EXECUTE FUNCTION private.recompute_payment_after_adjustment_change();

DROP TRIGGER IF EXISTS recompute_payment_after_dispute_change ON public.billing_disputes;
CREATE TRIGGER recompute_payment_after_dispute_change
    AFTER INSERT OR UPDATE OR DELETE ON public.billing_disputes
    FOR EACH ROW EXECUTE FUNCTION private.recompute_payment_after_adjustment_change();

WITH refund_totals AS (
    SELECT
        payment.id AS payment_id,
        COALESCE(
            SUM(GREATEST(refund.amount_cents, 0))
                FILTER (WHERE refund.status = 'succeeded'),
            0
        ) AS raw_refunded
    FROM public.billing_payments AS payment
    LEFT JOIN public.billing_refunds AS refund
      ON refund.payment_id = payment.id
     AND refund.studio_id = payment.studio_id
     AND refund.stripe_account_id IS NOT DISTINCT FROM payment.stripe_account_id
     AND refund.connect_account_generation IS NOT DISTINCT FROM payment.connect_account_generation
    GROUP BY payment.id
),
dispute_totals AS (
    SELECT
        payment.id AS payment_id,
        COALESCE(
            SUM(
                CASE
                    WHEN dispute.state_category IN ('active', 'lost', 'unknown')
                        THEN GREATEST(dispute.amount_cents, 0)
                    ELSE 0
                END
            ),
            0
        ) AS raw_disputed,
        COALESCE(
            BOOL_OR(
                dispute.state_category = 'unknown'
                OR dispute.reconciliation_required
            ) FILTER (WHERE dispute.id IS NOT NULL),
            false
        ) AS has_unknown_dispute
    FROM public.billing_payments AS payment
    LEFT JOIN public.billing_disputes AS dispute
      ON dispute.payment_id = payment.id
     AND dispute.studio_id = payment.studio_id
     AND dispute.stripe_account_id IS NOT DISTINCT FROM payment.stripe_account_id
     AND dispute.connect_account_generation IS NOT DISTINCT FROM payment.connect_account_generation
    GROUP BY payment.id
),
refund_capped AS (
    SELECT
        payment.id AS payment_id,
        payment.status,
        payment.gross_paid_amount_cents AS gross_paid,
        payment.stripe_charge_id,
        payment.adjustment_reconciliation_reason_code AS existing_reason,
        refund.raw_refunded,
        dispute.raw_disputed,
        dispute.has_unknown_dispute,
        LEAST(
            payment.gross_paid_amount_cents::BIGINT,
            refund.raw_refunded
        )::INTEGER AS refunded
    FROM public.billing_payments AS payment
    JOIN refund_totals AS refund ON refund.payment_id = payment.id
    JOIN dispute_totals AS dispute ON dispute.payment_id = payment.id
),
calculated AS (
    SELECT
        refund.*,
        LEAST(
            GREATEST(refund.gross_paid - refund.refunded, 0)::BIGINT,
            refund.raw_disputed
        )::INTEGER AS disputed
    FROM refund_capped AS refund
)
UPDATE public.billing_payments AS payment
SET status = CASE
        WHEN calculated.disputed > 0 THEN 'disputed'
        WHEN calculated.gross_paid > 0
             AND calculated.refunded >= calculated.gross_paid THEN 'refunded'
        WHEN calculated.status IN ('disputed', 'refunded', 'succeeded') THEN 'succeeded'
        ELSE calculated.status
    END,
    refunded_amount_cents = calculated.refunded,
    disputed_amount_cents = calculated.disputed,
    net_collected_amount_cents = GREATEST(
        calculated.gross_paid - calculated.refunded - calculated.disputed,
        0
    ),
    refundable_amount_cents = CASE
        WHEN calculated.stripe_charge_id IS NOT NULL THEN GREATEST(
            calculated.gross_paid - calculated.refunded - calculated.disputed,
            0
        )
        ELSE 0
    END,
    adjustment_reconciliation_required = (
        calculated.existing_reason = 'historical_connect_generation_unknown'
        OR calculated.raw_refunded > calculated.gross_paid
        OR calculated.has_unknown_dispute
    ),
    adjustment_reconciliation_reason_code = CASE
        WHEN calculated.existing_reason = 'historical_connect_generation_unknown'
            THEN calculated.existing_reason
        WHEN calculated.raw_refunded > calculated.gross_paid
            THEN 'succeeded_refunds_exceed_payment'
        WHEN calculated.has_unknown_dispute THEN 'unknown_dispute_status'
        ELSE NULL
    END
FROM calculated
WHERE payment.id = calculated.payment_id;

ALTER TABLE public.billing_payments
    ADD CONSTRAINT billing_payments_adjustment_totals_check
        CHECK (
            refunded_amount_cents + disputed_amount_cents + net_collected_amount_cents
            = gross_paid_amount_cents
            AND refundable_amount_cents = CASE
                WHEN stripe_charge_id IS NOT NULL THEN net_collected_amount_cents
                ELSE 0
            END
        ) NOT VALID;

ALTER TABLE public.billing_payments
    VALIDATE CONSTRAINT billing_payments_connect_account_generation_check,
    VALIDATE CONSTRAINT billing_payments_disputed_amount_cents_check,
    VALIDATE CONSTRAINT billing_payments_net_collected_amount_cents_check,
    VALIDATE CONSTRAINT billing_payments_refundable_amount_cents_check,
    VALIDATE CONSTRAINT billing_payments_adjustment_totals_check;

ALTER TABLE public.billing_refunds
    VALIDATE CONSTRAINT billing_refunds_connect_account_generation_check;

ALTER TABLE public.billing_disputes
    VALIDATE CONSTRAINT billing_disputes_connect_account_generation_check,
    VALIDATE CONSTRAINT billing_disputes_state_category_check;

COMMENT ON COLUMN public.billing_payments.amount_cents IS
    'Provider payment amount. Failed or pending attempts are not gross paid.';
COMMENT ON COLUMN public.billing_payments.gross_paid_amount_cents IS
    'Collected gross amount derived from provider payment status before refunds and disputes.';
COMMENT ON COLUMN public.billing_payments.net_collected_amount_cents IS
    'Gross payment less succeeded refunds and balance-reversing disputes, capped at zero.';
COMMENT ON COLUMN public.billing_payments.refundable_amount_cents IS
    'Amount still eligible for an explicit refund after succeeded refunds and balance-reversing disputes.';
COMMENT ON COLUMN public.billing_invoices.amount_remaining_cents IS
    'Stripe invoice receivable. Refund and dispute projection must not rewrite this amount.';

CREATE FUNCTION private.koaryu_release_payment_adjustment_manifest_v26()
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
        signature,
        expected_security_definer,
        expected_search_path,
        expected_service_execute
    ) AS (
        VALUES
          (
            'private.recompute_billing_payment_adjustment_totals(uuid)',
            false,
            'search_path=""',
            true
          ),
          (
            'private.validate_billing_payment_identity_change()',
            false,
            'search_path=""',
            false
          ),
          (
            'private.validate_billing_adjustment_payment_identity()',
            false,
            'search_path=""',
            false
          ),
          (
            'private.recompute_payment_after_adjustment_change()',
            false,
            'search_path=""',
            false
          )
    ),
    function_state AS (
        SELECT
            required.signature,
            procedure.oid,
            COALESCE(owner.rolname, '') AS owner_name,
            COALESCE(procedure.prosecdef::TEXT, '') AS security_definer,
            COALESCE(array_to_string(procedure.proconfig, ','), '') AS configuration,
            has_function_privilege('service_role', procedure.oid, 'EXECUTE')
                AS service_execute,
            has_function_privilege('anon', procedure.oid, 'EXECUTE')
                AS anon_execute,
            has_function_privilege('authenticated', procedure.oid, 'EXECUTE')
                AS authenticated_execute,
            EXISTS (
                SELECT 1
                  FROM aclexplode(
                      COALESCE(
                          procedure.proacl,
                          acldefault('f', procedure.proowner)
                      )
                  ) privilege
                 WHERE privilege.grantee = 0
                   AND privilege.privilege_type = 'EXECUTE'
            ) AS public_execute,
            EXISTS (
                SELECT 1
                  FROM aclexplode(
                      COALESCE(
                          procedure.proacl,
                          acldefault('f', procedure.proowner)
                      )
                  ) privilege
                  JOIN pg_roles grantee ON grantee.oid = privilege.grantee
                 WHERE privilege.privilege_type = 'EXECUTE'
                   AND grantee.rolname NOT IN (
                       'postgres',
                       CASE
                           WHEN required.expected_service_execute
                               THEN 'service_role'
                           ELSE 'postgres'
                       END
                   )
            ) AS unexpected_execute,
            COALESCE(pg_get_functiondef(procedure.oid), '') AS definition,
            required.expected_security_definer,
            required.expected_search_path,
            required.expected_service_execute
        FROM required_functions required
        LEFT JOIN pg_proc procedure
          ON procedure.oid = to_regprocedure(required.signature)
        LEFT JOIN pg_roles owner ON owner.oid = procedure.proowner
    ),
    required_columns(
        table_name,
        column_name,
        data_type,
        nullable,
        generated_kind
    ) AS (
        VALUES
          ('billing_payments', 'connect_account_generation', 'integer', true, ''),
          ('billing_payments', 'gross_paid_amount_cents', 'integer', false, 's'),
          ('billing_payments', 'disputed_amount_cents', 'integer', false, ''),
          ('billing_payments', 'net_collected_amount_cents', 'integer', false, ''),
          ('billing_payments', 'refundable_amount_cents', 'integer', false, ''),
          ('billing_payments', 'adjustment_reconciliation_required', 'boolean', false, ''),
          ('billing_payments', 'adjustment_reconciliation_reason_code', 'text', true, ''),
          ('billing_refunds', 'connect_account_generation', 'integer', true, ''),
          ('billing_refunds', 'last_stripe_event_created', 'bigint', true, ''),
          ('billing_refunds', 'reconciliation_required', 'boolean', false, ''),
          ('billing_refunds', 'reconciliation_reason_code', 'text', true, ''),
          ('billing_disputes', 'connect_account_generation', 'integer', true, ''),
          ('billing_disputes', 'state_category', 'text', false, ''),
          ('billing_disputes', 'last_stripe_event_created', 'bigint', true, ''),
          ('billing_disputes', 'reconciliation_required', 'boolean', false, ''),
          ('billing_disputes', 'reconciliation_reason_code', 'text', true, '')
    ),
    column_state AS (
        SELECT
            required.*,
            attribute.attname IS NOT NULL AS present,
            format_type(attribute.atttypid, attribute.atttypmod) AS actual_data_type,
            NOT attribute.attnotnull AS actual_nullable,
            attribute.attgenerated::TEXT AS actual_generated_kind,
            COALESCE(pg_get_expr(default_row.adbin, default_row.adrelid), '')
                AS expression
        FROM required_columns required
        LEFT JOIN pg_namespace namespace ON namespace.nspname = 'public'
        LEFT JOIN pg_class relation
          ON relation.relnamespace = namespace.oid
         AND relation.relname = required.table_name
        LEFT JOIN pg_attribute attribute
          ON attribute.attrelid = relation.oid
         AND attribute.attname = required.column_name
         AND attribute.attnum > 0
         AND NOT attribute.attisdropped
        LEFT JOIN pg_attrdef default_row
          ON default_row.adrelid = relation.oid
         AND default_row.adnum = attribute.attnum
    ),
    required_constraints(table_name, constraint_name) AS (
        VALUES
          ('billing_payments', 'billing_payments_connect_account_generation_check'),
          ('billing_payments', 'billing_payments_disputed_amount_cents_check'),
          ('billing_payments', 'billing_payments_net_collected_amount_cents_check'),
          ('billing_payments', 'billing_payments_refundable_amount_cents_check'),
          ('billing_payments', 'billing_payments_adjustment_totals_check'),
          ('billing_refunds', 'billing_refunds_connect_account_generation_check'),
          ('billing_disputes', 'billing_disputes_connect_account_generation_check'),
          ('billing_disputes', 'billing_disputes_state_category_check')
    ),
    constraint_state AS (
        SELECT
            required.*,
            constraint_row.oid,
            constraint_row.contype::TEXT AS constraint_type,
            constraint_row.convalidated,
            COALESCE(pg_get_constraintdef(constraint_row.oid), '') AS definition
        FROM required_constraints required
        LEFT JOIN pg_namespace namespace ON namespace.nspname = 'public'
        LEFT JOIN pg_class relation
          ON relation.relnamespace = namespace.oid
         AND relation.relname = required.table_name
        LEFT JOIN pg_constraint constraint_row
          ON constraint_row.conrelid = relation.oid
         AND constraint_row.conname = required.constraint_name
    ),
    required_triggers(table_name, trigger_name, function_name) AS (
        VALUES
          (
            'billing_payments',
            'validate_billing_payment_identity_change',
            'validate_billing_payment_identity_change'
          ),
          (
            'billing_refunds',
            'validate_billing_refund_payment_identity',
            'validate_billing_adjustment_payment_identity'
          ),
          (
            'billing_disputes',
            'validate_billing_dispute_payment_identity',
            'validate_billing_adjustment_payment_identity'
          ),
          (
            'billing_refunds',
            'recompute_payment_after_refund_change',
            'recompute_payment_after_adjustment_change'
          ),
          (
            'billing_disputes',
            'recompute_payment_after_dispute_change',
            'recompute_payment_after_adjustment_change'
          )
    ),
    trigger_state AS (
        SELECT
            required.*,
            trigger_row.oid,
            trigger_row.tgenabled,
            trigger_row.tgisinternal,
            function_namespace.nspname AS actual_function_schema,
            function_row.proname AS actual_function_name,
            COALESCE(pg_get_triggerdef(trigger_row.oid), '') AS definition
        FROM required_triggers required
        LEFT JOIN pg_namespace table_namespace
          ON table_namespace.nspname = 'public'
        LEFT JOIN pg_class relation
          ON relation.relnamespace = table_namespace.oid
         AND relation.relname = required.table_name
        LEFT JOIN pg_trigger trigger_row
          ON trigger_row.tgrelid = relation.oid
         AND trigger_row.tgname = required.trigger_name
        LEFT JOIN pg_proc function_row
          ON function_row.oid = trigger_row.tgfoid
        LEFT JOIN pg_namespace function_namespace
          ON function_namespace.oid = function_row.pronamespace
    ),
    required_indexes(index_name) AS (
        VALUES
          ('idx_billing_refunds_payment_id'),
          ('idx_billing_disputes_payment_id'),
          ('idx_billing_payments_stripe_charge'),
          ('idx_billing_refunds_stripe'),
          ('idx_billing_disputes_stripe')
    ),
    index_state AS (
        SELECT
            required.index_name,
            index_relation.oid,
            index_row.indisvalid,
            index_row.indisready,
            COALESCE(pg_get_indexdef(index_relation.oid), '') AS definition
        FROM required_indexes required
        LEFT JOIN pg_namespace namespace ON namespace.nspname = 'public'
        LEFT JOIN pg_class index_relation
          ON index_relation.relnamespace = namespace.oid
         AND index_relation.relname = required.index_name
        LEFT JOIN pg_index index_row
          ON index_row.indexrelid = index_relation.oid
    ),
    serialized AS (
        SELECT
            'f:' || signature || ':' || owner_name || ':' ||
            security_definer || ':' || configuration || ':' ||
            service_execute::TEXT || ':' || definition AS value,
            (
                oid IS NULL
                OR owner_name <> 'postgres'
                OR security_definer <> expected_security_definer::TEXT
                OR configuration <> expected_search_path
                OR service_execute IS DISTINCT FROM expected_service_execute
                OR public_execute
                OR anon_execute
                OR authenticated_execute
                OR unexpected_execute
            )::INTEGER AS invalid
        FROM function_state
        UNION ALL
        SELECT
            'c:' || table_name || '.' || column_name || ':' ||
            COALESCE(actual_data_type, '') || ':' ||
            COALESCE(actual_nullable::TEXT, '') || ':' ||
            COALESCE(actual_generated_kind, '') || ':' || expression,
            (
                NOT present
                OR actual_data_type IS DISTINCT FROM data_type
                OR actual_nullable IS DISTINCT FROM nullable
                OR actual_generated_kind IS DISTINCT FROM generated_kind
            )::INTEGER
        FROM column_state
        UNION ALL
        SELECT
            'k:' || table_name || ':' || constraint_name || ':' ||
            COALESCE(constraint_type, '') || ':' ||
            COALESCE(convalidated::TEXT, '') || ':' || definition,
            (
                oid IS NULL
                OR constraint_type IS DISTINCT FROM 'c'
                OR convalidated IS DISTINCT FROM true
            )::INTEGER
        FROM constraint_state
        UNION ALL
        SELECT
            't:' || table_name || ':' || trigger_name || ':' ||
            COALESCE(actual_function_schema, '') || '.' ||
            COALESCE(actual_function_name, '') || ':' ||
            COALESCE(tgenabled::TEXT, '') || ':' || definition,
            (
                oid IS NULL
                OR actual_function_schema IS DISTINCT FROM 'private'
                OR actual_function_name IS DISTINCT FROM function_name
                OR tgenabled IS DISTINCT FROM 'O'
                OR tgisinternal IS DISTINCT FROM false
            )::INTEGER
        FROM trigger_state
        UNION ALL
        SELECT
            'i:' || index_name || ':' ||
            COALESCE(indisvalid::TEXT, '') || ':' ||
            COALESCE(indisready::TEXT, '') || ':' || definition,
            (
                oid IS NULL
                OR indisvalid IS DISTINCT FROM true
                OR indisready IS DISTINCT FROM true
            )::INTEGER
        FROM index_state
    )
    SELECT
        COALESCE(sum(invalid), 0)::INTEGER,
        string_agg(value, '|' ORDER BY value COLLATE "C")
      INTO v_invalid, v_serialized
      FROM serialized;

    RETURN v_invalid::TEXT || ':' ||
        encode(
            extensions.digest(
                convert_to(COALESCE(v_serialized, ''), 'UTF8'),
                'sha256'
            ),
            'hex'
        );
END;
$manifest$;

ALTER FUNCTION private.koaryu_release_payment_adjustment_manifest_v26()
    OWNER TO postgres;
REVOKE ALL ON FUNCTION
    private.koaryu_release_payment_adjustment_manifest_v26()
    FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE private.koaryu_release_v26_expectations (
    expectation_key TEXT PRIMARY KEY,
    expected_sha256 TEXT NOT NULL,
    CONSTRAINT koaryu_release_v26_expectation_key_exact
        CHECK (expectation_key = 'operational_contract_v26'),
    CONSTRAINT koaryu_release_v26_expectation_digest_shape
        CHECK (expected_sha256 ~ '^[0-9a-f]{64}$')
);

ALTER TABLE private.koaryu_release_v26_expectations OWNER TO postgres;
ALTER TABLE private.koaryu_release_v26_expectations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE private.koaryu_release_v26_expectations
    FROM PUBLIC, anon, authenticated, service_role;

INSERT INTO private.koaryu_release_v26_expectations (
    expectation_key,
    expected_sha256
)
VALUES (
    'operational_contract_v26',
    '5ca124cf3faf50b7ac7cf231796a94dc703a4800a4ca2e7ff6222f5c2ff1e7a5'
);

CREATE OR REPLACE FUNCTION public.koaryu_release_schema_preflight_v7()
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
    v_expected_operational_sha256 TEXT;
BEGIN
    SELECT
        count(*)::INTEGER,
        max(version),
        array_agg(version ORDER BY version COLLATE "C")
            FILTER (WHERE version >= '20260727100000')
      INTO v_count, v_head, v_pending
      FROM supabase_migrations.schema_migrations;

    IF v_count <> 121 OR v_head <> '20260826030249' THEN
        v_failures := array_append(v_failures, 'migration_history_v26');
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
        '20260826030249'
    ]::TEXT[] THEN
        v_failures := array_append(
            v_failures,
            'migration_history_sequence_v26'
        );
    END IF;

    SELECT expectation.expected_sha256
      INTO v_expected_operational_sha256
      FROM private.koaryu_release_v26_expectations expectation
     WHERE expectation.expectation_key = 'operational_contract_v26';

    IF NOT FOUND
       OR (SELECT COUNT(*) FROM private.koaryu_release_v26_expectations) <> 1
       OR private.koaryu_release_operational_contract_v26()
            IS DISTINCT FROM '0:' || v_expected_operational_sha256 THEN
        v_failures := array_append(
            v_failures,
            'operational_semantic_acl_contract_v26'
        );
    END IF;

    IF private.koaryu_release_starting_belt_manifest_v9()
       <> '0:9c1c8ea5e7ab6ce0d34d5654d17b056faba89234f0f2b945ff147c0462711be9' THEN
        v_failures := array_append(
            v_failures,
            'starting_belt_invariant_manifest_v9'
        );
    END IF;

    IF private.koaryu_release_student_rank_writer_manifest_v13()
       <> '0:27cdc692d92fb49f696521e7ab6f3d0b7717c30a232ba6ce4ba057df9e5b30f7' THEN
        v_failures := array_append(
            v_failures,
            'student_rank_writer_manifest_v13'
        );
    END IF;

    IF private.koaryu_release_critical_surface_manifest_v18()
       <> '0:02e96ca8d2f4fe2117c2ab314fdab0ef079bac0a7c502c0cfcf2c3376529d620' THEN
        v_failures := array_append(
            v_failures,
            'critical_surface_manifest_v18'
        );
    END IF;

    IF private.koaryu_release_live_billing_v3_manifest_v25()
       <> '0:f810f40507fd5be476a90be7915be9f926ea15aafca7588cbca76233cda8adfb' THEN
        v_failures := array_append(
            v_failures,
            'live_billing_v3_manifest_v25'
        );
    END IF;

    IF private.koaryu_release_payment_adjustment_manifest_v26()
       <> '0:b63f010f0b0111f38b72fc43009f77722d824d96c3775a9dc3d34e6c58a63657' THEN
        v_failures := array_append(
            v_failures,
            'payment_adjustment_manifest_v26'
        );
    END IF;

    IF private.koaryu_release_schedule_window_manifest_v1()
       <> '0:f4c66d3098dcb3210ac6cc92e1831eebaf9f2ed74b210e84ec773cb1d8e854a7' THEN
        v_failures := array_append(
            v_failures,
            'schedule_window_manifest_v1'
        );
    END IF;

    RETURN QUERY
    SELECT
        cardinality(v_failures) = 0,
        v_count,
        v_head,
        COALESCE(v_pending, ARRAY[]::TEXT[]),
        v_failures,
        'release-db-attestation-v26';
END;
$preflight$;

ALTER FUNCTION public.koaryu_release_schema_preflight_v7()
    OWNER TO postgres;
REVOKE ALL ON FUNCTION public.koaryu_release_schema_preflight_v7()
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.koaryu_release_schema_preflight_v7()
    TO service_role;

-- Preserve the already-built V25 backend during the database-first V26
-- cutover. The integrated backend calls V7 and never accepts this bridge.
CREATE OR REPLACE FUNCTION public.koaryu_release_schema_preflight_v6()
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
    SELECT *
      INTO v_current
      FROM public.koaryu_release_schema_preflight_v7();

    IF v_current.ready IS TRUE
       AND v_current.migration_count = 121
       AND v_current.migration_head = '20260826030249'
       AND v_current.manifest_version = 'release-db-attestation-v26'
       AND private.koaryu_release_schedule_window_manifest_v1() =
            '0:f4c66d3098dcb3210ac6cc92e1831eebaf9f2ed74b210e84ec773cb1d8e854a7'
       AND cardinality(v_current.security_failures) = 0 THEN
        RETURN QUERY
        SELECT
            true,
            120,
            '20260826030234'::TEXT,
            ARRAY[
                '20260727100000','20260727110000','20260801050957',
                '20260801060000','20260801070000','20260801080000',
                '20260801090000','20260801091000','20260801092000',
                '20260801093000','20260801094000','20260801105313',
                '20260801112153','20260801115044','20260801123112',
                '20260801131844','20260814043325','20260814103046',
                '20260814105424','20260814114500','20260814152000',
                '20260814170000','20260814183000','20260814200000',
                '20260814213000','20260815220402','20260816012723',
                '20260820012533','20260820025759','20260820060216',
                '20260822193000','20260823193155','20260824190500',
                '20260825042838','20260825043911','20260826030234'
            ]::TEXT[],
            ARRAY[]::TEXT[],
            'release-db-attestation-v25'::TEXT;
        RETURN;
    END IF;

    RETURN QUERY
    SELECT
        false,
        v_current.migration_count,
        v_current.migration_head,
        v_current.pending_versions,
        COALESCE(
            v_current.security_failures,
            ARRAY['payments_v26_v25_compatibility_preflight']::TEXT[]
        ),
        'release-db-attestation-v25'::TEXT;
END;
$compatibility$;

ALTER FUNCTION public.koaryu_release_schema_preflight_v6()
    OWNER TO postgres;
REVOKE ALL ON FUNCTION public.koaryu_release_schema_preflight_v6()
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.koaryu_release_schema_preflight_v6()
    TO service_role;

CREATE FUNCTION private.koaryu_release_operational_contract_v26()
RETURNS TEXT
LANGUAGE sql
STABLE
SET search_path = pg_catalog
SET TimeZone = 'UTC'
AS $v7$

with required_tables(schema_name, table_name, rls_enabled, service_privileges) as (
  values
    ('public', 'studio_live_billing_authorizations', true, 'SELECT'),
    ('public', 'stripe_live_billing_reconciliation_checkpoints', true, 'SELECT'),
    ('public', 'stripe_connect_account_dispositions', true, 'SELECT'),
    ('public', 'stripe_live_billing_reconciliation_account_evidence', true, 'SELECT'),
    ('public', 'stripe_connect_onboarding_bootstraps', true, ''),
    ('public', 'operational_alert_episodes', true, 'INSERT,SELECT,UPDATE'),
    ('public', 'operational_alert_outbox', true, 'INSERT,SELECT,UPDATE'),
    ('public', 'operational_alert_delivery_attempts', true, 'INSERT,SELECT'),
    ('public', 'operational_alert_delivery_outcomes', true, 'INSERT,SELECT'),
    ('public', 'operational_alert_audit_events', true, 'INSERT,SELECT'),
    ('public', 'operational_alert_heartbeats', true, 'INSERT,SELECT,UPDATE'),
    ('private', 'stripe_connect_account_identity_guards', false, ''),
    ('private', 'koaryu_release_v26_expectations', true, '')
),
acl_scope_tables(schema_name, table_name) as (
  select schema_name, table_name from required_tables
  union all
  values
    ('public', 'studio_payment_accounts'),
    ('public', 'stripe_events')
),
scoped_definition_tables(schema_name, table_name) as (
  select schema_name, table_name from required_tables
  union all
  select 'public', 'studio_payment_accounts'
),
table_actual as (
  select
    namespace.nspname as schema_name,
    relation.relname as table_name,
    owner.rolname as owner_name,
    relation.relrowsecurity,
    coalesce((
      select string_agg(
               coalesce(grantor.rolname, 'PUBLIC') || '>' ||
               coalesce(grantee.rolname, 'PUBLIC') || ':' || acl.privilege_type || ':' || acl.is_grantable::text,
               ',' order by coalesce(grantor.rolname, 'PUBLIC') collate "C", coalesce(grantee.rolname, 'PUBLIC') collate "C", acl.privilege_type collate "C", acl.is_grantable
             )
        from aclexplode(coalesce(relation.relacl, acldefault('r', relation.relowner))) acl
        left join pg_roles grantor on grantor.oid = acl.grantor
        left join pg_roles grantee on grantee.oid = acl.grantee
    ), '') as acl_state,
    exists (
      select 1
        from aclexplode(coalesce(relation.relacl, acldefault('r', relation.relowner))) acl
       where acl.grantee = 0
    ) as public_access,
    has_table_privilege('anon', relation.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') as anon_access,
    has_table_privilege('authenticated', relation.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') as authenticated_access,
    concat_ws(',',
      case when has_table_privilege('service_role', relation.oid, 'INSERT') then 'INSERT' end,
      case when has_table_privilege('service_role', relation.oid, 'SELECT') then 'SELECT' end,
      case when has_table_privilege('service_role', relation.oid, 'UPDATE') then 'UPDATE' end,
      case when has_table_privilege('service_role', relation.oid, 'DELETE') then 'DELETE' end,
      case when has_table_privilege('service_role', relation.oid, 'TRUNCATE') then 'TRUNCATE' end,
      case when has_table_privilege('service_role', relation.oid, 'REFERENCES') then 'REFERENCES' end,
      case when has_table_privilege('service_role', relation.oid, 'TRIGGER') then 'TRIGGER' end
    ) as service_privileges
  from pg_class relation
  join pg_namespace namespace on namespace.oid = relation.relnamespace
  join pg_roles owner on owner.oid = relation.relowner
  join required_tables required
    on required.schema_name = namespace.nspname and required.table_name = relation.relname
  where relation.relkind = 'r'
),
table_compared as (
  select required.*, actual.owner_name, actual.relrowsecurity,
         actual.public_access, actual.anon_access, actual.authenticated_access,
         actual.service_privileges as actual_service_privileges,
         actual.acl_state
    from required_tables required
    left join table_actual actual using (schema_name, table_name)
),
table_acl_definitions as (
  select namespace.nspname as schema_name, relation.relname as table_name,
         owner.rolname as owner_name,
         coalesce((
           select string_agg(
                    coalesce(grantor.rolname, 'PUBLIC') || '>' ||
                    coalesce(grantee.rolname, 'PUBLIC') || ':' || acl.privilege_type || ':' || acl.is_grantable::text,
                    ',' order by coalesce(grantor.rolname, 'PUBLIC') collate "C", coalesce(grantee.rolname, 'PUBLIC') collate "C", acl.privilege_type collate "C", acl.is_grantable
                  )
             from aclexplode(coalesce(relation.relacl, acldefault('r', relation.relowner))) acl
             left join pg_roles grantor on grantor.oid = acl.grantor
             left join pg_roles grantee on grantee.oid = acl.grantee
         ), '') as acl_state
    from pg_class relation
    join pg_namespace namespace on namespace.oid = relation.relnamespace
    join pg_roles owner on owner.oid = relation.relowner
    join acl_scope_tables covered
      on covered.schema_name = namespace.nspname and covered.table_name = relation.relname
   where relation.relkind = 'r'
),
column_acl_definitions as (
  select namespace.nspname as schema_name,
         relation.relname as table_name,
         attribute.attnum,
         attribute.attname as column_name,
         coalesce((
           select string_agg(
                    coalesce(grantor.rolname, 'PUBLIC') || '>' ||
                    coalesce(grantee.rolname, 'PUBLIC') || ':' ||
                    acl.privilege_type || ':' || acl.is_grantable::text,
                    ',' order by coalesce(grantor.rolname, 'PUBLIC') collate "C",
                                 coalesce(grantee.rolname, 'PUBLIC') collate "C",
                                 acl.privilege_type collate "C", acl.is_grantable
                  )
             from aclexplode(attribute.attacl) acl
             left join pg_roles grantor on grantor.oid = acl.grantor
             left join pg_roles grantee on grantee.oid = acl.grantee
         ), '') as acl_state
    from pg_class relation
    join pg_namespace namespace on namespace.oid = relation.relnamespace
    join acl_scope_tables covered
      on covered.schema_name = namespace.nspname and covered.table_name = relation.relname
    join pg_attribute attribute
      on attribute.attrelid = relation.oid
     and attribute.attnum > 0
     and not attribute.attisdropped
   where relation.relkind = 'r'
),
required_policies(table_name, policy_name, permissive, command_name, role_names, predicate_kind) as (
  values
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
policy_actual as (
  select relation.relname as table_name, policy.polname as policy_name,
         policy.polpermissive as permissive, policy.polcmd::text as command_name,
         (select string_agg(role.rolname, ',' order by role.rolname collate "C")
            from unnest(policy.polroles) role_oid
            join pg_roles role on role.oid = role_oid) as role_names,
         case
           when regexp_replace(pg_get_expr(policy.polqual, policy.polrelid), '[[:space:]()]', '', 'g') = 'false'
            and regexp_replace(pg_get_expr(policy.polwithcheck, policy.polrelid), '[[:space:]()]', '', 'g') = 'false'
             then 'deny_all'
           when regexp_replace(
                  regexp_replace(pg_get_expr(policy.polqual, policy.polrelid), '[[:space:]()]', '', 'g'),
                  'AShas_unambiguous_studio_membership$', ''
                ) = 'SELECTprivate.has_unambiguous_studio_membership'
            and regexp_replace(
                  regexp_replace(pg_get_expr(policy.polwithcheck, policy.polrelid), '[[:space:]()]', '', 'g'),
                  'AShas_unambiguous_studio_membership$', ''
                ) = 'SELECTprivate.has_unambiguous_studio_membership'
             then 'membership_guard'
           else 'unexpected'
         end as predicate_kind
    from pg_policy policy
    join pg_class relation on relation.oid = policy.polrelid
    join pg_namespace namespace on namespace.oid = relation.relnamespace
    join required_tables covered
      on covered.schema_name = 'public' and covered.table_name = relation.relname
   where namespace.nspname = 'public'
),
policy_compared as (
  select coalesce(required.table_name, actual.table_name) as table_name,
         coalesce(required.policy_name, actual.policy_name) as policy_name,
         required.permissive, required.command_name, required.role_names,
         required.predicate_kind,
         actual.permissive as actual_permissive,
         actual.command_name as actual_command_name,
         actual.role_names as actual_role_names,
         actual.predicate_kind as actual_predicate_kind,
         required.table_name is not null as expected_policy,
         actual.table_name is not null as actual_policy
    from required_policies required
    full join policy_actual actual using (table_name, policy_name)
),
required_functions(signature, search_path_config, security_definer, service_execute) as (
  values
    ('public.preserve_studio_comp_provenance()', 'search_path=pg_catalog', false, false),
    ('public.set_studio_comp_atomic(uuid, boolean, text, uuid, text, boolean)', 'search_path=public, pg_temp', false, true),
    ('public.clear_studio_comp_for_billing_event(uuid, bigint)', 'search_path=public, pg_temp', false, true),
    ('public.record_stripe_live_billing_reconciliation_checkpoint(text, integer, integer, integer, integer, integer, integer, timestamp with time zone, timestamp with time zone, integer, integer, boolean, boolean, timestamp with time zone, text, text, uuid, text)', 'search_path=public, pg_temp', true, false),
    ('public.record_stripe_live_billing_reconciliation_checkpoint_v2(jsonb, timestamp with time zone, text, text, uuid, text)', 'search_path=""', true, false),
    ('public.authorize_studio_live_billing_mutation_atomic(uuid, text, text, text, text)', 'search_path=""', true, true),
    ('public.authorize_connect_onboarding_bootstrap_account_create(uuid, text, integer, text, text, text, text, text)', 'search_path=""', true, false),
    ('public.bind_connect_onboarding_bootstrap_account(uuid, text, integer, text, text, text)', 'search_path=""', true, false),
    ('public.authorize_connect_onboarding_bootstrap_initial_link(uuid, text, integer, text, text, text, text, text)', 'search_path=""', true, false),
    ('private.connect_onboarding_bootstrap_link_checkpoint(uuid, text)', 'search_path=""', true, false),
    ('public.preflight_connect_onboarding_bootstrap_begin(uuid, text)', 'search_path=""', true, true),
    ('public.preflight_connect_onboarding_bootstrap_resume(uuid, text)', 'search_path=""', true, true),
    ('public.prepare_connect_onboarding_bootstrap_atomic(uuid, text, integer, jsonb, text, text, text, text)', 'search_path=""', true, true),
    ('public.load_connect_onboarding_bootstrap_recovery_context(uuid, text)', 'search_path=""', true, true),
    ('public.authorize_connect_onboarding_bootstrap_account_create_v2(uuid, uuid, text, integer, text, text)', 'search_path=""', true, true),
    ('public.bind_connect_onboarding_bootstrap_account_v2(uuid, uuid, text, integer, text, text)', 'search_path=""', true, true),
    ('public.authorize_connect_onboarding_bootstrap_initial_link_v2(uuid, uuid, text, integer, text, text, text, text)', 'search_path=""', true, true),
    ('public.record_connect_onboarding_bootstrap_initial_link_response(uuid, uuid, text, integer, text, text, text, text, text, text)', 'search_path=""', true, true),
    ('public.acknowledge_connect_onboarding_bootstrap_initial_link_delivery(uuid, text, text)', 'search_path=""', true, true),
    ('private.live_billing_event_is_in_scope(text, text)', 'search_path=""', true, false),
    ('private.enforce_live_billing_checkpoint_processed_events()', 'search_path=""', true, false),
    ('private.current_connect_account_generation(jsonb)', 'search_path=""', false, true),
    ('private.bind_live_billing_authorization_checkpoint()', 'search_path=""', true, false),
    ('public.set_studio_live_billing_authorization_atomic(uuid, text, boolean, timestamp with time zone, text, uuid, text, text)', 'search_path=public, pg_temp', true, true),
    ('public.set_stripe_connect_account_exclusion_atomic(text, boolean, text, uuid, text)', 'search_path=public, pg_temp', true, true),
    ('public.finish_stripe_event_processing_v2(uuid, text, text, text, text)', 'search_path=public, pg_temp', false, true),
    ('public.prevent_operational_alert_append_only_mutation()', 'search_path=""', false, false),
    ('public.enforce_operational_alert_sent_receipt()', 'search_path=""', false, false),
    ('public.operational_alert_metric_counts()', 'search_path=public, pg_temp', false, true),
    ('public.evaluate_operational_alert(text, text, bigint, integer, integer, text, text, text, text)', 'search_path=public, pg_temp', false, false),
    ('public.evaluate_operational_alert(text, text, bigint, integer, integer, text, text, integer, text, text, text)', 'search_path=public, pg_temp', false, true),
    ('public.acknowledge_operational_alert(text, uuid, text, text)', 'search_path=public, pg_temp', false, true),
    ('public.claim_operational_alert_delivery(text, text, uuid, integer)', 'search_path=public, pg_temp', false, true),
    ('public.complete_operational_alert_delivery(uuid, text, text)', 'search_path=public, pg_temp', false, true),
    ('public.fail_operational_alert_delivery(uuid, text, text, integer)', 'search_path=public, pg_temp', false, true),
    ('public.record_operational_alert_heartbeat(text, text, text)', 'search_path=public, pg_temp', false, true),
    ('public.operational_alert_heartbeats(text)', 'search_path=public, pg_temp', false, true),
    ('public.koaryu_release_schema_preflight()', 'search_path=pg_catalog', true, true),
    ('public.koaryu_release_schema_preflight_v5()', 'search_path=pg_catalog', true, true),
    ('public.koaryu_release_schema_preflight_v6()', 'search_path=pg_catalog', true, true),
    ('public.koaryu_release_schema_preflight_v7()', 'search_path=pg_catalog', true, true),
    ('private.koaryu_release_operational_manifest_v2()', 'search_path=pg_catalog', false, false),
    ('private.koaryu_release_operational_manifest_v2_base()', 'search_path=pg_catalog', false, false),
    ('private.koaryu_release_operational_manifest_v4()', 'search_path=pg_catalog', false, false),
    ('private.koaryu_release_operational_manifest_v5()', 'search_path=pg_catalog', false, false),
    ('private.koaryu_release_operational_manifest_v6()', 'search_path=pg_catalog', false, false),
    ('private.sync_connect_identity_mapping_guard()', 'search_path=pg_catalog', true, false),
    ('private.sync_connect_identity_exclusion_guard()', 'search_path=pg_catalog', true, false),
    ('public.record_stripe_live_billing_reconciliation_checkpoint_v3(jsonb, timestamp with time zone, text, text, uuid, text)', 'search_path=""', true, true),
    ('private.koaryu_release_operational_contract_v25()', 'search_path=pg_catalog,TimeZone=UTC', false, false),
    ('private.koaryu_release_live_billing_v3_manifest_v25()', 'search_path=pg_catalog', false, false),
    ('private.recompute_billing_payment_adjustment_totals(uuid)', 'search_path=""', false, true),
    ('private.validate_billing_payment_identity_change()', 'search_path=""', false, false),
    ('private.validate_billing_adjustment_payment_identity()', 'search_path=""', false, false),
    ('private.recompute_payment_after_adjustment_change()', 'search_path=""', false, false),
    ('private.koaryu_release_payment_adjustment_manifest_v26()', 'search_path=pg_catalog', false, false),
    ('private.koaryu_release_operational_contract_v26()', 'search_path=pg_catalog,TimeZone=UTC', false, false)
),
function_actual as (
  select format('%I.%I(%s)', namespace.nspname, function.proname, oidvectortypes(function.proargtypes)) as signature,
         owner.rolname as owner_name, language.lanname as language_name,
         function.prosecdef as security_definer,
         coalesce(array_to_string(function.proconfig, ','), '') as search_path_config,
         exists (select 1 from aclexplode(coalesce(function.proacl, acldefault('f', function.proowner))) acl where acl.grantee = 0 and acl.privilege_type = 'EXECUTE') as public_execute,
         has_function_privilege('anon', function.oid, 'EXECUTE') as anon_execute,
         has_function_privilege('authenticated', function.oid, 'EXECUTE') as authenticated_execute,
         has_function_privilege('service_role', function.oid, 'EXECUTE') as service_execute,
         encode(extensions.digest(convert_to(function.prosrc, 'UTF8'), 'sha256'), 'hex') as body_sha256,
         coalesce((
           select string_agg(
                    coalesce(grantor.rolname, 'PUBLIC') || '>' ||
                    coalesce(grantee.rolname, 'PUBLIC') || ':' || acl.privilege_type || ':' || acl.is_grantable::text,
                    ',' order by coalesce(grantor.rolname, 'PUBLIC') collate "C", coalesce(grantee.rolname, 'PUBLIC') collate "C", acl.privilege_type collate "C", acl.is_grantable
                  )
             from aclexplode(coalesce(function.proacl, acldefault('f', function.proowner))) acl
             left join pg_roles grantor on grantor.oid = acl.grantor
             left join pg_roles grantee on grantee.oid = acl.grantee
         ), '') as acl_state,
         exists (
           select 1
             from aclexplode(coalesce(function.proacl, acldefault('f', function.proowner))) acl
             left join pg_roles grantee on grantee.oid = acl.grantee
            where acl.privilege_type = 'EXECUTE'
              and acl.grantee <> function.proowner
              and not (
                grantee.rolname = 'service_role'
                and required.service_execute
                and not acl.is_grantable
              )
         ) as unexpected_execute_grant
    from pg_proc function
    join pg_namespace namespace on namespace.oid = function.pronamespace
    join pg_roles owner on owner.oid = function.proowner
    join pg_language language on language.oid = function.prolang
    join required_functions required
      on required.signature = format('%I.%I(%s)', namespace.nspname, function.proname, oidvectortypes(function.proargtypes))
),
function_compared as (
  select required.*, actual.owner_name, actual.language_name,
         actual.security_definer as actual_security_definer,
         actual.search_path_config as actual_search_path_config,
         actual.public_execute, actual.anon_execute, actual.authenticated_execute,
         actual.service_execute as actual_service_execute,
         actual.body_sha256, actual.acl_state, actual.unexpected_execute_grant
    from required_functions required
    left join function_actual actual using (signature)
),
required_triggers(table_name, trigger_name, function_schema, function_name, trigger_type) as (
  values
    ('studio_subscriptions', 'preserve_studio_comp_provenance_on_metadata_update', 'public', 'preserve_studio_comp_provenance', 19),
    ('studio_live_billing_authorizations', 'set_studio_live_billing_authorizations_updated_at', 'public', 'update_updated_at_column', 19),
    ('stripe_connect_account_dispositions', 'set_stripe_connect_account_dispositions_updated_at', 'public', 'update_updated_at_column', 19),
    ('studio_live_billing_authorizations', 'bind_live_billing_authorization_checkpoint', 'private', 'bind_live_billing_authorization_checkpoint', 23),
    ('stripe_connect_onboarding_bootstraps', 'set_stripe_connect_onboarding_bootstraps_updated_at', 'public', 'update_updated_at_column', 19),
    ('stripe_live_billing_reconciliation_checkpoints', 'enforce_live_billing_checkpoint_processed_events', 'private', 'enforce_live_billing_checkpoint_processed_events', 7),
    ('operational_alert_delivery_attempts', 'prevent_operational_alert_attempt_mutation', 'public', 'prevent_operational_alert_append_only_mutation', 27),
    ('operational_alert_delivery_outcomes', 'prevent_operational_alert_outcome_mutation', 'public', 'prevent_operational_alert_append_only_mutation', 27),
    ('operational_alert_audit_events', 'prevent_operational_alert_audit_mutation', 'public', 'prevent_operational_alert_append_only_mutation', 27),
    ('operational_alert_outbox', 'enforce_operational_alert_sent_receipt', 'public', 'enforce_operational_alert_sent_receipt', 23),
    ('studio_payment_accounts', 'sync_connect_identity_mapping_guard', 'private', 'sync_connect_identity_mapping_guard', 29),
    ('stripe_connect_account_dispositions', 'sync_connect_identity_exclusion_guard', 'private', 'sync_connect_identity_exclusion_guard', 29),
    ('billing_payments', 'validate_billing_payment_identity_change', 'private', 'validate_billing_payment_identity_change', 19),
    ('billing_refunds', 'validate_billing_refund_payment_identity', 'private', 'validate_billing_adjustment_payment_identity', 23),
    ('billing_disputes', 'validate_billing_dispute_payment_identity', 'private', 'validate_billing_adjustment_payment_identity', 23),
    ('billing_refunds', 'recompute_payment_after_refund_change', 'private', 'recompute_payment_after_adjustment_change', 29),
    ('billing_disputes', 'recompute_payment_after_dispute_change', 'private', 'recompute_payment_after_adjustment_change', 29)
),
trigger_actual as (
  select relation.relname as table_name, trigger.tgname as trigger_name,
         function_namespace.nspname as function_schema, function.proname as function_name,
         trigger.tgtype::integer as trigger_type, trigger.tgenabled, trigger.tgisinternal,
         encode(extensions.digest(convert_to(pg_get_triggerdef(trigger.oid), 'UTF8'), 'sha256'), 'hex') as definition_sha256
    from pg_trigger trigger
    join pg_class relation on relation.oid = trigger.tgrelid
    join pg_namespace namespace on namespace.oid = relation.relnamespace
    join pg_proc function on function.oid = trigger.tgfoid
    join pg_namespace function_namespace on function_namespace.oid = function.pronamespace
    join required_triggers required
      on required.table_name = relation.relname and required.trigger_name = trigger.tgname
   where namespace.nspname = 'public'
),
trigger_compared as (
  select required.*, actual.function_schema as actual_function_schema,
         actual.function_name as actual_function_name,
         actual.trigger_type as actual_trigger_type,
         actual.tgenabled, actual.tgisinternal, actual.definition_sha256
    from required_triggers required
    left join trigger_actual actual using (table_name, trigger_name)
),
required_indexes(index_name, table_name, unique_index, partial_index) as (
  values
    ('idx_studio_live_billing_authorizations_enabled', 'studio_live_billing_authorizations', false, true),
    ('idx_stripe_live_billing_reconciliation_checkpoints_latest', 'stripe_live_billing_reconciliation_checkpoints', false, false),
    ('idx_stripe_events_error_reference', 'stripe_events', true, true),
    ('idx_stripe_events_live_billing_ingest_sequence', 'stripe_events', true, false),
    ('idx_stripe_connect_onboarding_bootstraps_generation_once', 'stripe_connect_onboarding_bootstraps', true, false),
    ('idx_stripe_connect_onboarding_bootstraps_delivery_receipt', 'stripe_connect_onboarding_bootstraps', true, true),
    ('operational_alert_episodes_one_unresolved', 'operational_alert_episodes', true, true),
    ('operational_alert_episodes_recent', 'operational_alert_episodes', false, false),
    ('operational_alert_outbox_claim', 'operational_alert_outbox', false, true),
    ('operational_alert_delivery_attempts_delivery', 'operational_alert_delivery_attempts', false, false),
    ('operational_alert_audit_events_episode', 'operational_alert_audit_events', false, false)
),
index_actual as (
  select index_relation.relname as index_name, table_relation.relname as table_name,
         index.indisunique as unique_index, index.indpred is not null as partial_index,
         index.indisvalid, index.indisready,
         encode(extensions.digest(convert_to(pg_get_indexdef(index.indexrelid), 'UTF8'), 'sha256'), 'hex') as definition_sha256
    from pg_index index
    join pg_class index_relation on index_relation.oid = index.indexrelid
    join pg_class table_relation on table_relation.oid = index.indrelid
    join pg_namespace namespace on namespace.oid = table_relation.relnamespace
    join required_indexes required on required.index_name = index_relation.relname
   where namespace.nspname = 'public'
),
index_compared as (
  select required.*, actual.table_name as actual_table_name,
         actual.unique_index as actual_unique_index,
         actual.partial_index as actual_partial_index,
         actual.indisvalid, actual.indisready, actual.definition_sha256
    from required_indexes required
    left join index_actual actual using (index_name)
),
required_sequences(table_name, column_name, service_usage, service_select, service_update) as (
  values
    ('stripe_live_billing_reconciliation_checkpoints', 'checkpoint_sequence', true, true, false),
    ('stripe_events', 'live_billing_ingest_sequence', true, true, false),
    ('operational_alert_audit_events', 'id', true, true, false)
),
sequence_actual as (
  select table_relation.relname as table_name, attribute.attname as column_name,
         owner.rolname as owner_name,
         coalesce((
           select string_agg(
                    coalesce(grantor.rolname, 'PUBLIC') || '>' ||
                    coalesce(grantee.rolname, 'PUBLIC') || ':' || acl.privilege_type || ':' || acl.is_grantable::text,
                    ',' order by coalesce(grantor.rolname, 'PUBLIC') collate "C", coalesce(grantee.rolname, 'PUBLIC') collate "C", acl.privilege_type collate "C", acl.is_grantable
                  )
             from aclexplode(coalesce(sequence.relacl, acldefault('S', sequence.relowner))) acl
             left join pg_roles grantor on grantor.oid = acl.grantor
             left join pg_roles grantee on grantee.oid = acl.grantee
         ), '') as acl_state,
         exists (select 1 from aclexplode(coalesce(sequence.relacl, acldefault('S', sequence.relowner))) acl where acl.grantee = 0) as public_access,
         has_sequence_privilege('anon', sequence.oid, 'USAGE,SELECT,UPDATE') as anon_access,
         has_sequence_privilege('authenticated', sequence.oid, 'USAGE,SELECT,UPDATE') as authenticated_access,
         has_sequence_privilege('service_role', sequence.oid, 'USAGE') as service_usage,
         has_sequence_privilege('service_role', sequence.oid, 'SELECT') as service_select,
         has_sequence_privilege('service_role', sequence.oid, 'UPDATE') as service_update
    from pg_class sequence
    join pg_depend dependency on dependency.objid = sequence.oid and dependency.deptype in ('a', 'i')
    join pg_class table_relation on table_relation.oid = dependency.refobjid
    join pg_attribute attribute on attribute.attrelid = table_relation.oid and attribute.attnum = dependency.refobjsubid
    join pg_namespace namespace on namespace.oid = table_relation.relnamespace
    join pg_roles owner on owner.oid = sequence.relowner
    join required_sequences required on required.table_name = table_relation.relname and required.column_name = attribute.attname
   where namespace.nspname = 'public' and sequence.relkind = 'S'
),
sequence_compared as (
  select required.*, actual.owner_name, actual.public_access,
         actual.anon_access, actual.authenticated_access,
         actual.service_usage as actual_service_usage,
         actual.service_select as actual_service_select,
         actual.service_update as actual_service_update,
         actual.acl_state
    from required_sequences required
    left join sequence_actual actual using (table_name, column_name)
),
required_columns(table_name, column_name, data_type, nullable, identity_column) as (
  values
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
    ('stripe_connect_onboarding_bootstraps', 'recovery_context', 'jsonb', true, false),
    ('stripe_connect_onboarding_bootstraps', 'recovery_expires_at', 'timestamp with time zone', true, false),
    ('stripe_connect_onboarding_bootstraps', 'initial_link_response_sha256', 'text', true, false),
    ('stripe_connect_onboarding_bootstraps', 'initial_link_response_recorded_at', 'timestamp with time zone', true, false),
    ('stripe_connect_onboarding_bootstraps', 'initial_link_delivery_receipt_sha256', 'text', true, false),
    ('stripe_connect_onboarding_bootstraps', 'initial_link_delivery_receipt_expires_at', 'timestamp with time zone', true, false),
    ('stripe_connect_onboarding_bootstraps', 'initial_link_delivered_at', 'timestamp with time zone', true, false),
    ('stripe_connect_onboarding_bootstraps', 'initial_link_support_required_at', 'timestamp with time zone', true, false),
    ('operational_alert_episodes', 'backup_destination_id', 'text', false, false),
    ('operational_alert_episodes', 'escalation_after_minutes', 'integer', false, false),
    ('operational_alert_episodes', 'acknowledged_at', 'timestamp with time zone', true, false),
    ('operational_alert_episodes', 'acknowledged_by_role', 'text', true, false),
    ('operational_alert_episodes', 'acknowledged_actor_ref', 'text', true, false),
    ('operational_alert_outbox', 'event_kind', 'text', false, false),
    ('operational_alert_outbox', 'destination_role', 'text', false, false)
),
column_compared as (
  select required.*,
         actual.data_type as actual_data_type,
         actual.is_nullable = 'YES' as actual_nullable,
         actual.is_identity = 'YES' as actual_identity_column
    from required_columns required
    left join information_schema.columns actual
      on actual.table_schema = 'public'
     and actual.table_name = required.table_name
     and actual.column_name = required.column_name
),
required_constraints(table_name, constraint_identity, constraint_type) as (
  values
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
    ('operational_alert_audit_events', 'operational_alert_audit_events_event_type_check', 'c'),
    ('stripe_connect_onboarding_bootstraps', 'stripe_connect_onboarding_bootstraps_recovery_pair', 'c'),
    ('stripe_connect_onboarding_bootstraps', 'stripe_connect_onboarding_bootstraps_recovery_context_object', 'c'),
    ('stripe_connect_onboarding_bootstraps', 'stripe_connect_onboarding_bootstraps_recovery_expiry', 'c'),
    ('stripe_connect_onboarding_bootstraps', 'stripe_connect_onboarding_bootstraps_response_hash', 'c'),
    ('stripe_connect_onboarding_bootstraps', 'stripe_connect_onboarding_bootstraps_receipt_hash', 'c'),
    ('stripe_connect_onboarding_bootstraps', 'stripe_connect_onboarding_bootstraps_response_pair', 'c'),
    ('stripe_connect_onboarding_bootstraps', 'stripe_connect_onboarding_bootstraps_receipt_pair', 'c'),
    ('stripe_connect_onboarding_bootstraps', 'stripe_connect_onboarding_bootstraps_delivery_order', 'c'),
    ('stripe_connect_onboarding_bootstraps', 'stripe_connect_onboarding_bootstraps_receipt_expiry', 'c'),
    ('stripe_connect_onboarding_bootstraps', 'stripe_connect_onboarding_bootstraps_delivered_state', 'c'),
    ('stripe_connect_onboarding_bootstraps', 'stripe_connect_onboarding_bootstraps_terminal_state', 'c')
),
constraint_actual as (
  select relation.relname as table_name,
         case
           when relation.relname = 'stripe_live_billing_reconciliation_account_evidence'
            and constraint_state.contype = 'p'
             then 'primary:' || columns.column_names
           when relation.relname = 'stripe_live_billing_reconciliation_account_evidence'
            and constraint_state.contype = 'u'
             then 'unique:' || columns.column_names
           else constraint_state.conname
         end as constraint_identity,
         constraint_state.contype::text as constraint_type,
         constraint_state.convalidated,
         encode(extensions.digest(convert_to(pg_get_constraintdef(constraint_state.oid), 'UTF8'), 'sha256'), 'hex') as definition_sha256
    from pg_constraint constraint_state
    join pg_class relation on relation.oid = constraint_state.conrelid
    join pg_namespace namespace on namespace.oid = relation.relnamespace
    left join lateral (
      select string_agg(attribute.attname, ',' order by key_position.ordinality) as column_names
        from unnest(constraint_state.conkey) with ordinality key_position(attnum, ordinality)
        join pg_attribute attribute
          on attribute.attrelid = constraint_state.conrelid
         and attribute.attnum = key_position.attnum
    ) columns on true
   where namespace.nspname = 'public'
),
constraint_compared as (
  select required.*,
         actual.constraint_type as actual_constraint_type,
         actual.convalidated, actual.definition_sha256
    from required_constraints required
    left join constraint_actual actual using (table_name, constraint_identity)
),
scoped_index_definitions as (
  select namespace.nspname as schema_name, table_relation.relname as table_name,
         index_relation.relname as index_name,
         encode(extensions.digest(convert_to(pg_get_indexdef(index_state.indexrelid), 'UTF8'), 'sha256'), 'hex') as definition_sha256
    from pg_index index_state
    join pg_class index_relation on index_relation.oid = index_state.indexrelid
    join pg_class table_relation on table_relation.oid = index_state.indrelid
    join pg_namespace namespace on namespace.oid = table_relation.relnamespace
    join scoped_definition_tables covered
      on covered.schema_name = namespace.nspname and covered.table_name = table_relation.relname
),
scoped_constraint_definitions as (
  select namespace.nspname as schema_name, relation.relname as table_name,
         constraint_state.conname as constraint_name,
         constraint_state.contype::text as constraint_type,
         constraint_state.convalidated,
         encode(extensions.digest(convert_to(pg_get_constraintdef(constraint_state.oid), 'UTF8'), 'sha256'), 'hex') as definition_sha256
    from pg_constraint constraint_state
    join pg_class relation on relation.oid = constraint_state.conrelid
    join pg_namespace namespace on namespace.oid = relation.relnamespace
    join scoped_definition_tables covered
      on covered.schema_name = namespace.nspname and covered.table_name = relation.relname
),
states as (
  select 'bootstrap_checks' as category, count(*)::integer as object_count,
         encode(
           extensions.digest(
             convert_to(count(*)::text, 'UTF8'),
             'sha256'
           ),
           'hex'
         ) as state_digest,
         (
           count(*) <> 23
           OR count(*) FILTER (WHERE NOT constraint_row.convalidated) <> 0
         )::integer as failures
    from pg_constraint constraint_row
   where constraint_row.conrelid =
         'public.stripe_connect_onboarding_bootstraps'::regclass
     and constraint_row.contype = 'c'
  union all
  select 'tables' as category, count(*)::integer as object_count,
         encode(extensions.digest(convert_to(coalesce(string_agg(schema_name || '.' || table_name || ':' || coalesce(owner_name, '') || ':' || coalesce(relrowsecurity::text, '') || ':' || coalesce(actual_service_privileges, '') || ':' || coalesce(acl_state, ''), '|' order by schema_name collate "C", table_name collate "C"), ''), 'UTF8'), 'sha256'), 'hex') as state_digest,
         count(*) filter (where owner_name is null or owner_name <> 'postgres' or relrowsecurity is distinct from rls_enabled or public_access or anon_access or authenticated_access or actual_service_privileges is distinct from service_privileges)::integer as failures
    from table_compared
  union all
  select 'table_acls', count(*)::integer,
         encode(extensions.digest(convert_to(coalesce(string_agg(schema_name || '.' || table_name || ':' || owner_name || ':' || acl_state, '|' order by schema_name collate "C", table_name collate "C"), ''), 'UTF8'), 'sha256'), 'hex'),
         0::integer
    from table_acl_definitions
  union all
  select 'column_acls', count(*)::integer,
         encode(extensions.digest(convert_to(coalesce(string_agg(schema_name || '.' || table_name || ':' || attnum::text || ':' || column_name || ':' || acl_state, '|' order by schema_name collate "C", table_name collate "C", attnum), ''), 'UTF8'), 'sha256'), 'hex'),
         0::integer
    from column_acl_definitions
  union all
  select 'policies', count(*)::integer,
         encode(extensions.digest(convert_to(coalesce(string_agg(table_name || ':' || policy_name || ':' || coalesce(actual_permissive::text, '') || ':' || coalesce(actual_command_name, '') || ':' || coalesce(actual_role_names, '') || ':' || coalesce(actual_predicate_kind, ''), '|' order by table_name collate "C", policy_name collate "C"), ''), 'UTF8'), 'sha256'), 'hex'),
         count(*) filter (where not expected_policy or not actual_policy or actual_permissive is distinct from permissive or actual_command_name is distinct from command_name or actual_role_names is distinct from role_names or actual_predicate_kind is distinct from predicate_kind)::integer
    from policy_compared
  union all
  select 'functions', count(*)::integer,
         encode(extensions.digest(convert_to(coalesce(string_agg(signature || ':' || coalesce(owner_name, '') || ':' || coalesce(language_name, '') || ':' || coalesce(actual_security_definer::text, '') || ':' || coalesce(actual_search_path_config, '') || ':' || coalesce(actual_service_execute::text, '') || ':' || coalesce(body_sha256, '') || ':' || coalesce(acl_state, ''), '|' order by signature collate "C"), ''), 'UTF8'), 'sha256'), 'hex'),
         count(*) filter (where owner_name is null or owner_name <> 'postgres' or language_name not in ('sql', 'plpgsql') or actual_security_definer is distinct from security_definer or actual_search_path_config is distinct from search_path_config or public_execute or anon_execute or authenticated_execute or actual_service_execute is distinct from service_execute or unexpected_execute_grant)::integer
    from function_compared
  union all
  select 'triggers', count(*)::integer,
         encode(extensions.digest(convert_to(coalesce(string_agg(table_name || ':' || trigger_name || ':' || coalesce(actual_function_schema, '') || '.' || coalesce(actual_function_name, '') || ':' || coalesce(actual_trigger_type::text, '') || ':' || coalesce(tgenabled::text, '') || ':' || coalesce(definition_sha256, ''), '|' order by table_name collate "C", trigger_name collate "C"), ''), 'UTF8'), 'sha256'), 'hex'),
         count(*) filter (where actual_function_schema is distinct from function_schema or actual_function_name is distinct from function_name or actual_trigger_type is distinct from trigger_type or tgenabled is distinct from 'O' or tgisinternal is distinct from false)::integer
    from trigger_compared
  union all
  select 'indexes', count(*)::integer,
         encode(extensions.digest(convert_to(coalesce(string_agg(index_name || ':' || coalesce(actual_table_name, '') || ':' || coalesce(actual_unique_index::text, '') || ':' || coalesce(actual_partial_index::text, '') || ':' || coalesce(indisvalid::text, '') || ':' || coalesce(indisready::text, '') || ':' || coalesce(definition_sha256, ''), '|' order by index_name collate "C"), ''), 'UTF8'), 'sha256'), 'hex'),
         count(*) filter (where actual_table_name is distinct from table_name or actual_unique_index is distinct from unique_index or actual_partial_index is distinct from partial_index or indisvalid is distinct from true or indisready is distinct from true)::integer
    from index_compared
  union all
  select 'sequences', count(*)::integer,
         encode(extensions.digest(convert_to(coalesce(string_agg(table_name || '.' || column_name || ':' || coalesce(owner_name, '') || ':' || coalesce(actual_service_usage::text, '') || ':' || coalesce(actual_service_select::text, '') || ':' || coalesce(actual_service_update::text, '') || ':' || coalesce(acl_state, ''), '|' order by table_name collate "C", column_name collate "C"), ''), 'UTF8'), 'sha256'), 'hex'),
         count(*) filter (where owner_name is null or owner_name <> 'postgres' or public_access or anon_access or authenticated_access or actual_service_usage is distinct from service_usage or actual_service_select is distinct from service_select or actual_service_update is distinct from service_update)::integer
    from sequence_compared
  union all
  select 'columns', count(*)::integer,
         encode(extensions.digest(convert_to(coalesce(string_agg(table_name || '.' || column_name || ':' || coalesce(actual_data_type, '') || ':' || coalesce(actual_nullable::text, '') || ':' || coalesce(actual_identity_column::text, ''), '|' order by table_name collate "C", column_name collate "C"), ''), 'UTF8'), 'sha256'), 'hex'),
         count(*) filter (where actual_data_type is distinct from data_type or actual_nullable is distinct from nullable or actual_identity_column is distinct from identity_column)::integer
    from column_compared
  union all
  select 'constraints', count(*)::integer,
         encode(extensions.digest(convert_to(coalesce(string_agg(table_name || ':' || constraint_identity || ':' || coalesce(actual_constraint_type, '') || ':' || coalesce(convalidated::text, '') || ':' || coalesce(definition_sha256, ''), '|' order by table_name collate "C", constraint_identity collate "C"), ''), 'UTF8'), 'sha256'), 'hex'),
         count(*) filter (where actual_constraint_type is distinct from constraint_type or convalidated is distinct from true)::integer
    from constraint_compared
  union all
  select 'scoped_indexes', count(*)::integer,
         encode(extensions.digest(convert_to(coalesce(string_agg(schema_name || '.' || table_name || ':' || index_name || ':' || definition_sha256, '|' order by schema_name collate "C", table_name collate "C", index_name collate "C"), ''), 'UTF8'), 'sha256'), 'hex'),
         0::integer
    from scoped_index_definitions
  union all
  select 'scoped_constraints', count(*)::integer,
         encode(extensions.digest(convert_to(coalesce(string_agg(schema_name || '.' || table_name || ':' || constraint_name || ':' || constraint_type || ':' || convalidated::text || ':' || definition_sha256, '|' order by schema_name collate "C", table_name collate "C", constraint_name collate "C"), ''), 'UTF8'), 'sha256'), 'hex'),
         count(*) filter (where not convalidated)::integer
    from scoped_constraint_definitions
)
select COALESCE(sum(failures), 0)::TEXT || ':' ||
       encode(
           extensions.digest(
               convert_to(
                   string_agg(
                       category || '=' || object_count::TEXT || ':' ||
                       CASE
                           WHEN category = 'scoped_constraints'
                               THEN 'restore-normalized'
                           ELSE state_digest
                       END || ':' || failures::TEXT,
                       ';' ORDER BY category COLLATE "C"
                   ),
                   'UTF8'
               ),
               'sha256'
           ),
           'hex'
       )
  from states
$v7$;

ALTER FUNCTION private.koaryu_release_operational_contract_v26() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.koaryu_release_operational_contract_v26()
    FROM PUBLIC, anon, authenticated, service_role;

DO $diagnostics$
BEGIN
    RAISE NOTICE 'KOARYU_V26_OPERATIONAL_CONTRACT=%',
        private.koaryu_release_operational_contract_v26();
    RAISE NOTICE 'KOARYU_V26_CRITICAL_SURFACE_MANIFEST=%',
        private.koaryu_release_critical_surface_manifest_v18();
    RAISE NOTICE 'KOARYU_V26_LIVE_BILLING_MANIFEST=%',
        private.koaryu_release_live_billing_v3_manifest_v25();
    RAISE NOTICE 'KOARYU_V26_PAYMENT_ADJUSTMENT_MANIFEST=%',
        private.koaryu_release_payment_adjustment_manifest_v26();
END;
$diagnostics$;

COMMENT ON FUNCTION private.koaryu_release_payment_adjustment_manifest_v26()
IS
    'Exact catalog, constraint, trigger, index, and helper ACL manifest for payment adjustment convergence.';
