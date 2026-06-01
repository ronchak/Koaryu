-- ==========================================
-- Koaryu v1 - Lock down Stripe event PUBLIC grants
-- ==========================================
--
-- Stripe webhook events are backend-only operational records. The earlier
-- denial migration revoked browser roles directly; this forward migration also
-- removes any inherited PUBLIC table privileges for consistency with the newer
-- operational-table lockdown migrations.

REVOKE ALL ON TABLE public.stripe_events
FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.stripe_events
TO service_role;
