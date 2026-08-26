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
    -- Older contract fixtures use a deliberately synthetic account id that
    -- predates the Stripe-id shape guard. Seed only the task-owned mapping row
    -- without exercising that unrelated trigger.
    PERFORM set_config('session_replication_role', 'replica', true);
    INSERT INTO public.studio_payment_accounts(
        studio_id, stripe_connected_account_id, metadata
    ) VALUES (
        v_studio, 'acct_operation_contract',
        jsonb_build_object('connect_account_generation', 1)
    );
    PERFORM set_config('session_replication_role', 'origin', true);
    INSERT INTO public.billing_payers(
        id, studio_id, display_name, stripe_account_id, stripe_customer_id
    ) VALUES (
        v_payer, v_studio, 'Operation payer',
        'acct_operation_contract', 'cus_operation_contract'
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
        v_clear_payer, v_studio, 'Clearable payer', 'acct_operation_contract',
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
        SET stripe_account_id = 'acct_operation_contract'
        WHERE id = v_clear_payer;
        RAISE EXCEPTION 'A partial payer provider identity was accepted.';
    EXCEPTION WHEN check_violation THEN
        IF SQLERRM <> 'billing_payer_connect_identity_incomplete' THEN RAISE; END IF;
    END;

    v_result := public.claim_billing_provider_operation_v1(
        v_studio, v_owner, 'invoice.create', 'invoice-operation-key', repeat('a', 64),
        'acct_operation_contract', 1, v_lease, 30
    );
    v_operation_id := (v_result->'operation'->>'id')::UUID;
    IF v_result->>'outcome' <> 'claimed'
       OR (v_result->'operation'->>'provider_request_attempt_count')::INTEGER <> 0 THEN
        RAISE EXCEPTION 'Initial provider operation claim was not exact.';
    END IF;

    v_result := public.claim_billing_provider_operation_v1(
        v_studio, v_owner, 'invoice.create', 'invoice-operation-key', repeat('a', 64),
        'acct_operation_contract', 1, v_lease, 30
    );
    IF v_result->>'outcome' <> 'claimed' OR (v_result->'operation'->>'id')::UUID <> v_operation_id THEN
        RAISE EXCEPTION 'Same-key replay did not return the same operation.';
    END IF;

    BEGIN
        PERFORM public.claim_billing_provider_operation_v1(
            v_studio, v_owner, 'invoice.create', 'invoice-operation-key', repeat('b', 64),
            'acct_operation_contract', 1, v_lease, 30
        );
        RAISE EXCEPTION 'Expected same workflow key with another hash to conflict.';
    EXCEPTION WHEN unique_violation THEN
        IF SQLERRM <> 'billing_provider_operation_request_conflict' THEN RAISE; END IF;
    END;

    -- The same caller key is legal for a different product workflow.
    PERFORM public.claim_billing_provider_operation_v1(
        v_studio, v_owner, 'invoice.retry', 'invoice-operation-key', repeat('c', 64),
        'acct_operation_contract', 1, gen_random_uuid(), 30
    );

    v_result := public.read_billing_provider_operation_v1(
        v_operation_id, v_studio, v_reader, 'invoice.create', 'invoice-operation-key',
        repeat('a', 64), 'acct_operation_contract', 1
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
        p_stripe_connected_account_id => 'acct_operation_contract',
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
        'acct_operation_contract', 1, gen_random_uuid(), 30
    )->>'outcome') <> 'provider_request_in_flight' THEN
        RAISE EXCEPTION 'Ambiguous in-flight operation was automatically re-leased.';
    END IF;

    v_revision := (v_result->'operation'->>'revision')::BIGINT;
    v_result := public.authorize_billing_provider_operation_recovery_v1(
        v_operation_id, v_studio, v_owner, 'invoice.create', 'invoice-operation-key', repeat('a', 64),
        'acct_operation_contract', 1, v_owner, repeat('d', 64),
        'provider_no_object_safe_to_retry', v_recovery_lease, 30, v_revision
    );
    v_revision := (v_result->'operation'->>'revision')::BIGINT;
    v_result := public.transition_billing_provider_operation_v1(
        p_operation_id => v_operation_id, p_studio_id => v_studio, p_actor_id => v_owner,
        p_operation_type => 'invoice.create', p_caller_request_key => 'invoice-operation-key',
        p_request_sha256 => repeat('a', 64), p_stripe_connected_account_id => 'acct_operation_contract',
        p_connect_account_generation => 1, p_lease_owner => v_recovery_lease,
        p_expected_revision => v_revision, p_to_state => 'provider_request_in_flight'
    );
    IF (v_result->'operation'->>'provider_request_attempt_count')::INTEGER <> 2 THEN
        RAISE EXCEPTION 'Proof-authorized provider retry was not recorded as attempt two.';
    END IF;
    BEGIN
        PERFORM public.authorize_billing_provider_operation_recovery_v1(
            v_operation_id, v_studio, v_owner, 'invoice.create', 'invoice-operation-key', repeat('a', 64),
            'acct_operation_contract', 1, v_owner, repeat('e', 64),
            'provider_no_object_safe_to_retry', gen_random_uuid(), 30,
            (v_result->'operation'->>'revision')::BIGINT
        );
        RAISE EXCEPTION 'Expected a third provider attempt authorization to fail.';
    EXCEPTION WHEN check_violation THEN
        IF SQLERRM <> 'billing_provider_operation_retry_limit_reached' THEN RAISE; END IF;
    END;

    BEGIN
        PERFORM public.claim_billing_provider_operation_v1(
            v_studio, v_owner, 'enrollment.cancel.immediate', 'reserved-cancel-key', repeat('f', 64),
            'acct_operation_contract', 1, gen_random_uuid(), 30
        );
        RAISE EXCEPTION 'Expected reserved cancellation workflow to remain unavailable.';
    EXCEPTION WHEN feature_not_supported THEN
        IF SQLERRM <> 'billing_provider_operation_reserved' THEN RAISE; END IF;
    END;

    v_result := public.claim_billing_provider_operation_v1(
        v_studio, v_owner, 'payer.setup', 'payer-setup-key', repeat('1', 64),
        'acct_operation_contract', 1, v_lease, 30
    );
    v_setup_operation := (v_result->'operation'->>'id')::UUID;
    v_revision := (v_result->'operation'->>'revision')::BIGINT;
    v_result := public.prepare_billing_payer_setup_request_v1(
        v_setup_operation, v_setup_request, v_studio, v_owner, v_payer,
        'terms-2026-08', 'acct_operation_contract', 1, v_lease, v_revision,
        v_now + interval '30 minutes'
    );
    IF v_result->>'outcome' <> 'prepared' OR (v_result->'setup_request'->>'id')::UUID <> v_setup_request THEN
        RAISE EXCEPTION 'Setup request was not created before provider mutation.';
    END IF;
    v_result := public.transition_billing_provider_operation_v1(
        p_operation_id => v_setup_operation, p_studio_id => v_studio, p_actor_id => v_owner,
        p_operation_type => 'payer.setup', p_caller_request_key => 'payer-setup-key',
        p_request_sha256 => repeat('1', 64), p_stripe_connected_account_id => 'acct_operation_contract',
        p_connect_account_generation => 1, p_lease_owner => v_lease,
        p_expected_revision => v_revision, p_to_state => 'provider_request_in_flight'
    );
    v_revision := (v_result->'operation'->>'revision')::BIGINT;
    v_result := public.transition_billing_provider_operation_v1(
        p_operation_id => v_setup_operation, p_studio_id => v_studio, p_actor_id => v_owner,
        p_operation_type => 'payer.setup', p_caller_request_key => 'payer-setup-key',
        p_request_sha256 => repeat('1', 64), p_stripe_connected_account_id => 'acct_operation_contract',
        p_connect_account_generation => 1, p_lease_owner => v_lease,
        p_expected_revision => v_revision, p_to_state => 'provider_succeeded',
        p_provider_object_id => 'cs_test_operation_contract'
    );
    PERFORM public.bind_billing_payer_setup_session_v1(
        v_setup_request, v_setup_operation, v_studio, v_payer,
        'cs_test_operation_contract', 'acct_operation_contract', 1, 1
    );
    v_result := public.accept_billing_payer_payment_consent_v1(
        v_setup_request, v_studio, v_payer, 'terms-2026-08',
        'cs_test_operation_contract', 'acct_operation_contract', 1,
        repeat('2', 64), v_now + interval '1 minute'
    );
    v_consent := (v_result->'consent'->>'id')::UUID;
    v_result := public.complete_billing_payer_payment_consent_v1(
        v_consent, v_setup_request, v_setup_operation,
        'cs_test_operation_contract', 'seti_test_operation_contract',
        'acct_operation_contract', 1, v_now + interval '2 minutes'
    );
    IF v_result->'operation'->>'state' <> 'projected' THEN
        RAISE EXCEPTION 'Consent completion claimed local payer projection was complete.';
    END IF;
    v_result := public.mark_billing_payer_setup_reconciliation_v1(
        v_setup_request, v_setup_operation,
        'cs_test_operation_contract', 'seti_test_operation_contract',
        'acct_operation_contract', 1, 'payer_projection_update_failed'
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
        'acct_operation_contract', 1, 'payer_projection_update_failed'
    )->>'outcome' <> 'replay' THEN
        RAISE EXCEPTION 'Exact projected reconciliation did not replay.';
    END IF;
    v_revision := (v_result->'operation'->>'revision')::BIGINT;
    v_result := public.transition_billing_provider_operation_v1(
        p_operation_id => v_setup_operation, p_studio_id => v_studio, p_actor_id => v_owner,
        p_operation_type => 'payer.setup', p_caller_request_key => 'payer-setup-key',
        p_request_sha256 => repeat('1', 64), p_stripe_connected_account_id => 'acct_operation_contract',
        p_connect_account_generation => 1, p_lease_owner => v_lease,
        p_expected_revision => v_revision, p_to_state => 'projected',
        p_provider_object_id => 'cs_test_operation_contract',
        p_provider_secondary_object_id => 'seti_test_operation_contract'
    );
    BEGIN
        PERFORM public.finalize_billing_payer_setup_projection_v1(
            v_consent, v_setup_request, v_setup_operation, v_studio, v_payer,
            'cs_test_operation_contract', 'seti_test_operation_contract',
            'acct_operation_contract', 1
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
            'acct_operation_contract', 2
        );
        RAISE EXCEPTION 'Payer setup finalization accepted the wrong account generation.';
    EXCEPTION WHEN check_violation THEN
        IF SQLERRM <> 'billing_payer_setup_projection_identity_mismatch' THEN RAISE; END IF;
    END;
    v_result := public.finalize_billing_payer_setup_projection_v1(
        v_consent, v_setup_request, v_setup_operation, v_studio, v_payer,
        'cs_test_operation_contract', 'seti_test_operation_contract',
        'acct_operation_contract', 1
    );
    IF v_result->'operation'->>'state' <> 'completed'
       OR (SELECT connect_account_generation FROM public.billing_payers WHERE id = v_payer) <> 1
       OR (public.read_active_billing_payer_payment_consent_v1(
            v_studio, v_payer, 'terms-2026-08', 'acct_operation_contract', 1
          )->'consent'->>'id')::UUID <> v_consent THEN
        RAISE EXCEPTION 'Payer setup did not converge with exact provider generation evidence.';
    END IF;
    IF public.finalize_billing_payer_setup_projection_v1(
        v_consent, v_setup_request, v_setup_operation, v_studio, v_payer,
        'cs_test_operation_contract', 'seti_test_operation_contract',
        'acct_operation_contract', 1
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
            'acct_operation_contract', 1
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
        'acct_operation_contract', 1, 'completed_consent_payment_method_missing'
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
        'acct_operation_contract', 1, 'completed_consent_payment_method_missing'
    )->>'outcome' <> 'replay' THEN
        RAISE EXCEPTION 'Exact completed reconciliation did not replay.';
    END IF;

    PERFORM public.revoke_billing_payer_payment_consent_v1(
        v_consent, v_studio, v_payer, 'acct_operation_contract', 1,
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

ROLLBACK;
