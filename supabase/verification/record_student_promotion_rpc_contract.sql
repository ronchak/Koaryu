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
    v_other_program_rank_two UUID := gen_random_uuid();
    v_other_studio_rank UUID := gen_random_uuid();
    v_student UUID := gen_random_uuid();
    v_student_without_membership UUID := gen_random_uuid();
    v_membership UUID := gen_random_uuid();
    v_secondary_membership UUID := gen_random_uuid();
    v_secondary_operation UUID := gen_random_uuid();
    v_secondary_demotion_operation UUID := gen_random_uuid();
    v_secondary_promotion UUID;
    v_promotion public.promotions%ROWTYPE;
    v_promotion_count INTEGER;
    v_expected_exception BOOLEAN;
    v_command_operation UUID := gen_random_uuid();
    v_command_promotion UUID;
    v_changed JSONB;
    v_error_detail TEXT;
    v_error_code TEXT;
    v_global_ladder UUID := gen_random_uuid();
    v_global_rank UUID := gen_random_uuid();
    v_global_student UUID := gen_random_uuid();
    v_foreign_student UUID := gen_random_uuid();
    v_foreign_membership UUID := gen_random_uuid();
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
        (v_other_program_rank_two, v_other_ladder, v_studio, 'Other Yellow', 1),
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
    VALUES
        (
            v_membership, v_studio, v_student, v_program,
            'active', CURRENT_DATE, v_rank_white
        ),
        (
            v_secondary_membership, v_studio, v_student, v_other_program,
            'active', CURRENT_DATE, v_other_program_rank
        );

    -- The API command resolves its membership and from-rank inside the writer.
    SET LOCAL ROLE service_role;
    SELECT id INTO v_command_promotion FROM public.record_student_rank_transition_v3(
        v_studio, v_student, NULL, NULL, v_rank_yellow, v_owner, NULL,
        'promotion', v_command_operation
    );
    IF v_command_promotion IS NULL OR NOT EXISTS (
        SELECT 1 FROM public.promotions WHERE id = v_command_promotion
          AND program_id = v_program AND student_program_membership_id = v_membership
          AND from_rank_id = v_rank_white AND to_rank_id = v_rank_yellow
          AND command_program_id = v_program AND command_membership_id = v_membership
          AND command_from_rank_id = v_rank_white AND command_fingerprint ~ '^v1:[0-9a-f]{64}$'
    ) THEN RAISE EXCEPTION 'V3 did not capture the resolved command and rank facts.'; END IF;
    IF (SELECT id FROM public.record_student_rank_transition_v3(
        v_studio, v_student, v_membership, v_program, v_rank_yellow, v_owner, NULL,
        'promotion', v_command_operation
    )) IS DISTINCT FROM v_command_promotion OR
    (SELECT id FROM public.record_student_promotion_v2(
        v_studio, v_student, v_membership, v_program, v_rank_white, v_rank_yellow,
        v_owner, NULL, v_command_operation
    )) IS DISTINCT FROM v_command_promotion THEN
        RAISE EXCEPTION 'Equivalent API and old V2 commands did not share the recorded receipt.';
    END IF;

    FOR v_changed IN SELECT value FROM jsonb_array_elements(jsonb_build_array(
        jsonb_build_object('student', v_student_without_membership),
        jsonb_build_object('actor', gen_random_uuid()),
        jsonb_build_object('target', v_rank_orange),
        jsonb_build_object('membership', v_secondary_membership),
        jsonb_build_object('program', v_other_program),
        jsonb_build_object('notes', ''),
        jsonb_build_object('kind', 'demotion', 'notes', 'Correction')
    )) LOOP
        v_expected_exception := FALSE;
        BEGIN
            PERFORM public.record_student_rank_transition_v3(
                v_studio, COALESCE((v_changed->>'student')::UUID, v_student),
                (v_changed->>'membership')::UUID, (v_changed->>'program')::UUID,
                COALESCE((v_changed->>'target')::UUID, v_rank_yellow),
                COALESCE((v_changed->>'actor')::UUID, v_owner),
                v_changed->>'notes', COALESCE(v_changed->>'kind', 'promotion'), v_command_operation
            );
        EXCEPTION WHEN invalid_parameter_value THEN
            GET STACKED DIAGNOSTICS v_error_detail = PG_EXCEPTION_DETAIL;
            IF v_error_detail IS DISTINCT FROM 'rank_transition_conflict' THEN RAISE; END IF;
            v_expected_exception := TRUE;
        END;
        IF NOT v_expected_exception THEN
            RAISE EXCEPTION 'Changed rank command was reported successful: %', v_changed;
        END IF;
    END LOOP;
    IF (SELECT count(*) FROM public.promotions WHERE studio_id = v_studio
        AND operation_id = v_command_operation) IS DISTINCT FROM 1
       OR (SELECT count(*) FROM public.audit_logs WHERE studio_id = v_studio
        AND entity_id = v_command_promotion AND action = 'student.promoted') IS DISTINCT FROM 1
       OR (SELECT current_belt_rank_id FROM public.student_program_memberships
           WHERE id = v_membership) IS DISTINCT FROM v_rank_yellow THEN
        RAISE EXCEPTION 'Rank retries changed history, audit or persisted rank.';
    END IF;
    PERFORM public.record_student_rank_transition_v3(
        v_studio, v_student, NULL, NULL, v_rank_white, v_owner, 'Correction',
        'demotion', gen_random_uuid()
    );
    RESET ROLE;

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

    SELECT id INTO v_secondary_promotion
    FROM public.record_student_promotion_v2(
        v_studio, v_student, v_secondary_membership, v_other_program,
        v_other_program_rank, v_other_program_rank_two, v_owner,
        'Secondary exact operation', v_secondary_operation
    );
    IF NOT EXISTS (
        SELECT 1 FROM public.student_program_memberships
        WHERE id = v_secondary_membership
          AND current_belt_rank_id = v_other_program_rank_two
    ) OR NOT EXISTS (
        SELECT 1 FROM public.students
        WHERE id = v_student
          AND program_id = v_program
          AND current_belt_rank_id = v_rank_yellow
    ) THEN
        RAISE EXCEPTION 'Secondary promotion changed primary compatibility state.';
    END IF;
    IF (
        SELECT id FROM public.record_student_promotion_v2(
            v_studio, v_student, v_secondary_membership, v_other_program,
            v_other_program_rank, v_other_program_rank_two, v_owner,
            'Secondary exact operation', v_secondary_operation
        )
    ) IS DISTINCT FROM v_secondary_promotion OR (
        SELECT count(*) FROM public.audit_logs
        WHERE studio_id = v_studio
          AND metadata->>'operation_id' = v_secondary_operation::TEXT
    ) <> 1 THEN
        RAISE EXCEPTION 'Promotion operation retry did not return one exact receipt.';
    END IF;

    PERFORM public.record_student_demotion_v2(
        v_studio, v_student, v_secondary_membership, v_other_program,
        v_other_program_rank_two, v_other_program_rank, v_owner,
        'Secondary correction', v_secondary_demotion_operation
    );
    IF NOT EXISTS (
        SELECT 1 FROM public.students
        WHERE id = v_student
          AND program_id = v_program
          AND current_belt_rank_id = v_rank_yellow
    ) THEN
        RAISE EXCEPTION 'Secondary demotion changed primary compatibility state.';
    END IF;

    v_expected_exception := false;
    BEGIN
        PERFORM public.record_student_promotion_v2(
            v_studio, v_student, v_membership, v_program,
            v_rank_yellow, v_rank_white, v_owner,
            'Wrong direction', gen_random_uuid()
        );
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%next rank%' THEN
            v_expected_exception := true;
        ELSE
            RAISE;
        END IF;
    END;
    IF NOT v_expected_exception THEN
        RAISE EXCEPTION 'Promotion writer accepted a non-adjacent or reverse transition.';
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

    -- New-command resolution must enforce the same ownership and rank rules.
    INSERT INTO public.students (id, studio_id, legal_first_name, legal_last_name, status, program_id)
    VALUES (v_foreign_student, v_other_studio, 'Foreign', 'Student', 'active', v_other_studio_program),
           (v_global_student, v_studio, 'Global', 'Student', 'active', v_program);
    INSERT INTO public.student_program_memberships (id, studio_id, student_id, program_id, status)
    VALUES (v_foreign_membership, v_other_studio, v_foreign_student, v_other_studio_program, 'active');
    INSERT INTO public.belt_ladders (id, studio_id, name, program_id)
    VALUES (v_global_ladder, v_studio, 'Unscoped Ladder', NULL);
    INSERT INTO public.belt_ranks (id, studio_id, ladder_id, name, display_order)
    VALUES (v_global_rank, v_studio, v_global_ladder, 'Initial', 0);

    FOR v_changed IN SELECT value FROM jsonb_array_elements(jsonb_build_array(
        jsonb_build_object('membership', gen_random_uuid(), 'code', 'P0002'),
        jsonb_build_object('membership', v_foreign_membership, 'code', 'P0002'),
        jsonb_build_object('membership', v_membership, 'student', v_student_without_membership, 'code', 'P0002'),
        jsonb_build_object('membership', v_secondary_membership, 'code', 'P0001'),
        jsonb_build_object('student', v_student_without_membership, 'code', 'P0001'),
        jsonb_build_object('student', v_global_student, 'target', v_global_rank,
                           'program', v_other_studio_program, 'code', 'P0002'),
        jsonb_build_object('target', v_other_studio_rank, 'code', 'P0002')
    )) LOOP
        v_expected_exception := FALSE;
        BEGIN
            PERFORM public.record_student_rank_transition_v3(
                v_studio, COALESCE((v_changed->>'student')::UUID, v_student),
                (v_changed->>'membership')::UUID, (v_changed->>'program')::UUID,
                COALESCE((v_changed->>'target')::UUID, v_rank_orange), v_owner, NULL,
                'promotion', gen_random_uuid()
            );
        EXCEPTION WHEN SQLSTATE 'P0001' OR SQLSTATE 'P0002' THEN
            GET STACKED DIAGNOSTICS v_error_detail = PG_EXCEPTION_DETAIL, v_error_code = RETURNED_SQLSTATE;
            IF v_error_code IS DISTINCT FROM v_changed->>'code'
               OR v_error_detail IS DISTINCT FROM (CASE v_error_code WHEN 'P0002'
                   THEN 'rank_transition_not_found' ELSE 'rank_transition_invalid' END) THEN RAISE; END IF;
            v_expected_exception := TRUE;
        END;
        IF NOT v_expected_exception THEN RAISE EXCEPTION 'V3 accepted invalid context: %', v_changed; END IF;
    END LOOP;

    UPDATE public.student_program_memberships SET status = 'ended', ended_at = CURRENT_DATE WHERE id = v_membership;
    v_expected_exception := FALSE;
    BEGIN
        PERFORM public.record_student_rank_transition_v3(v_studio, v_student, v_membership,
            v_program, v_rank_orange, v_owner, NULL, 'promotion', gen_random_uuid());
    EXCEPTION WHEN SQLSTATE 'P0001' THEN
        GET STACKED DIAGNOSTICS v_error_detail = PG_EXCEPTION_DETAIL;
        IF v_error_detail IS DISTINCT FROM 'rank_transition_invalid' THEN RAISE; END IF;
        v_expected_exception := TRUE;
    END;
    IF NOT v_expected_exception THEN RAISE EXCEPTION 'V3 transitioned an ended membership.'; END IF;
    UPDATE public.student_program_memberships SET status = 'paused', ended_at = NULL WHERE id = v_membership;
    PERFORM public.record_student_rank_transition_v3(v_studio, v_student, NULL,
        NULL, v_rank_orange, v_owner, NULL, 'promotion', gen_random_uuid());
    IF (SELECT status FROM public.student_program_memberships WHERE id = v_membership) IS DISTINCT FROM 'paused'
       OR (SELECT current_belt_rank_id FROM public.students WHERE id = v_student) IS DISTINCT FROM v_rank_orange THEN
        RAISE EXCEPTION 'V3 did not preserve paused membership status while advancing its rank.';
    END IF;

    -- A secondary command leaves the primary projection alone.
    PERFORM public.record_student_rank_transition_v3(v_studio, v_student, NULL,
        NULL, v_other_program_rank_two, v_owner, NULL, 'promotion', gen_random_uuid());
    IF (SELECT current_belt_rank_id FROM public.students WHERE id = v_student) IS DISTINCT FROM v_rank_orange
       OR (SELECT current_belt_rank_id FROM public.student_program_memberships
           WHERE id = v_secondary_membership) IS DISTINCT FROM v_other_program_rank_two THEN
        RAISE EXCEPTION 'V3 secondary resolution changed the primary rank.';
    END IF;
    SELECT * INTO v_promotion FROM public.record_student_rank_transition_v3(
        v_studio, v_global_student, NULL, NULL, v_global_rank, v_owner,
        NULL, 'promotion', gen_random_uuid());
    IF v_promotion.from_rank_id IS NOT NULL OR v_promotion.student_program_membership_id IS NOT NULL
       OR v_promotion.program_id IS DISTINCT FROM v_program
       OR (SELECT current_belt_rank_id FROM public.students WHERE id = v_global_student) IS DISTINCT FROM v_global_rank THEN
        RAISE EXCEPTION 'Unranked global-ladder resolution changed the existing primary-program fallback.';
    END IF;

    RAISE NOTICE 'Koaryu record_student_promotion RPC contract verification passed.';
END $$;

ROLLBACK;
