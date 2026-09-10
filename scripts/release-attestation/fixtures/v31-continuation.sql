BEGIN;
DO $resource_contract$
DECLARE
  v_studio UUID := '31000000-0000-4000-8000-000000000002';
  v_actor UUID := '31000000-0000-4000-8000-000000000001';
  v_other UUID := gen_random_uuid();
  v_payer UUID := gen_random_uuid();
  v_sync_payer UUID := gen_random_uuid();
  v_payment UUID := gen_random_uuid();
  v_pending_payment UUID := gen_random_uuid();
  v_pending_operation UUID;
  v_plan UUID := gen_random_uuid();
  v_product_plan UUID := gen_random_uuid();
  v_product_operation UUID;
  v_operation UUID;
  v_old_operation UUID;
  v_old_version TEXT;
  v_result JSONB;
  v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
  VALUES(v_other,'authenticated','authenticated',
         'v31-resource-'||replace(v_other::TEXT,'-','')||'@example.invalid','{}','{}',v_now,v_now);
  INSERT INTO public.staff_roles(studio_id,user_id,role) VALUES(v_studio,v_other,'admin');
  INSERT INTO public.billing_payers(
    id,studio_id,display_name,email,stripe_account_id,stripe_customer_id,
    connect_account_generation
  ) VALUES
    (v_payer,v_studio,'V31 refund owner','refund-owner@example.invalid',
     'acct_v31restore','cus_v31owner',1),
    (v_sync_payer,v_studio,'V31 sync owner','sync-owner@example.invalid',NULL,NULL,NULL);
  INSERT INTO public.billing_payments(
    id,studio_id,payer_id,stripe_customer_id,stripe_payment_intent_id,
    stripe_charge_id,stripe_account_id,connect_account_generation,status,
    amount_cents,currency,net_collected_amount_cents,refundable_amount_cents,processed_at
  ) VALUES(
    v_payment,v_studio,v_payer,'cus_v31owner','pi_v31owner','ch_v31owner',
    'acct_v31restore',1,'succeeded',1000,'usd',1000,1000,v_now
  );

  v_result := public.claim_billing_provider_operation_resource_v1(
    v_studio,v_actor,'payment.refund','payment',v_payment,v_payer,
    'v31-refund-key-a',repeat('a',64),'acct_v31restore',1,gen_random_uuid(),30
  );
  v_old_operation := (v_result->'operation'->>'id')::UUID;
  v_old_version := v_result->'resource'->>'resource_version_sha256';
  IF v_result->>'outcome'<>'claimed' OR v_old_version !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Initial refund owner was not versioned: %',v_result;
  END IF;
  v_result := public.claim_billing_provider_operation_resource_v1(
    v_studio,v_actor,'payment.refund','payment',v_payment,v_payer,
    'v31-refund-key-b',repeat('a',64),'acct_v31restore',1,gen_random_uuid(),30
  );
  IF v_result->>'outcome'<>'adopted'
     OR (v_result->'operation'->>'id')::UUID<>v_old_operation THEN
    RAISE EXCEPTION 'Concurrent same-version refund did not collapse: %',v_result;
  END IF;
  BEGIN
    PERFORM public.claim_billing_provider_operation_resource_v1(
      v_studio,v_actor,'payment.refund','payment',v_payment,v_payer,
      'v31-refund-different-input',repeat('b',64),
      'acct_v31restore',1,gen_random_uuid(),30
    );
    RAISE EXCEPTION 'Different amount/hash replaced an unchanged refund version.';
  EXCEPTION WHEN unique_violation THEN
    IF SQLERRM<>'billing_provider_operation_resource_request_conflict' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.claim_billing_provider_operation_resource_v1(
      v_studio,v_other,'payment.refund','payment',v_payment,v_payer,
      'v31-refund-key-a',repeat('a',64),'acct_v31restore',1,gen_random_uuid(),30
    );
    RAISE EXCEPTION 'Cross-actor refund replay was accepted.';
  EXCEPTION WHEN unique_violation THEN
    IF SQLERRM<>'billing_provider_operation_resource_actor_conflict' THEN RAISE; END IF;
  END;
  UPDATE public.billing_provider_operations SET
    state='completed',provider_request_attempt_count=1,provider_object_id='re_v31owner',
    result_code='payment_refund_completed',provider_request_in_flight_at=v_now,
    provider_succeeded_at=v_now,projected_at=v_now,completed_at=v_now,
    lease_owner=NULL,lease_acquired_at=NULL,lease_expires_at=NULL,
    revision=revision+1,updated_at=v_now
  WHERE id=v_old_operation;
  BEGIN
    PERFORM public.claim_billing_provider_operation_resource_v1(
      v_studio,v_actor,'payment.refund','payment',v_payment,v_payer,
      'v31-refund-before-version',repeat('b',64),
      'acct_v31restore',1,gen_random_uuid(),30
    );
    RAISE EXCEPTION 'Completed unchanged refund version accepted a different input.';
  EXCEPTION WHEN unique_violation THEN
    IF SQLERRM<>'billing_provider_operation_resource_request_conflict' THEN RAISE; END IF;
  END;
  INSERT INTO public.billing_refunds(
    studio_id,payment_id,stripe_refund_id,stripe_charge_id,stripe_payment_intent_id,
    stripe_account_id,connect_account_generation,amount_cents,status
  ) VALUES(v_studio,v_payment,'re_v31owner','ch_v31owner','pi_v31owner',
           'acct_v31restore',1,100,'succeeded');
  v_result := public.claim_billing_provider_operation_resource_v1(
    v_studio,v_actor,'payment.refund','payment',v_payment,v_payer,
    'v31-refund-key-a',repeat('a',64),'acct_v31restore',1,gen_random_uuid(),30
  );
  IF v_result->>'outcome'<>'replay'
     OR (v_result->'operation'->>'id')::UUID<>v_old_operation THEN
    RAISE EXCEPTION 'Old key did not replay after refund totals advanced: %',v_result;
  END IF;
  v_result := public.claim_billing_provider_operation_resource_v1(
    v_studio,v_actor,'payment.refund','payment',v_payment,v_payer,
    'v31-refund-key-c',repeat('a',64),'acct_v31restore',1,gen_random_uuid(),30
  );
  IF v_result->>'outcome'<>'replaced'
     OR (v_result->'operation'->>'id')::UUID=v_old_operation
     OR v_result->'resource'->>'resource_version_sha256'=v_old_version THEN
    RAISE EXCEPTION 'Advanced refund version did not replace its projected owner: %',v_result;
  END IF;

  INSERT INTO public.billing_payments(
    id,studio_id,payer_id,stripe_customer_id,stripe_payment_intent_id,
    stripe_charge_id,stripe_account_id,connect_account_generation,status,
    amount_cents,currency,net_collected_amount_cents,refundable_amount_cents,processed_at
  ) VALUES(
    v_pending_payment,v_studio,v_payer,'cus_v31owner','pi_v31pending','ch_v31pending',
    'acct_v31restore',1,'succeeded',500,'usd',500,500,v_now
  );
  v_result := public.claim_billing_provider_operation_resource_v1(
    v_studio,v_actor,'payment.refund','payment',v_pending_payment,v_payer,
    'v31-pending-refund-key-a',repeat('e',64),
    'acct_v31restore',1,gen_random_uuid(),30
  );
  v_pending_operation := (v_result->'operation'->>'id')::UUID;
  UPDATE public.billing_provider_operations SET
    state='completed',provider_request_attempt_count=1,
    provider_object_id='re_v31pending',result_code='payment_refund_completed',
    provider_request_in_flight_at=v_now,provider_succeeded_at=v_now,
    projected_at=v_now,completed_at=v_now,lease_owner=NULL,
    lease_acquired_at=NULL,lease_expires_at=NULL,revision=revision+1,
    updated_at=clock_timestamp()
  WHERE id=v_pending_operation;
  INSERT INTO public.billing_refunds(
    studio_id,payment_id,stripe_refund_id,stripe_charge_id,stripe_payment_intent_id,
    stripe_account_id,connect_account_generation,amount_cents,status
  ) VALUES(v_studio,v_pending_payment,'re_v31pending','ch_v31pending','pi_v31pending',
           'acct_v31restore',1,100,'pending');
  BEGIN
    PERFORM public.claim_billing_provider_operation_resource_v1(
      v_studio,v_actor,'payment.refund','payment',v_pending_payment,v_payer,
      'v31-pending-refund-key-b',repeat('e',64),
      'acct_v31restore',1,gen_random_uuid(),30
    );
    RAISE EXCEPTION 'A new refund request replayed an unsettled prior refund.';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN
    IF SQLERRM<>'billing_provider_operation_resource_prior_refund_unsettled' THEN RAISE; END IF;
  END;
  v_result := public.claim_billing_provider_operation_resource_v1(
    v_studio,v_actor,'payment.refund','payment',v_pending_payment,v_payer,
    'v31-pending-refund-key-a',repeat('e',64),
    'acct_v31restore',1,gen_random_uuid(),30
  );
  IF v_result->>'outcome'<>'replay'
     OR (v_result->'operation'->>'id')::UUID<>v_pending_operation THEN
    RAISE EXCEPTION 'Exact pending refund key did not replay: %',v_result;
  END IF;

  INSERT INTO public.billing_plans(
    id,studio_id,name,amount_cents,currency,billing_interval,status
  ) VALUES(v_plan,v_studio,'V31 resource plan',12000,'usd','monthly','pending');
  v_result := public.claim_billing_provider_operation_resource_v1(
    v_studio,v_actor,'plan.sync','plan',v_plan,NULL,
    'v31-plan-key-a',repeat('f',64),'acct_v31restore',1,gen_random_uuid(),30
  );
  v_old_operation := (v_result->'operation'->>'id')::UUID;
  IF v_result->>'outcome'<>'claimed'
     OR v_result->'resource'->>'payer_id' IS NOT NULL THEN
    RAISE EXCEPTION 'Initial plan resource owner was invalid: %',v_result;
  END IF;
  v_result := public.claim_billing_provider_operation_resource_v1(
    v_studio,v_actor,'plan.sync','plan',v_plan,NULL,
    'v31-plan-key-b',repeat('f',64),'acct_v31restore',1,gen_random_uuid(),30
  );
  IF v_result->>'outcome'<>'adopted'
     OR (v_result->'operation'->>'id')::UUID<>v_old_operation THEN
    RAISE EXCEPTION 'Same-version plan sync did not collapse: %',v_result;
  END IF;
  UPDATE public.billing_provider_operations SET
    provider_step_plan_sha256=repeat('2',64),
    provider_step_expected_count=2,
    provider_step_plan_registered_at=clock_timestamp(),
    revision=revision+1,
    updated_at=clock_timestamp()
  WHERE id=v_old_operation;
  INSERT INTO public.billing_provider_operation_steps(
    operation_id,studio_id,stripe_connected_account_id,
    connect_account_generation,step_order,step_name,provider_operation,
    request_sha256,stripe_idempotency_key,state,
    provider_request_attempt_count,provider_object_id,result_code,
    provider_succeeded_at
  ) VALUES
    (v_old_operation,v_studio,'acct_v31restore',1,1,'product',
     'connected_product.create',repeat('3',64),'v31-plan-step-product',
     'provider_succeeded',1,'prod_v31plan','plan_sync_product_succeeded',v_now),
    (v_old_operation,v_studio,'acct_v31restore',1,2,'price',
     'connected_price.create',repeat('4',64),'v31-plan-step-price',
     'provider_succeeded',1,'price_v31plan','plan_sync_price_succeeded',v_now);
  UPDATE public.billing_provider_operations SET
    state='completed',provider_request_attempt_count=1,
    provider_object_id='price_v31plan',result_code='plan_sync_completed',
    result_summary='plan_sync_mode:product_price_steps',
    provider_request_in_flight_at=v_now,provider_succeeded_at=v_now,
    projected_at=v_now,completed_at=v_now,lease_owner=NULL,
    lease_acquired_at=NULL,lease_expires_at=NULL,revision=revision+1,
    updated_at=clock_timestamp()
  WHERE id=v_old_operation;
  UPDATE public.billing_plans SET stripe_account_id='acct_v31restore',
    stripe_product_id='prod_v31plan',stripe_price_id='price_v31plan',
    stripe_price_version=1,status='active',
    updated_at=clock_timestamp() WHERE id=v_plan;
  BEGIN
    PERFORM public.claim_billing_provider_operation_resource_v1(
      v_studio,v_actor,'plan.sync','plan',v_plan,NULL,
      'v31-plan-key-unchanged',repeat('1',64),
      'acct_v31restore',1,gen_random_uuid(),30
    );
    RAISE EXCEPTION 'A caller-selected hash replaced an unchanged completed plan.';
  EXCEPTION WHEN unique_violation THEN
    IF SQLERRM<>'billing_provider_operation_resource_request_conflict' THEN RAISE; END IF;
  END;
  UPDATE public.billing_plans SET
    name='V31 resource plan updated',stripe_product_id='prod_v31plan_drift',
    updated_at=clock_timestamp() WHERE id=v_plan;
  BEGIN
    PERFORM public.claim_billing_provider_operation_resource_v1(
      v_studio,v_other,'plan.sync','plan',v_plan,NULL,
      'v31-plan-key-c',repeat('1',64),'acct_v31restore',1,gen_random_uuid(),30
    );
    RAISE EXCEPTION 'Plan replacement accepted corrupted product projection evidence.';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM<>'billing_provider_operation_resource_prior_projection_unverified' THEN RAISE; END IF;
  END;
  UPDATE public.billing_plans SET
    stripe_product_id='prod_v31plan',stripe_price_id='price_v31plan_drift',
    updated_at=clock_timestamp() WHERE id=v_plan;
  BEGIN
    PERFORM public.claim_billing_provider_operation_resource_v1(
      v_studio,v_other,'plan.sync','plan',v_plan,NULL,
      'v31-plan-key-c',repeat('1',64),'acct_v31restore',1,gen_random_uuid(),30
    );
    RAISE EXCEPTION 'Plan replacement accepted corrupted price projection evidence.';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM<>'billing_provider_operation_resource_prior_projection_unverified' THEN RAISE; END IF;
  END;
  UPDATE public.billing_plans SET stripe_price_id='price_v31plan',
    updated_at=clock_timestamp() WHERE id=v_plan;
  v_result := public.claim_billing_provider_operation_resource_v1(
    v_studio,v_other,'plan.sync','plan',v_plan,NULL,
    'v31-plan-key-c',repeat('1',64),'acct_v31restore',1,gen_random_uuid(),30
  );
  IF v_result->>'outcome'<>'replaced'
     OR (v_result->'operation'->>'id')::UUID=v_old_operation
     OR (v_result->'operation'->>'actor_id')::UUID<>v_other THEN
    RAISE EXCEPTION 'Changed plan resource did not transfer to another active Admin: %',v_result;
  END IF;

  INSERT INTO public.billing_plans(
    id,studio_id,name,amount_cents,currency,billing_interval,status,
    stripe_account_id,stripe_product_id,stripe_price_id,stripe_price_version
  ) VALUES(
    v_product_plan,v_studio,'V31 product-only plan',9000,'usd','monthly','active',
    'acct_v31restore','prod_v31product','price_v31product',1
  );
  v_result:=public.claim_billing_provider_operation_resource_v1(
    v_studio,v_actor,'plan.sync','plan',v_product_plan,NULL,
    'v31-product-plan-key-a',repeat('5',64),
    'acct_v31restore',1,gen_random_uuid(),30
  );
  v_product_operation:=(v_result->'operation'->>'id')::UUID;
  UPDATE public.billing_provider_operations SET
    provider_step_plan_sha256=repeat('6',64),
    provider_step_expected_count=2,
    provider_step_plan_registered_at=clock_timestamp(),
    revision=revision+1,updated_at=clock_timestamp()
  WHERE id=v_product_operation;
  UPDATE public.billing_provider_operations SET
    state='completed',provider_request_attempt_count=1,
    provider_object_id='prod_v31product',result_code='plan_sync_completed',
    result_summary='plan_sync_mode:product_update_only',
    provider_request_in_flight_at=clock_timestamp(),
    provider_succeeded_at=clock_timestamp(),projected_at=clock_timestamp(),
    completed_at=clock_timestamp(),lease_owner=NULL,
    lease_acquired_at=NULL,lease_expires_at=NULL,
    revision=revision+1,updated_at=clock_timestamp()
  WHERE id=v_product_operation;
  UPDATE public.billing_plans SET name='V31 product-only plan updated',
    updated_at=clock_timestamp() WHERE id=v_product_plan;
  BEGIN
    PERFORM public.claim_billing_provider_operation_resource_v1(
      v_studio,v_actor,'plan.sync','plan',v_product_plan,NULL,
      'v31-product-plan-key-b',repeat('7',64),
      'acct_v31restore',1,gen_random_uuid(),30
    );
    RAISE EXCEPTION 'Product-only plan replacement accepted step-plan evidence.';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM<>'billing_provider_operation_resource_prior_projection_unverified' THEN RAISE; END IF;
  END;

  v_result := public.claim_billing_provider_operation_resource_v1(
    v_studio,v_actor,'payer.sync','payer',v_sync_payer,v_sync_payer,
    'v31-payer-key-a',repeat('c',64),'acct_v31restore',1,gen_random_uuid(),30
  );
  v_old_operation := (v_result->'operation'->>'id')::UUID;
  v_old_version := v_result->'resource'->>'resource_version_sha256';
  UPDATE public.billing_provider_operations SET
    state='completed',provider_request_attempt_count=1,provider_object_id='cus_v31sync',
    result_code='payer_sync_completed',provider_request_in_flight_at=v_now,
    provider_succeeded_at=v_now,projected_at=v_now,completed_at=v_now,
    lease_owner=NULL,lease_acquired_at=NULL,lease_expires_at=NULL,
    revision=revision+1,updated_at=v_now
  WHERE id=v_old_operation;
  UPDATE public.billing_payers SET stripe_account_id='acct_v31restore',
    stripe_customer_id='cus_v31sync',connect_account_generation=1,
    updated_at=clock_timestamp() WHERE id=v_sync_payer;
  v_result := public.claim_billing_provider_operation_resource_v1(
    v_studio,v_actor,'payer.sync','payer',v_sync_payer,v_sync_payer,
    'v31-payer-key-b',repeat('c',64),'acct_v31restore',1,gen_random_uuid(),30
  );
  IF v_result->>'outcome'<>'adopted'
     OR (v_result->'operation'->>'id')::UUID<>v_old_operation THEN
    RAISE EXCEPTION 'Provider-assigned customer identity changed payer desired version: %',v_result;
  END IF;
  UPDATE public.billing_payers SET email='sync-owner-updated@example.invalid',
    updated_at=clock_timestamp() WHERE id=v_sync_payer;
  v_result := public.claim_billing_provider_operation_resource_v1(
    v_studio,v_actor,'payer.sync','payer',v_sync_payer,v_sync_payer,
    'v31-payer-key-a',repeat('c',64),'acct_v31restore',1,gen_random_uuid(),30
  );
  IF v_result->>'outcome'<>'replay'
     OR (v_result->'operation'->>'id')::UUID<>v_old_operation THEN
    RAISE EXCEPTION 'Old payer key did not replay after desired state advanced: %',v_result;
  END IF;
  v_result := public.claim_billing_provider_operation_resource_v1(
    v_studio,v_actor,'payer.sync','payer',v_sync_payer,v_sync_payer,
    'v31-payer-key-c',repeat('d',64),'acct_v31restore',1,gen_random_uuid(),30
  );
  v_operation := (v_result->'operation'->>'id')::UUID;
  IF v_result->>'outcome'<>'replaced' OR v_operation=v_old_operation
     OR v_result->'resource'->>'resource_version_sha256'=v_old_version THEN
    RAISE EXCEPTION 'Changed payer state did not replace its projected owner: %',v_result;
  END IF;
END;
$resource_contract$;

DO $sparse_payment_contract$
DECLARE
  v_payment public.billing_payments%ROWTYPE;
BEGIN
  SELECT * INTO v_payment FROM public.billing_payments
  WHERE id='31000000-0000-4000-8000-00000000000d';
  UPDATE public.billing_payments SET payer_id=NULL,invoice_id=NULL,
    stripe_customer_id=NULL,stripe_invoice_id=NULL,stripe_payment_intent_id=NULL,
    stripe_charge_id=NULL,stripe_account_id=NULL,connect_account_generation=NULL,
    stripe_payment_method_id=NULL
  WHERE id=v_payment.id;
  IF NOT EXISTS(
    SELECT 1 FROM public.billing_payments AS current
    WHERE current.id=v_payment.id
      AND current.payer_id IS NOT DISTINCT FROM v_payment.payer_id
      AND current.invoice_id IS NOT DISTINCT FROM v_payment.invoice_id
      AND current.stripe_customer_id IS NOT DISTINCT FROM v_payment.stripe_customer_id
      AND current.stripe_invoice_id IS NOT DISTINCT FROM v_payment.stripe_invoice_id
      AND current.stripe_payment_intent_id IS NOT DISTINCT FROM v_payment.stripe_payment_intent_id
      AND current.stripe_charge_id IS NOT DISTINCT FROM v_payment.stripe_charge_id
      AND current.stripe_account_id IS NOT DISTINCT FROM v_payment.stripe_account_id
      AND current.connect_account_generation IS NOT DISTINCT FROM v_payment.connect_account_generation
      AND current.stripe_payment_method_id IS NOT DISTINCT FROM v_payment.stripe_payment_method_id
      AND current.status=v_payment.status
  ) THEN RAISE EXCEPTION 'Sparse payment projection did not preserve established identity.'; END IF;
  BEGIN
    UPDATE public.billing_payments SET stripe_charge_id='ch_v31conflict'
    WHERE id=v_payment.id;
    RAISE EXCEPTION 'Established charge replacement was accepted.';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM<>'Established billing payment identity cannot change.' THEN RAISE; END IF;
  END;
END;
$sparse_payment_contract$;

DO $due_reclaim_contract$
DECLARE
  v_studio UUID := '31000000-0000-4000-8000-000000000002';
  v_actor UUID := '31000000-0000-4000-8000-000000000001';
  v_payer UUID := gen_random_uuid();
  v_plan UUID := gen_random_uuid();
  v_student UUID := gen_random_uuid();
  v_subscription UUID := gen_random_uuid();
  v_enrollment UUID := gen_random_uuid();
  v_schedule UUID := gen_random_uuid();
  v_execute UUID := gen_random_uuid();
  v_operation UUID := gen_random_uuid();
  v_mismatch_student UUID := gen_random_uuid();
  v_mismatch_enrollment UUID := gen_random_uuid();
  v_mismatch_schedule UUID := gen_random_uuid();
  v_mismatch_execute UUID := gen_random_uuid();
  v_mismatch_operation UUID := gen_random_uuid();
  v_old_worker UUID := gen_random_uuid();
  v_new_worker UUID := gen_random_uuid();
  v_claimed UUID;
  v_execute_revision BIGINT;
  v_operation_revision BIGINT;
  v_mismatch_execute_revision BIGINT;
  v_mismatch_operation_revision BIGINT;
  v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  INSERT INTO public.billing_payers(
    id,studio_id,display_name,stripe_account_id,stripe_customer_id,
    connect_account_generation
  ) VALUES(v_payer,v_studio,'V31 due payer','acct_v31restore','cus_v31due',1);
  INSERT INTO public.billing_plans(id,studio_id,name,amount_cents,billing_interval,status)
  VALUES(v_plan,v_studio,'V31 due plan',1000,'monthly','active');
  INSERT INTO public.students(id,studio_id,legal_first_name,legal_last_name)
  VALUES(v_student,v_studio,'Due','Reclaim');
  INSERT INTO public.billing_subscriptions(
    id,studio_id,payer_id,stripe_account_id,stripe_customer_id,
    stripe_subscription_id,collection_mode,billing_interval,currency,status,
    current_period_end,metadata
  ) VALUES(v_subscription,v_studio,v_payer,'acct_v31restore','cus_v31due',
           'sub_v31due','invoice_link','monthly','usd','active',
           v_now-interval '1 minute',jsonb_build_object('connect_account_generation',1));
  INSERT INTO public.student_billing_enrollments(
    id,studio_id,student_id,payer_id,billing_plan_id,billing_subscription_id,
    collection_mode,status,stripe_subscription_id,stripe_subscription_item_id
  ) VALUES(v_enrollment,v_studio,v_student,v_payer,v_plan,v_subscription,
           'invoice_link','active','sub_v31due','si_v31due');
  INSERT INTO public.billing_provider_operations(
    id,studio_id,actor_id,operation_type,caller_request_key,request_sha256,
    stripe_connected_account_id,connect_account_generation,state,
    provider_request_attempt_count,lease_owner,lease_acquired_at,lease_expires_at,
    started_at,created_at,updated_at
  ) VALUES(v_operation,v_studio,v_actor,'enrollment.cancel.period_end.execute',
           'v31-due-provider',repeat('e',64),'acct_v31restore',1,'started',0,
           v_old_worker,v_now-interval '1 minute',v_now+interval '1 minute',
           v_now-interval '2 minutes',v_now-interval '2 minutes',v_now-interval '2 minutes');
  INSERT INTO public.billing_enrollment_transition_intents(
    id,studio_id,enrollment_id,payer_id,billing_subscription_id,
    transition_kind,mutation_strategy,request_sha256,stripe_connected_account_id,
    connect_account_generation,stripe_subscription_id,stripe_subscription_item_id,
    period_boundary,expected_quantity,expected_subscription_item_count,
    same_item_active_count,provider_quantity,initiated_by,reason_code,state,
    due_claimed_at,created_at,updated_at
  ) VALUES(v_schedule,v_studio,v_enrollment,v_payer,v_subscription,
           'schedule_period_end','subscription_item_delete_at_period_end',repeat('f',64),
           'acct_v31restore',1,'sub_v31due','si_v31due',v_now-interval '1 minute',
           0,2,1,1,v_actor,'v31.due','due_claimed',v_now-interval '2 minutes',
           v_now-interval '2 minutes',v_now-interval '2 minutes');
  INSERT INTO public.billing_enrollment_transition_intents(
    id,studio_id,enrollment_id,payer_id,billing_subscription_id,source_intent_id,
    provider_operation_id,transition_kind,mutation_strategy,request_sha256,
    provider_caller_request_key,provider_request_sha256,stripe_connected_account_id,
    connect_account_generation,stripe_subscription_id,stripe_subscription_item_id,
    period_boundary,expected_quantity,expected_subscription_item_count,
    same_item_active_count,provider_quantity,initiated_by,reason_code,state,
    lease_owner,lease_acquired_at,lease_expires_at,due_claimed_at,created_at,updated_at
  ) VALUES(v_execute,v_studio,v_enrollment,v_payer,v_subscription,v_schedule,v_operation,
           'execute_due','subscription_item_delete_at_period_end',repeat('f',64),
           'v31-due-provider',repeat('e',64),'acct_v31restore',1,'sub_v31due','si_v31due',
           v_now-interval '1 minute',0,2,1,1,v_actor,'v31.due','due_claimed',
           v_old_worker,v_now-interval '2 minutes',v_now-interval '1 minute',
           v_now-interval '2 minutes',v_now-interval '2 minutes',v_now-interval '2 minutes');
  INSERT INTO public.billing_enrollment_transition_aliases(
    intent_id,studio_id,transition_kind,caller_request_key,actor_id,
    request_sha256,created_at
  ) VALUES(
    v_execute,v_studio,'execute_due','v31-due-provider',v_actor,
    repeat('e',64),v_now-interval '2 minutes'
  );

  SELECT revision INTO v_execute_revision
  FROM public.billing_enrollment_transition_intents WHERE id=v_execute;
  SELECT revision INTO v_operation_revision
  FROM public.billing_provider_operations WHERE id=v_operation;
  SELECT due.id INTO v_claimed
  FROM public.claim_due_billing_enrollment_transitions_v1(v_new_worker,30,1) AS due;
  IF v_claimed IS NOT NULL
     OR (SELECT revision FROM public.billing_enrollment_transition_intents
         WHERE id=v_execute)<>v_execute_revision
     OR (SELECT revision FROM public.billing_provider_operations
         WHERE id=v_operation)<>v_operation_revision THEN
    RAISE EXCEPTION 'Due claim stole a provider operation with an active lease.';
  END IF;

  INSERT INTO public.students(id,studio_id,legal_first_name,legal_last_name)
  VALUES(v_mismatch_student,v_studio,'Due','Mismatch');
  INSERT INTO public.student_billing_enrollments(
    id,studio_id,student_id,payer_id,billing_plan_id,billing_subscription_id,
    collection_mode,status,stripe_subscription_id,stripe_subscription_item_id
  ) VALUES(
    v_mismatch_enrollment,v_studio,v_mismatch_student,v_payer,v_plan,v_subscription,
    'invoice_link','active','sub_v31due','si_v31due_mismatch'
  );
  INSERT INTO public.billing_provider_operations(
    id,studio_id,actor_id,operation_type,caller_request_key,request_sha256,
    stripe_connected_account_id,connect_account_generation,state,
    provider_request_attempt_count,lease_owner,lease_acquired_at,lease_expires_at,
    started_at,created_at,updated_at
  ) VALUES(
    v_mismatch_operation,v_studio,gen_random_uuid(),
    'enrollment.cancel.period_end.execute','v31-due-provider-mismatch',repeat('c',64),
    'acct_v31restore',1,'started',0,v_old_worker,
    v_now-interval '2 minutes',v_now-interval '1 minute',
    v_now-interval '2 minutes',v_now-interval '2 minutes',v_now-interval '2 minutes'
  );
  INSERT INTO public.billing_enrollment_transition_intents(
    id,studio_id,enrollment_id,payer_id,billing_subscription_id,
    transition_kind,mutation_strategy,request_sha256,stripe_connected_account_id,
    connect_account_generation,stripe_subscription_id,stripe_subscription_item_id,
    period_boundary,expected_quantity,expected_subscription_item_count,
    same_item_active_count,provider_quantity,initiated_by,reason_code,state,
    due_claimed_at,created_at,updated_at
  ) VALUES(
    v_mismatch_schedule,v_studio,v_mismatch_enrollment,v_payer,v_subscription,
    'schedule_period_end','subscription_item_delete_at_period_end',repeat('b',64),
    'acct_v31restore',1,'sub_v31due','si_v31due_mismatch',v_now-interval '2 minutes',
    0,2,1,1,v_actor,'v31.due.mismatch','due_claimed',v_now-interval '2 minutes',
    v_now-interval '2 minutes',v_now-interval '2 minutes'
  );
  INSERT INTO public.billing_enrollment_transition_intents(
    id,studio_id,enrollment_id,payer_id,billing_subscription_id,source_intent_id,
    provider_operation_id,transition_kind,mutation_strategy,request_sha256,
    provider_caller_request_key,provider_request_sha256,stripe_connected_account_id,
    connect_account_generation,stripe_subscription_id,stripe_subscription_item_id,
    period_boundary,expected_quantity,expected_subscription_item_count,
    same_item_active_count,provider_quantity,initiated_by,reason_code,state,
    lease_owner,lease_acquired_at,lease_expires_at,due_claimed_at,created_at,updated_at
  ) VALUES(
    v_mismatch_execute,v_studio,v_mismatch_enrollment,v_payer,v_subscription,
    v_mismatch_schedule,v_mismatch_operation,'execute_due',
    'subscription_item_delete_at_period_end',repeat('b',64),
    'v31-due-provider-mismatch',repeat('c',64),'acct_v31restore',1,
    'sub_v31due','si_v31due_mismatch',v_now-interval '2 minutes',0,2,1,1,
    v_actor,'v31.due.mismatch','due_claimed',v_old_worker,
    v_now-interval '2 minutes',v_now-interval '1 minute',v_now-interval '2 minutes',
    v_now-interval '2 minutes',v_now-interval '2 minutes'
  );
  INSERT INTO public.billing_enrollment_transition_aliases(
    intent_id,studio_id,transition_kind,caller_request_key,actor_id,
    request_sha256,created_at
  ) VALUES(
    v_mismatch_execute,v_studio,'execute_due','v31-due-provider-mismatch',v_actor,
    repeat('c',64),v_now-interval '2 minutes'
  );
  SELECT revision INTO v_mismatch_execute_revision
  FROM public.billing_enrollment_transition_intents WHERE id=v_mismatch_execute;
  SELECT revision INTO v_mismatch_operation_revision
  FROM public.billing_provider_operations WHERE id=v_mismatch_operation;
  v_claimed:=NULL;
  SELECT due.id INTO v_claimed
  FROM public.claim_due_billing_enrollment_transitions_v1(v_new_worker,30,1) AS due;
  IF v_claimed IS NOT NULL
     OR (SELECT revision FROM public.billing_enrollment_transition_intents
         WHERE id=v_mismatch_execute)<>v_mismatch_execute_revision
     OR (SELECT revision FROM public.billing_provider_operations
         WHERE id=v_mismatch_operation)<>v_mismatch_operation_revision THEN
    RAISE EXCEPTION 'Due claim adopted a provider operation with mismatched identity.';
  END IF;

  UPDATE public.billing_provider_operations
  SET lease_acquired_at=v_now-interval '2 minutes',
      lease_expires_at=v_now-interval '1 minute',
      revision=revision+1,
      updated_at=clock_timestamp()
  WHERE id=v_operation;
  SELECT revision INTO v_execute_revision
  FROM public.billing_enrollment_transition_intents WHERE id=v_execute;
  SELECT revision INTO v_operation_revision
  FROM public.billing_provider_operations WHERE id=v_operation;
  v_claimed:=NULL;
  SELECT due.id INTO v_claimed
  FROM public.claim_due_billing_enrollment_transitions_v1(v_new_worker,30,1) AS due;
  IF v_claimed IS DISTINCT FROM v_execute
     OR (SELECT lease_owner FROM public.billing_enrollment_transition_intents
         WHERE id=v_execute) IS DISTINCT FROM v_new_worker
     OR (SELECT lease_owner FROM public.billing_provider_operations
         WHERE id=v_operation) IS DISTINCT FROM v_new_worker
     OR (SELECT revision FROM public.billing_enrollment_transition_intents
         WHERE id=v_execute)<>v_execute_revision+1
     OR (SELECT revision FROM public.billing_provider_operations
         WHERE id=v_operation)<>v_operation_revision+1
     OR (SELECT count(*) FROM public.billing_enrollment_transition_intents
         WHERE source_intent_id=v_schedule AND transition_kind='execute_due')<>1 THEN
    RAISE EXCEPTION 'Bound expired due work did not reclaim one exact durable operation.';
  END IF;

  UPDATE public.billing_provider_operations
  SET state='recovery_authorized',
      provider_request_attempt_count=1,
      provider_request_in_flight_at=v_now-interval '3 minutes',
      recovery_proof_sha256=repeat('a',64),
      recovery_outcome='provider_no_object_safe_to_retry',
      recovery_actor_id=v_actor,
      recovery_authorized_at=v_now-interval '2 minutes',
      lease_owner=v_old_worker,
      lease_acquired_at=v_now-interval '1 minute',
      lease_expires_at=v_now+interval '1 minute',
      revision=revision+1,
      updated_at=clock_timestamp()
  WHERE id=v_operation
  RETURNING revision INTO v_operation_revision;
  UPDATE public.billing_enrollment_transition_intents
  SET state='recovery_authorized',
      recovery_proof_sha256=repeat('a',64),
      recovery_outcome='provider_no_object_safe_to_retry',
      recovery_actor_id=v_actor,
      recovery_authorized_at=v_now-interval '2 minutes',
      lease_owner=v_old_worker,
      lease_acquired_at=v_now-interval '2 minutes',
      lease_expires_at=v_now-interval '1 minute',
      revision=revision+1,
      updated_at=clock_timestamp()
  WHERE id=v_execute
  RETURNING revision INTO v_execute_revision;

  v_claimed:=NULL;
  SELECT due.id INTO v_claimed
  FROM public.claim_due_billing_enrollment_transitions_v1(v_new_worker,30,1) AS due;
  IF v_claimed IS NOT NULL
     OR (SELECT revision FROM public.billing_enrollment_transition_intents
         WHERE id=v_execute)<>v_execute_revision
     OR (SELECT revision FROM public.billing_provider_operations
         WHERE id=v_operation)<>v_operation_revision THEN
    RAISE EXCEPTION 'Due recovery reclaimed work before both leases expired.';
  END IF;

  UPDATE public.billing_provider_operations
  SET lease_acquired_at=v_now-interval '2 minutes',
      lease_expires_at=v_now-interval '1 minute',
      revision=revision+1,
      updated_at=clock_timestamp()
  WHERE id=v_operation
  RETURNING revision INTO v_operation_revision;
  v_claimed:=NULL;
  SELECT due.id INTO v_claimed
  FROM public.claim_due_billing_enrollment_transitions_v1(v_new_worker,30,1) AS due;
  IF v_claimed IS DISTINCT FROM v_execute
     OR (SELECT state FROM public.billing_enrollment_transition_intents
         WHERE id=v_execute)<>'recovery_authorized'
     OR (SELECT lease_owner FROM public.billing_enrollment_transition_intents
         WHERE id=v_execute) IS DISTINCT FROM v_new_worker
     OR (SELECT lease_owner FROM public.billing_provider_operations
         WHERE id=v_operation) IS DISTINCT FROM v_new_worker
     OR (SELECT revision FROM public.billing_enrollment_transition_intents
         WHERE id=v_execute)<>v_execute_revision+1
     OR (SELECT revision FROM public.billing_provider_operations
         WHERE id=v_operation)<>v_operation_revision+1
     OR (SELECT count(*) FROM public.billing_enrollment_transition_intents
         WHERE source_intent_id=v_schedule AND transition_kind='execute_due')<>1 THEN
    RAISE EXCEPTION 'Expired exact no-object recovery did not reclaim the same due intent.';
  END IF;
END;
$due_reclaim_contract$;
ROLLBACK;
