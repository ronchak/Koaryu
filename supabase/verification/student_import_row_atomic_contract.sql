BEGIN;

DO $$
DECLARE
    v_import_rpc REGPROCEDURE := 'public.import_student_row_atomic(jsonb,uuid,uuid,text,integer,text,text,text,text,uuid[])'::REGPROCEDURE;
    v_uuid_helper REGPROCEDURE := 'private.deterministic_import_uuid(uuid,text)'::REGPROCEDURE;
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

    RAISE NOTICE 'Koaryu atomic student import RPC contract verification passed.';
END $$;

ROLLBACK;
