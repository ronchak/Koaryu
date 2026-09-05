BEGIN;
DO $$
DECLARE
 v_ready RECORD;
 v_v31_expectation_state TEXT;
 v_current_count INTEGER;
 v_current_head TEXT;
BEGIN
 SELECT count(*)::INTEGER,max(version)
 INTO v_current_count,v_current_head
 FROM supabase_migrations.schema_migrations;
 SELECT * INTO v_ready FROM public.koaryu_release_schema_preflight_v17();
 IF v_ready.ready IS DISTINCT FROM true
    OR v_ready.migration_count<>131
    OR v_ready.migration_head<>'20260831054918'
    OR v_ready.manifest_version<>'release-db-attestation-v36'
    OR cardinality(v_ready.security_failures)<>0 THEN
  RAISE EXCEPTION 'V36 readiness contract mismatch: %',row_to_json(v_ready);
 END IF;
 IF v_current_count=133 AND v_current_head='20260905022339' THEN
  IF position('migration_history_v38' IN pg_get_functiondef('public.koaryu_release_schema_preflight_v19()'::regprocedure))=0
     OR position('migration_history_v37' IN pg_get_functiondef('public.koaryu_release_schema_preflight_v19()'::regprocedure))<>0
     OR position('koaryu_release_schema_preflight_v19' IN pg_get_functiondef('public.koaryu_release_schema_preflight_v18()'::regprocedure))=0
     OR position('koaryu_release_schema_preflight_v18' IN pg_get_functiondef('public.koaryu_release_schema_preflight_v17()'::regprocedure))=0 THEN
    RAISE EXCEPTION 'V38 readiness diagnostics or predecessor adapters drifted.';
  END IF;
 ELSIF v_current_count=132 AND v_current_head='20260902001000' THEN
  IF position('migration_history_v37' IN pg_get_functiondef(
       'public.koaryu_release_schema_preflight_v18()'::regprocedure))=0
     OR position('migration_history_v36' IN pg_get_functiondef(
       'public.koaryu_release_schema_preflight_v18()'::regprocedure))<>0
     OR position('koaryu_release_schema_preflight_v18' IN pg_get_functiondef(
       'public.koaryu_release_schema_preflight_v17()'::regprocedure))=0 THEN
   RAISE EXCEPTION 'V37 readiness diagnostics or V36 compatibility wrapper drifted.';
  END IF;
 ELSIF position('migration_history_v36' IN pg_get_functiondef(
       'public.koaryu_release_schema_preflight_v17()'::regprocedure))=0
     OR position('migration_history_v35' IN pg_get_functiondef(
       'public.koaryu_release_schema_preflight_v17()'::regprocedure))<>0 THEN
   RAISE EXCEPTION 'V36 readiness diagnostics retained a stale history label.';
 END IF;
 IF private.koaryu_release_payer_setup_recovery_manifest_v36()
    <>'0:455520fff5182b12b23368da1afe60e133a01b78913fada73e8a708b94ae8dbb' THEN
  RAISE EXCEPTION 'V36 payer setup recovery manifest mismatch.';
 END IF;
 IF (v_current_count=132 AND v_current_head='20260902001000') OR (v_current_count=133 AND v_current_head='20260905022339') THEN
  IF private.koaryu_release_operational_contract_v29()
     <>'0:32706cfae7047b70ee6b563048ffafa91d945bc824939e3000fa01631a459ecb'
     OR private.koaryu_release_operational_manifest_v10()
     <>'e81893193bc199a3911d83ce0546d6458fdc4e63d34c05a1a8dd121da8087012'
     OR private.koaryu_release_payments_replay_repairs_manifest_v30()
     <>'0:508a8a5206cf3561197bf0395e5b700a1d5d2f54aae921c34ced795324643b98'
     OR private.koaryu_release_operational_contract_v30()
     <>'0:2b57633cdd638418ca7837de9a496755e0a3620f381375657f099f6bcded8c23'
     OR private.koaryu_release_operational_manifest_v11()
     <>'43bb07edfbd3c6ee1431b6abda46ca1785b8ea117de2a13f95636fc7a3c3b263'
     OR private.koaryu_release_resource_ownership_manifest_v31()
     <>'0:c609fd207f20746d6076d49d86a39240021d20122007278d053bcab160cfa2c9'
     OR private.koaryu_release_operational_contract_v31()
     <>'0:abfd3d70c27d61b7be33193069739ddaef7db8e8a4cc591be1aeeebe130b64cc'
     OR private.koaryu_release_operational_manifest_v12()
     <>'ba219b8a319d416680ab268ba09c8dad109d4d73db0bfdadedf31318bead365d' THEN
   RAISE EXCEPTION 'V37 predecessor compatibility manifests mismatch.';
  END IF;
 ELSIF private.koaryu_release_operational_contract_v29()
    <>'0:1abbf21f66bcd927d0c1adf1f16255f4d4eebd030b0685f6dd3a2891d5afb5b9'
    OR private.koaryu_release_operational_manifest_v10()
    <>'4f6e364fe37e1325f47e098a810daacc53175b68cb01ed5bda74103f567805c5'
    OR private.koaryu_release_payments_replay_repairs_manifest_v30()
    <>'0:508a8a5206cf3561197bf0395e5b700a1d5d2f54aae921c34ced795324643b98'
    OR private.koaryu_release_operational_contract_v30()
    <>'0:846135b52d0b7784290b8428b3c1533bc3c1fd47aa5117c009516f640db979d6'
    OR private.koaryu_release_operational_manifest_v11()
    <>'e0e7bb51715afc4d656260a86a03f897f7f11650cef676f4dd52763daaadec61'
    OR private.koaryu_release_resource_ownership_manifest_v31()
    <>'0:1e2b5d81df07c4738b195f786427759efd992aa187921b182317e58185c5e566'
    OR private.koaryu_release_operational_contract_v31()
    <>'0:873f7ac7a8a0d52ffb92de8936f35c1fd2a07c1f52fe20f4b617140fc5fbccae'
    OR private.koaryu_release_operational_manifest_v12()
    <>'7d55d1237d279a3a9242ccbf4ce814d54fc7eca4348295f0a125f7e8d0c9e627' THEN
  RAISE EXCEPTION 'V36 predecessor compatibility manifests mismatch.';
 END IF;
 SELECT count(*)::TEXT||':'||encode(extensions.digest(convert_to(
       COALESCE(string_agg(expectation_key||':'||expected_sha256,'|'
         ORDER BY expectation_key COLLATE "C"),''),'UTF8'),'sha256'),'hex')
   INTO v_v31_expectation_state
 FROM private.koaryu_release_v31_expectations;
 IF v_v31_expectation_state <> (CASE
      WHEN (v_current_count=132 AND v_current_head='20260902001000') OR (v_current_count=133 AND v_current_head='20260905022339')
      THEN '1:95f3c8d7693b10b867a8e2a322bc0c40a04a444db18c0a8137f27198260776f5'
      ELSE '1:3d764f9527b71e81235d6ae5dbc62047149958b39b741d63e6600f3d78a4a587'
    END) THEN
  RAISE EXCEPTION 'V36 V31 compatibility expectation state mismatch.';
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
