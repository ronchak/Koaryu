BEGIN;

DO $$
DECLARE
    v_actor UUID := gen_random_uuid();
    v_studio UUID := gen_random_uuid();
    v_other_studio UUID := gen_random_uuid();
    v_active UUID := gen_random_uuid();
    v_deleted UUID := gen_random_uuid();
    v_other UUID := gen_random_uuid();
    v_failure UUID := gen_random_uuid();
    v_unknown UUID := gen_random_uuid();
    v_instructor UUID := gen_random_uuid();
    v_front_desk UUID := gen_random_uuid();
    v_front_desk_student UUID := gen_random_uuid();
    v_updated INTEGER;
    v_audits INTEGER;
    v_function_definition TEXT;
    v_is_security_definer BOOLEAN;
    v_search_path TEXT[];
BEGIN
    IF to_regprocedure('public.archive_students_bulk_atomic(uuid,uuid,uuid[])') IS NULL THEN
        RAISE EXCEPTION 'Missing public.archive_students_bulk_atomic(uuid,uuid,uuid[]).';
    END IF;

    IF has_function_privilege('service_role', 'public.archive_students_bulk_atomic(uuid,uuid,uuid[])', 'EXECUTE') IS DISTINCT FROM TRUE
       OR has_function_privilege('anon', 'public.archive_students_bulk_atomic(uuid,uuid,uuid[])', 'EXECUTE') IS DISTINCT FROM FALSE
       OR has_function_privilege('authenticated', 'public.archive_students_bulk_atomic(uuid,uuid,uuid[])', 'EXECUTE') IS DISTINCT FROM FALSE
       OR has_function_privilege('public', 'public.archive_students_bulk_atomic(uuid,uuid,uuid[])', 'EXECUTE') IS DISTINCT FROM FALSE THEN
        RAISE EXCEPTION 'Bulk archive RPC ACL is not service_role-only.';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_class
        WHERE oid = 'public.students'::regclass AND relrowsecurity
    ) THEN
        RAISE EXCEPTION 'Student RLS is not enabled.';
    END IF;

    SELECT pg_get_functiondef(oid)
    INTO v_function_definition
    FROM pg_proc
    WHERE oid = to_regprocedure('public.archive_students_bulk_atomic(uuid,uuid,uuid[])');
    IF v_function_definition NOT LIKE '%ORDER BY student.id%FOR UPDATE%' THEN
        RAISE EXCEPTION 'Bulk archive RPC does not prove stable UUID lock ordering.';
    END IF;
    SELECT prosecdef, proconfig
    INTO v_is_security_definer, v_search_path
    FROM pg_proc
    WHERE oid = to_regprocedure('public.archive_students_bulk_atomic(uuid,uuid,uuid[])');
    IF v_is_security_definer OR NOT ('search_path=pg_catalog, public' = ANY(COALESCE(v_search_path, ARRAY[]::TEXT[]))) THEN
        RAISE EXCEPTION 'Bulk archive RPC security contract changed.';
    END IF;

    INSERT INTO auth.users (
        id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
    ) VALUES (
        v_actor, 'authenticated', 'authenticated',
        'bulk-archive-' || replace(v_actor::TEXT, '-', '') || '@example.invalid',
        '{}'::JSONB, '{}'::JSONB, now(), now()
    );
    INSERT INTO auth.users (
        id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
    ) VALUES (
        v_front_desk, 'authenticated', 'authenticated',
        'bulk-archive-front-desk-' || replace(v_front_desk::TEXT, '-', '') || '@example.invalid',
        '{}'::JSONB, '{}'::JSONB, now(), now()
    );
    INSERT INTO auth.users (
        id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
    ) VALUES (
        v_instructor, 'authenticated', 'authenticated',
        'bulk-archive-instructor-' || replace(v_instructor::TEXT, '-', '') || '@example.invalid',
        '{}'::JSONB, '{}'::JSONB, now(), now()
    );
    INSERT INTO public.studios (id, name, slug, owner_id)
    VALUES
        (v_studio, 'Bulk Archive Smoke', 'bulk-archive-' || replace(v_studio::TEXT, '-', ''), v_actor),
        (v_other_studio, 'Other Bulk Archive Smoke', 'bulk-archive-other-' || replace(v_other_studio::TEXT, '-', ''), v_actor);
    INSERT INTO public.staff_roles (studio_id, user_id, role)
    VALUES (v_studio, v_actor, 'admin');
    INSERT INTO public.staff_roles (studio_id, user_id, role)
    VALUES (v_studio, v_instructor, 'instructor');
    INSERT INTO public.staff_roles (studio_id, user_id, role)
    VALUES (v_studio, v_front_desk, 'front_desk');
    INSERT INTO public.students (
        id, studio_id, legal_first_name, legal_last_name, status, deleted_at
    ) VALUES
        (v_active, v_studio, 'Active', 'Archive', 'active', NULL),
        (v_deleted, v_studio, 'Already', 'Archived', 'active', now() - interval '1 day'),
        (v_failure, v_studio, 'Audit', 'Failure', 'active', NULL),
        (v_front_desk_student, v_studio, 'Front', 'Desk', 'active', NULL),
        (v_other, v_other_studio, 'Other', 'Tenant', 'active', NULL);

    BEGIN
        PERFORM public.archive_students_bulk_atomic(v_studio, NULL, ARRAY[v_active]::UUID[]);
        RAISE EXCEPTION 'NULL actor attribution unexpectedly succeeded.';
    EXCEPTION WHEN SQLSTATE '42501' THEN
        NULL;
    END;
    BEGIN
        PERFORM public.archive_students_bulk_atomic(v_studio, v_actor, NULL::UUID[]);
        RAISE EXCEPTION 'NULL raw id array unexpectedly succeeded.';
    EXCEPTION WHEN SQLSTATE '22023' THEN
        NULL;
    END;
    BEGIN
        PERFORM public.archive_students_bulk_atomic(v_studio, v_actor, ARRAY[NULL::UUID]);
        RAISE EXCEPTION 'NULL raw id element unexpectedly succeeded.';
    EXCEPTION WHEN SQLSTATE '22023' THEN
        NULL;
    END;

    -- Mixed active/already-deleted inputs succeed, deduplicate, and audit only
    -- the one newly archived row.
    SELECT public.archive_students_bulk_atomic(
        v_studio, v_actor, ARRAY[v_deleted, v_active, v_active]::UUID[]
    ) INTO v_updated;
    IF v_updated <> 1 THEN
        RAISE EXCEPTION 'Expected one newly archived student, got %.', v_updated;
    END IF;
    SELECT count(*) INTO v_audits
    FROM public.audit_logs
    WHERE studio_id = v_studio
      AND actor_id = v_actor
      AND action = 'student.deleted'
      AND entity_type = 'student'
      AND entity_id = v_active;
    IF v_audits <> 1 THEN
        RAISE EXCEPTION 'Expected exactly one current archive audit, got %.', v_audits;
    END IF;

    SELECT public.archive_students_bulk_atomic(v_studio, v_front_desk, ARRAY[v_front_desk_student]::UUID[])
    INTO v_updated;
    IF v_updated <> 1
       OR (SELECT deleted_at FROM public.students WHERE id = v_front_desk_student) IS NULL THEN
        RAISE EXCEPTION 'Front-desk roster manager archive was not accepted.';
    END IF;

    BEGIN
        PERFORM public.archive_students_bulk_atomic(
            v_studio, v_instructor, ARRAY[v_active]::UUID[]
        );
        RAISE EXCEPTION 'Instructor archive unexpectedly succeeded.';
    EXCEPTION WHEN SQLSTATE '42501' THEN
        NULL;
    END;

    BEGIN
        PERFORM public.archive_students_bulk_atomic(
            v_studio, v_actor, array_fill(v_active, ARRAY[201])
        );
        RAISE EXCEPTION 'Raw input above 200 unexpectedly succeeded.';
    EXCEPTION WHEN SQLSTATE '22023' THEN
        NULL;
    END;

    -- Exact retry and reversed input order converge without a second audit.
    SELECT public.archive_students_bulk_atomic(
        v_studio, v_actor, ARRAY[v_active, v_deleted, v_active]::UUID[]
    ) INTO v_updated;
    IF v_updated <> 0 THEN
        RAISE EXCEPTION 'Exact retry returned updated=% instead of zero.', v_updated;
    END IF;
    SELECT count(*) INTO v_audits
    FROM public.audit_logs
    WHERE studio_id = v_studio AND action = 'student.deleted'
      AND entity_type = 'student' AND entity_id IN (v_active, v_deleted);
    IF v_audits <> 1 THEN
        RAISE EXCEPTION 'Retry created a duplicate audit row.';
    END IF;

    -- Unknown and cross-tenant ids fail before any update or audit.
    BEGIN
        PERFORM public.archive_students_bulk_atomic(
            v_studio, v_actor, ARRAY[v_other, v_unknown]::UUID[]
        );
        RAISE EXCEPTION 'Unknown/cross-tenant request unexpectedly succeeded.';
    EXCEPTION WHEN SQLSTATE 'P0002' THEN
        NULL;
    END;
    IF (SELECT deleted_at FROM public.students WHERE id = v_other) IS NOT NULL
       OR (SELECT count(*) FROM public.audit_logs WHERE studio_id = v_studio AND entity_id = v_other) <> 0 THEN
        RAISE EXCEPTION 'Cross-tenant request partially changed state.';
    END IF;

    -- An audit failure rolls the update back with the same transaction.
    CREATE OR REPLACE FUNCTION pg_temp.fail_bulk_archive_audit()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $fail_bulk_archive_audit$
    BEGIN
        IF NEW.action = 'student.deleted' THEN
            RAISE EXCEPTION 'forced bulk archive audit failure' USING ERRCODE = 'P0001';
        END IF;
        RETURN NEW;
    END;
    $fail_bulk_archive_audit$;
    CREATE TRIGGER fail_bulk_archive_audit
    BEFORE INSERT ON public.audit_logs
    FOR EACH ROW EXECUTE FUNCTION pg_temp.fail_bulk_archive_audit();
    BEGIN
        PERFORM public.archive_students_bulk_atomic(v_studio, v_actor, ARRAY[v_failure]::UUID[]);
        RAISE EXCEPTION 'Audit failure test unexpectedly succeeded.';
    EXCEPTION WHEN SQLSTATE 'P0001' THEN
        NULL;
    END;
    DROP TRIGGER fail_bulk_archive_audit ON public.audit_logs;
    IF (SELECT deleted_at FROM public.students WHERE id = v_failure) IS NOT NULL THEN
        RAISE EXCEPTION 'Audit failure did not roll back student archive.';
    END IF;
END;
$$;

ROLLBACK;
