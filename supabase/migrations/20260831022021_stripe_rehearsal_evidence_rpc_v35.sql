-- V35 replaces direct collector table reads with one manifest-bound snapshot RPC.
DO $guard$
DECLARE v RECORD;
BEGIN
  SELECT * INTO v FROM public.koaryu_release_schema_preflight_v15();
  IF v.ready IS DISTINCT FROM true OR v.migration_count<>129
     OR v.migration_head<>'20260830151714'
     OR v.manifest_version<>'release-db-attestation-v34'
     OR cardinality(v.security_failures)<>0 THEN
    RAISE EXCEPTION 'Stripe rehearsal evidence V35 requires exact ready V34.';
  END IF;
END $guard$;

CREATE FUNCTION private.stripe_rehearsal_manifest_ids_v35(
  p_local_ids JSONB,p_owner TEXT,p_uuid BOOLEAN DEFAULT true
) RETURNS TEXT[] LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path='' AS $$
DECLARE v JSONB; v_ids TEXT[];
BEGIN
  v:=p_local_ids->p_owner;
  IF jsonb_typeof(v)<>'object' THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='stripe_rehearsal_manifest_invalid';
  END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(v))>64 THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='stripe_rehearsal_manifest_invalid';
  END IF;
  IF p_owner<>'operations' AND
     (SELECT count(*)<>count(DISTINCT value) FROM jsonb_each_text(v)) THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='stripe_rehearsal_manifest_duplicate_id';
  END IF;
  SELECT COALESCE(array_agg(DISTINCT value ORDER BY value),ARRAY[]::TEXT[])
    INTO v_ids FROM jsonb_each_text(v);
  IF p_uuid AND EXISTS(SELECT 1 FROM unnest(v_ids) x
    WHERE x!~'^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='stripe_rehearsal_manifest_invalid_uuid';
  END IF;
  RETURN v_ids;
END $$;
ALTER FUNCTION private.stripe_rehearsal_manifest_ids_v35(JSONB,TEXT,BOOLEAN) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.stripe_rehearsal_manifest_ids_v35(JSONB,TEXT,BOOLEAN)
 FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.read_stripe_rehearsal_local_evidence_v1(
  p_studio_id UUID,p_stripe_account_id TEXT,p_connect_account_generation INTEGER,
  p_rehearsal_started_at TIMESTAMPTZ,p_event_window_ended_at TIMESTAMPTZ,
  p_local_ids JSONB,p_actor_ids UUID[],p_external_audit_id UUID,
  p_connect_event_ids TEXT[],p_platform_event_ids TEXT[]
) RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE
  v_expected_owners CONSTANT TEXT[]:=ARRAY['operations','steps','resources','setup_requests',
    'consents','payers','plans','subscriptions','invoices','payments','refunds','disputes',
    'transitions','webhook_events','platform_core_rows'];
  v_rows JSONB; v_expected INTEGER; v_observed INTEGER;
  v_external_audit_entity UUID;
BEGIN
  IF p_stripe_account_id!~'^acct_[A-Za-z0-9]+$' OR p_connect_account_generation<1
     OR p_rehearsal_started_at>=p_event_window_ended_at
     OR p_event_window_ended_at-p_rehearsal_started_at>interval '14 days'
     OR p_actor_ids IS NULL OR cardinality(p_actor_ids) NOT BETWEEN 1 AND 16
     OR cardinality(p_actor_ids)<>cardinality(ARRAY(SELECT DISTINCT unnest(p_actor_ids)))
     OR p_connect_event_ids IS NULL OR cardinality(p_connect_event_ids)>64
     OR p_platform_event_ids IS NULL OR cardinality(p_platform_event_ids)>16
     OR cardinality(p_connect_event_ids)<>cardinality(ARRAY(SELECT DISTINCT unnest(p_connect_event_ids)))
     OR cardinality(p_platform_event_ids)<>cardinality(ARRAY(SELECT DISTINCT unnest(p_platform_event_ids)))
     OR EXISTS(SELECT 1 FROM unnest(p_connect_event_ids||p_platform_event_ids) x
               WHERE x!~'^evt_[A-Za-z0-9]+$')
     OR jsonb_typeof(p_local_ids)<>'object'
     OR ARRAY(SELECT jsonb_object_keys(p_local_ids) ORDER BY 1)
          IS DISTINCT FROM ARRAY(SELECT unnest(v_expected_owners) ORDER BY 1) THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='stripe_rehearsal_manifest_invalid';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.studio_payment_accounts a
    WHERE a.studio_id=p_studio_id AND a.stripe_connected_account_id=p_stripe_account_id
      AND COALESCE((a.metadata->>'connect_account_generation')::INTEGER,1)=p_connect_account_generation) THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='stripe_rehearsal_account_identity_mismatch';
  END IF;
  IF EXISTS(SELECT 1 FROM unnest(p_actor_ids) actor WHERE NOT EXISTS(
    SELECT 1 FROM public.staff_roles s WHERE s.studio_id=p_studio_id
      AND s.user_id=actor AND s.archived_at IS NULL)) THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='stripe_rehearsal_actor_identity_mismatch';
  END IF;
  SELECT entity_id INTO v_external_audit_entity FROM public.audit_logs
   WHERE id=p_external_audit_id AND studio_id=p_studio_id
     AND action='billing.external_payment_recorded'
     AND created_at BETWEEN p_rehearsal_started_at AND p_event_window_ended_at;
  IF v_external_audit_entity IS NULL OR (
    SELECT count(*) FROM public.audit_logs
     WHERE studio_id=p_studio_id AND action='billing.external_payment_recorded'
       AND entity_id=v_external_audit_entity
       AND created_at BETWEEN p_rehearsal_started_at AND p_event_window_ended_at
  )<>1 THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='stripe_rehearsal_audit_inventory_mismatch';
  END IF;

  WITH evidence(owner,row) AS (
    SELECT 'operations',to_jsonb(q) FROM (SELECT id,studio_id,actor_id,operation_type,
      encode(extensions.digest(convert_to(caller_request_key,'UTF8'),'sha256'),'hex') caller_request_key_sha256,
      request_sha256,stripe_connected_account_id,connect_account_generation,state,
      provider_request_attempt_count,lease_expires_at,provider_object_id,provider_secondary_object_id,
      recovery_outcome,reconciliation_required_at,definitive_failed_at,definitive_rejected_at,
      error_code,completed_at,created_at,updated_at FROM public.billing_provider_operations
      WHERE id=ANY(private.stripe_rehearsal_manifest_ids_v35(p_local_ids,'operations')::UUID[])
        AND studio_id=p_studio_id) q
    UNION ALL SELECT 'steps',to_jsonb(q) FROM (SELECT id,operation_id,studio_id,
      stripe_connected_account_id,connect_account_generation,step_order,step_name,
      provider_operation,request_sha256,
      encode(extensions.digest(convert_to(stripe_idempotency_key,'UTF8'),'sha256'),'hex') caller_request_key_sha256,
      state,provider_request_attempt_count,lease_expires_at,
      provider_object_id,provider_secondary_object_id,reconciliation_required_at,
      definitive_failed_at,definitive_rejected_at,error_code,created_at,updated_at
      FROM public.billing_provider_operation_steps WHERE id=ANY(private.stripe_rehearsal_manifest_ids_v35(p_local_ids,'steps')::UUID[]) AND studio_id=p_studio_id) q
    UNION ALL SELECT 'resources',to_jsonb(q) FROM (SELECT id,operation_id,studio_id,operation_type,
      resource_type,resource_id,payer_id,revision,created_at,updated_at
      FROM public.billing_provider_operation_resources WHERE id=ANY(private.stripe_rehearsal_manifest_ids_v35(p_local_ids,'resources')::UUID[]) AND studio_id=p_studio_id) q
    UNION ALL SELECT 'setup_requests',to_jsonb(q) FROM (SELECT id,operation_id,studio_id,payer_id,
      initiated_by,terms_version,stripe_checkout_session_id,stripe_setup_intent_id,
      stripe_connected_account_id,connect_account_generation,accepted_at,completed_at,revoked_at,
      superseded_at,revision,created_at,updated_at FROM public.billing_payer_setup_requests
      WHERE id=ANY(private.stripe_rehearsal_manifest_ids_v35(p_local_ids,'setup_requests')::UUID[]) AND studio_id=p_studio_id) q
    UNION ALL SELECT 'consents',to_jsonb(q) FROM (SELECT id,setup_request_id,studio_id,payer_id,
      terms_version,stripe_checkout_session_id,stripe_setup_intent_id,stripe_connected_account_id,
      connect_account_generation,accepted_at,completed_at,revoked_at,superseded_at,revision,created_at,updated_at
      FROM public.billing_payer_payment_consents WHERE id=ANY(private.stripe_rehearsal_manifest_ids_v35(p_local_ids,'consents')::UUID[]) AND studio_id=p_studio_id) q
    UNION ALL SELECT 'payers',to_jsonb(q) FROM (SELECT id,studio_id,stripe_customer_id,billing_status,
      balance_cents,created_at,updated_at FROM public.billing_payers WHERE id=ANY(private.stripe_rehearsal_manifest_ids_v35(p_local_ids,'payers')::UUID[]) AND studio_id=p_studio_id) q
    UNION ALL SELECT 'plans',to_jsonb(q) FROM (SELECT id,studio_id,amount_cents,currency,billing_interval,
      status,stripe_product_id,stripe_price_id,archived_at,created_at,updated_at FROM public.billing_plans
      WHERE id=ANY(private.stripe_rehearsal_manifest_ids_v35(p_local_ids,'plans')::UUID[]) AND studio_id=p_studio_id) q
    UNION ALL SELECT 'subscriptions',to_jsonb(q) FROM (SELECT id,studio_id,student_id,payer_id,
      billing_plan_id,billing_subscription_id,status,billing_status,stripe_subscription_id,
      stripe_subscription_item_id,created_at,updated_at FROM public.student_billing_enrollments
      WHERE id=ANY(private.stripe_rehearsal_manifest_ids_v35(p_local_ids,'subscriptions')::UUID[]) AND studio_id=p_studio_id) q
    UNION ALL SELECT 'invoices',to_jsonb(q) FROM (SELECT id,studio_id,payer_id,student_id,enrollment_id,
      stripe_invoice_id,stripe_account_id,stripe_customer_id,stripe_subscription_id,
      stripe_payment_intent_id,status,amount_due_cents,amount_paid_cents,amount_remaining_cents,
      currency,application_fee_amount_cents,paid_at,finalized_at,voided_at,external,created_at,updated_at
      FROM public.billing_invoices WHERE id=ANY(private.stripe_rehearsal_manifest_ids_v35(p_local_ids,'invoices')::UUID[]) AND studio_id=p_studio_id) q
    UNION ALL SELECT 'payments',to_jsonb(q) FROM (SELECT id,studio_id,payer_id,invoice_id,
      stripe_customer_id,stripe_invoice_id,stripe_payment_intent_id,stripe_charge_id,stripe_account_id,
      connect_account_generation,stripe_payment_method_id,status,amount_cents,currency,external_method,
      application_fee_amount_cents application_fee_cents,gross_paid_amount_cents gross_paid_cents,
      refunded_amount_cents refunded_cents,disputed_amount_cents disputed_cents,
      net_collected_amount_cents net_collected_cents,refundable_amount_cents refundable_remaining_cents,
      adjustment_reconciliation_required reconciliation_required,adjustment_reconciliation_reason_code,
      processed_at,encode(extensions.digest(convert_to(idempotency_key,'UTF8'),'sha256'),'hex') caller_request_key_sha256,
      request_hash,created_at,updated_at FROM public.billing_payments
      WHERE id=ANY(private.stripe_rehearsal_manifest_ids_v35(p_local_ids,'payments')::UUID[]) AND studio_id=p_studio_id) q
    UNION ALL SELECT 'refunds',to_jsonb(q) FROM (SELECT id,studio_id,payment_id,stripe_refund_id,
      stripe_charge_id,stripe_payment_intent_id,stripe_account_id,connect_account_generation,
      amount_cents,status,reconciliation_required,reconciliation_reason_code,created_at,updated_at
      FROM public.billing_refunds WHERE id=ANY(private.stripe_rehearsal_manifest_ids_v35(p_local_ids,'refunds')::UUID[]) AND studio_id=p_studio_id) q
    UNION ALL SELECT 'disputes',to_jsonb(q) FROM (SELECT id,studio_id,payment_id,stripe_dispute_id,
      stripe_charge_id,stripe_payment_intent_id,stripe_account_id,connect_account_generation,
      amount_cents,status,state_category,reconciliation_required,reconciliation_reason_code,created_at,updated_at
      FROM public.billing_disputes WHERE id=ANY(private.stripe_rehearsal_manifest_ids_v35(p_local_ids,'disputes')::UUID[]) AND studio_id=p_studio_id) q
    UNION ALL SELECT 'transitions',to_jsonb(q) FROM (SELECT id,studio_id,enrollment_id,payer_id,
      billing_subscription_id,source_intent_id,provider_operation_id,transition_kind,mutation_strategy,
      request_sha256,
      encode(extensions.digest(convert_to(provider_caller_request_key,'UTF8'),'sha256'),'hex') caller_request_key_sha256,
      provider_request_sha256,stripe_connected_account_id,
      connect_account_generation,stripe_subscription_id,stripe_subscription_item_id,period_boundary,
      expected_quantity,expected_subscription_item_count,same_item_active_count,provider_quantity,
      initiated_by,state,lease_expires_at,reconciliation_required_at,definitive_rejected_at,
      scheduled_at,due_claimed_at,provider_succeeded_at,projected_at,completed_at,revoked_at,created_at,updated_at
      FROM public.billing_enrollment_transition_intents
      WHERE id=ANY(private.stripe_rehearsal_manifest_ids_v35(p_local_ids,'transitions')::UUID[]) AND studio_id=p_studio_id) q
    UNION ALL SELECT 'webhook_events',to_jsonb(q) FROM (SELECT stripe_event_id,stripe_account_id,type,
      processing_status,livemode,processed_at,created_at,live_billing_ingest_sequence,
      error IS NOT NULL error_present,error_reference IS NOT NULL error_reference_present
      FROM public.stripe_events WHERE stripe_event_id=ANY(private.stripe_rehearsal_manifest_ids_v35(p_local_ids,'webhook_events',false))
        AND created_at BETWEEN p_rehearsal_started_at AND p_event_window_ended_at) q
    UNION ALL SELECT 'platform_core_rows',to_jsonb(q) FROM (SELECT studio_id,stripe_customer_id,
      stripe_subscription_id,status,created_at,updated_at FROM public.studio_subscriptions
      WHERE studio_id=p_studio_id) q
    UNION ALL SELECT 'staff_roles',to_jsonb(q) FROM (SELECT id,studio_id,user_id,role,created_at,
      updated_at,archived_at FROM public.staff_roles WHERE studio_id=p_studio_id
        AND user_id=ANY(p_actor_ids) AND archived_at IS NULL) q
    UNION ALL SELECT 'audit_logs',to_jsonb(q) FROM (SELECT id,studio_id,actor_id,action,entity_type,
      entity_id,(metadata->'amount_cents') audit_amount_cents,(metadata->>'external_method') audit_external_method,
      created_at FROM public.audit_logs WHERE id=p_external_audit_id AND studio_id=p_studio_id) q
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object('owner',owner)||row ORDER BY owner,
    COALESCE(row->>'id',row->>'stripe_event_id')),'[]'::JSONB),count(*) INTO v_rows,v_observed FROM evidence;

  SELECT sum(cardinality(private.stripe_rehearsal_manifest_ids_v35(
    p_local_ids,owner,owner NOT IN('webhook_events'))))
    INTO v_expected FROM unnest(v_expected_owners) owner;
  v_expected:=v_expected+cardinality(p_actor_ids)+1;
  IF v_observed<>v_expected THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='stripe_rehearsal_source_inventory_mismatch';
  END IF;
  IF ARRAY(SELECT unnest(p_connect_event_ids||p_platform_event_ids) ORDER BY 1)
       IS DISTINCT FROM private.stripe_rehearsal_manifest_ids_v35(
         p_local_ids,'webhook_events',false)
     OR ARRAY(SELECT e.stripe_event_id FROM public.stripe_events e
      WHERE e.stripe_account_id=p_stripe_account_id
        AND e.created_at BETWEEN p_rehearsal_started_at AND p_event_window_ended_at ORDER BY 1)
     IS DISTINCT FROM ARRAY(SELECT unnest(p_connect_event_ids) ORDER BY 1)
     OR EXISTS(SELECT 1 FROM public.stripe_events e WHERE e.stripe_event_id=ANY(p_platform_event_ids)
       AND (e.stripe_account_id IS NOT NULL OR e.created_at NOT BETWEEN p_rehearsal_started_at AND p_event_window_ended_at)) THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='stripe_rehearsal_event_inventory_mismatch';
  END IF;
  IF ARRAY(SELECT id::TEXT FROM public.billing_provider_operations WHERE studio_id=p_studio_id
         AND created_at>=p_rehearsal_started_at ORDER BY 1)
       IS DISTINCT FROM private.stripe_rehearsal_manifest_ids_v35(p_local_ids,'operations')
     OR ARRAY(SELECT id::TEXT FROM public.billing_provider_operation_steps WHERE studio_id=p_studio_id
         AND created_at>=p_rehearsal_started_at ORDER BY 1)
       IS DISTINCT FROM private.stripe_rehearsal_manifest_ids_v35(p_local_ids,'steps')
     OR ARRAY(SELECT id::TEXT FROM public.billing_provider_operation_resources WHERE studio_id=p_studio_id
         AND created_at>=p_rehearsal_started_at ORDER BY 1)
       IS DISTINCT FROM private.stripe_rehearsal_manifest_ids_v35(p_local_ids,'resources')
     OR ARRAY(SELECT id::TEXT FROM public.billing_payer_setup_requests WHERE studio_id=p_studio_id
         AND created_at>=p_rehearsal_started_at ORDER BY 1)
       IS DISTINCT FROM private.stripe_rehearsal_manifest_ids_v35(p_local_ids,'setup_requests')
     OR ARRAY(SELECT id::TEXT FROM public.billing_payer_payment_consents WHERE studio_id=p_studio_id
         AND created_at>=p_rehearsal_started_at ORDER BY 1)
       IS DISTINCT FROM private.stripe_rehearsal_manifest_ids_v35(p_local_ids,'consents')
     OR ARRAY(SELECT id::TEXT FROM public.student_billing_enrollments WHERE studio_id=p_studio_id
         AND created_at>=p_rehearsal_started_at ORDER BY 1)
       IS DISTINCT FROM private.stripe_rehearsal_manifest_ids_v35(p_local_ids,'subscriptions')
     OR ARRAY(SELECT id::TEXT FROM public.billing_invoices WHERE studio_id=p_studio_id
         AND created_at>=p_rehearsal_started_at ORDER BY 1)
       IS DISTINCT FROM private.stripe_rehearsal_manifest_ids_v35(p_local_ids,'invoices')
     OR ARRAY(SELECT id::TEXT FROM public.billing_payments WHERE studio_id=p_studio_id
         AND created_at>=p_rehearsal_started_at ORDER BY 1)
       IS DISTINCT FROM private.stripe_rehearsal_manifest_ids_v35(p_local_ids,'payments')
     OR ARRAY(SELECT id::TEXT FROM public.billing_refunds WHERE studio_id=p_studio_id
         AND created_at>=p_rehearsal_started_at ORDER BY 1)
       IS DISTINCT FROM private.stripe_rehearsal_manifest_ids_v35(p_local_ids,'refunds')
     OR ARRAY(SELECT id::TEXT FROM public.billing_disputes WHERE studio_id=p_studio_id
         AND created_at>=p_rehearsal_started_at ORDER BY 1)
       IS DISTINCT FROM private.stripe_rehearsal_manifest_ids_v35(p_local_ids,'disputes')
     OR ARRAY(SELECT id::TEXT FROM public.billing_enrollment_transition_intents WHERE studio_id=p_studio_id
         AND created_at>=p_rehearsal_started_at ORDER BY 1)
       IS DISTINCT FROM private.stripe_rehearsal_manifest_ids_v35(p_local_ids,'transitions') THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='stripe_rehearsal_window_inventory_mismatch';
  END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_rows) r
    WHERE COALESCE(r->>'stripe_account_id',r->>'stripe_connected_account_id',p_stripe_account_id)
      <>p_stripe_account_id
      OR COALESCE((r->>'connect_account_generation')::INTEGER,p_connect_account_generation)
      <>p_connect_account_generation) THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='stripe_rehearsal_source_identity_mismatch';
  END IF;
  RETURN jsonb_build_object('schema_version',1,'studio_id',p_studio_id,
    'stripe_account_id',p_stripe_account_id,'connect_account_generation',p_connect_account_generation,
    'rehearsal_started_at',p_rehearsal_started_at,'event_window_ended_at',p_event_window_ended_at,
    'local_id_bindings',p_local_ids,'local_rows',v_rows);
END $$;
ALTER FUNCTION public.read_stripe_rehearsal_local_evidence_v1(
 UUID,TEXT,INTEGER,TIMESTAMPTZ,TIMESTAMPTZ,JSONB,UUID[],UUID,TEXT[],TEXT[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.read_stripe_rehearsal_local_evidence_v1(
 UUID,TEXT,INTEGER,TIMESTAMPTZ,TIMESTAMPTZ,JSONB,UUID[],UUID,TEXT[],TEXT[])
 FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.read_stripe_rehearsal_local_evidence_v1(
 UUID,TEXT,INTEGER,TIMESTAMPTZ,TIMESTAMPTZ,JSONB,UUID[],UUID,TEXT[],TEXT[]) TO service_role;

CREATE FUNCTION private.koaryu_release_stripe_rehearsal_evidence_manifest_v35()
RETURNS TEXT LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_serialized TEXT;
BEGIN
  SELECT string_agg(item,';' ORDER BY item COLLATE "C") INTO v_serialized FROM (
    SELECT p.oid::regprocedure::TEXT||':'||p.prosecdef::TEXT||':'||
      COALESCE(array_to_string(p.proconfig,','),'')||':'||
      encode(extensions.digest(convert_to(pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')||':'||
      COALESCE(array_to_string(p.proacl,','),'') item
    FROM pg_catalog.pg_proc p WHERE p.oid IN (
      'private.stripe_rehearsal_manifest_ids_v35(jsonb,text,boolean)'::regprocedure,
      'public.read_stripe_rehearsal_local_evidence_v1(uuid,text,integer,timestamptz,timestamptz,jsonb,uuid[],uuid,text[],text[])'::regprocedure)
    UNION ALL
    SELECT 'runtime_select:'||c.oid::regclass::TEXT||':'||
      has_table_privilege('service_role',c.oid,'SELECT')::TEXT
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname=ANY(ARRAY[
      'billing_provider_operations','billing_provider_operation_steps',
      'billing_provider_operation_resources','billing_payer_setup_requests',
      'billing_payer_payment_consents','billing_payers','billing_plans',
      'student_billing_enrollments','billing_invoices','billing_payments','billing_refunds',
      'billing_disputes','billing_enrollment_transition_intents','stripe_events',
      'studio_subscriptions','staff_roles','audit_logs'])
  ) observed;
  RETURN '0:'||encode(extensions.digest(convert_to(COALESCE(v_serialized,''),'UTF8'),'sha256'),'hex');
END $$;
ALTER FUNCTION private.koaryu_release_stripe_rehearsal_evidence_manifest_v35() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.koaryu_release_stripe_rehearsal_evidence_manifest_v35()
 FROM PUBLIC,anon,authenticated,service_role;

CREATE TABLE private.koaryu_release_v35_expectations(
  singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK(singleton),
  evidence_manifest TEXT NOT NULL CHECK(evidence_manifest~'^0:[0-9a-f]{64}$')
);
ALTER TABLE private.koaryu_release_v35_expectations OWNER TO postgres;
ALTER TABLE private.koaryu_release_v35_expectations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE private.koaryu_release_v35_expectations
 FROM PUBLIC,anon,authenticated,service_role;
INSERT INTO private.koaryu_release_v35_expectations(singleton,evidence_manifest)
VALUES(true,'0:ab51017e560d5447369f72f9db4d7872012c59a91e9f385a7fc39e162ae1d45d');

DO $assert_v35_evidence_manifest$
DECLARE v_observed TEXT; v_expected TEXT;
BEGIN
  SELECT private.koaryu_release_stripe_rehearsal_evidence_manifest_v35(),
         evidence_manifest INTO v_observed,v_expected
  FROM private.koaryu_release_v35_expectations WHERE singleton;
  IF v_observed IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION USING ERRCODE='23514',
      MESSAGE='koaryu_v35_evidence_manifest_mismatch',
      DETAIL=format('observed=%s expected=%s',v_observed,v_expected);
  END IF;
END $assert_v35_evidence_manifest$;

DO $build_v16$
DECLARE v_definition TEXT;
BEGIN
  SELECT pg_get_functiondef('public.koaryu_release_schema_preflight_v15()'::regprocedure)
    INTO v_definition;
  v_definition:=replace(v_definition,
    'CREATE OR REPLACE FUNCTION public.koaryu_release_schema_preflight_v15()',
    'CREATE OR REPLACE FUNCTION public.koaryu_release_schema_preflight_v16()');
  v_definition:=replace(v_definition,
    'v_count <> 129 OR v_head <> ''20260830151714''',
    'v_count <> 130 OR v_head <> ''20260831022021''');
  v_definition:=replace(v_definition,
    '''20260830082610'',''20260830151714''',
    '''20260830082610'',''20260830151714'',''20260831022021''');
  v_definition:=replace(v_definition,
    'RETURN QUERY SELECT cardinality(v_failures) = 0,',
    $inject$IF private.koaryu_release_stripe_rehearsal_evidence_manifest_v35()
       IS DISTINCT FROM (SELECT evidence_manifest FROM private.koaryu_release_v35_expectations
                          WHERE singleton) THEN
      v_failures:=array_append(v_failures,'stripe_rehearsal_evidence_manifest_v35');
    END IF;
    IF has_function_privilege('anon',
      'public.read_stripe_rehearsal_local_evidence_v1(uuid,text,integer,timestamptz,timestamptz,jsonb,uuid[],uuid,text[],text[])','EXECUTE')
       OR has_function_privilege('authenticated',
      'public.read_stripe_rehearsal_local_evidence_v1(uuid,text,integer,timestamptz,timestamptz,jsonb,uuid[],uuid,text[],text[])','EXECUTE')
       OR NOT has_function_privilege('service_role',
      'public.read_stripe_rehearsal_local_evidence_v1(uuid,text,integer,timestamptz,timestamptz,jsonb,uuid[],uuid,text[],text[])','EXECUTE') THEN
      v_failures:=array_append(v_failures,'stripe_rehearsal_evidence_acl_v35');
    END IF;
    RETURN QUERY SELECT cardinality(v_failures) = 0,$inject$);
  v_definition:=replace(v_definition,
    '''release-db-attestation-v34''::TEXT;',
    '''release-db-attestation-v35''::TEXT;');
  v_definition:=replace(v_definition,'migration_history_v34','migration_history_v35');
  EXECUTE v_definition;
END $build_v16$;
ALTER FUNCTION public.koaryu_release_schema_preflight_v16() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.koaryu_release_schema_preflight_v16()
 FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.koaryu_release_schema_preflight_v16() TO service_role;

CREATE OR REPLACE FUNCTION public.koaryu_release_schema_preflight_v15()
RETURNS TABLE(ready BOOLEAN,migration_count INTEGER,migration_head TEXT,
 pending_versions TEXT[],security_failures TEXT[],manifest_version TEXT)
LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path=pg_catalog AS $$
DECLARE v RECORD;
BEGIN
  SELECT * INTO v FROM public.koaryu_release_schema_preflight_v16();
  IF v.ready AND v.migration_count=130 AND v.migration_head='20260831022021' THEN
    RETURN QUERY SELECT true,129,'20260830151714'::TEXT,
      v.pending_versions[1:cardinality(v.pending_versions)-1],ARRAY[]::TEXT[],
      'release-db-attestation-v34'::TEXT;
    RETURN;
  END IF;
  RETURN QUERY SELECT false,v.migration_count,v.migration_head,v.pending_versions,
    v.security_failures,'release-db-attestation-v34'::TEXT;
END $$;
ALTER FUNCTION public.koaryu_release_schema_preflight_v15() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.koaryu_release_schema_preflight_v15()
 FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.koaryu_release_schema_preflight_v15() TO service_role;

DO $v35_notices$ BEGIN
  RAISE NOTICE 'KOARYU_V35_EVIDENCE_MANIFEST=%',
    private.koaryu_release_stripe_rehearsal_evidence_manifest_v35();
  RAISE NOTICE 'KOARYU_V35_EXPECTATION=%',
    (SELECT evidence_manifest FROM private.koaryu_release_v35_expectations WHERE singleton);
  RAISE NOTICE 'KOARYU_V35_READINESS_TARGET=true|130|20260831022021|release-db-attestation-v35';
END $v35_notices$;
