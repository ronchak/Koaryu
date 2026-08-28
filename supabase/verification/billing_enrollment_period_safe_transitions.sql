BEGIN;

DO $$
DECLARE
    v_admin UUID := gen_random_uuid();
    v_front_desk UUID := gen_random_uuid();
    v_other_admin UUID := gen_random_uuid();
    v_studio UUID := gen_random_uuid();
    v_plan UUID := gen_random_uuid();
    v_payer_item UUID := gen_random_uuid();
    v_payer_whole UUID := gen_random_uuid();
    v_payer_revoke UUID := gen_random_uuid();
    v_payer_legacy UUID := gen_random_uuid();
    v_payer_immediate UUID := gen_random_uuid();
    v_group_item UUID := gen_random_uuid();
    v_group_whole UUID := gen_random_uuid();
    v_group_revoke UUID := gen_random_uuid();
    v_group_legacy UUID := gen_random_uuid();
    v_group_immediate UUID := gen_random_uuid();
    v_enrollment_item UUID := gen_random_uuid();
    v_enrollment_item_peer UUID := gen_random_uuid();
    v_enrollment_item_peer_two UUID := gen_random_uuid();
    v_enrollment_whole UUID := gen_random_uuid();
    v_enrollment_revoke UUID := gen_random_uuid();
    v_enrollment_revoke_peer UUID := gen_random_uuid();
    v_enrollment_legacy UUID := gen_random_uuid();
    v_enrollment_legacy_peer UUID := gen_random_uuid();
    v_enrollment_immediate UUID := gen_random_uuid();
    v_student_item UUID := gen_random_uuid();
    v_student_item_peer UUID := gen_random_uuid();
    v_student_item_peer_two UUID := gen_random_uuid();
    v_student_whole UUID := gen_random_uuid();
    v_student_revoke UUID := gen_random_uuid();
    v_student_revoke_peer UUID := gen_random_uuid();
    v_student_legacy UUID := gen_random_uuid();
    v_student_legacy_peer UUID := gen_random_uuid();
    v_student_immediate UUID := gen_random_uuid();
    v_item_boundary TIMESTAMPTZ := clock_timestamp() + interval '150 milliseconds';
    v_whole_boundary TIMESTAMPTZ := clock_timestamp() + interval '450 milliseconds';
    v_revoke_boundary TIMESTAMPTZ := clock_timestamp() + interval '1 day';
    v_worker UUID := gen_random_uuid();
    v_lease UUID := gen_random_uuid();
    v_result JSONB;
    v_replay JSONB;
    v_item_schedule public.billing_enrollment_transition_intents%ROWTYPE;
    v_whole_schedule public.billing_enrollment_transition_intents%ROWTYPE;
    v_revoke_schedule public.billing_enrollment_transition_intents%ROWTYPE;
    v_legacy_schedule public.billing_enrollment_transition_intents%ROWTYPE;
    v_legacy_revoke public.billing_enrollment_transition_intents%ROWTYPE;
    v_execute public.billing_enrollment_transition_intents%ROWTYPE;
    v_started JSONB;
    v_item_operation UUID;
    v_operation_count INTEGER;
    v_read_count INTEGER;
    v_read_intent UUID;
    v_read_revision BIGINT;
    v_schedule_step_plan JSONB;
    v_schedule_step_plan_sha TEXT;
    v_parent_revision BIGINT;
    v_step_revision BIGINT;
    v_step_lease UUID;
    v_revoke_lease UUID := gen_random_uuid();
    v_policy_lease UUID := gen_random_uuid();
BEGIN
    IF private.koaryu_release_enrollment_transition_manifest_v29()
       !~ '^0:[0-9a-f]{64}$' THEN
        RAISE EXCEPTION 'V29 enrollment-transition manifest is not exact: %',
            private.koaryu_release_enrollment_transition_manifest_v29();
    END IF;
    IF has_table_privilege(
        'service_role', 'public.billing_enrollment_transition_intents',
        'SELECT,INSERT,UPDATE,DELETE'
    ) OR has_table_privilege(
        'service_role', 'public.billing_enrollment_transition_aliases',
        'SELECT,INSERT,UPDATE,DELETE'
    ) OR has_function_privilege(
        'authenticated',
        'public.claim_billing_enrollment_transition_v1(uuid,uuid,text,text,text,uuid,uuid,uuid,text,text,text,integer,timestamp with time zone,integer,integer,integer,integer,text,text,uuid,integer)',
        'EXECUTE'
    ) OR NOT has_function_privilege(
        'service_role',
        'public.claim_billing_enrollment_transition_v1(uuid,uuid,text,text,text,uuid,uuid,uuid,text,text,text,integer,timestamp with time zone,integer,integer,integer,integer,text,text,uuid,integer)',
        'EXECUTE'
    ) OR has_function_privilege(
        'authenticated',
        'public.list_billing_enrollment_scheduled_transitions_v1(uuid,uuid[])',
        'EXECUTE'
    ) OR NOT has_function_privilege(
        'service_role',
        'public.list_billing_enrollment_scheduled_transitions_v1(uuid,uuid[])',
        'EXECUTE'
    ) OR has_function_privilege(
        'authenticated',
        'public.complete_due_billing_enrollment_item_transition_v31(uuid,uuid,uuid,bigint,text,jsonb)',
        'EXECUTE'
    ) OR NOT has_function_privilege(
        'service_role',
        'public.complete_due_billing_enrollment_item_transition_v31(uuid,uuid,uuid,bigint,text,jsonb)',
        'EXECUTE'
    ) OR has_function_privilege(
        'authenticated',
        'public.read_billing_enrollment_item_schedule_identity_v31(uuid,uuid)',
        'EXECUTE'
    ) OR NOT has_function_privilege(
        'service_role',
        'public.read_billing_enrollment_item_schedule_identity_v31(uuid,uuid)',
        'EXECUTE'
    ) OR has_function_privilege(
        'service_role',
        'public.claim_billing_enrollment_transition_v29(uuid,uuid,text,text,text,uuid,uuid,uuid,text,text,text,integer,timestamp with time zone,integer,integer,integer,integer,text,text,uuid,integer)',
        'EXECUTE'
    ) OR has_function_privilege(
        'service_role',
        'public.revoke_billing_enrollment_transition_v29(uuid,uuid,uuid,bigint,text,text,text,uuid,integer)',
        'EXECUTE'
    ) THEN
        RAISE EXCEPTION 'Enrollment-transition tables or RPCs are not service-only.';
    END IF;

    INSERT INTO auth.users(
        id, aud, role, email, raw_app_meta_data, raw_user_meta_data,
        created_at, updated_at
    ) VALUES
        (v_admin, 'authenticated', 'authenticated',
         'transition-admin@example.invalid', '{}', '{}', now(), now()),
        (v_front_desk, 'authenticated', 'authenticated',
         'transition-front-desk@example.invalid', '{}', '{}', now(), now()),
        (v_other_admin, 'authenticated', 'authenticated',
         'transition-other-admin@example.invalid', '{}', '{}', now(), now());
    INSERT INTO public.studios(id, name, slug, owner_id)
    VALUES (
        v_studio, 'Enrollment transition contract',
        'enrollment-transition-' || replace(v_studio::TEXT, '-', ''), v_admin
    );
    INSERT INTO public.staff_roles(studio_id, user_id, role) VALUES
        (v_studio, v_admin, 'admin'),
        (v_studio, v_front_desk, 'front_desk'),
        (v_studio, v_other_admin, 'admin');
    INSERT INTO public.studio_payment_accounts(
        studio_id, stripe_connected_account_id, metadata
    ) VALUES (
        v_studio, 'acct_transitioncontract',
        jsonb_build_object('connect_account_generation', 1)
    );
    INSERT INTO public.billing_payers(
        id, studio_id, display_name, stripe_account_id,
        stripe_customer_id, connect_account_generation
    ) VALUES
        (v_payer_item, v_studio, 'Item payer',
         'acct_transitioncontract', 'cus_transitionitem', 1),
        (v_payer_whole, v_studio, 'Whole payer',
         'acct_transitioncontract', 'cus_transitionwhole', 1),
        (v_payer_revoke, v_studio, 'Revoke payer',
         'acct_transitioncontract', 'cus_transitionrevoke', 1),
        (v_payer_legacy, v_studio, 'Legacy payer',
         'acct_transitioncontract', 'cus_transitionlegacy', 1),
        (v_payer_immediate, v_studio, 'Immediate payer',
         'acct_transitioncontract', 'cus_transitionimmediate', 1);
    INSERT INTO public.billing_plans(
        id, studio_id, name, amount_cents, billing_interval, status
    ) VALUES (v_plan, v_studio, 'Monthly transition plan', 5000, 'monthly', 'active');
    INSERT INTO public.students(id, studio_id, legal_first_name, legal_last_name) VALUES
        (v_student_item, v_studio, 'Item', 'Target'),
        (v_student_item_peer, v_studio, 'Item', 'Peer'),
        (v_student_item_peer_two, v_studio, 'Item', 'Peer Two'),
        (v_student_whole, v_studio, 'Whole', 'Target'),
        (v_student_revoke, v_studio, 'Revoke', 'Target'),
        (v_student_revoke_peer, v_studio, 'Revoke', 'Peer'),
        (v_student_legacy, v_studio, 'Legacy', 'Target'),
        (v_student_legacy_peer, v_studio, 'Legacy', 'Peer'),
        (v_student_immediate, v_studio, 'Immediate', 'Target');
    INSERT INTO public.billing_subscriptions(
        id, studio_id, payer_id, stripe_account_id, stripe_customer_id,
        stripe_subscription_id, collection_mode, billing_interval, currency,
        status, current_period_end, metadata
    ) VALUES
        (v_group_item, v_studio, v_payer_item, 'acct_transitioncontract',
         'cus_transitionitem', 'sub_transitionitem', 'invoice_link', 'monthly',
         'usd', 'active', v_item_boundary,
         jsonb_build_object('connect_account_generation', 1)),
        (v_group_whole, v_studio, v_payer_whole, 'acct_transitioncontract',
         'cus_transitionwhole', 'sub_transitionwhole', 'invoice_link', 'monthly',
         'usd', 'active', v_whole_boundary,
         jsonb_build_object('connect_account_generation', 1)),
        (v_group_revoke, v_studio, v_payer_revoke, 'acct_transitioncontract',
         'cus_transitionrevoke', 'sub_transitionrevoke', 'invoice_link', 'monthly',
         'usd', 'active', v_revoke_boundary,
         jsonb_build_object('connect_account_generation', 1)),
        (v_group_legacy, v_studio, v_payer_legacy, 'acct_transitioncontract',
         'cus_transitionlegacy', 'sub_transitionlegacy', 'invoice_link', 'monthly',
         'usd', 'active', v_revoke_boundary,
         jsonb_build_object('connect_account_generation', 1)),
        (v_group_immediate, v_studio, v_payer_immediate, 'acct_transitioncontract',
         'cus_transitionimmediate', 'sub_transitionimmediate', 'invoice_link', 'monthly',
         'usd', 'active', v_revoke_boundary,
         jsonb_build_object('connect_account_generation', 1));
    INSERT INTO public.student_billing_enrollments(
        id, studio_id, student_id, payer_id, billing_plan_id,
        billing_subscription_id, collection_mode, status,
        stripe_subscription_id, stripe_subscription_item_id, metadata
    ) VALUES
        (v_enrollment_item, v_studio, v_student_item, v_payer_item, v_plan,
         v_group_item, 'invoice_link', 'active',
         'sub_transitionitem', 'si_transitionitem', '{}'),
        (v_enrollment_item_peer, v_studio, v_student_item_peer, v_payer_item, v_plan,
         v_group_item, 'invoice_link', 'active',
         'sub_transitionitem', 'si_transitionitem', '{}'),
        (v_enrollment_item_peer_two, v_studio, v_student_item_peer_two,
         v_payer_item, v_plan, v_group_item, 'invoice_link', 'active',
         'sub_transitionitem', 'si_transitionitem', '{}'),
        (v_enrollment_whole, v_studio, v_student_whole, v_payer_whole, v_plan,
         v_group_whole, 'invoice_link', 'active',
         'sub_transitionwhole', 'si_transitionwhole', '{}'),
        (v_enrollment_revoke, v_studio, v_student_revoke, v_payer_revoke, v_plan,
         v_group_revoke, 'invoice_link', 'active',
         'sub_transitionrevoke', 'si_transitionrevoke', '{}'),
        (v_enrollment_revoke_peer, v_studio, v_student_revoke_peer, v_payer_revoke, v_plan,
         v_group_revoke, 'invoice_link', 'active',
         'sub_transitionrevoke', 'si_transitionrevokepeer', '{}'),
        (v_enrollment_legacy, v_studio, v_student_legacy, v_payer_legacy, v_plan,
         v_group_legacy, 'invoice_link', 'active',
         'sub_transitionlegacy', 'si_transitionlegacy', '{}'),
        (v_enrollment_legacy_peer, v_studio, v_student_legacy_peer,
         v_payer_legacy, v_plan, v_group_legacy, 'invoice_link', 'active',
         'sub_transitionlegacy', 'si_transitionlegacypeer', '{}'),
        (v_enrollment_immediate, v_studio, v_student_immediate, v_payer_immediate, v_plan,
         v_group_immediate, 'invoice_link', 'active',
         'sub_transitionimmediate', 'si_transitionimmediate', '{}');

    -- Start the short due windows only after fixture creation so a slow CI host
    -- cannot turn a valid scheduling request into a past-boundary request.
    v_item_boundary := clock_timestamp() + interval '500 milliseconds';
    v_whole_boundary := clock_timestamp() + interval '2 seconds';
    UPDATE public.billing_subscriptions
    SET current_period_end=v_item_boundary
    WHERE id=v_group_item;
    UPDATE public.billing_subscriptions
    SET current_period_end=v_whole_boundary
    WHERE id=v_group_whole;

    v_result := public.claim_billing_enrollment_transition_v1(
        p_studio_id => v_studio,
        p_actor_id => v_front_desk,
        p_transition_kind => 'schedule_period_end',
        p_caller_request_key => 'item-schedule-key',
        p_request_sha256 => repeat('a', 64),
        p_enrollment_id => v_enrollment_item,
        p_payer_id => v_payer_item,
        p_billing_subscription_id => v_group_item,
        p_stripe_subscription_id => 'sub_transitionitem',
        p_stripe_subscription_item_id => 'si_transitionitem',
        p_stripe_connected_account_id => 'acct_transitioncontract',
        p_connect_account_generation => 1,
        p_period_boundary => v_item_boundary,
        p_expected_quantity => 2,
        p_expected_subscription_item_count => 1,
        p_same_item_active_count => 3,
        p_provider_quantity => 3,
        p_mutation_strategy => 'subscription_item_delete_at_period_end',
        p_reason_code => 'contract.period_end',
        p_lease_owner => v_lease,
        p_lease_seconds => 30
    );
    v_item_schedule := jsonb_populate_record(
        NULL::public.billing_enrollment_transition_intents,
        v_result->'intent'
    );
    IF v_result->>'outcome' <> 'claimed'
       OR v_item_schedule.state <> 'scheduled'
       OR v_item_schedule.provider_operation_id IS NULL
       OR (v_result->'operation'->>'operation_type')
            <> 'enrollment.cancel.period_end.schedule' THEN
        RAISE EXCEPTION 'Item schedule lacks its exact provider parent: %', v_result;
    END IF;
    v_item_operation:=v_item_schedule.provider_operation_id;
    SELECT count(*)
    INTO v_read_count
    FROM public.list_billing_enrollment_scheduled_transitions_v1(
        v_studio, ARRAY[v_enrollment_item, v_enrollment_item_peer]
    ) AS listed;
    SELECT listed.intent_id, listed.revision
    INTO v_read_intent, v_read_revision
    FROM public.list_billing_enrollment_scheduled_transitions_v1(
        v_studio, ARRAY[v_enrollment_item, v_enrollment_item_peer]
    ) AS listed
    LIMIT 1;
    IF v_read_count <> 1
       OR v_read_intent IS DISTINCT FROM v_item_schedule.id
       OR v_read_revision IS DISTINCT FROM v_item_schedule.revision THEN
        RAISE EXCEPTION 'Scheduled-transition read did not return exact identity: %, %, %',
            v_read_count, v_read_intent, v_read_revision;
    END IF;
    SELECT count(*) INTO v_read_count
    FROM public.list_billing_enrollment_scheduled_transitions_v1(
        gen_random_uuid(), ARRAY[v_enrollment_item]
    );
    IF v_read_count <> 0 THEN
        RAISE EXCEPTION 'Scheduled-transition read crossed studio identity.';
    END IF;
    BEGIN
        PERFORM public.list_billing_enrollment_scheduled_transitions_v1(
            v_studio, ARRAY[v_enrollment_item, v_enrollment_item]
        );
        RAISE EXCEPTION 'Scheduled-transition read accepted duplicate enrollment IDs.';
    EXCEPTION WHEN invalid_parameter_value THEN
        IF SQLERRM <> 'billing_enrollment_scheduled_transition_list_invalid' THEN
            RAISE;
        END IF;
    END;
    v_replay := public.claim_billing_enrollment_transition_v1(
        v_studio, v_front_desk, 'schedule_period_end', 'item-schedule-key',
        repeat('a', 64), v_enrollment_item, v_payer_item, v_group_item,
        'sub_transitionitem', 'si_transitionitem', 'acct_transitioncontract', 1,
        v_item_boundary, 2, 1, 3, 3,
        'subscription_item_delete_at_period_end', 'contract.period_end',
        gen_random_uuid(), 30
    );
    IF v_replay->>'outcome' <> 'replay'
       OR (v_replay->'intent'->>'id')::UUID <> v_item_schedule.id THEN
        RAISE EXCEPTION 'Exact item schedule replay changed identity: %', v_replay;
    END IF;
    BEGIN
        PERFORM public.claim_billing_enrollment_transition_v1(
            v_studio, v_other_admin, 'schedule_period_end', 'item-cross-actor',
            repeat('a', 64), v_enrollment_item, v_payer_item, v_group_item,
            'sub_transitionitem', 'si_transitionitem', 'acct_transitioncontract', 1,
            v_item_boundary, 2, 1, 3, 3,
            'subscription_item_delete_at_period_end', 'contract.period_end',
            gen_random_uuid(), 30
        );
        RAISE EXCEPTION 'Cross-actor schedule adoption was accepted.';
    EXCEPTION WHEN unique_violation THEN
        IF SQLERRM <> 'billing_enrollment_transition_request_conflict' THEN RAISE; END IF;
    END;

    v_result := public.claim_billing_enrollment_transition_v1(
        v_studio, v_admin, 'schedule_period_end', 'whole-schedule-key', repeat('b', 64),
        v_enrollment_whole, v_payer_whole, v_group_whole,
        'sub_transitionwhole', 'si_transitionwhole', 'acct_transitioncontract', 1,
        v_whole_boundary, 0, 1, 1, 1,
        'subscription_cancel_at_period_end', 'contract.period_end',
        gen_random_uuid(), 30
    );
    v_whole_schedule := jsonb_populate_record(
        NULL::public.billing_enrollment_transition_intents,
        v_result->'intent'
    );
    IF v_whole_schedule.provider_operation_id IS NULL
       OR (v_result->'operation'->>'operation_type')
            <> 'enrollment.cancel.period_end.schedule' THEN
        RAISE EXCEPTION 'Whole schedule lacks its one provider parent: %', v_result;
    END IF;

    v_result := public.claim_billing_enrollment_transition_v1(
        v_studio, v_front_desk, 'schedule_period_end', 'revoke-source-key', repeat('c', 64),
        v_enrollment_revoke, v_payer_revoke, v_group_revoke,
        'sub_transitionrevoke', 'si_transitionrevoke', 'acct_transitioncontract', 1,
        v_revoke_boundary, 0, 2, 1, 1,
        'subscription_item_delete_at_period_end', 'contract.period_end',
        v_revoke_lease, 30
    );
    v_revoke_schedule := jsonb_populate_record(
        NULL::public.billing_enrollment_transition_intents,
        v_result->'intent'
    );
    v_result:=public.claim_billing_enrollment_transition_v29(
        v_studio,v_front_desk,'schedule_period_end','legacy-source-key',
        repeat('5',64),v_enrollment_legacy,v_payer_legacy,v_group_legacy,
        'sub_transitionlegacy','si_transitionlegacy',
        'acct_transitioncontract',1,v_revoke_boundary,0,2,1,1,
        'subscription_item_delete_at_period_end','contract.legacy',
        gen_random_uuid(),30
    );
    v_legacy_schedule:=jsonb_populate_record(
        NULL::public.billing_enrollment_transition_intents,v_result->'intent'
    );
    IF v_legacy_schedule.provider_operation_id IS NOT NULL THEN
        RAISE EXCEPTION 'V29 legacy source unexpectedly owns provider work: %',v_result;
    END IF;
    v_result:=public.revoke_billing_enrollment_transition_v1(
        v_legacy_schedule.id,v_studio,v_front_desk,v_legacy_schedule.revision,
        'legacy-revoke-key',repeat('6',64),'contract.legacy_revoke',
        gen_random_uuid(),30
    );
    v_legacy_revoke:=jsonb_populate_record(
        NULL::public.billing_enrollment_transition_intents,v_result->'intent'
    );
    IF v_result->>'outcome'<>'revoked'
       OR (SELECT state FROM public.billing_enrollment_transition_intents
            WHERE id=v_legacy_schedule.id)<>'revoked'
       OR v_legacy_revoke.state<>'completed'
       OR v_legacy_revoke.provider_operation_id IS NOT NULL
       OR EXISTS (
            SELECT 1 FROM public.billing_provider_operations
            WHERE studio_id=v_studio
              AND caller_request_key='legacy-revoke-key'
       ) THEN
        RAISE EXCEPTION 'Legacy V29 revoke invented provider release work: %',v_result;
    END IF;
    v_result:=public.claim_billing_enrollment_transition_v1(
        v_studio,v_front_desk,'schedule_period_end','policy-source-key',
        repeat('8',64),v_enrollment_legacy,v_payer_legacy,v_group_legacy,
        'sub_transitionlegacy','si_transitionlegacy',
        'acct_transitioncontract',1,v_revoke_boundary,0,2,1,1,
        'subscription_item_delete_at_period_end','contract.policy_reject',
        v_policy_lease,30
    );
    v_legacy_schedule:=jsonb_populate_record(
        NULL::public.billing_enrollment_transition_intents,v_result->'intent'
    );
    v_schedule_step_plan:=jsonb_build_array(
        jsonb_build_object(
            'step_name','schedule_create',
            'provider_operation','connected_subscription_schedule.create',
            'request_sha256',repeat('9',64),
            'stripe_idempotency_key','policy-schedule-create'
        ),
        jsonb_build_object(
            'step_name','schedule_update',
            'provider_operation','connected_subscription_schedule.update',
            'request_sha256',repeat('a',64),
            'stripe_idempotency_key','policy-schedule-update'
        )
    );
    v_schedule_step_plan_sha:=encode(extensions.digest(convert_to(
        v_schedule_step_plan::TEXT,'UTF8'
    ),'sha256'),'hex');
    v_parent_revision:=(SELECT revision FROM public.billing_provider_operations
        WHERE id=v_legacy_schedule.provider_operation_id);
    v_result:=public.register_billing_provider_operation_step_plan_v1(
        v_legacy_schedule.provider_operation_id,v_studio,v_front_desk,
        'enrollment.cancel.period_end.schedule','policy-source-key',
        repeat('8',64),'acct_transitioncontract',1,v_policy_lease,
        v_parent_revision,v_schedule_step_plan_sha,2,v_schedule_step_plan
    );
    v_step_lease:=gen_random_uuid();
    v_result:=public.claim_billing_provider_operation_step_v1(
        v_legacy_schedule.provider_operation_id,v_studio,v_front_desk,
        'enrollment.cancel.period_end.schedule','policy-source-key',
        repeat('8',64),'acct_transitioncontract',1,v_schedule_step_plan_sha,
        1,'schedule_create','connected_subscription_schedule.create',
        repeat('9',64),'policy-schedule-create',v_step_lease,30
    );
    v_result:=public.transition_billing_provider_operation_step_v1(
        v_legacy_schedule.provider_operation_id,v_studio,v_front_desk,
        'enrollment.cancel.period_end.schedule','policy-source-key',
        repeat('8',64),'acct_transitioncontract',1,v_schedule_step_plan_sha,
        1,'schedule_create','connected_subscription_schedule.create',
        repeat('9',64),'policy-schedule-create',v_step_lease,
        (v_result->'step'->>'revision')::BIGINT,'provider_request_in_flight'
    );
    v_result:=public.transition_billing_provider_operation_step_v1(
        p_operation_id=>v_legacy_schedule.provider_operation_id,
        p_studio_id=>v_studio,p_actor_id=>v_front_desk,
        p_operation_type=>'enrollment.cancel.period_end.schedule',
        p_caller_request_key=>'policy-source-key',
        p_parent_request_sha256=>repeat('8',64),
        p_stripe_connected_account_id=>'acct_transitioncontract',
        p_connect_account_generation=>1,p_plan_sha256=>v_schedule_step_plan_sha,
        p_step_order=>1,p_step_name=>'schedule_create',
        p_provider_operation=>'connected_subscription_schedule.create',
        p_step_request_sha256=>repeat('9',64),
        p_stripe_idempotency_key=>'policy-schedule-create',
        p_lease_owner=>v_step_lease,
        p_expected_step_revision=>(v_result->'step'->>'revision')::BIGINT,
        p_to_state=>'definitive_rejected',
        p_error_code=>'provider_mutation_blocked'
    );
    v_parent_revision:=(v_result->'operation'->>'revision')::BIGINT;
    v_result:=public.transition_billing_provider_operation_v1(
        p_operation_id=>v_legacy_schedule.provider_operation_id,
        p_studio_id=>v_studio,p_actor_id=>v_front_desk,
        p_operation_type=>'enrollment.cancel.period_end.schedule',
        p_caller_request_key=>'policy-source-key',
        p_request_sha256=>repeat('8',64),
        p_stripe_connected_account_id=>'acct_transitioncontract',
        p_connect_account_generation=>1,p_lease_owner=>v_policy_lease,
        p_expected_revision=>v_parent_revision,
        p_to_state=>'definitive_rejected',
        p_error_code=>'provider_mutation_blocked'
    );
    v_parent_revision:=(v_result->'operation'->>'revision')::BIGINT;
    v_result:=public.transition_billing_enrollment_transition_v1(
        v_legacy_schedule.id,v_studio,v_front_desk,
        v_legacy_schedule.revision,v_legacy_schedule.provider_operation_id,
        v_parent_revision,NULL,NULL
    );
    IF v_result->'intent'->>'state'<>'definitive_rejected'
       OR NOT private.billing_enrollment_item_schedule_pre_provider_rejected_v31(
            jsonb_populate_record(
                NULL::public.billing_provider_operations,
                (SELECT to_jsonb(operation) FROM public.billing_provider_operations
                 AS operation WHERE operation.id=v_legacy_schedule.provider_operation_id)
            )
       ) THEN
        RAISE EXCEPTION 'Pre-provider schedule policy rejection did not converge: %',
            v_result;
    END IF;
    BEGIN
        PERFORM public.revoke_billing_enrollment_transition_v1(
            v_revoke_schedule.id,v_studio,v_front_desk,
            v_revoke_schedule.revision,'revoke-before-schedule-complete',
            repeat('7',64),'contract.revoke',gen_random_uuid(),30
        );
        RAISE EXCEPTION 'Provider-backed source revoked before schedule completion.';
    EXCEPTION WHEN check_violation THEN
        IF SQLERRM<>'billing_enrollment_transition_revoke_binding_invalid' THEN
            RAISE;
        END IF;
    END;
    v_schedule_step_plan:=jsonb_build_array(
        jsonb_build_object(
            'step_name','schedule_create',
            'provider_operation','connected_subscription_schedule.create',
            'request_sha256',repeat('3',64),
            'stripe_idempotency_key','revoke-schedule-create'
        ),
        jsonb_build_object(
            'step_name','schedule_update',
            'provider_operation','connected_subscription_schedule.update',
            'request_sha256',repeat('4',64),
            'stripe_idempotency_key','revoke-schedule-update'
        )
    );
    v_schedule_step_plan_sha:=encode(extensions.digest(convert_to(
        v_schedule_step_plan::TEXT,'UTF8'
    ),'sha256'),'hex');
    v_parent_revision:=(SELECT revision FROM public.billing_provider_operations
        WHERE id=v_revoke_schedule.provider_operation_id);
    v_result:=public.register_billing_provider_operation_step_plan_v1(
        v_revoke_schedule.provider_operation_id,v_studio,v_front_desk,
        'enrollment.cancel.period_end.schedule','revoke-source-key',
        repeat('c',64),'acct_transitioncontract',1,v_revoke_lease,
        v_parent_revision,v_schedule_step_plan_sha,2,v_schedule_step_plan
    );
    v_parent_revision:=(v_result->'operation'->>'revision')::BIGINT;
    v_step_lease:=gen_random_uuid();
    v_result:=public.claim_billing_provider_operation_step_v1(
        v_revoke_schedule.provider_operation_id,v_studio,v_front_desk,
        'enrollment.cancel.period_end.schedule','revoke-source-key',
        repeat('c',64),'acct_transitioncontract',1,v_schedule_step_plan_sha,
        1,'schedule_create','connected_subscription_schedule.create',
        repeat('3',64),'revoke-schedule-create',v_step_lease,30
    );
    v_result:=public.transition_billing_provider_operation_step_v1(
        v_revoke_schedule.provider_operation_id,v_studio,v_front_desk,
        'enrollment.cancel.period_end.schedule','revoke-source-key',
        repeat('c',64),'acct_transitioncontract',1,v_schedule_step_plan_sha,
        1,'schedule_create','connected_subscription_schedule.create',
        repeat('3',64),'revoke-schedule-create',v_step_lease,
        (v_result->'step'->>'revision')::BIGINT,'provider_request_in_flight'
    );
    v_result:=public.transition_billing_provider_operation_step_v1(
        p_operation_id=>v_revoke_schedule.provider_operation_id,
        p_studio_id=>v_studio,p_actor_id=>v_front_desk,
        p_operation_type=>'enrollment.cancel.period_end.schedule',
        p_caller_request_key=>'revoke-source-key',
        p_parent_request_sha256=>repeat('c',64),
        p_stripe_connected_account_id=>'acct_transitioncontract',
        p_connect_account_generation=>1,p_plan_sha256=>v_schedule_step_plan_sha,
        p_step_order=>1,p_step_name=>'schedule_create',
        p_provider_operation=>'connected_subscription_schedule.create',
        p_step_request_sha256=>repeat('3',64),
        p_stripe_idempotency_key=>'revoke-schedule-create',
        p_lease_owner=>v_step_lease,
        p_expected_step_revision=>(v_result->'step'->>'revision')::BIGINT,
        p_to_state=>'provider_succeeded',
        p_provider_object_id=>'sub_sched_transitionrevoke',
        p_result_code=>'enrollment_item_schedule_created'
    );
    v_step_lease:=gen_random_uuid();
    v_result:=public.claim_billing_provider_operation_step_v1(
        v_revoke_schedule.provider_operation_id,v_studio,v_front_desk,
        'enrollment.cancel.period_end.schedule','revoke-source-key',
        repeat('c',64),'acct_transitioncontract',1,v_schedule_step_plan_sha,
        2,'schedule_update','connected_subscription_schedule.update',
        repeat('4',64),'revoke-schedule-update',v_step_lease,30
    );
    v_result:=public.transition_billing_provider_operation_step_v1(
        v_revoke_schedule.provider_operation_id,v_studio,v_front_desk,
        'enrollment.cancel.period_end.schedule','revoke-source-key',
        repeat('c',64),'acct_transitioncontract',1,v_schedule_step_plan_sha,
        2,'schedule_update','connected_subscription_schedule.update',
        repeat('4',64),'revoke-schedule-update',v_step_lease,
        (v_result->'step'->>'revision')::BIGINT,'provider_request_in_flight'
    );
    v_result:=public.transition_billing_provider_operation_step_v1(
        p_operation_id=>v_revoke_schedule.provider_operation_id,
        p_studio_id=>v_studio,p_actor_id=>v_front_desk,
        p_operation_type=>'enrollment.cancel.period_end.schedule',
        p_caller_request_key=>'revoke-source-key',
        p_parent_request_sha256=>repeat('c',64),
        p_stripe_connected_account_id=>'acct_transitioncontract',
        p_connect_account_generation=>1,p_plan_sha256=>v_schedule_step_plan_sha,
        p_step_order=>2,p_step_name=>'schedule_update',
        p_provider_operation=>'connected_subscription_schedule.update',
        p_step_request_sha256=>repeat('4',64),
        p_stripe_idempotency_key=>'revoke-schedule-update',
        p_lease_owner=>v_step_lease,
        p_expected_step_revision=>(v_result->'step'->>'revision')::BIGINT,
        p_to_state=>'provider_succeeded',
        p_provider_object_id=>'si_transitionrevoke',
        p_provider_secondary_object_id=>'sub_sched_transitionrevoke',
        p_result_code=>'enrollment_item_schedule_updated'
    );
    v_result:=public.complete_billing_provider_operation_provider_phase_v31(
        v_revoke_schedule.provider_operation_id,v_studio,v_front_desk,
        'enrollment.cancel.period_end.schedule','revoke-source-key',
        repeat('c',64),'acct_transitioncontract',1,v_schedule_step_plan_sha,2,
        v_parent_revision,v_revoke_lease
    );
    v_parent_revision:=(v_result->'operation'->>'revision')::BIGINT;
    v_result:=public.transition_billing_enrollment_transition_v1(
        v_revoke_schedule.id,v_studio,v_front_desk,
        v_revoke_schedule.revision,v_revoke_schedule.provider_operation_id,
        v_parent_revision,repeat('f',64),NULL
    );
    v_revoke_schedule:=jsonb_populate_record(
        NULL::public.billing_enrollment_transition_intents,v_result->'intent'
    );
    v_result:=public.transition_billing_provider_operation_v1(
        p_operation_id=>v_revoke_schedule.provider_operation_id,
        p_studio_id=>v_studio,p_actor_id=>v_front_desk,
        p_operation_type=>'enrollment.cancel.period_end.schedule',
        p_caller_request_key=>'revoke-source-key',
        p_request_sha256=>repeat('c',64),
        p_stripe_connected_account_id=>'acct_transitioncontract',
        p_connect_account_generation=>1,p_lease_owner=>v_revoke_lease,
        p_expected_revision=>v_parent_revision,
        p_to_state=>'projected',p_provider_object_id=>'si_transitionrevoke',
        p_provider_secondary_object_id=>'sub_sched_transitionrevoke'
    );
    v_parent_revision:=(v_result->'operation'->>'revision')::BIGINT;
    v_result:=public.transition_billing_enrollment_transition_v1(
        v_revoke_schedule.id,v_studio,v_front_desk,
        v_revoke_schedule.revision,v_revoke_schedule.provider_operation_id,
        v_parent_revision,repeat('f',64),NULL
    );
    v_revoke_schedule:=jsonb_populate_record(
        NULL::public.billing_enrollment_transition_intents,v_result->'intent'
    );
    v_result:=public.complete_billing_provider_operation_v1(
        v_revoke_schedule.provider_operation_id,v_studio,v_front_desk,
        'enrollment.cancel.period_end.schedule','revoke-source-key',
        repeat('c',64),'acct_transitioncontract',1,v_revoke_lease,
        v_parent_revision,
        'enrollment_transition_completed',NULL
    );
    v_parent_revision:=(v_result->'operation'->>'revision')::BIGINT;
    v_result:=public.transition_billing_enrollment_transition_v1(
        v_revoke_schedule.id,v_studio,v_front_desk,
        v_revoke_schedule.revision,v_revoke_schedule.provider_operation_id,
        v_parent_revision,repeat('f',64),NULL
    );
    v_revoke_schedule:=jsonb_populate_record(
        NULL::public.billing_enrollment_transition_intents,v_result->'intent'
    );
    IF v_revoke_schedule.state<>'scheduled' THEN
        RAISE EXCEPTION 'Provider-completed revoke source did not stay scheduled: %',
            v_result;
    END IF;
    v_result := public.revoke_billing_enrollment_transition_v1(
        v_revoke_schedule.id, v_studio, v_front_desk, v_revoke_schedule.revision,
        'revoke-key', repeat('d', 64), 'contract.revoke', gen_random_uuid(), 30
    );
    IF v_result->>'outcome' <> 'claimed'
       OR (v_result->'operation'->>'operation_type')
            <> 'enrollment.cancel.period_end.revoke'
       OR (SELECT state FROM public.billing_enrollment_transition_intents
            WHERE id=v_revoke_schedule.id) <> 'scheduled' THEN
        RAISE EXCEPTION 'Item revoke lacks its exact release parent: %', v_result;
    END IF;
    SELECT count(*) INTO v_read_count
    FROM public.list_billing_enrollment_scheduled_transitions_v1(
        v_studio, ARRAY[v_enrollment_revoke]
    );
    IF v_read_count <> 1 THEN
        RAISE EXCEPTION 'Provider-backed revoke hid the schedule before release.';
    END IF;
    v_replay := public.revoke_billing_enrollment_transition_v1(
        v_revoke_schedule.id, v_studio, v_front_desk, v_revoke_schedule.revision,
        'revoke-key', repeat('d', 64), 'contract.revoke', gen_random_uuid(), 30
    );
    IF v_replay->>'outcome' <> 'replay' THEN
        RAISE EXCEPTION 'Exact revoke replay was not returned: %', v_replay;
    END IF;

    BEGIN
        PERFORM public.claim_billing_enrollment_transition_v1(
            v_studio, v_front_desk, 'immediate_cancel', 'front-desk-immediate',
            repeat('e', 64), v_enrollment_immediate, v_payer_immediate,
            v_group_immediate, 'sub_transitionimmediate', 'si_transitionimmediate',
            'acct_transitioncontract', 1, clock_timestamp(), 0, 1, 1, 1,
            'subscription_cancel_immediate', 'contract.immediate',
            gen_random_uuid(), 30
        );
        RAISE EXCEPTION 'Front Desk immediate cancellation was accepted.';
    EXCEPTION WHEN insufficient_privilege THEN
        IF SQLERRM <> 'billing_enrollment_transition_actor_forbidden' THEN RAISE; END IF;
    END;
    v_result := public.claim_billing_enrollment_transition_v1(
        v_studio, v_admin, 'immediate_cancel', 'admin-immediate', repeat('f', 64),
        v_enrollment_immediate, v_payer_immediate, v_group_immediate,
        'sub_transitionimmediate', 'si_transitionimmediate',
        'acct_transitioncontract', 1, clock_timestamp(), 0, 1, 1, 1,
        'subscription_cancel_immediate', 'contract.immediate', gen_random_uuid(), 30
    );
    IF (v_result->'operation'->>'operation_type') <> 'enrollment.cancel.immediate' THEN
        RAISE EXCEPTION 'Admin immediate cancellation lacks exact provider parent: %', v_result;
    END IF;

    v_schedule_step_plan:=jsonb_build_array(
        jsonb_build_object(
            'step_name','schedule_create',
            'provider_operation','connected_subscription_schedule.create',
            'request_sha256',repeat('1',64),
            'stripe_idempotency_key','item-schedule-create'
        ),
        jsonb_build_object(
            'step_name','schedule_update',
            'provider_operation','connected_subscription_schedule.update',
            'request_sha256',repeat('2',64),
            'stripe_idempotency_key','item-schedule-update'
        )
    );
    v_schedule_step_plan_sha:=encode(extensions.digest(convert_to(
        v_schedule_step_plan::TEXT,'UTF8'
    ),'sha256'),'hex');
    v_parent_revision:=(SELECT revision FROM public.billing_provider_operations
        WHERE id=v_item_operation);
    v_result:=public.register_billing_provider_operation_step_plan_v1(
        v_item_operation,v_studio,v_front_desk,
        'enrollment.cancel.period_end.schedule','item-schedule-key',
        repeat('a',64),'acct_transitioncontract',1,v_lease,
        v_parent_revision,v_schedule_step_plan_sha,2,v_schedule_step_plan
    );
    v_parent_revision:=(v_result->'operation'->>'revision')::BIGINT;
    v_step_lease:=gen_random_uuid();
    v_result:=public.claim_billing_provider_operation_step_v1(
        v_item_operation,v_studio,v_front_desk,
        'enrollment.cancel.period_end.schedule','item-schedule-key',
        repeat('a',64),'acct_transitioncontract',1,v_schedule_step_plan_sha,
        1,'schedule_create','connected_subscription_schedule.create',
        repeat('1',64),'item-schedule-create',v_step_lease,30
    );
    v_step_revision:=(v_result->'step'->>'revision')::BIGINT;
    v_result:=public.transition_billing_provider_operation_step_v1(
        v_item_operation,v_studio,v_front_desk,
        'enrollment.cancel.period_end.schedule','item-schedule-key',
        repeat('a',64),'acct_transitioncontract',1,v_schedule_step_plan_sha,
        1,'schedule_create','connected_subscription_schedule.create',
        repeat('1',64),'item-schedule-create',v_step_lease,v_step_revision,
        'provider_request_in_flight'
    );
    v_step_revision:=(v_result->'step'->>'revision')::BIGINT;
    v_result:=public.transition_billing_provider_operation_step_v1(
        p_operation_id=>v_item_operation,p_studio_id=>v_studio,
        p_actor_id=>v_front_desk,
        p_operation_type=>'enrollment.cancel.period_end.schedule',
        p_caller_request_key=>'item-schedule-key',
        p_parent_request_sha256=>repeat('a',64),
        p_stripe_connected_account_id=>'acct_transitioncontract',
        p_connect_account_generation=>1,p_plan_sha256=>v_schedule_step_plan_sha,
        p_step_order=>1,p_step_name=>'schedule_create',
        p_provider_operation=>'connected_subscription_schedule.create',
        p_step_request_sha256=>repeat('1',64),
        p_stripe_idempotency_key=>'item-schedule-create',
        p_lease_owner=>v_step_lease,p_expected_step_revision=>v_step_revision,
        p_to_state=>'provider_succeeded',
        p_provider_object_id=>'sub_sched_transitionitem',
        p_result_code=>'enrollment_item_schedule_created'
    );
    v_step_lease:=gen_random_uuid();
    v_result:=public.claim_billing_provider_operation_step_v1(
        v_item_operation,v_studio,v_front_desk,
        'enrollment.cancel.period_end.schedule','item-schedule-key',
        repeat('a',64),'acct_transitioncontract',1,v_schedule_step_plan_sha,
        2,'schedule_update','connected_subscription_schedule.update',
        repeat('2',64),'item-schedule-update',v_step_lease,30
    );
    v_step_revision:=(v_result->'step'->>'revision')::BIGINT;
    v_result:=public.transition_billing_provider_operation_step_v1(
        v_item_operation,v_studio,v_front_desk,
        'enrollment.cancel.period_end.schedule','item-schedule-key',
        repeat('a',64),'acct_transitioncontract',1,v_schedule_step_plan_sha,
        2,'schedule_update','connected_subscription_schedule.update',
        repeat('2',64),'item-schedule-update',v_step_lease,v_step_revision,
        'provider_request_in_flight'
    );
    v_step_revision:=(v_result->'step'->>'revision')::BIGINT;
    v_result:=public.transition_billing_provider_operation_step_v1(
        p_operation_id=>v_item_operation,p_studio_id=>v_studio,
        p_actor_id=>v_front_desk,
        p_operation_type=>'enrollment.cancel.period_end.schedule',
        p_caller_request_key=>'item-schedule-key',
        p_parent_request_sha256=>repeat('a',64),
        p_stripe_connected_account_id=>'acct_transitioncontract',
        p_connect_account_generation=>1,p_plan_sha256=>v_schedule_step_plan_sha,
        p_step_order=>2,p_step_name=>'schedule_update',
        p_provider_operation=>'connected_subscription_schedule.update',
        p_step_request_sha256=>repeat('2',64),
        p_stripe_idempotency_key=>'item-schedule-update',
        p_lease_owner=>v_step_lease,p_expected_step_revision=>v_step_revision,
        p_to_state=>'provider_succeeded',
        p_provider_object_id=>'si_transitionitem',
        p_provider_secondary_object_id=>'sub_sched_transitionitem',
        p_result_code=>'enrollment_item_schedule_updated'
    );
    v_result:=public.complete_billing_provider_operation_provider_phase_v31(
        v_item_operation,v_studio,v_front_desk,
        'enrollment.cancel.period_end.schedule','item-schedule-key',
        repeat('a',64),'acct_transitioncontract',1,v_schedule_step_plan_sha,2,
        v_parent_revision,v_lease
    );
    IF v_result->'operation'->>'provider_object_id'<>'si_transitionitem'
       OR v_result->'operation'->>'provider_secondary_object_id'<>
            'sub_sched_transitionitem'
       OR (v_result->'operation'->>'lease_owner')::UUID<>v_lease THEN
        RAISE EXCEPTION 'V31 provider phase lost schedule evidence or lease: %',v_result;
    END IF;
    v_parent_revision:=(v_result->'operation'->>'revision')::BIGINT;
    v_result:=public.transition_billing_enrollment_transition_v1(
        v_item_schedule.id,v_studio,v_front_desk,v_item_schedule.revision,
        v_item_operation,v_parent_revision,repeat('e',64),NULL
    );
    v_item_schedule:=jsonb_populate_record(
        NULL::public.billing_enrollment_transition_intents,v_result->'intent'
    );
    IF v_item_schedule.state<>'provider_succeeded' THEN
        RAISE EXCEPTION 'Item schedule intent skipped provider success: %',v_result;
    END IF;
    v_replay:=public.complete_billing_provider_operation_provider_phase_v31(
        v_item_operation,v_studio,v_front_desk,
        'enrollment.cancel.period_end.schedule','item-schedule-key',
        repeat('a',64),'acct_transitioncontract',1,v_schedule_step_plan_sha,2,
        v_parent_revision,v_lease
    );
    IF v_replay->>'outcome'<>'replay' THEN
        RAISE EXCEPTION 'V31 provider phase did not replay exactly: %',v_replay;
    END IF;
    v_result:=public.transition_billing_provider_operation_v1(
        p_operation_id=>v_item_operation,p_studio_id=>v_studio,
        p_actor_id=>v_front_desk,
        p_operation_type=>'enrollment.cancel.period_end.schedule',
        p_caller_request_key=>'item-schedule-key',
        p_request_sha256=>repeat('a',64),
        p_stripe_connected_account_id=>'acct_transitioncontract',
        p_connect_account_generation=>1,p_lease_owner=>v_lease,
        p_expected_revision=>v_parent_revision,
        p_to_state=>'projected',p_provider_object_id=>'si_transitionitem',
        p_provider_secondary_object_id=>'sub_sched_transitionitem'
    );
    v_parent_revision:=(v_result->'operation'->>'revision')::BIGINT;
    v_result:=public.transition_billing_enrollment_transition_v1(
        v_item_schedule.id,v_studio,v_front_desk,v_item_schedule.revision,
        v_item_operation,v_parent_revision,repeat('e',64),NULL
    );
    v_item_schedule:=jsonb_populate_record(
        NULL::public.billing_enrollment_transition_intents,v_result->'intent'
    );
    IF v_item_schedule.state<>'projected' THEN
        RAISE EXCEPTION 'Item schedule intent skipped projection: %',v_result;
    END IF;
    v_result:=public.complete_billing_provider_operation_v1(
        v_item_operation,v_studio,v_front_desk,
        'enrollment.cancel.period_end.schedule','item-schedule-key',
        repeat('a',64),'acct_transitioncontract',1,v_lease,
        v_parent_revision,
        'enrollment_transition_completed',NULL
    );
    v_parent_revision:=(v_result->'operation'->>'revision')::BIGINT;
    v_result:=public.transition_billing_enrollment_transition_v1(
        v_item_schedule.id,v_studio,v_front_desk,v_item_schedule.revision,
        v_item_operation,v_parent_revision,repeat('e',64),NULL
    );
    v_item_schedule:=jsonb_populate_record(
        NULL::public.billing_enrollment_transition_intents,v_result->'intent'
    );
    IF v_item_schedule.state<>'scheduled' THEN
        RAISE EXCEPTION 'Completed item schedule intent did not return scheduled: %',
            v_result;
    END IF;
    v_result:=public.read_billing_enrollment_item_schedule_identity_v31(
        v_item_schedule.id,v_studio
    );
    IF (v_result->'schedule_identity'->>'source_intent_id')::UUID<>
            v_item_schedule.id
       OR (v_result->'schedule_identity'->>'provider_operation_id')::UUID<>
            v_item_operation
       OR v_result->'schedule_identity'->>'schedule_id'<>
            'sub_sched_transitionitem' THEN
        RAISE EXCEPTION 'Durable item schedule identity read drifted: %',v_result;
    END IF;

    PERFORM pg_sleep(0.6);
    SELECT * INTO v_execute
    FROM public.claim_due_billing_enrollment_transitions_v1(v_worker, 30, 1)
    LIMIT 1;
    IF v_execute.source_intent_id IS DISTINCT FROM v_item_schedule.id
       OR v_execute.mutation_strategy <> 'subscription_item_delete_at_period_end'
       OR v_execute.provider_operation_id IS NOT NULL
       OR v_execute.provider_caller_request_key IS NOT NULL
       OR v_execute.provider_request_sha256 IS NOT NULL THEN
        RAISE EXCEPTION 'Item due claim was not exact: %', to_jsonb(v_execute);
    END IF;
    BEGIN
        UPDATE public.billing_subscriptions
        SET stripe_account_id='acct_transitiondrift'
        WHERE id=v_group_item;
        PERFORM public.complete_due_billing_enrollment_item_transition_v31(
            v_execute.id,v_studio,v_worker,v_execute.revision,repeat('8',64),
            jsonb_build_array(
                jsonb_build_object(
                    'old_item_id','si_transitionitem',
                    'new_item_id','si_transitionrotated',
                    'expected_active_count',2
                )
            )
        );
        RAISE EXCEPTION 'Drifted group provider identity was accepted.';
    EXCEPTION WHEN check_violation THEN
        IF SQLERRM<>'billing_enrollment_item_due_identity_mismatch' THEN
            RAISE;
        END IF;
    END;
    BEGIN
        UPDATE public.studio_payment_accounts
        SET metadata=jsonb_set(
            metadata,'{connect_account_generation}','2'::JSONB,true
        )
        WHERE studio_id=v_studio;
        PERFORM public.complete_due_billing_enrollment_item_transition_v31(
            v_execute.id,v_studio,v_worker,v_execute.revision,repeat('8',64),
            jsonb_build_array(
                jsonb_build_object(
                    'old_item_id','si_transitionitem',
                    'new_item_id','si_transitionrotated',
                    'expected_active_count',2
                )
            )
        );
        RAISE EXCEPTION 'Drifted current account generation was accepted.';
    EXCEPTION WHEN check_violation THEN
        IF SQLERRM<>'billing_enrollment_item_due_identity_mismatch' THEN
            RAISE;
        END IF;
    END;
    v_result:=public.complete_due_billing_enrollment_item_transition_v31(
        v_execute.id,v_studio,v_worker,v_execute.revision,repeat('8',64),
        jsonb_build_array(
            jsonb_build_object(
                'old_item_id','si_transitionitem',
                'new_item_id','si_transitionrotated',
                'expected_active_count',2
            )
        )
    );
    IF v_result->>'outcome'<>'completed'
       OR (SELECT status FROM public.student_billing_enrollments
            WHERE id=v_enrollment_item)<>'canceled'
       OR (SELECT count(*) FROM public.student_billing_enrollments
            WHERE id IN (v_enrollment_item_peer,v_enrollment_item_peer_two)
              AND status='active'
              AND stripe_subscription_item_id='si_transitionrotated')<>2
       OR (SELECT count(*) FROM public.student_billing_enrollments
            WHERE billing_subscription_id=v_group_item
              AND status IN ('pending','active')
              AND stripe_subscription_item_id='si_transitionitem')<>0
       OR (SELECT state FROM public.billing_enrollment_transition_intents
            WHERE id=v_item_schedule.id)<>'completed' THEN
        RAISE EXCEPTION 'Item due CAS did not converge exactly: %',v_result;
    END IF;
    v_replay:=public.complete_due_billing_enrollment_item_transition_v31(
        v_execute.id,v_studio,v_worker,v_execute.revision,repeat('8',64),
        jsonb_build_array(jsonb_build_object(
            'old_item_id','si_transitionitem',
            'new_item_id','si_transitionrotated',
            'expected_active_count',2
        ))
    );
    IF v_replay->>'outcome'<>'replay' THEN
        RAISE EXCEPTION 'Exact item due CAS did not replay: %',v_replay;
    END IF;
    BEGIN
        PERFORM public.complete_due_billing_enrollment_item_transition_v31(
            v_execute.id,v_studio,v_worker,v_execute.revision,repeat('8',64),
            jsonb_build_array(jsonb_build_object(
                'old_item_id','si_conflicting_old',
                'new_item_id','si_transitionrotated',
                'expected_active_count',2
            ))
        );
        RAISE EXCEPTION 'Same-evidence, different-mapping replay was accepted.';
    EXCEPTION WHEN unique_violation THEN
        IF SQLERRM<>'billing_enrollment_item_due_completion_conflict' THEN
            RAISE;
        END IF;
    END;
    SELECT count(*) INTO v_operation_count
    FROM public.billing_provider_operations
    WHERE operation_type='enrollment.cancel.period_end.execute';
    IF v_operation_count <> 0 THEN
        RAISE EXCEPTION 'Provider-scheduled item due invented an execute operation: %',
            v_operation_count;
    END IF;

    PERFORM pg_sleep(1.6);
    SELECT * INTO v_execute
    FROM public.claim_due_billing_enrollment_transitions_v1(v_worker, 30, 5)
    WHERE source_intent_id=v_whole_schedule.id
    LIMIT 1;
    IF v_execute.id IS NULL
       OR v_execute.provider_operation_id IS NOT NULL
       OR v_execute.provider_caller_request_key IS NOT NULL THEN
        RAISE EXCEPTION 'Whole due claim invented provider work: %', to_jsonb(v_execute);
    END IF;
    SELECT count(*) INTO v_operation_count
    FROM public.billing_provider_operations
    WHERE operation_type='enrollment.cancel.period_end.execute';
    IF v_operation_count <> 0 THEN
        RAISE EXCEPTION 'Whole due claim created a second provider operation.';
    END IF;
    UPDATE public.student_billing_enrollments
    SET status='canceled'
    WHERE id=v_enrollment_whole AND studio_id=v_studio;
    v_result := public.complete_due_billing_enrollment_transition_v1(
        v_execute.id, v_worker, v_execute.revision, repeat('9', 64), 'canceled'
    );
    IF v_result->>'outcome' <> 'completed'
       OR (SELECT state FROM public.billing_enrollment_transition_intents
            WHERE id=v_whole_schedule.id) <> 'completed' THEN
        RAISE EXCEPTION 'Whole due readback did not converge source completion: %', v_result;
    END IF;

    BEGIN
        UPDATE public.billing_enrollment_transition_aliases
        SET request_sha256=repeat('0',64)
        WHERE intent_id=v_item_schedule.id;
        RAISE EXCEPTION 'Immutable transition alias was updated.';
    EXCEPTION WHEN check_violation THEN
        IF SQLERRM <> 'billing_enrollment_transition_alias_immutable' THEN RAISE; END IF;
    END;
END;
$$;

ROLLBACK;
