BEGIN;

DO $$
DECLARE
  v_ready RECORD;
  v_current_count INTEGER;
  v_current_head TEXT;
  v_v31_expectation_state TEXT;
  v_expected_v31_expectation_state TEXT;
BEGIN
  SELECT count(*)::INTEGER,max(version)
    INTO v_current_count,v_current_head
  FROM supabase_migrations.schema_migrations;
  SELECT * INTO v_ready FROM public.koaryu_release_schema_preflight_v15();
  IF v_ready.ready IS DISTINCT FROM true
     OR v_ready.migration_count<>129
     OR v_ready.migration_head<>'20260830151714'
     OR v_ready.manifest_version<>'release-db-attestation-v34'
     OR cardinality(v_ready.security_failures)<>0 THEN
    RAISE EXCEPTION 'V34 readiness contract mismatch: %',row_to_json(v_ready);
  END IF;
  IF private.koaryu_release_invoice_retry_closeout_manifest_v34()
     <>'0:d054ae0cf5ce43ce2c241ca628e0724b5239bd696c323ba9c817b8bd21ee0eec' THEN
    RAISE EXCEPTION 'V34 closeout manifest mismatch.';
  END IF;
  IF v_current_count=131 AND v_current_head='20260831054918' THEN
    IF private.koaryu_release_operational_contract_v29()
       <>'0:1abbf21f66bcd927d0c1adf1f16255f4d4eebd030b0685f6dd3a2891d5afb5b9'
       OR private.koaryu_release_operational_manifest_v10()
       <>'4f6e364fe37e1325f47e098a810daacc53175b68cb01ed5bda74103f567805c5'
       OR private.koaryu_release_payments_replay_repairs_manifest_v30()
       <>'0:508a8a5206cf3561197bf0395e5b700a1d5d2f54aae921c34ced795324643b98' THEN
      RAISE EXCEPTION 'V36 current compatibility manifests mismatch.';
    END IF;
  ELSIF private.koaryu_release_operational_contract_v29()
       <>'0:5d022e3d25e3c09fd56cc80fd26ed8e6233b5ce881ddcc60b6b8593d8801190a'
       OR private.koaryu_release_operational_manifest_v10()
       <>'a1f100a662af004ba6683ae15f0f9834493013131142612721a5b6d410971a3f'
       OR private.koaryu_release_payments_replay_repairs_manifest_v30()
       <>'0:508a8a5206cf3561197bf0395e5b700a1d5d2f54aae921c34ced795324643b98' THEN
      RAISE EXCEPTION 'V34 legacy compatibility manifests mismatch.';
  END IF;
  SELECT count(*)::TEXT||':'||encode(extensions.digest(convert_to(
        COALESCE(string_agg(expectation_key||':'||expected_sha256,'|'
          ORDER BY expectation_key COLLATE "C"),''),'UTF8'),'sha256'),'hex')
    INTO v_v31_expectation_state
  FROM private.koaryu_release_v31_expectations;
  v_expected_v31_expectation_state:=CASE
    WHEN v_current_count=131 AND v_current_head='20260831054918'
         THEN '1:3d764f9527b71e81235d6ae5dbc62047149958b39b741d63e6600f3d78a4a587'
    ELSE '1:98b3c2abb6dbe454ea0b9d84d3bdd31769f47b4fe72af9a5dcd5df476a62e443'
  END;
  IF v_v31_expectation_state IS DISTINCT FROM v_expected_v31_expectation_state THEN
    RAISE EXCEPTION 'V34 V31 compatibility expectation state mismatch.';
  END IF;
  IF position('requires_action' IN pg_get_functiondef(
       'private.recompute_billing_payment_adjustment_totals(uuid)'::regprocedure))=0
     OR position('requires_action' IN pg_get_functiondef(
       'private.enforce_billing_payment_refundable_amount_v31()'::regprocedure))=0 THEN
    RAISE EXCEPTION 'V34 refund reservation does not cover requires_action.';
  END IF;
  IF has_function_privilege('anon',
       'public.claim_billing_invoice_closeout_operation_v1(uuid,uuid,text,text,uuid,uuid,text,text,text,integer,uuid,integer)','EXECUTE')
     OR has_function_privilege('authenticated',
       'public.claim_billing_invoice_closeout_operation_v1(uuid,uuid,text,text,uuid,uuid,text,text,text,integer,uuid,integer)','EXECUTE')
     OR NOT has_function_privilege('service_role',
       'public.claim_billing_invoice_closeout_operation_v1(uuid,uuid,text,text,uuid,uuid,text,text,text,integer,uuid,integer)','EXECUTE') THEN
    RAISE EXCEPTION 'V34 closeout ACL mismatch.';
  END IF;
END;
$$;

DO $$
DECLARE
  v_admin UUID:=gen_random_uuid(); v_front UUID:=gen_random_uuid();
  v_studio UUID:=gen_random_uuid(); v_payer UUID:=gen_random_uuid();
  v_invoice UUID; v_operation UUID; v_result JSONB;
  v_type TEXT; v_resource_type TEXT; v_status TEXT;
BEGIN
  INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,
    email_confirmed_at,created_at,updated_at) VALUES
    (v_admin,'authenticated','authenticated','v34-alias-admin@example.invalid','{}','{}',now(),now(),now()),
    (v_front,'authenticated','authenticated','v34-alias-front@example.invalid','{}','{}',now(),now(),now());
  INSERT INTO public.studios(id,name,slug,owner_id)
  VALUES(v_studio,'V34 adopted alias replay',
    'v34-alias-'||replace(v_studio::TEXT,'-',''),v_admin);
  INSERT INTO public.staff_roles(studio_id,user_id,role) VALUES
    (v_studio,v_admin,'admin'),(v_studio,v_front,'front_desk');
  INSERT INTO public.studio_payment_accounts(studio_id,stripe_connected_account_id,metadata)
  VALUES(v_studio,'acct_v34aliasreplay',jsonb_build_object('connect_account_generation',1));
  INSERT INTO public.billing_payers(id,studio_id,display_name,stripe_account_id,
    stripe_customer_id,connect_account_generation)
  VALUES(v_payer,v_studio,'V34 alias payer','acct_v34aliasreplay','cus_v34aliasreplay',1);
  FOREACH v_type IN ARRAY ARRAY['invoice.finalize','invoice.void'] LOOP
    v_invoice:=gen_random_uuid();
    v_resource_type:=CASE WHEN v_type='invoice.finalize'
      THEN 'invoice_finalize' ELSE 'invoice_void' END;
    INSERT INTO public.billing_invoices(id,studio_id,payer_id,invoice_type,status,
      amount_due_cents,amount_paid_cents,amount_remaining_cents,currency,
      stripe_invoice_id,stripe_account_id,stripe_customer_id,collection_method,metadata)
    VALUES(v_invoice,v_studio,v_payer,'manual','draft',500,0,500,'usd',
      'in_'||replace(v_invoice::TEXT,'-',''),'acct_v34aliasreplay','cus_v34aliasreplay',
      'send_invoice',jsonb_build_object('connect_account_generation',1));
    v_result:=public.claim_billing_invoice_closeout_operation_v1(
      v_studio,v_admin,v_type,v_resource_type,v_invoice,v_payer,
      v_type||'-canonical-a',repeat('e',64),'acct_v34aliasreplay',1,gen_random_uuid(),30);
    v_operation:=(v_result->'operation'->>'id')::UUID;
    v_result:=public.claim_billing_invoice_closeout_operation_v1(
      v_studio,v_admin,v_type,v_resource_type,v_invoice,v_payer,
      v_type||'-adopted-b',repeat('e',64),'acct_v34aliasreplay',1,gen_random_uuid(),30);
    IF (v_result->'operation'->>'id')::UUID<>v_operation
       OR NOT EXISTS(SELECT 1 FROM public.billing_provider_operation_resource_aliases
          WHERE operation_id=v_operation AND caller_request_key=v_type||'-adopted-b') THEN
      RAISE EXCEPTION 'V34 adopted alias B was not persisted for %.',v_type;
    END IF;
    UPDATE public.billing_provider_operations SET state='completed',
      provider_request_attempt_count=1,provider_object_id='in_'||replace(v_invoice::TEXT,'-',''),
      provider_succeeded_at=clock_timestamp(),projected_at=clock_timestamp(),
      completed_at=clock_timestamp(),result_code='invoice_closeout_completed',
      lease_owner=NULL,lease_acquired_at=NULL,lease_expires_at=NULL,revision=revision+1
    WHERE id=v_operation;
    v_status:=CASE WHEN v_type='invoice.finalize' THEN 'open' ELSE 'void' END;
    UPDATE public.billing_invoices SET status=v_status WHERE id=v_invoice;
    v_result:=public.claim_billing_invoice_closeout_operation_v1(
      v_studio,v_admin,v_type,v_resource_type,v_invoice,v_payer,
      v_type||'-adopted-b',repeat('e',64),'acct_v34aliasreplay',1,gen_random_uuid(),30);
    IF v_result->>'outcome'<>'replay'
       OR (v_result->'operation'->>'id')::UUID<>v_operation
       OR v_result->'operation'->>'caller_request_key'<>v_type||'-canonical-a'
       OR v_result->'operation'->>'result_code'<>'invoice_closeout_completed' THEN
      RAISE EXCEPTION 'V34 adopted alias B terminal replay failed for %.',v_type;
    END IF;
    v_result:=public.claim_billing_invoice_closeout_operation_v1(
      v_studio,v_admin,v_type,v_resource_type,v_invoice,v_payer,
      v_type||'-canonical-a',repeat('e',64),'acct_v34aliasreplay',1,gen_random_uuid(),30);
    IF v_result->>'outcome'<>'replay' OR (v_result->'operation'->>'id')::UUID<>v_operation THEN
      RAISE EXCEPTION 'V34 canonical alias A terminal replay changed for %.',v_type;
    END IF;
    BEGIN
      PERFORM public.claim_billing_invoice_closeout_operation_v1(
        v_studio,v_admin,v_type,v_resource_type,v_invoice,v_payer,
        v_type||'-missing-c',repeat('e',64),'acct_v34aliasreplay',1,gen_random_uuid(),30);
      RAISE EXCEPTION 'V34 non-alias C was accepted for %.',v_type;
    EXCEPTION WHEN check_violation OR unique_violation THEN NULL; END;
    BEGIN
      PERFORM public.claim_billing_invoice_closeout_operation_v1(
        v_studio,v_admin,v_type,v_resource_type,gen_random_uuid(),v_payer,
        v_type||'-adopted-b',repeat('e',64),'acct_v34aliasreplay',1,gen_random_uuid(),30);
      RAISE EXCEPTION 'V34 wrong resource replay was accepted.';
    EXCEPTION WHEN unique_violation THEN NULL; END;
    BEGIN
      PERFORM public.claim_billing_invoice_closeout_operation_v1(
        v_studio,v_admin,v_type,v_resource_type,v_invoice,v_payer,
        v_type||'-adopted-b',repeat('e',64),'acct_wrong',1,gen_random_uuid(),30);
      RAISE EXCEPTION 'V34 wrong account replay was accepted.';
    EXCEPTION WHEN unique_violation THEN NULL; END;
    BEGIN
      PERFORM public.claim_billing_invoice_closeout_operation_v1(
        v_studio,v_front,v_type,v_resource_type,v_invoice,v_payer,
        v_type||'-adopted-b',repeat('e',64),'acct_v34aliasreplay',1,gen_random_uuid(),30);
      RAISE EXCEPTION 'V34 non-admin adopted replay was accepted.';
    EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  END LOOP;
END;
$$;

DO $$
DECLARE
  v_actor UUID:=gen_random_uuid(); v_studio UUID:=gen_random_uuid();
  v_payer UUID:=gen_random_uuid(); v_invoice UUID:=gen_random_uuid();
  v_claimant UUID:=gen_random_uuid(); v_foreign UUID:=gen_random_uuid();
  v_operation UUID; v_revision BIGINT; v_result JSONB;
  v_row public.billing_provider_operations%ROWTYPE;
BEGIN
  INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,
    email_confirmed_at,created_at,updated_at)
  VALUES(v_actor,'authenticated','authenticated',
    'v34-reconcile-'||replace(v_actor::TEXT,'-','')||'@example.invalid',
    '{}','{}',now(),now(),now());
  INSERT INTO public.studios(id,name,slug,owner_id)
  VALUES(v_studio,'V34 reconciliation lease',
    'v34-reconcile-'||replace(v_studio::TEXT,'-',''),v_actor);
  INSERT INTO public.staff_roles(studio_id,user_id,role)
  VALUES(v_studio,v_actor,'admin');
  INSERT INTO public.studio_payment_accounts(
    studio_id,stripe_connected_account_id,metadata)
  VALUES(v_studio,'acct_v34reconcile',
    jsonb_build_object('connect_account_generation',1));
  INSERT INTO public.billing_payers(id,studio_id,display_name,stripe_account_id,
    stripe_customer_id,connect_account_generation)
  VALUES(v_payer,v_studio,'V34 reconcile payer','acct_v34reconcile',
    'cus_v34reconcile',1);
  INSERT INTO public.billing_invoices(id,studio_id,payer_id,invoice_type,status,
    amount_due_cents,amount_paid_cents,amount_remaining_cents,currency,
    stripe_invoice_id,stripe_account_id,stripe_customer_id,collection_method,
    metadata)
  VALUES(v_invoice,v_studio,v_payer,'manual','draft',500,0,500,'usd',
    'in_v34reconcile','acct_v34reconcile','cus_v34reconcile','send_invoice',
    jsonb_build_object('connect_account_generation',1));
  v_result:=public.claim_billing_invoice_closeout_operation_v1(
    v_studio,v_actor,'invoice.finalize','invoice_finalize',v_invoice,v_payer,
    'v34-reconcile-lease',repeat('b',64),'acct_v34reconcile',1,v_claimant,30);
  v_operation:=(v_result->'operation'->>'id')::UUID;
  UPDATE public.billing_provider_operations SET
    state='reconciliation_required',provider_object_id='in_v34reconcile',
    provider_request_attempt_count=1,
    reconciliation_required_at=clock_timestamp(),
    reconciliation_reason_code='v34_fixture',lease_owner=NULL,
    lease_acquired_at=NULL,lease_expires_at=NULL,revision=revision+1
  WHERE id=v_operation RETURNING revision INTO v_revision;
  v_result:=public.claim_billing_invoice_closeout_operation_v1(
    v_studio,v_actor,'invoice.finalize','invoice_finalize',v_invoice,v_payer,
    'v34-reconcile-lease',repeat('b',64),'acct_v34reconcile',1,v_claimant,30);
  IF (v_result->'operation'->>'lease_owner')::UUID IS DISTINCT FROM v_claimant
     OR (v_result->'operation'->>'revision')::BIGINT<>v_revision+1 THEN
    RAISE EXCEPTION 'V34 cleared reconciliation lease was not acquired.';
  END IF;
  UPDATE public.billing_provider_operations SET lease_owner=v_foreign,
    lease_acquired_at=clock_timestamp(),lease_expires_at=clock_timestamp()+interval '5 minutes',
    revision=revision+1 WHERE id=v_operation RETURNING revision INTO v_revision;
  v_result:=public.claim_billing_invoice_closeout_operation_v1(
    v_studio,v_actor,'invoice.finalize','invoice_finalize',v_invoice,v_payer,
    'v34-reconcile-lease',repeat('b',64),'acct_v34reconcile',1,v_claimant,30);
  SELECT * INTO v_row FROM public.billing_provider_operations WHERE id=v_operation;
  IF v_row.lease_owner IS DISTINCT FROM v_foreign OR v_row.revision<>v_revision
     OR (v_result->'operation'->>'lease_owner')::UUID IS DISTINCT FROM v_foreign THEN
    RAISE EXCEPTION 'V34 active foreign reconciliation lease transferred.';
  END IF;
  UPDATE public.billing_provider_operations SET
    lease_acquired_at=clock_timestamp()-interval '2 minutes',
    lease_expires_at=clock_timestamp()-interval '1 minute',revision=revision+1
    WHERE id=v_operation;
  v_result:=public.claim_billing_invoice_closeout_operation_v1(
    v_studio,v_actor,'invoice.finalize','invoice_finalize',v_invoice,v_payer,
    'v34-reconcile-lease',repeat('b',64),'acct_v34reconcile',1,v_claimant,30);
  v_revision:=(v_result->'operation'->>'revision')::BIGINT;
  IF (v_result->'operation'->>'lease_owner')::UUID IS DISTINCT FROM v_claimant THEN
    RAISE EXCEPTION 'V34 expired reconciliation lease was not acquired.';
  END IF;
  v_result:=public.transition_billing_provider_operation_v1(
    v_operation,v_studio,v_actor,'invoice.finalize','v34-reconcile-lease',
    repeat('b',64),'acct_v34reconcile',1,v_claimant,v_revision,
    'provider_succeeded','in_v34reconcile');
  IF v_result->>'outcome'<>'transitioned'
     OR v_result->'operation'->>'state'<>'provider_succeeded' THEN
    RAISE EXCEPTION 'V34 reacquired reconciliation transition failed.';
  END IF;
END;
$$;

DO $$
DECLARE
  v_actor UUID:=gen_random_uuid(); v_studio UUID:=gen_random_uuid();
  v_payer UUID:=gen_random_uuid(); v_invoice UUID:=gen_random_uuid();
  v_first_lease UUID:=gen_random_uuid(); v_reclaim_lease UUID:=gen_random_uuid();
  v_operation UUID; v_base TEXT; v_result JSONB; v_released_revision BIGINT;
  v_row public.billing_provider_operations%ROWTYPE;
BEGIN
  INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,
    email_confirmed_at,created_at,updated_at)
  VALUES(v_actor,'authenticated','authenticated',
    'v34-reclaim-'||replace(v_actor::TEXT,'-','')||'@example.invalid',
    '{}','{}',now(),now(),now());
  INSERT INTO public.studios(id,name,slug,owner_id)
  VALUES(v_studio,'V34 no-ledger reclaim',
    'v34-reclaim-'||replace(v_studio::TEXT,'-',''),v_actor);
  INSERT INTO public.staff_roles(studio_id,user_id,role)
  VALUES(v_studio,v_actor,'admin');
  INSERT INTO public.studio_payment_accounts(
    studio_id,stripe_connected_account_id,metadata)
  VALUES(v_studio,'acct_v34retryreclaim',
    jsonb_build_object('connect_account_generation',2));
  INSERT INTO public.billing_payers(id,studio_id,display_name,stripe_account_id,
    stripe_customer_id,connect_account_generation)
  VALUES(v_payer,v_studio,'V34 reclaim payer','acct_v34retryreclaim',
    'cus_v34retryreclaim',2);
  INSERT INTO public.billing_invoices(id,studio_id,payer_id,status,
    amount_due_cents,amount_paid_cents,amount_remaining_cents,currency,
    stripe_invoice_id,stripe_account_id,stripe_customer_id,collection_method,
    metadata)
  VALUES(v_invoice,v_studio,v_payer,'open',500,0,500,'usd',
    'in_v34retryreclaim','acct_v34retryreclaim','cus_v34retryreclaim',
    'charge_automatically',jsonb_build_object('connect_account_generation',2));
  v_base:=private.resolve_billing_invoice_retry_identity_v33(
    NULL,v_studio,v_invoice,v_payer)->>'base_request_sha256';
  PERFORM public.finalize_billing_invoice_retry_hash_capture_v33(
    1,repeat('c',40),repeat('d',64));
  v_result:=public.claim_billing_provider_operation_resource_v1(
    v_studio,v_actor,'invoice.retry','invoice',v_invoice,v_payer,
    'v34-no-ledger-reclaim',v_base,'acct_v34retryreclaim',2,v_first_lease,30);
  v_operation:=(v_result->'operation'->>'id')::UUID;
  v_result:=public.release_billing_invoice_retry_preread_lease_v33(
    v_operation,v_studio,v_actor,'v34-no-ledger-reclaim',v_base,
    'acct_v34retryreclaim',2,v_first_lease,
    (v_result->'operation'->>'revision')::BIGINT,'provider_preread_unavailable');
  v_released_revision:=(v_result->'operation'->>'revision')::BIGINT;
  IF EXISTS(SELECT 1 FROM private.billing_invoice_retry_hash_ledger_v33
            WHERE operation_id=v_operation) THEN
    RAISE EXCEPTION 'V34 exact-base no-ledger fixture unexpectedly captured.';
  END IF;
  BEGIN
    v_result:=public.claim_billing_provider_operation_resource_v1(
      v_studio,v_actor,'invoice.retry','invoice',v_invoice,v_payer,
      'v34-no-ledger-reclaim',v_base,'acct_v34retryreclaim',2,v_reclaim_lease,30);
    IF v_result->>'outcome'<>'reclaimed' THEN
      RAISE EXCEPTION 'V34 rollback reclaim did not return reclaimed.';
    END IF;
    RAISE EXCEPTION 'v34_force_reclaim_rollback';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM<>'v34_force_reclaim_rollback' THEN RAISE; END IF;
  END;
  SELECT * INTO v_row FROM public.billing_provider_operations WHERE id=v_operation;
  IF v_row.invoice_retry_preread_released_at IS NULL
     OR v_row.lease_owner IS NOT NULL OR v_row.revision<>v_released_revision THEN
    RAISE EXCEPTION 'V34 rollback did not restore preread marker atomically.';
  END IF;
  v_result:=public.claim_billing_provider_operation_resource_v1(
    v_studio,v_actor,'invoice.retry','invoice',v_invoice,v_payer,
    'v34-no-ledger-reclaim',v_base,'acct_v34retryreclaim',2,v_reclaim_lease,30);
  SELECT * INTO v_row FROM public.billing_provider_operations WHERE id=v_operation;
  IF v_result->>'outcome'<>'reclaimed'
     OR (v_result->'operation'->>'id')::UUID<>v_operation
     OR v_row.invoice_retry_preread_released_at IS NOT NULL
     OR v_row.invoice_retry_preread_release_reason IS NOT NULL
     OR v_row.lease_owner IS DISTINCT FROM v_reclaim_lease
     OR v_row.revision<>v_released_revision+1
     OR EXISTS(SELECT 1 FROM private.billing_invoice_retry_hash_ledger_v33
               WHERE operation_id=v_operation) THEN
    RAISE EXCEPTION 'V34 same-key no-ledger reclaim contract mismatch.';
  END IF;
END;
$$;

DO $$
DECLARE
  v_admin UUID:=gen_random_uuid(); v_backup_admin UUID:=gen_random_uuid();
  v_front UUID:=gen_random_uuid();
  v_studio UUID:=gen_random_uuid(); v_payer UUID:=gen_random_uuid();
  v_invoice UUID:=gen_random_uuid(); v_operation UUID; v_result JSONB;
BEGIN
  INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,
    email_confirmed_at,created_at,updated_at) VALUES
    (v_admin,'authenticated','authenticated','v34-admin@example.invalid','{}','{}',now(),now(),now()),
    (v_backup_admin,'authenticated','authenticated','v34-backup@example.invalid','{}','{}',now(),now(),now()),
    (v_front,'authenticated','authenticated','v34-front@example.invalid','{}','{}',now(),now(),now());
  INSERT INTO public.studios(id,name,slug,owner_id)
  VALUES(v_studio,'V34 replay auth','v34-auth-'||replace(v_studio::TEXT,'-',''),v_admin);
  INSERT INTO public.staff_roles(studio_id,user_id,role) VALUES
    (v_studio,v_admin,'admin'),(v_studio,v_backup_admin,'admin'),
    (v_studio,v_front,'front_desk');
  INSERT INTO public.studio_payment_accounts(
    studio_id,stripe_connected_account_id,metadata)
  VALUES(v_studio,'acct_v34authcontract',jsonb_build_object('connect_account_generation',1));
  INSERT INTO public.billing_payers(id,studio_id,display_name,stripe_account_id,
    stripe_customer_id,connect_account_generation)
  VALUES(v_payer,v_studio,'V34 auth payer','acct_v34authcontract','cus_v34_auth',1);
  INSERT INTO public.billing_invoices(id,studio_id,payer_id,invoice_type,status,
    amount_due_cents,amount_paid_cents,amount_remaining_cents,currency,
    stripe_invoice_id,stripe_account_id,stripe_customer_id,collection_method,
    external,metadata)
  VALUES(v_invoice,v_studio,v_payer,'manual','draft',500,0,500,'usd',
    'in_v34_auth','acct_v34authcontract','cus_v34_auth','send_invoice',false,
    jsonb_build_object('connect_account_generation',1));
  v_result:=public.claim_billing_invoice_closeout_operation_v1(
    v_studio,v_admin,'invoice.finalize','invoice_finalize',v_invoice,v_payer,
    'v34-auth-replay',repeat('a',64),'acct_v34authcontract',1,gen_random_uuid(),30);
  v_operation:=(v_result->'operation'->>'id')::UUID;
  UPDATE public.billing_provider_operations SET state='definitive_rejected',
    error_code='v34_auth_fixture',definitive_rejected_at=clock_timestamp(),
    lease_owner=NULL,lease_acquired_at=NULL,lease_expires_at=NULL,
    revision=revision+1 WHERE id=v_operation;
  BEGIN
    PERFORM public.claim_billing_invoice_closeout_operation_v1(
      v_studio,v_front,'invoice.finalize','invoice_finalize',v_invoice,v_payer,
      'v34-auth-replay',repeat('a',64),'acct_v34authcontract',1,gen_random_uuid(),30);
    RAISE EXCEPTION 'V34 non-admin terminal replay was accepted.';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM<>'billing_invoice_mutation_actor_forbidden' THEN RAISE; END IF;
  END;
  UPDATE public.studios SET owner_id=v_backup_admin WHERE id=v_studio;
  UPDATE public.staff_roles SET archived_at=clock_timestamp()
   WHERE studio_id=v_studio AND user_id=v_admin;
  BEGIN
    PERFORM public.claim_billing_invoice_closeout_operation_v1(
      v_studio,v_admin,'invoice.finalize','invoice_finalize',v_invoice,v_payer,
      'v34-auth-replay',repeat('a',64),'acct_v34authcontract',1,gen_random_uuid(),30);
    RAISE EXCEPTION 'V34 removed admin terminal replay was accepted.';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM<>'billing_invoice_mutation_actor_forbidden' THEN RAISE; END IF;
  END;
  UPDATE public.staff_roles SET archived_at=NULL
   WHERE studio_id=v_studio AND user_id=v_admin;
  v_result:=public.claim_billing_invoice_closeout_operation_v1(
    v_studio,v_admin,'invoice.finalize','invoice_finalize',v_invoice,v_payer,
    'v34-auth-replay',repeat('a',64),'acct_v34authcontract',1,gen_random_uuid(),30);
  IF v_result->>'outcome'<>'replay'
     OR (v_result->'operation'->>'id')::UUID<>v_operation THEN
    RAISE EXCEPTION 'V34 valid historical admin replay changed.';
  END IF;
END;
$$;

DO $$
DECLARE
  v_owner UUID:=gen_random_uuid(); v_studio UUID:=gen_random_uuid();
  v_payer UUID:=gen_random_uuid(); v_invoice UUID:=gen_random_uuid();
  v_payment UUID:=gen_random_uuid(); v_pending UUID:=gen_random_uuid();
  v_requires_action UUID:=gen_random_uuid(); v_row public.billing_payments%ROWTYPE;
BEGIN
  INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,
    created_at,updated_at)
  VALUES(v_owner,'authenticated','authenticated',
    'v34-refund-'||replace(v_owner::TEXT,'-','')||'@example.invalid',
    '{}'::jsonb,'{}'::jsonb,now(),now());
  INSERT INTO public.studios(id,name,slug,owner_id)
  VALUES(v_studio,'V34 refund reservation','v34-refund-'||replace(v_studio::TEXT,'-',''),v_owner);
  INSERT INTO public.billing_payers(id,studio_id,display_name,billing_status,balance_cents)
  VALUES(v_payer,v_studio,'V34 payer','current',0);
  INSERT INTO public.billing_invoices(id,studio_id,payer_id,stripe_invoice_id,
    stripe_account_id,status,amount_due_cents,amount_paid_cents,
    amount_remaining_cents,currency,paid_at)
  VALUES(v_invoice,v_studio,v_payer,'in_v34_refund','acct_v34_refund','paid',
    200,200,0,'usd',now());
  SET LOCAL session_replication_role=replica;
  INSERT INTO public.billing_payments(id,studio_id,payer_id,invoice_id,
    stripe_payment_intent_id,stripe_charge_id,stripe_account_id,
    connect_account_generation,status,amount_cents,
    refunded_amount_cents,disputed_amount_cents,net_collected_amount_cents,
    refundable_amount_cents,currency,processed_at)
  VALUES(v_payment,v_studio,v_payer,v_invoice,'pi_v34_refund','ch_v34_refund',
    'acct_v34_refund',1,'succeeded',200,0,0,200,200,'usd',now());
  INSERT INTO public.billing_refunds(id,studio_id,payment_id,stripe_refund_id,
    stripe_charge_id,stripe_payment_intent_id,stripe_account_id,
    connect_account_generation,amount_cents,status)
  VALUES
    (v_pending,v_studio,v_payment,'re_v34_pending','ch_v34_refund',
      'pi_v34_refund','acct_v34_refund',1,80,'pending'),
    (v_requires_action,v_studio,v_payment,'re_v34_action','ch_v34_refund',
      'pi_v34_refund','acct_v34_refund',1,150,'requires_action');
  SET LOCAL session_replication_role=origin;
  SELECT * INTO v_row FROM public.billing_payments WHERE id=v_payment;
  IF v_row.refundable_amount_cents<>200 THEN
    RAISE EXCEPTION 'V34 stale under-reserved fixture was not stale.';
  END IF;
  PERFORM private.recompute_billing_payment_adjustment_totals(v_payment);
  SELECT * INTO v_row FROM public.billing_payments WHERE id=v_payment;
  IF v_row.gross_paid_amount_cents<>200 OR v_row.refunded_amount_cents<>0
     OR v_row.net_collected_amount_cents<>200
     OR v_row.refundable_amount_cents<>0 THEN
    RAISE EXCEPTION 'V34 pending+requires_action backfill did not clamp reservation: %',
      row_to_json(v_row);
  END IF;
END;
$$;

ROLLBACK;
