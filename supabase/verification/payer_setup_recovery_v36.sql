BEGIN;
DO $$
DECLARE
 v_ready RECORD;
BEGIN
 SELECT * INTO v_ready FROM public.koaryu_release_schema_preflight_v17();
 IF v_ready.ready IS DISTINCT FROM true
    OR v_ready.migration_count IS DISTINCT FROM 131
    OR v_ready.migration_head IS DISTINCT FROM '20260831054918'
    OR v_ready.manifest_version IS DISTINCT FROM 'release-db-attestation-v36'
    OR cardinality(v_ready.security_failures) IS DISTINCT FROM 0 THEN
  RAISE EXCEPTION 'V36 readiness contract mismatch: %',row_to_json(v_ready);
 END IF;
 -- Current/old readiness bodies are pinned independently by the local verifier
 -- and rollout tool. This contract checks actual responses and payer behavior.
 IF private.koaryu_release_payer_setup_recovery_manifest_v36()
     IS DISTINCT FROM '0:455520fff5182b12b23368da1afe60e133a01b78913fada73e8a708b94ae8dbb' THEN
  RAISE EXCEPTION 'V36 payer setup recovery manifest mismatch.';
 END IF;
END $$;

DO $$
DECLARE
 v_admin UUID:=gen_random_uuid(); v_studio UUID:=gen_random_uuid();
 v_payer UUID:=gen_random_uuid(); v_operation UUID:=gen_random_uuid();
 v_request UUID:=gen_random_uuid(); v_lease UUID:=gen_random_uuid();
 v_operation2 UUID:=gen_random_uuid(); v_request2 UUID:=gen_random_uuid();
 v_lease2 UUID:=gen_random_uuid();
 v_operation3 UUID:=gen_random_uuid(); v_request3 UUID:=gen_random_uuid();
 v_lease3 UUID:=gen_random_uuid();
 v_now TIMESTAMPTZ:=clock_timestamp(); v_result JSONB;
BEGIN
 INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
 VALUES(v_admin,'authenticated','authenticated','v36@example.invalid','{}','{}',v_now,v_now);
 INSERT INTO public.studios(id,name,slug,owner_id) VALUES(v_studio,'V36','v36-'||replace(v_studio::text,'-',''),v_admin);
 INSERT INTO public.staff_roles(studio_id,user_id,role) VALUES(v_studio,v_admin,'admin');
 INSERT INTO public.studio_payment_accounts(studio_id,stripe_connected_account_id,metadata)
 VALUES(v_studio,'acct_V36',jsonb_build_object('connect_account_generation',1));
 INSERT INTO public.billing_payers(id,studio_id,display_name,stripe_account_id,stripe_customer_id,connect_account_generation)
 VALUES(v_payer,v_studio,'V36 payer','acct_V36','cus_V36',1);
 INSERT INTO public.billing_provider_operations(id,studio_id,actor_id,operation_type,caller_request_key,
  request_sha256,stripe_connected_account_id,connect_account_generation,state,
  provider_request_attempt_count,recovery_outcome,recovery_proof_sha256,recovery_actor_id,
  recovery_authorized_at,lease_owner,lease_acquired_at,lease_expires_at)
 VALUES(v_operation,v_studio,v_admin,'payer.setup','v36-key',repeat('a',64),'acct_V36',1,
  'recovery_authorized',1,'provider_no_object_safe_to_retry',repeat('b',64),v_admin,
  v_now,v_lease,v_now,v_now+interval '2 minutes');
 INSERT INTO public.billing_payer_setup_requests(id,operation_id,studio_id,payer_id,initiated_by,
  terms_version,stripe_connected_account_id,connect_account_generation,setup_request_expires_at)
 VALUES(v_request,v_operation,v_studio,v_payer,v_admin,'koaryu-autopay-v1','acct_V36',1,v_now+interval '20 minutes');
 v_result:=public.reject_billing_payer_setup_without_provider_v1(
  v_operation,v_request,v_studio,v_admin,v_payer,'v36-key',repeat('a',64),
  'acct_V36',1,v_lease,1,1);
 IF v_result->>'outcome'<>'rejected'
    OR v_result->'operation'->>'error_code'<>'setup_request_lifetime_insufficient'
    OR (v_result->'operation'->>'provider_request_attempt_count')::int<>1
    OR (v_result->'setup_request'->>'close_reason_code')<>'setup_request_lifetime_insufficient'
    OR (v_result->'setup_request'->>'provider_read_proof_sha256')<>repeat('b',64) THEN
  RAISE EXCEPTION 'V36 stale recovery rejection mismatch';
 END IF;
 v_result:=public.reject_billing_payer_setup_without_provider_v1(
  v_operation,v_request,v_studio,v_admin,v_payer,'v36-key',repeat('a',64),
  'acct_V36',1,v_lease,2,2);
 IF v_result->>'outcome'<>'replay' THEN RAISE EXCEPTION 'V36 rejection replay mismatch'; END IF;
 INSERT INTO public.billing_provider_operations(id,studio_id,actor_id,operation_type,caller_request_key,
  request_sha256,stripe_connected_account_id,connect_account_generation,state,
  provider_request_attempt_count,recovery_outcome,recovery_proof_sha256,recovery_actor_id,
  recovery_authorized_at,lease_owner,lease_acquired_at,lease_expires_at,
  provider_request_in_flight_at)
 VALUES(v_operation2,v_studio,v_admin,'payer.setup','v36-key-2',repeat('d',64),'acct_V36',1,
  'provider_request_in_flight',2,'provider_no_object_safe_to_retry',repeat('e',64),v_admin,
  v_now,v_lease2,v_now,v_now+interval '2 minutes',v_now);
 INSERT INTO public.billing_payer_setup_requests(id,operation_id,studio_id,payer_id,initiated_by,
  terms_version,stripe_connected_account_id,connect_account_generation,setup_request_expires_at)
 VALUES(v_request2,v_operation2,v_studio,v_payer,v_admin,'koaryu-autopay-v1','acct_V36',1,
  v_now+interval '50 minutes');
 v_result:=public.reject_billing_payer_setup_without_provider_v1(
  v_operation2,v_request2,v_studio,v_admin,v_payer,'v36-key-2',repeat('d',64),
  'acct_V36',1,v_lease2,1,1);
 IF v_result->>'outcome'<>'rejected'
    OR v_result->'operation'->>'error_code'<>'provider_mutation_blocked'
    OR (v_result->'operation'->>'provider_request_attempt_count')::int<>2
    OR v_result->'setup_request'->>'close_reason_code'<>'provider_mutation_blocked'
    OR v_result->'setup_request'->>'provider_read_proof_sha256' IS NOT NULL THEN
  RAISE EXCEPTION 'V36 recovered policy rejection mismatch';
 END IF;
 INSERT INTO public.billing_provider_operations(id,studio_id,actor_id,operation_type,caller_request_key,
  request_sha256,stripe_connected_account_id,connect_account_generation,state,
  provider_request_attempt_count,lease_owner,lease_acquired_at,lease_expires_at,
  provider_request_in_flight_at)
 VALUES(v_operation3,v_studio,v_admin,'payer.setup','v36-key-3',repeat('f',64),'acct_V36',1,
  'provider_request_in_flight',2,v_lease3,v_now,v_now+interval '2 minutes',v_now);
 INSERT INTO public.billing_payer_setup_requests(id,operation_id,studio_id,payer_id,initiated_by,
  terms_version,stripe_connected_account_id,connect_account_generation,setup_request_expires_at)
 VALUES(v_request3,v_operation3,v_studio,v_payer,v_admin,'koaryu-autopay-v1','acct_V36',1,
  v_now+interval '50 minutes');
 BEGIN
  PERFORM public.reject_billing_payer_setup_without_provider_v1(
   v_operation3,v_request3,v_studio,v_admin,v_payer,'v36-key-3',repeat('f',64),
   'acct_V36',1,v_lease3,1,1);
  RAISE EXCEPTION 'V36 accepted attempt two without recovery evidence';
 EXCEPTION WHEN check_violation THEN NULL; END;
 IF NOT EXISTS(SELECT 1 FROM public.billing_provider_operations
      WHERE id=v_operation3 AND state='provider_request_in_flight'
        AND provider_request_attempt_count=2)
    OR NOT EXISTS(SELECT 1 FROM public.billing_payer_setup_requests
      WHERE id=v_request3 AND closed_at IS NULL AND superseded_at IS NULL) THEN
  RAISE EXCEPTION 'V36 invalid attempt-two rejection mutated state';
 END IF;
END $$;
ROLLBACK;
