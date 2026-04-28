-- Koaryu Payments v1 lifecycle: Connect-native customers, prices,
-- payer billing groups, and richer Stripe invoice/payment projections.

ALTER TABLE billing_payers
    ADD COLUMN IF NOT EXISTS stripe_account_id TEXT,
    ADD COLUMN IF NOT EXISTS default_payment_method_id TEXT,
    ADD COLUMN IF NOT EXISTS default_payment_method_brand TEXT,
    ADD COLUMN IF NOT EXISTS default_payment_method_last4 TEXT,
    ADD COLUMN IF NOT EXISTS default_payment_method_exp_month INTEGER,
    ADD COLUMN IF NOT EXISTS default_payment_method_exp_year INTEGER,
    ADD COLUMN IF NOT EXISTS autopay_authorized_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS autopay_disabled_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS autopay_terms_accepted_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_payers_stripe_customer_account
    ON billing_payers(studio_id, stripe_account_id, stripe_customer_id)
    WHERE stripe_customer_id IS NOT NULL AND stripe_account_id IS NOT NULL;

ALTER TABLE billing_plans
    ADD COLUMN IF NOT EXISTS stripe_account_id TEXT,
    ADD COLUMN IF NOT EXISTS stripe_price_lookup_key TEXT,
    ADD COLUMN IF NOT EXISTS stripe_one_time_price_id TEXT,
    ADD COLUMN IF NOT EXISTS stripe_price_version INTEGER NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS billing_plan_prices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    studio_id UUID NOT NULL REFERENCES studios(id) ON DELETE CASCADE,
    billing_plan_id UUID NOT NULL REFERENCES billing_plans(id) ON DELETE CASCADE,
    stripe_account_id TEXT NOT NULL,
    stripe_product_id TEXT NOT NULL,
    stripe_price_id TEXT NOT NULL,
    amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
    currency TEXT NOT NULL DEFAULT 'usd',
    billing_interval TEXT NOT NULL,
    interval_count INTEGER NOT NULL DEFAULT 1 CHECK (interval_count > 0),
    recurring BOOLEAN NOT NULL DEFAULT true,
    active BOOLEAN NOT NULL DEFAULT true,
    version INTEGER NOT NULL DEFAULT 1,
    metadata JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(studio_id, stripe_account_id, stripe_price_id)
);

CREATE INDEX IF NOT EXISTS idx_billing_plan_prices_plan_active
    ON billing_plan_prices(studio_id, billing_plan_id, active, created_at DESC);

CREATE TABLE IF NOT EXISTS billing_subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    studio_id UUID NOT NULL REFERENCES studios(id) ON DELETE CASCADE,
    payer_id UUID NOT NULL REFERENCES billing_payers(id) ON DELETE CASCADE,
    stripe_account_id TEXT,
    stripe_customer_id TEXT,
    stripe_subscription_id TEXT,
    collection_mode TEXT NOT NULL DEFAULT 'invoice_link'
        CHECK (collection_mode IN ('autopay', 'invoice_link', 'external')),
    billing_interval TEXT NOT NULL DEFAULT 'monthly',
    currency TEXT NOT NULL DEFAULT 'usd',
    status TEXT NOT NULL DEFAULT 'pending',
    current_period_start TIMESTAMPTZ,
    current_period_end TIMESTAMPTZ,
    cancel_at_period_end BOOLEAN NOT NULL DEFAULT false,
    default_payment_method_id TEXT,
    application_fee_percent NUMERIC(6, 3),
    metadata JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_billing_subscriptions_studio_payer
    ON billing_subscriptions(studio_id, payer_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_subscriptions_stripe
    ON billing_subscriptions(studio_id, stripe_account_id, stripe_subscription_id)
    WHERE stripe_subscription_id IS NOT NULL;

ALTER TABLE student_billing_enrollments
    ADD COLUMN IF NOT EXISTS billing_subscription_id UUID REFERENCES billing_subscriptions(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS collection_mode TEXT NOT NULL DEFAULT 'invoice_link'
        CHECK (collection_mode IN ('autopay', 'invoice_link', 'external')),
    ADD COLUMN IF NOT EXISTS stripe_subscription_item_id TEXT;

CREATE INDEX IF NOT EXISTS idx_student_billing_enrollments_subscription
    ON student_billing_enrollments(studio_id, billing_subscription_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_student_billing_enrollments_stripe_item
    ON student_billing_enrollments(studio_id, stripe_subscription_item_id)
    WHERE stripe_subscription_item_id IS NOT NULL;

ALTER TABLE billing_invoices
    ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT,
    ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT,
    ADD COLUMN IF NOT EXISTS stripe_payment_intent_id TEXT,
    ADD COLUMN IF NOT EXISTS invoice_number TEXT,
    ADD COLUMN IF NOT EXISTS invoice_pdf TEXT,
    ADD COLUMN IF NOT EXISTS amount_remaining_cents INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS collection_method TEXT,
    ADD COLUMN IF NOT EXISTS last_payment_error TEXT,
    ADD COLUMN IF NOT EXISTS application_fee_amount_cents INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS finalized_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_billing_invoices_stripe_customer
    ON billing_invoices(studio_id, stripe_account_id, stripe_customer_id)
    WHERE stripe_customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_billing_invoices_subscription
    ON billing_invoices(studio_id, stripe_account_id, stripe_subscription_id)
    WHERE stripe_subscription_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_invoices_payment_intent
    ON billing_invoices(studio_id, stripe_account_id, stripe_payment_intent_id)
    WHERE stripe_payment_intent_id IS NOT NULL;

ALTER TABLE billing_invoice_items
    ADD COLUMN IF NOT EXISTS enrollment_id UUID REFERENCES student_billing_enrollments(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS billing_plan_id UUID REFERENCES billing_plans(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS stripe_invoice_item_id TEXT,
    ADD COLUMN IF NOT EXISTS stripe_price_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_invoice_items_stripe
    ON billing_invoice_items(studio_id, stripe_invoice_item_id)
    WHERE stripe_invoice_item_id IS NOT NULL;

ALTER TABLE billing_payments
    ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT,
    ADD COLUMN IF NOT EXISTS stripe_invoice_id TEXT,
    ADD COLUMN IF NOT EXISTS stripe_payment_method_id TEXT,
    ADD COLUMN IF NOT EXISTS receipt_url TEXT,
    ADD COLUMN IF NOT EXISTS failure_code TEXT,
    ADD COLUMN IF NOT EXISTS failure_message TEXT,
    ADD COLUMN IF NOT EXISTS application_fee_amount_cents INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS refunded_amount_cents INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_billing_payments_invoice_stripe
    ON billing_payments(studio_id, stripe_account_id, stripe_invoice_id)
    WHERE stripe_invoice_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_payments_stripe_charge
    ON billing_payments(studio_id, stripe_account_id, stripe_charge_id)
    WHERE stripe_charge_id IS NOT NULL;

ALTER TABLE billing_refunds
    ADD COLUMN IF NOT EXISTS stripe_charge_id TEXT,
    ADD COLUMN IF NOT EXISTS stripe_payment_intent_id TEXT,
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}';

CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_refunds_stripe
    ON billing_refunds(studio_id, stripe_account_id, stripe_refund_id)
    WHERE stripe_refund_id IS NOT NULL;

ALTER TABLE billing_disputes
    ADD COLUMN IF NOT EXISTS stripe_charge_id TEXT,
    ADD COLUMN IF NOT EXISTS stripe_payment_intent_id TEXT,
    ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}';

CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_disputes_stripe
    ON billing_disputes(studio_id, stripe_account_id, stripe_dispute_id)
    WHERE stripe_dispute_id IS NOT NULL;

DROP TRIGGER IF EXISTS set_billing_subscriptions_updated_at ON billing_subscriptions;
CREATE TRIGGER set_billing_subscriptions_updated_at
    BEFORE UPDATE ON billing_subscriptions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS set_billing_refunds_updated_at ON billing_refunds;
CREATE TRIGGER set_billing_refunds_updated_at
    BEFORE UPDATE ON billing_refunds
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE OR REPLACE FUNCTION validate_billing_subscription_refs()
RETURNS TRIGGER AS $$
DECLARE
    payer_studio UUID;
BEGIN
    SELECT studio_id INTO payer_studio FROM billing_payers WHERE id = NEW.payer_id;
    IF payer_studio IS NULL OR payer_studio <> NEW.studio_id THEN
        RAISE EXCEPTION 'Billing subscription payer must belong to the same studio';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS validate_billing_subscription_refs_trigger ON billing_subscriptions;
CREATE TRIGGER validate_billing_subscription_refs_trigger
    BEFORE INSERT OR UPDATE ON billing_subscriptions
    FOR EACH ROW EXECUTE FUNCTION validate_billing_subscription_refs();

ALTER TABLE billing_subscriptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "billing_subscriptions_manager_select" ON billing_subscriptions;
CREATE POLICY "billing_subscriptions_manager_select" ON billing_subscriptions FOR SELECT
    USING (private.is_admin_or_front_desk_in_studio(studio_id));

ALTER FUNCTION public.validate_billing_subscription_refs()
    SET search_path = public, pg_temp;
