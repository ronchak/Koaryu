TABLES = ("auth.users", "public.studios", "public.staff_roles", "public.studio_payment_accounts",
          "public.billing_payers", "public.billing_invoices", "public.billing_invoice_mutation_owners",
          "public.billing_provider_operations", "public.billing_provider_operation_resources",
          "public.billing_provider_operation_resource_aliases")
SEED_SQL = """
BEGIN;
DO $seed$
DECLARE actor UUID := gen_random_uuid(); studio UUID := gen_random_uuid(); payer UUID := gen_random_uuid();
    finalized UUID := gen_random_uuid(); voiding UUID := gen_random_uuid(); claim JSONB;
BEGIN
    INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES(actor,'authenticated','authenticated',actor||'@example.invalid','{}','{}',now(),now());
    INSERT INTO public.studios(id,name,slug,owner_id) VALUES(studio,'Closeout restore',studio::TEXT,actor);
    INSERT INTO public.staff_roles(studio_id,user_id,role) VALUES(studio,actor,'admin');
    INSERT INTO public.studio_payment_accounts(studio_id,stripe_connected_account_id,metadata)
    VALUES(studio,'acct_v51restore',jsonb_build_object('connect_account_generation',1));
    INSERT INTO public.billing_payers(id,studio_id,display_name,stripe_account_id,stripe_customer_id,connect_account_generation)
    VALUES(payer,studio,'Closeout payer','acct_v51restore','cus_v51restore',1);
    INSERT INTO public.billing_invoices(id,studio_id,payer_id,invoice_type,status,amount_due_cents,amount_paid_cents,
        amount_remaining_cents,currency,stripe_invoice_id,stripe_account_id,stripe_customer_id,collection_method,metadata) VALUES
        (finalized,studio,payer,'manual','draft',500,0,500,'usd','in_'||replace(finalized::TEXT,'-',''),
         'acct_v51restore','cus_v51restore','send_invoice',jsonb_build_object('connect_account_generation',1)),
        (voiding,studio,payer,'manual','open',700,0,700,'usd','in_'||replace(voiding::TEXT,'-',''),
         'acct_v51restore','cus_v51restore','send_invoice',jsonb_build_object('connect_account_generation',1));
    claim := public.claim_billing_invoice_closeout_operation_v1(studio,actor,'invoice.finalize','invoice_finalize',
        finalized,payer,'restore-finalize',repeat('e',64),'acct_v51restore',1,gen_random_uuid(),30);
    UPDATE public.billing_provider_operations SET state='completed',provider_request_attempt_count=1,
        provider_object_id='in_'||replace(finalized::TEXT,'-',''),provider_succeeded_at=clock_timestamp(),
        projected_at=clock_timestamp(),completed_at=clock_timestamp(),result_code='invoice_closeout_completed',
        lease_owner=NULL,lease_acquired_at=NULL,lease_expires_at=NULL,revision=revision+1
    WHERE id=(claim->'operation'->>'id')::UUID;
    UPDATE public.billing_invoices SET status='open' WHERE id=finalized;
    PERFORM public.claim_billing_invoice_closeout_operation_v1(studio,actor,'invoice.void','invoice_void',
        voiding,payer,'restore-void',repeat('f',64),'acct_v51restore',1,gen_random_uuid(),30);
END;
$seed$;
SELECT 'seeded';
COMMIT;
"""
