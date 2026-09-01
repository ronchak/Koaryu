-- V36 lets an explicitly authorized no-object payer.setup recovery close a
-- stale prepared request without issuing a second provider mutation.
ALTER TABLE public.billing_payer_setup_requests
  DROP CONSTRAINT billing_payer_setup_requests_close_evidence;
ALTER TABLE public.billing_payer_setup_requests
  ADD CONSTRAINT billing_payer_setup_requests_close_evidence CHECK (
    (closed_at IS NULL AND close_reason_code IS NULL AND provider_read_proof_sha256 IS NULL)
    OR (
      closed_at IS NOT NULL AND closed_at=superseded_at AND (
        (close_reason_code IN ('checkout_session_expired','checkout_session_terminal_unusable')
          AND provider_read_proof_sha256~'^[0-9a-f]{64}$')
        OR (close_reason_code='provider_mutation_blocked'
          AND provider_read_proof_sha256 IS NULL
          AND stripe_checkout_session_id IS NULL AND stripe_setup_intent_id IS NULL)
        OR (close_reason_code='setup_request_lifetime_insufficient'
          AND provider_read_proof_sha256~'^[0-9a-f]{64}$'
          AND stripe_checkout_session_id IS NULL AND stripe_setup_intent_id IS NULL)
      )
    )
  );

CREATE OR REPLACE FUNCTION public.reject_billing_payer_setup_without_provider_v1(
 p_operation_id UUID,p_setup_request_id UUID,p_studio_id UUID,p_actor_id UUID,
 p_payer_id UUID,p_caller_request_key TEXT,p_request_sha256 TEXT,
 p_stripe_connected_account_id TEXT,p_connect_account_generation INTEGER,
 p_lease_owner UUID,p_expected_operation_revision BIGINT,p_expected_setup_revision BIGINT
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
 v_operation public.billing_provider_operations%ROWTYPE;
 v_request public.billing_payer_setup_requests%ROWTYPE;
 v_now TIMESTAMPTZ:=clock_timestamp();
 v_reason TEXT;
 v_proof TEXT;
BEGIN
 SELECT * INTO v_operation FROM public.billing_provider_operations
  WHERE id=p_operation_id FOR UPDATE;
 PERFORM 1 FROM public.billing_payers WHERE id=p_payer_id AND studio_id=p_studio_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='billing_payer_setup_policy_rejection_identity_mismatch'; END IF;
 SELECT * INTO v_request FROM public.billing_payer_setup_requests
  WHERE id=p_setup_request_id FOR UPDATE;
 PERFORM 1 FROM public.billing_payer_payment_consents c
  WHERE c.setup_request_id=p_setup_request_id AND c.completed_at IS NULL
    AND c.revoked_at IS NULL AND c.superseded_at IS NULL ORDER BY c.id FOR UPDATE;
 IF v_operation.id IS NULL OR v_request.id IS NULL
    OR v_operation.operation_type<>'payer.setup'
    OR v_operation.studio_id IS DISTINCT FROM p_studio_id
    OR v_operation.actor_id IS DISTINCT FROM p_actor_id
    OR v_operation.caller_request_key IS DISTINCT FROM p_caller_request_key
    OR v_operation.request_sha256 IS DISTINCT FROM p_request_sha256
    OR v_operation.stripe_connected_account_id IS DISTINCT FROM p_stripe_connected_account_id
    OR v_operation.connect_account_generation IS DISTINCT FROM p_connect_account_generation
    OR v_request.operation_id IS DISTINCT FROM p_operation_id
    OR v_request.studio_id IS DISTINCT FROM p_studio_id
    OR v_request.payer_id IS DISTINCT FROM p_payer_id
    OR v_request.initiated_by IS DISTINCT FROM p_actor_id
    OR v_request.stripe_connected_account_id IS DISTINCT FROM p_stripe_connected_account_id
    OR v_request.connect_account_generation IS DISTINCT FROM p_connect_account_generation THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='billing_payer_setup_policy_rejection_identity_mismatch';
 END IF;
 IF v_operation.state='definitive_rejected'
    AND v_operation.error_code IN ('provider_mutation_blocked','setup_request_lifetime_insufficient')
    AND v_operation.provider_object_id IS NULL AND v_operation.provider_secondary_object_id IS NULL
    AND v_operation.provider_request_id IS NULL AND v_request.closed_at IS NOT NULL
    AND v_request.closed_at=v_request.superseded_at
    AND v_request.close_reason_code=v_operation.error_code
    AND ((v_operation.error_code='provider_mutation_blocked' AND v_request.provider_read_proof_sha256 IS NULL)
      OR (v_operation.error_code='setup_request_lifetime_insufficient'
        AND v_request.provider_read_proof_sha256~'^[0-9a-f]{64}$')) THEN
  RETURN private.billing_payer_setup_request_json_v1(v_request,'replay')
    ||jsonb_build_object('operation',private.billing_provider_operation_json_v1(v_operation,'replay')->'operation');
 END IF;
 IF v_operation.revision IS DISTINCT FROM p_expected_operation_revision
    OR v_request.revision IS DISTINCT FROM p_expected_setup_revision THEN
  RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='billing_payer_setup_policy_rejection_stale_revision';
 END IF;
 IF v_operation.state='recovery_authorized'
    AND v_operation.recovery_outcome='provider_no_object_safe_to_retry' THEN
  v_reason:='setup_request_lifetime_insufficient';
  v_proof:=v_operation.recovery_proof_sha256;
  IF v_operation.provider_request_attempt_count<>1
     OR v_operation.lease_owner IS DISTINCT FROM p_lease_owner
     OR v_operation.lease_expires_at IS NULL OR v_operation.lease_expires_at<=v_now
     OR v_operation.recovery_actor_id IS NULL OR v_operation.recovery_authorized_at IS NULL
     OR v_proof!~'^[0-9a-f]{64}$'
     OR v_request.setup_request_expires_at>=v_now+interval '30 minutes' THEN
   RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='billing_payer_setup_policy_rejection_invalid';
  END IF;
 ELSE
  v_reason:='provider_mutation_blocked'; v_proof:=NULL;
  IF v_operation.lease_owner IS DISTINCT FROM p_lease_owner
     OR v_operation.state<>'provider_request_in_flight'
     OR v_operation.lease_expires_at IS NULL OR v_operation.lease_expires_at<=v_now
     OR (
       (v_operation.provider_request_attempt_count=1
         AND v_operation.recovery_outcome IS NULL
         AND v_operation.recovery_proof_sha256 IS NULL
         AND v_operation.recovery_actor_id IS NULL
         AND v_operation.recovery_authorized_at IS NULL)
       OR
       (v_operation.provider_request_attempt_count=2
         AND v_operation.recovery_outcome='provider_no_object_safe_to_retry'
         AND v_operation.recovery_proof_sha256~'^[0-9a-f]{64}$'
         AND v_operation.recovery_actor_id IS NOT NULL
         AND v_operation.recovery_authorized_at IS NOT NULL
         AND v_operation.recovery_authorized_at<=v_now)
     ) IS NOT TRUE THEN
   RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='billing_payer_setup_policy_rejection_invalid';
  END IF;
 END IF;
 IF v_operation.provider_object_id IS NOT NULL OR v_operation.provider_secondary_object_id IS NOT NULL
    OR v_operation.provider_request_id IS NOT NULL
    OR v_request.stripe_checkout_session_id IS NOT NULL OR v_request.stripe_setup_intent_id IS NOT NULL
    OR v_request.accepted_at IS NOT NULL OR v_request.completed_at IS NOT NULL
    OR v_request.revoked_at IS NOT NULL OR v_request.superseded_at IS NOT NULL
    OR v_request.closed_at IS NOT NULL
    OR EXISTS(SELECT 1 FROM public.billing_payer_payment_consents c
      WHERE c.setup_request_id=p_setup_request_id
        AND (c.completed_at IS NOT NULL OR c.revoked_at IS NOT NULL OR c.superseded_at IS NOT NULL)) THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='billing_payer_setup_policy_rejection_invalid';
 END IF;
 UPDATE public.billing_payer_payment_consents SET superseded_at=v_now,
  revision=revision+1,updated_at=v_now WHERE setup_request_id=p_setup_request_id
  AND completed_at IS NULL AND revoked_at IS NULL AND superseded_at IS NULL;
 UPDATE public.billing_payer_setup_requests SET superseded_at=v_now,closed_at=v_now,
  close_reason_code=v_reason,provider_read_proof_sha256=v_proof,
  revision=revision+1,updated_at=v_now WHERE id=p_setup_request_id RETURNING * INTO v_request;
 UPDATE public.billing_provider_operations SET state='definitive_rejected',error_code=v_reason,
  error_summary=NULL,reconciliation_reason_code=NULL,completed_at=NULL,
  definitive_rejected_at=v_now,lease_owner=NULL,lease_acquired_at=NULL,
  lease_expires_at=NULL,revision=revision+1,updated_at=v_now
  WHERE id=p_operation_id RETURNING * INTO v_operation;
 RETURN private.billing_payer_setup_request_json_v1(v_request,'rejected')
  ||jsonb_build_object('operation',private.billing_provider_operation_json_v1(v_operation,'rejected')->'operation');
END $$;
ALTER FUNCTION public.reject_billing_payer_setup_without_provider_v1(
 UUID,UUID,UUID,UUID,UUID,TEXT,TEXT,TEXT,INTEGER,UUID,BIGINT,BIGINT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.reject_billing_payer_setup_without_provider_v1(
 UUID,UUID,UUID,UUID,UUID,TEXT,TEXT,TEXT,INTEGER,UUID,BIGINT,BIGINT)
 FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.reject_billing_payer_setup_without_provider_v1(
 UUID,UUID,UUID,UUID,UUID,TEXT,TEXT,TEXT,INTEGER,UUID,BIGINT,BIGINT) TO service_role;

CREATE FUNCTION private.koaryu_release_payer_setup_recovery_manifest_v36()
RETURNS TEXT LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_serialized TEXT;
BEGIN
 SELECT pg_get_functiondef('public.reject_billing_payer_setup_without_provider_v1(uuid,uuid,uuid,uuid,uuid,text,text,text,integer,uuid,bigint,bigint)'::regprocedure)
   ||':'||COALESCE(pg_get_constraintdef(c.oid),'') INTO v_serialized
 FROM pg_catalog.pg_constraint c
 WHERE c.conrelid='public.billing_payer_setup_requests'::regclass
   AND c.conname='billing_payer_setup_requests_close_evidence';
 RETURN '0:'||encode(extensions.digest(convert_to(COALESCE(v_serialized,''),'UTF8'),'sha256'),'hex');
END $$;
ALTER FUNCTION private.koaryu_release_payer_setup_recovery_manifest_v36() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.koaryu_release_payer_setup_recovery_manifest_v36()
 FROM PUBLIC,anon,authenticated,service_role;

CREATE TABLE private.koaryu_release_v36_expectations(
 singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK(singleton),
 recovery_manifest TEXT NOT NULL CHECK(recovery_manifest~'^0:[0-9a-f]{64}$')
);
ALTER TABLE private.koaryu_release_v36_expectations OWNER TO postgres;
ALTER TABLE private.koaryu_release_v36_expectations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE private.koaryu_release_v36_expectations FROM PUBLIC,anon,authenticated,service_role;
INSERT INTO private.koaryu_release_v36_expectations VALUES(
 true,'0:455520fff5182b12b23368da1afe60e133a01b78913fada73e8a708b94ae8dbb'
);

UPDATE private.koaryu_release_v27_expectations SET expected_sha256='517fefbb5a7f29197599a684d5998a4fd73d0547367e58e67bd59323bc1ed476'
 WHERE expectation_key='operational_contract_v27';
UPDATE private.koaryu_release_v28_expectations SET expected_sha256='9afa0fc8e7244d43a8fc65724a10fa4ea5c2ef96acd606f38f76960d47b70b02'
 WHERE expectation_key='operational_contract_v28';
UPDATE private.koaryu_release_v29_expectations SET expected_sha256='1abbf21f66bcd927d0c1adf1f16255f4d4eebd030b0685f6dd3a2891d5afb5b9'
 WHERE expectation_key='operational_contract_v29';
UPDATE private.koaryu_release_v30_expectations SET expected_sha256='846135b52d0b7784290b8428b3c1533bc3c1fd47aa5117c009516f640db979d6'
 WHERE expectation_key='operational_contract_v30';
UPDATE private.koaryu_release_v31_expectations SET expected_sha256='873f7ac7a8a0d52ffb92de8936f35c1fd2a07c1f52fe20f4b617140fc5fbccae'
 WHERE expectation_key='operational_contract_v31';
UPDATE private.koaryu_release_v31_expectations SET expected_sha256='1e2b5d81df07c4738b195f786427759efd992aa187921b182317e58185c5e566'
 WHERE expectation_key='resource_ownership_manifest_v31';
UPDATE private.koaryu_release_v31_expectations SET expected_sha256='e0e7bb51715afc4d656260a86a03f897f7f11650cef676f4dd52763daaadec61'
 WHERE expectation_key='operational_manifest_v11';
UPDATE private.koaryu_release_v31_expectations SET expected_sha256='7d55d1237d279a3a9242ccbf4ce814d54fc7eca4348295f0a125f7e8d0c9e627'
 WHERE expectation_key='operational_manifest_v12';

DO $build_v17$
DECLARE v_definition TEXT; v_state TEXT;
BEGIN
 SELECT pg_get_functiondef('public.koaryu_release_schema_preflight_v16()'::regprocedure) INTO v_definition;
 v_definition:=replace(v_definition,'CREATE OR REPLACE FUNCTION public.koaryu_release_schema_preflight_v16()','CREATE OR REPLACE FUNCTION public.koaryu_release_schema_preflight_v17()');
 v_definition:=replace(v_definition,'v_count <> 130 OR v_head <> ''20260831022021''','v_count <> 131 OR v_head <> ''20260831054918''');
 v_definition:=replace(v_definition,'migration_history_v35','migration_history_v36');
 v_definition:=replace(v_definition,'''20260830151714'',''20260831022021''','''20260830151714'',''20260831022021'',''20260831054918''');
 v_definition:=replace(v_definition,'0:9a3686c65b3709c76adddbef693fe67d9e33d9f38295f73b1e4faaa5534ab67a','0:1e2b5d81df07c4738b195f786427759efd992aa187921b182317e58185c5e566');
 v_definition:=replace(v_definition,'0:71bd6c57dd16c61d0cab4ec45f1902a1b1cdf14f85a5961880f262e5c9730738','0:517fefbb5a7f29197599a684d5998a4fd73d0547367e58e67bd59323bc1ed476');
 v_definition:=replace(v_definition,'0:f11329ea7fe8c06da904f598fdb89af7c5083449f4feb30486176cc1904c37b3','0:9afa0fc8e7244d43a8fc65724a10fa4ea5c2ef96acd606f38f76960d47b70b02');
 v_definition:=replace(v_definition,'0:5d022e3d25e3c09fd56cc80fd26ed8e6233b5ce881ddcc60b6b8593d8801190a','0:1abbf21f66bcd927d0c1adf1f16255f4d4eebd030b0685f6dd3a2891d5afb5b9');
 v_definition:=replace(v_definition,'0:12a3aea5cdfd8360926300447e0643c20b771c2ed7fa212676dbea3fbba5e905','0:846135b52d0b7784290b8428b3c1533bc3c1fd47aa5117c009516f640db979d6');
 v_definition:=replace(v_definition,'6396d71a8da8966ca50d412e6d5caccb7dc624775e69aef993b61e303f5d0400','846135b52d0b7784290b8428b3c1533bc3c1fd47aa5117c009516f640db979d6');
 v_definition:=replace(v_definition,'0:fc3b9de6660335ddaeda6100978f7bb313f01fe2a564efa3167394a54a27c476','0:873f7ac7a8a0d52ffb92de8936f35c1fd2a07c1f52fe20f4b617140fc5fbccae');
 v_definition:=replace(v_definition,'076e54d2ff5bf99ea77518a94ba88dec06bcf1f5bd472439234e8e849652f5e1','e0e7bb51715afc4d656260a86a03f897f7f11650cef676f4dd52763daaadec61');
 v_definition:=replace(v_definition,'7982677386a8df84dee019036a51b3f71952a03de147ceefc2d05f6503220a5a','7d55d1237d279a3a9242ccbf4ce814d54fc7eca4348295f0a125f7e8d0c9e627');
 SELECT count(*)::text||':'||encode(extensions.digest(convert_to(coalesce(string_agg(expectation_key||':'||expected_sha256,'|' ORDER BY expectation_key COLLATE "C"),''),'UTF8'),'sha256'),'hex') INTO v_state FROM private.koaryu_release_v27_expectations;
 v_definition:=replace(v_definition,'1:6e4238353d10a453e3a4581ff8f63a8a0310b33d404be1c6d4e0a04d5c67aa4f',v_state);
 SELECT count(*)::text||':'||encode(extensions.digest(convert_to(coalesce(string_agg(expectation_key||':'||expected_sha256,'|' ORDER BY expectation_key COLLATE "C"),''),'UTF8'),'sha256'),'hex') INTO v_state FROM private.koaryu_release_v28_expectations;
 v_definition:=replace(v_definition,'1:e57560e15d366056bd249ecf52225162403b0866c4fea4929b34c8ef84c3df11',v_state);
 SELECT count(*)::text||':'||encode(extensions.digest(convert_to(coalesce(string_agg(expectation_key||':'||expected_sha256,'|' ORDER BY expectation_key COLLATE "C"),''),'UTF8'),'sha256'),'hex') INTO v_state FROM private.koaryu_release_v29_expectations;
 v_definition:=replace(v_definition,'1:b0e1d3777d1686ff48b9f5d73a255cc1f6d6fea974736215c7c21a621dbaa1a5',v_state);
 SELECT count(*)::text||':'||encode(extensions.digest(convert_to(coalesce(string_agg(expectation_key||':'||expected_sha256,'|' ORDER BY expectation_key COLLATE "C"),''),'UTF8'),'sha256'),'hex') INTO v_state FROM private.koaryu_release_v30_expectations;
 v_definition:=replace(v_definition,'1:64daabcda5df9823fa4b32e7320e715d1d96dd0d0acc697ebed4570256655643',v_state);
 SELECT count(*)::text||':'||encode(extensions.digest(convert_to(coalesce(string_agg(expectation_key||':'||expected_sha256,'|' ORDER BY expectation_key COLLATE "C"),''),'UTF8'),'sha256'),'hex') INTO v_state FROM private.koaryu_release_v31_expectations;
 v_definition:=replace(v_definition,'1:98b3c2abb6dbe454ea0b9d84d3bdd31769f47b4fe72af9a5dcd5df476a62e443',v_state);
 v_definition:=replace(v_definition,'RETURN QUERY SELECT cardinality(v_failures) = 0,',
 $inject$IF private.koaryu_release_payer_setup_recovery_manifest_v36()
    IS DISTINCT FROM (SELECT recovery_manifest FROM private.koaryu_release_v36_expectations WHERE singleton) THEN
   v_failures:=array_append(v_failures,'payer_setup_recovery_manifest_v36');
 END IF;
 RETURN QUERY SELECT cardinality(v_failures) = 0,$inject$);
 v_definition:=replace(v_definition,'''release-db-attestation-v35''::TEXT;','''release-db-attestation-v36''::TEXT;');
 EXECUTE v_definition;
END $build_v17$;
ALTER FUNCTION public.koaryu_release_schema_preflight_v17() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.koaryu_release_schema_preflight_v17() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.koaryu_release_schema_preflight_v17() TO service_role;

CREATE OR REPLACE FUNCTION public.koaryu_release_schema_preflight_v16()
RETURNS TABLE(ready BOOLEAN,migration_count INTEGER,migration_head TEXT,pending_versions TEXT[],security_failures TEXT[],manifest_version TEXT)
LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path=pg_catalog AS $$
DECLARE v RECORD;
BEGIN
 SELECT * INTO v FROM public.koaryu_release_schema_preflight_v17();
 IF v.ready AND v.migration_count=131 AND v.migration_head='20260831054918' THEN
  RETURN QUERY SELECT true,130,'20260831022021'::TEXT,
   v.pending_versions[1:cardinality(v.pending_versions)-1],ARRAY[]::TEXT[],
   'release-db-attestation-v35'::TEXT; RETURN;
 END IF;
 RETURN QUERY SELECT false,v.migration_count,v.migration_head,v.pending_versions,
  v.security_failures,'release-db-attestation-v35'::TEXT;
END $$;
ALTER FUNCTION public.koaryu_release_schema_preflight_v16() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.koaryu_release_schema_preflight_v16() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.koaryu_release_schema_preflight_v16() TO service_role;

DO $$ BEGIN
 RAISE NOTICE 'KOARYU_V36_RECOVERY_MANIFEST=%',private.koaryu_release_payer_setup_recovery_manifest_v36();
 RAISE NOTICE 'KOARYU_V36_CONTRACT_V27=%',private.koaryu_release_operational_contract_v27();
 RAISE NOTICE 'KOARYU_V36_CONTRACT_V28=%',private.koaryu_release_operational_contract_v28();
 RAISE NOTICE 'KOARYU_V36_CONTRACT_V29=%',private.koaryu_release_operational_contract_v29();
 RAISE NOTICE 'KOARYU_V36_CONTRACT_V30=%',private.koaryu_release_operational_contract_v30();
 RAISE NOTICE 'KOARYU_V36_CONTRACT_V31=%',private.koaryu_release_operational_contract_v31();
 RAISE NOTICE 'KOARYU_V36_RESOURCE_V31=%',private.koaryu_release_resource_ownership_manifest_v31();
 RAISE NOTICE 'KOARYU_V36_MANIFEST_V11=%',private.koaryu_release_operational_manifest_v11();
 RAISE NOTICE 'KOARYU_V36_MANIFEST_V12=%',private.koaryu_release_operational_manifest_v12();
END $$;
