BEGIN;

DO $$
DECLARE
    v_owner UUID := gen_random_uuid();
    v_reader UUID := gen_random_uuid();
    v_studio UUID := gen_random_uuid();
    v_payer UUID := gen_random_uuid();
    v_clear_payer UUID := gen_random_uuid();
    v_lease UUID := gen_random_uuid();
    v_recovery_lease UUID := gen_random_uuid();
    v_operation_id UUID;
    v_setup_operation UUID;
    v_setup_request UUID := gen_random_uuid();
    v_consent UUID;
    v_result JSONB;
    v_revision BIGINT;
    v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
    IF has_table_privilege('service_role', 'public.billing_provider_operations', 'SELECT,INSERT,UPDATE,DELETE')
       OR has_table_privilege('service_role', 'public.billing_payer_setup_requests', 'SELECT,INSERT,UPDATE,DELETE')
       OR has_table_privilege('service_role', 'public.billing_payer_payment_consents', 'SELECT,INSERT,UPDATE,DELETE')
       OR has_table_privilege('anon', 'public.billing_provider_operations', 'SELECT')
       OR has_table_privilege('authenticated', 'public.billing_payer_payment_consents', 'SELECT') THEN
        RAISE EXCEPTION 'Billing provider tables expose direct privileges.';
    END IF;

    IF NOT has_function_privilege(
        'service_role',
        'public.claim_billing_provider_operation_v1(uuid,uuid,text,text,text,text,integer,uuid,integer)',
        'EXECUTE'
    ) OR has_function_privilege(
        'authenticated',
        'public.claim_billing_provider_operation_v1(uuid,uuid,text,text,text,text,integer,uuid,integer)',
        'EXECUTE'
    ) OR NOT has_function_privilege(
        'service_role',
        'public.close_billing_payer_setup_request_v1(uuid,uuid,uuid,uuid,text,text,integer,text,text)',
        'EXECUTE'
    ) OR has_function_privilege(
        'anon',
        'public.close_billing_payer_setup_request_v1(uuid,uuid,uuid,uuid,text,text,integer,text,text)',
        'EXECUTE'
    ) OR has_function_privilege(
        'authenticated',
        'public.close_billing_payer_setup_request_v1(uuid,uuid,uuid,uuid,text,text,integer,text,text)',
        'EXECUTE'
    ) OR NOT has_function_privilege(
        'service_role',
        'public.disable_billing_payer_autopay_v1(uuid,uuid,uuid,timestamp with time zone,text)',
        'EXECUTE'
    ) OR has_function_privilege(
        'authenticated',
        'public.disable_billing_payer_autopay_v1(uuid,uuid,uuid,timestamp with time zone,text)',
        'EXECUTE'
    ) OR NOT has_function_privilege(
        'service_role',
        'public.reserve_billing_autopay_activation_v31(uuid,uuid,uuid,uuid,uuid,text,integer,text,text,numeric)',
        'EXECUTE'
    ) OR has_function_privilege(
        'authenticated',
        'public.reserve_billing_autopay_activation_v31(uuid,uuid,uuid,uuid,uuid,text,integer,text,text,numeric)',
        'EXECUTE'
    ) OR NOT has_function_privilege(
        'service_role',
        'public.reject_billing_autopay_activation_without_provider_v31(uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,integer,uuid,text,text,bigint)',
        'EXECUTE'
    ) OR has_function_privilege(
        'authenticated',
        'public.reject_billing_autopay_activation_without_provider_v31(uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,integer,uuid,text,text,bigint)',
        'EXECUTE'
    ) OR NOT has_function_privilege(
        'service_role',
        'public.authorize_billing_provider_operation_recovery_v2(uuid,uuid,uuid,text,text,text,text,integer,uuid,text,text,text,uuid,integer,bigint)',
        'EXECUTE'
    ) OR has_function_privilege(
        'authenticated',
        'public.authorize_billing_provider_operation_recovery_v2(uuid,uuid,uuid,text,text,text,text,integer,uuid,text,text,text,uuid,integer,bigint)',
        'EXECUTE'
    ) OR NOT has_function_privilege(
        'service_role',
        'public.mark_billing_provider_recovery_reconciliation_v2(uuid,uuid,uuid,text,text,text,text,integer,uuid,bigint,text)',
        'EXECUTE'
    ) OR NOT has_function_privilege(
        'service_role',
        'public.reject_billing_provider_recovery_source_drift_v2(uuid,uuid,uuid,text,text,text,text,integer,uuid,bigint,text)',
        'EXECUTE'
    ) THEN
        RAISE EXCEPTION 'Billing provider RPC privileges are not service-only.';
    END IF;

    INSERT INTO auth.users(id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    VALUES
        (v_owner, 'authenticated', 'authenticated', 'billing-operation-owner@example.invalid', '{}'::JSONB, '{}'::JSONB, v_now, v_now),
        (v_reader, 'authenticated', 'authenticated', 'billing-operation-reader@example.invalid', '{}'::JSONB, '{}'::JSONB, v_now, v_now);
    INSERT INTO public.studios(id, name, slug, owner_id)
    VALUES (v_studio, 'Billing operation verification', 'billing-operation-' || replace(v_studio::TEXT, '-', ''), v_owner);
    INSERT INTO public.staff_roles(studio_id, user_id, role)
    VALUES (v_studio, v_owner, 'admin'), (v_studio, v_reader, 'front_desk');
    -- Use a Stripe-shaped synthetic account so the real mapping trigger remains active.
    INSERT INTO public.studio_payment_accounts(
        studio_id, stripe_connected_account_id, metadata
    ) VALUES (
        v_studio, 'acct_OperationContract123',
        jsonb_build_object('connect_account_generation', 1)
    );
    INSERT INTO public.billing_payers(
        id, studio_id, display_name, stripe_account_id, stripe_customer_id
    ) VALUES (
        v_payer, v_studio, 'Operation payer',
        'acct_OperationContract123', 'cus_operationcontract123'
    );
    IF (SELECT connect_account_generation FROM public.billing_payers WHERE id = v_payer)
       IS NOT NULL THEN
        RAISE EXCEPTION 'V28 guessed a provider generation for a legacy payer.';
    END IF;
    BEGIN
        UPDATE public.billing_payers
        SET connect_account_generation = 0
        WHERE id = v_payer;
        RAISE EXCEPTION 'A non-positive payer provider generation was accepted.';
    EXCEPTION WHEN check_violation THEN
        IF SQLERRM <> 'billing_payer_connect_identity_incomplete' THEN RAISE; END IF;
    END;
    UPDATE public.billing_payers SET display_name = 'Operation payer legacy update'
    WHERE id = v_payer;
    IF (SELECT connect_account_generation FROM public.billing_payers WHERE id = v_payer)
       IS NOT NULL THEN
        RAISE EXCEPTION 'An unrelated legacy payer update inferred a provider generation.';
    END IF;
    BEGIN
        UPDATE public.billing_payers SET connect_account_generation = 2
        WHERE id = v_payer;
        RAISE EXCEPTION 'A stale payer generation was accepted against the current account mapping.';
    EXCEPTION WHEN check_violation THEN
        IF SQLERRM <> 'billing_payer_connect_identity_not_current' THEN RAISE; END IF;
    END;
    INSERT INTO public.billing_payers(
        id, studio_id, display_name, stripe_account_id,
        stripe_customer_id, connect_account_generation
    ) VALUES (
        v_clear_payer, v_studio, 'Clearable payer', 'acct_OperationContract123',
        'cus_clearable_contract', 1
    );
    UPDATE public.billing_payers
    SET stripe_account_id = NULL,
        stripe_customer_id = NULL,
        connect_account_generation = NULL
    WHERE id = v_clear_payer;
    IF EXISTS (
        SELECT 1 FROM public.billing_payers
        WHERE id = v_clear_payer
          AND (
            stripe_account_id IS NOT NULL
            OR stripe_customer_id IS NOT NULL
            OR connect_account_generation IS NOT NULL
          )
    ) THEN
        RAISE EXCEPTION 'Explicit payer provider identity clear was not atomic.';
    END IF;
    BEGIN
        UPDATE public.billing_payers
        SET stripe_account_id = 'acct_OperationContract123'
        WHERE id = v_clear_payer;
        RAISE EXCEPTION 'A partial payer provider identity was accepted.';
    EXCEPTION WHEN check_violation THEN
        IF SQLERRM <> 'billing_payer_connect_identity_incomplete' THEN RAISE; END IF;
    END;

    v_result := public.claim_billing_provider_operation_v1(
        v_studio, v_owner, 'invoice.create', 'invoice-operation-key', repeat('a', 64),
        'acct_OperationContract123', 1, v_lease, 30
    );
    v_operation_id := (v_result->'operation'->>'id')::UUID;
    IF v_result->>'outcome' <> 'claimed'
       OR (v_result->'operation'->>'provider_request_attempt_count')::INTEGER <> 0 THEN
        RAISE EXCEPTION 'Initial provider operation claim was not exact.';
    END IF;

    v_result := public.claim_billing_provider_operation_v1(
        v_studio, v_owner, 'invoice.create', 'invoice-operation-key', repeat('a', 64),
        'acct_OperationContract123', 1, v_lease, 30
    );
    IF v_result->>'outcome' <> 'claimed' OR (v_result->'operation'->>'id')::UUID <> v_operation_id THEN
        RAISE EXCEPTION 'Same-key replay did not return the same operation.';
    END IF;

    BEGIN
        PERFORM public.claim_billing_provider_operation_v1(
            v_studio, v_owner, 'invoice.create', 'invoice-operation-key', repeat('b', 64),
            'acct_OperationContract123', 1, v_lease, 30
        );
        RAISE EXCEPTION 'Expected same workflow key with another hash to conflict.';
    EXCEPTION WHEN unique_violation THEN
        IF SQLERRM <> 'billing_provider_operation_request_conflict' THEN RAISE; END IF;
    END;

    -- The same caller key is legal for a different product workflow.
    PERFORM public.claim_billing_provider_operation_v1(
        v_studio, v_owner, 'invoice.retry', 'invoice-operation-key', repeat('c', 64),
        'acct_OperationContract123', 1, gen_random_uuid(), 30
    );

    v_result := public.read_billing_provider_operation_v1(
        v_operation_id, v_studio, v_reader, 'invoice.create', 'invoice-operation-key',
        repeat('a', 64), 'acct_OperationContract123', 1
    );
    IF v_result->>'outcome' <> 'read' OR (v_result->'operation'->>'actor_id')::UUID <> v_owner THEN
        RAISE EXCEPTION 'Active Front Desk readback did not preserve original actor evidence.';
    END IF;

    v_revision := (v_result->'operation'->>'revision')::BIGINT;
    v_result := public.transition_billing_provider_operation_v1(
        p_operation_id => v_operation_id,
        p_studio_id => v_studio,
        p_actor_id => v_owner,
        p_operation_type => 'invoice.create',
        p_caller_request_key => 'invoice-operation-key',
        p_request_sha256 => repeat('a', 64),
        p_stripe_connected_account_id => 'acct_OperationContract123',
        p_connect_account_generation => 1,
        p_lease_owner => v_lease,
        p_expected_revision => v_revision,
        p_to_state => 'provider_request_in_flight'
    );
    IF (v_result->'operation'->>'provider_request_attempt_count')::INTEGER <> 1 THEN
        RAISE EXCEPTION 'First provider request attempt was not recorded.';
    END IF;
    IF (public.claim_billing_provider_operation_v1(
        v_studio, v_owner, 'invoice.create', 'invoice-operation-key', repeat('a', 64),
        'acct_OperationContract123', 1, gen_random_uuid(), 30
    )->>'outcome') <> 'provider_request_in_flight' THEN
        RAISE EXCEPTION 'Ambiguous in-flight operation was automatically re-leased.';
    END IF;

    v_revision := (v_result->'operation'->>'revision')::BIGINT;
    v_result := public.authorize_billing_provider_operation_recovery_v1(
        v_operation_id, v_studio, v_owner, 'invoice.create', 'invoice-operation-key', repeat('a', 64),
        'acct_OperationContract123', 1, v_owner, repeat('d', 64),
        'provider_no_object_safe_to_retry', v_recovery_lease, 30, v_revision
    );
    v_revision := (v_result->'operation'->>'revision')::BIGINT;
    v_result := public.transition_billing_provider_operation_v1(
        p_operation_id => v_operation_id, p_studio_id => v_studio, p_actor_id => v_owner,
        p_operation_type => 'invoice.create', p_caller_request_key => 'invoice-operation-key',
        p_request_sha256 => repeat('a', 64), p_stripe_connected_account_id => 'acct_OperationContract123',
        p_connect_account_generation => 1, p_lease_owner => v_recovery_lease,
        p_expected_revision => v_revision, p_to_state => 'provider_request_in_flight'
    );
    IF (v_result->'operation'->>'provider_request_attempt_count')::INTEGER <> 2 THEN
        RAISE EXCEPTION 'Proof-authorized provider retry was not recorded as attempt two.';
    END IF;
    BEGIN
        PERFORM public.authorize_billing_provider_operation_recovery_v1(
            v_operation_id, v_studio, v_owner, 'invoice.create', 'invoice-operation-key', repeat('a', 64),
            'acct_OperationContract123', 1, v_owner, repeat('e', 64),
            'provider_no_object_safe_to_retry', gen_random_uuid(), 30,
            (v_result->'operation'->>'revision')::BIGINT
        );
        RAISE EXCEPTION 'Expected a third provider attempt authorization to fail.';
    EXCEPTION WHEN check_violation THEN
        IF SQLERRM <> 'billing_provider_operation_retry_limit_reached' THEN RAISE; END IF;
    END;

    v_lease:=gen_random_uuid();
    v_recovery_lease:=gen_random_uuid();
    v_result:=public.claim_billing_provider_operation_resource_v1(
        v_studio,v_owner,'payer.sync','payer',v_payer,v_payer,
        'payer-recovery-v2',repeat('6',64),'acct_OperationContract123',1,
        v_lease,30
    );
    v_operation_id:=(v_result->'operation'->>'id')::UUID;
    v_result:=public.transition_billing_provider_operation_v1(
        v_operation_id,v_studio,v_owner,'payer.sync',
        v_result->>'canonical_caller_request_key',repeat('6',64),
        'acct_OperationContract123',1,v_lease,
        (v_result->'operation'->>'revision')::BIGINT,
        'provider_request_in_flight',NULL,NULL,NULL,
        'payer_sync_update_started',
        'sync_mode:update:target_customer_id:cus_operationcontract123',NULL,NULL,NULL
    );
    v_result:=public.transition_billing_provider_operation_v1(
        v_operation_id,v_studio,v_owner,'payer.sync','payer-recovery-v2',
        repeat('6',64),'acct_OperationContract123',1,v_lease,
        (v_result->'operation'->>'revision')::BIGINT,
        'reconciliation_required',NULL,NULL,NULL,NULL,NULL,NULL,NULL,
        'payer_sync_provider_outcome_ambiguous'
    );
    v_result:=public.authorize_billing_provider_operation_recovery_v2(
        v_operation_id,v_studio,v_owner,'payer.sync','payer-recovery-v2',
        repeat('6',64),'acct_OperationContract123',1,v_owner,repeat('7',64),
        'provider_no_object_safe_to_retry',NULL,v_recovery_lease,30,
        (v_result->'operation'->>'revision')::BIGINT
    );
    IF v_result->'operation'->>'state'<>'recovery_authorized'
       OR (v_result->'operation'->>'provider_request_attempt_count')::INTEGER<>1
       OR v_result->'operation'->>'provider_object_id' IS NOT NULL THEN
        RAISE EXCEPTION 'V2 no-object recovery evidence did not converge.';
    END IF;
    IF public.authorize_billing_provider_operation_recovery_v2(
        v_operation_id,v_studio,v_owner,'payer.sync','payer-recovery-v2',
        repeat('6',64),'acct_OperationContract123',1,v_owner,repeat('7',64),
        'provider_no_object_safe_to_retry',NULL,v_recovery_lease,30,
        (v_result->'operation'->>'revision')::BIGINT
    )->>'outcome'<>'replay' THEN
        RAISE EXCEPTION 'Exact V2 recovery authorization did not replay.';
    END IF;
    BEGIN
        PERFORM public.claim_billing_provider_operation_resource_v1(
            v_studio,v_owner,'payer.sync','payer',v_payer,v_payer,
            'payer-recovery-v2-alias',repeat('6',64),
            'acct_OperationContract123',1,gen_random_uuid(),30
        );
        RAISE EXCEPTION 'New alias entered an authorized recovery.';
    EXCEPTION WHEN lock_not_available THEN
        IF SQLERRM<>'billing_provider_operation_recovery_in_progress' THEN RAISE; END IF;
    END;
    v_result:=public.transition_billing_provider_operation_v1(
        v_operation_id,v_studio,v_owner,'payer.sync','payer-recovery-v2',
        repeat('6',64),'acct_OperationContract123',1,v_recovery_lease,
        (v_result->'operation'->>'revision')::BIGINT,
        'provider_request_in_flight',NULL,NULL,NULL,
        'payer_sync_update_started',
        'sync_mode:update:target_customer_id:cus_operationcontract123',NULL,NULL,NULL
    );
    IF (v_result->'operation'->>'provider_request_attempt_count')::INTEGER<>2 THEN
        RAISE EXCEPTION 'V2 safe retry did not CAS to attempt two.';
    END IF;

    UPDATE public.billing_provider_operations
    SET state='reconciliation_required',provider_request_attempt_count=1,
        provider_request_in_flight_at=v_now,reconciliation_required_at=v_now,
        reconciliation_reason_code='payer_sync_provider_outcome_ambiguous',
        provider_object_id=NULL,lease_owner=NULL,lease_acquired_at=NULL,
        lease_expires_at=NULL,revision=revision+1,updated_at=clock_timestamp()
    WHERE id=v_operation_id;
    SELECT revision INTO v_revision FROM public.billing_provider_operations
    WHERE id=v_operation_id;
    BEGIN
        PERFORM public.authorize_billing_provider_operation_recovery_v2(
            v_operation_id,v_studio,v_owner,'payer.sync','payer-recovery-v2',
            repeat('6',64),'acct_OperationContract123',1,v_owner,repeat('8',64),
            'provider_succeeded_reconcile_only','cusXbad',v_recovery_lease,30,
            v_revision
        );
        RAISE EXCEPTION 'V2 accepted a wildcard-like recovered customer ID.';
    EXCEPTION WHEN check_violation THEN
        IF SQLERRM<>'billing_provider_operation_reconcile_evidence_invalid' THEN RAISE; END IF;
    END;
    UPDATE public.billing_provider_operations
    SET result_summary='sync_mode:tampered',revision=revision+1,
        updated_at=clock_timestamp() WHERE id=v_operation_id;
    SELECT revision INTO v_revision FROM public.billing_provider_operations
    WHERE id=v_operation_id;
    BEGIN
        PERFORM public.authorize_billing_provider_operation_recovery_v2(
            v_operation_id,v_studio,v_owner,'payer.sync','payer-recovery-v2',
            repeat('6',64),'acct_OperationContract123',1,v_owner,repeat('8',64),
            'provider_no_object_safe_to_retry',NULL,v_recovery_lease,30,v_revision
        );
        RAISE EXCEPTION 'V2 accepted malformed saved payer mode.';
    EXCEPTION WHEN check_violation THEN
        IF SQLERRM<>'billing_provider_operation_recovery_saved_evidence_invalid' THEN RAISE; END IF;
    END;
    UPDATE public.billing_provider_operations
    SET result_summary='sync_mode:update:target_customer_id:cus_operationcontract123',
        provider_secondary_object_id='seti_bad',
        revision=revision+1,updated_at=clock_timestamp() WHERE id=v_operation_id;
    SELECT revision INTO v_revision FROM public.billing_provider_operations
    WHERE id=v_operation_id;
    BEGIN
        PERFORM public.authorize_billing_provider_operation_recovery_v2(
            v_operation_id,v_studio,v_owner,'payer.sync','payer-recovery-v2',
            repeat('6',64),'acct_OperationContract123',1,v_owner,repeat('8',64),
            'provider_succeeded_reconcile_only','cus_recovered',v_recovery_lease,30,
            v_revision
        );
        RAISE EXCEPTION 'V2 accepted reconcile-only with a secondary object.';
    EXCEPTION WHEN check_violation THEN
        IF SQLERRM<>'billing_provider_operation_reconcile_evidence_invalid' THEN RAISE; END IF;
    END;
    UPDATE public.billing_provider_operations
    SET provider_secondary_object_id=NULL,revision=revision+1,
        updated_at=clock_timestamp() WHERE id=v_operation_id;
    SELECT revision INTO v_revision FROM public.billing_provider_operations
    WHERE id=v_operation_id;
    v_result:=public.authorize_billing_provider_operation_recovery_v2(
        v_operation_id,v_studio,v_owner,'payer.sync','payer-recovery-v2',
        repeat('6',64),'acct_OperationContract123',1,v_owner,repeat('8',64),
        'provider_succeeded_reconcile_only','cus_recovered',v_recovery_lease,30,
        v_revision
    );
    IF v_result->'operation'->>'provider_object_id'<>'cus_recovered' THEN
        RAISE EXCEPTION 'V2 reconcile-only did not bind recovered object.';
    END IF;
    v_result:=public.mark_billing_provider_recovery_reconciliation_v2(
        v_operation_id,v_studio,v_owner,'payer.sync','payer-recovery-v2',
        repeat('6',64),'acct_OperationContract123',1,v_recovery_lease,
        (v_result->'operation'->>'revision')::BIGINT,
        'payer_sync_recovered_customer_mismatch'
    );
    IF v_result->'operation'->>'state'<>'reconciliation_required' THEN
        RAISE EXCEPTION 'Reconcile-only readback failure did not return to reconciliation.';
    END IF;
    v_operation_id:=gen_random_uuid();
    INSERT INTO public.billing_provider_operations(
        id,studio_id,actor_id,operation_type,caller_request_key,request_sha256,
        stripe_connected_account_id,connect_account_generation,state,
        provider_request_attempt_count,provider_request_in_flight_at,
        reconciliation_required_at,reconciliation_reason_code,
        provider_step_plan_sha256,provider_step_expected_count,
        provider_step_plan_registered_at,started_at,created_at,updated_at
    ) VALUES(
        v_operation_id,v_studio,v_owner,'plan.sync','stepped-parent-recovery',
        repeat('9',64),'acct_OperationContract123',1,'reconciliation_required',1,
        v_now,v_now,'provider_outcome_ambiguous',repeat('a',64),2,v_now,
        v_now,v_now,v_now
    );
    BEGIN
        PERFORM public.authorize_billing_provider_operation_recovery_v2(
            v_operation_id,v_studio,v_owner,'plan.sync','stepped-parent-recovery',
            repeat('9',64),'acct_OperationContract123',1,v_owner,repeat('a',64),
            'provider_no_object_safe_to_retry',NULL,gen_random_uuid(),30,1
        );
        RAISE EXCEPTION 'Generic recovery accepted a stepped parent.';
    EXCEPTION WHEN check_violation THEN
        IF SQLERRM<>'billing_provider_operation_parent_step_recovery_denied' THEN RAISE; END IF;
    END;

    BEGIN
        PERFORM public.claim_billing_provider_operation_v1(
            v_studio, v_owner, 'enrollment.cancel.immediate', 'reserved-cancel-key', repeat('f', 64),
            'acct_OperationContract123', 1, gen_random_uuid(), 30
        );
        RAISE EXCEPTION 'Expected reserved cancellation workflow to remain unavailable.';
    EXCEPTION WHEN feature_not_supported THEN
        IF SQLERRM <> 'billing_provider_operation_reserved' THEN RAISE; END IF;
    END;

    v_result := public.claim_billing_provider_operation_v1(
        v_studio, v_owner, 'payer.setup', 'payer-setup-key', repeat('1', 64),
        'acct_OperationContract123', 1, v_lease, 30
    );
    v_setup_operation := (v_result->'operation'->>'id')::UUID;
    v_revision := (v_result->'operation'->>'revision')::BIGINT;
    v_result := public.prepare_billing_payer_setup_request_v1(
        v_setup_operation, v_setup_request, v_studio, v_owner, v_payer,
        'terms-2026-08', 'acct_OperationContract123', 1, v_lease, v_revision,
        v_now + interval '30 minutes'
    );
    IF v_result->>'outcome' <> 'prepared' OR (v_result->'setup_request'->>'id')::UUID <> v_setup_request THEN
        RAISE EXCEPTION 'Setup request was not created before provider mutation.';
    END IF;
    v_result := public.transition_billing_provider_operation_v1(
        p_operation_id => v_setup_operation, p_studio_id => v_studio, p_actor_id => v_owner,
        p_operation_type => 'payer.setup', p_caller_request_key => 'payer-setup-key',
        p_request_sha256 => repeat('1', 64), p_stripe_connected_account_id => 'acct_OperationContract123',
        p_connect_account_generation => 1, p_lease_owner => v_lease,
        p_expected_revision => v_revision, p_to_state => 'provider_request_in_flight'
    );
    v_revision := (v_result->'operation'->>'revision')::BIGINT;
    v_result := public.transition_billing_provider_operation_v1(
        p_operation_id => v_setup_operation, p_studio_id => v_studio, p_actor_id => v_owner,
        p_operation_type => 'payer.setup', p_caller_request_key => 'payer-setup-key',
        p_request_sha256 => repeat('1', 64), p_stripe_connected_account_id => 'acct_OperationContract123',
        p_connect_account_generation => 1, p_lease_owner => v_lease,
        p_expected_revision => v_revision, p_to_state => 'provider_succeeded',
        p_provider_object_id => 'cs_test_operation_contract'
    );
    PERFORM public.bind_billing_payer_setup_session_v1(
        v_setup_request, v_setup_operation, v_studio, v_payer,
        'cs_test_operation_contract', 'acct_OperationContract123', 1, 1
    );
    v_result := public.accept_billing_payer_payment_consent_v1(
        v_setup_request, v_studio, v_payer, 'terms-2026-08',
        'cs_test_operation_contract', 'acct_OperationContract123', 1,
        repeat('2', 64), v_now + interval '1 minute'
    );
    v_consent := (v_result->'consent'->>'id')::UUID;
    v_result := public.complete_billing_payer_payment_consent_v1(
        v_consent, v_setup_request, v_setup_operation,
        'cs_test_operation_contract', 'seti_test_operation_contract',
        'acct_OperationContract123', 1, v_now + interval '2 minutes'
    );
    IF v_result->'operation'->>'state' <> 'projected' THEN
        RAISE EXCEPTION 'Consent completion claimed local payer projection was complete.';
    END IF;
    v_result := public.mark_billing_payer_setup_reconciliation_v1(
        v_setup_request, v_setup_operation,
        'cs_test_operation_contract', 'seti_test_operation_contract',
        'acct_OperationContract123', 1, 'payer_projection_update_failed'
    );
    IF v_result->>'outcome' <> 'reconciliation_required'
       OR v_result->'operation'->>'state' <> 'reconciliation_required'
       OR NOT EXISTS (
            SELECT 1
            FROM public.billing_payer_setup_requests request
            JOIN public.billing_payer_payment_consents consent
              ON consent.setup_request_id = request.id
            WHERE request.id = v_setup_request
              AND request.completed_at IS NOT NULL
              AND consent.id = v_consent
              AND consent.completed_at IS NOT NULL
       ) THEN
        RAISE EXCEPTION 'Projected reconciliation did not preserve completed setup and consent evidence.';
    END IF;
    IF public.mark_billing_payer_setup_reconciliation_v1(
        v_setup_request, v_setup_operation,
        'cs_test_operation_contract', 'seti_test_operation_contract',
        'acct_OperationContract123', 1, 'payer_projection_update_failed'
    )->>'outcome' <> 'replay' THEN
        RAISE EXCEPTION 'Exact projected reconciliation did not replay.';
    END IF;
    v_revision := (v_result->'operation'->>'revision')::BIGINT;
    v_result := public.transition_billing_provider_operation_v1(
        p_operation_id => v_setup_operation, p_studio_id => v_studio, p_actor_id => v_owner,
        p_operation_type => 'payer.setup', p_caller_request_key => 'payer-setup-key',
        p_request_sha256 => repeat('1', 64), p_stripe_connected_account_id => 'acct_OperationContract123',
        p_connect_account_generation => 1, p_lease_owner => v_lease,
        p_expected_revision => v_revision, p_to_state => 'projected',
        p_provider_object_id => 'cs_test_operation_contract',
        p_provider_secondary_object_id => 'seti_test_operation_contract'
    );
    BEGIN
        PERFORM public.finalize_billing_payer_setup_projection_v1(
            v_consent, v_setup_request, v_setup_operation, v_studio, v_payer,
            'cs_test_operation_contract', 'seti_test_operation_contract',
            'acct_OperationContract123', 1
        );
        RAISE EXCEPTION 'Expected finalization before payer projection to fail.';
    EXCEPTION WHEN object_not_in_prerequisite_state THEN
        IF SQLERRM <> 'billing_payer_setup_projection_not_converged' THEN RAISE; END IF;
    END;
    UPDATE public.billing_payers
    SET default_payment_method_id = 'pm_test_operation_contract',
        autopay_status = 'enabled',
        autopay_authorized_at = v_now + interval '2 minutes',
        autopay_terms_accepted_at = v_now + interval '1 minute'
    WHERE id = v_payer;
    BEGIN
        PERFORM public.finalize_billing_payer_setup_projection_v1(
            v_consent, v_setup_request, v_setup_operation, v_studio, v_payer,
            'cs_test_operation_contract', 'seti_test_operation_contract',
            'acct_wrong_operation_contract', 1
        );
        RAISE EXCEPTION 'Payer setup finalization accepted the wrong connected account.';
    EXCEPTION WHEN check_violation THEN
        IF SQLERRM <> 'billing_payer_setup_projection_identity_mismatch' THEN RAISE; END IF;
    END;
    BEGIN
        PERFORM public.finalize_billing_payer_setup_projection_v1(
            v_consent, v_setup_request, v_setup_operation, v_studio, v_payer,
            'cs_test_operation_contract', 'seti_test_operation_contract',
            'acct_OperationContract123', 2
        );
        RAISE EXCEPTION 'Payer setup finalization accepted the wrong account generation.';
    EXCEPTION WHEN check_violation THEN
        IF SQLERRM <> 'billing_payer_setup_projection_identity_mismatch' THEN RAISE; END IF;
    END;
    v_result := public.finalize_billing_payer_setup_projection_v1(
        v_consent, v_setup_request, v_setup_operation, v_studio, v_payer,
        'cs_test_operation_contract', 'seti_test_operation_contract',
        'acct_OperationContract123', 1
    );
    IF v_result->'operation'->>'state' <> 'completed'
       OR (SELECT connect_account_generation FROM public.billing_payers WHERE id = v_payer) <> 1
       OR (public.read_active_billing_payer_payment_consent_v1(
            v_studio, v_payer, 'terms-2026-08', 'acct_OperationContract123', 1
          )->'consent'->>'id')::UUID <> v_consent THEN
        RAISE EXCEPTION 'Payer setup did not converge with exact provider generation evidence.';
    END IF;
    IF public.finalize_billing_payer_setup_projection_v1(
        v_consent, v_setup_request, v_setup_operation, v_studio, v_payer,
        'cs_test_operation_contract', 'seti_test_operation_contract',
        'acct_OperationContract123', 1
    )->>'outcome' <> 'replay' THEN
        RAISE EXCEPTION 'Exact payer generation finalization did not replay.';
    END IF;
    UPDATE public.studio_payment_accounts
    SET metadata = jsonb_build_object('connect_account_generation', 2)
    WHERE studio_id = v_studio;
    UPDATE public.billing_payers SET connect_account_generation = 2 WHERE id = v_payer;
    BEGIN
        PERFORM public.finalize_billing_payer_setup_projection_v1(
            v_consent, v_setup_request, v_setup_operation, v_studio, v_payer,
            'cs_test_operation_contract', 'seti_test_operation_contract',
            'acct_OperationContract123', 1
        );
        RAISE EXCEPTION 'Completed setup replay overwrote a conflicting payer generation.';
    EXCEPTION WHEN check_violation THEN
        IF SQLERRM <> 'billing_payer_connect_identity_not_current' THEN RAISE; END IF;
    END;
    UPDATE public.studio_payment_accounts
    SET metadata = jsonb_build_object('connect_account_generation', 1)
    WHERE studio_id = v_studio;
    UPDATE public.billing_payers SET connect_account_generation = 1 WHERE id = v_payer;

    v_result := public.mark_billing_payer_setup_reconciliation_v1(
        v_setup_request, v_setup_operation,
        'cs_test_operation_contract', 'seti_test_operation_contract',
        'acct_OperationContract123', 1, 'completed_consent_payment_method_missing'
    );
    IF v_result->'operation'->>'state' <> 'reconciliation_required'
       OR v_result->'operation'->>'completed_at' IS NOT NULL
       OR NOT EXISTS (
            SELECT 1
            FROM public.billing_payer_setup_requests request
            JOIN public.billing_payer_payment_consents consent
              ON consent.setup_request_id = request.id
            WHERE request.id = v_setup_request
              AND request.completed_at IS NOT NULL
              AND consent.id = v_consent
              AND consent.completed_at IS NOT NULL
       ) THEN
        RAISE EXCEPTION 'Completed reconciliation lost durable payer consent evidence.';
    END IF;
    IF public.mark_billing_payer_setup_reconciliation_v1(
        v_setup_request, v_setup_operation,
        'cs_test_operation_contract', 'seti_test_operation_contract',
        'acct_OperationContract123', 1, 'completed_consent_payment_method_missing'
    )->>'outcome' <> 'replay' THEN
        RAISE EXCEPTION 'Exact completed reconciliation did not replay.';
    END IF;

    PERFORM public.revoke_billing_payer_payment_consent_v1(
        v_consent, v_studio, v_payer, 'acct_OperationContract123', 1,
        v_now + interval '3 minutes', v_owner, 'payer_requested_revocation', NULL
    );
    IF NOT EXISTS (
        SELECT 1 FROM public.billing_payer_payment_consents
        WHERE id = v_consent AND revoked_by = v_owner
          AND revocation_reason_code = 'payer_requested_revocation'
    ) OR (SELECT connect_account_generation FROM public.billing_payers WHERE id = v_payer) <> 1 THEN
        RAISE EXCEPTION 'Consent revocation did not preserve actor, reason, and payer generation.';
    END IF;
END;
$$;

DO $$
DECLARE
    v_owner UUID := gen_random_uuid();
    v_studio UUID := gen_random_uuid();
    v_payer UUID := gen_random_uuid();
    v_lease UUID := gen_random_uuid();
    v_operation UUID;
    v_replacement_operation UUID;
    v_final_operation UUID;
    v_request UUID := gen_random_uuid();
    v_replacement_request UUID := gen_random_uuid();
    v_final_request UUID := gen_random_uuid();
    v_revision BIGINT;
    v_short_expiry TIMESTAMPTZ;
    v_result JSONB;
    v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
    INSERT INTO auth.users(id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    VALUES (
        v_owner, 'authenticated', 'authenticated',
        'billing-setup-close-owner@example.invalid', '{}'::JSONB, '{}'::JSONB,
        v_now, v_now
    );
    INSERT INTO public.studios(id, name, slug, owner_id)
    VALUES (
        v_studio, 'Billing setup close verification',
        'billing-setup-close-' || replace(v_studio::TEXT, '-', ''), v_owner
    );
    INSERT INTO public.staff_roles(studio_id, user_id, role)
    VALUES (v_studio, v_owner, 'admin');
    INSERT INTO public.billing_payers(id, studio_id, display_name, stripe_account_id)
    VALUES (v_payer, v_studio, 'Setup close payer', 'acct_setup_close_contract');

    v_result := public.claim_billing_provider_operation_v1(
        v_studio, v_owner, 'payer.setup', 'setup-close-key', repeat('3', 64),
        'acct_setup_close_contract', 1, v_lease, 30
    );
    v_operation := (v_result->'operation'->>'id')::UUID;
    v_revision := (v_result->'operation'->>'revision')::BIGINT;
    PERFORM public.prepare_billing_payer_setup_request_v1(
        v_operation, v_request, v_studio, v_owner, v_payer,
        'terms-close-2026-08', 'acct_setup_close_contract', 1,
        v_lease, v_revision, v_now + interval '30 minutes'
    );
    v_result := public.transition_billing_provider_operation_v1(
        p_operation_id => v_operation, p_studio_id => v_studio, p_actor_id => v_owner,
        p_operation_type => 'payer.setup', p_caller_request_key => 'setup-close-key',
        p_request_sha256 => repeat('3', 64),
        p_stripe_connected_account_id => 'acct_setup_close_contract',
        p_connect_account_generation => 1, p_lease_owner => v_lease,
        p_expected_revision => v_revision, p_to_state => 'provider_request_in_flight'
    );
    BEGIN
        PERFORM public.close_billing_payer_setup_request_v1(
            v_request, v_operation, v_studio, v_payer,
            'cs_setup_close_contract', 'acct_setup_close_contract', 1,
            'checkout_session_expired', repeat('4', 64)
        );
        RAISE EXCEPTION 'In-flight payer setup was closed without definitive provider readback.';
    EXCEPTION WHEN check_violation THEN
        IF SQLERRM <> 'billing_payer_setup_close_invalid' THEN RAISE; END IF;
    END;

    v_revision := (v_result->'operation'->>'revision')::BIGINT;
    v_result := public.transition_billing_provider_operation_v1(
        p_operation_id => v_operation, p_studio_id => v_studio, p_actor_id => v_owner,
        p_operation_type => 'payer.setup', p_caller_request_key => 'setup-close-key',
        p_request_sha256 => repeat('3', 64),
        p_stripe_connected_account_id => 'acct_setup_close_contract',
        p_connect_account_generation => 1, p_lease_owner => v_lease,
        p_expected_revision => v_revision, p_to_state => 'provider_succeeded',
        p_provider_object_id => 'cs_setup_close_contract'
    );

    BEGIN
        PERFORM public.mark_billing_payer_setup_reconciliation_v1(
            v_request, v_operation, 'cs_setup_close_contract', NULL,
            'acct_wrong_identity', 1, 'setup_projection_pending'
        );
        RAISE EXCEPTION 'Reconciliation bound a Session across account identity.';
    EXCEPTION WHEN check_violation THEN
        IF SQLERRM <> 'billing_payer_setup_reconciliation_invalid' THEN RAISE; END IF;
    END;
    IF EXISTS (
        SELECT 1 FROM public.billing_payer_setup_requests
        WHERE id = v_request AND stripe_checkout_session_id IS NOT NULL
    ) THEN
        RAISE EXCEPTION 'Rejected reconciliation changed the setup Session binding.';
    END IF;

    v_result := public.mark_billing_payer_setup_reconciliation_v1(
        v_request, v_operation, 'cs_setup_close_contract', NULL,
        'acct_setup_close_contract', 1, 'setup_projection_pending'
    );
    IF v_result->'operation'->>'state' <> 'reconciliation_required'
       OR NOT EXISTS (
            SELECT 1 FROM public.billing_payer_setup_requests
            WHERE id = v_request
              AND stripe_checkout_session_id = 'cs_setup_close_contract'
       ) THEN
        RAISE EXCEPTION 'Provider-succeeded reconciliation did not bind the exact missing Session.';
    END IF;
    IF public.mark_billing_payer_setup_reconciliation_v1(
        v_request, v_operation, 'cs_setup_close_contract', NULL,
        'acct_setup_close_contract', 1, 'setup_projection_pending'
    )->>'outcome' <> 'replay' THEN
        RAISE EXCEPTION 'Exact provider-succeeded reconciliation did not replay.';
    END IF;
    BEGIN
        PERFORM public.mark_billing_payer_setup_reconciliation_v1(
            v_request, v_operation, 'cs_conflicting_session', NULL,
            'acct_setup_close_contract', 1, 'setup_projection_pending'
        );
        RAISE EXCEPTION 'Reconciliation replaced a non-null Session binding.';
    EXCEPTION WHEN check_violation THEN
        IF SQLERRM <> 'billing_payer_setup_reconciliation_invalid' THEN RAISE; END IF;
    END;

    v_result := public.close_billing_payer_setup_request_v1(
        v_request, v_operation, v_studio, v_payer,
        'cs_setup_close_contract', 'acct_setup_close_contract', 1,
        'checkout_session_expired', repeat('4', 64)
    );
    IF v_result->>'outcome' <> 'closed'
       OR v_result->'operation'->>'state' <> 'definitive_rejected'
       OR v_result->'setup_request'->>'close_reason_code' <> 'checkout_session_expired'
       OR v_result->'setup_request'->>'provider_read_proof_sha256' <> repeat('4', 64)
       OR v_result->'setup_request'->>'closed_at' IS NULL
       OR v_result->'setup_request'->>'superseded_at' IS NULL THEN
        RAISE EXCEPTION 'Proof-backed payer setup close did not persist exact terminal evidence.';
    END IF;
    IF public.close_billing_payer_setup_request_v1(
        v_request, v_operation, v_studio, v_payer,
        'cs_setup_close_contract', 'acct_setup_close_contract', 1,
        'checkout_session_expired', repeat('4', 64)
    )->>'outcome' <> 'replay' THEN
        RAISE EXCEPTION 'Exact payer setup close did not replay.';
    END IF;
    BEGIN
        PERFORM public.close_billing_payer_setup_request_v1(
            v_request, v_operation, v_studio, v_payer,
            'cs_setup_close_contract', 'acct_setup_close_contract', 1,
            'checkout_session_terminal_unusable', repeat('5', 64)
        );
        RAISE EXCEPTION 'A conflicting payer setup close proof was accepted.';
    EXCEPTION WHEN unique_violation THEN
        IF SQLERRM <> 'billing_payer_setup_close_conflict' THEN RAISE; END IF;
    END;

    v_lease := gen_random_uuid();
    v_result := public.claim_billing_provider_operation_v1(
        v_studio, v_owner, 'payer.setup', 'setup-replacement-key', repeat('6', 64),
        'acct_setup_close_contract', 1, v_lease, 30
    );
    v_replacement_operation := (v_result->'operation'->>'id')::UUID;
    v_revision := (v_result->'operation'->>'revision')::BIGINT;
    PERFORM public.prepare_billing_payer_setup_request_v1(
        v_replacement_operation, v_replacement_request, v_studio, v_owner, v_payer,
        'terms-close-2026-08', 'acct_setup_close_contract', 1,
        v_lease, v_revision, v_now + interval '40 minutes'
    );
    PERFORM public.transition_billing_provider_operation_v1(
        p_operation_id => v_replacement_operation, p_studio_id => v_studio,
        p_actor_id => v_owner, p_operation_type => 'payer.setup',
        p_caller_request_key => 'setup-replacement-key',
        p_request_sha256 => repeat('6', 64),
        p_stripe_connected_account_id => 'acct_setup_close_contract',
        p_connect_account_generation => 1, p_lease_owner => v_lease,
        p_expected_revision => v_revision, p_to_state => 'definitive_rejected',
        p_error_code => 'operator_rejected_before_provider'
    );

    v_lease := gen_random_uuid();
    v_result := public.claim_billing_provider_operation_v1(
        v_studio, v_owner, 'payer.setup', 'setup-final-key', repeat('7', 64),
        'acct_setup_close_contract', 1, v_lease, 30
    );
    v_final_operation := (v_result->'operation'->>'id')::UUID;
    v_revision := (v_result->'operation'->>'revision')::BIGINT;
    v_short_expiry := clock_timestamp() + interval '5 minutes 2 seconds';
    v_result := public.prepare_billing_payer_setup_request_v1(
        v_final_operation, v_final_request, v_studio, v_owner, v_payer,
        'terms-close-2026-08', 'acct_setup_close_contract', 1,
        v_lease, v_revision, v_short_expiry
    );
    IF v_result->>'outcome' <> 'prepared'
       OR NOT EXISTS (
            SELECT 1 FROM public.billing_payer_setup_requests
            WHERE id = v_replacement_request AND superseded_at IS NOT NULL
       )
       OR NOT EXISTS (
            SELECT 1 FROM public.billing_provider_operations
            WHERE id = v_replacement_operation
              AND state = 'definitive_rejected'
              AND provider_request_attempt_count = 0
              AND provider_object_id IS NULL
       ) THEN
        RAISE EXCEPTION 'Pre-provider definitive rejection did not allow one replacement request.';
    END IF;

    PERFORM pg_sleep(2.1);
    v_result := public.prepare_billing_payer_setup_request_v1(
        v_final_operation, v_final_request, v_studio, v_owner, v_payer,
        'terms-close-2026-08', 'acct_setup_close_contract', 1,
        v_lease, v_revision, v_short_expiry
    );
    IF v_result->>'outcome' <> 'replay' THEN
        RAISE EXCEPTION 'Exact unexpired setup request did not replay inside its final five minutes.';
    END IF;
END;
$$;

DO $$
DECLARE
    v_admin UUID := gen_random_uuid();
    v_front_desk UUID := gen_random_uuid();
    v_studio UUID := gen_random_uuid();
    v_payer UUID := gen_random_uuid();
    v_operation UUID := gen_random_uuid();
    v_request UUID := gen_random_uuid();
    v_consent UUID := gen_random_uuid();
    v_now TIMESTAMPTZ := clock_timestamp();
    v_disabled_at TIMESTAMPTZ := clock_timestamp();
    v_result JSONB;
BEGIN
    INSERT INTO auth.users(
        id, aud, role, email, raw_app_meta_data, raw_user_meta_data,
        created_at, updated_at
    ) VALUES
        (v_admin, 'authenticated', 'authenticated',
         'autopay-disable-admin@example.invalid', '{}', '{}', v_now, v_now),
        (v_front_desk, 'authenticated', 'authenticated',
         'autopay-disable-front-desk@example.invalid', '{}', '{}', v_now, v_now);
    INSERT INTO public.studios(id, name, slug, owner_id)
    VALUES (
        v_studio, 'Autopay disable contract',
        'autopay-disable-' || replace(v_studio::TEXT, '-', ''), v_admin
    );
    INSERT INTO public.staff_roles(studio_id, user_id, role) VALUES
        (v_studio, v_admin, 'admin'),
        (v_studio, v_front_desk, 'front_desk');
    INSERT INTO public.studio_payment_accounts(
        studio_id, stripe_connected_account_id, metadata
    ) VALUES (
        v_studio, 'acct_AutopayDisableContract',
        jsonb_build_object('connect_account_generation', 1)
    );
    INSERT INTO public.billing_payers(
        id, studio_id, display_name, stripe_account_id,
        stripe_customer_id, connect_account_generation, autopay_status
    ) VALUES (
        v_payer, v_studio, 'Autopay disable payer',
        'acct_AutopayDisableContract', 'cus_autopay_disable', 1, 'pending'
    );
    INSERT INTO public.billing_provider_operations(
        id, studio_id, actor_id, operation_type, caller_request_key,
        request_sha256, stripe_connected_account_id,
        connect_account_generation, state, provider_request_attempt_count,
        provider_object_id, provider_succeeded_at
    ) VALUES (
        v_operation, v_studio, v_admin, 'payer.setup',
        'autopay-disable-setup', repeat('a', 64),
        'acct_AutopayDisableContract', 1, 'provider_succeeded', 1,
        'cs_autopay_disable', v_now
    );
    INSERT INTO public.billing_payer_setup_requests(
        id, operation_id, studio_id, payer_id, initiated_by, terms_version,
        stripe_checkout_session_id, stripe_connected_account_id,
        connect_account_generation, setup_request_expires_at,
        created_at, updated_at
    ) VALUES (
        v_request, v_operation, v_studio, v_payer, v_admin,
        'koaryu-autopay-v1', 'cs_autopay_disable',
        'acct_AutopayDisableContract', 1, v_now + interval '35 minutes',
        v_now - interval '1 minute', v_now
    );

    BEGIN
        PERFORM public.disable_billing_payer_autopay_v1(
            v_studio, v_payer, v_admin, v_disabled_at,
            'staff_disabled_autopay'
        );
        RAISE EXCEPTION 'Pending payer setup was silently disabled.';
    EXCEPTION WHEN object_not_in_prerequisite_state THEN
        IF SQLERRM <> 'billing_payer_autopay_disable_setup_pending' THEN
            RAISE;
        END IF;
    END;
    IF (SELECT autopay_status FROM public.billing_payers WHERE id = v_payer)
           <> 'pending'
       OR (SELECT revoked_at FROM public.billing_payer_setup_requests
           WHERE id = v_request) IS NOT NULL THEN
        RAISE EXCEPTION 'Rejected autopay disable changed pending setup state.';
    END IF;

    UPDATE public.billing_provider_operations
    SET state = 'completed',
        provider_secondary_object_id = 'seti_autopay_disable',
        projected_at = v_now,
        completed_at = v_now,
        revision = revision + 1,
        updated_at = clock_timestamp()
    WHERE id = v_operation;
    UPDATE public.billing_payer_setup_requests
    SET stripe_setup_intent_id = 'seti_autopay_disable',
        accepted_at = v_now - interval '30 seconds',
        completed_at = v_now - interval '20 seconds',
        revision = revision + 1,
        updated_at = clock_timestamp()
    WHERE id = v_request;
    INSERT INTO public.billing_payer_payment_consents(
        id, setup_request_id, studio_id, payer_id, terms_version,
        stripe_checkout_session_id, stripe_setup_intent_id,
        stripe_connected_account_id, connect_account_generation,
        acceptance_proof_sha256, accepted_at, completed_at,
        setup_request_expires_at, created_at, updated_at
    ) VALUES (
        v_consent, v_request, v_studio, v_payer, 'koaryu-autopay-v1',
        'cs_autopay_disable', 'seti_autopay_disable',
        'acct_AutopayDisableContract', 1, repeat('b', 64),
        v_now - interval '30 seconds', v_now - interval '20 seconds',
        v_now + interval '35 minutes', v_now - interval '30 seconds', v_now
    );
    UPDATE public.billing_payers
    SET autopay_status = 'enabled',
        default_payment_method_id = 'pm_autopay_disable',
        autopay_authorized_at = v_now - interval '20 seconds',
        autopay_terms_accepted_at = v_now - interval '30 seconds'
    WHERE id = v_payer;

    v_result := public.disable_billing_payer_autopay_v1(
        v_studio, v_payer, v_admin, v_disabled_at,
        'staff_disabled_autopay'
    );
    IF v_result->>'outcome' <> 'disabled'
       OR v_result->'payer'->>'autopay_status' <> 'disabled'
       OR (v_result->>'revoked_consent_id')::UUID <> v_consent
       OR (SELECT revoked_at FROM public.billing_payer_payment_consents
           WHERE id = v_consent) IS DISTINCT FROM v_disabled_at
       OR (SELECT revoked_by FROM public.billing_payer_payment_consents
           WHERE id = v_consent) IS DISTINCT FROM v_admin
       OR (SELECT revocation_reason_code FROM public.billing_payer_payment_consents
           WHERE id = v_consent) <> 'staff_disabled_autopay'
       OR (SELECT revoked_at FROM public.billing_payer_setup_requests
           WHERE id = v_request) IS DISTINCT FROM v_disabled_at
       OR (SELECT default_payment_method_id FROM public.billing_payers
           WHERE id = v_payer) <> 'pm_autopay_disable' THEN
        RAISE EXCEPTION 'Atomic autopay disable did not revoke consent safely.';
    END IF;
    IF public.disable_billing_payer_autopay_v1(
        v_studio, v_payer, v_admin, v_disabled_at,
        'staff_disabled_autopay'
    )->>'outcome' <> 'replay' THEN
        RAISE EXCEPTION 'Exact autopay disable did not replay.';
    END IF;
    BEGIN
        PERFORM public.disable_billing_payer_autopay_v1(
            v_studio, v_payer, v_front_desk, v_disabled_at,
            'staff_disabled_autopay'
        );
        RAISE EXCEPTION 'Front Desk disabled payer autopay.';
    EXCEPTION WHEN insufficient_privilege THEN
        IF SQLERRM <> 'billing_payer_autopay_disable_actor_invalid' THEN
            RAISE;
        END IF;
    END;
END;
$$;

DO $$
DECLARE
    v_admin UUID := gen_random_uuid();
    v_studio UUID := gen_random_uuid();
    v_payer UUID := gen_random_uuid();
    v_prior_operation UUID := gen_random_uuid();
    v_prior_request UUID := gen_random_uuid();
    v_prior_consent UUID := gen_random_uuid();
    v_rejected_operation UUID := gen_random_uuid();
    v_rejected_request UUID := gen_random_uuid();
    v_unfinished_consent UUID := gen_random_uuid();
    v_lease UUID := gen_random_uuid();
    v_fresh_lease UUID := gen_random_uuid();
    v_fresh_request UUID := gen_random_uuid();
    v_now TIMESTAMPTZ := clock_timestamp();
    v_result JSONB;
    v_operation_revision BIGINT;
    v_setup_revision BIGINT;
BEGIN
    IF NOT has_function_privilege(
        'service_role',
        'public.reject_billing_payer_setup_without_provider_v1(uuid,uuid,uuid,uuid,uuid,text,text,text,integer,uuid,bigint,bigint)',
        'EXECUTE'
    ) OR has_function_privilege(
        'anon',
        'public.reject_billing_payer_setup_without_provider_v1(uuid,uuid,uuid,uuid,uuid,text,text,text,integer,uuid,bigint,bigint)',
        'EXECUTE'
    ) OR has_function_privilege(
        'authenticated',
        'public.reject_billing_payer_setup_without_provider_v1(uuid,uuid,uuid,uuid,uuid,text,text,text,integer,uuid,bigint,bigint)',
        'EXECUTE'
    ) THEN
        RAISE EXCEPTION 'No-object payer setup rejection RPC is not service-only.';
    END IF;

    INSERT INTO auth.users(
        id,aud,role,email,raw_app_meta_data,raw_user_meta_data,
        created_at,updated_at
    ) VALUES (
        v_admin,'authenticated','authenticated',
        'payer-setup-policy-rejection@example.invalid','{}','{}',v_now,v_now
    );
    INSERT INTO public.studios(id,name,slug,owner_id) VALUES (
        v_studio,'Payer setup policy rejection contract',
        'payer-setup-policy-'||replace(v_studio::TEXT,'-',''),v_admin
    );
    INSERT INTO public.staff_roles(studio_id,user_id,role)
    VALUES(v_studio,v_admin,'admin');
    INSERT INTO public.studio_payment_accounts(
        studio_id,stripe_connected_account_id,metadata
    ) VALUES(
        v_studio,'acct_PayerSetupPolicyContract',
        jsonb_build_object('connect_account_generation',1)
    );
    INSERT INTO public.billing_payers(
        id,studio_id,display_name,stripe_account_id,stripe_customer_id,
        connect_account_generation,default_payment_method_id,
        autopay_status,autopay_authorized_at,autopay_terms_accepted_at
    ) VALUES(
        v_payer,v_studio,'Enabled replacement payer',
        'acct_PayerSetupPolicyContract','cus_payer_setup_policy',1,
        'pm_existing_consent','enabled',v_now-interval '2 minutes',
        v_now-interval '3 minutes'
    );
    INSERT INTO public.billing_provider_operations(
        id,studio_id,actor_id,operation_type,caller_request_key,request_sha256,
        stripe_connected_account_id,connect_account_generation,state,
        provider_request_attempt_count,provider_object_id,
        provider_secondary_object_id,result_code,started_at,
        provider_request_in_flight_at,provider_succeeded_at,projected_at,
        completed_at,created_at,updated_at
    ) VALUES(
        v_prior_operation,v_studio,v_admin,'payer.setup','prior-consent-key',
        repeat('a',64),'acct_PayerSetupPolicyContract',1,'completed',1,
        'cs_prior_consent','seti_prior_consent','payer_setup_completed',
        v_now-interval '5 minutes',v_now-interval '4 minutes',
        v_now-interval '3 minutes',v_now-interval '2 minutes',
        v_now-interval '2 minutes',v_now-interval '5 minutes',v_now
    );
    INSERT INTO public.billing_payer_setup_requests(
        id,operation_id,studio_id,payer_id,initiated_by,terms_version,
        stripe_checkout_session_id,stripe_setup_intent_id,
        stripe_connected_account_id,connect_account_generation,
        setup_request_expires_at,accepted_at,completed_at,created_at,updated_at
    ) VALUES(
        v_prior_request,v_prior_operation,v_studio,v_payer,v_admin,
        'koaryu-autopay-v1','cs_prior_consent','seti_prior_consent',
        'acct_PayerSetupPolicyContract',1,v_now+interval '30 minutes',
        v_now-interval '3 minutes',v_now-interval '2 minutes',
        v_now-interval '5 minutes',v_now
    );
    INSERT INTO public.billing_payer_payment_consents(
        id,setup_request_id,studio_id,payer_id,terms_version,
        stripe_checkout_session_id,stripe_setup_intent_id,
        stripe_connected_account_id,connect_account_generation,
        acceptance_proof_sha256,accepted_at,completed_at,
        setup_request_expires_at,created_at,updated_at
    ) VALUES(
        v_prior_consent,v_prior_request,v_studio,v_payer,'koaryu-autopay-v1',
        'cs_prior_consent','seti_prior_consent','acct_PayerSetupPolicyContract',1,
        repeat('b',64),v_now-interval '3 minutes',v_now-interval '2 minutes',
        v_now+interval '30 minutes',v_now-interval '5 minutes',v_now
    );

    INSERT INTO public.billing_provider_operations(
        id,studio_id,actor_id,operation_type,caller_request_key,request_sha256,
        stripe_connected_account_id,connect_account_generation,state,
        provider_request_attempt_count,lease_owner,lease_acquired_at,
        lease_expires_at,provider_request_in_flight_at,result_code,
        started_at,created_at,updated_at
    ) VALUES(
        v_rejected_operation,v_studio,v_admin,'payer.setup','blocked-setup-key',
        repeat('c',64),'acct_PayerSetupPolicyContract',1,
        'provider_request_in_flight',1,v_lease,v_now-interval '5 seconds',
        v_now+interval '25 seconds',v_now-interval '5 seconds',
        'payer_setup_requested',v_now-interval '10 seconds',
        v_now-interval '10 seconds',v_now
    );
    INSERT INTO public.billing_payer_setup_requests(
        id,operation_id,studio_id,payer_id,initiated_by,terms_version,
        stripe_connected_account_id,connect_account_generation,
        setup_request_expires_at,created_at,updated_at
    ) VALUES(
        v_rejected_request,v_rejected_operation,v_studio,v_payer,v_admin,
        'koaryu-autopay-v1','acct_PayerSetupPolicyContract',1,
        v_now+interval '35 minutes',v_now-interval '10 seconds',v_now
    );
    INSERT INTO public.billing_payer_payment_consents(
        id,setup_request_id,studio_id,payer_id,terms_version,
        stripe_checkout_session_id,stripe_connected_account_id,
        connect_account_generation,acceptance_proof_sha256,accepted_at,
        setup_request_expires_at,created_at,updated_at
    ) VALUES(
        v_unfinished_consent,v_rejected_request,v_studio,v_payer,
        'koaryu-autopay-v1','cs_never_created','acct_PayerSetupPolicyContract',1,
        repeat('d',64),v_now-interval '1 second',v_now+interval '35 minutes',
        v_now-interval '1 second',v_now
    );
    SELECT revision INTO v_operation_revision
    FROM public.billing_provider_operations WHERE id=v_rejected_operation;
    SELECT revision INTO v_setup_revision
    FROM public.billing_payer_setup_requests WHERE id=v_rejected_request;

    v_result:=public.reject_billing_payer_setup_without_provider_v1(
        v_rejected_operation,v_rejected_request,v_studio,v_admin,v_payer,
        'blocked-setup-key',repeat('c',64),'acct_PayerSetupPolicyContract',1,
        v_lease,v_operation_revision,v_setup_revision
    );
    IF v_result->>'outcome'<>'rejected'
       OR v_result->'operation'->>'state'<>'definitive_rejected'
       OR v_result->'operation'->>'error_code'<>'provider_mutation_blocked'
       OR (v_result->'operation'->>'provider_request_attempt_count')::INTEGER<>1
       OR v_result->'operation'->>'provider_object_id' IS NOT NULL
       OR v_result->'setup_request'->>'close_reason_code'<>'provider_mutation_blocked'
       OR (v_result->'setup_request'->>'closed_at') IS DISTINCT FROM
          (v_result->'setup_request'->>'superseded_at')
       OR (SELECT superseded_at FROM public.billing_payer_payment_consents
           WHERE id=v_unfinished_consent) IS NULL
       OR (SELECT superseded_at FROM public.billing_payer_payment_consents
           WHERE id=v_prior_consent) IS NOT NULL
       OR (SELECT autopay_status FROM public.billing_payers WHERE id=v_payer)<>'enabled'
       OR (SELECT default_payment_method_id FROM public.billing_payers
           WHERE id=v_payer)<>'pm_existing_consent'
       OR (SELECT autopay_authorized_at FROM public.billing_payers
           WHERE id=v_payer) IS DISTINCT FROM v_now-interval '2 minutes'
       OR (SELECT autopay_terms_accepted_at FROM public.billing_payers
           WHERE id=v_payer) IS DISTINCT FROM v_now-interval '3 minutes' THEN
        RAISE EXCEPTION 'No-object setup rejection did not close exact new state and preserve prior consent.';
    END IF;
    BEGIN
        UPDATE public.billing_payer_setup_requests
        SET stripe_checkout_session_id='cs_contradictory_after_policy_rejection',
            revision=revision+1,
            updated_at=clock_timestamp()
        WHERE id=v_rejected_request;
        RAISE EXCEPTION 'Policy-rejected setup accepted a contradictory provider object.';
    EXCEPTION WHEN check_violation THEN
        IF SQLERRM NOT LIKE '%billing_payer_setup_requests_close_evidence%' THEN
            RAISE;
        END IF;
    END;
    IF public.reject_billing_payer_setup_without_provider_v1(
        v_rejected_operation,v_rejected_request,v_studio,v_admin,v_payer,
        'blocked-setup-key',repeat('c',64),'acct_PayerSetupPolicyContract',1,
        v_lease,v_operation_revision,v_setup_revision
    )->>'outcome'<>'replay' THEN
        RAISE EXCEPTION 'Exact no-object setup rejection did not replay.';
    END IF;

    v_result:=public.claim_billing_provider_operation_v1(
        v_studio,v_admin,'payer.setup','fresh-setup-key',repeat('e',64),
        'acct_PayerSetupPolicyContract',1,v_fresh_lease,30
    );
    IF v_result->>'outcome'<>'claimed' THEN
        RAISE EXCEPTION 'Fresh setup key did not claim after no-object rejection.';
    END IF;
    v_result:=public.prepare_billing_payer_setup_request_v1(
        (v_result->'operation'->>'id')::UUID,v_fresh_request,v_studio,v_admin,
        v_payer,'koaryu-autopay-v1','acct_PayerSetupPolicyContract',1,
        v_fresh_lease,(v_result->'operation'->>'revision')::BIGINT,
        v_now+interval '35 minutes'
    );
    IF v_result->>'outcome'<>'prepared'
       OR (v_result->'setup_request'->>'id')::UUID<>v_fresh_request
       OR (SELECT superseded_at FROM public.billing_payer_setup_requests
           WHERE id=v_rejected_request) IS NULL THEN
        RAISE EXCEPTION 'Fresh setup request did not proceed after policy rejection.';
    END IF;
END;
$$;

DO $$
DECLARE
    v_admin UUID:=gen_random_uuid();
    v_studio UUID:=gen_random_uuid();
    v_payer UUID:=gen_random_uuid();
    v_student UUID:=gen_random_uuid();
    v_plan UUID:=gen_random_uuid();
    v_enrollment UUID:=gen_random_uuid();
    v_consent_operation UUID:=gen_random_uuid();
    v_consent_request UUID:=gen_random_uuid();
    v_consent UUID:=gen_random_uuid();
    v_group UUID;
    v_operation UUID;
    v_lease UUID:=gen_random_uuid();
    v_lock TEXT:='activation-policy-lock-a';
    v_now TIMESTAMPTZ:=clock_timestamp();
    v_result JSONB;
    v_intent JSONB;
    v_revision BIGINT;
BEGIN
    INSERT INTO auth.users(
        id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at
    ) VALUES(
        v_admin,'authenticated','authenticated',
        'activation-policy-contract@example.invalid','{}','{}',v_now,v_now
    );
    INSERT INTO public.studios(id,name,slug,owner_id) VALUES(
        v_studio,'Activation policy contract',
        'activation-policy-'||replace(v_studio::TEXT,'-',''),v_admin
    );
    INSERT INTO public.staff_roles(studio_id,user_id,role)
    VALUES(v_studio,v_admin,'admin');
    INSERT INTO public.studio_payment_accounts(
        studio_id,stripe_connected_account_id,status,charges_enabled,metadata
    ) VALUES(
        v_studio,'acct_ActivationPolicyContract','charges_enabled',true,
        jsonb_build_object('connect_account_generation',1)
    );
    INSERT INTO public.billing_payers(
        id,studio_id,display_name,stripe_account_id,stripe_customer_id,
        connect_account_generation,default_payment_method_id,autopay_status,
        autopay_authorized_at,autopay_terms_accepted_at
    ) VALUES(
        v_payer,v_studio,'Activation policy payer',
        'acct_ActivationPolicyContract','cus_activation_policy',1,
        'pm_activation_policy','enabled',v_now-interval '2 minutes',
        v_now-interval '3 minutes'
    );
    INSERT INTO public.students(id,studio_id,legal_first_name,legal_last_name)
    VALUES(v_student,v_studio,'Activation','Policy');
    INSERT INTO public.billing_plans(
        id,studio_id,name,amount_cents,currency,billing_interval,status
    ) VALUES(v_plan,v_studio,'Activation policy plan',5000,'usd','monthly','active');
    INSERT INTO public.student_billing_enrollments(
        id,studio_id,student_id,payer_id,billing_plan_id,collection_mode,status,
        metadata
    ) VALUES(
        v_enrollment,v_studio,v_student,v_payer,v_plan,'autopay','pending','{}'
    );
    INSERT INTO public.billing_provider_operations(
        id,studio_id,actor_id,operation_type,caller_request_key,request_sha256,
        stripe_connected_account_id,connect_account_generation,state,
        provider_request_attempt_count,provider_object_id,
        provider_secondary_object_id,provider_request_in_flight_at,
        provider_succeeded_at,projected_at,completed_at,started_at,created_at,updated_at
    ) VALUES(
        v_consent_operation,v_studio,v_admin,'payer.setup','activation-consent',
        repeat('a',64),'acct_ActivationPolicyContract',1,'completed',1,
        'cs_activation_consent','seti_activation_consent',v_now-interval '4 minutes',
        v_now-interval '3 minutes',v_now-interval '2 minutes',
        v_now-interval '2 minutes',v_now-interval '5 minutes',
        v_now-interval '5 minutes',v_now
    );
    INSERT INTO public.billing_payer_setup_requests(
        id,operation_id,studio_id,payer_id,initiated_by,terms_version,
        stripe_checkout_session_id,stripe_setup_intent_id,
        stripe_connected_account_id,connect_account_generation,
        setup_request_expires_at,accepted_at,completed_at,created_at,updated_at
    ) VALUES(
        v_consent_request,v_consent_operation,v_studio,v_payer,v_admin,
        'koaryu-autopay-v1','cs_activation_consent','seti_activation_consent',
        'acct_ActivationPolicyContract',1,v_now+interval '30 minutes',
        v_now-interval '3 minutes',v_now-interval '2 minutes',
        v_now-interval '5 minutes',v_now
    );
    INSERT INTO public.billing_payer_payment_consents(
        id,setup_request_id,studio_id,payer_id,terms_version,
        stripe_checkout_session_id,stripe_setup_intent_id,
        stripe_connected_account_id,connect_account_generation,
        acceptance_proof_sha256,accepted_at,completed_at,
        setup_request_expires_at,created_at,updated_at
    ) VALUES(
        v_consent,v_consent_request,v_studio,v_payer,'koaryu-autopay-v1',
        'cs_activation_consent','seti_activation_consent',
        'acct_ActivationPolicyContract',1,repeat('b',64),
        v_now-interval '3 minutes',v_now-interval '2 minutes',
        v_now+interval '30 minutes',v_now-interval '5 minutes',v_now
    );

    v_result:=public.reserve_billing_autopay_activation_v31(
        v_studio,v_admin,v_enrollment,v_payer,v_plan,
        'acct_ActivationPolicyContract',1,repeat('c',64),
        'koaryu-autopay-v1',0.5
    );
    v_group:=(v_result->'subscription'->>'id')::UUID;
    IF v_result->>'outcome'<>'created'
       OR v_result->'subscription'->'metadata'->'activation_reservation'
          IS DISTINCT FROM jsonb_build_object(
              'version',1,'enrollment_id',v_enrollment
          ) THEN
        RAISE EXCEPTION 'Activation reservation did not persist exact ownership.';
    END IF;
    v_intent:=jsonb_build_object(
        'version',1,'operation_type','enrollment.activate.autopay',
        'studio_id',v_studio,'enrollment_id',v_enrollment,
        'student_id',v_student,'payer_id',v_payer,'plan_id',v_plan,
        'account_id','acct_ActivationPolicyContract','generation',1,
        'customer_id','cus_activation_policy','product_id','prod_contract',
        'price_id','price_contract','group_id',v_group,
        'branch','create_subscription','expected_subscription_id',NULL,
        'expected_item_id',NULL,'expected_quantity',1,
        'desired_sha256',repeat('d',64)
    );
    UPDATE public.student_billing_enrollments
    SET metadata=jsonb_build_object('provider_activation_intent',v_intent)
    WHERE id=v_enrollment;
    v_result:=public.claim_billing_provider_operation_resource_v1(
        v_studio,v_admin,'enrollment.activate.autopay','enrollment',v_enrollment,
        v_payer,'activation-policy-key',repeat('d',64),
        'acct_ActivationPolicyContract',1,v_lease,30
    );
    v_operation:=(v_result->'operation'->>'id')::UUID;
    v_revision:=(v_result->'operation'->>'revision')::BIGINT;
    PERFORM public.claim_billing_subscription_quantity_sync(
        v_studio,v_group,v_lock,120
    );
    v_result:=public.reject_billing_autopay_activation_without_provider_v31(
        v_operation,v_studio,v_admin,v_enrollment,v_payer,v_group,
        v_result->'operation'->>'caller_request_key',repeat('d',64),
        'acct_ActivationPolicyContract',1,gen_random_uuid(),v_lock,
        repeat('c',64),v_revision
    );
    IF v_result->>'outcome'<>'rejected'
       OR (v_result->>'subscription_deleted')::BOOLEAN IS DISTINCT FROM true
       OR v_result->'operation'->>'state'<>'definitive_rejected'
       OR (v_result->'operation'->>'provider_request_attempt_count')::INTEGER<>0
       OR EXISTS(SELECT 1 FROM public.billing_subscriptions WHERE id=v_group)
       OR (SELECT metadata ? 'provider_activation_intent'
           FROM public.student_billing_enrollments WHERE id=v_enrollment)
       OR NOT (SELECT metadata ? 'provider_activation_rejection'
           FROM public.student_billing_enrollments WHERE id=v_enrollment) THEN
        RAISE EXCEPTION 'Exact no-object activation rejection did not converge.';
    END IF;
    IF public.reject_billing_autopay_activation_without_provider_v31(
        v_operation,v_studio,v_admin,v_enrollment,v_payer,v_group,
        v_result->'operation'->>'caller_request_key',repeat('d',64),
        'acct_ActivationPolicyContract',1,v_lease,v_lock,repeat('c',64),v_revision
    )->>'outcome'<>'replay' THEN
        RAISE EXCEPTION 'Exact activation rejection did not replay.';
    END IF;
    v_result:=public.reserve_billing_autopay_activation_v31(
        v_studio,v_admin,v_enrollment,v_payer,v_plan,
        'acct_ActivationPolicyContract',1,repeat('c',64),
        'koaryu-autopay-v1',0.5
    );
    IF v_result->>'outcome'<>'definitive_rejected'
       OR EXISTS(SELECT 1 FROM public.billing_subscriptions
                 WHERE studio_id=v_studio AND payer_id=v_payer) THEN
        RAISE EXCEPTION 'Same-key retry recreated a rejected reservation.';
    END IF;

    v_result:=public.reserve_billing_autopay_activation_v31(
        v_studio,v_admin,v_enrollment,v_payer,v_plan,
        'acct_ActivationPolicyContract',1,repeat('e',64),
        'koaryu-autopay-v1',0.5
    );
    v_group:=(v_result->'subscription'->>'id')::UUID;
    v_intent:=jsonb_set(v_intent,'{group_id}',to_jsonb(v_group));
    v_intent:=jsonb_set(v_intent,'{desired_sha256}',to_jsonb(repeat('f',64)));
    UPDATE public.student_billing_enrollments
    SET metadata=jsonb_build_object('provider_activation_intent',v_intent)
    WHERE id=v_enrollment;
    v_lease:=gen_random_uuid();
    v_lock:='activation-policy-lock-b';
    v_result:=public.claim_billing_provider_operation_resource_v1(
        v_studio,v_admin,'enrollment.activate.autopay','enrollment',v_enrollment,
        v_payer,'activation-policy-fresh',repeat('f',64),
        'acct_ActivationPolicyContract',1,v_lease,30
    );
    v_operation:=(v_result->'operation'->>'id')::UUID;
    PERFORM public.claim_billing_subscription_quantity_sync(
        v_studio,v_group,v_lock,120
    );
    v_result:=public.transition_billing_provider_operation_v1(
        v_operation,v_studio,v_admin,'enrollment.activate.autopay',
        v_result->>'canonical_caller_request_key',repeat('f',64),
        'acct_ActivationPolicyContract',1,v_lease,
        (v_result->'operation'->>'revision')::BIGINT,
        'provider_request_in_flight',NULL,NULL,NULL,
        'enrollment_activation_started',NULL,NULL,NULL,NULL
    );
    UPDATE public.billing_subscriptions
    SET stripe_subscription_id='sub_provider_backed_contract'
    WHERE id=v_group;
    v_result:=public.reject_billing_autopay_activation_without_provider_v31(
        v_operation,v_studio,v_admin,v_enrollment,v_payer,v_group,
        v_result->'operation'->>'caller_request_key',repeat('f',64),
        'acct_ActivationPolicyContract',1,v_lease,v_lock,repeat('e',64),
        (v_result->'operation'->>'revision')::BIGINT
    );
    IF (v_result->>'subscription_deleted')::BOOLEAN IS DISTINCT FROM false
       OR NOT EXISTS(SELECT 1 FROM public.billing_subscriptions
                     WHERE id=v_group
                       AND stripe_subscription_id='sub_provider_backed_contract')
       OR v_result->'operation'->>'state'<>'definitive_rejected' THEN
        RAISE EXCEPTION 'Provider-backed activation group was not preserved.';
    END IF;
END;
$$;

ROLLBACK;
