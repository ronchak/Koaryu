-- Extend the exact-head writer attestation to cover RPC return contracts.
-- The V11 manifest remains the owner of bodies, search paths, security mode,
-- ownership, and ACLs; V12 composes that proof with pg_get_function_result().

CREATE FUNCTION private.koaryu_release_student_rank_writer_manifest_v12()
RETURNS TEXT
LANGUAGE sql
SECURITY INVOKER
STABLE
SET search_path = pg_catalog
AS $$
WITH required_functions(signature, expected_result) AS (
    VALUES
        (
            'public.write_student_profile_atomic(uuid, uuid, uuid, jsonb, uuid[], jsonb, boolean, text)',
            'students'
        ),
        (
            'private.write_student_profile_atomic(uuid, uuid, uuid, jsonb, uuid[], jsonb, boolean, text)',
            'students'
        ),
        (
            'public.import_student_row_atomic(jsonb, uuid, uuid, text, integer, text, text, text, text, uuid[])',
            'TABLE(student_id uuid, guardian_imported boolean)'
        ),
        (
            'private.import_student_row_atomic(jsonb, uuid, uuid, text, integer, text, text, text, text, uuid[])',
            'TABLE(student_id uuid, guardian_imported boolean)'
        )
),
function_actual AS (
    SELECT
        format(
            '%I.%I(%s)',
            namespace.nspname,
            function.proname,
            oidvectortypes(function.proargtypes)
        ) AS signature,
        replace(pg_get_function_result(function.oid), 'public.', '') AS result_contract
    FROM pg_proc function
    JOIN pg_namespace namespace ON namespace.oid = function.pronamespace
    JOIN required_functions required
      ON required.signature = format(
          '%I.%I(%s)',
          namespace.nspname,
          function.proname,
          oidvectortypes(function.proargtypes)
      )
),
function_compared AS (
    SELECT
        required.signature,
        required.expected_result,
        actual.result_contract
    FROM required_functions required
    LEFT JOIN function_actual actual USING (signature)
),
manifest_state AS (
    SELECT private.koaryu_release_student_rank_writer_manifest_v11() AS v11_manifest
),
invalid AS (
    SELECT
        count(*) FILTER (
            WHERE function.result_contract IS DISTINCT FROM function.expected_result
        ) +
        count(*) FILTER (
            WHERE manifest.v11_manifest IS DISTINCT FROM
              '0:2d9f05f4064da0a2855c2b916e8d4bb7785927db131a037ba6ae9716a40ddb60'
        ) AS invalid_count
    FROM function_compared function
    CROSS JOIN manifest_state manifest
)
SELECT invalid.invalid_count::TEXT || ':' || encode(
    extensions.digest(
        convert_to(
            manifest.v11_manifest || '|' || COALESCE(string_agg(
                function.signature || ':' ||
                function.expected_result || ':' ||
                COALESCE(function.result_contract, ''),
                '|' ORDER BY function.signature COLLATE "C"
            ), ''),
            'UTF8'
        ),
        'sha256'
    ),
    'hex'
)
FROM function_compared function
CROSS JOIN manifest_state manifest
CROSS JOIN invalid
GROUP BY invalid.invalid_count, manifest.v11_manifest;
$$;

ALTER FUNCTION private.koaryu_release_student_rank_writer_manifest_v12()
    OWNER TO postgres;
REVOKE ALL ON FUNCTION private.koaryu_release_student_rank_writer_manifest_v12()
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

    IF v_count <> 105
       OR v_head <> '20260814152000'
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
           '20260814114500',
           '20260814152000'
       ]::TEXT[]
       OR v_baseline <> '84:57ae4269ef4d75c249d59ef297661a3a' THEN
        v_failures := array_append(v_failures, 'migration_history_v12');
    END IF;

    IF private.koaryu_release_operational_manifest_v7()
       <> 'd621d0bfa18b21571132a51108dd418e66996944fb7723bd3aeb624da7fe0e79' THEN
        v_failures := array_append(v_failures, 'operational_semantic_acl_manifest_v7');
    END IF;

    IF private.koaryu_release_starting_belt_manifest_v9()
       <> '0:872d8e3159278a82fc8d72f248d6b131ec8e87d679de19b0e889ab83eb39e653' THEN
        v_failures := array_append(v_failures, 'starting_belt_invariant_manifest_v9');
    END IF;

    IF private.koaryu_release_student_rank_writer_manifest_v12()
       <> '0:37191b47844a7b1d665242e9d90627b89410eb3d2238511d4bd2845912aa7aa7' THEN
        v_failures := array_append(v_failures, 'student_rank_writer_manifest_v12');
    END IF;

    RETURN QUERY SELECT
        cardinality(v_failures) = 0,
        v_count,
        v_head,
        COALESCE(v_pending, ARRAY[]::TEXT[]),
        v_failures,
        'release-db-attestation-v12';
END;
$preflight$;

ALTER FUNCTION public.koaryu_release_schema_preflight_v2() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.koaryu_release_schema_preflight_v2()
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.koaryu_release_schema_preflight_v2()
    TO service_role;

COMMENT ON FUNCTION public.koaryu_release_schema_preflight_v2() IS
    'Operational exact-head V12 drift signal. V12 composes the V11 writer body/ACL proof with exact RPC return contracts, keeps the V9 starting-belt invariant, and advances migration history.';
