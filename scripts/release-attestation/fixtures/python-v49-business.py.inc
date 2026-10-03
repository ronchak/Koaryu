TABLES = ("auth.users", "public.staff_profiles", "public.studios", "public.staff_roles",
          "public.studio_payment_accounts", "public.billing_payers", "public.billing_subscriptions",
          "public.students", "public.billing_plans", "public.billing_invoices", "public.billing_payments", "public.audit_logs")
SEED_SQL = """
BEGIN;
DO $seed$
DECLARE actor UUID:=gen_random_uuid(); studio UUID:=gen_random_uuid(); payer UUID:=gen_random_uuid();
BEGIN
    INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES(actor,'authenticated','authenticated',actor||'@example.invalid','{}','{}',now(),now());
    INSERT INTO public.studios(id,name,slug,owner_id) VALUES(studio,'Known terms',studio::TEXT,actor);
    INSERT INTO public.staff_roles(studio_id,user_id,role) VALUES(studio,actor,'admin');
    INSERT INTO public.studio_payment_accounts(studio_id,stripe_connected_account_id,status,charges_enabled,payouts_enabled,metadata)
    VALUES(studio,'acct_RestoreTerms49','charges_enabled',TRUE,TRUE,'{"connect_account_generation":1}');
    INSERT INTO public.billing_payers(id,studio_id,display_name,stripe_account_id,stripe_customer_id,connect_account_generation)
    VALUES(payer,studio,'Legacy confirmed payer','acct_RestoreTerms49','cus_RestoreTerms49',1);
    INSERT INTO public.billing_subscriptions(studio_id,payer_id,stripe_account_id,stripe_customer_id,stripe_subscription_id,
        collection_mode,billing_interval,currency,status)
    VALUES(studio,payer,'acct_RestoreTerms49','cus_RestoreTerms49','sub_RestoreTerms49','invoice_link','annual','cad','active');
END;
$seed$;
SELECT 'seeded';
COMMIT;
"""
