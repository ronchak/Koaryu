BEGIN;

CREATE FUNCTION pg_temp.reject_student_write_audit()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.entity_id::TEXT = TG_ARGV[0] THEN
        RAISE EXCEPTION 'forced student write audit failure' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END;
$$;

DO $$
DECLARE
    v_rpc REGPROCEDURE := 'public.write_student_profile_atomic(uuid, uuid, uuid, jsonb, uuid[], jsonb, boolean, text)'::REGPROCEDURE;
    v_owner UUID := gen_random_uuid();
    v_other_owner UUID := gen_random_uuid();
    v_studio UUID := gen_random_uuid();
    v_other_studio UUID := gen_random_uuid();
    v_program_one UUID := gen_random_uuid();
    v_program_two UUID := gen_random_uuid();
    v_program_three UUID := gen_random_uuid();
    v_other_program UUID := gen_random_uuid();
    v_ladder_one UUID := gen_random_uuid();
    v_ladder_two UUID := gen_random_uuid();
    v_other_ladder UUID := gen_random_uuid();
    v_rank_one UUID := gen_random_uuid();
    v_rank_two UUID := gen_random_uuid();
    v_other_rank UUID := gen_random_uuid();
    v_student UUID := gen_random_uuid();
    v_sync_student UUID := gen_random_uuid();
    v_retained_student UUID := gen_random_uuid();
    v_conflict_student UUID := gen_random_uuid();
    v_other_guardian UUID := gen_random_uuid();
    v_written public.students%ROWTYPE;
    v_count INTEGER;
    v_member_one UUID;
    v_member_two UUID;
    v_member_three UUID;
    v_case RECORD;
    v_result RECORD;
    v_selected_programs UUID[];
    v_expected JSONB;
    v_actual JSONB;
    v_student_before JSONB;
    v_audit_count INTEGER;
    v_audit_rejected BOOLEAN := FALSE;
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
        (v_program_three, v_studio, 'New Program'),
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

    INSERT INTO public.students (
        id, studio_id, legal_first_name, legal_last_name, status,
        program_id, current_belt_rank_id
    ) VALUES (
        v_sync_student, v_studio, 'Program', 'Switch', 'active',
        v_program_one, v_rank_one
    );

    PERFORM public.write_student_profile_atomic(
        v_sync_student,
        v_studio,
        v_owner,
        '{}'::JSONB,
        ARRAY[v_program_two],
        '[]'::JSONB,
        TRUE,
        'student.updated'
    );

    IF NOT EXISTS (
        SELECT 1
        FROM public.students
        WHERE id = v_sync_student
          AND program_id = v_program_two
          AND current_belt_rank_id = v_rank_two
    ) THEN
        RAISE EXCEPTION 'Primary membership default did not replace a stale rank from the prior program.';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM public.student_program_memberships
        WHERE student_id = v_sync_student
          AND studio_id = v_studio
          AND program_id = v_program_two
          AND current_belt_rank_id = v_rank_two
          AND status = 'active'
          AND ended_at IS NULL
    ) THEN
        RAISE EXCEPTION 'Primary program switch did not default the new active membership.';
    END IF;

    INSERT INTO public.students (
        id, studio_id, legal_first_name, legal_last_name, status,
        program_id, current_belt_rank_id
    ) VALUES (
        v_retained_student, v_studio, 'Retained', 'Ranks', 'active',
        v_program_one, v_rank_one
    );

    INSERT INTO public.student_program_memberships (
        studio_id, student_id, program_id, status, current_belt_rank_id
    ) VALUES
        (v_studio, v_retained_student, v_program_one, 'active', v_rank_one),
        (v_studio, v_retained_student, v_program_two, 'active', v_rank_two);

    SELECT id INTO STRICT v_member_one FROM public.student_program_memberships
    WHERE student_id = v_retained_student AND program_id = v_program_one;
    SELECT id INTO STRICT v_member_two FROM public.student_program_memberships
    WHERE student_id = v_retained_student AND program_id = v_program_two;

    -- Normal forms resend the unchanged overall date and full program list.
    -- Neither implies a request to reactivate or redate retained memberships.
    FOR v_case IN SELECT * FROM (VALUES
        ('omitted', DATE '2026-01-10', '{}'::JSONB, TRUE, FALSE, DATE '2026-01-10', DATE '2026-03-05', NULL::DATE),
        ('same-date', DATE '2026-01-10', '{"membership_start_date":"2026-01-10"}'::JSONB, TRUE, FALSE, DATE '2026-01-10', DATE '2026-03-05', NULL::DATE),
        ('omitted-null', NULL::DATE, '{}'::JSONB, TRUE, FALSE, NULL::DATE, DATE '2026-03-05', NULL::DATE),
        ('same-null', NULL::DATE, '{"membership_start_date":null}'::JSONB, TRUE, FALSE, NULL::DATE, DATE '2026-03-05', NULL::DATE),
        ('reorder', DATE '2026-01-10', '{}'::JSONB, TRUE, TRUE, DATE '2026-01-10', DATE '2026-03-05', NULL::DATE),
        -- Overall edits preserve both known and unknown program dates.
        ('changed-date', DATE '2026-01-10', '{"membership_start_date":"2026-07-01"}'::JSONB, TRUE, FALSE, DATE '2026-07-01', DATE '2026-03-05', NULL::DATE),
        ('clear-date', DATE '2026-01-10', '{"membership_start_date":null}'::JSONB, TRUE, FALSE, NULL::DATE, DATE '2026-03-05', NULL::DATE),
        ('date-without-programs', DATE '2026-01-10', '{"membership_start_date":"2026-07-01"}'::JSONB, FALSE, FALSE, DATE '2026-07-01', DATE '2026-03-05', NULL::DATE),
        ('clear-without-programs', DATE '2026-01-10', '{"membership_start_date":null}'::JSONB, FALSE, FALSE, NULL::DATE, DATE '2026-03-05', NULL::DATE)
    ) AS cases(name, initial_date, payload, replace_programs, reorder, student_date, first_date, second_date)
    LOOP
        UPDATE public.students SET membership_start_date = v_case.initial_date,
            program_id = v_program_one, current_belt_rank_id = v_rank_one, tags = ARRAY['keep'], phone = 'original'
        WHERE id = v_retained_student;
        UPDATE public.student_program_memberships SET status = 'paused', started_at = DATE '2026-03-05', current_belt_rank_id = v_rank_one
        WHERE id = v_member_one;
        UPDATE public.student_program_memberships SET status = 'active', started_at = NULL, current_belt_rank_id = v_rank_two
        WHERE id = v_member_two;
        v_selected_programs := CASE WHEN NOT v_case.replace_programs THEN NULL
            WHEN v_case.reorder THEN ARRAY[v_program_two, v_program_one] ELSE ARRAY[v_program_one, v_program_two] END;

        SELECT * INTO v_result FROM public.write_student_profile_v2_atomic(
            v_retained_student, v_studio, v_owner,
            v_case.payload || jsonb_build_object('phone', 'updated') || CASE WHEN v_case.replace_programs
                THEN jsonb_build_object('status', 'active', 'program_id', v_selected_programs[1]) ELSE '{}'::JSONB END,
            v_selected_programs, '[]'::JSONB, v_case.replace_programs, 'student.updated'
        );
        IF (v_result.result_student->>'id')::UUID IS DISTINCT FROM v_retained_student
           OR (v_result.result_student->>'membership_start_date')::DATE IS DISTINCT FROM v_case.student_date
           OR v_result.result_student->>'phone' IS DISTINCT FROM 'updated'
           OR v_result.result_student->'tags' IS DISTINCT FROM '["keep"]'::JSONB
           OR (v_result.result_student->>'current_belt_rank_id')::UUID IS DISTINCT FROM
                (CASE WHEN v_case.reorder THEN v_rank_two ELSE v_rank_one END) THEN
            RAISE EXCEPTION 'Profile result changed unintended student facts for %.', v_case.name;
        END IF;
        v_expected := jsonb_build_object(
            v_member_one::TEXT, jsonb_build_array(v_program_one, 'paused', v_case.first_date, NULL, v_rank_one),
            v_member_two::TEXT, jsonb_build_array(v_program_two, 'active', v_case.second_date, NULL, v_rank_two)
        );
        SELECT jsonb_object_agg(id::TEXT, jsonb_build_array(program_id, status, started_at, ended_at, current_belt_rank_id))
        INTO v_actual FROM public.student_program_memberships
        WHERE student_id = v_retained_student AND studio_id = v_studio;
        IF v_actual IS DISTINCT FROM v_expected THEN
            RAISE EXCEPTION 'Retained membership facts changed for %.', v_case.name;
        END IF;
        SELECT jsonb_object_agg(item->>'id', jsonb_build_array(item->'program_id', item->'status', item->'started_at', item->'ended_at', item->'current_belt_rank_id'))
        INTO v_actual FROM jsonb_array_elements(v_result.result_program_memberships) item;
        IF v_actual IS DISTINCT FROM v_expected THEN
            RAISE EXCEPTION 'V2 response lost preserved membership facts for %.', v_case.name;
        END IF;
    END LOOP;

    -- Ending one program and adding another must preserve the retained program.
    SELECT * INTO v_result FROM public.write_student_profile_v2_atomic(
        v_retained_student, v_studio, v_owner, '{}'::JSONB,
        ARRAY[v_program_one, v_program_three], '[]'::JSONB, TRUE, 'student.updated'
    );
    SELECT id INTO STRICT v_member_three FROM public.student_program_memberships
    WHERE student_id = v_retained_student AND program_id = v_program_three AND ended_at IS NULL;
    IF v_member_three IN (v_member_one, v_member_two) THEN
        RAISE EXCEPTION 'New program reused a retained or ended membership identity.';
    END IF;
    v_expected := jsonb_build_object(
        v_member_one::TEXT, jsonb_build_array(v_program_one, 'paused', DATE '2026-03-05', NULL, v_rank_one),
        v_member_two::TEXT, jsonb_build_array(v_program_two, 'ended', NULL, CURRENT_DATE, NULL),
        v_member_three::TEXT, jsonb_build_array(v_program_three, 'active', NULL, NULL, NULL)
    );
    SELECT jsonb_object_agg(id::TEXT, jsonb_build_array(program_id, status, started_at, ended_at, current_belt_rank_id))
    INTO v_actual FROM public.student_program_memberships WHERE student_id = v_retained_student AND studio_id = v_studio;
    IF v_actual IS DISTINCT FROM v_expected THEN
        RAISE EXCEPTION 'Changing another program lost retained or ended membership facts.';
    END IF;

    SELECT to_jsonb(student) INTO v_student_before FROM public.students student WHERE id = v_retained_student;
    SELECT count(*) INTO v_audit_count FROM public.audit_logs WHERE entity_id = v_retained_student;
    EXECUTE format('CREATE TRIGGER student_write_audit_failure BEFORE INSERT ON public.audit_logs FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_student_write_audit(%L)', v_retained_student::TEXT);
    BEGIN
        PERFORM public.write_student_profile_v2_atomic(
            v_retained_student, v_studio, v_owner, '{"phone":"must-roll-back"}'::JSONB,
            ARRAY[v_program_one, v_program_two], '[]'::JSONB, TRUE, 'student.updated'
        );
    EXCEPTION WHEN SQLSTATE 'P0001' THEN
        IF SQLERRM IS DISTINCT FROM 'forced student write audit failure' THEN RAISE; END IF;
        v_audit_rejected := TRUE;
    END;
    DROP TRIGGER student_write_audit_failure ON public.audit_logs;
    IF NOT v_audit_rejected THEN RAISE EXCEPTION 'Student write audit failure was not observed.'; END IF;
    IF (SELECT to_jsonb(student) FROM public.students student WHERE id = v_retained_student) IS DISTINCT FROM v_student_before
       OR (SELECT count(*) FROM public.audit_logs WHERE entity_id = v_retained_student) IS DISTINCT FROM v_audit_count THEN
        RAISE EXCEPTION 'Failed audit did not roll back the student write.';
    END IF;
    SELECT jsonb_object_agg(id::TEXT, jsonb_build_array(program_id, status, started_at, ended_at, current_belt_rank_id))
    INTO v_actual FROM public.student_program_memberships WHERE student_id = v_retained_student AND studio_id = v_studio;
    IF v_actual IS DISTINCT FROM v_expected THEN RAISE EXCEPTION 'Failed audit did not roll back membership facts.'; END IF;

    -- Keep the independent rank-switch/explicit-clear checks on their original active fixture.
    DELETE FROM public.student_program_memberships WHERE id = v_member_three;
    UPDATE public.student_program_memberships SET status = 'active', ended_at = NULL,
        current_belt_rank_id = CASE WHEN id = v_member_one THEN v_rank_one ELSE v_rank_two END
    WHERE id IN (v_member_one, v_member_two);

    SELECT *
    INTO v_written
    FROM public.write_student_profile_atomic(
        v_retained_student,
        v_studio,
        v_owner,
        '{}'::JSONB,
        ARRAY[v_program_two, v_program_one],
        '[]'::JSONB,
        TRUE,
        'student.updated'
    );

    IF v_written.program_id <> v_program_two
       OR v_written.current_belt_rank_id <> v_rank_two THEN
        RAISE EXCEPTION 'Primary program switch did not retain and synchronize the new primary rank.';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM public.student_program_memberships
        WHERE student_id = v_retained_student
          AND studio_id = v_studio
          AND program_id = v_program_one
          AND current_belt_rank_id = v_rank_one
          AND status = 'active'
          AND ended_at IS NULL
    ) OR NOT EXISTS (
        SELECT 1
        FROM public.student_program_memberships
        WHERE student_id = v_retained_student
          AND studio_id = v_studio
          AND program_id = v_program_two
          AND current_belt_rank_id = v_rank_two
          AND status = 'active'
          AND ended_at IS NULL
    ) THEN
        RAISE EXCEPTION 'Primary program switch erased a retained membership rank.';
    END IF;

    SELECT *
    INTO v_written
    FROM public.write_student_profile_atomic(
        v_retained_student,
        v_studio,
        v_owner,
        jsonb_build_object('current_belt_rank_id', NULL),
        ARRAY[v_program_two, v_program_one],
        '[]'::JSONB,
        TRUE,
        'student.updated'
    );

    IF v_written.current_belt_rank_id IS NOT NULL
       OR EXISTS (
           SELECT 1
           FROM public.student_program_memberships
           WHERE student_id = v_retained_student
             AND studio_id = v_studio
             AND program_id = v_program_two
             AND current_belt_rank_id IS NOT NULL
             AND status = 'active'
             AND ended_at IS NULL
       ) OR NOT EXISTS (
           SELECT 1
           FROM public.student_program_memberships
           WHERE student_id = v_retained_student
             AND studio_id = v_studio
             AND program_id = v_program_one
             AND current_belt_rank_id = v_rank_one
             AND status = 'active'
             AND ended_at IS NULL
       ) THEN
        RAISE EXCEPTION 'Explicit primary-rank clear did not preserve the deliberate unranked state and retained secondary rank.';
    END IF;

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

-- DOB validation applies to every insert path, including import RPCs, and uses
-- the studio calendar rather than the session timezone. Retained invalid rows
-- can still receive unrelated profile edits or have the DOB explicitly cleared.
DO $$
DECLARE
    v_owner UUID := gen_random_uuid();
    v_studio UUID := gen_random_uuid();
    v_program UUID := gen_random_uuid();
    v_student UUID := gen_random_uuid();
    v_legacy UUID := gen_random_uuid();
    v_today DATE;
    v_future DATE;
    v_actual DATE;
    v_rejected BOOLEAN;
    v_constraint TEXT;
    v_timezone TEXT;
BEGIN
    INSERT INTO auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data)
    VALUES (v_owner, 'authenticated', 'authenticated',
            'dob-' || replace(v_owner::TEXT, '-', '') || '@example.invalid', '{}', '{}');
    INSERT INTO public.studios (id, name, slug, owner_id, timezone)
    VALUES (v_studio, 'Student DOB Contract', 'dob-' || replace(v_studio::TEXT, '-', ''),
            v_owner, 'America/Los_Angeles');
    INSERT INTO public.programs (id, studio_id, name) VALUES (v_program, v_studio, 'DOB Program');

    FOREACH v_timezone IN ARRAY ARRAY['America/Los_Angeles', 'Pacific/Kiritimati', 'UTC'] LOOP
        UPDATE public.studios SET timezone = v_timezone WHERE id = v_studio;
        v_today := public.student_business_date(v_studio);
        IF v_today IS DISTINCT FROM (CURRENT_TIMESTAMP AT TIME ZONE v_timezone)::DATE THEN
            RAISE EXCEPTION 'Student business date differs from studio calendar.';
        END IF;
        INSERT INTO public.students (studio_id, legal_first_name, legal_last_name, date_of_birth)
        VALUES (v_studio, 'Today', 'Allowed', v_today),
               (v_studio, 'Past leap day', 'Allowed', '2008-02-29'),
               (v_studio, 'Unknown', 'Allowed', NULL);
        FOREACH v_future IN ARRAY ARRAY[v_today + 1, (v_today + INTERVAL '1 year')::DATE] LOOP
            v_rejected := FALSE;
            BEGIN
                INSERT INTO public.students (studio_id, legal_first_name, legal_last_name, date_of_birth)
                VALUES (v_studio, 'Future', 'Rejected', v_future);
            EXCEPTION WHEN check_violation THEN
                GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
                IF v_constraint IS DISTINCT FROM 'students_birth_date_not_future' THEN RAISE; END IF;
                v_rejected := TRUE;
            END;
            IF NOT v_rejected THEN RAISE EXCEPTION 'Future birth date insert must fail.'; END IF;
        END LOOP;
    END LOOP;

    -- Fail closed for a missing studio, and use the same UTC fallback as API reads.
    UPDATE public.studios SET timezone = 'Invalid/Timezone' WHERE id = v_studio;
    v_today := public.student_business_date(v_studio);
    IF v_today IS DISTINCT FROM (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::DATE THEN
        RAISE EXCEPTION 'Invalid studio timezone must fall back to UTC.';
    END IF;

    INSERT INTO public.students (id, studio_id, legal_first_name, legal_last_name, date_of_birth)
    VALUES (v_student, v_studio, 'Profile', 'DOB', v_today);
    v_rejected := FALSE;
    BEGIN
        PERFORM public.write_student_profile_v2_atomic(
            v_student, v_studio, v_owner,
            jsonb_build_object('date_of_birth', (v_today + 1)::TEXT), NULL, '[]', FALSE, 'student.updated'
        );
    EXCEPTION WHEN check_violation THEN
        GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
        IF v_constraint IS DISTINCT FROM 'students_birth_date_not_future' THEN RAISE; END IF;
        v_rejected := TRUE;
    END;
    IF NOT v_rejected THEN RAISE EXCEPTION 'Atomic profile must reject future birth dates.'; END IF;
    SELECT date_of_birth INTO v_actual FROM public.students WHERE id = v_student;
    IF v_actual IS DISTINCT FROM v_today THEN RAISE EXCEPTION 'Rejected DOB update changed student.'; END IF;
    IF EXISTS (SELECT 1 FROM public.audit_logs WHERE entity_id = v_student) THEN
        RAISE EXCEPTION 'Rejected DOB update left an audit write.';
    END IF;

    -- Emulate a retained pre-migration row without rewriting any real records.
    ALTER TABLE public.students DISABLE TRIGGER validate_students_birth_date;
    INSERT INTO public.students (id, studio_id, legal_first_name, legal_last_name, date_of_birth)
    VALUES (v_legacy, v_studio, 'Retained', 'DOB', v_today + 1);
    ALTER TABLE public.students ENABLE TRIGGER validate_students_birth_date;
    UPDATE public.students SET notes = 'Unrelated edit', date_of_birth = date_of_birth WHERE id = v_legacy;
    SELECT date_of_birth INTO v_actual FROM public.students WHERE id = v_legacy;
    IF v_actual IS DISTINCT FROM v_today + 1 THEN RAISE EXCEPTION 'Retained DOB was silently rewritten.'; END IF;
    UPDATE public.students SET date_of_birth = NULL WHERE id = v_legacy;
    SELECT date_of_birth INTO v_actual FROM public.students WHERE id = v_legacy;
    IF v_actual IS NOT NULL THEN RAISE EXCEPTION 'Explicit DOB clearing failed.'; END IF;

    IF has_function_privilege('anon', 'public.student_business_date(uuid)', 'EXECUTE')
       OR has_function_privilege('authenticated', 'public.student_business_date(uuid)', 'EXECUTE')
       OR NOT has_function_privilege('service_role', 'public.student_business_date(uuid)', 'EXECUTE') THEN
        RAISE EXCEPTION 'Student business-date helper privileges changed.';
    END IF;
END $$;
-- Guardian additions and patches remain one transaction with profile/audit writes.
DO $$
DECLARE
    v_owner UUID := gen_random_uuid();
    v_other_owner UUID := gen_random_uuid();
    v_studio UUID := gen_random_uuid();
    v_other_studio UUID := gen_random_uuid();
    v_student UUID := gen_random_uuid();
    v_sibling UUID := gen_random_uuid();
    v_guardian UUID;
    v_secondary UUID := gen_random_uuid();
    v_foreign UUID := gen_random_uuid();
    v_unlinked UUID := gen_random_uuid();
    v_result RECORD;
    v_before_student JSONB;
    v_before_guardian JSONB;
    v_before_audit INTEGER;
    v_invalid JSONB;
    v_failed BOOLEAN;
BEGIN
    IF has_function_privilege('authenticated', 'public.write_student_profile_v2_atomic(uuid,uuid,uuid,jsonb,uuid[],jsonb,boolean,text)', 'EXECUTE')
       OR has_function_privilege('anon', 'public.write_student_profile_v2_atomic(uuid,uuid,uuid,jsonb,uuid[],jsonb,boolean,text)', 'EXECUTE') THEN
        RAISE EXCEPTION 'Guardian write must remain unavailable to browser roles.';
    END IF;
    INSERT INTO auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    VALUES (v_owner, 'authenticated', 'authenticated', v_owner::TEXT || '@example.invalid', '{}', '{}', now(), now()),
           (v_other_owner, 'authenticated', 'authenticated', v_other_owner::TEXT || '@example.invalid', '{}', '{}', now(), now());
    INSERT INTO public.studios (id, owner_id, name, slug)
    VALUES (v_studio, v_owner, 'Guardian Test', v_studio::TEXT), (v_other_studio, v_other_owner, 'Guardian Other', v_other_studio::TEXT);
    INSERT INTO public.students (id, studio_id, legal_first_name, legal_last_name, status)
    VALUES (v_student, v_studio, 'Student', 'One', 'active'), (v_sibling, v_studio, 'Student', 'Two', 'active');

    -- Add a missing guardian, including the supported single-name contact case.
    SELECT * INTO v_result FROM public.write_student_profile_v2_atomic(
        v_student, v_studio, v_owner, '{}'::JSONB, NULL,
        '[{"first_name":"Kenji","last_name":"","phone":"old","is_primary_contact":true}]'::JSONB, FALSE, 'student.updated'
    );
    v_guardian := (v_result.result_guardians->0->>'id')::UUID;
    IF v_guardian IS NULL OR v_result.result_guardians->0->>'last_name' IS DISTINCT FROM ''
       OR NOT EXISTS (SELECT 1 FROM public.student_guardians WHERE student_id = v_student AND guardian_id = v_guardian) THEN
        RAISE EXCEPTION 'Missing guardian add/snapshot persistence.';
    END IF;

    INSERT INTO public.guardians (id, studio_id, first_name, last_name, is_primary_contact)
    VALUES (v_secondary, v_studio, 'Other', 'Parent', FALSE), (v_unlinked, v_studio, 'Unlinked', 'Contact', FALSE),
           (v_foreign, v_other_studio, 'Foreign', 'Contact', TRUE);
    INSERT INTO public.student_guardians (student_id, guardian_id)
    VALUES (v_student, v_secondary), (v_sibling, v_guardian);

    SELECT * INTO v_result FROM public.write_student_profile_v2_atomic(
        v_student, v_studio, v_owner, '{"notes":"ordinary edit"}'::JSONB
    );
    IF jsonb_array_length(v_result.result_guardians) IS DISTINCT FROM 2 THEN
        RAISE EXCEPTION 'Omitted guardians must preserve all contacts.';
    END IF;
    SELECT * INTO v_result FROM public.write_student_profile_v2_atomic(
        v_student, v_studio, v_owner, '{}'::JSONB, NULL,
        jsonb_build_array(jsonb_build_object('id', v_guardian, 'phone', 'new', 'email', NULL)), FALSE, 'student.updated'
    );
    IF NOT EXISTS (SELECT 1 FROM public.guardians WHERE id = v_guardian AND phone = 'new' AND email IS NULL AND first_name = 'Kenji' AND last_name = '' AND is_primary_contact)
       OR (SELECT count(*) FROM public.student_guardians WHERE guardian_id = v_guardian) IS DISTINCT FROM 2::BIGINT
       OR NOT EXISTS (SELECT 1 FROM public.student_guardians WHERE student_id = v_student AND guardian_id = v_secondary)
       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_result.result_guardians) g WHERE g->>'id' = v_guardian::TEXT AND g->>'phone' = 'new') THEN
        RAISE EXCEPTION 'Contact patch must preserve identity, omitted fields, sibling/secondary links and committed snapshot.';
    END IF;

    SELECT to_jsonb(s) INTO v_before_student FROM public.students s WHERE id = v_student;
    SELECT to_jsonb(g) INTO v_before_guardian FROM public.guardians g WHERE id = v_guardian;
    SELECT count(*) INTO v_before_audit FROM public.audit_logs WHERE entity_id = v_student;
    FOR v_invalid IN SELECT value FROM jsonb_array_elements(jsonb_build_array(
        'null'::JSONB, '{}'::JSONB, '[null]'::JSONB, '[{"id":null,"phone":"bad"}]'::JSONB,
        '[{"first_name":"","last_name":""}]'::JSONB,
        jsonb_build_array(jsonb_build_object('id', v_guardian, 'first_name', NULL)),
        jsonb_build_array(jsonb_build_object('id', v_guardian, 'is_primary_contact', NULL)),
        jsonb_build_array(jsonb_build_object('id', v_unlinked, 'phone', 'bad')),
        jsonb_build_array(jsonb_build_object('id', v_foreign, 'phone', 'bad')),
        jsonb_build_array(jsonb_build_object('id', v_guardian, 'phone', 'one'), jsonb_build_object('id', v_guardian, 'phone', 'two'))
    )) LOOP
        v_failed := FALSE;
        BEGIN
            PERFORM public.write_student_profile_v2_atomic(v_student, v_studio, v_owner, '{"notes":"must rollback"}'::JSONB, NULL, v_invalid, FALSE, 'student.updated');
        EXCEPTION WHEN SQLSTATE '22023' THEN
            v_failed := TRUE;
        END;
        IF NOT v_failed THEN RAISE EXCEPTION 'Invalid guardian payload must fail with 22023: %', v_invalid; END IF;
        IF (SELECT to_jsonb(s) FROM public.students s WHERE id = v_student) IS DISTINCT FROM v_before_student
           OR (SELECT to_jsonb(g) FROM public.guardians g WHERE id = v_guardian) IS DISTINCT FROM v_before_guardian
           OR (SELECT count(*) FROM public.audit_logs WHERE entity_id = v_student) IS DISTINCT FROM v_before_audit::BIGINT THEN
            RAISE EXCEPTION 'Failed guardian patch must roll back the complete write.';
        END IF;
    END LOOP;
    IF NOT EXISTS (SELECT 1 FROM public.guardians WHERE id = v_foreign AND phone IS NULL) THEN
        RAISE EXCEPTION 'Cross-studio contact was changed.';
    END IF;

    EXECUTE format('CREATE TRIGGER guardian_audit_failure BEFORE INSERT ON public.audit_logs FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_student_write_audit(%L)', v_student::TEXT);
    v_failed := FALSE;
    BEGIN
        PERFORM public.write_student_profile_v2_atomic(v_student, v_studio, v_owner, '{"notes":"must rollback"}'::JSONB, NULL,
            jsonb_build_array(jsonb_build_object('id', v_guardian, 'phone', 'must rollback'), jsonb_build_object('first_name', 'New', 'last_name', '')),
            FALSE, 'student.updated');
    EXCEPTION WHEN SQLSTATE 'P0001' THEN
        IF SQLERRM IS DISTINCT FROM 'forced student write audit failure' THEN RAISE; END IF;
        v_failed := TRUE;
    END;
    IF NOT v_failed THEN RAISE EXCEPTION 'Expected audit failure.'; END IF;
    IF (SELECT to_jsonb(s) FROM public.students s WHERE id = v_student) IS DISTINCT FROM v_before_student
       OR (SELECT to_jsonb(g) FROM public.guardians g WHERE id = v_guardian) IS DISTINCT FROM v_before_guardian
       OR (SELECT count(*) FROM public.student_guardians WHERE student_id = v_student) IS DISTINCT FROM 2::BIGINT
       OR EXISTS (SELECT 1 FROM public.guardians WHERE studio_id = v_studio AND first_name = 'New') THEN
        RAISE EXCEPTION 'Audit failure must roll back contact add/patch, links and profile.';
    END IF;
    DROP TRIGGER guardian_audit_failure ON public.audit_logs;
END;
$$;

-- Compare both installed triggers against the original slow definition. The
-- temporary tables isolate trigger errors from the students table's FK, so a
-- missing studio must still produce the helper's exact error on dated rows.
CREATE FUNCTION pg_temp.slow_student_business_date(p_studio_id UUID)
RETURNS DATE LANGUAGE plpgsql AS $$
DECLARE v_timezone TEXT;
BEGIN
    SELECT COALESCE(NULLIF(timezone, ''), 'UTC') INTO v_timezone
    FROM public.studios WHERE id = p_studio_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Student studio not found.' USING ERRCODE = '23503';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name = v_timezone) THEN
        v_timezone := 'UTC';
    END IF;
    RETURN (CURRENT_TIMESTAMP AT TIME ZONE v_timezone)::DATE;
END;
$$;
-- CURRENT_TIMESTAMP is fixed for this transaction, and the studio timezone
-- stays fixed within each case group. Compute the exact slow reference once
-- per group instead of repeating its catalog scan for every operation/flag.
CREATE TEMP TABLE reference_student_business_dates (
    studio_id UUID PRIMARY KEY, business_date DATE
) ON COMMIT DROP;
CREATE FUNCTION pg_temp.reference_student_business_date(p_studio_id UUID)
RETURNS DATE LANGUAGE plpgsql AS $$
DECLARE v_today DATE;
BEGIN
    SELECT business_date INTO v_today FROM pg_temp.reference_student_business_dates
    WHERE studio_id = p_studio_id;
    IF NOT FOUND THEN
        RETURN pg_temp.slow_student_business_date(p_studio_id);
    END IF;
    RETURN v_today;
END;
$$;
CREATE FUNCTION pg_temp.slow_set_student_is_minor()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_today DATE;
BEGIN
    IF NEW.date_of_birth IS NOT NULL THEN
        v_today := pg_temp.reference_student_business_date(NEW.studio_id);
        NEW.is_minor := pg_catalog.isfinite(NEW.date_of_birth)
            AND NEW.date_of_birth <= v_today
            AND NEW.date_of_birth > ((v_today - INTERVAL '18 years')::DATE);
    ELSIF TG_OP = 'UPDATE' AND OLD.date_of_birth IS NOT NULL THEN
        v_today := pg_temp.reference_student_business_date(NEW.studio_id);
        NEW.is_minor := pg_catalog.isfinite(OLD.date_of_birth)
            AND OLD.date_of_birth <= v_today
            AND OLD.date_of_birth > ((v_today - INTERVAL '18 years')::DATE);
    ELSE
        NEW.is_minor := COALESCE(NEW.is_minor, false);
    END IF;
    RETURN NEW;
END;
$$;
CREATE FUNCTION pg_temp.slow_validate_student_birth_date()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.date_of_birth IS NULL THEN RETURN NEW; END IF;
    IF TG_OP = 'UPDATE' THEN
        IF NEW.date_of_birth IS NOT DISTINCT FROM OLD.date_of_birth
           AND NEW.studio_id IS NOT DISTINCT FROM OLD.studio_id THEN RETURN NEW; END IF;
    END IF;
    IF NOT pg_catalog.isfinite(NEW.date_of_birth)
       OR NEW.date_of_birth > pg_temp.reference_student_business_date(NEW.studio_id) THEN
        RAISE EXCEPTION 'Date of birth cannot be in the future.'
            USING ERRCODE = '23514', CONSTRAINT = 'students_birth_date_not_future';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TEMP TABLE repaired_student_dates (
    studio_id UUID, date_of_birth DATE, is_minor BOOLEAN, notes TEXT
) ON COMMIT DROP;
CREATE TEMP TABLE reference_student_dates (LIKE repaired_student_dates) ON COMMIT DROP;
CREATE TRIGGER set_students_is_minor BEFORE INSERT OR UPDATE ON repaired_student_dates
FOR EACH ROW EXECUTE FUNCTION public.set_student_is_minor();
CREATE TRIGGER validate_students_birth_date BEFORE INSERT OR UPDATE OF date_of_birth, studio_id ON repaired_student_dates
FOR EACH ROW EXECUTE FUNCTION public.validate_student_birth_date();
CREATE TRIGGER set_students_is_minor BEFORE INSERT OR UPDATE ON reference_student_dates
FOR EACH ROW EXECUTE FUNCTION pg_temp.slow_set_student_is_minor();
CREATE TRIGGER validate_students_birth_date BEFORE INSERT OR UPDATE OF date_of_birth, studio_id ON reference_student_dates
FOR EACH ROW EXECUTE FUNCTION pg_temp.slow_validate_student_birth_date();

DO $$
DECLARE
    v_owner UUID := gen_random_uuid();
    v_studio UUID := gen_random_uuid();
    v_missing UUID := gen_random_uuid();
    v_target UUID;
    v_utc DATE := (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::DATE;
    v_timezone TEXT;
    v_session TEXT;
    v_dob DATE;
    v_op TEXT;
    v_table TEXT;
    v_initial BOOLEAN;
    v_minor BOOLEAN;
    v_stored_dob DATE;
    v_state TEXT;
    v_constraint TEXT;
    v_message TEXT;
    v_outcome JSONB;
    v_reference JSONB;
    v_cases INTEGER := 0;
BEGIN
    INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data)
    VALUES(v_owner,'authenticated','authenticated',v_owner::TEXT||'@example.invalid','{}','{}');
    INSERT INTO public.studios(id,name,slug,owner_id,timezone)
    VALUES(v_studio,'Differential student dates',v_studio::TEXT,v_owner,'UTC');
    FOREACH v_session IN ARRAY ARRAY['Pacific/Kiritimati','Etc/GMT+12'] LOOP
        PERFORM set_config('TimeZone',v_session,true);
        FOREACH v_timezone IN ARRAY ARRAY['UTC','Pacific/Kiritimati','Etc/GMT+12',
            'America/Los_Angeles','Asia/Kolkata','Not/AZone','',NULL] LOOP
            UPDATE public.studios SET timezone = v_timezone WHERE id = v_studio;
            TRUNCATE pg_temp.reference_student_business_dates;
            INSERT INTO pg_temp.reference_student_business_dates
            VALUES(v_studio,pg_temp.slow_student_business_date(v_studio));
            FOREACH v_target IN ARRAY ARRAY[v_studio,v_missing] LOOP
                FOR v_dob IN
                    SELECT v_utc + n FROM generate_series(-3,3) n
                    UNION SELECT ((v_utc - INTERVAL '18 years')::DATE) + n FROM generate_series(-3,3) n
                    UNION SELECT d FROM (VALUES (DATE '2008-02-29'),(DATE '2012-02-29'),
                        (DATE '2024-02-29'),('infinity'::DATE),('-infinity'::DATE),(NULL::DATE)) dates(d)
                LOOP
                    FOREACH v_initial IN ARRAY ARRAY[TRUE,FALSE,NULL] LOOP
                        FOREACH v_op IN ARRAY ARRAY['insert','dob-update','unrelated-update','unchanged-dob-update','remove-dob','studio-update'] LOOP
                            v_reference := NULL;
                            FOREACH v_table IN ARRAY ARRAY['reference_student_dates','repaired_student_dates'] LOOP
                                EXECUTE format('TRUNCATE pg_temp.%I',v_table);
                                IF v_op <> 'insert' THEN
                                    -- Seed legacy invalid DOBs and deliberately stale flags.
                                    -- This also proves removal uses OLD DOB rather than OLD.is_minor.
                                    EXECUTE format('ALTER TABLE pg_temp.%I DISABLE TRIGGER USER',v_table);
                                    EXECUTE format('INSERT INTO pg_temp.%I VALUES ($1,$2,$3,NULL)',v_table)
                                        USING CASE WHEN v_op='studio-update' THEN v_studio ELSE v_target END,
                                              CASE WHEN v_op='dob-update' THEN NULL ELSE v_dob END,v_initial;
                                    EXECUTE format('ALTER TABLE pg_temp.%I ENABLE TRIGGER USER',v_table);
                                END IF;
                                v_minor := NULL; v_stored_dob := NULL;
                                v_state := '00000'; v_constraint := ''; v_message := '';
                                BEGIN
                                    CASE v_op
                                        WHEN 'insert' THEN
                                            EXECUTE format('INSERT INTO pg_temp.%I VALUES ($1,$2,$3,NULL) RETURNING is_minor,date_of_birth',v_table)
                                                INTO v_minor,v_stored_dob USING v_target,v_dob,v_initial;
                                        WHEN 'dob-update' THEN
                                            EXECUTE format('UPDATE pg_temp.%I SET date_of_birth=$1 RETURNING is_minor,date_of_birth',v_table)
                                                INTO v_minor,v_stored_dob USING v_dob;
                                        WHEN 'unrelated-update' THEN
                                            EXECUTE format('UPDATE pg_temp.%I SET notes=''unrelated'' RETURNING is_minor,date_of_birth',v_table)
                                                INTO v_minor,v_stored_dob;
                                        WHEN 'unchanged-dob-update' THEN
                                            EXECUTE format('UPDATE pg_temp.%I SET date_of_birth=date_of_birth RETURNING is_minor,date_of_birth',v_table)
                                                INTO v_minor,v_stored_dob;
                                        WHEN 'remove-dob' THEN
                                            EXECUTE format('UPDATE pg_temp.%I SET date_of_birth=NULL RETURNING is_minor,date_of_birth',v_table)
                                                INTO v_minor,v_stored_dob;
                                        WHEN 'studio-update' THEN
                                            EXECUTE format('UPDATE pg_temp.%I SET studio_id=$1 RETURNING is_minor,date_of_birth',v_table)
                                                INTO v_minor,v_stored_dob USING v_target;
                                    END CASE;
                                EXCEPTION WHEN OTHERS THEN
                                    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE,
                                        v_constraint = CONSTRAINT_NAME,v_message = MESSAGE_TEXT;
                                END;
                                IF v_state NOT IN ('00000','23503','23514') THEN
                                    RAISE EXCEPTION 'Unexpected differential error: %, %',v_state,v_message;
                                END IF;
                                IF v_state = '23503' AND v_message IS DISTINCT FROM 'Student studio not found.' THEN
                                    RAISE EXCEPTION 'Missing-studio error changed: %',v_message;
                                END IF;
                                IF v_state = '23514' AND (v_constraint IS DISTINCT FROM 'students_birth_date_not_future'
                                    OR v_message IS DISTINCT FROM 'Date of birth cannot be in the future.') THEN
                                    RAISE EXCEPTION 'Future-DOB error changed: %, %',v_constraint,v_message;
                                END IF;
                                v_outcome := jsonb_build_array(v_state,v_constraint,v_message,v_minor,v_stored_dob);
                                IF v_table='reference_student_dates' THEN
                                    v_reference := v_outcome;
                                ELSIF v_outcome IS DISTINCT FROM v_reference THEN
                                    RAISE EXCEPTION 'Student date differential mismatch: session=%, tz=%, missing=%, DOB=%, flag=%, op=%, reference=%, actual=%',
                                        v_session,v_timezone,v_target=v_missing,v_dob,v_initial,v_op,v_reference,v_outcome;
                                END IF;
                            END LOOP;
                            v_cases := v_cases + 1;
                        END LOOP;
                    END LOOP;
                END LOOP;
            END LOOP;
        END LOOP;
    END LOOP;
    RAISE NOTICE 'Student date differential PASS: % cases including missing studio, non-finite DOB, stale flags and session timezone independence.',v_cases;
END;
$$;

ROLLBACK;
