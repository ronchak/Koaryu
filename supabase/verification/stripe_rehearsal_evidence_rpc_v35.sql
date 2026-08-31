BEGIN;

DO $acl$
DECLARE v_preflight RECORD;
BEGIN
  IF has_function_privilege(
      'anon',
      'public.read_stripe_rehearsal_local_evidence_v1(uuid,text,integer,timestamptz,timestamptz,jsonb,uuid[],uuid,text[],text[])',
      'EXECUTE'
    )
    OR has_function_privilege(
      'authenticated',
      'public.read_stripe_rehearsal_local_evidence_v1(uuid,text,integer,timestamptz,timestamptz,jsonb,uuid[],uuid,text[],text[])',
      'EXECUTE'
    )
    OR NOT has_function_privilege(
      'service_role',
      'public.read_stripe_rehearsal_local_evidence_v1(uuid,text,integer,timestamptz,timestamptz,jsonb,uuid[],uuid,text[],text[])',
      'EXECUTE'
    )
    OR has_function_privilege(
      'service_role',
      'private.stripe_rehearsal_manifest_ids_v35(jsonb,text,boolean)',
      'EXECUTE'
    ) THEN
    RAISE EXCEPTION 'V35 evidence RPC ACL mismatch.';
  END IF;

  IF has_table_privilege('service_role','public.billing_provider_operations','SELECT')
    OR has_table_privilege('service_role','public.billing_provider_operation_steps','SELECT')
    OR has_table_privilege('service_role','public.billing_provider_operation_resources','SELECT')
    OR has_table_privilege('service_role','public.billing_payer_setup_requests','SELECT')
    OR has_table_privilege('service_role','public.billing_payer_payment_consents','SELECT')
    OR has_table_privilege('service_role','public.billing_enrollment_transition_intents','SELECT') THEN
    RAISE EXCEPTION 'V35 protected source direct SELECT remains available.';
  END IF;

  IF NOT has_table_privilege('service_role','public.billing_payers','SELECT')
    OR NOT has_table_privilege('service_role','public.billing_invoices','SELECT')
    OR NOT has_table_privilege('service_role','public.stripe_events','SELECT')
    OR NOT has_table_privilege('service_role','public.studio_subscriptions','SELECT')
    OR NOT has_table_privilege('service_role','public.staff_roles','SELECT')
    OR NOT has_table_privilege('service_role','public.audit_logs','SELECT') THEN
    RAISE EXCEPTION 'V35 changed a required runtime SELECT grant.';
  END IF;

  IF position(
      'SECURITY DEFINER' IN pg_get_functiondef(
        'public.read_stripe_rehearsal_local_evidence_v1(uuid,text,integer,timestamptz,timestamptz,jsonb,uuid[],uuid,text[],text[])'::regprocedure
      )
    ) = 0
    OR position(
      'SET search_path TO ''''' IN pg_get_functiondef(
        'public.read_stripe_rehearsal_local_evidence_v1(uuid,text,integer,timestamptz,timestamptz,jsonb,uuid[],uuid,text[],text[])'::regprocedure
      )
    ) = 0 THEN
    RAISE EXCEPTION 'V35 evidence RPC security definition mismatch.';
  END IF;
  IF position('migration_history_v35' IN pg_get_functiondef(
      'public.koaryu_release_schema_preflight_v16()'::regprocedure))=0
    OR position('migration_history_v34' IN pg_get_functiondef(
      'public.koaryu_release_schema_preflight_v16()'::regprocedure))<>0 THEN
    RAISE EXCEPTION 'V35 readiness diagnostics retained a stale history label.';
  END IF;
  IF private.koaryu_release_stripe_rehearsal_evidence_manifest_v35()
       IS DISTINCT FROM (SELECT evidence_manifest
                         FROM private.koaryu_release_v35_expectations
                         WHERE singleton) THEN
    RAISE EXCEPTION 'V35 evidence manifest expectation does not match the computed manifest.';
  END IF;
  SELECT * INTO v_preflight FROM public.koaryu_release_schema_preflight_v16();
  IF v_preflight.ready IS DISTINCT FROM true
    OR v_preflight.migration_count <> 130
    OR v_preflight.migration_head <> '20260831022021'
    OR cardinality(v_preflight.security_failures) <> 0
    OR v_preflight.manifest_version <> 'release-db-attestation-v35' THEN
    RAISE EXCEPTION 'V35 release preflight did not attest the exact final schema.';
  END IF;
END;
$acl$;

DO $contract$
DECLARE
  v_studio UUID := '35000000-0000-4000-8000-000000000001';
  v_actor UUID := '35000000-0000-4000-8000-000000000002';
  v_operation UUID := '35000000-0000-4000-8000-000000000003';
  v_extra_operation UUID := '35000000-0000-4000-8000-000000000004';
  v_audit UUID := '35000000-0000-4000-8000-000000000005';
  v_missing UUID := '35000000-0000-4000-8000-000000000006';
  v_extra_audit UUID := '35000000-0000-4000-8000-000000000007';
  v_started TIMESTAMPTZ := now() - interval '5 minutes';
  v_ended TIMESTAMPTZ := now() + interval '5 minutes';
  v_local_ids JSONB;
  v_result JSONB;
  v_operation_row JSONB;
BEGIN
  INSERT INTO auth.users(
    id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at
  ) VALUES (
    v_actor,'authenticated','authenticated','v35-evidence@example.invalid','{}','{}',now(),now()
  );
  INSERT INTO public.studios(id,name,slug,owner_id)
  VALUES(v_studio,'V35 evidence contract','v35-evidence-contract',v_actor);
  INSERT INTO public.staff_roles(studio_id,user_id,role)
  VALUES(v_studio,v_actor,'admin');
  INSERT INTO public.studio_payment_accounts(
    studio_id,stripe_connected_account_id,status,charges_enabled,payouts_enabled,
    details_submitted,requirements_due,metadata
  ) VALUES (
    v_studio,'acct_V35Evidence','charges_enabled',true,true,true,ARRAY[]::TEXT[],
    '{"connect_account_generation":1}'::JSONB
  );
  INSERT INTO public.studio_subscriptions(
    studio_id,status,comped,stripe_customer_id,stripe_subscription_id,metadata
  ) VALUES (
    v_studio,'active',false,'cus_V35Platform','sub_V35Platform','{}'
  );
  INSERT INTO public.audit_logs(
    id,studio_id,actor_id,action,entity_type,entity_id,metadata
  ) VALUES (
    v_audit,v_studio,v_actor,'billing.external_payment_recorded','billing',v_operation,
    '{"amount_cents":1000,"external_method":"cash"}'::JSONB
  );
  INSERT INTO public.billing_provider_operations(
    id,studio_id,actor_id,operation_type,caller_request_key,request_sha256,
    stripe_connected_account_id,connect_account_generation,state,
    provider_request_attempt_count,provider_object_id,provider_succeeded_at,
    projected_at,completed_at
  ) VALUES (
    v_operation,v_studio,v_actor,'plan.sync','raw-v35-caller-key',repeat('a',64),
    'acct_V35Evidence',1,'completed',1,'prod_V35Evidence',now(),now(),now()
  );

  v_local_ids := jsonb_build_object(
    'operations',jsonb_build_object('one',v_operation::TEXT),
    'steps','{}'::JSONB,
    'resources','{}'::JSONB,
    'setup_requests','{}'::JSONB,
    'consents','{}'::JSONB,
    'payers','{}'::JSONB,
    'plans','{}'::JSONB,
    'subscriptions','{}'::JSONB,
    'invoices','{}'::JSONB,
    'payments','{}'::JSONB,
    'refunds','{}'::JSONB,
    'disputes','{}'::JSONB,
    'transitions','{}'::JSONB,
    'webhook_events','{}'::JSONB,
    'platform_core_rows',jsonb_build_object('platform_subscription',v_studio::TEXT)
  );

  EXECUTE 'SET LOCAL ROLE service_role';
  SELECT public.read_stripe_rehearsal_local_evidence_v1(
    v_studio,'acct_V35Evidence',1,v_started,v_ended,v_local_ids,
    ARRAY[v_actor],v_audit,ARRAY[]::TEXT[],ARRAY[]::TEXT[]
  ) INTO v_result;
  EXECUTE 'RESET ROLE';

  IF v_result->>'schema_version' <> '1'
    OR v_result->>'studio_id' <> v_studio::TEXT
    OR v_result->>'stripe_account_id' <> 'acct_V35Evidence'
    OR (v_result->>'connect_account_generation')::INTEGER <> 1
    OR v_result->'local_id_bindings' IS DISTINCT FROM v_local_ids
    OR jsonb_array_length(v_result->'local_rows') <> 4 THEN
    RAISE EXCEPTION 'V35 evidence RPC happy-path envelope mismatch.';
  END IF;

  SELECT row INTO v_operation_row
  FROM jsonb_array_elements(v_result->'local_rows') row
  WHERE row->>'owner'='operations';
  IF v_operation_row IS NULL
    OR v_operation_row ? 'caller_request_key'
    OR v_operation_row->>'caller_request_key_sha256'
      <> encode(extensions.digest(convert_to('raw-v35-caller-key','UTF8'),'sha256'),'hex')
    OR position('raw-v35-caller-key' IN v_result::TEXT) <> 0 THEN
    RAISE EXCEPTION 'V35 evidence RPC leaked or omitted caller-key evidence.';
  END IF;

  BEGIN
    EXECUTE 'SET LOCAL ROLE authenticated';
    PERFORM public.read_stripe_rehearsal_local_evidence_v1(
      v_studio,'acct_V35Evidence',1,v_started,v_ended,v_local_ids,
      ARRAY[v_actor],v_audit,ARRAY[]::TEXT[],ARRAY[]::TEXT[]
    );
    EXECUTE 'RESET ROLE';
    RAISE EXCEPTION 'V35 evidence RPC accepted a non-service caller.';
  EXCEPTION WHEN insufficient_privilege THEN
    EXECUTE 'RESET ROLE';
    IF SQLERRM NOT LIKE 'permission denied for function read_stripe_rehearsal_local_evidence_v1%' THEN RAISE; END IF;
  END;

  BEGIN
    PERFORM public.read_stripe_rehearsal_local_evidence_v1(
      v_studio,'acct_Wrong',1,v_started,v_ended,v_local_ids,
      ARRAY[v_actor],v_audit,ARRAY[]::TEXT[],ARRAY[]::TEXT[]
    );
    RAISE EXCEPTION 'V35 evidence RPC accepted the wrong account.';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM <> 'stripe_rehearsal_account_identity_mismatch' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.read_stripe_rehearsal_local_evidence_v1(
      v_studio,'acct_V35Evidence',2,v_started,v_ended,v_local_ids,
      ARRAY[v_actor],v_audit,ARRAY[]::TEXT[],ARRAY[]::TEXT[]
    );
    RAISE EXCEPTION 'V35 evidence RPC accepted the wrong generation.';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM <> 'stripe_rehearsal_account_identity_mismatch' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.read_stripe_rehearsal_local_evidence_v1(
      v_studio,'acct_V35Evidence',1,v_ended,v_started,v_local_ids,
      ARRAY[v_actor],v_audit,ARRAY[]::TEXT[],ARRAY[]::TEXT[]
    );
    RAISE EXCEPTION 'V35 evidence RPC accepted an inverted window.';
  EXCEPTION WHEN invalid_parameter_value THEN
    IF SQLERRM <> 'stripe_rehearsal_manifest_invalid' THEN RAISE; END IF;
  END;

  BEGIN
    PERFORM private.stripe_rehearsal_manifest_ids_v35(
      jsonb_build_object(
        'plans',jsonb_build_object(
          'one','35000000-0000-4000-8000-000000000010',
          'two','35000000-0000-4000-8000-000000000010'
        )
      ),
      'plans',true
    );
    RAISE EXCEPTION 'V35 manifest helper accepted duplicate non-operation IDs.';
  EXCEPTION WHEN invalid_parameter_value THEN
    IF SQLERRM <> 'stripe_rehearsal_manifest_duplicate_id' THEN RAISE; END IF;
  END;

  BEGIN
    PERFORM public.read_stripe_rehearsal_local_evidence_v1(
      v_studio,'acct_V35Evidence',1,v_started,v_ended,v_local_ids,
      ARRAY[v_actor],v_audit,ARRAY[]::TEXT[],ARRAY['evt_NotManifest']
    );
    RAISE EXCEPTION 'V35 evidence RPC accepted event IDs outside the manifest.';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM <> 'stripe_rehearsal_event_inventory_mismatch' THEN RAISE; END IF;
  END;

  INSERT INTO public.audit_logs(
    id,studio_id,actor_id,action,entity_type,entity_id,metadata
  ) VALUES (
    v_extra_audit,v_studio,v_actor,'billing.external_payment_recorded','billing',
    v_operation,'{"amount_cents":1000,"external_method":"cash"}'::JSONB
  );
  BEGIN
    PERFORM public.read_stripe_rehearsal_local_evidence_v1(
      v_studio,'acct_V35Evidence',1,v_started,v_ended,v_local_ids,
      ARRAY[v_actor],v_audit,ARRAY[]::TEXT[],ARRAY[]::TEXT[]
    );
    RAISE EXCEPTION 'V35 evidence RPC accepted a duplicate external-payment audit.';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM <> 'stripe_rehearsal_audit_inventory_mismatch' THEN RAISE; END IF;
  END;
  DELETE FROM public.audit_logs WHERE id=v_extra_audit;

  INSERT INTO public.billing_provider_operations(
    id,studio_id,actor_id,operation_type,caller_request_key,request_sha256,
    stripe_connected_account_id,connect_account_generation,state,
    provider_request_attempt_count,provider_object_id,provider_succeeded_at,
    projected_at,completed_at
  ) VALUES (
    v_extra_operation,v_studio,v_actor,'plan.sync','raw-v35-extra-key',repeat('b',64),
    'acct_V35Evidence',1,'completed',1,'prod_V35Extra',now(),now(),now()
  );
  BEGIN
    PERFORM public.read_stripe_rehearsal_local_evidence_v1(
      v_studio,'acct_V35Evidence',1,v_started,v_ended,v_local_ids,
      ARRAY[v_actor],v_audit,ARRAY[]::TEXT[],ARRAY[]::TEXT[]
    );
    RAISE EXCEPTION 'V35 evidence RPC accepted an extra in-window operation.';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM <> 'stripe_rehearsal_window_inventory_mismatch' THEN RAISE; END IF;
  END;

  BEGIN
    PERFORM public.read_stripe_rehearsal_local_evidence_v1(
      v_studio,'acct_V35Evidence',1,v_started,v_ended,
      jsonb_set(v_local_ids,'{operations,one}',to_jsonb(v_missing::TEXT)),
      ARRAY[v_actor],v_audit,ARRAY[]::TEXT[],ARRAY[]::TEXT[]
    );
    RAISE EXCEPTION 'V35 evidence RPC accepted a missing manifest row.';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM <> 'stripe_rehearsal_source_inventory_mismatch' THEN RAISE; END IF;
  END;

END;
$contract$;

ROLLBACK;
