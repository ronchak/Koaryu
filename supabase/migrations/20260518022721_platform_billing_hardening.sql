-- Harden Koaryu Core billing projection against out-of-order Stripe events.

ALTER TABLE studio_subscriptions
    ADD COLUMN IF NOT EXISTS last_stripe_event_created BIGINT;
