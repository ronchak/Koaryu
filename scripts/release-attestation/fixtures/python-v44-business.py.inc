STUDIO = "44000000-0000-4000-8000-000000000001"
ACTOR = "44000000-0000-4000-8000-000000000002"
PROGRAM = "44000000-0000-4000-8000-000000000003"
PLAN = "44000000-0000-4000-8000-000000000004"
LEGACY_PLAN = "44000000-0000-4000-8000-000000000005"
CLEAR_STUDIO = "44000000-0000-4000-8000-000000000006"
CLEAR_PROGRAM = "44000000-0000-4000-8000-000000000007"
CLEAR_ACTOR = "44000000-0000-4000-8000-000000000008"
TABLES = ("auth.users", "public.staff_profiles", "public.studios", "public.staff_roles",
          "public.programs", "public.billing_plans", "public.billing_plan_programs",
          "public.billing_plan_prices", "public.studio_payment_accounts", "public.audit_logs",
          "public.billing_payers", "public.billing_invoices", "public.billing_payments")
SEED_SQL = f"""
BEGIN;
INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
VALUES('{ACTOR}','authenticated','authenticated','plan-restore@example.invalid','{{}}','{{}}',now(),now()),
      ('{CLEAR_ACTOR}','authenticated','authenticated','clear-restore@example.invalid','{{}}','{{}}',now(),now());
INSERT INTO public.studios(id,name,slug,owner_id)
VALUES('{STUDIO}','Local plan restore','local-plan-restore','{ACTOR}'),
      ('{CLEAR_STUDIO}','Local clear restore','local-clear-restore','{CLEAR_ACTOR}');
INSERT INTO public.staff_roles(studio_id,user_id,role)
VALUES('{STUDIO}','{ACTOR}','admin'),('{CLEAR_STUDIO}','{CLEAR_ACTOR}','admin');
INSERT INTO public.programs(id,studio_id,name,color_hex,sort_order)
VALUES('{PROGRAM}','{STUDIO}','Karate','#123456',0),('{CLEAR_PROGRAM}','{CLEAR_STUDIO}','Demo karate','#abcdef',0);
INSERT INTO public.billing_plans(id,studio_id,name,description,amount_cents,currency,status,
 stripe_account_id,stripe_product_id,stripe_price_id,stripe_price_version,metadata,updated_at)
VALUES('{PLAN}','{STUDIO}','Active USD','Keep description',1000,'usd','active',
 'acct_restore','prod_restore','price_restore',3,'{{"keep":"provider facts"}}','2000-01-01T00:00:00Z'),
 ('{LEGACY_PLAN}','{STUDIO}','Legacy EUR','Historical facts',500,'EUR','active',
 'acct_restore','prod_legacy','price_legacy',1,'{{}}','2000-01-01T00:00:00Z');
INSERT INTO public.billing_plan_programs(studio_id,billing_plan_id,program_id)
VALUES('{STUDIO}','{PLAN}','{PROGRAM}');
INSERT INTO public.billing_plan_prices(studio_id,billing_plan_id,stripe_account_id,stripe_product_id,
 stripe_price_id,amount_cents,currency,billing_interval,version)
VALUES('{STUDIO}','{PLAN}','acct_restore','prod_restore','price_restore',1000,'usd','monthly',3);
INSERT INTO public.studio_payment_accounts(studio_id) VALUES('{CLEAR_STUDIO}');
SELECT 'seeded';
COMMIT;
"""
