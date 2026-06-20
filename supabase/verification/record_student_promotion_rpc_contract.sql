BEGIN;

DO $$
DECLARE
    v_owner UUID := gen_random_uuid();
    v_studio UUID := gen_random_uuid();
    v_other_studio UUID := gen_random_uuid();
    v_program UUID := gen_random_uuid();
    v_other_program UUID := gen_random_uuid();
    v_other_studio_program UUID := gen_random_uuid();
    v_ladder UUID := gen_random_uuid();
    v_other_ladder UUID := gen_random_uuid();
    v_other_studio_ladder UUID := gen_random_uuid();
    v_rank_white UUID := gen_random_uuid();
    v_rank_yellow UUID := gen_random_uuid();
    v_rank_orange UUID := gen_random_uuid();
    v_other_program_rank UUID := gen_random_uuid();
    v_other_studio_rank UUID := gen_random_uuid();
    v_student UUID := gen_random_uuid();
    v_student_without_membership UUID := gen_random_uuid();
    v_membership UUID := gen_random_uuid();
    v_promotion public.promotions%ROWTYPE;
    v_promotion_count INTEGER;
    v_expected_exception BOOLEAN;
BEGIN
    IF to_regprocedure('public.record_student_promotion(uuid, uuid, uuid, uuid, uuid, uuid, uuid, text)') IS NULL THEN
        RAISE EXCEPTION 'Missing public.record_student_promotion(uuid, uuid, uuid, uuid, uuid, uuid, uuid, text).';
    END IF;

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
        'koaryu-promotion-verification-' || replace(v_owner::TEXT, '-', '') || '@example.invalid',
        '{}'::jsonb,
        '{}'::jsonb,
        now(),
        now()
    );

    INSERT INTO public.studios (id, name, slug, owner_id)
    VALUES
        (v_studio, 'Koaryu Promotion Verification', 'koaryu-promotion-' || replace(v_studio::TEXT, '-', ''), v_owner),
        (v_other_studio, 'Koaryu Other Promotion Verification', 'koaryu-other-promotion-' || replace(v_other_studio::TEXT, '-', ''), v_owner);

    INSERT INTO public.programs (id, studio_id, name, sort_order)
    VALUES
        (v_program, v_studio, 'Promotion Program', 0),
        (v_other_program, v_studio, 'Other Promotion Program', 1),
        (v_other_studio_program, v_other_studio, 'Other Studio Promotion Program', 0);

    INSERT INTO public.belt_ladders (id, studio_id, name, program_id)
    VALUES
        (v_ladder, v_studio, 'Promotion Ladder', v_program),
        (v_other_ladder, v_studio, 'Other Program Ladder', v_other_program),
        (v_other_studio_ladder, v_other_studio, 'Other Studio Ladder', v_other_studio_program);

    INSERT INTO public.belt_ranks (id, ladder_id, studio_id, name, display_order)
    VALUES
        (v_rank_white, v_ladder, v_studio, 'White', 0),
        (v_rank_yellow, v_ladder, v_studio, 'Yellow', 1),
        (v_rank_orange, v_ladder, v_studio, 'Orange', 2),
        (v_other_program_rank, v_other_ladder, v_studio, 'Other White', 0),
        (v_other_studio_rank, v_other_studio_ladder, v_other_studio, 'Other Studio White', 0);

    INSERT INTO public.students (
        id,
        studio_id,
        legal_first_name,
        legal_last_name,
        status,
        program_id,
        current_belt_rank_id
    )
    VALUES
        (v_student, v_studio, 'Promotion', 'Student', 'active', v_program, v_rank_white),
        (v_student_without_membership, v_studio, 'No', 'Membership', 'active', v_program, v_rank_white);

    INSERT INTO public.student_program_memberships (
        id,
        studio_id,
        student_id,
        program_id,
        status,
        started_at,
        current_belt_rank_id
    )
    VALUES (
        v_membership,
        v_studio,
        v_student,
        v_program,
        'active',
        CURRENT_DATE,
        v_rank_white
    );

    SELECT *
    INTO v_promotion
    FROM public.record_student_promotion(
        v_studio,
        v_student,
        v_membership,
        v_program,
        v_rank_white,
        v_rank_yellow,
        v_owner,
        'Verification happy path'
    );

    IF v_promotion.id IS NULL
       OR v_promotion.program_id IS DISTINCT FROM v_program
       OR v_promotion.student_program_membership_id IS DISTINCT FROM v_membership THEN
        RAISE EXCEPTION 'Promotion RPC did not return the expected happy-path promotion: %', row_to_json(v_promotion);
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM public.student_program_memberships
        WHERE id = v_membership
          AND current_belt_rank_id = v_rank_yellow
    ) THEN
        RAISE EXCEPTION 'Promotion RPC did not update membership rank atomically.';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM public.students
        WHERE id = v_student
          AND current_belt_rank_id = v_rank_yellow
          AND program_id = v_program
    ) THEN
        RAISE EXCEPTION 'Promotion RPC did not update student rank/program atomically.';
    END IF;

    SELECT COUNT(*)
    INTO v_promotion_count
    FROM public.promotions
    WHERE studio_id = v_studio;

    v_expected_exception := false;
    BEGIN
        PERFORM public.record_student_promotion(
            v_studio,
            v_student,
            v_membership,
            v_program,
            v_rank_white,
            v_rank_orange,
            v_owner,
            'Stale membership rank should fail'
        );
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%membership rank changed%' THEN
            v_expected_exception := true;
        ELSE
            RAISE;
        END IF;
    END;
    IF NOT v_expected_exception THEN
        RAISE EXCEPTION 'Expected stale membership rank promotion to fail.';
    END IF;

    v_expected_exception := false;
    BEGIN
        PERFORM public.record_student_promotion(
            v_studio,
            v_student,
            v_membership,
            v_other_program,
            v_rank_yellow,
            v_rank_orange,
            v_owner,
            'Wrong program should fail'
        );
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%target ladder program%' THEN
            v_expected_exception := true;
        ELSE
            RAISE;
        END IF;
    END;
    IF NOT v_expected_exception THEN
        RAISE EXCEPTION 'Expected promotion with mismatched program to fail.';
    END IF;

    v_expected_exception := false;
    BEGIN
        PERFORM public.record_student_promotion(
            v_studio,
            v_student,
            v_membership,
            v_program,
            v_rank_yellow,
            v_other_studio_rank,
            v_owner,
            'Cross-studio rank should fail'
        );
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Target belt rank not found%' THEN
            v_expected_exception := true;
        ELSE
            RAISE;
        END IF;
    END;
    IF NOT v_expected_exception THEN
        RAISE EXCEPTION 'Expected cross-studio target-rank promotion to fail.';
    END IF;

    v_expected_exception := false;
    BEGIN
        PERFORM public.record_student_promotion(
            v_studio,
            v_student_without_membership,
            NULL,
            v_program,
            v_rank_white,
            v_rank_yellow,
            v_owner,
            'Program ladder without membership should fail'
        );
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Program-scoped promotions require%' THEN
            v_expected_exception := true;
        ELSE
            RAISE;
        END IF;
    END;
    IF NOT v_expected_exception THEN
        RAISE EXCEPTION 'Expected program-scoped promotion without membership to fail.';
    END IF;

    IF (
        SELECT COUNT(*)
        FROM public.promotions
        WHERE studio_id = v_studio
    ) <> v_promotion_count THEN
        RAISE EXCEPTION 'Failed promotion validation cases inserted promotion rows.';
    END IF;

    RAISE NOTICE 'Koaryu record_student_promotion RPC contract verification passed.';
END $$;

ROLLBACK;
