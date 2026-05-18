-- Prevent older Stripe events from overwriting newer projected state.

ALTER TABLE billing_invoices
    ADD COLUMN IF NOT EXISTS last_stripe_event_created BIGINT;

ALTER TABLE billing_subscriptions
    ADD COLUMN IF NOT EXISTS last_stripe_event_created BIGINT;
