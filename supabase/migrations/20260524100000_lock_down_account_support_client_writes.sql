-- ==========================================
-- Koaryu v1 - Lock down account/support client writes
-- ==========================================
--
-- Account deletion and support-ticket writes are operational workflows owned by
-- the service-role backend. Browser-facing roles keep the existing SELECT
-- contract through RLS, but must not be able to mutate rows or worker claim
-- fields directly through the Supabase Data API.

REVOKE INSERT, UPDATE, DELETE ON TABLE
    public.account_deletion_requests,
    public.support_tickets,
    public.support_ticket_events
FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
    public.account_deletion_requests,
    public.support_tickets,
    public.support_ticket_events
TO service_role;
