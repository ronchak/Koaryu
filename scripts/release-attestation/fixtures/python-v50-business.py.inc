TABLES = ("auth.users", "public.staff_profiles", "public.studios", "public.staff_roles",
          "public.billing_payers", "public.billing_invoices", "public.billing_payments", "public.audit_logs")
SEED_SQL = """
BEGIN;
DO $seed$
DECLARE actor UUID := gen_random_uuid(); studio UUID := gen_random_uuid();
    future_payer UUID := gen_random_uuid(); written_off_payer UUID := gen_random_uuid();
BEGIN
    INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES(actor,'authenticated','authenticated',actor||'@example.invalid','{}','{}',now(),now());
    INSERT INTO public.studios(id,name,slug,owner_id,timezone)
    VALUES(studio,'Due-date restore',studio::TEXT,actor,'UTC');
    INSERT INTO public.staff_roles(studio_id,user_id,role) VALUES(studio,actor,'admin');
    INSERT INTO public.billing_payers(id,studio_id,display_name,balance_cents,billing_status) VALUES
        (future_payer,studio,'Legacy future',100,'past_due'),
        (written_off_payer,studio,'Legacy uncollectible',200,'past_due');
    INSERT INTO public.billing_invoices(studio_id,payer_id,status,amount_due_cents,amount_remaining_cents,due_date,external) VALUES
        (studio,future_payer,'open',100,100,'2040-06-16',true),
        (studio,written_off_payer,'uncollectible',200,200,'2040-06-01',true);
END;
$seed$;
SELECT 'seeded';
COMMIT;
"""
