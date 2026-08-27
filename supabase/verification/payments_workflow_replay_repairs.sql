BEGIN;

DO $$
DECLARE
    v_admin UUID := gen_random_uuid();
    v_other_admin UUID := gen_random_uuid();
    v_front_desk UUID := gen_random_uuid();
    v_studio UUID := gen_random_uuid();
    v_plan UUID := gen_random_uuid();
    v_payer UUID := gen_random_uuid();
    v_due_payer UUID := gen_random_uuid();
    v_student UUID := gen_random_uuid();
    v_due_student UUID := gen_random_uuid();
    v_group UUID := gen_random_uuid();
    v_due_group UUID := gen_random_uuid();
    v_enrollment UUID := gen_random_uuid();
    v_due_enrollment UUID := gen_random_uuid();
    v_schedule UUID := gen_random_uuid();
    v_due_schedule UUID := gen_random_uuid();
    v_due_execute UUID := gen_random_uuid();
    v_invoice UUID := gen_random_uuid();
    v_worker UUID := gen_random_uuid();
    v_result JSONB;
    v_operation UUID;
    v_has_v31_invoice_owner BOOLEAN :=
        to_regclass('public.billing_invoice_mutation_owners') IS NOT NULL;
BEGIN
    IF has_function_privilege(
        'authenticated',
        'public.read_billing_enrollment_transition_by_key_v1(uuid,uuid,text,text,text,uuid)',
        'EXECUTE'
    ) OR NOT has_function_privilege(
        'service_role',
        'public.read_billing_enrollment_transition_by_key_v1(uuid,uuid,text,text,text,uuid)',
        'EXECUTE'
    ) OR has_function_privilege(
        'authenticated',
        'public.claim_billing_invoice_closeout_operation_v1(uuid,uuid,text,text,uuid,uuid,text,text,text,integer,uuid,integer)',
        'EXECUTE'
    ) OR NOT has_function_privilege(
        'service_role',
        'public.claim_billing_invoice_closeout_operation_v1(uuid,uuid,text,text,uuid,uuid,text,text,text,integer,uuid,integer)',
        'EXECUTE'
    ) THEN
        RAISE EXCEPTION 'V30 replay-repair RPC ACLs are not service-only.';
    END IF;
    IF NOT private.live_billing_operation_set_is_canonical_v1(
        'connect_payments',
        ARRAY['connected_invoice.finalize','connected_invoice.send']::TEXT[]
    ) OR private.live_billing_operation_set_is_canonical_v1(
        'connect_payments', ARRAY[]::TEXT[]
    ) OR private.live_billing_operation_set_is_canonical_v1(
        'connect_payments',
        ARRAY['connected_invoice.send','connected_invoice.finalize']::TEXT[]
    ) OR private.live_billing_operation_set_is_canonical_v1(
        'connect_payments',
        ARRAY['connected_invoice.send','connected_invoice.send']::TEXT[]
    ) OR private.live_billing_operation_set_is_canonical_v1(
        'connect_payments', ARRAY['connected_invoice.*']::TEXT[]
    ) OR private.live_billing_operation_set_is_canonical_v1(
        'connect_payments', ARRAY['connected_unknown.create']::TEXT[]
    ) THEN
        RAISE EXCEPTION 'V30 exact operation-set canonicalization is not fail-closed.';
    END IF;
    IF NOT has_function_privilege(
        'service_role',
        'public.set_studio_live_billing_authorization_operations_v1(uuid,text,boolean,timestamp with time zone,text,uuid,text[],text,text)',
        'EXECUTE'
    ) OR has_function_privilege(
        'service_role',
        'public.set_studio_live_billing_authorization_scope_v3(uuid,text,boolean,timestamp with time zone,text,uuid,text,text)',
        'EXECUTE'
    ) OR NOT has_function_privilege(
        'service_role',
        'public.authorize_studio_live_billing_mutation_atomic(uuid,text,text,text,text)',
        'EXECUTE'
    ) OR has_function_privilege(
        'service_role',
        'public.authorize_studio_live_billing_scope_v3(uuid,text,text,text,text)',
        'EXECUTE'
    ) OR NOT has_function_privilege(
        'service_role',
        'public.set_studio_live_billing_authorization_atomic(uuid,text,boolean,timestamp with time zone,text,uuid,text,text)',
        'EXECUTE'
    ) THEN
        RAISE EXCEPTION 'V30 operation-aware grant wrappers can be bypassed.';
    END IF;
    BEGIN
        PERFORM public.set_studio_live_billing_authorization_atomic(
            NULL, 'connect_payments', true, now() + interval '1 hour',
            'legacy enable contract', NULL, NULL, NULL
        );
        RAISE EXCEPTION 'Legacy operation-unbounded authorization enabled a grant.';
    EXCEPTION WHEN feature_not_supported THEN
        IF SQLERRM <> 'operation_bounded_live_authorization_required' THEN RAISE; END IF;
    END;

    INSERT INTO auth.users(
        id, aud, role, email, raw_app_meta_data, raw_user_meta_data,
        created_at, updated_at
    ) VALUES
        (v_admin, 'authenticated', 'authenticated',
         'v30-admin@example.invalid', '{}', '{}', now(), now()),
        (v_other_admin, 'authenticated', 'authenticated',
         'v30-other-admin@example.invalid', '{}', '{}', now(), now()),
        (v_front_desk, 'authenticated', 'authenticated',
         'v30-front-desk@example.invalid', '{}', '{}', now(), now());
    INSERT INTO public.studios(id, name, slug, owner_id)
    VALUES (
        v_studio, 'V30 replay contract',
        'v30-replay-' || replace(v_studio::TEXT, '-', ''), v_admin
    );
    INSERT INTO public.staff_roles(studio_id, user_id, role) VALUES
        (v_studio, v_admin, 'admin'),
        (v_studio, v_other_admin, 'admin'),
        (v_studio, v_front_desk, 'front_desk');
    INSERT INTO public.studio_payment_accounts(
        studio_id, stripe_connected_account_id, metadata
    ) VALUES (
        v_studio, 'acct_v30replay',
        jsonb_build_object('connect_account_generation', 1)
    );
    INSERT INTO public.billing_payers(
        id, studio_id, display_name, stripe_account_id,
        stripe_customer_id, connect_account_generation
    ) VALUES
        (v_payer, v_studio, 'V30 invoice payer',
         'acct_v30replay', 'cus_v30invoice', 1),
        (v_due_payer, v_studio, 'V30 due payer',
         'acct_v30replay', 'cus_v30due', 1);
    INSERT INTO public.billing_plans(
        id, studio_id, name, amount_cents, billing_interval, status
    ) VALUES (v_plan, v_studio, 'V30 plan', 5000, 'monthly', 'active');
    INSERT INTO public.students(id, studio_id, legal_first_name, legal_last_name) VALUES
        (v_student, v_studio, 'Replay', 'Student'),
        (v_due_student, v_studio, 'Due', 'Student');
    INSERT INTO public.billing_subscriptions(
        id, studio_id, payer_id, stripe_account_id, stripe_customer_id,
        stripe_subscription_id, collection_mode, billing_interval, currency,
        status, current_period_end, metadata
    ) VALUES
        (v_group, v_studio, v_payer, 'acct_v30replay', 'cus_v30invoice',
         'sub_v30replay', 'invoice_link', 'monthly', 'usd', 'active',
         now() + interval '1 day', jsonb_build_object('connect_account_generation', 1)),
        (v_due_group, v_studio, v_due_payer, 'acct_v30replay', 'cus_v30due',
         'sub_v30due', 'invoice_link', 'monthly', 'usd', 'active',
         now() - interval '1 second', jsonb_build_object('connect_account_generation', 1));
    INSERT INTO public.student_billing_enrollments(
        id, studio_id, student_id, payer_id, billing_plan_id,
        billing_subscription_id, collection_mode, status,
        stripe_subscription_id, stripe_subscription_item_id, metadata
    ) VALUES
        (v_enrollment, v_studio, v_student, v_payer, v_plan, v_group,
         'invoice_link', 'active', 'sub_v30replay', 'si_v30replay', '{}'),
        (v_due_enrollment, v_studio, v_due_student, v_due_payer, v_plan, v_due_group,
         'invoice_link', 'active', 'sub_v30due', 'si_v30due', '{}');

    INSERT INTO public.billing_enrollment_transition_intents(
        id, studio_id, enrollment_id, payer_id, billing_subscription_id,
        transition_kind, mutation_strategy, request_sha256,
        stripe_connected_account_id, connect_account_generation,
        stripe_subscription_id, stripe_subscription_item_id, period_boundary,
        expected_quantity, expected_subscription_item_count, same_item_active_count,
        provider_quantity, initiated_by, reason_code, state, completed_at
    ) VALUES (
        v_schedule, v_studio, v_enrollment, v_payer, v_group,
        'schedule_period_end', 'subscription_cancel_at_period_end', repeat('a', 64),
        'acct_v30replay', 1, 'sub_v30replay', 'si_v30replay', now() + interval '1 day',
        0, 1, 1, 1, v_admin, 'contract.completed', 'completed', now()
    );
    INSERT INTO public.billing_enrollment_transition_aliases(
        intent_id, studio_id, transition_kind, caller_request_key,
        actor_id, request_sha256
    ) VALUES (
        v_schedule, v_studio, 'schedule_period_end', 'completed-replay-key',
        v_admin, repeat('a', 64)
    );
    UPDATE public.student_billing_enrollments
    SET status = 'canceled',
        billing_subscription_id = NULL,
        stripe_subscription_id = NULL,
        stripe_subscription_item_id = NULL
    WHERE id = v_enrollment;
    v_result := public.read_billing_enrollment_transition_by_key_v1(
        v_studio, v_admin, 'schedule_period_end', 'completed-replay-key',
        repeat('a', 64), v_enrollment
    );
    IF v_result->>'outcome' <> 'read'
       OR (v_result->'intent'->>'id')::UUID <> v_schedule THEN
        RAISE EXCEPTION 'Completed transition replay did not survive mutable projection.';
    END IF;
    BEGIN
        PERFORM public.read_billing_enrollment_transition_by_key_v1(
            v_studio, v_other_admin, 'schedule_period_end', 'completed-replay-key',
            repeat('a', 64), v_enrollment
        );
        RAISE EXCEPTION 'Cross-actor completed transition replay was accepted.';
    EXCEPTION WHEN check_violation THEN
        IF SQLERRM <> 'billing_enrollment_transition_read_identity_mismatch' THEN RAISE; END IF;
    END;

    INSERT INTO public.billing_enrollment_transition_intents(
        id, studio_id, enrollment_id, payer_id, billing_subscription_id,
        transition_kind, mutation_strategy, request_sha256,
        stripe_connected_account_id, connect_account_generation,
        stripe_subscription_id, stripe_subscription_item_id, period_boundary,
        expected_quantity, expected_subscription_item_count, same_item_active_count,
        provider_quantity, initiated_by, reason_code, state, due_claimed_at
    ) VALUES (
        v_due_schedule, v_studio, v_due_enrollment, v_due_payer, v_due_group,
        'schedule_period_end', 'subscription_item_delete_at_period_end', repeat('b', 64),
        'acct_v30replay', 1, 'sub_v30due', 'si_v30due', now() - interval '1 second',
        0, 2, 1, 1, v_admin, 'contract.due', 'due_claimed', now()
    );
    INSERT INTO public.billing_enrollment_transition_intents(
        id, studio_id, enrollment_id, payer_id, billing_subscription_id,
        source_intent_id, transition_kind, mutation_strategy, request_sha256,
        provider_caller_request_key, provider_request_sha256,
        stripe_connected_account_id, connect_account_generation,
        stripe_subscription_id, stripe_subscription_item_id, period_boundary,
        expected_quantity, expected_subscription_item_count, same_item_active_count,
        provider_quantity, initiated_by, reason_code, state,
        lease_owner, lease_acquired_at, lease_expires_at, due_claimed_at
    ) VALUES (
        v_due_execute, v_studio, v_due_enrollment, v_due_payer, v_due_group,
        v_due_schedule, 'execute_due', 'subscription_item_delete_at_period_end',
        repeat('b', 64), 'v30-due-provider', repeat('c', 64),
        'acct_v30replay', 1, 'sub_v30due', 'si_v30due', now() - interval '1 second',
        0, 2, 1, 1, v_admin, 'contract.due', 'due_claimed',
        v_worker, now(), now() + interval '30 seconds', now()
    );
    v_result := public.mark_billing_enrollment_due_pre_provider_reconciliation_v1(
        v_due_execute, v_studio, v_worker, 1, repeat('d', 64),
        'item_due_pre_provider_identity_drift'
    );
    IF v_result->>'outcome' <> 'reconciliation_required'
       OR (SELECT state FROM public.billing_enrollment_transition_intents
            WHERE id = v_due_execute) <> 'reconciliation_required'
       OR (SELECT state FROM public.billing_enrollment_transition_intents
            WHERE id = v_due_schedule) <> 'reconciliation_required' THEN
        RAISE EXCEPTION 'Pre-provider item due drift did not converge both intents.';
    END IF;

    INSERT INTO public.billing_invoices(
        id, studio_id, payer_id, invoice_type, status,
        amount_due_cents, amount_paid_cents, amount_remaining_cents, currency,
        stripe_invoice_id, stripe_account_id, stripe_customer_id,
        collection_method, external, metadata
    ) VALUES (
        v_invoice, v_studio, v_payer, 'manual', 'draft',
        5000, 0, 5000, 'usd', 'in_v30closeout', 'acct_v30replay',
        'cus_v30invoice', 'send_invoice', false,
        jsonb_build_object('connect_account_generation', 1)
    );
    v_result := public.claim_billing_invoice_closeout_operation_v1(
        v_studio, v_admin, 'invoice.finalize', 'invoice_finalize',
        v_invoice, v_payer, 'finalize-key', repeat('e', 64),
        'acct_v30replay', 1, gen_random_uuid(), 30
    );
    v_operation := (v_result->'operation'->>'id')::UUID;
    IF v_result->>'outcome' <> 'claimed' THEN
        RAISE EXCEPTION 'Invoice finalize resource was not claimed.';
    END IF;
    IF public.claim_billing_invoice_closeout_operation_v1(
        v_studio, v_admin, 'invoice.finalize', 'invoice_finalize',
        v_invoice, v_payer, 'finalize-key', repeat('e', 64),
        'acct_v30replay', 1, gen_random_uuid(), 30
    )->>'outcome' <> 'replay' THEN
        RAISE EXCEPTION 'Invoice finalize same-key replay was not exact.';
    END IF;
    v_result := public.claim_billing_invoice_closeout_operation_v1(
        v_studio, v_admin, 'invoice.finalize', 'invoice_finalize',
        v_invoice, v_payer, 'finalize-alias', repeat('e', 64),
        'acct_v30replay', 1, gen_random_uuid(), 30
    );
    IF v_result->>'outcome' <> 'adopted'
       OR (v_result->'operation'->>'id')::UUID <> v_operation THEN
        RAISE EXCEPTION 'Invoice finalize alias did not adopt canonical ownership.';
    END IF;
    BEGIN
        PERFORM public.claim_billing_invoice_closeout_operation_v1(
            v_studio, v_other_admin, 'invoice.finalize', 'invoice_finalize',
            v_invoice, v_payer, 'finalize-cross-actor', repeat('e', 64),
            'acct_v30replay', 1, gen_random_uuid(), 30
        );
        RAISE EXCEPTION 'Cross-actor invoice finalize adoption was accepted.';
    EXCEPTION WHEN unique_violation THEN
        IF SQLERRM <> 'billing_invoice_closeout_request_conflict' THEN RAISE; END IF;
    END;
    IF v_has_v31_invoice_owner THEN
        BEGIN
            PERFORM public.claim_billing_invoice_closeout_operation_v1(
                v_studio, v_admin, 'invoice.void', 'invoice_void',
                v_invoice, v_payer, 'void-key', repeat('f', 64),
                'acct_v30replay', 1, gen_random_uuid(), 30
            );
            RAISE EXCEPTION 'Concurrent finalize and void owners were accepted.';
        EXCEPTION WHEN lock_not_available THEN
            IF SQLERRM <> 'billing_invoice_mutation_in_progress' THEN RAISE; END IF;
        END;
        IF (SELECT count(*) FROM public.billing_provider_operation_resources
            WHERE studio_id = v_studio AND resource_id = v_invoice) <> 1 THEN
            RAISE EXCEPTION 'Blocked invoice void created a second resource owner.';
        END IF;
    ELSE
        v_result := public.claim_billing_invoice_closeout_operation_v1(
            v_studio, v_admin, 'invoice.void', 'invoice_void',
            v_invoice, v_payer, 'void-key', repeat('f', 64),
            'acct_v30replay', 1, gen_random_uuid(), 30
        );
        IF v_result->>'outcome' <> 'claimed'
           OR (SELECT count(*) FROM public.billing_provider_operation_resources
                WHERE studio_id = v_studio AND resource_id = v_invoice) <> 2 THEN
            RAISE EXCEPTION 'V30 invoice closeout resource types did not remain independent.';
        END IF;
    END IF;
    BEGIN
        PERFORM public.claim_billing_invoice_closeout_operation_v1(
            v_studio, v_front_desk, 'invoice.void', 'invoice_void',
            v_invoice, v_payer, 'front-desk-void', repeat('f', 64),
            'acct_v30replay', 1, gen_random_uuid(), 30
        );
        RAISE EXCEPTION 'Front Desk invoice closeout was accepted.';
    EXCEPTION WHEN insufficient_privilege THEN
        IF v_has_v31_invoice_owner
           AND SQLERRM <> 'billing_invoice_mutation_actor_forbidden' THEN
            RAISE;
        ELSIF NOT v_has_v31_invoice_owner
           AND SQLERRM <> 'billing_invoice_closeout_actor_forbidden' THEN
            RAISE;
        END IF;
    END;
END;
$$;

ROLLBACK;
