-- ==========================================
-- Koaryu v1 — Lock down belt ladder sync RPC
-- ==========================================
--
-- Belt ladder sync is called by the service-role backend after tenant and role
-- checks. Older grants left the RPC directly executable by browser-facing
-- roles, which is unnecessary and weakens the backend authorization boundary.

REVOKE ALL ON FUNCTION public.sync_belt_ladder_ranks(UUID, UUID, TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sync_belt_ladder_ranks(UUID, UUID, TEXT, JSONB) FROM anon;
REVOKE ALL ON FUNCTION public.sync_belt_ladder_ranks(UUID, UUID, TEXT, JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.sync_belt_ladder_ranks(UUID, UUID, TEXT, JSONB) TO service_role;
