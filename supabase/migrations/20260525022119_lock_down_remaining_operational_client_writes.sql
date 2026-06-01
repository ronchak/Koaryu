-- ==========================================
-- Koaryu v1 - Lock down remaining direct operational client writes
-- ==========================================
--
-- The frontend now mutates application data through backend route handlers that
-- use the service role. Browser-facing Supabase roles keep their existing RLS
-- read contracts, but legacy direct write policies should not remain available
-- through the Data API for operational tables.

DROP POLICY IF EXISTS "studios_insert_auth" ON public.studios;
DROP POLICY IF EXISTS "studios_insert_owner" ON public.studios;
DROP POLICY IF EXISTS "studios_update_owner" ON public.studios;
DROP POLICY IF EXISTS "staff_roles_insert_auth" ON public.staff_roles;
DROP POLICY IF EXISTS "staff_roles_insert_owner" ON public.staff_roles;
DROP POLICY IF EXISTS "audit_logs_insert_auth" ON public.audit_logs;
DROP POLICY IF EXISTS "audit_logs_insert_member" ON public.audit_logs;

DROP POLICY IF EXISTS "guardians_insert" ON public.guardians;
DROP POLICY IF EXISTS "guardians_update" ON public.guardians;
DROP POLICY IF EXISTS "student_guardians_insert" ON public.student_guardians;
DROP POLICY IF EXISTS "student_guardians_update" ON public.student_guardians;
DROP POLICY IF EXISTS "student_guardians_delete" ON public.student_guardians;

DROP POLICY IF EXISTS "class_templates_insert" ON public.class_templates;
DROP POLICY IF EXISTS "class_templates_update" ON public.class_templates;
DROP POLICY IF EXISTS "class_sessions_insert" ON public.class_sessions;
DROP POLICY IF EXISTS "class_sessions_update" ON public.class_sessions;
DROP POLICY IF EXISTS "attendance_insert" ON public.attendance;
DROP POLICY IF EXISTS "attendance_update" ON public.attendance;
DROP POLICY IF EXISTS "attendance_delete" ON public.attendance;

DROP POLICY IF EXISTS "belt_ladders_insert" ON public.belt_ladders;
DROP POLICY IF EXISTS "belt_ladders_update" ON public.belt_ladders;
DROP POLICY IF EXISTS "belt_ranks_insert" ON public.belt_ranks;
DROP POLICY IF EXISTS "belt_ranks_update" ON public.belt_ranks;
DROP POLICY IF EXISTS "promotions_insert" ON public.promotions;
DROP POLICY IF EXISTS "promotions_update" ON public.promotions;
DROP POLICY IF EXISTS "promotions_delete" ON public.promotions;

DROP POLICY IF EXISTS "leads_insert" ON public.leads;
DROP POLICY IF EXISTS "leads_update" ON public.leads;
DROP POLICY IF EXISTS "lead_activities_insert" ON public.lead_activities;
DROP POLICY IF EXISTS "lead_activities_update" ON public.lead_activities;
DROP POLICY IF EXISTS "lead_activities_delete" ON public.lead_activities;

REVOKE INSERT, UPDATE, DELETE ON TABLE
    public.studios,
    public.staff_roles,
    public.audit_logs,
    public.guardians,
    public.student_guardians,
    public.class_templates,
    public.class_sessions,
    public.attendance,
    public.belt_ladders,
    public.belt_ranks,
    public.promotions,
    public.leads,
    public.lead_activities,
    public.studio_subscriptions,
    public.studio_payment_accounts,
    public.email_usage_events,
    public.billing_payers,
    public.billing_plans,
    public.billing_plan_programs,
    public.student_billing_enrollments,
    public.billing_invoices,
    public.billing_invoice_items,
    public.billing_payments,
    public.billing_refunds,
    public.billing_disputes,
    public.billing_adjustments,
    public.billing_plan_prices,
    public.billing_subscriptions,
    public.export_jobs
FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
    public.studios,
    public.staff_roles,
    public.audit_logs,
    public.guardians,
    public.student_guardians,
    public.class_templates,
    public.class_sessions,
    public.attendance,
    public.belt_ladders,
    public.belt_ranks,
    public.promotions,
    public.leads,
    public.lead_activities,
    public.studio_subscriptions,
    public.studio_payment_accounts,
    public.email_usage_events,
    public.billing_payers,
    public.billing_plans,
    public.billing_plan_programs,
    public.student_billing_enrollments,
    public.billing_invoices,
    public.billing_invoice_items,
    public.billing_payments,
    public.billing_refunds,
    public.billing_disputes,
    public.billing_adjustments,
    public.billing_plan_prices,
    public.billing_subscriptions,
    public.export_jobs
TO service_role;
