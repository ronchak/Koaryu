BEGIN;

DO $$
DECLARE
    v_owner UUID := gen_random_uuid();
    v_studio UUID := gen_random_uuid();
    v_other_studio UUID := gen_random_uuid();
    v_program UUID := gen_random_uuid();
    v_other_program UUID := gen_random_uuid();
    v_alpha UUID := gen_random_uuid();
    v_beta UUID := gen_random_uuid();
    v_equal_a UUID := gen_random_uuid();
    v_equal_b UUID := gen_random_uuid();
    v_equal_c UUID := gen_random_uuid();
    v_equal_d UUID := gen_random_uuid();
    v_null_membership UUID := gen_random_uuid();
    v_inserted UUID := gen_random_uuid();
    v_inserted_before_cursor UUID := gen_random_uuid();
    v_other_student UUID := gen_random_uuid();
    v_guardian UUID := gen_random_uuid();
    v_session UUID := gen_random_uuid();
    v_medium_studio UUID := gen_random_uuid();
    v_large_studio UUID := gen_random_uuid();
    v_medium_program UUID := gen_random_uuid();
    v_medium_alt_program UUID := gen_random_uuid();
    v_large_program UUID := gen_random_uuid();
    v_large_alt_program UUID := gen_random_uuid();
    v_medium_session UUID := gen_random_uuid();
    v_large_session UUID := gen_random_uuid();
    v_page JSONB;
    v_next JSONB;
    v_previous JSONB;
    v_row JSONB;
    v_plan TEXT;
    v_rpc_plan JSONB;
    v_rpc_family TEXT;
    v_deep_next JSONB;
    v_deep_previous JSONB;
    v_deep_index INTEGER;
    v_denied BOOLEAN;
    v_sort_by TEXT;
    v_sort_dir TEXT;
    v_expected UUID[];
    v_seen UUID[];
    v_page_ids UUID[];
    v_page_two UUID[];
    v_page_three UUID[];
    v_delete_cursor JSONB;
    v_plan_text TEXT;
    v_plan_profile TEXT;
    v_plan_studio UUID;
    v_plan_program UUID;
BEGIN
    IF to_regprocedure('public.list_student_roster(uuid,text,text,uuid,integer,text,date,text,text,integer,text,uuid,text)') IS NULL THEN
        RAISE EXCEPTION 'Missing list_student_roster RPC signature.';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_proc AS function
        JOIN pg_namespace AS namespace ON namespace.oid = function.pronamespace
        CROSS JOIN LATERAL aclexplode(COALESCE(function.proacl, acldefault('f', function.proowner))) AS privilege
        WHERE namespace.nspname = 'public'
          AND function.oid = 'public.list_student_roster(uuid,text,text,uuid,integer,text,date,text,text,integer,text,uuid,text)'::REGPROCEDURE
          AND privilege.grantee = 0
          AND privilege.privilege_type = 'EXECUTE'
    ) THEN
        RAISE EXCEPTION 'PUBLIC can execute the roster RPC.';
    END IF;
    IF has_function_privilege('anon', 'public.list_student_roster(uuid,text,text,uuid,integer,text,date,text,text,integer,text,uuid,text)', 'EXECUTE')
       OR has_function_privilege('authenticated', 'public.list_student_roster(uuid,text,text,uuid,integer,text,date,text,text,integer,text,uuid,text)', 'EXECUTE')
       OR NOT has_function_privilege('service_role', 'public.list_student_roster(uuid,text,text,uuid,integer,text,date,text,text,integer,text,uuid,text)', 'EXECUTE') THEN
        RAISE EXCEPTION 'Roster RPC ACL is not service_role-only.';
    END IF;

    INSERT INTO auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    VALUES (v_owner, 'authenticated', 'authenticated', 'roster-' || replace(v_owner::TEXT, '-', '') || '@example.invalid', '{}', '{}', now(), now());
    INSERT INTO public.studios (id, name, slug, owner_id)
    VALUES
        (v_studio, 'Roster Contract Studio', 'roster-' || replace(v_studio::TEXT, '-', ''), v_owner),
        (v_other_studio, 'Roster Other Studio', 'roster-other-' || replace(v_other_studio::TEXT, '-', ''), v_owner);
    INSERT INTO public.programs (id, studio_id, name)
    VALUES
        (v_program, v_studio, 'Advanced Roster Program'),
        (v_other_program, v_other_studio, 'Advanced Other Program');
    INSERT INTO public.students (
        id, studio_id, legal_first_name, legal_last_name, preferred_name, email, phone,
        status, membership_start_date, program_id, notes, tags, created_at, updated_at
    ) VALUES
        (v_alpha, v_studio, 'Alpha', 'Page', 'Ari', 'alpha@example.invalid', '555-0101', 'active', DATE '2026-01-01', v_program, 'quick view', ARRAY['vip'], TIMESTAMPTZ '2026-01-01', TIMESTAMPTZ '2026-01-01'),
        (v_beta, v_studio, 'Beta', 'Page', NULL, 'beta@example.invalid', '555-0102', 'active', DATE '2026-05-01', NULL, NULL, ARRAY[]::TEXT[], TIMESTAMPTZ '2026-05-01', TIMESTAMPTZ '2026-05-01'),
        (v_other_student, v_other_studio, 'Alpha', 'Page', NULL, 'other@example.invalid', '555-0199', 'active', DATE '2026-01-01', v_other_program, NULL, ARRAY[]::TEXT[], now(), now());
    INSERT INTO public.student_program_memberships (studio_id, student_id, program_id, status, started_at)
    VALUES (v_studio, v_beta, v_program, 'active', DATE '2026-05-01');
    INSERT INTO public.guardians (id, studio_id, first_name, last_name, email, relation, is_primary_contact)
    VALUES (v_guardian, v_studio, 'Primary', 'Guardian', 'guardian@example.invalid', 'Parent', true);
    INSERT INTO public.student_guardians (student_id, guardian_id)
    VALUES (v_alpha, v_guardian);
    INSERT INTO public.class_sessions (id, studio_id, name, date, start_time, end_time, status, capacity)
    VALUES (v_session, v_studio, 'Roster Attendance', DATE '2026-05-10', TIME '10:00', TIME '11:00', 'completed', 10);
    INSERT INTO public.attendance (studio_id, session_id, student_id, status, checked_in_at)
    VALUES (v_studio, v_session, v_alpha, 'present', TIMESTAMPTZ '2026-05-10 18:00:00+00');

    SELECT public.list_student_roster(
        v_studio, NULL, NULL, NULL, NULL, NULL, DATE '2026-05-20', 'name', 'asc', 1,
        NULL, NULL, NULL
    ) INTO v_page;
    IF v_page->>'total' <> '2'
       OR jsonb_array_length(v_page->'items') <> 1
       OR v_page->>'has_next' <> 'true' THEN
        RAISE EXCEPTION 'Roster first page metadata is incorrect: %', v_page;
    END IF;

    BEGIN
        PERFORM public.list_student_roster(
            v_studio, NULL, NULL, NULL, NULL, NULL, DATE '2026-05-20', 'name', 'asc', 1,
            NULL, NULL, 'unexpected-revision'
        );
        RAISE EXCEPTION 'Roster RPC accepted a revision without a cursor boundary.';
    EXCEPTION WHEN SQLSTATE '22023' THEN
        NULL;
    END;
    BEGIN
        PERFORM public.list_student_roster(
            v_studio, NULL, NULL, NULL, NULL, NULL, DATE '2026-05-20', 'name', 'asc', 1,
            NULL, v_alpha, 'revision'
        );
        RAISE EXCEPTION 'Roster RPC accepted an anchor without cursor direction.';
    EXCEPTION WHEN SQLSTATE '22023' THEN
        NULL;
    END;
    v_row := v_page->'items'->0;
    FOREACH v_plan IN ARRAY ARRAY['id','legal_first_name','legal_last_name','preferred_name','status','photo_path','photo_url','email','phone','tags','membership_start_date','guardian_email','notes','last_attendance_date','inactivity_days','reference_date','program_memberships'] LOOP
        IF NOT (v_row ? v_plan) THEN
            RAISE EXCEPTION 'Roster projection is missing key %: %', v_plan, v_row;
        END IF;
    END LOOP;
    IF v_row->>'id' <> v_alpha::TEXT
       OR v_row->>'guardian_email' <> 'guardian@example.invalid'
       OR v_row->>'last_attendance_date' <> '2026-05-10'
       OR v_row->>'inactivity_days' <> '10'
       OR jsonb_array_length(v_row->'program_memberships') <> 0 THEN
        RAISE EXCEPTION 'Roster quick-view projection or attendance formula is incorrect: %', v_row;
    END IF;
    IF v_row ? 'stripe_customer_id' THEN
        RAISE EXCEPTION 'Roster projection leaked an unused billing identifier.';
    END IF;
    v_next := v_page->'next_anchor';

    SELECT public.list_student_roster(
        v_studio, NULL, NULL, NULL, NULL, NULL, DATE '2026-05-20', 'name', 'asc', 1,
        'next', (v_next->>'id')::UUID, v_next->>'revision'
    ) INTO v_page;
    IF v_page->'items'->0->>'id' <> v_beta::TEXT
       OR v_page->>'has_previous' <> 'true'
       OR v_page->>'has_next' <> 'false' THEN
        RAISE EXCEPTION 'Roster next traversal is not stable: %', v_page;
    END IF;
    v_previous := v_page->'previous_anchor';
    SELECT public.list_student_roster(
        v_studio, NULL, NULL, NULL, NULL, NULL, DATE '2026-05-20', 'name', 'asc', 1,
        'previous', (v_previous->>'id')::UUID, v_previous->>'revision'
    ) INTO v_page;
    IF v_page->'items'->0->>'id' <> v_alpha::TEXT THEN
        RAISE EXCEPTION 'Roster previous traversal did not return the prior page: %', v_page;
    END IF;

    SELECT public.list_student_roster(
        v_studio, 'Advanced Roster Program', NULL, NULL, NULL, NULL, DATE '2026-05-20', 'name', 'asc', 50,
        NULL, NULL, NULL
    ) INTO v_page;
    IF v_page->>'total' <> '2' THEN
        RAISE EXCEPTION 'Program-name search did not include legacy and membership program names: %', v_page;
    END IF;
    SELECT public.list_student_roster(
        v_studio, NULL, NULL, v_program, NULL, NULL, DATE '2026-05-20', 'status', 'desc', 50,
        NULL, NULL, NULL
    ) INTO v_page;
    IF v_page->>'total' <> '2' THEN
        RAISE EXCEPTION 'Program filter did not include legacy and membership membership rows: %', v_page;
    END IF;
    SELECT public.list_student_roster(
        v_studio, NULL, NULL, NULL, 14, NULL, DATE '2026-05-20', 'membership_start_date', 'asc', 50,
        NULL, NULL, NULL
    ) INTO v_page;
    IF v_page->>'total' <> '1' OR v_page->'items'->0->>'id' <> v_beta::TEXT
       OR v_page->'items'->0->>'inactivity_days' <> '19' THEN
        RAISE EXCEPTION 'Inactivity formula/filter is incorrect: %', v_page;
    END IF;
    SELECT public.list_student_roster(
        v_studio, NULL, NULL, NULL, NULL, '30', DATE '2026-05-20', 'created_at', 'desc', 50,
        NULL, NULL, NULL
    ) INTO v_page;
    IF v_page->>'total' <> '1' OR v_page->'items'->0->>'id' <> v_beta::TEXT THEN
        RAISE EXCEPTION 'New-student date window is incorrect: %', v_page;
    END IF;

    SELECT public.list_student_roster(
        v_studio, 'definitely-no-roster-match', NULL, NULL, NULL, NULL, DATE '2026-05-20', 'name', 'asc', 50,
        NULL, NULL, NULL
    ) INTO v_page;
    IF v_page->>'total' <> '0' OR jsonb_array_length(v_page->'items') <> 0
       OR v_page->>'has_next' <> 'false' OR v_page->>'has_previous' <> 'false'
       OR jsonb_typeof(v_page->'next_anchor') <> 'null'
       OR jsonb_typeof(v_page->'previous_anchor') <> 'null' THEN
        RAISE EXCEPTION 'Empty roster page metadata is incorrect: %', v_page;
    END IF;

    UPDATE public.students SET legal_last_name = 'Renamed' WHERE id = v_alpha;
    SELECT public.list_student_roster(
        v_studio, NULL, NULL, NULL, NULL, NULL, DATE '2026-05-20', 'name', 'asc', 1,
        'next', (v_next->>'id')::UUID, v_next->>'revision'
    ) INTO v_page;
    IF v_page->'cursor_error'->>'code' <> 'stale_cursor' THEN
        RAISE EXCEPTION 'Changed cursor boundary was not rejected: %', v_page;
    END IF;

    -- Equal-primary fixtures exercise the complete name/id tie-breaker.  The
    -- null membership row also proves both explicit null policies while the
    -- other four rows share every non-name primary value.
    INSERT INTO public.students (
        id, studio_id, legal_first_name, legal_last_name, email, phone,
        status, membership_start_date, created_at, updated_at
    ) VALUES
        (v_equal_a, v_studio, 'Equal A', 'Boundary', 'equal-a@example.invalid', '555-0201', 'active', DATE '2026-02-01', TIMESTAMPTZ '2026-02-01', TIMESTAMPTZ '2026-02-01'),
        (v_equal_b, v_studio, 'Equal B', 'Boundary', 'equal-b@example.invalid', '555-0202', 'active', DATE '2026-02-01', TIMESTAMPTZ '2026-02-01', TIMESTAMPTZ '2026-02-01'),
        (v_equal_c, v_studio, 'Equal C', 'Boundary', 'equal-c@example.invalid', '555-0203', 'active', DATE '2026-02-01', TIMESTAMPTZ '2026-02-01', TIMESTAMPTZ '2026-02-01'),
        (v_equal_d, v_studio, 'Equal D', 'Boundary', 'equal-d@example.invalid', '555-0204', 'active', DATE '2026-02-01', TIMESTAMPTZ '2026-02-01', TIMESTAMPTZ '2026-02-01'),
        (v_null_membership, v_studio, 'Null Membership', 'Boundary', 'null@example.invalid', '555-0205', 'active', NULL, TIMESTAMPTZ '2026-02-01', TIMESTAMPTZ '2026-02-01');

    FOREACH v_sort_by IN ARRAY ARRAY['status', 'membership_start_date', 'created_at'] LOOP
        FOREACH v_sort_dir IN ARRAY ARRAY['asc', 'desc'] LOOP
            IF v_sort_by = 'status' AND v_sort_dir = 'asc' THEN
                SELECT array_agg(id ORDER BY status ASC, legal_last_name, legal_first_name, id) INTO v_expected
                FROM public.students WHERE studio_id = v_studio AND deleted_at IS NULL;
            ELSIF v_sort_by = 'status' THEN
                SELECT array_agg(id ORDER BY status DESC, legal_last_name, legal_first_name, id) INTO v_expected
                FROM public.students WHERE studio_id = v_studio AND deleted_at IS NULL;
            ELSIF v_sort_by = 'membership_start_date' AND v_sort_dir = 'asc' THEN
                SELECT array_agg(id ORDER BY membership_start_date ASC NULLS LAST, legal_last_name, legal_first_name, id) INTO v_expected
                FROM public.students WHERE studio_id = v_studio AND deleted_at IS NULL;
            ELSIF v_sort_by = 'membership_start_date' THEN
                SELECT array_agg(id ORDER BY membership_start_date DESC NULLS FIRST, legal_last_name, legal_first_name, id) INTO v_expected
                FROM public.students WHERE studio_id = v_studio AND deleted_at IS NULL;
            ELSIF v_sort_dir = 'asc' THEN
                SELECT array_agg(id ORDER BY created_at ASC NULLS LAST, legal_last_name, legal_first_name, id) INTO v_expected
                FROM public.students WHERE studio_id = v_studio AND deleted_at IS NULL;
            ELSE
                SELECT array_agg(id ORDER BY created_at DESC NULLS FIRST, legal_last_name, legal_first_name, id) INTO v_expected
                FROM public.students WHERE studio_id = v_studio AND deleted_at IS NULL;
            END IF;

            SELECT public.list_student_roster(v_studio, NULL, NULL, NULL, NULL, NULL, DATE '2026-05-20', v_sort_by, v_sort_dir, 3, NULL, NULL, NULL) INTO v_page;
            v_page_ids := ARRAY(SELECT (value->>'id')::UUID FROM jsonb_array_elements(v_page->'items') AS value);
            IF cardinality(v_page_ids) <> 3 OR v_page->>'has_previous' <> 'false' OR v_page->>'has_next' <> 'true' THEN
                RAISE EXCEPTION 'First %/% page shape/navigation is incorrect: %', v_sort_by, v_sort_dir, v_page;
            END IF;
            v_seen := v_page_ids;
            v_next := v_page->'next_anchor';

            SELECT public.list_student_roster(v_studio, NULL, NULL, NULL, NULL, NULL, DATE '2026-05-20', v_sort_by, v_sort_dir, 3, 'next', (v_next->>'id')::UUID, v_next->>'revision') INTO v_page;
            v_page_two := ARRAY(SELECT (value->>'id')::UUID FROM jsonb_array_elements(v_page->'items') AS value);
            IF cardinality(v_page_two) <> 3 OR v_page->>'has_previous' <> 'true' OR v_page->>'has_next' <> 'true'
               OR jsonb_typeof(v_page->'previous_anchor') <> 'object'
               OR jsonb_typeof(v_page->'next_anchor') <> 'object' THEN
                RAISE EXCEPTION 'Middle %/% page shape/navigation is incorrect: %', v_sort_by, v_sort_dir, v_page;
            END IF;
            v_seen := v_seen || v_page_two;

            v_previous := v_page->'previous_anchor';
            SELECT public.list_student_roster(v_studio, NULL, NULL, NULL, NULL, NULL, DATE '2026-05-20', v_sort_by, v_sort_dir, 3, 'previous', (v_previous->>'id')::UUID, v_previous->>'revision') INTO v_page;
            IF ARRAY(SELECT (value->>'id')::UUID FROM jsonb_array_elements(v_page->'items') AS value) <> v_page_ids
               OR v_page->>'has_next' <> 'true' OR jsonb_typeof(v_page->'next_anchor') <> 'object' THEN
                RAISE EXCEPTION 'Previous %/% did not restore page order/back navigation: %', v_sort_by, v_sort_dir, v_page;
            END IF;
            v_next := v_page->'next_anchor';
            SELECT public.list_student_roster(v_studio, NULL, NULL, NULL, NULL, NULL, DATE '2026-05-20', v_sort_by, v_sort_dir, 3, 'next', (v_next->>'id')::UUID, v_next->>'revision') INTO v_page;
            IF ARRAY(SELECT (value->>'id')::UUID FROM jsonb_array_elements(v_page->'items') AS value) <> v_page_two THEN
                RAISE EXCEPTION 'Next after previous %/% did not return the page just left: %', v_sort_by, v_sort_dir, v_page;
            END IF;

            v_next := v_page->'next_anchor';
            SELECT public.list_student_roster(v_studio, NULL, NULL, NULL, NULL, NULL, DATE '2026-05-20', v_sort_by, v_sort_dir, 3, 'next', (v_next->>'id')::UUID, v_next->>'revision') INTO v_page;
            v_page_three := ARRAY(SELECT (value->>'id')::UUID FROM jsonb_array_elements(v_page->'items') AS value);
            IF cardinality(v_page_three) <> 1 OR v_page->>'has_next' <> 'false' OR v_page->>'has_previous' <> 'true' THEN
                RAISE EXCEPTION 'Last %/% page shape/navigation is incorrect: %', v_sort_by, v_sort_dir, v_page;
            END IF;
            v_seen := v_seen || v_page_three;
            IF v_seen <> v_expected OR cardinality(v_seen) <> cardinality(v_expected) THEN
                RAISE EXCEPTION 'Keyset %/% skipped or repeated IDs. expected %, seen %', v_sort_by, v_sort_dir, v_expected, v_seen;
            END IF;
        END LOOP;
    END LOOP;

    -- A cursor cannot be reused after its boundary is deleted or its
    -- non-PII revision is changed, even when its UUID remains parseable.
    SELECT public.list_student_roster(v_studio, NULL, NULL, NULL, NULL, NULL, DATE '2026-05-20', 'name', 'asc', 2, NULL, NULL, NULL) INTO v_page;
    v_delete_cursor := v_page->'next_anchor';
    UPDATE public.students SET updated_at = updated_at + INTERVAL '1 second' WHERE id = (v_delete_cursor->>'id')::UUID;
    SELECT public.list_student_roster(v_studio, NULL, NULL, NULL, NULL, NULL, DATE '2026-05-20', 'name', 'asc', 2, 'next', (v_delete_cursor->>'id')::UUID, v_delete_cursor->>'revision') INTO v_page;
    IF v_page->'cursor_error'->>'code' <> 'stale_cursor' THEN
        RAISE EXCEPTION 'Revision-mismatched cursor was not rejected: %', v_page;
    END IF;
    DELETE FROM public.students WHERE id = (v_delete_cursor->>'id')::UUID;
    SELECT public.list_student_roster(v_studio, NULL, NULL, NULL, NULL, NULL, DATE '2026-05-20', 'name', 'asc', 2, 'next', (v_delete_cursor->>'id')::UUID, v_delete_cursor->>'revision') INTO v_page;
    IF v_page->'cursor_error'->>'code' <> 'stale_cursor' THEN
        RAISE EXCEPTION 'Deleted cursor boundary was not rejected: %', v_page;
    END IF;
    SELECT public.list_student_roster(v_other_studio, NULL, NULL, NULL, NULL, NULL, DATE '2026-05-20', 'name', 'asc', 2, 'next', (v_delete_cursor->>'id')::UUID, v_delete_cursor->>'revision') INTO v_page;
    IF v_page->'cursor_error'->>'code' <> 'stale_cursor' THEN
        RAISE EXCEPTION 'Cross-studio cursor boundary was not rejected: %', v_page;
    END IF;
    SELECT public.list_student_roster(v_studio, NULL, 'inactive', NULL, NULL, NULL, DATE '2026-05-20', 'name', 'asc', 2, 'next', (v_delete_cursor->>'id')::UUID, v_delete_cursor->>'revision') INTO v_page;
    IF v_page->'cursor_error'->>'code' <> 'stale_cursor' THEN
        RAISE EXCEPTION 'Filter-changed cursor boundary was not rejected: %', v_page;
    END IF;

    INSERT INTO public.students (id, studio_id, legal_first_name, legal_last_name, email, phone, status, membership_start_date, created_at, updated_at)
    VALUES (v_inserted, v_studio, 'Inserted', 'Before', 'inserted@example.invalid', '555-0210', 'active', DATE '2026-01-01', TIMESTAMPTZ '2026-01-01', TIMESTAMPTZ '2026-01-01');
    IF (SELECT count(*) FROM jsonb_array_elements((public.list_student_roster(v_studio, NULL, NULL, NULL, NULL, NULL, DATE '2026-05-20', 'name', 'asc', 50, NULL, NULL, NULL))->'items')) <> 7 THEN
        RAISE EXCEPTION 'Cross-tenant or deleted rows changed the scoped roster count.';
    END IF;

    IF (SELECT count(*) FROM public.students WHERE studio_id = v_studio AND deleted_at IS NULL) <> 7 THEN
        RAISE EXCEPTION 'Fixture unexpectedly changed tenant row count.';
    END IF;
    IF (SELECT count(*) FROM jsonb_array_elements((public.list_student_roster(v_studio, NULL, NULL, NULL, NULL, NULL, DATE '2026-05-20', 'name', 'asc', 50, NULL, NULL, NULL))->'items')) <> 7 THEN
        RAISE EXCEPTION 'Cross-tenant rows leaked into the roster.';
    END IF;

    -- An insert before an established boundary must not move the boundary or
    -- repeat a row already traversed.
    SELECT public.list_student_roster(v_studio, NULL, NULL, NULL, NULL, NULL, DATE '2026-05-20', 'name', 'asc', 3, NULL, NULL, NULL) INTO v_page;
    v_next := v_page->'next_anchor';
    SELECT public.list_student_roster(v_studio, NULL, NULL, NULL, NULL, NULL, DATE '2026-05-20', 'name', 'asc', 3, 'next', (v_next->>'id')::UUID, v_next->>'revision') INTO v_page;
    v_page_two := ARRAY(SELECT (value->>'id')::UUID FROM jsonb_array_elements(v_page->'items') AS value);
    INSERT INTO public.students (id, studio_id, legal_first_name, legal_last_name, email, phone, status, membership_start_date, created_at, updated_at)
    VALUES (v_inserted_before_cursor, v_studio, 'Aardvark', 'AAAA', 'inserted-before@example.invalid', '555-0211', 'active', DATE '2026-01-01', TIMESTAMPTZ '2026-01-01', TIMESTAMPTZ '2026-01-01');
    SELECT public.list_student_roster(v_studio, NULL, NULL, NULL, NULL, NULL, DATE '2026-05-20', 'name', 'asc', 3, 'next', (v_next->>'id')::UUID, v_next->>'revision') INTO v_page;
    IF ARRAY(SELECT (value->>'id')::UUID FROM jsonb_array_elements(v_page->'items') AS value) <> v_page_two THEN
        RAISE EXCEPTION 'Insert before cursor changed the established next page: %', v_page;
    END IF;
    DELETE FROM public.students WHERE id = v_inserted_before_cursor;

    -- Reuse the WS0 dashboard fixture's versioned medium/large student
    -- cardinalities (250/2,500) for SQL plan evidence.  This is a rollback-only
    -- roster extension of that fixture truth, not a second performance
    -- manifest.  All EXPLAIN output is emitted as notices and is not retained
    -- as a tracked report artifact.
    INSERT INTO public.studios (id, name, slug, owner_id)
    VALUES
        (v_medium_studio, 'Roster Medium Plan Studio', 'roster-medium-' || replace(v_medium_studio::TEXT, '-', ''), v_owner),
        (v_large_studio, 'Roster Large Plan Studio', 'roster-large-' || replace(v_large_studio::TEXT, '-', ''), v_owner);
    INSERT INTO public.programs (id, studio_id, name)
    VALUES
        (v_medium_program, v_medium_studio, 'Roster Medium Program'),
        (v_medium_alt_program, v_medium_studio, 'Roster Medium Alternate'),
        (v_large_program, v_large_studio, 'Roster Large Program'),
        (v_large_alt_program, v_large_studio, 'Roster Large Alternate');

    INSERT INTO public.students (
        studio_id, legal_first_name, legal_last_name, preferred_name, email, phone,
        status, membership_start_date, program_id, created_at, updated_at
    )
    SELECT
        v_medium_studio,
        CASE WHEN series_number = 1 THEN 'Needle' ELSE 'Fixture' END,
        'Student',
        CASE WHEN series_number = 1 THEN 'Needle Preferred' ELSE NULL END,
        'medium-' || series_number::TEXT || '@example.invalid',
        '555-03' || LPAD(series_number::TEXT, 3, '0'),
        CASE WHEN series_number = 1 THEN 'trialing' ELSE 'active' END,
        CASE WHEN series_number % 10 = 0 THEN NULL ELSE DATE '2026-01-01' + (series_number % 120) END,
        CASE WHEN series_number % 2 = 0 THEN v_medium_program ELSE NULL END,
        TIMESTAMPTZ '2026-01-01 00:00:00+00' + series_number * INTERVAL '1 minute',
        TIMESTAMPTZ '2026-01-01 00:00:00+00' + series_number * INTERVAL '1 minute'
    FROM generate_series(1, 250) AS series(series_number);
    INSERT INTO public.students (
        studio_id, legal_first_name, legal_last_name, preferred_name, email, phone,
        status, membership_start_date, program_id, notes, created_at, updated_at
    )
    SELECT
        v_large_studio,
        CASE WHEN series_number = 1 THEN 'Needle' ELSE 'Fixture' END,
        'Student',
        CASE WHEN series_number = 1 THEN 'Needle Preferred' ELSE NULL END,
        'large-' || series_number::TEXT || '@example.invalid',
        '555-04' || LPAD(series_number::TEXT, 4, '0'),
        CASE WHEN series_number = 1 THEN 'trialing' ELSE 'active' END,
        CASE WHEN series_number % 10 = 0 THEN NULL ELSE DATE '2026-01-01' + (series_number % 120) END,
        CASE WHEN series_number % 2 = 0 THEN v_large_program ELSE NULL END,
        -- Keep the WS0 large cardinality while retaining a realistic wide
        -- student heap.  The roster projection includes notes, so this makes
        -- the selective search plan account for the same row-width pressure
        -- without changing planner GUCs or removing competing indexes.
        repeat('Roster plan fixture note ', 64),
        TIMESTAMPTZ '2026-01-01 00:00:00+00' + series_number * INTERVAL '1 minute',
        TIMESTAMPTZ '2026-01-01 00:00:00+00' + series_number * INTERVAL '1 minute'
    FROM generate_series(1, 2500) AS series(series_number);

    INSERT INTO public.class_sessions (id, studio_id, name, date, start_time, end_time, status, capacity)
    VALUES
        (v_medium_session, v_medium_studio, 'Roster Medium History', DATE '2026-05-01', TIME '10:00', TIME '11:00', 'completed', 250),
        (v_large_session, v_large_studio, 'Roster Large History', DATE '2026-05-01', TIME '10:00', TIME '11:00', 'completed', 2500);
    INSERT INTO public.attendance (studio_id, session_id, student_id, status, checked_in_at)
    SELECT v_medium_studio, v_medium_session, student.id, 'present', TIMESTAMPTZ '2026-05-01 17:00:00+00'
    FROM public.students AS student
    WHERE student.studio_id = v_medium_studio
    ORDER BY student.created_at, student.id
    LIMIT 3;
    INSERT INTO public.attendance (studio_id, session_id, student_id, status, checked_in_at)
    SELECT v_large_studio, v_large_session, student.id, 'present', TIMESTAMPTZ '2026-05-01 17:00:00+00'
    FROM public.students AS student
    WHERE student.studio_id = v_large_studio
    ORDER BY student.created_at, student.id
    LIMIT 3;
    ANALYZE public.students;
    ANALYZE public.attendance;
    ANALYZE public.class_sessions;
    ANALYZE public.programs;

    -- Exercise the actual RPC on both distributions before inspecting the
    -- same filter families' plans.  Exact totals and bounded rows are checked
    -- for normal, deep, status, program, search, inactivity, and new-student
    -- requests; page projection itself remains owned by the RPC.
    SELECT public.list_student_roster(v_medium_studio, NULL, NULL, NULL, NULL, NULL, DATE '2026-05-20', 'name', 'asc', 50, NULL, NULL, NULL) INTO v_page;
    IF v_page->>'total' <> '250' OR jsonb_array_length(v_page->'items') <> 50 OR v_page->>'has_next' <> 'true' THEN
        RAISE EXCEPTION 'Medium normal roster page is not exact and bounded: %', v_page;
    END IF;
    v_next := v_page->'next_anchor';
    SELECT public.list_student_roster(v_medium_studio, NULL, NULL, NULL, NULL, NULL, DATE '2026-05-20', 'name', 'asc', 50, 'next', (v_next->>'id')::UUID, v_next->>'revision') INTO v_page;
    IF v_page->>'total' <> '250' OR jsonb_array_length(v_page->'items') <> 50 OR v_page->>'has_previous' <> 'true' THEN
        RAISE EXCEPTION 'Medium deep roster page is not exact and bounded: %', v_page;
    END IF;
    SELECT public.list_student_roster(v_large_studio, NULL, NULL, NULL, NULL, NULL, DATE '2026-05-20', 'created_at', 'desc', 50, NULL, NULL, NULL) INTO v_page;
    IF v_page->>'total' <> '2500' OR jsonb_array_length(v_page->'items') <> 50 OR v_page->>'has_next' <> 'true' THEN
        RAISE EXCEPTION 'Large normal roster page is not exact and bounded: %', v_page;
    END IF;
    SELECT public.list_student_roster(v_medium_studio, 'Needle', NULL, NULL, NULL, NULL, DATE '2026-05-20', 'name', 'asc', 50, NULL, NULL, NULL) INTO v_page;
    IF v_page->>'total' <> '1' OR jsonb_array_length(v_page->'items') <> 1 THEN
        RAISE EXCEPTION 'Selective roster search changed meaning: %', v_page;
    END IF;
    SELECT public.list_student_roster(v_large_studio, 'Student', NULL, NULL, NULL, NULL, DATE '2026-05-20', 'name', 'asc', 50, NULL, NULL, NULL) INTO v_page;
    IF v_page->>'total' <> '2500' OR jsonb_array_length(v_page->'items') <> 50 THEN
        RAISE EXCEPTION 'Nonselective roster search changed meaning: %', v_page;
    END IF;
    SELECT public.list_student_roster(v_medium_studio, NULL, 'trialing', NULL, NULL, NULL, DATE '2026-05-20', 'status', 'asc', 50, NULL, NULL, NULL) INTO v_page;
    IF v_page->>'total' <> '1' OR jsonb_array_length(v_page->'items') <> 1 THEN
        RAISE EXCEPTION 'Selective status roster filter changed meaning: %', v_page;
    END IF;
    SELECT public.list_student_roster(v_large_studio, NULL, 'active', v_large_program, NULL, NULL, DATE '2026-05-20', 'membership_start_date', 'asc', 50, NULL, NULL, NULL) INTO v_page;
    IF v_page->>'total' <> '1250' OR jsonb_array_length(v_page->'items') <> 50 THEN
        RAISE EXCEPTION 'Large program roster filter changed meaning: %', v_page;
    END IF;
    SELECT public.list_student_roster(v_medium_studio, NULL, NULL, NULL, 14, NULL, DATE '2026-05-20', 'name', 'asc', 50, NULL, NULL, NULL) INTO v_page;
    IF v_page->>'total' <= '0' OR jsonb_array_length(v_page->'items') <> 50 THEN
        RAISE EXCEPTION 'Medium inactivity roster filter is not bounded: %', v_page;
    END IF;
    SELECT public.list_student_roster(v_large_studio, NULL, NULL, NULL, NULL, '30', DATE '2026-05-20', 'created_at', 'desc', 50, NULL, NULL, NULL) INTO v_page;
    IF v_page->>'total' <= '0' OR jsonb_array_length(v_page->'items') <> 50 THEN
        RAISE EXCEPTION 'Large new-student roster filter is not bounded: %', v_page;
    END IF;

    -- Measure the full production RPC as well as the explanatory query-family
    -- excerpts below. Navigate 1,000 real rows to obtain query-bound anchors.
    v_page := public.list_student_roster(v_large_studio, NULL, NULL, NULL, NULL, NULL, DATE '2026-05-20', 'name', 'asc', 50, NULL, NULL, NULL);
    FOR v_deep_index IN 1..20 LOOP
        v_deep_next := v_page->'next_anchor';
        v_page := public.list_student_roster(v_large_studio, NULL, NULL, NULL, NULL, NULL, DATE '2026-05-20', 'name', 'asc', 50, 'next', (v_deep_next->>'id')::UUID, v_deep_next->>'revision');
        IF jsonb_array_length(v_page->'items') <> 50 OR v_page->>'total' <> '2500' THEN
            RAISE EXCEPTION 'Deep roster page lost bounded rows or total.';
        END IF;
    END LOOP;
    v_deep_next := v_page->'next_anchor';
    v_deep_previous := v_page->'previous_anchor';
    FOREACH v_rpc_family IN ARRAY ARRAY['first', 'deep-next', 'deep-previous', 'created-sort', 'status-sort', 'search-selective', 'search-common', 'program', 'inactivity'] LOOP
        EXECUTE 'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT public.list_student_roster($1,$2,$3,$4,$5,NULL,DATE ''2026-05-20'',$6,$7,50,$8,$9,$10)'
        INTO v_rpc_plan
        USING v_large_studio,
            CASE v_rpc_family WHEN 'search-selective' THEN 'Needle' WHEN 'search-common' THEN 'Student' ELSE NULL END,
            CASE v_rpc_family WHEN 'status-sort' THEN 'active' ELSE NULL END,
            CASE v_rpc_family WHEN 'program' THEN v_large_program ELSE NULL END,
            CASE v_rpc_family WHEN 'inactivity' THEN 14 ELSE NULL END,
            CASE v_rpc_family WHEN 'created-sort' THEN 'created_at' WHEN 'status-sort' THEN 'status' ELSE 'name' END,
            CASE v_rpc_family WHEN 'created-sort' THEN 'desc' ELSE 'asc' END,
            CASE v_rpc_family WHEN 'deep-next' THEN 'next' WHEN 'deep-previous' THEN 'previous' ELSE NULL END,
            CASE v_rpc_family WHEN 'deep-next' THEN (v_deep_next->>'id')::UUID WHEN 'deep-previous' THEN (v_deep_previous->>'id')::UUID ELSE NULL END,
            CASE v_rpc_family WHEN 'deep-next' THEN v_deep_next->>'revision' WHEN 'deep-previous' THEN v_deep_previous->>'revision' ELSE NULL END;
        IF v_rpc_plan->0->>'Execution Time' IS NULL THEN
            RAISE EXCEPTION 'Full roster RPC plan did not execute.';
        END IF;
        RAISE NOTICE 'roster_rpc_plan profile=large students=2500 family=% planning_ms=% execution_ms=% shared_hit_blocks=% shared_read_blocks=%',
            v_rpc_family, v_rpc_plan->0->>'Planning Time', v_rpc_plan->0->>'Execution Time',
            v_rpc_plan->0->'Plan'->>'Shared Hit Blocks', v_rpc_plan->0->'Plan'->>'Shared Read Blocks';
    END LOOP;

    FOREACH v_plan_studio IN ARRAY ARRAY[v_medium_studio, v_large_studio] LOOP
        IF v_plan_studio = v_medium_studio THEN
            v_plan_profile := 'medium';
            v_plan_program := v_medium_program;
        ELSE
            v_plan_profile := 'large';
            v_plan_program := v_large_program;
        END IF;
        RAISE NOTICE 'roster-plan fixture profile=% students=% source=student-roster-rpc-contract', v_plan_profile,
            CASE WHEN v_plan_profile = 'medium' THEN 250 ELSE 2500 END;

        -- First and deep name keyset pages use the installed name index and
        -- expose the same stable primary/last/first/id boundary as the RPC.
        v_plan_text := '';
        FOR v_plan IN EXECUTE 'EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) SELECT student.id FROM public.students AS student WHERE student.studio_id = $1 AND student.deleted_at IS NULL ORDER BY student.legal_last_name, student.legal_first_name, student.id LIMIT 51' USING v_plan_studio LOOP
            v_plan_text := v_plan_text || E'\n' || v_plan;
            RAISE NOTICE 'roster-plan profile=% family=name-first: %', v_plan_profile, v_plan;
        END LOOP;
        IF v_plan_text NOT LIKE '%Planning Time:%' OR v_plan_text NOT LIKE '%Execution Time:%' THEN
            RAISE EXCEPTION 'Normal first page plan omitted plan timings for %: %', v_plan_profile, v_plan_text;
        END IF;

        v_plan_text := '';
        FOR v_plan IN EXECUTE 'EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) SELECT student.id FROM public.students AS student WHERE student.studio_id = $1 AND student.deleted_at IS NULL AND (student.legal_last_name, student.legal_first_name, student.id) > (''Student'', ''Fixture'', ''00000000-0000-0000-0000-000000000000''::UUID) ORDER BY student.legal_last_name, student.legal_first_name, student.id LIMIT 51' USING v_plan_studio LOOP
            v_plan_text := v_plan_text || E'\n' || v_plan;
            RAISE NOTICE 'roster-plan profile=% family=name-deep: %', v_plan_profile, v_plan;
        END LOOP;
        IF v_plan_text NOT LIKE '%Planning Time:%' OR v_plan_text NOT LIKE '%Execution Time:%' THEN
            RAISE EXCEPTION 'Normal deep page plan omitted plan timings for %: %', v_plan_profile, v_plan_text;
        END IF;

        -- Every non-name sort family is represented in both selective and
        -- broad distributions without suppressing any planner access path.
        FOR v_plan IN EXECUTE 'EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) SELECT student.id FROM public.students AS student WHERE student.studio_id = $1 AND student.status = ''trialing'' AND student.deleted_at IS NULL ORDER BY student.status, student.legal_last_name, student.legal_first_name, student.id LIMIT 51' USING v_plan_studio LOOP
            RAISE NOTICE 'roster-plan profile=% family=status-selective: %', v_plan_profile, v_plan;
        END LOOP;
        FOR v_plan IN EXECUTE 'EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) SELECT student.id FROM public.students AS student WHERE student.studio_id = $1 AND student.status = ''active'' AND student.deleted_at IS NULL ORDER BY student.status, student.legal_last_name, student.legal_first_name, student.id LIMIT 51' USING v_plan_studio LOOP
            RAISE NOTICE 'roster-plan profile=% family=status-nonselective: %', v_plan_profile, v_plan;
        END LOOP;
        FOR v_plan IN EXECUTE 'EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) SELECT student.id FROM public.students AS student WHERE student.studio_id = $1 AND student.deleted_at IS NULL ORDER BY student.membership_start_date ASC NULLS LAST, student.legal_last_name, student.legal_first_name, student.id LIMIT 51' USING v_plan_studio LOOP
            RAISE NOTICE 'roster-plan profile=% family=membership-start-first: %', v_plan_profile, v_plan;
        END LOOP;
        FOR v_plan IN EXECUTE 'EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) SELECT student.id FROM public.students AS student WHERE student.studio_id = $1 AND student.deleted_at IS NULL ORDER BY student.membership_start_date DESC NULLS FIRST, student.legal_last_name, student.legal_first_name, student.id LIMIT 51' USING v_plan_studio LOOP
            RAISE NOTICE 'roster-plan profile=% family=membership-start-deep: %', v_plan_profile, v_plan;
        END LOOP;
        FOR v_plan IN EXECUTE 'EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) SELECT student.id FROM public.students AS student WHERE student.studio_id = $1 AND student.deleted_at IS NULL ORDER BY student.created_at ASC NULLS LAST, student.legal_last_name, student.legal_first_name, student.id LIMIT 51' USING v_plan_studio LOOP
            RAISE NOTICE 'roster-plan profile=% family=created-first: %', v_plan_profile, v_plan;
        END LOOP;
        FOR v_plan IN EXECUTE 'EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) SELECT student.id FROM public.students AS student WHERE student.studio_id = $1 AND student.deleted_at IS NULL ORDER BY student.created_at DESC NULLS FIRST, student.legal_last_name, student.legal_first_name, student.id LIMIT 51' USING v_plan_studio LOOP
            RAISE NOTICE 'roster-plan profile=% family=created-deep: %', v_plan_profile, v_plan;
        END LOOP;
        FOR v_plan IN EXECUTE 'EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) SELECT student.id FROM public.students AS student WHERE student.studio_id = $1 AND student.deleted_at IS NULL AND (student.program_id = $2 OR EXISTS (SELECT 1 FROM public.student_program_memberships AS membership WHERE membership.studio_id = $1 AND membership.student_id = student.id AND membership.program_id = $2 AND membership.status IN (''active'', ''paused'') AND membership.ended_at IS NULL)) ORDER BY student.legal_last_name, student.legal_first_name, student.id LIMIT 51' USING v_plan_studio, v_plan_program LOOP
            RAISE NOTICE 'roster-plan profile=% family=program-selective: %', v_plan_profile, v_plan;
        END LOOP;
        FOR v_plan IN EXECUTE 'EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) SELECT student.id FROM public.students AS student WHERE student.studio_id = $1 AND student.deleted_at IS NULL AND student.status IN (''active'', ''trialing'', ''paused'') AND COALESCE(student.membership_start_date, (student.created_at AT TIME ZONE ''UTC'')::DATE) BETWEEN DATE ''2026-04-20'' AND DATE ''2026-05-20'' ORDER BY student.created_at DESC NULLS FIRST, student.legal_last_name, student.legal_first_name, student.id LIMIT 51' USING v_plan_studio LOOP
            RAISE NOTICE 'roster-plan profile=% family=new-student-selective: %', v_plan_profile, v_plan;
        END LOOP;

        -- Both search plans are deliberately left to the planner.  On the
        -- WS0-sized medium/large fixtures a sequential scan can be cheaper
        -- even for a one-row result, while the installed trigram index remains
        -- available to larger real-world heaps.  The proof is the actual
        -- uncoerced scan, row counts, buffers, and timings emitted below.
        v_plan_text := '';
        FOR v_plan IN EXECUTE 'EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) SELECT student.id FROM public.students AS student WHERE student.studio_id = $1 AND student.deleted_at IS NULL AND LOWER(COALESCE(student.legal_first_name, '''') || '' '' || COALESCE(student.legal_last_name, '''') || '' '' || COALESCE(student.preferred_name, '''') || '' '' || COALESCE(student.email, '''') || '' '' || COALESCE(student.phone, '''')) LIKE ''%needle%'' ORDER BY student.legal_last_name, student.legal_first_name, student.id LIMIT 51' USING v_plan_studio LOOP
            v_plan_text := v_plan_text || E'\n' || v_plan;
            RAISE NOTICE 'roster-plan profile=% family=search-selective: %', v_plan_profile, v_plan;
        END LOOP;
        IF v_plan_text NOT LIKE '%Planning Time:%' OR v_plan_text NOT LIKE '%Execution Time:%' THEN
            RAISE EXCEPTION 'Selective search plan omitted plan timings for %: %', v_plan_profile, v_plan_text;
        END IF;
        v_plan_text := '';
        FOR v_plan IN EXECUTE 'EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) SELECT student.id FROM public.students AS student WHERE student.studio_id = $1 AND student.deleted_at IS NULL AND LOWER(COALESCE(student.legal_first_name, '''') || '' '' || COALESCE(student.legal_last_name, '''') || '' '' || COALESCE(student.preferred_name, '''') || '' '' || COALESCE(student.email, '''') || '' '' || COALESCE(student.phone, '''')) LIKE ''%student%'' ORDER BY student.legal_last_name, student.legal_first_name, student.id LIMIT 51' USING v_plan_studio LOOP
            v_plan_text := v_plan_text || E'\n' || v_plan;
            RAISE NOTICE 'roster-plan profile=% family=search-nonselective: %', v_plan_profile, v_plan;
        END LOOP;
        IF v_plan_text NOT LIKE '%Planning Time:%' OR v_plan_text NOT LIKE '%Execution Time:%' THEN
            RAISE EXCEPTION 'Nonselective search plan omitted plan timings for %: %', v_plan_profile, v_plan_text;
        END IF;

        -- The inactivity plan is one grouped attendance aggregate.  It may
        -- choose a hash or indexed scan naturally, but must not devolve to an
        -- attendance-history probe with one execution per candidate student.
        v_plan_text := '';
        FOR v_plan IN EXECUTE 'EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) WITH roster_candidates AS MATERIALIZED (SELECT student.id FROM public.students AS student WHERE student.studio_id = $1 AND student.deleted_at IS NULL), attendance_by_student AS MATERIALIZED (SELECT attendance.student_id, MAX(COALESCE(class_session.date, (attendance.checked_in_at AT TIME ZONE ''UTC'')::DATE)) AS last_attendance_date FROM public.attendance AS attendance JOIN roster_candidates AS candidate ON candidate.id = attendance.student_id LEFT JOIN public.class_sessions AS class_session ON class_session.id = attendance.session_id AND class_session.studio_id = $1 WHERE attendance.studio_id = $1 AND attendance.status <> ''absent'' GROUP BY attendance.student_id) SELECT attendance_by_student.student_id FROM attendance_by_student JOIN roster_candidates AS candidate ON candidate.id = attendance_by_student.student_id' USING v_plan_studio LOOP
            v_plan_text := v_plan_text || E'\n' || v_plan;
            RAISE NOTICE 'roster-plan profile=% family=inactivity-grouped: %', v_plan_profile, v_plan;
        END LOOP;
        IF v_plan_text ~* 'loops=(250|2500)([^0-9]|$)' THEN
            RAISE EXCEPTION 'Inactivity plan performed candidate-count loops for %: %', v_plan_profile, v_plan_text;
        END IF;

        -- Page attendance enrichment is intentionally limited to the 50-row
        -- page; the p_page_size+1 sentinel is not present in this CTE.
        v_plan_text := '';
        FOR v_plan IN EXECUTE 'EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) WITH page_rows AS MATERIALIZED (SELECT student.id FROM public.students AS student WHERE student.studio_id = $1 AND student.deleted_at IS NULL ORDER BY student.legal_last_name, student.legal_first_name, student.id LIMIT 50), page_attendance AS MATERIALIZED (SELECT attendance.student_id, MAX(COALESCE(class_session.date, (attendance.checked_in_at AT TIME ZONE ''UTC'')::DATE)) AS last_attendance_date FROM public.attendance AS attendance JOIN page_rows ON page_rows.id = attendance.student_id LEFT JOIN public.class_sessions AS class_session ON class_session.id = attendance.session_id AND class_session.studio_id = $1 WHERE attendance.studio_id = $1 AND attendance.status <> ''absent'' GROUP BY attendance.student_id) SELECT page_attendance.student_id FROM page_attendance' USING v_plan_studio LOOP
            v_plan_text := v_plan_text || E'\n' || v_plan;
            RAISE NOTICE 'roster-plan profile=% family=page-attendance-bounded: %', v_plan_profile, v_plan;
        END LOOP;
        IF v_plan_text ~* 'loops=(250|2500)([^0-9]|$)' THEN
            RAISE EXCEPTION 'Page attendance enrichment exceeded page bounds for %: %', v_plan_profile, v_plan_text;
        END IF;
    END LOOP;
END;
$$;

ROLLBACK;
