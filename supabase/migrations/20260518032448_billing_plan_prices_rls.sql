-- Tenant-scope Stripe price mappings. Application writes use the service-role
-- backend; direct client access is read-only for billing managers.

ALTER TABLE billing_plan_prices ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "billing_plan_prices_manager_select" ON billing_plan_prices;
CREATE POLICY "billing_plan_prices_manager_select" ON billing_plan_prices
    FOR SELECT
    USING (private.is_admin_or_front_desk_in_studio(studio_id));
