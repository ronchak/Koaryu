-- Stripe webhook events are backend-only operational records.
-- RLS already denied client rows implicitly; make that denial explicit and remove client grants.

ALTER TABLE stripe_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE stripe_events FROM anon, authenticated;

DROP POLICY IF EXISTS "stripe_events_no_client_access" ON stripe_events;
CREATE POLICY "stripe_events_no_client_access" ON stripe_events
    AS RESTRICTIVE
    FOR ALL
    TO anon, authenticated
    USING (false)
    WITH CHECK (false);
