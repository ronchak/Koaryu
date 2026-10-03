TABLES = ("auth.users", "public.staff_profiles", "public.studios", "public.staff_roles",
          "public.studio_payment_accounts", "public.billing_payers", "public.billing_payments",
          "public.billing_refunds", "public.billing_provider_operations",
          "public.billing_provider_operation_resources", "public.billing_provider_operation_resource_aliases",
          "public.students", "public.billing_invoices", "public.audit_logs")
SEED_SQL = """
BEGIN;
DO $proof$
DECLARE
  actor UUID:=gen_random_uuid(); studio UUID:=gen_random_uuid(); payer UUID:=gen_random_uuid();
  payment UUID:=gen_random_uuid(); lease UUID:=gen_random_uuid(); operation JSONB; claim JSONB; state TEXT;
BEGIN
  INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
  VALUES(actor,'authenticated','authenticated',actor||'@example.invalid','{}','{}',now(),now());
  INSERT INTO public.studios(id,name,slug,owner_id) VALUES(studio,'Refund recovery',studio::TEXT,actor);
  INSERT INTO public.staff_roles(studio_id,user_id,role) VALUES(studio,actor,'admin');
  INSERT INTO public.studio_payment_accounts(studio_id,stripe_connected_account_id,charges_enabled,payouts_enabled,metadata)
  VALUES(studio,'acct_refundproof',true,true,'{"connect_account_generation":1}');
  INSERT INTO public.billing_payers(id,studio_id,display_name,stripe_account_id,stripe_customer_id,connect_account_generation)
  VALUES(payer,studio,'Refund payer','acct_refundproof','cus_refundproof',1);
  INSERT INTO public.billing_payments(id,studio_id,payer_id,stripe_customer_id,stripe_payment_intent_id,stripe_charge_id,
    stripe_account_id,connect_account_generation,status,amount_cents,currency,net_collected_amount_cents,refundable_amount_cents,processed_at)
  VALUES(payment,studio,payer,'cus_refundproof','pi_refundproof','ch_refundproof','acct_refundproof',1,'succeeded',1000,'usd',1000,1000,now());
  claim:=public.claim_billing_provider_operation_resource_v1(studio,actor,'payment.refund','payment',payment,payer,
    'refund-proof',repeat('a',64),'acct_refundproof',1,lease,30);
  operation:=claim->'operation';
  FOREACH state IN ARRAY ARRAY['provider_request_in_flight','provider_succeeded','projected'] LOOP
    IF state='projected' THEN
      INSERT INTO public.billing_refunds(studio_id,payment_id,stripe_refund_id,stripe_charge_id,stripe_payment_intent_id,
        stripe_account_id,connect_account_generation,amount_cents,status)
      VALUES(studio,payment,'re_refundproof','ch_refundproof','pi_refundproof','acct_refundproof',1,500,'succeeded');
    END IF;
    operation:=public.transition_billing_provider_operation_v1((operation->>'id')::UUID,studio,actor,'payment.refund',
      'refund-proof',repeat('a',64),'acct_refundproof',1,lease,(operation->>'revision')::BIGINT,state,
      p_provider_object_id=>CASE WHEN state<>'provider_request_in_flight' THEN 're_refundproof' END,
      p_result_code=>CASE state WHEN 'provider_request_in_flight' THEN 'payment_refund_started'
        WHEN 'provider_succeeded' THEN 'payment_refund_status_succeeded' ELSE 'payment_refund_projected' END,
      p_result_summary=>'amount_cents:500')->'operation';
  END LOOP;
  BEGIN
    PERFORM public.complete_billing_provider_operation_v1((operation->>'id')::UUID,studio,actor,'payment.refund',
      'refund-proof',repeat('a',64),'acct_refundproof',1,lease,(operation->>'revision')::BIGINT,'payment_refund_completed');
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='injected_before_commit';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM<>'injected_before_commit' THEN RAISE; END IF;
  END;
  IF (SELECT refunded_amount_cents FROM public.billing_payments WHERE id=payment) IS DISTINCT FROM 500
     OR (SELECT billing_provider_operations.state FROM public.billing_provider_operations WHERE id=(operation->>'id')::UUID) IS DISTINCT FROM 'projected' THEN
    RAISE EXCEPTION 'Completion failure did not preserve the projected refund.';
  END IF;
END;
$proof$;
SELECT 'seeded';
COMMIT;
"""
