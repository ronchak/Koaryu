BEGIN;

DO $$
DECLARE
    v_owner UUID := gen_random_uuid();
    v_reader UUID := gen_random_uuid();
    v_studio UUID := gen_random_uuid();
    v_parent_lease UUID := gen_random_uuid();
    v_step_lease UUID := gen_random_uuid();
    v_recovery_lease UUID := gen_random_uuid();
    v_operation UUID;
    v_parent_revision BIGINT;
    v_step_revision BIGINT;
    v_now TIMESTAMPTZ := clock_timestamp();
    v_plan JSONB := jsonb_build_array(
        jsonb_build_object(
            'step_name', 'customer.create',
            'provider_operation', 'stripe.customers.create',
            'request_sha256', repeat('1', 64),
            'stripe_idempotency_key', 'step-contract-customer'
        ),
        jsonb_build_object(
            'step_name', 'subscription.create',
            'provider_operation', 'stripe.subscriptions.create',
            'request_sha256', repeat('2', 64),
            'stripe_idempotency_key', 'step-contract-subscription'
        )
    );
    v_plan_sha TEXT;
    v_result JSONB;
BEGIN
    IF has_table_privilege(
        'service_role', 'public.billing_provider_operation_steps',
        'SELECT,INSERT,UPDATE,DELETE'
    )
       OR has_table_privilege('anon', 'public.billing_provider_operation_steps', 'SELECT')
       OR has_table_privilege('authenticated', 'public.billing_provider_operation_steps', 'SELECT')
       OR NOT has_function_privilege(
            'service_role',
            'public.register_billing_provider_operation_step_plan_v1(uuid,uuid,uuid,text,text,text,text,integer,uuid,bigint,text,integer,jsonb)',
            'EXECUTE'
       )
       OR has_function_privilege(
            'authenticated',
            'public.claim_billing_provider_operation_step_v1(uuid,uuid,uuid,text,text,text,text,integer,text,integer,text,text,text,text,uuid,integer)',
            'EXECUTE'
       ) THEN
        RAISE EXCEPTION 'Provider operation step ACLs are not service-only.';
    END IF;
    IF private.koaryu_release_provider_operation_steps_manifest_v28()
       <> '0:fc27387abfcf7dfafb1c43552341f78c707b4b6c546f4bb1a02841fb88235fd8' THEN
        RAISE EXCEPTION 'V28 step manifest drifted: %',
            private.koaryu_release_provider_operation_steps_manifest_v28();
    END IF;

    INSERT INTO auth.users(
        id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
    ) VALUES
        (v_owner, 'authenticated', 'authenticated', 'step-owner@example.invalid', '{}', '{}', v_now, v_now),
        (v_reader, 'authenticated', 'authenticated', 'step-reader@example.invalid', '{}', '{}', v_now, v_now);
    INSERT INTO public.studios(id, name, slug, owner_id)
    VALUES (
        v_studio, 'Provider step contract',
        'provider-step-' || replace(v_studio::TEXT, '-', ''), v_owner
    );
    INSERT INTO public.staff_roles(studio_id, user_id, role)
    VALUES (v_studio, v_owner, 'admin'), (v_studio, v_reader, 'front_desk');

    v_result := public.claim_billing_provider_operation_v1(
        v_studio, v_owner, 'plan.sync', 'provider-step-parent', repeat('a', 64),
        'acct_provider_step_contract', 1, v_parent_lease, 30
    );
    v_operation := (v_result->'operation'->>'id')::UUID;
    v_parent_revision := (v_result->'operation'->>'revision')::BIGINT;
    v_plan_sha := encode(
        extensions.digest(convert_to(v_plan::TEXT, 'UTF8'), 'sha256'), 'hex'
    );

    v_result := public.register_billing_provider_operation_step_plan_v1(
        v_operation, v_studio, v_owner, 'plan.sync', 'provider-step-parent',
        repeat('a', 64), 'acct_provider_step_contract', 1, v_parent_lease,
        v_parent_revision, v_plan_sha, 2, v_plan
    );
    IF v_result->>'outcome' <> 'registered'
       OR jsonb_array_length(v_result->'steps') <> 2
       OR v_result->'operation'->>'state' <> 'started' THEN
        RAISE EXCEPTION 'Exact step plan registration failed: %', v_result;
    END IF;
    v_parent_revision := (v_result->'operation'->>'revision')::BIGINT;
    IF public.register_billing_provider_operation_step_plan_v1(
        v_operation, v_studio, v_owner, 'plan.sync', 'provider-step-parent',
        repeat('a', 64), 'acct_provider_step_contract', 1, v_parent_lease,
        v_parent_revision, v_plan_sha, 2, v_plan
    )->>'outcome' <> 'replay' THEN
        RAISE EXCEPTION 'Exact step plan did not replay.';
    END IF;
    BEGIN
        PERFORM public.register_billing_provider_operation_step_plan_v1(
            v_operation, v_studio, v_owner, 'plan.sync', 'provider-step-parent',
            repeat('a', 64), 'acct_provider_step_contract', 1, v_parent_lease,
            v_parent_revision, repeat('f', 64), 2, v_plan
        );
        RAISE EXCEPTION 'Conflicting plan hash was accepted.';
    EXCEPTION WHEN check_violation THEN
        IF SQLERRM <> 'billing_provider_operation_step_plan_hash_mismatch' THEN RAISE; END IF;
    END;
    BEGIN
        PERFORM public.transition_billing_provider_operation_v1(
            p_operation_id => v_operation, p_studio_id => v_studio,
            p_actor_id => v_owner, p_operation_type => 'plan.sync',
            p_caller_request_key => 'provider-step-parent',
            p_request_sha256 => repeat('a', 64),
            p_stripe_connected_account_id => 'acct_provider_step_contract',
            p_connect_account_generation => 1, p_lease_owner => v_parent_lease,
            p_expected_revision => v_parent_revision,
            p_to_state => 'provider_request_in_flight'
        );
        RAISE EXCEPTION 'Planned parent issued a direct provider call.';
    EXCEPTION WHEN check_violation THEN
        IF SQLERRM <> 'billing_provider_operation_step_plan_requires_step_rpc' THEN RAISE; END IF;
    END;

    BEGIN
        PERFORM public.claim_billing_provider_operation_step_v1(
            v_operation, v_studio, v_owner, 'plan.sync', 'provider-step-parent',
            repeat('a', 64), 'acct_provider_step_contract', 1, v_plan_sha,
            2, 'subscription.create', 'stripe.subscriptions.create', repeat('2', 64),
            'step-contract-subscription', gen_random_uuid(), 30
        );
        RAISE EXCEPTION 'Second step ran before its predecessor.';
    EXCEPTION WHEN object_not_in_prerequisite_state THEN
        IF SQLERRM <> 'billing_provider_operation_step_predecessor_incomplete' THEN RAISE; END IF;
    END;

    v_result := public.claim_billing_provider_operation_step_v1(
        v_operation, v_studio, v_owner, 'plan.sync', 'provider-step-parent',
        repeat('a', 64), 'acct_provider_step_contract', 1, v_plan_sha,
        1, 'customer.create', 'stripe.customers.create', repeat('1', 64),
        'step-contract-customer', v_step_lease, 30
    );
    v_step_revision := (v_result->'step'->>'revision')::BIGINT;
    v_result := public.transition_billing_provider_operation_step_v1(
        v_operation, v_studio, v_owner, 'plan.sync', 'provider-step-parent',
        repeat('a', 64), 'acct_provider_step_contract', 1, v_plan_sha,
        1, 'customer.create', 'stripe.customers.create', repeat('1', 64),
        'step-contract-customer', v_step_lease, v_step_revision,
        'provider_request_in_flight'
    );
    IF (v_result->'step'->>'provider_request_attempt_count')::INTEGER <> 1 THEN
        RAISE EXCEPTION 'First step attempt count was not truthful.';
    END IF;
    BEGIN
        PERFORM public.transition_billing_provider_operation_step_v1(
            p_operation_id => v_operation, p_studio_id => v_studio,
            p_actor_id => v_owner, p_operation_type => 'plan.sync',
            p_caller_request_key => 'provider-step-parent',
            p_parent_request_sha256 => repeat('a', 64),
            p_stripe_connected_account_id => 'acct_provider_step_contract',
            p_connect_account_generation => 1, p_plan_sha256 => v_plan_sha,
            p_step_order => 1, p_step_name => 'customer.create',
            p_provider_operation => 'stripe.customers.create',
            p_step_request_sha256 => repeat('1', 64),
            p_stripe_idempotency_key => 'step-contract-customer',
            p_lease_owner => v_step_lease,
            p_expected_step_revision => (v_result->'step'->>'revision')::BIGINT,
            p_to_state => 'provider_succeeded',
            p_provider_object_id => 'https://provider.invalid/secret'
        );
        RAISE EXCEPTION 'Provider URL was accepted as durable step evidence.';
    EXCEPTION WHEN check_violation THEN
        IF SQLERRM NOT LIKE '%billing_provider_operation_steps_provider_ids_bounded%' THEN RAISE; END IF;
    END;
    IF public.claim_billing_provider_operation_step_v1(
        v_operation, v_studio, v_owner, 'plan.sync', 'provider-step-parent',
        repeat('a', 64), 'acct_provider_step_contract', 1, v_plan_sha,
        1, 'customer.create', 'stripe.customers.create', repeat('1', 64),
        'step-contract-customer', gen_random_uuid(), 30
    )->>'outcome' <> 'provider_request_in_flight' THEN
        RAISE EXCEPTION 'Ambiguous step was automatically re-leased.';
    END IF;

    v_step_revision := (v_result->'step'->>'revision')::BIGINT;
    v_result := public.authorize_billing_provider_operation_step_recovery_v1(
        v_operation, v_studio, v_owner, 'plan.sync', 'provider-step-parent',
        repeat('a', 64), 'acct_provider_step_contract', 1, v_plan_sha,
        1, 'customer.create', 'stripe.customers.create', repeat('1', 64),
        'step-contract-customer', v_owner, repeat('3', 64),
        'provider_no_object_safe_to_retry', v_recovery_lease, 30, v_step_revision
    );
    v_parent_revision := (v_result->'operation'->>'revision')::BIGINT;
    v_step_revision := (v_result->'step'->>'revision')::BIGINT;
    v_result := public.transition_billing_provider_operation_step_v1(
        v_operation, v_studio, v_owner, 'plan.sync', 'provider-step-parent',
        repeat('a', 64), 'acct_provider_step_contract', 1, v_plan_sha,
        1, 'customer.create', 'stripe.customers.create', repeat('1', 64),
        'step-contract-customer', v_recovery_lease, v_step_revision,
        'provider_request_in_flight'
    );
    IF (v_result->'step'->>'provider_request_attempt_count')::INTEGER <> 2 THEN
        RAISE EXCEPTION 'Proof-authorized retry was not attempt two.';
    END IF;
    v_step_revision := (v_result->'step'->>'revision')::BIGINT;
    v_result := public.transition_billing_provider_operation_step_v1(
        p_operation_id => v_operation, p_studio_id => v_studio, p_actor_id => v_owner,
        p_operation_type => 'plan.sync', p_caller_request_key => 'provider-step-parent',
        p_parent_request_sha256 => repeat('a', 64),
        p_stripe_connected_account_id => 'acct_provider_step_contract',
        p_connect_account_generation => 1, p_plan_sha256 => v_plan_sha,
        p_step_order => 1, p_step_name => 'customer.create',
        p_provider_operation => 'stripe.customers.create',
        p_step_request_sha256 => repeat('1', 64),
        p_stripe_idempotency_key => 'step-contract-customer',
        p_lease_owner => v_recovery_lease, p_expected_step_revision => v_step_revision,
        p_to_state => 'provider_succeeded', p_provider_object_id => 'cus_step_contract'
    );

    v_step_lease := gen_random_uuid();
    v_result := public.claim_billing_provider_operation_step_v1(
        v_operation, v_studio, v_owner, 'plan.sync', 'provider-step-parent',
        repeat('a', 64), 'acct_provider_step_contract', 1, v_plan_sha,
        2, 'subscription.create', 'stripe.subscriptions.create', repeat('2', 64),
        'step-contract-subscription', v_step_lease, 30
    );
    v_step_revision := (v_result->'step'->>'revision')::BIGINT;
    v_result := public.transition_billing_provider_operation_step_v1(
        v_operation, v_studio, v_owner, 'plan.sync', 'provider-step-parent',
        repeat('a', 64), 'acct_provider_step_contract', 1, v_plan_sha,
        2, 'subscription.create', 'stripe.subscriptions.create', repeat('2', 64),
        'step-contract-subscription', v_step_lease, v_step_revision,
        'provider_request_in_flight'
    );
    v_step_revision := (v_result->'step'->>'revision')::BIGINT;
    v_result := public.transition_billing_provider_operation_step_v1(
        p_operation_id => v_operation, p_studio_id => v_studio, p_actor_id => v_owner,
        p_operation_type => 'plan.sync', p_caller_request_key => 'provider-step-parent',
        p_parent_request_sha256 => repeat('a', 64),
        p_stripe_connected_account_id => 'acct_provider_step_contract',
        p_connect_account_generation => 1, p_plan_sha256 => v_plan_sha,
        p_step_order => 2, p_step_name => 'subscription.create',
        p_provider_operation => 'stripe.subscriptions.create',
        p_step_request_sha256 => repeat('2', 64),
        p_stripe_idempotency_key => 'step-contract-subscription',
        p_lease_owner => v_step_lease, p_expected_step_revision => v_step_revision,
        p_to_state => 'reconciliation_required',
        p_reconciliation_reason_code => 'provider_response_unknown'
    );
    v_parent_revision := (v_result->'operation'->>'revision')::BIGINT;
    v_result := public.complete_billing_provider_operation_provider_phase_v1(
        v_operation, v_studio, v_owner, 'plan.sync', 'provider-step-parent',
        repeat('a', 64), 'acct_provider_step_contract', 1,
        v_plan_sha, 2, v_parent_revision
    );
    IF v_result->>'outcome' <> 'reconciliation_required'
       OR v_result->'operation'->>'state' <> 'reconciliation_required' THEN
        RAISE EXCEPTION 'Partial success was not held for reconciliation.';
    END IF;
    v_parent_revision := (v_result->'operation'->>'revision')::BIGINT;
    v_step_revision := (
        SELECT revision FROM public.billing_provider_operation_steps
        WHERE operation_id = v_operation AND step_order = 2
    );
    v_recovery_lease := gen_random_uuid();
    v_result := public.authorize_billing_provider_operation_step_recovery_v1(
        v_operation, v_studio, v_owner, 'plan.sync', 'provider-step-parent',
        repeat('a', 64), 'acct_provider_step_contract', 1, v_plan_sha,
        2, 'subscription.create', 'stripe.subscriptions.create', repeat('2', 64),
        'step-contract-subscription', v_owner, repeat('4', 64),
        'provider_succeeded_reconcile_only', v_recovery_lease, 30, v_step_revision
    );
    v_parent_revision := (v_result->'operation'->>'revision')::BIGINT;
    v_step_revision := (v_result->'step'->>'revision')::BIGINT;
    v_result := public.transition_billing_provider_operation_step_v1(
        p_operation_id => v_operation, p_studio_id => v_studio, p_actor_id => v_owner,
        p_operation_type => 'plan.sync', p_caller_request_key => 'provider-step-parent',
        p_parent_request_sha256 => repeat('a', 64),
        p_stripe_connected_account_id => 'acct_provider_step_contract',
        p_connect_account_generation => 1, p_plan_sha256 => v_plan_sha,
        p_step_order => 2, p_step_name => 'subscription.create',
        p_provider_operation => 'stripe.subscriptions.create',
        p_step_request_sha256 => repeat('2', 64),
        p_stripe_idempotency_key => 'step-contract-subscription',
        p_lease_owner => v_recovery_lease, p_expected_step_revision => v_step_revision,
        p_to_state => 'provider_succeeded', p_provider_object_id => 'sub_step_contract'
    );
    v_result := public.complete_billing_provider_operation_provider_phase_v1(
        v_operation, v_studio, v_owner, 'plan.sync', 'provider-step-parent',
        repeat('a', 64), 'acct_provider_step_contract', 1,
        v_plan_sha, 2, v_parent_revision
    );
    IF v_result->>'outcome' <> 'provider_succeeded'
       OR v_result->'operation'->>'state' <> 'provider_succeeded'
       OR v_result->'operation'->>'provider_object_id' <> 'sub_step_contract' THEN
        RAISE EXCEPTION 'Complete step set did not converge the parent with final provider evidence.';
    END IF;
END;
$$;

-- BEGIN provider resource claim behavior
DO $$
DECLARE
    v_owner UUID := gen_random_uuid();
    v_other_owner UUID := gen_random_uuid();
    v_reader UUID := gen_random_uuid();
    v_studio UUID := gen_random_uuid();
    v_other_studio UUID := gen_random_uuid();
    v_payer UUID := gen_random_uuid();
    v_other_payer UUID := gen_random_uuid();
    v_invoice UUID := gen_random_uuid();
    v_terminal_invoice UUID := gen_random_uuid();
    v_student UUID := gen_random_uuid();
    v_other_student UUID := gen_random_uuid();
    v_plan UUID := gen_random_uuid();
    v_enrollment UUID := gen_random_uuid();
    v_other_enrollment UUID := gen_random_uuid();
    v_enrollment_operation UUID;
    v_other_enrollment_operation UUID;
    v_lease UUID := gen_random_uuid();
    v_operation UUID;
    v_terminal_operation UUID;
    v_replacement_operation UUID;
    v_revision BIGINT;
    v_enrollment_revision BIGINT;
    v_result JSONB;
    v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
    IF has_table_privilege(
        'service_role', 'public.billing_provider_operation_resources',
        'SELECT,INSERT,UPDATE,DELETE'
    ) OR has_table_privilege(
        'service_role', 'public.billing_provider_operation_resource_aliases',
        'SELECT,INSERT,UPDATE,DELETE'
    ) OR NOT has_function_privilege(
        'service_role',
        'public.claim_billing_provider_operation_resource_v1(uuid,uuid,text,text,uuid,uuid,text,text,text,integer,uuid,integer)',
        'EXECUTE'
    ) OR has_function_privilege(
        'authenticated',
        'public.claim_billing_provider_operation_resource_v1(uuid,uuid,text,text,uuid,uuid,text,text,text,integer,uuid,integer)',
        'EXECUTE'
    ) THEN
        RAISE EXCEPTION 'Provider resource claim ACLs are not service-only.';
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name IN (
            'billing_provider_operation_resources',
            'billing_provider_operation_resource_aliases'
          )
          AND column_name = 'metadata'
    ) THEN
        RAISE EXCEPTION 'Provider resource claims gained mutable metadata.';
    END IF;

    INSERT INTO auth.users(
        id, aud, role, email, raw_app_meta_data, raw_user_meta_data,
        created_at, updated_at
    ) VALUES (
        v_owner, 'authenticated', 'authenticated',
        'provider-resource-owner@example.invalid', '{}', '{}', v_now, v_now
    ), (
        v_other_owner, 'authenticated', 'authenticated',
        'provider-resource-other@example.invalid', '{}', '{}', v_now, v_now
    ), (
        v_reader, 'authenticated', 'authenticated',
        'provider-resource-reader@example.invalid', '{}', '{}', v_now, v_now
    );
    INSERT INTO public.studios(id, name, slug, owner_id) VALUES
        (v_studio, 'Provider resource contract',
         'provider-resource-' || replace(v_studio::TEXT, '-', ''), v_owner),
        (v_other_studio, 'Other provider resource contract',
         'provider-resource-other-' || replace(v_other_studio::TEXT, '-', ''), v_other_owner);
    INSERT INTO public.staff_roles(studio_id, user_id, role) VALUES
        (v_studio, v_owner, 'admin'),
        (v_studio, v_reader, 'front_desk'),
        (v_other_studio, v_other_owner, 'admin');
    INSERT INTO public.billing_payers(
        id, studio_id, display_name, stripe_account_id, stripe_customer_id,
        connect_account_generation
    ) VALUES
        (v_payer, v_studio, 'Provider resource payer',
         'acct_resource_contract', 'cus_resource_contract', 1),
        (v_other_payer, v_studio, 'Other provider resource payer',
         'acct_resource_contract', 'cus_resource_other_contract', 1);
    INSERT INTO public.billing_invoices(
        id, studio_id, payer_id, stripe_invoice_id, stripe_account_id, status
    ) VALUES
        (v_invoice, v_studio, v_payer, 'in_resource_contract',
         'acct_resource_contract', 'open'),
        (v_terminal_invoice, v_studio, v_payer, 'in_resource_terminal',
         'acct_resource_contract', 'open');
    INSERT INTO public.students(id, studio_id, legal_first_name, legal_last_name)
    VALUES
        (v_student, v_studio, 'Resource', 'Enrollment'),
        (v_other_student, v_studio, 'Other', 'Enrollment');
    INSERT INTO public.billing_plans(id, studio_id, name, amount_cents, status)
    VALUES (v_plan, v_studio, 'Resource enrollment plan', 1000, 'active');
    INSERT INTO public.student_billing_enrollments(
        id, studio_id, student_id, payer_id, billing_plan_id, status
    ) VALUES
        (v_enrollment, v_studio, v_student, v_payer, v_plan, 'pending'),
        (v_other_enrollment, v_studio, v_other_student, v_payer, v_plan, 'pending');

    v_result := public.claim_billing_provider_operation_resource_v1(
        v_studio, v_owner, 'invoice.retry', 'invoice', v_invoice,
        v_payer,
        'resource-key-a', repeat('a', 64), 'acct_resource_contract', 1,
        v_lease, 30
    );
    v_operation := (v_result->'operation'->>'id')::UUID;
    IF v_result->>'outcome' <> 'claimed'
       OR v_result->>'canonical_caller_request_key' <> 'resource-key-a'
       OR v_result->>'requested_caller_request_key' <> 'resource-key-a'
       OR (v_result->'resource'->>'operation_id')::UUID <> v_operation THEN
        RAISE EXCEPTION 'Initial provider resource claim was not canonical: %', v_result;
    END IF;
    IF public.claim_billing_provider_operation_resource_v1(
        v_studio, v_owner, 'invoice.retry', 'invoice', v_invoice,
        v_payer,
        'resource-key-a', repeat('a', 64), 'acct_resource_contract', 1,
        v_lease, 30
    )->>'outcome' <> 'replay' THEN
        RAISE EXCEPTION 'Exact provider resource alias did not replay.';
    END IF;
    BEGIN
        PERFORM public.claim_billing_provider_operation_resource_v1(
            v_studio, v_reader, 'invoice.retry', 'invoice', v_invoice,
            v_payer,
            'resource-key-a', repeat('a', 64), 'acct_resource_contract', 1,
            gen_random_uuid(), 30
        );
        RAISE EXCEPTION 'A different actor replayed the canonical resource key.';
    EXCEPTION WHEN unique_violation THEN
        IF SQLERRM <> 'billing_provider_operation_resource_actor_conflict' THEN RAISE; END IF;
    END;
    BEGIN
        PERFORM public.claim_billing_provider_operation_resource_v1(
            v_studio, v_reader, 'invoice.retry', 'invoice', v_invoice,
            v_payer,
            'resource-cross-actor-alias', repeat('a', 64),
            'acct_resource_contract', 1, gen_random_uuid(), 30
        );
        RAISE EXCEPTION 'A different actor adopted the resource under a new key.';
    EXCEPTION WHEN unique_violation THEN
        IF SQLERRM <> 'billing_provider_operation_resource_actor_conflict' THEN RAISE; END IF;
    END;
    v_result := public.claim_billing_provider_operation_resource_v1(
        v_studio, v_owner, 'invoice.retry', 'invoice', v_invoice,
        v_payer,
        'resource-key-b', repeat('a', 64), 'acct_resource_contract', 1,
        v_lease, 30
    );
    IF v_result->>'outcome' <> 'adopted'
       OR (v_result->'operation'->>'id')::UUID <> v_operation
       OR v_result->>'canonical_caller_request_key' <> 'resource-key-a'
       OR (SELECT count(*) FROM public.billing_provider_operation_resource_aliases
           WHERE operation_id = v_operation) <> 2 THEN
        RAISE EXCEPTION 'Different caller key did not adopt one parent: %', v_result;
    END IF;

    BEGIN
        PERFORM public.claim_billing_provider_operation_resource_v1(
            v_studio, v_owner, 'invoice.retry', 'invoice', v_invoice,
            v_payer,
            'resource-hash-conflict', repeat('b', 64), 'acct_resource_contract', 1,
            gen_random_uuid(), 30
        );
        RAISE EXCEPTION 'Resource adoption accepted a changed request hash.';
    EXCEPTION WHEN unique_violation THEN
        IF SQLERRM <> 'billing_provider_operation_resource_request_conflict' THEN RAISE; END IF;
    END;
    BEGIN
        PERFORM public.claim_billing_provider_operation_resource_v1(
            v_studio, v_owner, 'invoice.retry', 'invoice', v_invoice,
            v_payer,
            'resource-account-conflict', repeat('a', 64), 'acct_wrong_resource', 1,
            gen_random_uuid(), 30
        );
        RAISE EXCEPTION 'Resource adoption accepted a changed account.';
    EXCEPTION WHEN check_violation THEN
        IF SQLERRM <> 'billing_provider_operation_resource_payer_identity_mismatch' THEN RAISE; END IF;
    END;
    BEGIN
        PERFORM public.claim_billing_provider_operation_resource_v1(
            v_studio, v_owner, 'invoice.retry', 'invoice', v_invoice,
            v_payer,
            'resource-generation-conflict', repeat('a', 64), 'acct_resource_contract', 2,
            gen_random_uuid(), 30
        );
        RAISE EXCEPTION 'Resource adoption accepted a changed generation.';
    EXCEPTION WHEN check_violation THEN
        IF SQLERRM <> 'billing_provider_operation_resource_payer_identity_mismatch' THEN RAISE; END IF;
    END;
    BEGIN
        PERFORM public.claim_billing_provider_operation_resource_v1(
            v_studio, v_owner, 'invoice.retry', 'invoice', v_invoice,
            v_other_payer,
            'resource-payer-conflict', repeat('a', 64), 'acct_resource_contract', 1,
            gen_random_uuid(), 30
        );
        RAISE EXCEPTION 'Resource adoption accepted a changed payer.';
    EXCEPTION WHEN check_violation THEN
        IF SQLERRM <> 'billing_provider_operation_resource_tenant_mismatch' THEN RAISE; END IF;
    END;
    BEGIN
        PERFORM public.claim_billing_provider_operation_resource_v1(
            v_other_studio, v_other_owner, 'invoice.retry', 'invoice', v_invoice,
            v_payer,
            'resource-studio-conflict', repeat('a', 64), 'acct_resource_contract', 1,
            gen_random_uuid(), 30
        );
        RAISE EXCEPTION 'Resource claim crossed studio identity.';
    EXCEPTION WHEN check_violation THEN
        IF SQLERRM <> 'billing_provider_operation_resource_tenant_mismatch' THEN RAISE; END IF;
    END;
    BEGIN
        PERFORM public.claim_billing_provider_operation_resource_v1(
            v_studio, v_owner, 'invoice.retry', 'invoice.%', v_invoice,
            v_payer,
            'resource-wildcard', repeat('a', 64), 'acct_resource_contract', 1,
            gen_random_uuid(), 30
        );
        RAISE EXCEPTION 'Wildcard provider resource type was accepted.';
    EXCEPTION WHEN invalid_parameter_value THEN
        IF SQLERRM <> 'billing_provider_operation_resource_claim_invalid' THEN RAISE; END IF;
    END;

    v_revision := (v_result->'operation'->>'revision')::BIGINT;
    v_result := public.transition_billing_provider_operation_v1(
        p_operation_id => v_operation, p_studio_id => v_studio,
        p_actor_id => v_owner, p_operation_type => 'invoice.retry',
        p_caller_request_key => 'resource-key-a',
        p_request_sha256 => repeat('a', 64),
        p_stripe_connected_account_id => 'acct_resource_contract',
        p_connect_account_generation => 1, p_lease_owner => v_lease,
        p_expected_revision => v_revision,
        p_to_state => 'provider_request_in_flight'
    );
    v_result := public.transition_billing_provider_operation_v1(
        p_operation_id => v_operation, p_studio_id => v_studio,
        p_actor_id => v_owner, p_operation_type => 'invoice.retry',
        p_caller_request_key => 'resource-key-a',
        p_request_sha256 => repeat('a', 64),
        p_stripe_connected_account_id => 'acct_resource_contract',
        p_connect_account_generation => 1, p_lease_owner => v_lease,
        p_expected_revision => (v_result->'operation'->>'revision')::BIGINT,
        p_to_state => 'provider_succeeded',
        p_provider_object_id => 'in_resource_contract'
    );
    v_result := public.transition_billing_provider_operation_v1(
        p_operation_id => v_operation, p_studio_id => v_studio,
        p_actor_id => v_owner, p_operation_type => 'invoice.retry',
        p_caller_request_key => 'resource-key-a',
        p_request_sha256 => repeat('a', 64),
        p_stripe_connected_account_id => 'acct_resource_contract',
        p_connect_account_generation => 1, p_lease_owner => v_lease,
        p_expected_revision => (v_result->'operation'->>'revision')::BIGINT,
        p_to_state => 'projected',
        p_provider_object_id => 'in_resource_contract'
    );
    v_result := public.complete_billing_provider_operation_v1(
        v_operation, v_studio, v_owner, 'invoice.retry', 'resource-key-a',
        repeat('a', 64), 'acct_resource_contract', 1, v_lease,
        (v_result->'operation'->>'revision')::BIGINT,
        'invoice_retry_completed', NULL
    );
    v_result := public.claim_billing_provider_operation_resource_v1(
        v_studio, v_owner, 'invoice.retry', 'invoice', v_invoice,
        v_payer,
        'resource-completed-alias', repeat('a', 64), 'acct_resource_contract', 1,
        gen_random_uuid(), 30
    );
    IF v_result->>'outcome' <> 'adopted'
       OR v_result->'operation'->>'state' <> 'completed'
       OR (v_result->'operation'->>'id')::UUID <> v_operation THEN
        RAISE EXCEPTION 'Completed resource owner was replaced instead of adopted: %', v_result;
    END IF;

    v_lease := gen_random_uuid();
    v_result := public.claim_billing_provider_operation_resource_v1(
        v_studio, v_owner, 'invoice.retry', 'invoice', v_terminal_invoice,
        v_payer,
        'resource-terminal-a', repeat('c', 64), 'acct_resource_contract', 1,
        v_lease, 30
    );
    v_terminal_operation := (v_result->'operation'->>'id')::UUID;
    PERFORM public.transition_billing_provider_operation_v1(
        p_operation_id => v_terminal_operation, p_studio_id => v_studio,
        p_actor_id => v_owner, p_operation_type => 'invoice.retry',
        p_caller_request_key => 'resource-terminal-a',
        p_request_sha256 => repeat('c', 64),
        p_stripe_connected_account_id => 'acct_resource_contract',
        p_connect_account_generation => 1, p_lease_owner => v_lease,
        p_expected_revision => (v_result->'operation'->>'revision')::BIGINT,
        p_to_state => 'definitive_rejected',
        p_error_code => 'invoice_retry_definitive_rejection'
    );
    v_result := public.claim_billing_provider_operation_resource_v1(
        v_studio, v_owner, 'invoice.retry', 'invoice', v_terminal_invoice,
        v_payer,
        'resource-terminal-b', repeat('c', 64), 'acct_resource_contract', 1,
        gen_random_uuid(), 30
    );
    v_replacement_operation := (v_result->'operation'->>'id')::UUID;
    IF v_result->>'outcome' <> 'replaced'
       OR v_replacement_operation = v_terminal_operation
       OR (v_result->'resource'->>'operation_id')::UUID <> v_replacement_operation THEN
        RAISE EXCEPTION 'Definitive terminal resource owner was not replaced: %', v_result;
    END IF;
    v_result := public.claim_billing_provider_operation_resource_v1(
        v_studio, v_owner, 'invoice.retry', 'invoice', v_terminal_invoice,
        v_payer,
        'resource-terminal-a', repeat('c', 64), 'acct_resource_contract', 1,
        gen_random_uuid(), 30
    );
    IF v_result->>'outcome' <> 'replay'
       OR (v_result->'operation'->>'id')::UUID <> v_terminal_operation
       OR (v_result->'resource'->>'operation_id')::UUID <> v_terminal_operation THEN
        RAISE EXCEPTION 'Historical terminal alias did not remain immutable: %', v_result;
    END IF;
    BEGIN
        UPDATE public.billing_provider_operation_resource_aliases
        SET caller_request_key = 'mutated-resource-alias'
        WHERE operation_id = v_terminal_operation;
        RAISE EXCEPTION 'Provider resource alias identity was mutable.';
    EXCEPTION WHEN check_violation THEN
        IF SQLERRM <> 'billing_provider_operation_resource_alias_immutable' THEN RAISE; END IF;
    END;

    v_lease := gen_random_uuid();
    v_result := public.claim_billing_provider_operation_resource_v1(
        v_studio, v_owner, 'enrollment.activate.autopay', 'enrollment',
        v_enrollment, v_payer,
        'enrollment-resource-a', repeat('d', 64), 'acct_resource_contract', 1,
        v_lease, 30
    );
    v_enrollment_operation := (v_result->'operation'->>'id')::UUID;
    IF v_result->>'outcome' <> 'claimed'
       OR (v_result->'resource'->>'payer_id')::UUID <> v_payer THEN
        RAISE EXCEPTION 'Enrollment resource owner was not payer-bound: %', v_result;
    END IF;
    v_result := public.claim_billing_provider_operation_resource_v1(
        v_studio, v_owner, 'enrollment.activate.autopay', 'enrollment',
        v_enrollment, v_payer,
        'enrollment-resource-b', repeat('d', 64), 'acct_resource_contract', 1,
        v_lease, 30
    );
    v_enrollment_revision := (v_result->'operation'->>'revision')::BIGINT;
    IF v_result->>'outcome' <> 'adopted'
       OR (v_result->'operation'->>'id')::UUID <> v_enrollment_operation
       OR v_result->>'canonical_caller_request_key' <> 'enrollment-resource-a' THEN
        RAISE EXCEPTION 'Two enrollment keys did not adopt one parent: %', v_result;
    END IF;
    BEGIN
        PERFORM public.claim_billing_provider_operation_resource_v1(
            v_studio, v_owner, 'enrollment.activate.invoice', 'enrollment',
            v_enrollment, v_payer,
            'enrollment-mode-conflict', repeat('d', 64),
            'acct_resource_contract', 1, gen_random_uuid(), 30
        );
        RAISE EXCEPTION 'One enrollment admitted concurrent activation modes.';
    EXCEPTION WHEN unique_violation THEN
        IF SQLERRM <> 'billing_provider_operation_resource_request_conflict' THEN RAISE; END IF;
    END;
    BEGIN
        PERFORM public.claim_billing_provider_operation_resource_v1(
            v_studio, v_owner, 'enrollment.activate.autopay', 'enrollment',
            v_enrollment, v_payer,
            'enrollment-hash-conflict', repeat('e', 64),
            'acct_resource_contract', 1, gen_random_uuid(), 30
        );
        RAISE EXCEPTION 'Enrollment adoption accepted a changed request hash.';
    EXCEPTION WHEN unique_violation THEN
        IF SQLERRM <> 'billing_provider_operation_resource_request_conflict' THEN RAISE; END IF;
    END;
    BEGIN
        PERFORM public.claim_billing_provider_operation_resource_v1(
            v_studio, v_owner, 'enrollment.activate.autopay', 'enrollment',
            v_enrollment, v_other_payer,
            'enrollment-payer-conflict', repeat('d', 64),
            'acct_resource_contract', 1, gen_random_uuid(), 30
        );
        RAISE EXCEPTION 'Enrollment adoption accepted a changed payer.';
    EXCEPTION WHEN check_violation THEN
        IF SQLERRM <> 'billing_provider_operation_resource_tenant_mismatch' THEN RAISE; END IF;
    END;
    BEGIN
        PERFORM public.claim_billing_provider_operation_resource_v1(
            v_studio, v_owner, 'enrollment.activate.autopay', 'enrollment',
            v_enrollment, v_payer,
            'enrollment-account-conflict', repeat('d', 64),
            'acct_wrong_resource', 1, gen_random_uuid(), 30
        );
        RAISE EXCEPTION 'Enrollment adoption accepted a changed account.';
    EXCEPTION WHEN check_violation THEN
        IF SQLERRM <> 'billing_provider_operation_resource_payer_identity_mismatch' THEN RAISE; END IF;
    END;
    BEGIN
        PERFORM public.claim_billing_provider_operation_resource_v1(
            v_studio, v_owner, 'enrollment.activate.autopay', 'enrollment',
            v_enrollment, v_payer,
            'enrollment-generation-conflict', repeat('d', 64),
            'acct_resource_contract', 2, gen_random_uuid(), 30
        );
        RAISE EXCEPTION 'Enrollment adoption accepted a changed generation.';
    EXCEPTION WHEN check_violation THEN
        IF SQLERRM <> 'billing_provider_operation_resource_payer_identity_mismatch' THEN RAISE; END IF;
    END;

    v_result := public.claim_billing_provider_operation_resource_v1(
        v_studio, v_owner, 'enrollment.activate.invoice', 'enrollment',
        v_other_enrollment, v_payer,
        'other-enrollment-resource', repeat('f', 64),
        'acct_resource_contract', 1, gen_random_uuid(), 30
    );
    v_other_enrollment_operation := (v_result->'operation'->>'id')::UUID;
    IF v_result->>'outcome' <> 'claimed'
       OR v_other_enrollment_operation = v_enrollment_operation THEN
        RAISE EXCEPTION 'Distinct enrollments did not receive isolated owners: %', v_result;
    END IF;

    PERFORM public.transition_billing_provider_operation_v1(
        p_operation_id => v_enrollment_operation, p_studio_id => v_studio,
        p_actor_id => v_owner,
        p_operation_type => 'enrollment.activate.autopay',
        p_caller_request_key => 'enrollment-resource-a',
        p_request_sha256 => repeat('d', 64),
        p_stripe_connected_account_id => 'acct_resource_contract',
        p_connect_account_generation => 1, p_lease_owner => v_lease,
        p_expected_revision => v_enrollment_revision,
        p_to_state => 'definitive_rejected',
        p_error_code => 'enrollment_activation_definitive_rejection'
    );
    v_result := public.claim_billing_provider_operation_resource_v1(
        v_studio, v_owner, 'enrollment.activate.autopay', 'enrollment',
        v_enrollment, v_payer,
        'enrollment-resource-replacement', repeat('d', 64),
        'acct_resource_contract', 1, gen_random_uuid(), 30
    );
    IF v_result->>'outcome' <> 'replaced'
       OR (v_result->'operation'->>'id')::UUID = v_enrollment_operation
       OR (v_result->'resource'->>'payer_id')::UUID <> v_payer THEN
        RAISE EXCEPTION 'Definitive enrollment owner was not safely replaced: %', v_result;
    END IF;
END;
$$;
-- END provider resource claim behavior

-- Drift the same complete function set through owner-supported DDL. Direct pg_proc
-- writes are unavailable in the hardened Supabase local container and are not a
-- supported administration surface. Each ALTER changes pg_get_functiondef and the
-- manifest's pinned configuration signal, then this transaction rolls everything back.
ALTER FUNCTION private.preserve_billing_provider_operation_step_v1()
    SET search_path = public;
ALTER FUNCTION private.enforce_billing_provider_step_parent_v1()
    SET search_path = public;
ALTER FUNCTION private.enforce_billing_payer_connect_identity_v1()
    SET search_path = public;
ALTER FUNCTION private.preserve_billing_provider_operation_resource_v1()
    SET search_path = public;
ALTER FUNCTION private.preserve_billing_provider_operation_resource_alias_v1()
    SET search_path = public;
ALTER FUNCTION public.finalize_billing_payer_setup_projection_v1(
    UUID, UUID, UUID, UUID, UUID, TEXT, TEXT, TEXT, INTEGER
) SET search_path = public;
ALTER FUNCTION public.claim_billing_provider_operation_resource_v1(
    UUID, UUID, TEXT, TEXT, UUID, UUID, TEXT, TEXT, TEXT, INTEGER, UUID, INTEGER
) SET search_path = public;
ALTER FUNCTION private.koaryu_release_operational_manifest_v9()
    SET search_path = public;

DO $$
DECLARE
    v_preflight RECORD;
BEGIN
    SELECT * INTO v_preflight FROM public.koaryu_release_schema_preflight_v8();
    IF v_preflight.ready IS DISTINCT FROM false
       OR NOT ('provider_operation_steps_manifest_v28' = ANY(v_preflight.security_failures))
       OR NOT ('operational_contract_v28' = ANY(v_preflight.security_failures)) THEN
        RAISE EXCEPTION 'V8 accepted tampered step or payer-generation functions: %',
            row_to_json(v_preflight);
    END IF;
END;
$$;

ROLLBACK;
