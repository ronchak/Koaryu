STUDIO = "00000000-0000-4000-8000-000000041002"
ACTOR = "00000000-0000-4000-8000-000000041001"
PAYER = "00000000-0000-4000-8000-000000041003"
INVOICE = "00000000-0000-4000-8000-000000041005"
TABLES = (
    "auth.users", "public.staff_profiles", "private.stripe_connect_account_identity_guards",
    "public.studios", "public.staff_roles", "public.studio_payment_accounts",
    "public.billing_payers", "public.billing_invoices", "public.billing_invoice_items",
    "public.audit_logs", "public.billing_provider_operations",
    "public.billing_provider_operation_resources", "public.billing_provider_operation_resource_aliases",
    "private.billing_invoice_retry_hash_ledger_v33",
)
SEMANTICS = (
    "koaryu_release_critical_surface_manifest_v16", "koaryu_release_critical_surface_manifest_v17",
    "koaryu_release_critical_surface_manifest_v18", "koaryu_release_operational_manifest_v10",
    "koaryu_release_operational_manifest_v11", "koaryu_release_resource_ownership_manifest_v31",
    "koaryu_release_operational_contract_v31", "koaryu_release_operational_manifest_v12",
    "koaryu_release_student_rank_writer_manifest_v11", "koaryu_release_student_rank_writer_manifest_v13",
)
SEED_SQL = r"""
BEGIN;
INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
VALUES('00000000-0000-4000-8000-000000041001','authenticated','authenticated','balance-restore@example.invalid','{}','{}',now(),now());
INSERT INTO public.studios(id,name,slug,owner_id)
VALUES('00000000-0000-4000-8000-000000041002','Balance restore fixture','balance-restore-fixture','00000000-0000-4000-8000-000000041001');
INSERT INTO public.staff_roles(studio_id,user_id,role)
VALUES('00000000-0000-4000-8000-000000041002','00000000-0000-4000-8000-000000041001','admin');
INSERT INTO public.studio_payment_accounts(studio_id,stripe_connected_account_id,metadata)
VALUES('00000000-0000-4000-8000-000000041002','acct_balancerestore','{"connect_account_generation":1}');
INSERT INTO public.billing_payers(id,studio_id,display_name,stripe_account_id,stripe_customer_id,connect_account_generation,balance_cents,billing_status)
VALUES('00000000-0000-4000-8000-000000041003','00000000-0000-4000-8000-000000041002','Retained payer','acct_balancerestore','cus_balancerestore',1,777,'failed'),
      ('00000000-0000-4000-8000-000000041004','00000000-0000-4000-8000-000000041002','Untouched payer',NULL,NULL,NULL,888,'failed');
INSERT INTO public.billing_invoices(id,studio_id,payer_id,stripe_invoice_id,stripe_account_id,stripe_customer_id,status,amount_due_cents,amount_remaining_cents,collection_method,metadata)
VALUES('00000000-0000-4000-8000-000000041005','00000000-0000-4000-8000-000000041002','00000000-0000-4000-8000-000000041003','in_balancerestore','acct_balancerestore','cus_balancerestore','open',100,100,'send_invoice','{"connect_account_generation":1}'),
      ('00000000-0000-4000-8000-000000041006','00000000-0000-4000-8000-000000041002','00000000-0000-4000-8000-000000041003',NULL,NULL,NULL,'open',300,300,NULL,'{}');
DO $receipt$
DECLARE
    studio UUID := '00000000-0000-4000-8000-000000041002';
    actor UUID := '00000000-0000-4000-8000-000000041001';
    payer UUID := '00000000-0000-4000-8000-000000041003';
    invoice UUID := '00000000-0000-4000-8000-000000041005';
    lease UUID := gen_random_uuid();
    request_hash TEXT;
    operation JSONB;
BEGIN
    request_hash:=private.billing_invoice_retry_base_hash_v33(studio,invoice,'in_balancerestore','acct_balancerestore',1);
    SET LOCAL ROLE service_role;
    IF current_user <> 'service_role' THEN RAISE EXCEPTION 'Receipt fixture requires service_role'; END IF;
    operation:=public.claim_billing_provider_operation_resource_v1(studio,actor,'invoice.retry','invoice',invoice,payer,
        'balance-restore-retry',request_hash,'acct_balancerestore',1,lease,30)->'operation';
    operation:=public.transition_billing_provider_operation_v1(
        p_operation_id=>(operation->>'id')::UUID,p_studio_id=>studio,p_actor_id=>actor,p_operation_type=>'invoice.retry',
        p_caller_request_key=>'balance-restore-retry',p_request_sha256=>request_hash,
        p_stripe_connected_account_id=>'acct_balancerestore',p_connect_account_generation=>1,p_lease_owner=>lease,
        p_expected_revision=>(operation->>'revision')::BIGINT,p_to_state=>'provider_request_in_flight',
        p_result_code=>'invoice_retry_started',p_result_summary=>'invoice_retry_mode:pay')->'operation';
    operation:=public.transition_billing_provider_operation_v1(
        p_operation_id=>(operation->>'id')::UUID,p_studio_id=>studio,p_actor_id=>actor,p_operation_type=>'invoice.retry',
        p_caller_request_key=>'balance-restore-retry',p_request_sha256=>request_hash,
        p_stripe_connected_account_id=>'acct_balancerestore',p_connect_account_generation=>1,p_lease_owner=>lease,
        p_expected_revision=>(operation->>'revision')::BIGINT,p_to_state=>'provider_succeeded',
        p_provider_object_id=>'in_balancerestore',p_result_code=>'invoice_retry_provider_paid')->'operation';
    UPDATE public.billing_invoices SET status='paid',amount_paid_cents=100,amount_remaining_cents=0 WHERE id=invoice;
    operation:=public.transition_billing_provider_operation_v1(
        p_operation_id=>(operation->>'id')::UUID,p_studio_id=>studio,p_actor_id=>actor,p_operation_type=>'invoice.retry',
        p_caller_request_key=>'balance-restore-retry',p_request_sha256=>request_hash,
        p_stripe_connected_account_id=>'acct_balancerestore',p_connect_account_generation=>1,p_lease_owner=>lease,
        p_expected_revision=>(operation->>'revision')::BIGINT,p_to_state=>'projected',
        p_result_code=>'invoice_retry_projected',p_result_summary=>'invoice_retry_mode:pay')->'operation';
    operation:=public.complete_billing_provider_operation_v1(
        p_operation_id=>(operation->>'id')::UUID,p_studio_id=>studio,p_actor_id=>actor,p_operation_type=>'invoice.retry',
        p_caller_request_key=>'balance-restore-retry',p_request_sha256=>request_hash,
        p_stripe_connected_account_id=>'acct_balancerestore',p_connect_account_generation=>1,p_lease_owner=>lease,
        p_expected_revision=>(operation->>'revision')::BIGINT,p_result_code=>'invoice_retry_completed')->'operation';
    IF operation->>'state' IS DISTINCT FROM 'completed' THEN RAISE EXCEPTION 'Retained receipt is not completed'; END IF;
    PERFORM set_config('balance_restore.operation',operation->>'id',true);
    PERFORM set_config('balance_restore.hash',request_hash,true);
    RESET ROLE;
END;
$receipt$;
SELECT jsonb_build_object('operation_id',current_setting('balance_restore.operation'),'request_hash',current_setting('balance_restore.hash'));
COMMIT;
"""
