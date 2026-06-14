BEGIN;

DO $$
DECLARE
    v_rpc REGPROCEDURE := 'public.write_student_profile_atomic(uuid, uuid, uuid, jsonb, uuid[], jsonb, boolean, text)'::REGPROCEDURE;
    v_owner UUID := gen_random_uuid();
    v_other_owner UUID := gen_random_uuid();
    v_studio UUID := gen_random_uuid();
    v_other_studio UUID := gen_random_uuid();
    v_program_one UUID := gen_random_uuid();
    v_program_two UUID := gen_random_uuid();
    v_other_program UUID := gen_random_uuid();
    v_ladder_one UUID := gen_random_uuid();
    v_ladder_two UUID := gen_random_uuid();
    v_other_ladder UUID := gen_random_uuid();
    v_rank_one UUID := gen_random_uuid();
    v_rank_two UUID := gen_random_uuid();
    v_other_rank UUID := gen_random_uuid();
    v_student UUID := gen_random_uuid();
    v_conflict_student UUID := gen_random_uuid();
    v_other_guardian UUID := gen_random_uuid();
    v_written public.students%ROWTYPE;
    v_count INTEGER;
BEGIN
    IF to_regprocedure('public.write_student_profile_atomic(uuid, uuid, uuid, jsonb, uuid[], jsonb, boolean, text)') IS NULL THEN
        RAISE EXCEPTION 'Missing public.write_student_profile_atomic(uuid, uuid, uuid, jsonb, uuid[], jsonb, boolean, text).';
    END IF;

    IF NOT has_function_privilege('service_role', v_rpc, 'EXECUTE') THEN
        RAISE EXCEPTION 'service_role must execute public.write_student_profile_atomic.';
    END IF;

    IF has_function_privilege('anon', v_rpc, 'EXECUTE')
       OR has_function_privilege('authenticated', v_rpc, 'EXECUTE') THEN
        RAISE EXCEPTION 'Browser-facing roles must not execute public.write_student_profile_atomic.';
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
    VALUES
        (
            v_owner,
            'authenticated',
            'authenticated',
            'student-write-' || replace(v_owner::TEXT, '-', '') || '@example.invalid',
            '{}'::jsonb,
            '{}'::jsonb,
            now(),
            now()
        ),
        (
            v_other_owner,
            'authenticated',
            'authenticated',
            'student-write-' || replace(v_other_owner::TEXT, '-', '') || '@example.invalid',
            '{}'::jsonb,
            '{}'::jsonb,
            now(),
            now()
        );

    INSERT INTO public.studios (id, name, slug, owner_id)
    VALUES
        (v_studio, 'Student Write Smoke', 'student-write-' || replace(v_studio::TEXT, '-', ''), v_owner),
        (v_other_studio, 'Student Write Other', 'student-write-' || replace(v_other_studio::TEXT, '-', ''), v_other_owner);

    INSERT INTO public.programs (id, studio_id, name)
    VALUES
        (v_program_one, v_studio, 'Fundamentals'),
        (v_program_two, v_studio, 'Competition'),
        (v_other_program, v_other_studio, 'Other Program');

    INSERT INTO public.belt_ladders (id, studio_id, name, program_id)
    VALUES
        (v_ladder_one, v_studio, 'Fundamentals Ladder', v_program_one),
        (v_ladder_two, v_studio, 'Competition Ladder', v_program_two),
        (v_other_ladder, v_other_studio, 'Other Ladder', v_other_program);

    INSERT INTO public.belt_ranks (id, studio_id, ladder_id, name, display_order)
    VALUES
        (v_rank_one, v_studio, v_ladder_one, 'White Belt', 0),
        (v_rank_two, v_studio, v_ladder_two, 'Blue Belt', 0),
        (v_other_rank, v_other_studio, v_other_ladder, 'Other Rank', 0);

    SELECT *
    INTO v_written
    FROM public.write_student_profile_atomic(
        v_student,
        v_studio,
        v_owner,
        jsonb_build_object(
            'id', v_student,
            'studio_id', v_studio,
            'legal_first_name', 'Aiko',
            'legal_last_name', 'Tanaka',
            'status', 'active',
            'membership_start_date', '2026-06-01',
            'program_id', v_program_one,
            'current_belt_rank_id', v_rank_one,
            'tags', jsonb_build_array('new')
        ),
        ARRAY[v_program_one],
        jsonb_build_array(jsonb_build_object(
            'first_name', 'Hana',
            'last_name', 'Tanaka',
            'email', 'hana@example.invalid',
            'is_primary_contact', true
        )),
        TRUE,
        'student.created'
    );

    IF v_written.id <> v_student
       OR v_written.studio_id <> v_studio
       OR v_written.legal_first_name <> 'Aiko'
       OR v_written.program_id <> v_program_one
       OR v_written.current_belt_rank_id <> v_rank_one THEN
        RAISE EXCEPTION 'Atomic student create did not return the expected student row.';
    END IF;

    SELECT COUNT(*)
    INTO v_count
    FROM public.student_program_memberships
    WHERE studio_id = v_studio
      AND student_id = v_student
      AND program_id = v_program_one
      AND status = 'active'
      AND ended_at IS NULL;

    IF v_count <> 1 THEN
        RAISE EXCEPTION 'Atomic student create did not create one active membership.';
    END IF;

    SELECT COUNT(*)
    INTO v_count
    FROM public.guardians guardian
    JOIN public.student_guardians link ON link.guardian_id = guardian.id
    WHERE guardian.studio_id = v_studio
      AND guardian.first_name = 'Hana'
      AND guardian.last_name = 'Tanaka'
      AND link.student_id = v_student;

    IF v_count <> 1 THEN
        RAISE EXCEPTION 'Atomic student create did not create the guardian relationship.';
    END IF;

    SELECT COUNT(*)
    INTO v_count
    FROM public.audit_logs
    WHERE studio_id = v_studio
      AND actor_id = v_owner
      AND action = 'student.created'
      AND entity_id = v_student;

    IF v_count <> 1 THEN
        RAISE EXCEPTION 'Atomic student create did not write one audit log.';
    END IF;

    SELECT *
    INTO v_written
    FROM public.write_student_profile_atomic(
        v_student,
        v_studio,
        v_owner,
        jsonb_build_object(
            'status', 'paused',
            'program_id', v_program_two,
            'current_belt_rank_id', v_rank_two,
            'membership_start_date', '2026-06-15',
            'tags', jsonb_build_array('updated')
        ),
        ARRAY[v_program_two],
        '[]'::jsonb,
        TRUE,
        'student.updated'
    );

    IF v_written.status <> 'paused'
       OR v_written.program_id <> v_program_two
       OR v_written.current_belt_rank_id <> v_rank_two
       OR v_written.tags <> ARRAY['updated']::TEXT[] THEN
        RAISE EXCEPTION 'Atomic student update did not return the expected student row.';
    END IF;

    SELECT COUNT(*)
    INTO v_count
    FROM public.student_program_memberships
    WHERE studio_id = v_studio
      AND student_id = v_student
      AND program_id = v_program_one
      AND status = 'ended'
      AND ended_at IS NOT NULL;

    IF v_count <> 1 THEN
        RAISE EXCEPTION 'Atomic student update did not end the old membership.';
    END IF;

    SELECT COUNT(*)
    INTO v_count
    FROM public.student_program_memberships
    WHERE studio_id = v_studio
      AND student_id = v_student
      AND program_id = v_program_two
      AND status = 'active'
      AND ended_at IS NULL;

    IF v_count <> 1 THEN
        RAISE EXCEPTION 'Atomic student update did not activate the new membership.';
    END IF;

    BEGIN
        PERFORM public.write_student_profile_atomic(
            v_student,
            v_studio,
            v_owner,
            jsonb_build_object(
                'current_belt_rank_id', v_other_rank
            ),
            ARRAY[v_program_two],
            '[]'::jsonb,
            TRUE,
            'student.updated'
        );
        RAISE EXCEPTION 'Expected cross-studio student rank write to fail.';
    EXCEPTION
        WHEN OTHERS THEN
            IF SQLERRM NOT ILIKE '%belt rank does not belong to this studio%' THEN
                RAISE;
            END IF;
    END;

    BEGIN
        PERFORM public.write_student_profile_atomic(
            v_student,
            v_studio,
            v_owner,
            jsonb_build_object(
                'program_id', v_program_one,
                'current_belt_rank_id', v_rank_two
            ),
            ARRAY[v_program_one],
            '[]'::jsonb,
            TRUE,
            'student.updated'
        );
        RAISE EXCEPTION 'Expected cross-program student rank write to fail.';
    EXCEPTION
        WHEN OTHERS THEN
            IF SQLERRM NOT ILIKE '%different program%' THEN
                RAISE;
            END IF;
    END;

    INSERT INTO public.students (
        id,
        studio_id,
        legal_first_name,
        legal_last_name,
        status,
        membership_start_date,
        program_id
    )
    VALUES (
        v_conflict_student,
        v_other_studio,
        'Other',
        'Student',
        'active',
        CURRENT_DATE,
        v_other_program
    );

    INSERT INTO public.guardians (
        id,
        studio_id,
        first_name,
        last_name,
        is_primary_contact
    )
    VALUES (
        v_other_guardian,
        v_other_studio,
        'Other',
        'Guardian',
        true
    );

    BEGIN
        INSERT INTO public.student_guardians (student_id, guardian_id)
        VALUES (v_student, v_other_guardian);
        RAISE EXCEPTION 'Expected cross-studio student guardian link to fail.';
    EXCEPTION
        WHEN OTHERS THEN
            IF SQLERRM NOT ILIKE '%crosses studio boundaries%' THEN
                RAISE;
            END IF;
    END;

    BEGIN
        PERFORM public.write_student_profile_atomic(
            v_conflict_student,
            v_studio,
            v_owner,
            jsonb_build_object(
                'id', v_conflict_student,
                'studio_id', v_studio,
                'legal_first_name', 'Collision',
                'legal_last_name', 'Student',
                'status', 'active'
            ),
            ARRAY[v_program_one],
            '[]'::jsonb,
            TRUE,
            'student.created'
        );
        RAISE EXCEPTION 'Expected cross-studio student id conflict to fail.';
    EXCEPTION
        WHEN OTHERS THEN
            IF SQLERRM NOT ILIKE '%another studio%' THEN
                RAISE;
            END IF;
    END;
END $$;

ROLLBACK;
