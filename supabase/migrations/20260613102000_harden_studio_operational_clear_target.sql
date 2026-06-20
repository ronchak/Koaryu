-- ==========================================
-- Koaryu v1 - Harden atomic studio operational clear target
-- ==========================================

CREATE OR REPLACE FUNCTION public.clear_studio_operational_data_atomic(
    p_studio_id UUID,
    p_include_platform_rows BOOLEAN DEFAULT FALSE
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_student_ids UUID[];
    v_guardian_ids UUID[];
BEGIN
    IF p_studio_id IS NULL THEN
        RAISE EXCEPTION 'Studio operational clear requires a studio id.'
            USING ERRCODE = '22023';
    END IF;

    PERFORM 1
      FROM public.studios
     WHERE id = p_studio_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Studio not found for operational clear.'
            USING ERRCODE = 'P0001';
    END IF;

    SELECT COALESCE(array_agg(id), ARRAY[]::UUID[])
      INTO v_student_ids
      FROM public.students
     WHERE studio_id = p_studio_id;

    SELECT COALESCE(array_agg(id), ARRAY[]::UUID[])
      INTO v_guardian_ids
      FROM public.guardians
     WHERE studio_id = p_studio_id;

    IF to_regclass('public.billing_disputes') IS NOT NULL THEN
        DELETE FROM public.billing_disputes WHERE studio_id = p_studio_id;
    END IF;
    IF to_regclass('public.billing_refunds') IS NOT NULL THEN
        DELETE FROM public.billing_refunds WHERE studio_id = p_studio_id;
    END IF;
    IF to_regclass('public.billing_payments') IS NOT NULL THEN
        DELETE FROM public.billing_payments WHERE studio_id = p_studio_id;
    END IF;
    IF to_regclass('public.billing_invoice_items') IS NOT NULL THEN
        DELETE FROM public.billing_invoice_items WHERE studio_id = p_studio_id;
    END IF;
    IF to_regclass('public.billing_invoices') IS NOT NULL THEN
        DELETE FROM public.billing_invoices WHERE studio_id = p_studio_id;
    END IF;
    IF to_regclass('public.student_billing_enrollments') IS NOT NULL THEN
        DELETE FROM public.student_billing_enrollments WHERE studio_id = p_studio_id;
    END IF;
    IF to_regclass('public.billing_subscriptions') IS NOT NULL THEN
        DELETE FROM public.billing_subscriptions WHERE studio_id = p_studio_id;
    END IF;
    IF to_regclass('public.billing_plan_programs') IS NOT NULL THEN
        DELETE FROM public.billing_plan_programs WHERE studio_id = p_studio_id;
    END IF;
    IF to_regclass('public.billing_plan_prices') IS NOT NULL THEN
        DELETE FROM public.billing_plan_prices WHERE studio_id = p_studio_id;
    END IF;
    IF to_regclass('public.billing_plans') IS NOT NULL THEN
        DELETE FROM public.billing_plans WHERE studio_id = p_studio_id;
    END IF;
    IF to_regclass('public.billing_payers') IS NOT NULL THEN
        DELETE FROM public.billing_payers WHERE studio_id = p_studio_id;
    END IF;
    IF to_regclass('public.email_usage_events') IS NOT NULL THEN
        DELETE FROM public.email_usage_events WHERE studio_id = p_studio_id;
    END IF;
    IF to_regclass('public.export_jobs') IS NOT NULL THEN
        DELETE FROM public.export_jobs WHERE studio_id = p_studio_id;
    END IF;

    IF p_include_platform_rows THEN
        IF to_regclass('public.studio_payment_accounts') IS NOT NULL THEN
            DELETE FROM public.studio_payment_accounts WHERE studio_id = p_studio_id;
        END IF;
        IF to_regclass('public.studio_subscriptions') IS NOT NULL THEN
            DELETE FROM public.studio_subscriptions WHERE studio_id = p_studio_id;
        END IF;
    END IF;

    DELETE FROM public.attendance WHERE studio_id = p_studio_id;
    DELETE FROM public.promotions WHERE studio_id = p_studio_id;

    IF to_regclass('public.student_program_memberships') IS NOT NULL THEN
        DELETE FROM public.student_program_memberships WHERE studio_id = p_studio_id;
    END IF;

    DELETE FROM public.lead_activities WHERE studio_id = p_studio_id;
    DELETE FROM public.student_import_runs WHERE studio_id = p_studio_id;
    DELETE FROM public.leads WHERE studio_id = p_studio_id;

    IF cardinality(v_student_ids) > 0 THEN
        DELETE FROM public.student_guardians WHERE student_id = ANY(v_student_ids);
    END IF;
    IF cardinality(v_guardian_ids) > 0 THEN
        DELETE FROM public.student_guardians WHERE guardian_id = ANY(v_guardian_ids);
    END IF;

    DELETE FROM public.class_sessions WHERE studio_id = p_studio_id;
    DELETE FROM public.class_templates WHERE studio_id = p_studio_id;
    DELETE FROM public.students WHERE studio_id = p_studio_id;
    DELETE FROM public.guardians WHERE studio_id = p_studio_id;
    DELETE FROM public.belt_ranks WHERE studio_id = p_studio_id;
    DELETE FROM public.belt_ladders WHERE studio_id = p_studio_id;
    DELETE FROM public.programs WHERE studio_id = p_studio_id;
END;
$$;

REVOKE ALL ON FUNCTION public.clear_studio_operational_data_atomic(UUID, BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.clear_studio_operational_data_atomic(UUID, BOOLEAN) TO service_role;
