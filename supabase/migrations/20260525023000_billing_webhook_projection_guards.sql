-- Track Stripe event ordering on mutable Connect billing projections.

ALTER TABLE billing_payments
    ADD COLUMN IF NOT EXISTS last_stripe_event_created BIGINT;

ALTER TABLE studio_payment_accounts
    ADD COLUMN IF NOT EXISTS last_stripe_event_created BIGINT;
