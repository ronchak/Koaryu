-- ==========================================
-- Koaryu v1 — Migration 026
-- Harden function search paths and private RLS helpers
-- ==========================================

-- Pin search_path for trigger and validation functions reported by the
-- Supabase database linter. These functions intentionally use public tables.
ALTER FUNCTION public.update_updated_at_column()
    SET search_path = pg_catalog;

ALTER FUNCTION public.validate_student_program_membership()
    SET search_path = pg_catalog, public;

ALTER FUNCTION public.validate_lead_program_integrity()
    SET search_path = pg_catalog, public;

ALTER FUNCTION public.validate_class_template_program_integrity()
    SET search_path = pg_catalog, public;

ALTER FUNCTION public.validate_class_session_program_integrity()
    SET search_path = pg_catalog, public;

ALTER FUNCTION public.validate_attendance_program_integrity()
    SET search_path = pg_catalog, public;

ALTER FUNCTION public.validate_billing_plan_program()
    SET search_path = pg_catalog, public;

ALTER FUNCTION public.validate_student_billing_enrollment()
    SET search_path = pg_catalog, public;

ALTER FUNCTION public.validate_billing_payer_guardian()
    SET search_path = pg_catalog, public;

ALTER FUNCTION public.validate_billing_invoice_refs()
    SET search_path = pg_catalog, public;

ALTER FUNCTION public.validate_billing_invoice_item_refs()
    SET search_path = pg_catalog, public;

ALTER FUNCTION public.validate_billing_payment_refs()
    SET search_path = pg_catalog, public;

ALTER FUNCTION public.validate_billing_refund_refs()
    SET search_path = pg_catalog, public;

ALTER FUNCTION public.validate_billing_dispute_refs()
    SET search_path = pg_catalog, public;

ALTER FUNCTION public.validate_billing_adjustment_refs()
    SET search_path = pg_catalog, public;

-- Security-definer RLS helpers should not live in an exposed API schema.
-- Keep them callable from policies with explicit schema qualification.
CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC;
GRANT USAGE ON SCHEMA private TO authenticated, service_role;

CREATE OR REPLACE FUNCTION private.is_staff_in_studio(target_studio_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.staff_roles AS sr
        WHERE sr.studio_id = target_studio_id
          AND sr.user_id = auth.uid()
    );
$$;

CREATE OR REPLACE FUNCTION private.is_admin_or_front_desk_in_studio(target_studio_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.staff_roles AS sr
        WHERE sr.studio_id = target_studio_id
          AND sr.user_id = auth.uid()
          AND sr.role IN ('admin', 'front_desk')
    );
$$;

CREATE OR REPLACE FUNCTION private.is_admin_in_studio(target_studio_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.staff_roles AS sr
        WHERE sr.studio_id = target_studio_id
          AND sr.user_id = auth.uid()
          AND sr.role = 'admin'
    );
$$;

REVOKE EXECUTE ON FUNCTION private.is_staff_in_studio(UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION private.is_admin_or_front_desk_in_studio(UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION private.is_admin_in_studio(UUID) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION private.is_staff_in_studio(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.is_admin_or_front_desk_in_studio(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.is_admin_in_studio(UUID) TO authenticated, service_role;

DROP POLICY IF EXISTS "studio_subscriptions_admin_select" ON public.studio_subscriptions;
CREATE POLICY "studio_subscriptions_admin_select" ON public.studio_subscriptions
    FOR SELECT TO authenticated
    USING (private.is_admin_in_studio(studio_id));

DROP POLICY IF EXISTS "studio_payment_accounts_admin_select" ON public.studio_payment_accounts;
CREATE POLICY "studio_payment_accounts_admin_select" ON public.studio_payment_accounts
    FOR SELECT TO authenticated
    USING (private.is_admin_in_studio(studio_id));

DROP POLICY IF EXISTS "email_usage_events_admin_select" ON public.email_usage_events;
CREATE POLICY "email_usage_events_admin_select" ON public.email_usage_events
    FOR SELECT TO authenticated
    USING (private.is_admin_in_studio(studio_id));

DROP POLICY IF EXISTS "billing_payers_manager_select" ON public.billing_payers;
CREATE POLICY "billing_payers_manager_select" ON public.billing_payers
    FOR SELECT TO authenticated
    USING (private.is_admin_or_front_desk_in_studio(studio_id));

DROP POLICY IF EXISTS "billing_plans_manager_select" ON public.billing_plans;
CREATE POLICY "billing_plans_manager_select" ON public.billing_plans
    FOR SELECT TO authenticated
    USING (private.is_admin_or_front_desk_in_studio(studio_id));

DROP POLICY IF EXISTS "billing_plan_programs_manager_select" ON public.billing_plan_programs;
CREATE POLICY "billing_plan_programs_manager_select" ON public.billing_plan_programs
    FOR SELECT TO authenticated
    USING (private.is_admin_or_front_desk_in_studio(studio_id));

DROP POLICY IF EXISTS "student_billing_enrollments_manager_select" ON public.student_billing_enrollments;
CREATE POLICY "student_billing_enrollments_manager_select" ON public.student_billing_enrollments
    FOR SELECT TO authenticated
    USING (private.is_admin_or_front_desk_in_studio(studio_id));

DROP POLICY IF EXISTS "billing_invoices_manager_select" ON public.billing_invoices;
CREATE POLICY "billing_invoices_manager_select" ON public.billing_invoices
    FOR SELECT TO authenticated
    USING (private.is_admin_or_front_desk_in_studio(studio_id));

DROP POLICY IF EXISTS "billing_invoice_items_manager_select" ON public.billing_invoice_items;
CREATE POLICY "billing_invoice_items_manager_select" ON public.billing_invoice_items
    FOR SELECT TO authenticated
    USING (private.is_admin_or_front_desk_in_studio(studio_id));

DROP POLICY IF EXISTS "billing_payments_manager_select" ON public.billing_payments;
CREATE POLICY "billing_payments_manager_select" ON public.billing_payments
    FOR SELECT TO authenticated
    USING (private.is_admin_or_front_desk_in_studio(studio_id));

DROP POLICY IF EXISTS "billing_refunds_manager_select" ON public.billing_refunds;
CREATE POLICY "billing_refunds_manager_select" ON public.billing_refunds
    FOR SELECT TO authenticated
    USING (private.is_admin_or_front_desk_in_studio(studio_id));

DROP POLICY IF EXISTS "billing_disputes_manager_select" ON public.billing_disputes;
CREATE POLICY "billing_disputes_manager_select" ON public.billing_disputes
    FOR SELECT TO authenticated
    USING (private.is_admin_or_front_desk_in_studio(studio_id));

DROP POLICY IF EXISTS "billing_adjustments_manager_select" ON public.billing_adjustments;
CREATE POLICY "billing_adjustments_manager_select" ON public.billing_adjustments
    FOR SELECT TO authenticated
    USING (private.is_admin_or_front_desk_in_studio(studio_id));

DROP POLICY IF EXISTS "export_jobs_manager_select" ON public.export_jobs;
CREATE POLICY "export_jobs_manager_select" ON public.export_jobs
    FOR SELECT TO authenticated
    USING (private.is_admin_or_front_desk_in_studio(studio_id));

DROP FUNCTION IF EXISTS public.is_staff_in_studio(UUID);
DROP FUNCTION IF EXISTS public.is_admin_or_front_desk_in_studio(UUID);
DROP FUNCTION IF EXISTS public.is_admin_in_studio(UUID);

NOTIFY pgrst, 'reload schema';
