-- Keep every student write path synchronized with the primary active program
-- membership, and attest the RPC wrappers introduced by migrations 103-104.

-- The import implementation writes memberships before its final compatibility
-- update on students. Keep the established implementation private, then
-- reconcile the compatibility rank after that implementation returns.
ALTER FUNCTION public.import_student_row_atomic(
    JSONB, UUID, UUID, TEXT, INTEGER, TEXT, TEXT, TEXT, TEXT, UUID[]
) SET SCHEMA private;

CREATE FUNCTION public.import_student_row_atomic(
    p_student JSONB,
    p_studio_id UUID,
    p_import_run_id UUID,
    p_processing_token TEXT,
    p_row_number INTEGER,
    p_guardian_name TEXT DEFAULT NULL,
    p_guardian_email TEXT DEFAULT NULL,
    p_guardian_phone TEXT DEFAULT NULL,
    p_guardian_relation TEXT DEFAULT NULL,
    p_program_ids UUID[] DEFAULT NULL
)
RETURNS TABLE(student_id UUID, guardian_imported BOOLEAN)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, private
AS $$
DECLARE
    v_student_id UUID;
    v_guardian_imported BOOLEAN;
BEGIN
    SELECT imported.student_id, imported.guardian_imported
    INTO v_student_id, v_guardian_imported
    FROM private.import_student_row_atomic(
        p_student,
        p_studio_id,
        p_import_run_id,
        p_processing_token,
        p_row_number,
        p_guardian_name,
        p_guardian_email,
        p_guardian_phone,
        p_guardian_relation,
        p_program_ids
    ) AS imported;

    UPDATE public.students student
    SET current_belt_rank_id = membership.current_belt_rank_id,
        updated_at = NOW()
    FROM public.student_program_memberships membership
    WHERE student.id = v_student_id
      AND student.studio_id = p_studio_id
      AND membership.student_id = student.id
      AND membership.studio_id = student.studio_id
      AND membership.program_id = student.program_id
      AND membership.status IN ('active', 'paused')
      AND membership.ended_at IS NULL
      AND student.current_belt_rank_id IS DISTINCT FROM membership.current_belt_rank_id;

    student_id := v_student_id;
    guardian_imported := v_guardian_imported;
    RETURN NEXT;
END;
$$;

ALTER FUNCTION private.import_student_row_atomic(
    JSONB, UUID, UUID, TEXT, INTEGER, TEXT, TEXT, TEXT, TEXT, UUID[]
) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.import_student_row_atomic(
    JSONB, UUID, UUID, TEXT, INTEGER, TEXT, TEXT, TEXT, TEXT, UUID[]
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.import_student_row_atomic(
    JSONB, UUID, UUID, TEXT, INTEGER, TEXT, TEXT, TEXT, TEXT, UUID[]
) TO service_role;

ALTER FUNCTION public.import_student_row_atomic(
    JSONB, UUID, UUID, TEXT, INTEGER, TEXT, TEXT, TEXT, TEXT, UUID[]
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.import_student_row_atomic(
    JSONB, UUID, UUID, TEXT, INTEGER, TEXT, TEXT, TEXT, TEXT, UUID[]
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.import_student_row_atomic(
    JSONB, UUID, UUID, TEXT, INTEGER, TEXT, TEXT, TEXT, TEXT, UUID[]
) TO service_role;

-- Database-observable proof for the public/private student profile and CSV
-- import RPC pairs. The digest includes bodies, search paths, security mode,
-- ownership, and the complete EXECUTE ACL state for each identity.
CREATE FUNCTION private.koaryu_release_student_rank_writer_manifest_v11()
RETURNS TEXT
LANGUAGE sql
SECURITY INVOKER
STABLE
SET search_path = pg_catalog
AS $$
WITH required_functions(signature, expected_config) AS (
    VALUES
        (
            'public.write_student_profile_atomic(uuid, uuid, uuid, jsonb, uuid[], jsonb, boolean, text)',
            'search_path=pg_catalog, public, private'
        ),
        (
            'private.write_student_profile_atomic(uuid, uuid, uuid, jsonb, uuid[], jsonb, boolean, text)',
            'search_path=public, pg_temp'
        ),
        (
            'public.import_student_row_atomic(jsonb, uuid, uuid, text, integer, text, text, text, text, uuid[])',
            'search_path=pg_catalog, public, private'
        ),
        (
            'private.import_student_row_atomic(jsonb, uuid, uuid, text, integer, text, text, text, text, uuid[])',
            'search_path=public, pg_temp'
        )
),
function_actual AS (
    SELECT
        format('%I.%I(%s)', namespace.nspname, function.proname, oidvectortypes(function.proargtypes)) AS signature,
        owner.rolname AS owner_name,
        language.lanname AS language_name,
        function.prosecdef AS security_definer,
        COALESCE(array_to_string(function.proconfig, ','), '') AS config,
        EXISTS (
            SELECT 1
            FROM aclexplode(COALESCE(function.proacl, acldefault('f', function.proowner))) acl
            WHERE acl.grantee = 0
              AND acl.privilege_type = 'EXECUTE'
        ) AS public_execute,
        has_function_privilege('anon', function.oid, 'EXECUTE') AS anon_execute,
        has_function_privilege('authenticated', function.oid, 'EXECUTE') AS authenticated_execute,
        has_function_privilege('service_role', function.oid, 'EXECUTE') AS service_execute,
        encode(extensions.digest(convert_to(function.prosrc, 'UTF8'), 'sha256'), 'hex') AS body_sha256,
        COALESCE((
            SELECT string_agg(
                COALESCE(grantor.rolname, 'PUBLIC') || '>' ||
                COALESCE(grantee.rolname, 'PUBLIC') || ':' ||
                acl.privilege_type || ':' || acl.is_grantable::TEXT,
                ',' ORDER BY
                    COALESCE(grantor.rolname, 'PUBLIC') COLLATE "C",
                    COALESCE(grantee.rolname, 'PUBLIC') COLLATE "C",
                    acl.privilege_type COLLATE "C",
                    acl.is_grantable
            )
            FROM aclexplode(COALESCE(function.proacl, acldefault('f', function.proowner))) acl
            LEFT JOIN pg_roles grantor ON grantor.oid = acl.grantor
            LEFT JOIN pg_roles grantee ON grantee.oid = acl.grantee
        ), '') AS acl_state,
        EXISTS (
            SELECT 1
            FROM aclexplode(COALESCE(function.proacl, acldefault('f', function.proowner))) acl
            LEFT JOIN pg_roles grantee ON grantee.oid = acl.grantee
            WHERE acl.privilege_type = 'EXECUTE'
              AND acl.grantee <> function.proowner
              AND NOT (
                  grantee.rolname = 'service_role'
                  AND NOT acl.is_grantable
              )
        ) AS unexpected_execute_grant
    FROM pg_proc function
    JOIN pg_namespace namespace ON namespace.oid = function.pronamespace
    JOIN pg_roles owner ON owner.oid = function.proowner
    JOIN pg_language language ON language.oid = function.prolang
    JOIN required_functions required
      ON required.signature = format(
          '%I.%I(%s)', namespace.nspname, function.proname, oidvectortypes(function.proargtypes)
      )
),
function_compared AS (
    SELECT
        required.*,
        actual.owner_name,
        actual.language_name,
        actual.security_definer,
        actual.config,
        actual.public_execute,
        actual.anon_execute,
        actual.authenticated_execute,
        actual.service_execute,
        actual.body_sha256,
        actual.acl_state,
        actual.unexpected_execute_grant
    FROM required_functions required
    LEFT JOIN function_actual actual USING (signature)
),
invalid AS (
    SELECT count(*) AS invalid_count
    FROM function_compared function
    WHERE function.owner_name IS DISTINCT FROM 'postgres'
       OR function.language_name IS DISTINCT FROM 'plpgsql'
       OR function.security_definer IS DISTINCT FROM FALSE
       OR function.config IS DISTINCT FROM function.expected_config
       OR function.public_execute IS DISTINCT FROM FALSE
       OR function.anon_execute IS DISTINCT FROM FALSE
       OR function.authenticated_execute IS DISTINCT FROM FALSE
       OR function.service_execute IS DISTINCT FROM TRUE
       OR function.unexpected_execute_grant IS DISTINCT FROM FALSE
       OR function.body_sha256 IS NULL
)
SELECT invalid.invalid_count::TEXT || ':' || encode(
    extensions.digest(
        convert_to(
            COALESCE(string_agg(
                function.signature || ':' || concat_ws('|',
                    function.owner_name,
                    function.language_name,
                    function.security_definer::TEXT,
                    function.config,
                    function.public_execute::TEXT,
                    function.anon_execute::TEXT,
                    function.authenticated_execute::TEXT,
                    function.service_execute::TEXT,
                    function.body_sha256,
                    function.acl_state,
                    function.unexpected_execute_grant::TEXT
                ),
                '|' ORDER BY function.signature COLLATE "C"
            ), ''),
            'UTF8'
        ),
        'sha256'
    ),
    'hex'
)
FROM function_compared function
CROSS JOIN invalid
GROUP BY invalid.invalid_count;
$$;

ALTER FUNCTION private.koaryu_release_student_rank_writer_manifest_v11()
    OWNER TO postgres;
REVOKE ALL ON FUNCTION private.koaryu_release_student_rank_writer_manifest_v11()
    FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.koaryu_release_schema_preflight_v2()
RETURNS TABLE (
    ready BOOLEAN,
    migration_count INTEGER,
    migration_head TEXT,
    pending_versions TEXT[],
    security_failures TEXT[],
    manifest_version TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog
AS $preflight$
DECLARE
    v_count INTEGER;
    v_head TEXT;
    v_pending TEXT[];
    v_baseline TEXT;
    v_prior RECORD;
    v_failures TEXT[] := ARRAY[]::TEXT[];
BEGIN
    SELECT * INTO v_prior
    FROM public.koaryu_release_schema_preflight_v6();

    v_failures := array_remove(
        array_remove(v_prior.security_failures, 'migration_history_v6'),
        'operational_semantic_acl_manifest_v6'
    );

    SELECT count(*)::INTEGER,
           max(version),
           array_agg(version ORDER BY version COLLATE "C")
             FILTER (WHERE version >= '20260727100000'),
           count(*) FILTER (WHERE version < '20260727100000')::TEXT || ':' ||
             md5(string_agg(version || ':' || name, '|' ORDER BY version COLLATE "C")
                 FILTER (WHERE version < '20260727100000'))
    INTO v_count, v_head, v_pending, v_baseline
    FROM supabase_migrations.schema_migrations;

    IF v_count <> 104
       OR v_head <> '20260814114500'
       OR v_pending IS DISTINCT FROM ARRAY[
           '20260727100000',
           '20260727110000',
           '20260801050957',
           '20260801060000',
           '20260801070000',
           '20260801080000',
           '20260801090000',
           '20260801091000',
           '20260801092000',
           '20260801093000',
           '20260801094000',
           '20260801105313',
           '20260801112153',
           '20260801115044',
           '20260801123112',
           '20260801131844',
           '20260814043325',
           '20260814103046',
           '20260814105424',
           '20260814114500'
       ]::TEXT[]
       OR v_baseline <> '84:57ae4269ef4d75c249d59ef297661a3a' THEN
        v_failures := array_append(v_failures, 'migration_history_v11');
    END IF;

    IF private.koaryu_release_operational_manifest_v7()
       <> 'd621d0bfa18b21571132a51108dd418e66996944fb7723bd3aeb624da7fe0e79' THEN
        v_failures := array_append(v_failures, 'operational_semantic_acl_manifest_v7');
    END IF;

    IF private.koaryu_release_starting_belt_manifest_v9()
       <> '0:872d8e3159278a82fc8d72f248d6b131ec8e87d679de19b0e889ab83eb39e653' THEN
        v_failures := array_append(v_failures, 'starting_belt_invariant_manifest_v9');
    END IF;

    IF private.koaryu_release_student_rank_writer_manifest_v11()
       <> '0:2d9f05f4064da0a2855c2b916e8d4bb7785927db131a037ba6ae9716a40ddb60' THEN
        v_failures := array_append(v_failures, 'student_rank_writer_manifest_v11');
    END IF;

    RETURN QUERY SELECT
        cardinality(v_failures) = 0,
        v_count,
        v_head,
        COALESCE(v_pending, ARRAY[]::TEXT[]),
        v_failures,
        'release-db-attestation-v11';
END;
$preflight$;

ALTER FUNCTION public.koaryu_release_schema_preflight_v2() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.koaryu_release_schema_preflight_v2()
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.koaryu_release_schema_preflight_v2()
    TO service_role;

COMMENT ON FUNCTION public.koaryu_release_schema_preflight_v2() IS
    'Operational exact-head V11 drift signal. V11 attests the public/private student profile and CSV import writer pairs, keeps the V9 starting-belt invariant, and advances migration history.';
