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
    v_program UUID := gen_random_uuid();
    v_ladder UUID := gen_random_uuid();
    v_student_before_rank UUID := gen_random_uuid();
    v_student_after_rank UUID := gen_random_uuid();
    v_ended_student UUID := gen_random_uuid();
    v_ranks JSONB;
    v_first_rank UUID;
    v_second_rank UUID;
    v_tip_rank UUID;
    v_green_rank UUID;
    v_replacement_rank UUID;
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

    INSERT INTO public.programs (id, studio_id, name)
    VALUES (v_program, v_studio, 'Verification Program');

    INSERT INTO public.belt_ladders (id, studio_id, name, program_id)
    VALUES (v_ladder, v_studio, 'Verification Ladder', v_program);

    INSERT INTO public.students (
        id,
        studio_id,
        legal_first_name,
        legal_last_name,
        status,
        program_id
    )
    VALUES (
        v_student_before_rank,
        v_studio,
        'Before',
        'Rank',
        'active',
        v_program
    );

    INSERT INTO public.student_program_memberships (
        studio_id,
        student_id,
        program_id,
        status,
        current_belt_rank_id
    )
    VALUES (
        v_studio,
        v_student_before_rank,
        v_program,
        'active',
        NULL
    );

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
    v_second_rank := (v_ranks->1->>'id')::UUID;

    IF NOT EXISTS (
        SELECT 1
        FROM public.student_program_memberships
        WHERE student_id = v_student_before_rank
          AND program_id = v_program
          AND current_belt_rank_id = v_first_rank
    ) THEN
        RAISE EXCEPTION 'Creating the first full belt did not backfill an existing unassigned membership.';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM public.students
        WHERE id = v_student_before_rank
          AND program_id = v_program
          AND current_belt_rank_id = v_first_rank
    ) THEN
        RAISE EXCEPTION 'Starting-belt backfill did not update the primary student rank.';
    END IF;

    INSERT INTO public.students (
        id,
        studio_id,
        legal_first_name,
        legal_last_name,
        status,
        program_id
    )
    VALUES (
        v_student_after_rank,
        v_studio,
        'After',
        'Rank',
        'active',
        v_program
    );

    INSERT INTO public.student_program_memberships (
        studio_id,
        student_id,
        program_id,
        status,
        current_belt_rank_id
    )
    VALUES (
        v_studio,
        v_student_after_rank,
        v_program,
        'active',
        NULL
    );

    IF NOT EXISTS (
        SELECT 1
        FROM public.student_program_memberships
        WHERE student_id = v_student_after_rank
          AND program_id = v_program
          AND current_belt_rank_id = v_first_rank
    ) THEN
        RAISE EXCEPTION 'A new unassigned membership did not default to the starting belt.';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM public.students
        WHERE id = v_student_after_rank
          AND program_id = v_program
          AND current_belt_rank_id = v_first_rank
    ) THEN
        RAISE EXCEPTION 'Membership default did not update the primary student rank.';
    END IF;

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
                'id', v_second_rank,
                'name', 'Yellow',
                'color_hex', '#facc15',
                'min_classes', 10,
                'min_months', 2,
                'requires_approval', true,
                'is_tip', false
            ),
            jsonb_build_object(
                'name', 'Yellow Tip',
                'color_hex', '#fde047',
                'min_classes', 3,
                'min_months', 1,
                'requires_approval', false,
                'is_tip', true,
                'tip_color_hex', '#eab308'
            ),
            jsonb_build_object(
                'name', 'Green',
                'color_hex', '#22c55e',
                'min_classes', 12,
                'min_months', 3,
                'requires_approval', true,
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

    IF jsonb_array_length(v_ranks) <> 5 THEN
        RAISE EXCEPTION 'Expected five ranks after update sync, got %', jsonb_array_length(v_ranks);
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

    IF NOT EXISTS (
        SELECT 1
        FROM public.belt_ranks
        WHERE ladder_id = v_ladder
          AND studio_id = v_studio
          AND name = 'Yellow'
    ) THEN
        RAISE EXCEPTION 'Existing second rank was not preserved during sync.';
    END IF;

    SELECT COUNT(*)
    INTO v_rank_count
    FROM public.belt_ranks
    WHERE ladder_id = v_ladder
      AND studio_id = v_studio;

    IF v_rank_count <> 5 THEN
        RAISE EXCEPTION 'Expected five persisted ranks after update sync, got %', v_rank_count;
    END IF;

    v_tip_rank := (v_ranks->2->>'id')::UUID;
    v_green_rank := (v_ranks->3->>'id')::UUID;

    UPDATE public.student_program_memberships
    SET current_belt_rank_id = v_tip_rank
    WHERE student_id = v_student_before_rank
      AND program_id = v_program;

    UPDATE public.student_program_memberships
    SET current_belt_rank_id = NULL
    WHERE student_id = v_student_before_rank
      AND program_id = v_program;

    IF EXISTS (
        SELECT 1
        FROM public.student_program_memberships
        WHERE student_id = v_student_before_rank
          AND current_belt_rank_id IS NOT NULL
    ) THEN
        RAISE EXCEPTION 'Clearing an existing rank during an update was rewritten to the starting belt.';
    END IF;

    UPDATE public.student_program_memberships
    SET current_belt_rank_id = v_tip_rank
    WHERE student_id = v_student_before_rank
      AND program_id = v_program;

    UPDATE public.students
    SET current_belt_rank_id = v_tip_rank
    WHERE id = v_student_before_rank
      AND studio_id = v_studio;

    UPDATE public.student_program_memberships
    SET current_belt_rank_id = v_second_rank
    WHERE student_id = v_student_after_rank
      AND program_id = v_program;

    UPDATE public.students
    SET current_belt_rank_id = v_second_rank
    WHERE id = v_student_after_rank
      AND studio_id = v_studio;

    INSERT INTO public.students (
        id, studio_id, legal_first_name, legal_last_name, status,
        program_id, current_belt_rank_id
    )
    VALUES (
        v_ended_student, v_studio, 'Ended', 'Rank', 'inactive',
        v_program, v_second_rank
    );

    INSERT INTO public.student_program_memberships (
        studio_id, student_id, program_id, status, ended_at,
        current_belt_rank_id
    )
    VALUES (
        v_studio, v_ended_student, v_program, 'ended', CURRENT_DATE,
        v_second_rank
    );

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
                'id', v_green_rank,
                'name', 'Green',
                'color_hex', '#22c55e',
                'min_classes', 12,
                'min_months', 3,
                'requires_approval', true,
                'is_tip', false
            )
        )
    ) AS synced;

    v_replacement_rank := v_first_rank;

    IF EXISTS (
        SELECT 1
        FROM public.student_program_memberships
        WHERE student_id IN (v_student_before_rank, v_student_after_rank)
          AND current_belt_rank_id IS DISTINCT FROM v_replacement_rank
    ) THEN
        RAISE EXCEPTION 'Deleting a middle belt group did not move active memberships to the preceding surviving full belt.';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.students
        WHERE id IN (v_student_before_rank, v_student_after_rank)
          AND current_belt_rank_id IS DISTINCT FROM v_replacement_rank
    ) THEN
        RAISE EXCEPTION 'Deleting a middle belt group did not move primary student ranks to the preceding surviving full belt.';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.student_program_memberships
        WHERE student_id = v_ended_student
          AND current_belt_rank_id IS NOT NULL
    ) THEN
        RAISE EXCEPTION 'Deleting a rank rewrote an ended membership instead of leaving foreign-key cleanup neutral.';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.students
        WHERE id = v_ended_student
          AND current_belt_rank_id IS NOT NULL
    ) THEN
        RAISE EXCEPTION 'Deleting a rank reassigned an inactive student without an active membership.';
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
