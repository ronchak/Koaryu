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
        'public.publish_core_checkout_atomic(uuid,uuid,bigint,text,text,bigint)',
        'public.release_core_checkout_reservation_atomic(uuid,uuid,bigint)',
        'public.accept_core_checkout_subscription_atomic(uuid,uuid,bigint,text,text,bigint)'
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
    SELECT * INTO v_checkout FROM public.reserve_core_checkout_atomic(v_studio);
    IF v_checkout.outcome <> 'reserved' OR v_checkout.reservation_token IS NULL THEN
        RAISE EXCEPTION 'Core checkout did not reserve a studio-scoped epoch.';
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
    FROM public.reserve_core_checkout_atomic(v_studio);
    IF v_second_checkout.outcome <> 'active' THEN
        RAISE EXCEPTION 'A completed checkout binding was reopened before projection: %',
            row_to_json(v_second_checkout);
    END IF;
    UPDATE public.studio_subscriptions
    SET stripe_subscription_id = 'sub_contract', status = 'canceled'
    WHERE studio_id = v_studio;
    SELECT * INTO v_second_checkout
    FROM public.reserve_core_checkout_atomic(v_studio);
    IF v_second_checkout.outcome <> 'reserved'
       OR public.accept_core_checkout_subscription_atomic(
            v_studio, v_checkout.reservation_token, v_checkout.checkout_epoch,
            'cs_contract', 'sub_contract', 10
          ) <> 'already_accepted'
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
       OR (v_metadata->>'core_checkout_epoch')::BIGINT <= v_second_checkout.checkout_epoch
       OR v_metadata ? 'core_checkout_session'
       OR public.accept_core_checkout_completion_atomic(
            v_studio, v_second_checkout.reservation_token, v_second_checkout.checkout_epoch,
            'cs_contract_2', 1
       ) THEN
        RAISE EXCEPTION 'Comp grant did not invalidate the published checkout epoch.';
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

    RAISE NOTICE 'Koaryu release UI atomic contract verification passed.';
END $$;

ROLLBACK;
