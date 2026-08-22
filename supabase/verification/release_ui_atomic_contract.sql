BEGIN;

DO $$
DECLARE
    v_signature TEXT;
    v_rpc REGPROCEDURE;
BEGIN
    FOREACH v_signature IN ARRAY ARRAY[
        'public.mutate_student_program_membership_atomic(uuid,uuid,uuid,text,uuid,jsonb)',
        'public.mutate_students_bulk_atomic(uuid,uuid,uuid[],text,text[],text[],text)',
        'public.soft_delete_student_atomic(uuid,uuid,uuid)',
        'public.reserve_core_checkout_atomic(uuid)',
        'public.reserve_core_checkout_v2_atomic(uuid)',
        'public.publish_core_checkout_atomic(uuid,uuid,bigint,text,text,bigint)',
        'public.release_core_checkout_reservation_atomic(uuid,uuid,bigint)',
        'public.accept_core_checkout_subscription_atomic(uuid,uuid,bigint,text,text,bigint)',
        'public.set_studio_comp_v2_atomic(uuid,boolean,text,uuid,text,boolean)',
        'public.sync_belt_ladder_ranks_v2(uuid,uuid,uuid,uuid,text,jsonb)',
        'public.write_student_profile_v2_atomic(uuid,uuid,uuid,jsonb,uuid[],jsonb,boolean,text)'
    ] LOOP
        v_rpc := to_regprocedure(v_signature);
        IF v_rpc IS NULL THEN
            RAISE EXCEPTION 'Missing release UI atomic RPC: %', v_signature;
        END IF;
        IF NOT has_function_privilege('service_role', v_rpc, 'EXECUTE') THEN
            RAISE EXCEPTION 'service_role cannot execute %', v_signature;
        END IF;
        IF has_function_privilege('anon', v_rpc, 'EXECUTE')
           OR has_function_privilege('authenticated', v_rpc, 'EXECUTE') THEN
            RAISE EXCEPTION 'Browser role can execute %', v_signature;
        END IF;
    END LOOP;
END $$;

DO $$
DECLARE
    v_owner UUID := gen_random_uuid();
    v_studio UUID := gen_random_uuid();
    v_program_one UUID := gen_random_uuid();
    v_program_two UUID := gen_random_uuid();
    v_unassigned UUID := gen_random_uuid();
    v_student UUID := gen_random_uuid();
    v_membership_one UUID := gen_random_uuid();
    v_membership_two UUID := gen_random_uuid();
    v_ladder UUID := gen_random_uuid();
    v_white UUID := gen_random_uuid();
    v_yellow UUID := gen_random_uuid();
    v_black UUID := gen_random_uuid();
    v_promotion UUID := gen_random_uuid();
    v_checkout RECORD;
    v_publish RECORD;
    v_second_checkout RECORD;
    v_result public.student_program_memberships%ROWTYPE;
    v_deleted BOOLEAN;
    v_metadata JSONB;
    v_bulk_count INTEGER;
    v_override_studio UUID := gen_random_uuid();
    v_unbound_override_studio UUID := gen_random_uuid();
    v_override_token UUID := gen_random_uuid();
    v_comp_result RECORD;
    v_sync_operation UUID := gen_random_uuid();
    v_sync_result RECORD;
    v_student_write RECORD;
    v_compensation_recorded BOOLEAN;
    v_compensation_replayed BOOLEAN;
BEGIN
    INSERT INTO auth.users (
        id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
    ) VALUES (
        v_owner, 'authenticated', 'authenticated',
        'release-ui-atomic-' || replace(v_owner::TEXT, '-', '') || '@example.invalid',
        '{}'::JSONB, '{}'::JSONB, NOW(), NOW()
    );
    INSERT INTO public.studios (id, name, slug, owner_id)
    VALUES (
        v_studio, 'Release UI Atomic Contract',
        'release-ui-atomic-' || replace(v_studio::TEXT, '-', ''), v_owner
    );
    INSERT INTO public.programs (id, studio_id, name, sort_order, is_system)
    VALUES
        (v_program_one, v_studio, 'Program One', 0, FALSE),
        (v_program_two, v_studio, 'Program Two', 1, FALSE),
        (v_unassigned, v_studio, 'Unassigned', 2, TRUE);
    INSERT INTO public.belt_ladders (id, studio_id, name, program_id)
    VALUES (v_ladder, v_studio, 'Program One Ladder', v_program_one);
    INSERT INTO public.belt_ranks (
        id, ladder_id, studio_id, name, color_hex, display_order
    ) VALUES
        (v_white, v_ladder, v_studio, 'White Belt', '#FFFFFF', 0),
        (v_yellow, v_ladder, v_studio, 'Yellow Belt', '#FFFF00', 1),
        (v_black, v_ladder, v_studio, 'Black Belt', '#000000', 2);
    INSERT INTO public.students (
        id, studio_id, legal_first_name, legal_last_name, status,
        program_id, current_belt_rank_id, tags
    ) VALUES (
        v_student, v_studio, 'Atomic', 'Student', 'active',
        v_program_one, v_white, ARRAY['existing']::TEXT[]
    );
    INSERT INTO public.student_program_memberships (
        id, studio_id, student_id, program_id, status, started_at, current_belt_rank_id
    ) VALUES
        (v_membership_one, v_studio, v_student, v_program_one, 'active', CURRENT_DATE, v_white),
        (v_membership_two, v_studio, v_student, v_program_two, 'active', CURRENT_DATE, NULL);

    SELECT * INTO v_student_write
    FROM public.write_student_profile_v2_atomic(
        v_student,
        v_studio,
        v_owner,
        jsonb_build_object('notes', 'atomic response'),
        NULL,
        '[]'::JSONB,
        FALSE,
        'student.updated'
    );
    IF v_student_write.result_student->>'id' IS DISTINCT FROM v_student::TEXT
       OR v_student_write.result_student->>'notes' IS DISTINCT FROM 'atomic response'
       OR jsonb_array_length(v_student_write.result_guardians) <> 0
       OR jsonb_array_length(v_student_write.result_program_memberships) <> 2 THEN
        RAISE EXCEPTION 'Student V2 writer did not return the committed related response atomically.';
    END IF;

    SELECT * INTO v_result
    FROM public.mutate_student_program_membership_atomic(
        v_student, v_studio, v_owner, 'remove', v_membership_one, '{}'::JSONB
    );
    IF NOT EXISTS (
        SELECT 1 FROM public.students
        WHERE id = v_student AND program_id = v_program_two AND current_belt_rank_id IS NULL
    ) THEN
        RAISE EXCEPTION 'Removing the primary membership did not atomically select the remaining active program.';
    END IF;

    SELECT * INTO v_result
    FROM public.mutate_student_program_membership_atomic(
        v_student, v_studio, v_owner, 'remove', v_membership_two, '{}'::JSONB
    );
    IF NOT EXISTS (
        SELECT 1 FROM public.students student
        JOIN public.student_program_memberships membership
          ON membership.student_id = student.id
         AND membership.program_id = student.program_id
         AND membership.status = 'active'
         AND membership.ended_at IS NULL
        WHERE student.id = v_student AND student.program_id = v_unassigned
    ) THEN
        RAISE EXCEPTION 'Removing the final active membership did not atomically install the Unassigned fallback.';
    END IF;

    SELECT public.mutate_students_bulk_atomic(
        v_studio, v_owner, ARRAY[v_student], 'tags', ARRAY['new'], ARRAY['existing'], NULL
    ) INTO v_bulk_count;
    IF v_bulk_count <> 1 OR NOT EXISTS (
        SELECT 1 FROM public.students
        WHERE id = v_student AND tags = ARRAY['new']::TEXT[]
    ) OR NOT EXISTS (
        SELECT 1 FROM public.audit_logs
        WHERE entity_id = v_student AND action = 'student.tags.bulk_updated'
    ) THEN
        RAISE EXCEPTION 'Bulk tag write and audit did not commit atomically: count=%, tags=%, audits=%',
            v_bulk_count,
            (SELECT tags FROM public.students WHERE id = v_student),
            (SELECT count(*) FROM public.audit_logs
             WHERE entity_id = v_student AND action = 'student.tags.bulk_updated');
    END IF;

    SELECT * INTO v_sync_result
    FROM public.sync_belt_ladder_ranks_v2(
        v_ladder,
        v_studio,
        v_owner,
        v_sync_operation,
        'Stripe',
        jsonb_build_array(
            jsonb_build_object('id', v_white, 'name', 'White Belt', 'color_hex', '#FFFFFF', 'display_order', 0, 'min_classes', 0, 'min_months', 0, 'requires_approval', FALSE, 'is_tip', FALSE, 'tip_color_hex', NULL),
            jsonb_build_object('id', v_yellow, 'name', 'Yellow Belt', 'color_hex', '#FFFF00', 'display_order', 1, 'min_classes', 0, 'min_months', 0, 'requires_approval', FALSE, 'is_tip', FALSE, 'tip_color_hex', NULL),
            jsonb_build_object('id', v_black, 'name', 'Black Belt', 'color_hex', '#000000', 'display_order', 2, 'min_classes', 0, 'min_months', 0, 'requires_approval', FALSE, 'is_tip', FALSE, 'tip_color_hex', NULL)
        )
    );
    SELECT * INTO v_sync_result
    FROM public.sync_belt_ladder_ranks_v2(
        v_ladder,
        v_studio,
        v_owner,
        v_sync_operation,
        'Stripe',
        jsonb_build_array(
            jsonb_build_object('id', v_white, 'name', 'White Belt', 'color_hex', '#FFFFFF', 'display_order', 0, 'min_classes', 0, 'min_months', 0, 'requires_approval', FALSE, 'is_tip', FALSE, 'tip_color_hex', NULL),
            jsonb_build_object('id', v_yellow, 'name', 'Yellow Belt', 'color_hex', '#FFFF00', 'display_order', 1, 'min_classes', 0, 'min_months', 0, 'requires_approval', FALSE, 'is_tip', FALSE, 'tip_color_hex', NULL),
            jsonb_build_object('id', v_black, 'name', 'Black Belt', 'color_hex', '#000000', 'display_order', 2, 'min_classes', 0, 'min_months', 0, 'requires_approval', FALSE, 'is_tip', FALSE, 'tip_color_hex', NULL)
        )
    );
    IF v_sync_result.id <> v_ladder OR (
        SELECT count(*)
        FROM public.audit_logs audit
        WHERE audit.studio_id = v_studio
          AND audit.action = 'belt_ladder.synced'
          AND audit.entity_id = v_ladder
          AND audit.metadata->>'operation_id' = v_sync_operation::TEXT
    ) <> 1 THEN
        RAISE EXCEPTION 'Retry-safe ladder sync did not atomically retain one audit receipt.';
    END IF;
    BEGIN
        PERFORM public.sync_belt_ladder_ranks_v2(
            v_ladder, v_studio, v_owner, v_sync_operation, 'Tip', '[]'::JSONB
        );
        RAISE EXCEPTION 'Ladder operation ID accepted a different payload.';
    EXCEPTION
        WHEN SQLSTATE '22023' THEN NULL;
    END;

    INSERT INTO public.promotions (
        id, studio_id, student_id, from_rank_id, to_rank_id, promoted_by, notes
    ) VALUES (
        v_promotion, v_studio, v_student, v_white, v_yellow, v_owner, 'Snapshot contract'
    );
    IF NOT EXISTS (
        SELECT 1 FROM public.promotions
        WHERE id = v_promotion AND to_rank_name_snapshot = 'Yellow Belt'
    ) THEN
        RAISE EXCEPTION 'Promotion insert did not snapshot target rank: promotion=%, target_exists=%',
            (SELECT row_to_json(promotion) FROM public.promotions promotion WHERE id = v_promotion),
            EXISTS(SELECT 1 FROM public.belt_ranks WHERE id = v_yellow);
    END IF;
    DELETE FROM public.belt_ranks WHERE id IN (v_white, v_yellow);
    IF NOT EXISTS (
        SELECT 1 FROM public.promotions
        WHERE id = v_promotion
          AND from_rank_id IS NULL
          AND to_rank_id IS NULL
          AND from_rank_name_snapshot = 'White Belt'
          AND from_rank_color_snapshot = '#FFFFFF'
          AND to_rank_name_snapshot = 'Yellow Belt'
          AND to_rank_color_snapshot = '#FFFF00'
    ) THEN
        RAISE EXCEPTION 'Historical promotion did not survive from/to rank deletion with immutable snapshots: %',
            (SELECT row_to_json(promotion) FROM public.promotions promotion WHERE id = v_promotion);
    END IF;

    INSERT INTO public.studio_subscriptions (studio_id, status, comped, metadata)
    VALUES (v_studio, 'incomplete', FALSE, '{}'::JSONB);
    SELECT * INTO v_checkout FROM public.reserve_core_checkout_v2_atomic(v_studio);
    IF v_checkout.outcome <> 'reserved'
       OR v_checkout.reservation_token IS NULL
       OR v_checkout.trial_period_days <> 30 THEN
        RAISE EXCEPTION 'Core checkout did not atomically reserve a first-trial epoch: %',
            row_to_json(v_checkout);
    END IF;
    SELECT * INTO v_publish FROM public.publish_core_checkout_atomic(
        v_studio, v_checkout.reservation_token, v_checkout.checkout_epoch,
        'cs_contract', 'https://checkout.stripe.example/contract', 4102444800
    );
    IF v_publish.outcome <> 'published' THEN
        RAISE EXCEPTION 'Core checkout reservation could not be published.';
    END IF;

    IF public.accept_core_checkout_subscription_atomic(
        v_studio, v_checkout.reservation_token, v_checkout.checkout_epoch,
        'cs_contract', 'sub_contract', 10
    ) <> 'accepted' THEN
        RAISE EXCEPTION 'Core checkout acceptance did not commit.';
    END IF;
    SELECT * INTO v_second_checkout
    FROM public.reserve_core_checkout_v2_atomic(v_studio);
    IF v_second_checkout.outcome <> 'active'
       OR v_second_checkout.trial_period_days IS NOT NULL THEN
        RAISE EXCEPTION 'A completed checkout binding was reopened before projection: %',
            row_to_json(v_second_checkout);
    END IF;
    UPDATE public.studio_subscriptions
    SET stripe_subscription_id = 'sub_older', status = 'canceled'
    WHERE studio_id = v_studio;
    BEGIN
        UPDATE public.studio_subscriptions SET comped = TRUE WHERE studio_id = v_studio;
        RAISE EXCEPTION 'Comp grant crossed an accepted but unprojected subscription.';
    EXCEPTION
        WHEN SQLSTATE 'P0001' THEN NULL;
    END;
    IF EXISTS (
        SELECT 1 FROM public.studio_subscriptions
        WHERE studio_id = v_studio AND comped IS TRUE
    ) THEN
        RAISE EXCEPTION 'Rejected comp grant changed subscription state.';
    END IF;
    UPDATE public.studio_subscriptions
    SET stripe_subscription_id = 'sub_contract', status = 'canceled'
    WHERE studio_id = v_studio;
    SELECT * INTO v_second_checkout
    FROM public.reserve_core_checkout_v2_atomic(v_studio);
    IF v_second_checkout.outcome <> 'reserved'
       OR v_second_checkout.trial_period_days IS NOT NULL
          OR public.accept_core_checkout_subscription_atomic(
            v_studio, v_checkout.reservation_token, v_checkout.checkout_epoch,
            'cs_contract', 'sub_contract', 10
          ) <> 'historical_replay'
       OR NOT EXISTS (
            SELECT 1
            FROM public.studio_subscriptions subscription
            WHERE subscription.studio_id = v_studio
              AND subscription.metadata->>'core_trial_consumed' = 'true'
              AND subscription.metadata->'core_checkout_acceptances'->'sub_contract'
                    ->>'accepted_subscription_id' = 'sub_contract'
       ) THEN
        RAISE EXCEPTION 'Terminal subscription retry did not preserve accepted replay/trial proof.';
    END IF;

    -- Restore a published session so the comp-trigger invalidation contract
    -- below continues to exercise an in-flight checkout.
    SELECT * INTO v_publish FROM public.publish_core_checkout_atomic(
        v_studio, v_second_checkout.reservation_token, v_second_checkout.checkout_epoch,
        'cs_contract_2', 'https://checkout.stripe.example/contract-2', 4102444800
    );
    IF v_publish.outcome <> 'published' THEN
        RAISE EXCEPTION 'Second Core checkout reservation could not be published.';
    END IF;

    UPDATE public.studio_subscriptions SET comped = TRUE WHERE studio_id = v_studio;
    SELECT metadata INTO v_metadata
    FROM public.studio_subscriptions WHERE studio_id = v_studio;
    IF v_metadata->>'core_checkout_invalidated_session_id' <> 'cs_contract_2'
       OR v_metadata->>'core_checkout_invalidated_session_state' <> 'published'
       OR (v_metadata->>'core_checkout_epoch')::BIGINT <= v_second_checkout.checkout_epoch
       OR v_metadata ? 'core_checkout_session'
       OR public.accept_core_checkout_completion_atomic(
            v_studio, v_second_checkout.reservation_token, v_second_checkout.checkout_epoch,
            'cs_contract_2', 1
       )
       OR public.accept_core_checkout_subscription_atomic(
            v_studio, v_checkout.reservation_token, v_checkout.checkout_epoch,
            'cs_contract', 'sub_contract', 10
       ) <> 'invalid' THEN
        RAISE EXCEPTION 'Comp grant did not invalidate the published checkout epoch.';
    END IF;

    SELECT public.record_core_checkout_compensation_required_atomic(
        v_studio, 'cs_contract_2', 'sub_contract_2', 12,
        'invalid_paid_checkout_completion', TRUE
    ) INTO v_compensation_recorded;
    SELECT public.record_core_checkout_compensation_required_atomic(
        v_studio, 'cs_contract_2', 'sub_contract_2', 12,
        'invalid_paid_checkout_completion', TRUE
    ) INTO v_compensation_replayed;

    -- A rejection with no money owed still has to be durable: provider repair
    -- consults this record, and relying on the acceptance RPC to re-derive
    -- `invalid` left a transiently-uncancelled subscription repairable.
    IF NOT EXISTS (
        SELECT 1 FROM public.studio_subscriptions subscription
        WHERE subscription.studio_id = v_studio
          AND subscription.metadata->'core_checkout_rejections'
                ->'sub_contract_2'->>'subscription_id' = 'sub_contract_2'
    ) THEN
        RAISE EXCEPTION 'Compensation did not record a durable checkout rejection.';
    END IF;

    PERFORM public.record_core_checkout_compensation_required_atomic(
        v_studio, NULL, 'sub_contract_trial', 13,
        'invalid_paid_subscription_event', FALSE
    );
    IF NOT EXISTS (
        SELECT 1 FROM public.studio_subscriptions subscription
        WHERE subscription.studio_id = v_studio
          AND subscription.metadata->'core_checkout_rejections'
                ? 'sub_contract_trial'
    ) OR EXISTS (
        SELECT 1 FROM public.studio_subscriptions subscription
        WHERE subscription.studio_id = v_studio
          AND subscription.metadata->'core_checkout_compensations'
                ? 'sub_contract_trial'
    ) THEN
        RAISE EXCEPTION 'Unpaid rejection must record a rejection without a refund receipt.';
    END IF;
    IF NOT v_compensation_recorded OR v_compensation_replayed OR NOT EXISTS (
        SELECT 1 FROM public.studio_subscriptions subscription
        WHERE subscription.studio_id = v_studio
          AND subscription.metadata->'core_checkout_compensations'
                ->'sub_contract_2'->>'state' = 'required'
          AND subscription.metadata->'core_checkout_compensations'
                ->'sub_contract_2'->>'session_id' = 'cs_contract_2'
    ) THEN
        RAISE EXCEPTION 'Paid invalid Checkout compensation was not durable and idempotent.';
    END IF;

    SELECT public.soft_delete_student_atomic(v_student, v_studio, v_owner)
    INTO v_deleted;
    IF NOT v_deleted OR NOT EXISTS (
        SELECT 1 FROM public.students WHERE id = v_student AND deleted_at IS NOT NULL
    ) OR NOT EXISTS (
        SELECT 1 FROM public.audit_logs
        WHERE entity_id = v_student AND action = 'student.deleted'
    ) THEN
        RAISE EXCEPTION 'Soft delete and audit did not commit atomically.';
    END IF;

    INSERT INTO public.studios (id, name, slug, owner_id)
    VALUES (
        v_override_studio,
        'Release UI Core Override Contract',
        'release-ui-core-override-' || replace(v_override_studio::TEXT, '-', ''),
        v_owner
    );
    INSERT INTO public.studio_subscriptions (
        studio_id, status, stripe_subscription_id, comped, metadata
    ) VALUES (
        v_override_studio,
        'active',
        'sub_override_contract',
        FALSE,
        jsonb_build_object(
            'core_checkout_epoch', 1,
            'core_trial_consumed', TRUE,
            'core_checkout_session', jsonb_build_object(
                'state', 'completed',
                'token', v_override_token,
                'epoch', 1,
                'id', 'cs_override_contract',
                'accepted_subscription_id', 'sub_override_contract'
            ),
            'core_checkout_acceptances', jsonb_build_object(
                'sub_override_contract', jsonb_build_object(
                    'state', 'completed',
                    'token', v_override_token,
                    'epoch', 1,
                    'id', 'cs_override_contract',
                    'accepted_subscription_id', 'sub_override_contract'
                )
            )
        )
    );
    BEGIN
        PERFORM public.set_studio_comp_v2_atomic(
            v_override_studio, TRUE, 'contract refusal', v_owner, NULL, FALSE
        );
        RAISE EXCEPTION 'Live Core subscription comp succeeded without explicit override.';
    EXCEPTION
        WHEN SQLSTATE 'P0C01' THEN NULL;
    END;

    INSERT INTO public.studios (id, name, slug, owner_id)
    VALUES (
        v_unbound_override_studio,
        'Release UI Unbound Override Contract',
        'release-ui-unbound-override-' || replace(v_unbound_override_studio::TEXT, '-', ''),
        v_owner
    );
    INSERT INTO public.studio_subscriptions (
        studio_id, status, stripe_subscription_id, comped, metadata
    ) VALUES (
        v_unbound_override_studio, 'active', 'sub_unbound_contract', FALSE, '{}'::JSONB
    );
    BEGIN
        PERFORM public.set_studio_comp_v2_atomic(
            v_unbound_override_studio, TRUE, 'unsafe contract override', v_owner, NULL, TRUE
        );
        RAISE EXCEPTION 'Unbound live subscription comp override unexpectedly succeeded.';
    EXCEPTION
        WHEN SQLSTATE 'P0C02' THEN NULL;
    END;

    SELECT * INTO v_comp_result
    FROM public.set_studio_comp_v2_atomic(
        v_override_studio, TRUE, 'contract override', v_owner, NULL, TRUE
    );
    IF v_comp_result.outcome <> 'applied'
       OR v_comp_result.comped IS NOT TRUE
       OR v_comp_result.metadata->'comp'->>'live_subscription_override' <> 'true'
       OR v_comp_result.metadata->'comp'->>'live_subscription_override_subscription_id'
            <> 'sub_override_contract'
       OR v_comp_result.metadata->>'core_checkout_invalidated_session_state' <> 'completed'
       OR public.accept_core_checkout_subscription_atomic(
            v_override_studio, v_override_token, 1,
            'cs_override_contract', 'sub_override_contract', 20
          ) <> 'retained_live'
       OR public.accept_core_checkout_subscription_atomic(
            v_override_studio, v_override_token, 1,
            NULL, 'sub_override_contract', 21
          ) <> 'retained_live' THEN
        RAISE EXCEPTION 'Explicit live Core subscription comp override did not preserve exact replay.';
    END IF;

    UPDATE public.studio_subscriptions
    SET status = 'canceled'
    WHERE studio_id = v_override_studio;
    SELECT * INTO v_comp_result
    FROM public.set_studio_comp_v2_atomic(
        v_override_studio, FALSE, 'provider subscription canceled', v_owner, NULL, FALSE
    );
    IF v_comp_result.comped IS TRUE
       OR v_comp_result.subscription_status <> 'canceled'
       OR public.accept_core_checkout_subscription_atomic(
            v_override_studio, v_override_token, 1,
            'cs_override_contract', 'sub_override_contract', 22
          ) <> 'already_accepted'
       OR public.accept_core_checkout_subscription_atomic(
            v_override_studio, v_override_token, 1,
            NULL, 'sub_override_contract', 23
          ) <> 'already_accepted' THEN
        RAISE EXCEPTION 'Comp revocation restored stale provider entitlement: %',
            row_to_json(v_comp_result);
    END IF;

    RAISE NOTICE 'Koaryu release UI atomic contract verification passed.';
END $$;

DO $$
DECLARE
    v_v4 RECORD;
    v_v2 RECORD;
BEGIN
    UPDATE supabase_migrations.schema_migrations
    SET version = '20260814170001'
    WHERE version = '20260814170000';

    SELECT * INTO v_v4 FROM public.koaryu_release_schema_preflight_v4();
    SELECT * INTO v_v2 FROM public.koaryu_release_schema_preflight_v2();
    IF v_v4.ready IS TRUE
       OR NOT ('migration_history_sequence_v22' = ANY(v_v4.security_failures))
       OR v_v2.ready IS TRUE THEN
        RAISE EXCEPTION 'Readiness accepted substituted migration history: v4=%, v2=%',
            row_to_json(v_v4), row_to_json(v_v2);
    END IF;

    UPDATE supabase_migrations.schema_migrations
    SET version = '20260814170000'
    WHERE version = '20260814170001';
END $$;

ROLLBACK;
