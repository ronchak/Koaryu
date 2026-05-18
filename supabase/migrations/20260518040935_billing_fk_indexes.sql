-- Cover billing foreign keys that Supabase's advisor flagged as unindexed.
-- These keep joins, deletes, and parent-key updates predictable as live billing data grows.

CREATE INDEX IF NOT EXISTS idx_billing_adjustments_payer_id
    ON billing_adjustments(payer_id);
CREATE INDEX IF NOT EXISTS idx_billing_adjustments_student_id
    ON billing_adjustments(student_id);

CREATE INDEX IF NOT EXISTS idx_billing_disputes_payment_id
    ON billing_disputes(payment_id);

CREATE INDEX IF NOT EXISTS idx_billing_invoice_items_billing_plan_id
    ON billing_invoice_items(billing_plan_id);
CREATE INDEX IF NOT EXISTS idx_billing_invoice_items_enrollment_id
    ON billing_invoice_items(enrollment_id);
CREATE INDEX IF NOT EXISTS idx_billing_invoice_items_invoice_id
    ON billing_invoice_items(invoice_id);
CREATE INDEX IF NOT EXISTS idx_billing_invoice_items_student_id
    ON billing_invoice_items(student_id);

CREATE INDEX IF NOT EXISTS idx_billing_invoices_enrollment_id
    ON billing_invoices(enrollment_id);
CREATE INDEX IF NOT EXISTS idx_billing_invoices_payer_id
    ON billing_invoices(payer_id);
CREATE INDEX IF NOT EXISTS idx_billing_invoices_student_id
    ON billing_invoices(student_id);

CREATE INDEX IF NOT EXISTS idx_billing_payers_guardian_id
    ON billing_payers(guardian_id);

CREATE INDEX IF NOT EXISTS idx_billing_payments_invoice_id
    ON billing_payments(invoice_id);
CREATE INDEX IF NOT EXISTS idx_billing_payments_payer_id
    ON billing_payments(payer_id);

CREATE INDEX IF NOT EXISTS idx_billing_plan_prices_billing_plan_id
    ON billing_plan_prices(billing_plan_id);

CREATE INDEX IF NOT EXISTS idx_billing_plan_programs_program_id
    ON billing_plan_programs(program_id);

CREATE INDEX IF NOT EXISTS idx_billing_refunds_payment_id
    ON billing_refunds(payment_id);

CREATE INDEX IF NOT EXISTS idx_billing_subscriptions_payer_id
    ON billing_subscriptions(payer_id);

CREATE INDEX IF NOT EXISTS idx_student_billing_enrollments_billing_plan_id
    ON student_billing_enrollments(billing_plan_id);
CREATE INDEX IF NOT EXISTS idx_student_billing_enrollments_billing_subscription_id
    ON student_billing_enrollments(billing_subscription_id);
CREATE INDEX IF NOT EXISTS idx_student_billing_enrollments_payer_id
    ON student_billing_enrollments(payer_id);
CREATE INDEX IF NOT EXISTS idx_student_billing_enrollments_student_id
    ON student_billing_enrollments(student_id);
