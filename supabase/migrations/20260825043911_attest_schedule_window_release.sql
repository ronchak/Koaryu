-- Advance hosted readiness for the schedule-window release while keeping the
-- deployed V24 backend healthy during the database-first rollout. V25 callers
-- use preflight_v5. The V24-shaped preflight_v4 bridge can be removed after
-- both hosted backends run a V25-aware release.

CREATE FUNCTION private.koaryu_release_schedule_window_manifest_v1()
RETURNS TEXT
LANGUAGE plpgsql
SECURITY INVOKER
STABLE
SET search_path = pg_catalog
AS $schedule_window_manifest_v1$
DECLARE
    v_invalid INTEGER;
    v_serialized TEXT;
BEGIN
    WITH function_state AS (
        SELECT
            function_state_row.oid,
            COALESCE(owner.rolname, '') AS owner_name,
            COALESCE(language.lanname, '') AS language_name,
            COALESCE(function_state_row.provolatile::TEXT, '') AS volatility,
            COALESCE(function_state_row.prosecdef::TEXT, '') AS security_definer,
            COALESCE(array_to_string(function_state_row.proconfig, ','), '') AS configuration,
            COALESCE(pg_get_function_result(function_state_row.oid), '') AS result_contract,
            has_function_privilege('service_role', function_state_row.oid, 'EXECUTE') AS service_execute,
            has_function_privilege('anon', function_state_row.oid, 'EXECUTE') AS anon_execute,
            has_function_privilege('authenticated', function_state_row.oid, 'EXECUTE') AS authenticated_execute,
            EXISTS (
                SELECT 1
                FROM aclexplode(
                    COALESCE(
                        function_state_row.proacl,
                        acldefault('f', function_state_row.proowner)
                    )
                ) AS privilege
                WHERE privilege.grantee = 0
                  AND privilege.privilege_type = 'EXECUTE'
            ) AS public_execute,
            EXISTS (
                SELECT 1
                FROM aclexplode(
                    COALESCE(
                        function_state_row.proacl,
                        acldefault('f', function_state_row.proowner)
                    )
                ) AS privilege
                LEFT JOIN pg_roles AS grantee
                  ON grantee.oid = privilege.grantee
                WHERE privilege.privilege_type = 'EXECUTE'
                  AND privilege.grantee <> function_state_row.proowner
                  AND NOT (
                      grantee.rolname = 'service_role'
                      AND NOT privilege.is_grantable
                  )
            ) AS unexpected_execute_grant,
            COALESCE(pg_get_functiondef(function_state_row.oid), '') AS definition
        FROM pg_proc AS function_state_row
        JOIN pg_namespace AS namespace
          ON namespace.oid = function_state_row.pronamespace
        LEFT JOIN pg_roles AS owner
          ON owner.oid = function_state_row.proowner
        LEFT JOIN pg_language AS language
          ON language.oid = function_state_row.prolang
        WHERE namespace.nspname = 'public'
          AND function_state_row.oid = to_regprocedure(
              'public.schedule_window_read(uuid,date,date,text)'
          )
    ), serialized AS (
        SELECT
            'f:public.schedule_window_read(uuid,date,date,text):'
              || definition || ':' || owner_name || ':' || language_name || ':'
              || volatility || ':' || security_definer || ':' || configuration || ':'
              || result_contract || ':' || service_execute::TEXT || ':'
              || anon_execute::TEXT || ':' || authenticated_execute::TEXT || ':'
              || public_execute::TEXT AS value,
            (
                oid IS NULL
                OR owner_name <> 'postgres'
                OR language_name <> 'plpgsql'
                OR volatility <> 's'
                OR security_definer <> 'false'
                OR configuration <> 'search_path=pg_catalog'
                OR result_contract <> 'jsonb'
                OR service_execute IS DISTINCT FROM true
                OR anon_execute
                OR authenticated_execute
                OR public_execute
                OR unexpected_execute_grant
            )::INTEGER AS invalid
        FROM function_state
    )
    SELECT
        COALESCE(SUM(invalid), 1)::INTEGER,
        COALESCE(string_agg(value, '|' ORDER BY value COLLATE "C"), '')
    INTO v_invalid, v_serialized
    FROM serialized;

    RETURN v_invalid::TEXT || ':' || encode(
        extensions.digest(convert_to(v_serialized, 'UTF8'), 'sha256'),
        'hex'
    );
END;
$schedule_window_manifest_v1$;

ALTER FUNCTION private.koaryu_release_schedule_window_manifest_v1() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.koaryu_release_schedule_window_manifest_v1()
FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.koaryu_release_schema_preflight_v5()
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
AS $schema_preflight_v5_schedule_window$
DECLARE
    v_count INTEGER;
    v_head TEXT;
    v_pending TEXT[];
    v_operational_manifest TEXT;
    v_failures TEXT[] := ARRAY[]::TEXT[];
BEGIN
    SELECT count(*)::INTEGER, max(version),
           array_agg(version ORDER BY version COLLATE "C")
             FILTER (WHERE version >= '20260727100000')
    INTO v_count, v_head, v_pending
    FROM supabase_migrations.schema_migrations;

    IF v_count <> 119 OR v_head <> '20260825043911' THEN
        v_failures := array_append(v_failures, 'migration_history_v25');
    END IF;
    IF COALESCE(v_pending, ARRAY[]::TEXT[]) IS DISTINCT FROM ARRAY[
        '20260727100000','20260727110000','20260801050957','20260801060000',
        '20260801070000','20260801080000','20260801090000','20260801091000',
        '20260801092000','20260801093000','20260801094000','20260801105313',
        '20260801112153','20260801115044','20260801123112','20260801131844',
        '20260814043325','20260814103046','20260814105424','20260814114500',
        '20260814152000','20260814170000','20260814183000','20260814200000',
        '20260814213000','20260815220402','20260816012723','20260820012533',
        '20260820025759','20260820060216','20260822193000','20260823193155',
        '20260824190500','20260825042838','20260825043911'
    ]::TEXT[] THEN
        v_failures := array_append(v_failures, 'migration_history_sequence_v25');
    END IF;

    v_operational_manifest := private.koaryu_release_operational_manifest_v7();
    IF v_operational_manifest IS DISTINCT FROM
           '61c8251b04d170bb4777de6c35570d024d6c97897ef1c524bc1adbcff97b7931'
       AND v_operational_manifest IS DISTINCT FROM
           'f9ce359c0ebf12039e8dfcb5308cd193ac18aa05cea23dad5b9f5208b0c51233' THEN
        v_failures := array_append(v_failures, 'operational_semantic_acl_manifest_v7');
    END IF;
    IF private.koaryu_release_starting_belt_manifest_v9()
       <> '0:9c1c8ea5e7ab6ce0d34d5654d17b056faba89234f0f2b945ff147c0462711be9' THEN
        v_failures := array_append(v_failures, 'starting_belt_invariant_manifest_v9');
    END IF;
    IF private.koaryu_release_student_rank_writer_manifest_v13()
       <> '0:27cdc692d92fb49f696521e7ab6f3d0b7717c30a232ba6ce4ba057df9e5b30f7' THEN
        v_failures := array_append(v_failures, 'student_rank_writer_manifest_v13');
    END IF;
    IF private.koaryu_release_critical_surface_manifest_v18()
       <> '0:cf1b1a4403e539721172d4a8cfec64540e4f5dcec2aab12eafbcfb51fbd84b3a' THEN
        v_failures := array_append(v_failures, 'critical_surface_manifest_v18');
    END IF;
    IF private.koaryu_release_schedule_window_manifest_v1()
       <> '0:f4c66d3098dcb3210ac6cc92e1831eebaf9f2ed74b210e84ec773cb1d8e854a7' THEN
        v_failures := array_append(v_failures, 'schedule_window_manifest_v1');
    END IF;

    RETURN QUERY SELECT cardinality(v_failures) = 0, v_count, v_head,
        COALESCE(v_pending, ARRAY[]::TEXT[]), v_failures,
        'release-db-attestation-v25';
END;
$schema_preflight_v5_schedule_window$;

ALTER FUNCTION public.koaryu_release_schema_preflight_v5() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.koaryu_release_schema_preflight_v5()
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.koaryu_release_schema_preflight_v5()
TO service_role;

CREATE OR REPLACE FUNCTION public.koaryu_release_schema_preflight_v4()
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
AS $schema_preflight_v4_v25_compatibility$
DECLARE
    v_actual_count INTEGER;
    v_actual_head TEXT;
    v_actual_pending TEXT[];
    v_operational_manifest TEXT;
    v_failures TEXT[] := ARRAY[]::TEXT[];
BEGIN
    SELECT count(*)::INTEGER, max(version),
           array_agg(version ORDER BY version COLLATE "C")
             FILTER (WHERE version >= '20260727100000')
    INTO v_actual_count, v_actual_head, v_actual_pending
    FROM supabase_migrations.schema_migrations;

    IF v_actual_count <> 119 OR v_actual_head <> '20260825043911' THEN
        v_failures := array_append(v_failures, 'migration_history_v25_bridge');
    END IF;
    IF COALESCE(v_actual_pending, ARRAY[]::TEXT[]) IS DISTINCT FROM ARRAY[
        '20260727100000','20260727110000','20260801050957','20260801060000',
        '20260801070000','20260801080000','20260801090000','20260801091000',
        '20260801092000','20260801093000','20260801094000','20260801105313',
        '20260801112153','20260801115044','20260801123112','20260801131844',
        '20260814043325','20260814103046','20260814105424','20260814114500',
        '20260814152000','20260814170000','20260814183000','20260814200000',
        '20260814213000','20260815220402','20260816012723','20260820012533',
        '20260820025759','20260820060216','20260822193000','20260823193155',
        '20260824190500','20260825042838','20260825043911'
    ]::TEXT[] THEN
        v_failures := array_append(v_failures, 'migration_history_sequence_v24');
    END IF;
    v_operational_manifest := private.koaryu_release_operational_manifest_v7();
    IF v_operational_manifest IS DISTINCT FROM
           '61c8251b04d170bb4777de6c35570d024d6c97897ef1c524bc1adbcff97b7931'
       AND v_operational_manifest IS DISTINCT FROM
           'f9ce359c0ebf12039e8dfcb5308cd193ac18aa05cea23dad5b9f5208b0c51233' THEN
        v_failures := array_append(v_failures, 'operational_semantic_acl_manifest_v7');
    END IF;
    IF private.koaryu_release_schedule_window_manifest_v1()
       <> '0:f4c66d3098dcb3210ac6cc92e1831eebaf9f2ed74b210e84ec773cb1d8e854a7' THEN
        v_failures := array_append(v_failures, 'schedule_window_manifest_v1');
    END IF;
    IF private.koaryu_release_starting_belt_manifest_v9()
       <> '0:9c1c8ea5e7ab6ce0d34d5654d17b056faba89234f0f2b945ff147c0462711be9' THEN
        v_failures := array_append(v_failures, 'starting_belt_invariant_manifest_v9');
    END IF;
    IF private.koaryu_release_student_rank_writer_manifest_v13()
       <> '0:27cdc692d92fb49f696521e7ab6f3d0b7717c30a232ba6ce4ba057df9e5b30f7' THEN
        v_failures := array_append(v_failures, 'student_rank_writer_manifest_v13');
    END IF;
    IF private.koaryu_release_critical_surface_manifest_v18()
       <> '0:cf1b1a4403e539721172d4a8cfec64540e4f5dcec2aab12eafbcfb51fbd84b3a' THEN
        v_failures := array_append(v_failures, 'critical_surface_manifest_v18');
    END IF;

    RETURN QUERY SELECT
        cardinality(v_failures) = 0,
        117,
        '20260824190500'::TEXT,
        ARRAY[
            '20260727100000','20260727110000','20260801050957','20260801060000',
            '20260801070000','20260801080000','20260801090000','20260801091000',
            '20260801092000','20260801093000','20260801094000','20260801105313',
            '20260801112153','20260801115044','20260801123112','20260801131844',
            '20260814043325','20260814103046','20260814105424','20260814114500',
            '20260814152000','20260814170000','20260814183000','20260814200000',
            '20260814213000','20260815220402','20260816012723','20260820012533',
            '20260820025759','20260820060216','20260822193000','20260823193155',
            '20260824190500'
        ]::TEXT[],
        v_failures,
        'release-db-attestation-v24'::TEXT;
END;
$schema_preflight_v4_v25_compatibility$;

ALTER FUNCTION public.koaryu_release_schema_preflight_v4() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.koaryu_release_schema_preflight_v4()
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.koaryu_release_schema_preflight_v4()
TO service_role;
