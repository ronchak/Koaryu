-- A provider-confirmed refund can finish its original receipt after a completion rollback.
BEGIN;
DO $proof$
DECLARE
  actor UUID:=gen_random_uuid(); studio UUID:=gen_random_uuid(); payer UUID:=gen_random_uuid();
  payment UUID:=gen_random_uuid(); lease UUID:=gen_random_uuid(); operation JSONB; claim JSONB; state TEXT; original_version TEXT; rejected BOOLEAN; invalid RECORD; error_state TEXT;
  account TEXT:='acct_'||replace(studio::TEXT,'-','');
  rival UUID:=gen_random_uuid(); other_actor UUID:=gen_random_uuid();
BEGIN
  INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
  VALUES(actor,'authenticated','authenticated',actor||'@example.invalid','{}','{}',now(),now());
  INSERT INTO public.studios(id,name,slug,owner_id) VALUES(studio,'Refund recovery',studio::TEXT,actor);
  INSERT INTO public.staff_roles(studio_id,user_id,role) VALUES(studio,actor,'admin');
  INSERT INTO public.studio_payment_accounts(studio_id,stripe_connected_account_id,charges_enabled,payouts_enabled,metadata)
  VALUES(studio,account,true,true,'{"connect_account_generation":1}');
  INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
  VALUES(other_actor,'authenticated','authenticated',other_actor||'@example.invalid','{}','{}',now(),now());
  INSERT INTO public.staff_roles(studio_id,user_id,role) VALUES(studio,other_actor,'admin');
  INSERT INTO public.billing_payers(id,studio_id,display_name,stripe_account_id,stripe_customer_id,connect_account_generation)
  VALUES(payer,studio,'Refund payer',account,'cus_refundproof',1);
  INSERT INTO public.billing_payments(id,studio_id,payer_id,stripe_customer_id,stripe_payment_intent_id,stripe_charge_id,
    stripe_account_id,connect_account_generation,status,amount_cents,currency,net_collected_amount_cents,refundable_amount_cents,processed_at)
  VALUES(payment,studio,payer,'cus_refundproof','pi_refundproof','ch_refundproof',account,1,'succeeded',1000,'usd',1000,1000,now());
  claim:=public.claim_billing_provider_operation_resource_v1(studio,actor,'payment.refund','payment',payment,payer,
    'refund-proof',repeat('a',64),account,1,lease,30);
  operation:=claim->'operation';
  SELECT resource_version_sha256 INTO original_version FROM public.billing_provider_operation_resources
  WHERE id=(claim->'resource'->>'id')::UUID;
  IF original_version IS NULL THEN RAISE EXCEPTION 'The original claim has no resource version.'; END IF;
  FOREACH state IN ARRAY ARRAY['provider_request_in_flight','provider_succeeded','projected'] LOOP
    IF state='projected' THEN
      INSERT INTO public.billing_refunds(studio_id,payment_id,stripe_refund_id,stripe_charge_id,stripe_payment_intent_id,
        stripe_account_id,connect_account_generation,amount_cents,status)
      VALUES(studio,payment,'re_refundproof','ch_refundproof','pi_refundproof',account,1,500,'succeeded');
      claim:=public.claim_billing_provider_operation_resource_v1(studio,actor,'payment.refund','payment',payment,payer,
        'refund-proof',repeat('a',64),account,1,lease,30);
      IF claim->'operation'->>'state' IS DISTINCT FROM 'provider_succeeded' THEN
        RAISE EXCEPTION 'A persisted own refund lost its provider-succeeded continuation.';
      END IF;
      operation:=claim->'operation';
    END IF;
    operation:=public.transition_billing_provider_operation_v1((operation->>'id')::UUID,studio,actor,'payment.refund',
      'refund-proof',repeat('a',64),account,1,lease,(operation->>'revision')::BIGINT,state,
      p_provider_object_id=>CASE WHEN state<>'provider_request_in_flight' THEN 're_refundproof' END,
      p_result_code=>CASE state WHEN 'provider_request_in_flight' THEN 'payment_refund_started'
        WHEN 'provider_succeeded' THEN 'payment_refund_status_succeeded' ELSE 'payment_refund_projected' END,
      p_result_summary=>'amount_cents:500')->'operation';
  END LOOP;
  BEGIN
    PERFORM public.complete_billing_provider_operation_v1((operation->>'id')::UUID,studio,actor,'payment.refund',
      'refund-proof',repeat('a',64),account,1,lease,(operation->>'revision')::BIGINT,'payment_refund_completed');
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='injected_before_commit';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM<>'injected_before_commit' THEN RAISE; END IF;
  END;
  IF (SELECT refunded_amount_cents FROM public.billing_payments WHERE id=payment) IS DISTINCT FROM 500
     OR (SELECT billing_provider_operations.state FROM public.billing_provider_operations WHERE id=(operation->>'id')::UUID) IS DISTINCT FROM 'projected' THEN
    RAISE EXCEPTION 'Completion failure did not preserve the projected refund.';
  END IF;
  claim:=public.claim_billing_provider_operation_resource_v1(studio,actor,'payment.refund','payment',payment,payer,
    'refund-proof',repeat('a',64),account,1,lease,30);
  IF (SELECT resource_version_sha256 FROM public.billing_provider_operation_resources WHERE id=(claim->'resource'->>'id')::UUID) IS DISTINCT FROM original_version
     OR claim->'operation'->>'id' IS DISTINCT FROM operation->>'id'
     OR claim->'operation'->>'state' IS DISTINCT FROM 'projected' THEN
    RAISE EXCEPTION 'Retry must retain the original claim and projected operation.';
  END IF;
  operation:=claim->'operation';

  -- A verified own projection does not give another lease holder permission to complete.
  claim:=public.claim_billing_provider_operation_resource_v1(studio,actor,'payment.refund','payment',payment,payer,
    'refund-proof',repeat('a',64),account,1,rival,30);
  IF claim->'operation'->>'lease_owner' IS DISTINCT FROM lease::TEXT THEN
    RAISE EXCEPTION 'Retry stole a live lease.';
  END IF;
  rejected:=FALSE;
  BEGIN
    PERFORM public.complete_billing_provider_operation_v1((operation->>'id')::UUID,studio,actor,'payment.refund',
      'refund-proof',repeat('a',64),account,1,rival,(operation->>'revision')::BIGINT);
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM<>'billing_provider_operation_lease_owner_mismatch' THEN RAISE; END IF;
    rejected:=TRUE;
  END;
  IF NOT rejected THEN RAISE EXCEPTION 'A competing lease completed the refund.'; END IF;

  FOR invalid IN SELECT * FROM (VALUES
    (studio,other_actor,payer,account,1,repeat('a',64),'23505','billing_provider_operation_resource_actor_conflict'),
    (gen_random_uuid(),actor,payer,account,1,repeat('a',64),'42501','billing_provider_operation_actor_not_active'),
    (studio,actor,gen_random_uuid(),account,1,repeat('a',64),'23514','billing_provider_operation_resource_payment_identity_mismatch'),
    (studio,actor,payer,'acct_different',1,repeat('a',64),'23514','billing_provider_operation_resource_payment_identity_mismatch'),
    (studio,actor,payer,account,2,repeat('a',64),'23514','billing_provider_operation_resource_payment_identity_mismatch'),
    (studio,actor,payer,account,1,repeat('b',64),'23505','billing_provider_operation_resource_request_conflict')
  ) AS failures(studio_id,actor_id,payer_id,account_id,generation,request_hash,sqlstate,message) LOOP
    rejected:=FALSE;
    BEGIN
      PERFORM public.claim_billing_provider_operation_resource_v1(invalid.studio_id,invalid.actor_id,'payment.refund',
        'payment',payment,invalid.payer_id,'refund-proof',invalid.request_hash,invalid.account_id,invalid.generation,lease,30);
    EXCEPTION WHEN unique_violation OR check_violation OR insufficient_privilege THEN
      GET STACKED DIAGNOSTICS error_state=RETURNED_SQLSTATE;
      IF error_state<>invalid.sqlstate OR SQLERRM<>invalid.message THEN RAISE; END IF;
      rejected:=TRUE;
    END;
    IF NOT rejected THEN RAISE EXCEPTION 'Refund retry accepted changed identity: %',invalid.message; END IF;
  END LOOP;
  rejected:=FALSE;
  BEGIN
    PERFORM public.claim_billing_provider_operation_resource_v1(studio,actor,'payment.refund','payment',payment,payer,
      'different-amount',repeat('b',64),account,1,lease,30);
  EXCEPTION WHEN unique_violation THEN
    IF SQLERRM<>'billing_provider_operation_resource_request_conflict' THEN RAISE; END IF;
    rejected:=TRUE;
  END;
  IF NOT rejected THEN RAISE EXCEPTION 'A different request adopted the projected refund.'; END IF;

  -- Other confirmed refunds still change the version; rollback only the test adjustment.
  rejected:=FALSE;
  BEGIN
    INSERT INTO public.billing_refunds(studio_id,payment_id,stripe_refund_id,stripe_charge_id,stripe_payment_intent_id,
      stripe_account_id,connect_account_generation,amount_cents,status)
    VALUES(studio,payment,'re_unrelated','ch_refundproof','pi_refundproof',account,1,100,'succeeded');
    PERFORM public.claim_billing_provider_operation_resource_v1(studio,actor,'payment.refund','payment',payment,payer,
      'refund-proof',repeat('a',64),account,1,lease,30);
  EXCEPTION WHEN unique_violation THEN
    IF SQLERRM<>'billing_provider_operation_resource_version_conflict' THEN RAISE; END IF;
    rejected:=TRUE;
  END;
  IF NOT rejected THEN RAISE EXCEPTION 'An unrelated refund bypassed the resource version.'; END IF;
  rejected:=FALSE;
  BEGIN
    UPDATE public.billing_refunds SET reconciliation_required=TRUE
    WHERE studio_id=studio AND stripe_refund_id='re_refundproof';
    PERFORM public.claim_billing_provider_operation_resource_v1(studio,actor,'payment.refund','payment',payment,payer,
      'refund-proof',repeat('a',64),account,1,lease,30);
  EXCEPTION WHEN unique_violation THEN
    IF SQLERRM<>'billing_provider_operation_resource_version_conflict' THEN RAISE; END IF;
    rejected:=TRUE;
  END;
  IF NOT rejected THEN RAISE EXCEPTION 'An unverified projection bypassed the resource version.'; END IF;

  claim:=public.claim_billing_provider_operation_resource_v1(studio,actor,'payment.refund','payment',payment,payer,
    'same-refund-alias',repeat('a',64),account,1,lease,30);
  IF claim->'operation'->>'id' IS DISTINCT FROM operation->>'id' THEN
    RAISE EXCEPTION 'Equivalent in-flight request created another operation.';
  END IF;
  operation:=claim->'operation';
  operation:=public.complete_billing_provider_operation_v1((operation->>'id')::UUID,studio,actor,'payment.refund',
    'refund-proof',repeat('a',64),account,1,lease,(operation->>'revision')::BIGINT,
    'payment_refund_completed')->'operation';
  IF operation->>'state' IS DISTINCT FROM 'completed'
     OR (operation->>'provider_request_attempt_count')::INTEGER IS DISTINCT FROM 1
     OR (SELECT refunded_amount_cents FROM public.billing_payments WHERE id=payment) IS DISTINCT FROM 500
     OR (SELECT count(*) FROM public.billing_refunds WHERE payment_id=payment) IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'Completion must preserve one confirmed refund and one provider attempt.';
  END IF;
  claim:=public.claim_billing_provider_operation_resource_v1(studio,actor,'payment.refund','payment',payment,payer,
    'refund-proof',repeat('a',64),account,1,lease,30);
  IF claim->'operation'->>'id' IS DISTINCT FROM operation->>'id' THEN
    RAISE EXCEPTION 'Completed same-key replay lost its original result.';
  END IF;
  claim:=public.claim_billing_provider_operation_resource_v1(studio,actor,'payment.refund','payment',payment,payer,
    'next-refund',repeat('b',64),account,1,lease,30);
  IF claim->>'outcome' IS DISTINCT FROM 'replaced'
     OR claim->'operation'->>'id' IS NOT DISTINCT FROM operation->>'id'
     OR (SELECT resource_version_sha256 FROM public.billing_provider_operation_resources WHERE id=(claim->'resource'->>'id')::UUID) IS NOT DISTINCT FROM original_version THEN
    RAISE EXCEPTION 'A later refund must receive the advanced payment version.';
  END IF;
END;
$proof$;
ROLLBACK;
