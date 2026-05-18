-- Harden billing against duplicate submissions and concurrent grouping races.

CREATE UNIQUE INDEX IF NOT EXISTS idx_student_billing_enrollments_one_live_assignment
    ON student_billing_enrollments(
        studio_id,
        student_id,
        billing_plan_id,
        COALESCE(payer_id, '00000000-0000-0000-0000-000000000000'::uuid),
        collection_mode
    )
    WHERE status IN ('pending', 'active');

CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_subscriptions_one_live_group
    ON billing_subscriptions(studio_id, payer_id, collection_mode, billing_interval, currency)
    WHERE status IN ('pending', 'trialing', 'active', 'incomplete', 'past_due');
