-- Current-state contract for public.sync_belt_ladder_ranks(uuid, uuid, text, jsonb).
--
-- The migration history for this RPC includes several repair migrations. Treat
-- this smoke file, plus the function/grant checks in account_support_controls.sql,
-- as the audit entrypoint for the final contract: service-role backend only,
-- no temp-table dependency, tenant-locked ladder selection, atomic create/update/
-- remove behavior, and deterministic full-state return.

BEGIN;

DO $$
DECLARE
    v_owner UUID := gen_random_uuid();
    v_studio UUID := gen_random_uuid();
    v_other_studio UUID := gen_random_uuid();
    v_ladder UUID := gen_random_uuid();
    v_ranks JSONB;
    v_first_rank UUID;
    v_rank_count INTEGER;
    v_error_message TEXT;
BEGIN
    INSERT INTO auth.users (
        id,
        aud,
        role,
        email,
        raw_app_meta_data,
        raw_user_meta_data,
        created_at,
        updated_at
    )
    VALUES (
        v_owner,
        'authenticated',
        'authenticated',
        'koaryu-verification-' || replace(v_owner::TEXT, '-', '') || '@example.invalid',
        '{}'::jsonb,
        '{}'::jsonb,
        now(),
        now()
    );

    INSERT INTO public.studios (id, name, slug, owner_id)
    VALUES (v_studio, 'Koaryu Verification Studio', 'koaryu-verification-' || replace(v_studio::TEXT, '-', ''), v_owner);

    INSERT INTO public.belt_ladders (id, studio_id, name)
    VALUES (v_ladder, v_studio, 'Verification Ladder');

    SELECT synced.ranks
    INTO v_ranks
    FROM public.sync_belt_ladder_ranks(
        v_ladder,
        v_studio,
        'Stripe',
        jsonb_build_array(
            jsonb_build_object(
                'name', 'White',
                'color_hex', '#ffffff',
                'min_classes', 0,
                'min_months', 0,
                'requires_approval', false,
                'is_tip', false
            ),
            jsonb_build_object(
                'name', 'Yellow',
                'color_hex', '#facc15',
                'min_classes', 10,
                'min_months', 2,
                'requires_approval', true,
                'is_tip', false
            )
        )
    ) AS synced;

    IF jsonb_array_length(v_ranks) <> 2 THEN
        RAISE EXCEPTION 'Expected two ranks after initial sync, got %', jsonb_array_length(v_ranks);
    END IF;

    v_first_rank := (v_ranks->0->>'id')::UUID;

    SELECT synced.ranks
    INTO v_ranks
    FROM public.sync_belt_ladder_ranks(
        v_ladder,
        v_studio,
        'Tip',
        jsonb_build_array(
            jsonb_build_object(
                'id', v_first_rank,
                'name', 'White Updated',
                'color_hex', '#eeeeee',
                'min_classes', 1,
                'min_months', 0,
                'requires_approval', false,
                'is_tip', false
            ),
            jsonb_build_object(
                'name', 'Green Tip',
                'color_hex', '#22c55e',
                'min_classes', 3,
                'min_months', 1,
                'requires_approval', false,
                'is_tip', true,
                'tip_color_hex', '#16a34a'
            )
        )
    ) AS synced;

    IF jsonb_array_length(v_ranks) <> 2 THEN
        RAISE EXCEPTION 'Expected two ranks after update sync, got %', jsonb_array_length(v_ranks);
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM public.belt_ranks
        WHERE ladder_id = v_ladder
          AND studio_id = v_studio
          AND name = 'White Updated'
          AND id = v_first_rank
    ) THEN
        RAISE EXCEPTION 'Existing rank was not updated in place.';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.belt_ranks
        WHERE ladder_id = v_ladder
          AND studio_id = v_studio
          AND name = 'Yellow'
    ) THEN
        RAISE EXCEPTION 'Removed rank still exists after sync.';
    END IF;

    SELECT COUNT(*)
    INTO v_rank_count
    FROM public.belt_ranks
    WHERE ladder_id = v_ladder
      AND studio_id = v_studio;

    IF v_rank_count <> 2 THEN
        RAISE EXCEPTION 'Expected two persisted ranks after update sync, got %', v_rank_count;
    END IF;

    BEGIN
        PERFORM *
        FROM public.sync_belt_ladder_ranks(
            v_ladder,
            v_other_studio,
            'Stripe',
            '[]'::jsonb
        );

        RAISE EXCEPTION 'Expected wrong-studio belt ladder sync to fail.';
    EXCEPTION
        WHEN OTHERS THEN
            GET STACKED DIAGNOSTICS v_error_message = MESSAGE_TEXT;

            IF v_error_message <> 'Belt ladder not found' THEN
                RAISE EXCEPTION 'Expected wrong-studio sync to fail with Belt ladder not found, got: %', v_error_message;
            END IF;
    END;
END $$;

ROLLBACK;
