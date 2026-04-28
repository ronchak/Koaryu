-- Stripe subscriptions aggregate sibling enrollments on the same Price by
-- increasing a Subscription Item's quantity, so multiple enrollments may share
-- one stripe_subscription_item_id.

DROP INDEX IF EXISTS idx_student_billing_enrollments_stripe_item;

CREATE INDEX IF NOT EXISTS idx_student_billing_enrollments_stripe_item
    ON student_billing_enrollments(studio_id, stripe_subscription_item_id)
    WHERE stripe_subscription_item_id IS NOT NULL;
