-- Koaryu v1 - Billing foundation
-- Flat Koaryu Core subscription, optional studio payment processing, and
-- tenant-scoped billing projections.

CREATE TABLE IF NOT EXISTS studio_subscriptions (
    studio_id UUID PRIMARY KEY REFERENCES studios(id) ON DELETE CASCADE,
    stripe_customer_id TEXT,
    stripe_subscription_id TEXT,
    status TEXT NOT NULL DEFAULT 'comped'
        CHECK (status IN ('comped', 'trialing', 'active', 'past_due', 'unpaid', 'canceled', 'incomplete', 'incomplete_expired', 'paused')),
    plan_name TEXT NOT NULL DEFAULT 'Koaryu Core',
    monthly_price_cents INTEGER NOT NULL DEFAULT 2700 CHECK (monthly_price_cents >= 0),
    currency TEXT NOT NULL DEFAULT 'usd',
    trial_start TIMESTAMPTZ,
    trial_end TIMESTAMPTZ,
    current_period_start TIMESTAMPTZ,
    current_period_end TIMESTAMPTZ,
    cancel_at_period_end BOOLEAN NOT NULL DEFAULT false,
    last_payment_status TEXT,
    comped BOOLEAN NOT NULL DEFAULT true,
    metadata JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_studio_subscriptions_customer
    ON studio_subscriptions(stripe_customer_id)
    WHERE stripe_customer_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_studio_subscriptions_subscription
    ON studio_subscriptions(stripe_subscription_id)
    WHERE stripe_subscription_id IS NOT NULL;

INSERT INTO studio_subscriptions (studio_id, status, comped, metadata)
SELECT id, 'comped', true, jsonb_build_object('backfilled', true)
FROM studios
ON CONFLICT (studio_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS studio_payment_accounts (
    studio_id UUID PRIMARY KEY REFERENCES studios(id) ON DELETE CASCADE,
    stripe_connected_account_id TEXT UNIQUE,
    status TEXT NOT NULL DEFAULT 'not_connected'
        CHECK (status IN ('not_connected', 'onboarding_incomplete', 'charges_enabled', 'action_required', 'deauthorized')),
    charges_enabled BOOLEAN NOT NULL DEFAULT false,
    payouts_enabled BOOLEAN NOT NULL DEFAULT false,
    details_submitted BOOLEAN NOT NULL DEFAULT false,
    requirements_due TEXT[] NOT NULL DEFAULT '{}',
    platform_fee_bps INTEGER NOT NULL DEFAULT 50 CHECK (platform_fee_bps >= 0),
    metadata JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_studio_payment_accounts_status
    ON studio_payment_accounts(studio_id, status);

CREATE TABLE IF NOT EXISTS email_usage_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    studio_id UUID NOT NULL REFERENCES studios(id) ON DELETE CASCADE,
    category TEXT NOT NULL DEFAULT 'general',
    recipient TEXT,
    provider_message_id TEXT,
    quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
    sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    metadata JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_usage_events_studio_sent
    ON email_usage_events(studio_id, sent_at);

CREATE TABLE IF NOT EXISTS billing_payers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    studio_id UUID NOT NULL REFERENCES studios(id) ON DELETE CASCADE,
    guardian_id UUID REFERENCES guardians(id) ON DELETE SET NULL,
    display_name TEXT NOT NULL,
    email TEXT,
    phone TEXT,
    address_line1 TEXT,
    address_city TEXT,
    address_state TEXT,
    address_zip TEXT,
    stripe_customer_id TEXT,
    autopay_status TEXT NOT NULL DEFAULT 'not_configured'
        CHECK (autopay_status IN ('not_configured', 'pending', 'enabled', 'disabled')),
    billing_status TEXT NOT NULL DEFAULT 'no_payment_method'
        CHECK (billing_status IN ('current', 'upcoming', 'past_due', 'failed', 'unpaid', 'externally_paid', 'no_payment_method', 'no_billing_plan')),
    balance_cents INTEGER NOT NULL DEFAULT 0,
    metadata JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_billing_payers_studio
    ON billing_payers(studio_id, display_name);
CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_payers_stripe_customer
    ON billing_payers(studio_id, stripe_customer_id)
    WHERE stripe_customer_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS billing_plans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    studio_id UUID NOT NULL REFERENCES studios(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
    currency TEXT NOT NULL DEFAULT 'usd',
    billing_interval TEXT NOT NULL DEFAULT 'monthly'
        CHECK (billing_interval IN ('weekly', 'biweekly', 'monthly', 'annual', 'paid_in_full', 'fixed_term', 'trial')),
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'active', 'archived')),
    signup_fee_cents INTEGER NOT NULL DEFAULT 0 CHECK (signup_fee_cents >= 0),
    trial_days INTEGER NOT NULL DEFAULT 0 CHECK (trial_days >= 0),
    proration_behavior TEXT NOT NULL DEFAULT 'next_cycle',
    freeze_behavior TEXT,
    cancellation_policy TEXT,
    tax_behavior TEXT,
    stripe_product_id TEXT,
    stripe_price_id TEXT,
    metadata JSONB NOT NULL DEFAULT '{}',
    archived_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_billing_plans_studio_status
    ON billing_plans(studio_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_plans_active_name
    ON billing_plans(studio_id, lower(name))
    WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS billing_plan_programs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    studio_id UUID NOT NULL REFERENCES studios(id) ON DELETE CASCADE,
    billing_plan_id UUID NOT NULL REFERENCES billing_plans(id) ON DELETE CASCADE,
    program_id UUID NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(billing_plan_id, program_id)
);

CREATE INDEX IF NOT EXISTS idx_billing_plan_programs_studio
    ON billing_plan_programs(studio_id, program_id);

CREATE TABLE IF NOT EXISTS student_billing_enrollments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    studio_id UUID NOT NULL REFERENCES studios(id) ON DELETE CASCADE,
    student_id UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    payer_id UUID REFERENCES billing_payers(id) ON DELETE SET NULL,
    billing_plan_id UUID NOT NULL REFERENCES billing_plans(id) ON DELETE RESTRICT,
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('pending', 'active', 'paused', 'ended', 'canceled')),
    billing_status TEXT NOT NULL DEFAULT 'no_payment_method'
        CHECK (billing_status IN ('current', 'upcoming', 'past_due', 'failed', 'unpaid', 'externally_paid', 'no_payment_method', 'no_billing_plan')),
    start_date DATE NOT NULL DEFAULT CURRENT_DATE,
    end_date DATE,
    next_bill_on DATE,
    stripe_subscription_id TEXT,
    metadata JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_student_billing_enrollments_studio_student
    ON student_billing_enrollments(studio_id, student_id, status);
CREATE INDEX IF NOT EXISTS idx_student_billing_enrollments_plan
    ON student_billing_enrollments(studio_id, billing_plan_id);

CREATE TABLE IF NOT EXISTS billing_invoices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    studio_id UUID NOT NULL REFERENCES studios(id) ON DELETE CASCADE,
    payer_id UUID REFERENCES billing_payers(id) ON DELETE SET NULL,
    student_id UUID REFERENCES students(id) ON DELETE SET NULL,
    enrollment_id UUID REFERENCES student_billing_enrollments(id) ON DELETE SET NULL,
    stripe_invoice_id TEXT,
    stripe_account_id TEXT,
    invoice_type TEXT NOT NULL DEFAULT 'manual',
    status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'open', 'paid', 'void', 'uncollectible', 'refunded', 'partially_refunded')),
    amount_due_cents INTEGER NOT NULL DEFAULT 0,
    amount_paid_cents INTEGER NOT NULL DEFAULT 0,
    currency TEXT NOT NULL DEFAULT 'usd',
    hosted_invoice_url TEXT,
    due_date DATE,
    paid_at TIMESTAMPTZ,
    external BOOLEAN NOT NULL DEFAULT false,
    metadata JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_billing_invoices_studio_status
    ON billing_invoices(studio_id, status, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_invoices_stripe
    ON billing_invoices(studio_id, stripe_account_id, stripe_invoice_id)
    WHERE stripe_invoice_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS billing_invoice_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    studio_id UUID NOT NULL REFERENCES studios(id) ON DELETE CASCADE,
    invoice_id UUID NOT NULL REFERENCES billing_invoices(id) ON DELETE CASCADE,
    student_id UUID REFERENCES students(id) ON DELETE SET NULL,
    description TEXT NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
    unit_amount_cents INTEGER NOT NULL DEFAULT 0,
    amount_cents INTEGER NOT NULL DEFAULT 0,
    metadata JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_billing_invoice_items_studio_invoice
    ON billing_invoice_items(studio_id, invoice_id);

CREATE TABLE IF NOT EXISTS billing_payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    studio_id UUID NOT NULL REFERENCES studios(id) ON DELETE CASCADE,
    payer_id UUID REFERENCES billing_payers(id) ON DELETE SET NULL,
    invoice_id UUID REFERENCES billing_invoices(id) ON DELETE SET NULL,
    stripe_payment_intent_id TEXT,
    stripe_charge_id TEXT,
    stripe_account_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'succeeded', 'failed', 'refunded', 'disputed', 'externally_recorded')),
    amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
    currency TEXT NOT NULL DEFAULT 'usd',
    payment_method_type TEXT,
    external_method TEXT,
    note TEXT,
    processed_at TIMESTAMPTZ,
    metadata JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_billing_payments_studio_status
    ON billing_payments(studio_id, status, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_payments_stripe_intent
    ON billing_payments(studio_id, stripe_account_id, stripe_payment_intent_id)
    WHERE stripe_payment_intent_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS billing_refunds (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    studio_id UUID NOT NULL REFERENCES studios(id) ON DELETE CASCADE,
    payment_id UUID REFERENCES billing_payments(id) ON DELETE SET NULL,
    stripe_refund_id TEXT,
    stripe_account_id TEXT,
    amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
    status TEXT NOT NULL DEFAULT 'pending',
    reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_billing_refunds_studio
    ON billing_refunds(studio_id, created_at DESC);

CREATE TABLE IF NOT EXISTS billing_disputes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    studio_id UUID NOT NULL REFERENCES studios(id) ON DELETE CASCADE,
    payment_id UUID REFERENCES billing_payments(id) ON DELETE SET NULL,
    stripe_dispute_id TEXT,
    stripe_account_id TEXT,
    amount_cents INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    reason TEXT,
    liability_owner TEXT NOT NULL DEFAULT 'studio',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_billing_disputes_studio_status
    ON billing_disputes(studio_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS billing_adjustments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    studio_id UUID NOT NULL REFERENCES studios(id) ON DELETE CASCADE,
    payer_id UUID REFERENCES billing_payers(id) ON DELETE SET NULL,
    student_id UUID REFERENCES students(id) ON DELETE SET NULL,
    amount_cents INTEGER NOT NULL,
    reason TEXT NOT NULL,
    note TEXT,
    created_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_billing_adjustments_studio
    ON billing_adjustments(studio_id, created_at DESC);

CREATE TABLE IF NOT EXISTS stripe_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    stripe_event_id TEXT NOT NULL,
    livemode BOOLEAN NOT NULL DEFAULT false,
    stripe_account_id TEXT,
    type TEXT NOT NULL,
    payload JSONB NOT NULL,
    processing_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (processing_status IN ('pending', 'processing', 'processed', 'failed', 'ignored')),
    error TEXT,
    processed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_stripe_events_unique_event_account
    ON stripe_events(stripe_event_id, COALESCE(stripe_account_id, 'platform'));
CREATE INDEX IF NOT EXISTS idx_stripe_events_type
    ON stripe_events(type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stripe_events_account
    ON stripe_events(stripe_account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS export_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    studio_id UUID NOT NULL REFERENCES studios(id) ON DELETE CASCADE,
    export_type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'running', 'completed', 'failed')),
    requested_by UUID,
    download_url TEXT,
    error TEXT,
    metadata JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_export_jobs_studio_status
    ON export_jobs(studio_id, status, created_at DESC);

DROP TRIGGER IF EXISTS set_studio_subscriptions_updated_at ON studio_subscriptions;
CREATE TRIGGER set_studio_subscriptions_updated_at
    BEFORE UPDATE ON studio_subscriptions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS set_studio_payment_accounts_updated_at ON studio_payment_accounts;
CREATE TRIGGER set_studio_payment_accounts_updated_at
    BEFORE UPDATE ON studio_payment_accounts
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS set_billing_payers_updated_at ON billing_payers;
CREATE TRIGGER set_billing_payers_updated_at
    BEFORE UPDATE ON billing_payers
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS set_billing_plans_updated_at ON billing_plans;
CREATE TRIGGER set_billing_plans_updated_at
    BEFORE UPDATE ON billing_plans
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS set_student_billing_enrollments_updated_at ON student_billing_enrollments;
CREATE TRIGGER set_student_billing_enrollments_updated_at
    BEFORE UPDATE ON student_billing_enrollments
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS set_billing_invoices_updated_at ON billing_invoices;
CREATE TRIGGER set_billing_invoices_updated_at
    BEFORE UPDATE ON billing_invoices
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS set_billing_payments_updated_at ON billing_payments;
CREATE TRIGGER set_billing_payments_updated_at
    BEFORE UPDATE ON billing_payments
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS set_billing_disputes_updated_at ON billing_disputes;
CREATE TRIGGER set_billing_disputes_updated_at
    BEFORE UPDATE ON billing_disputes
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS set_export_jobs_updated_at ON export_jobs;
CREATE TRIGGER set_export_jobs_updated_at
    BEFORE UPDATE ON export_jobs
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE OR REPLACE FUNCTION validate_billing_plan_program()
RETURNS TRIGGER AS $$
DECLARE
    plan_studio UUID;
    program_studio UUID;
BEGIN
    SELECT studio_id INTO plan_studio FROM billing_plans WHERE id = NEW.billing_plan_id;
    SELECT studio_id INTO program_studio FROM programs WHERE id = NEW.program_id;
    IF plan_studio IS NULL OR program_studio IS NULL OR plan_studio <> NEW.studio_id OR program_studio <> NEW.studio_id THEN
        RAISE EXCEPTION 'Billing plan and program must belong to the same studio';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS validate_billing_plan_program_trigger ON billing_plan_programs;
CREATE TRIGGER validate_billing_plan_program_trigger
    BEFORE INSERT OR UPDATE ON billing_plan_programs
    FOR EACH ROW EXECUTE FUNCTION validate_billing_plan_program();

CREATE OR REPLACE FUNCTION validate_student_billing_enrollment()
RETURNS TRIGGER AS $$
DECLARE
    student_studio UUID;
    payer_studio UUID;
    plan_studio UUID;
BEGIN
    SELECT studio_id INTO student_studio FROM students WHERE id = NEW.student_id;
    SELECT studio_id INTO plan_studio FROM billing_plans WHERE id = NEW.billing_plan_id;
    IF NEW.payer_id IS NOT NULL THEN
        SELECT studio_id INTO payer_studio FROM billing_payers WHERE id = NEW.payer_id;
    ELSE
        payer_studio := NEW.studio_id;
    END IF;
    IF student_studio IS NULL OR plan_studio IS NULL
       OR student_studio <> NEW.studio_id
       OR plan_studio <> NEW.studio_id
       OR payer_studio <> NEW.studio_id THEN
        RAISE EXCEPTION 'Billing enrollment references must belong to the same studio';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS validate_student_billing_enrollment_trigger ON student_billing_enrollments;
CREATE TRIGGER validate_student_billing_enrollment_trigger
    BEFORE INSERT OR UPDATE ON student_billing_enrollments
    FOR EACH ROW EXECUTE FUNCTION validate_student_billing_enrollment();

CREATE OR REPLACE FUNCTION validate_billing_payer_guardian()
RETURNS TRIGGER AS $$
DECLARE
    guardian_studio UUID;
BEGIN
    IF NEW.guardian_id IS NULL THEN
        RETURN NEW;
    END IF;
    SELECT studio_id INTO guardian_studio FROM guardians WHERE id = NEW.guardian_id;
    IF guardian_studio IS NULL OR guardian_studio <> NEW.studio_id THEN
        RAISE EXCEPTION 'Billing payer guardian must belong to the same studio';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS validate_billing_payer_guardian_trigger ON billing_payers;
CREATE TRIGGER validate_billing_payer_guardian_trigger
    BEFORE INSERT OR UPDATE ON billing_payers
    FOR EACH ROW EXECUTE FUNCTION validate_billing_payer_guardian();

CREATE OR REPLACE FUNCTION validate_billing_invoice_refs()
RETURNS TRIGGER AS $$
DECLARE
    payer_studio UUID;
    student_studio UUID;
    enrollment_studio UUID;
BEGIN
    IF NEW.payer_id IS NOT NULL THEN
        SELECT studio_id INTO payer_studio FROM billing_payers WHERE id = NEW.payer_id;
        IF payer_studio IS NULL OR payer_studio <> NEW.studio_id THEN
            RAISE EXCEPTION 'Billing invoice payer must belong to the same studio';
        END IF;
    END IF;
    IF NEW.student_id IS NOT NULL THEN
        SELECT studio_id INTO student_studio FROM students WHERE id = NEW.student_id;
        IF student_studio IS NULL OR student_studio <> NEW.studio_id THEN
            RAISE EXCEPTION 'Billing invoice student must belong to the same studio';
        END IF;
    END IF;
    IF NEW.enrollment_id IS NOT NULL THEN
        SELECT studio_id INTO enrollment_studio FROM student_billing_enrollments WHERE id = NEW.enrollment_id;
        IF enrollment_studio IS NULL OR enrollment_studio <> NEW.studio_id THEN
            RAISE EXCEPTION 'Billing invoice enrollment must belong to the same studio';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS validate_billing_invoice_refs_trigger ON billing_invoices;
CREATE TRIGGER validate_billing_invoice_refs_trigger
    BEFORE INSERT OR UPDATE ON billing_invoices
    FOR EACH ROW EXECUTE FUNCTION validate_billing_invoice_refs();

CREATE OR REPLACE FUNCTION validate_billing_invoice_item_refs()
RETURNS TRIGGER AS $$
DECLARE
    invoice_studio UUID;
    student_studio UUID;
BEGIN
    SELECT studio_id INTO invoice_studio FROM billing_invoices WHERE id = NEW.invoice_id;
    IF invoice_studio IS NULL OR invoice_studio <> NEW.studio_id THEN
        RAISE EXCEPTION 'Billing invoice item invoice must belong to the same studio';
    END IF;
    IF NEW.student_id IS NOT NULL THEN
        SELECT studio_id INTO student_studio FROM students WHERE id = NEW.student_id;
        IF student_studio IS NULL OR student_studio <> NEW.studio_id THEN
            RAISE EXCEPTION 'Billing invoice item student must belong to the same studio';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS validate_billing_invoice_item_refs_trigger ON billing_invoice_items;
CREATE TRIGGER validate_billing_invoice_item_refs_trigger
    BEFORE INSERT OR UPDATE ON billing_invoice_items
    FOR EACH ROW EXECUTE FUNCTION validate_billing_invoice_item_refs();

CREATE OR REPLACE FUNCTION validate_billing_payment_refs()
RETURNS TRIGGER AS $$
DECLARE
    payer_studio UUID;
    invoice_studio UUID;
BEGIN
    IF NEW.payer_id IS NOT NULL THEN
        SELECT studio_id INTO payer_studio FROM billing_payers WHERE id = NEW.payer_id;
        IF payer_studio IS NULL OR payer_studio <> NEW.studio_id THEN
            RAISE EXCEPTION 'Billing payment payer must belong to the same studio';
        END IF;
    END IF;
    IF NEW.invoice_id IS NOT NULL THEN
        SELECT studio_id INTO invoice_studio FROM billing_invoices WHERE id = NEW.invoice_id;
        IF invoice_studio IS NULL OR invoice_studio <> NEW.studio_id THEN
            RAISE EXCEPTION 'Billing payment invoice must belong to the same studio';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS validate_billing_payment_refs_trigger ON billing_payments;
CREATE TRIGGER validate_billing_payment_refs_trigger
    BEFORE INSERT OR UPDATE ON billing_payments
    FOR EACH ROW EXECUTE FUNCTION validate_billing_payment_refs();

CREATE OR REPLACE FUNCTION validate_billing_refund_refs()
RETURNS TRIGGER AS $$
DECLARE
    payment_studio UUID;
BEGIN
    IF NEW.payment_id IS NULL THEN
        RETURN NEW;
    END IF;
    SELECT studio_id INTO payment_studio FROM billing_payments WHERE id = NEW.payment_id;
    IF payment_studio IS NULL OR payment_studio <> NEW.studio_id THEN
        RAISE EXCEPTION 'Billing refund payment must belong to the same studio';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS validate_billing_refund_refs_trigger ON billing_refunds;
CREATE TRIGGER validate_billing_refund_refs_trigger
    BEFORE INSERT OR UPDATE ON billing_refunds
    FOR EACH ROW EXECUTE FUNCTION validate_billing_refund_refs();

CREATE OR REPLACE FUNCTION validate_billing_dispute_refs()
RETURNS TRIGGER AS $$
DECLARE
    payment_studio UUID;
BEGIN
    IF NEW.payment_id IS NULL THEN
        RETURN NEW;
    END IF;
    SELECT studio_id INTO payment_studio FROM billing_payments WHERE id = NEW.payment_id;
    IF payment_studio IS NULL OR payment_studio <> NEW.studio_id THEN
        RAISE EXCEPTION 'Billing dispute payment must belong to the same studio';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS validate_billing_dispute_refs_trigger ON billing_disputes;
CREATE TRIGGER validate_billing_dispute_refs_trigger
    BEFORE INSERT OR UPDATE ON billing_disputes
    FOR EACH ROW EXECUTE FUNCTION validate_billing_dispute_refs();

CREATE OR REPLACE FUNCTION validate_billing_adjustment_refs()
RETURNS TRIGGER AS $$
DECLARE
    payer_studio UUID;
    student_studio UUID;
BEGIN
    IF NEW.payer_id IS NOT NULL THEN
        SELECT studio_id INTO payer_studio FROM billing_payers WHERE id = NEW.payer_id;
        IF payer_studio IS NULL OR payer_studio <> NEW.studio_id THEN
            RAISE EXCEPTION 'Billing adjustment payer must belong to the same studio';
        END IF;
    END IF;
    IF NEW.student_id IS NOT NULL THEN
        SELECT studio_id INTO student_studio FROM students WHERE id = NEW.student_id;
        IF student_studio IS NULL OR student_studio <> NEW.studio_id THEN
            RAISE EXCEPTION 'Billing adjustment student must belong to the same studio';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS validate_billing_adjustment_refs_trigger ON billing_adjustments;
CREATE TRIGGER validate_billing_adjustment_refs_trigger
    BEFORE INSERT OR UPDATE ON billing_adjustments
    FOR EACH ROW EXECUTE FUNCTION validate_billing_adjustment_refs();

ALTER TABLE studio_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE studio_payment_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_usage_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_payers ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_plan_programs ENABLE ROW LEVEL SECURITY;
ALTER TABLE student_billing_enrollments ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_invoice_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_refunds ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_disputes ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_adjustments ENABLE ROW LEVEL SECURITY;
ALTER TABLE stripe_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE export_jobs ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION is_staff_in_studio(target_studio_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1 FROM staff_roles
        WHERE staff_roles.studio_id = target_studio_id
          AND staff_roles.user_id = auth.uid()
    );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

CREATE OR REPLACE FUNCTION is_admin_or_front_desk_in_studio(target_studio_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1 FROM staff_roles
        WHERE staff_roles.studio_id = target_studio_id
          AND staff_roles.user_id = auth.uid()
          AND staff_roles.role IN ('admin', 'front_desk')
    );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

CREATE OR REPLACE FUNCTION is_admin_in_studio(target_studio_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1 FROM staff_roles
        WHERE staff_roles.studio_id = target_studio_id
          AND staff_roles.user_id = auth.uid()
          AND staff_roles.role = 'admin'
    );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

DROP POLICY IF EXISTS "studio_subscriptions_admin_select" ON studio_subscriptions;
CREATE POLICY "studio_subscriptions_admin_select" ON studio_subscriptions FOR SELECT
    USING (is_admin_in_studio(studio_id));
DROP POLICY IF EXISTS "studio_payment_accounts_admin_select" ON studio_payment_accounts;
CREATE POLICY "studio_payment_accounts_admin_select" ON studio_payment_accounts FOR SELECT
    USING (is_admin_in_studio(studio_id));
DROP POLICY IF EXISTS "email_usage_events_admin_select" ON email_usage_events;
CREATE POLICY "email_usage_events_admin_select" ON email_usage_events FOR SELECT
    USING (is_admin_in_studio(studio_id));

DROP POLICY IF EXISTS "billing_payers_manager_select" ON billing_payers;
CREATE POLICY "billing_payers_manager_select" ON billing_payers FOR SELECT
    USING (is_admin_or_front_desk_in_studio(studio_id));
DROP POLICY IF EXISTS "billing_plans_manager_select" ON billing_plans;
CREATE POLICY "billing_plans_manager_select" ON billing_plans FOR SELECT
    USING (is_admin_or_front_desk_in_studio(studio_id));
DROP POLICY IF EXISTS "billing_plan_programs_manager_select" ON billing_plan_programs;
CREATE POLICY "billing_plan_programs_manager_select" ON billing_plan_programs FOR SELECT
    USING (is_admin_or_front_desk_in_studio(studio_id));
DROP POLICY IF EXISTS "student_billing_enrollments_manager_select" ON student_billing_enrollments;
CREATE POLICY "student_billing_enrollments_manager_select" ON student_billing_enrollments FOR SELECT
    USING (is_admin_or_front_desk_in_studio(studio_id));
DROP POLICY IF EXISTS "billing_invoices_manager_select" ON billing_invoices;
CREATE POLICY "billing_invoices_manager_select" ON billing_invoices FOR SELECT
    USING (is_admin_or_front_desk_in_studio(studio_id));
DROP POLICY IF EXISTS "billing_invoice_items_manager_select" ON billing_invoice_items;
CREATE POLICY "billing_invoice_items_manager_select" ON billing_invoice_items FOR SELECT
    USING (is_admin_or_front_desk_in_studio(studio_id));
DROP POLICY IF EXISTS "billing_payments_manager_select" ON billing_payments;
CREATE POLICY "billing_payments_manager_select" ON billing_payments FOR SELECT
    USING (is_admin_or_front_desk_in_studio(studio_id));
DROP POLICY IF EXISTS "billing_refunds_manager_select" ON billing_refunds;
CREATE POLICY "billing_refunds_manager_select" ON billing_refunds FOR SELECT
    USING (is_admin_or_front_desk_in_studio(studio_id));
DROP POLICY IF EXISTS "billing_disputes_manager_select" ON billing_disputes;
CREATE POLICY "billing_disputes_manager_select" ON billing_disputes FOR SELECT
    USING (is_admin_or_front_desk_in_studio(studio_id));
DROP POLICY IF EXISTS "billing_adjustments_manager_select" ON billing_adjustments;
CREATE POLICY "billing_adjustments_manager_select" ON billing_adjustments FOR SELECT
    USING (is_admin_or_front_desk_in_studio(studio_id));
DROP POLICY IF EXISTS "export_jobs_manager_select" ON export_jobs;
CREATE POLICY "export_jobs_manager_select" ON export_jobs FOR SELECT
    USING (is_admin_or_front_desk_in_studio(studio_id));

-- Application writes are performed through the service-role backend after
-- explicit role and studio-scope checks. RLS keeps direct client reads narrow.
