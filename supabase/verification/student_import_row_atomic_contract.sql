BEGIN;

DO $$
DECLARE
    v_import_rpc REGPROCEDURE := 'public.import_student_row_atomic(jsonb,uuid,uuid,text,integer,text,text,text,text,uuid[])'::REGPROCEDURE;
    v_uuid_helper REGPROCEDURE := 'private.deterministic_import_uuid(uuid,text)'::REGPROCEDURE;
    v_owner_a UUID := gen_random_uuid();
    v_owner_b UUID := gen_random_uuid();
    v_studio_a UUID := gen_random_uuid();
    v_studio_b UUID := gen_random_uuid();
    v_program_a UUID := gen_random_uuid();
    v_program_b UUID := gen_random_uuid();
    v_import_run_b UUID := gen_random_uuid();
    v_conflicting_student UUID := gen_random_uuid();
    v_new_student UUID := gen_random_uuid();
    v_conflicting_guardian UUID;
    v_count INTEGER;
BEGIN
    IF v_import_rpc IS NULL THEN
        RAISE EXCEPTION 'Expected public.import_student_row_atomic RPC to exist.';
    END IF;

    IF v_uuid_helper IS NULL THEN
        RAISE EXCEPTION 'Expected private.deterministic_import_uuid helper to exist.';
    END IF;

    IF private.deterministic_import_uuid(
        '6ba7b810-9dad-11d1-80b4-00c04fd430c8'::UUID,
        'python.org'
    ) <> '886313e1-3b8a-5372-9b90-0c9aee199e5d'::UUID THEN
        RAISE EXCEPTION 'private.deterministic_import_uuid does not match UUIDv5 output.';
    END IF;

    IF has_function_privilege('anon', v_import_rpc, 'EXECUTE')
       OR has_function_privilege('authenticated', v_import_rpc, 'EXECUTE') THEN
        RAISE EXCEPTION 'Browser-facing roles must not execute public.import_student_row_atomic.';
    END IF;

    IF NOT has_function_privilege('service_role', v_import_rpc, 'EXECUTE') THEN
        RAISE EXCEPTION 'service_role must execute public.import_student_row_atomic.';
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
            v_owner_a,
            'authenticated',
            'authenticated',
            'koaryu-import-owner-a-' || replace(v_owner_a::TEXT, '-', '') || '@example.invalid',
            '{}'::jsonb,
            '{}'::jsonb,
            now(),
            now()
        ),
        (
            v_owner_b,
            'authenticated',
            'authenticated',
            'koaryu-import-owner-b-' || replace(v_owner_b::TEXT, '-', '') || '@example.invalid',
            '{}'::jsonb,
            '{}'::jsonb,
            now(),
            now()
        );

    INSERT INTO public.studios (id, name, slug, owner_id)
    VALUES
        (v_studio_a, 'Koaryu Import Tenant A', 'koaryu-import-a-' || replace(v_studio_a::TEXT, '-', ''), v_owner_a),
        (v_studio_b, 'Koaryu Import Tenant B', 'koaryu-import-b-' || replace(v_studio_b::TEXT, '-', ''), v_owner_b);

    INSERT INTO public.programs (id, studio_id, name, sort_order)
    VALUES
        (v_program_a, v_studio_a, 'Tenant A Import Program', 0),
        (v_program_b, v_studio_b, 'Tenant B Import Program', 0);

    INSERT INTO public.student_import_runs (
        id,
        studio_id,
        actor_id,
        operation,
        idempotency_key,
        request_hash,
        status,
        processing_token,
        processing_started_at
    )
    VALUES (
        v_import_run_b,
        v_studio_b,
        v_owner_b,
        'students_csv_execute',
        'tenant-b-import',
        'tenant-b-import-hash',
        'processing',
        'tenant-b-token',
        now()
    );

    INSERT INTO public.students (
        id,
        studio_id,
        legal_first_name,
        legal_last_name,
        status,
        program_id,
        tags
    )
    VALUES (
        v_conflicting_student,
        v_studio_a,
        'Existing',
        'Student',
        'active',
        v_program_a,
        ARRAY[]::TEXT[]
    );

    BEGIN
        PERFORM 1
          FROM public.import_student_row_atomic(
              jsonb_build_object(
                  'id', v_conflicting_student,
                  'studio_id', v_studio_b,
                  'legal_first_name', 'Tenant',
                  'legal_last_name', 'Collision',
                  'status', 'active',
                  'tags', '[]'::JSONB
              ),
              v_studio_b,
              v_import_run_b,
              'tenant-b-token',
              1,
              NULL,
              NULL,
              NULL,
              NULL,
              ARRAY[v_program_b]
          );
        RAISE EXCEPTION 'Expected cross-studio student import ID conflict to fail.';
    EXCEPTION
        WHEN OTHERS THEN
            IF SQLERRM <> 'Student import id already belongs to another studio.' THEN
                RAISE;
            END IF;
    END;

    SELECT COUNT(*)
      INTO v_count
      FROM public.students
     WHERE id = v_conflicting_student
       AND studio_id = v_studio_a
       AND legal_first_name = 'Existing';

    IF v_count <> 1 THEN
        RAISE EXCEPTION 'Cross-studio student import conflict changed existing student ownership or data.';
    END IF;

    v_conflicting_guardian := private.deterministic_import_uuid(v_import_run_b, 'guardian-row:2');

    INSERT INTO public.guardians (
        id,
        studio_id,
        first_name,
        last_name,
        email,
        is_primary_contact
    )
    VALUES (
        v_conflicting_guardian,
        v_studio_a,
        'Existing',
        'Guardian',
        'existing-guardian@example.invalid',
        true
    );

    BEGIN
        PERFORM 1
          FROM public.import_student_row_atomic(
              jsonb_build_object(
                  'id', v_new_student,
                  'studio_id', v_studio_b,
                  'legal_first_name', 'New',
                  'legal_last_name', 'Student',
                  'status', 'active',
                  'tags', '[]'::JSONB
              ),
              v_studio_b,
              v_import_run_b,
              'tenant-b-token',
              2,
              'Tenant Guardian',
              'tenant-guardian@example.invalid',
              NULL,
              'Parent',
              ARRAY[v_program_b]
          );
        RAISE EXCEPTION 'Expected cross-studio guardian import ID conflict to fail.';
    EXCEPTION
        WHEN OTHERS THEN
            IF SQLERRM <> 'Student import guardian id already belongs to another studio.' THEN
                RAISE;
            END IF;
    END;

    SELECT COUNT(*)
      INTO v_count
      FROM public.guardians
     WHERE id = v_conflicting_guardian
       AND studio_id = v_studio_a
       AND first_name = 'Existing'
       AND email = 'existing-guardian@example.invalid';

    IF v_count <> 1 THEN
        RAISE EXCEPTION 'Cross-studio guardian import conflict changed existing guardian ownership or data.';
    END IF;

    RAISE NOTICE 'Koaryu atomic student import RPC contract verification passed.';
END $$;

ROLLBACK;
