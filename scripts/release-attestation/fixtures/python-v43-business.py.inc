STUDIO = "43000000-0000-4000-8000-000000000001"
ACTOR = "43000000-0000-4000-8000-000000000002"
RETRY_ACTOR = "43000000-0000-4000-8000-000000000003"
PAYER = "43000000-0000-4000-8000-000000000004"
LEGACY = "43000000-0000-4000-8000-000000000005"
LEGACY_REQUEST_HASH = "6346248088a49ef4aa12f1442d2b8eb0a48cfa8e7c34966fcd3a58dac16f7d77"
NEW_REQUEST_HASH = "9fd38e75c5c0cb553c42ffd2bac77bb228fb214eade39ee3493e2409502c6f81"
TABLES = ("auth.users", "public.staff_profiles", "public.studios", "public.staff_roles",
          "public.billing_payers", "public.billing_invoices", "public.billing_payments", "public.audit_logs")
SEED_SQL = f"""
BEGIN;
INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
VALUES('{ACTOR}','authenticated','authenticated','external-owner@example.invalid','{{}}','{{}}',now(),now()),
      ('{RETRY_ACTOR}','authenticated','authenticated','external-retry@example.invalid','{{}}','{{}}',now(),now());
INSERT INTO public.studios(id,name,slug,owner_id)
VALUES('{STUDIO}','External payment restore','external-payment-restore','{ACTOR}');
INSERT INTO public.staff_roles(studio_id,user_id,role)
VALUES('{STUDIO}','{ACTOR}','admin'),('{STUDIO}','{RETRY_ACTOR}','front_desk');
INSERT INTO public.billing_payers(id,studio_id,display_name,balance_cents,billing_status)
VALUES('{PAYER}','{STUDIO}','Retained payer',777,'past_due');
INSERT INTO public.billing_invoices(studio_id,payer_id,status,amount_due_cents,amount_remaining_cents,currency,external)
VALUES('{STUDIO}','{PAYER}','open',1000,1000,'usd',true);
INSERT INTO public.billing_payments(id,studio_id,payer_id,status,amount_cents,currency,payment_method_type,
 external_method,note,idempotency_key,request_hash,processed_at,net_collected_amount_cents,refundable_amount_cents)
VALUES('{LEGACY}','{STUDIO}','{PAYER}','externally_recorded',500,'eur','external','cash','Legacy note',
 'legacy-external','{LEGACY_REQUEST_HASH}','2026-09-01T00:00:00Z',500,0);
SELECT 'seeded';
COMMIT;
"""
