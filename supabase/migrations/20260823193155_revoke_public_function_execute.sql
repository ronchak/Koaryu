-- Remove executable public-schema routines from the browser-facing roles and
-- keep future routines closed until a migration grants them deliberately.
--
-- Migration 20260711215000 already revoked PostgreSQL's global PUBLIC default
-- and swept the functions that existed at that point. Migration 20260822193000
-- later removed Supabase's schema-local function defaults for anon and
-- authenticated. Reassert both controls here, then fail closed across every
-- current public routine so the release does not depend on
-- per-routine REVOKE statements being remembered.

-- PostgreSQL grants EXECUTE on new routines to PUBLIC from a global default.
-- A schema-local revoke cannot subtract that built-in grant, so the global
-- default is the control that keeps new public routines private.
ALTER DEFAULT PRIVILEGES
    REVOKE ALL ON FUNCTIONS FROM PUBLIC;

-- Supabase can also seed additive defaults for its API roles in public. Keep
-- the schema-local default empty for all three browser-reachable principals.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    REVOKE ALL ON FUNCTIONS FROM PUBLIC, anon, authenticated;

-- Migration 20260822193000 guards ordinary, partitioned, view, materialized
-- view, and foreign relations (r,p,v,m,f). Its verification contract separately
-- guards sequences (S). This block completes that split for every public
-- pg_proc routine kind without rewriting either historical migration.
DO $$
DECLARE
    v_leaked TEXT;
BEGIN
    -- MATERIALIZED pins the public-schema candidate set ahead of the
    -- privilege probe.
    WITH candidates AS MATERIALIZED (
        SELECT
            p.oid,
            format(
                '%I.%I(%s)',
                n.nspname,
                p.proname,
                pg_get_function_identity_arguments(p.oid)
            ) AS signature
          FROM pg_proc AS p
          JOIN pg_namespace AS n
            ON n.oid = p.pronamespace
           AND n.nspname = 'public'
    )
    SELECT string_agg(
               format('%s(%s)', candidates.signature, roles.role_name),
               ', ' ORDER BY candidates.signature, roles.role_name
           )
      INTO v_leaked
      FROM candidates
      CROSS JOIN (VALUES ('public'), ('anon'), ('authenticated')) AS roles(role_name)
     WHERE has_function_privilege(roles.role_name, candidates.oid, 'EXECUTE');

    IF v_leaked IS NOT NULL THEN
        RAISE EXCEPTION
            'Browser-facing roles retain EXECUTE on public routines: %',
            v_leaked;
    END IF;
END;
$$;

-- Keep the release preflight pointed at this additive exact head. A fresh
-- PostgreSQL 17 replay leaves every semantic and raw-catalog manifest at its
-- prior value because the earlier global revoke had already converged current
-- routine ACLs. Only the exact history count, head, sequence, and attestation
-- version move.
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
AS $schema_preflight_v4_function_execute$
DECLARE
    v_count INTEGER;
    v_head TEXT;
    v_pending TEXT[];
    v_failures TEXT[] := ARRAY[]::TEXT[];
BEGIN
    SELECT count(*)::INTEGER, max(version),
           array_agg(version ORDER BY version COLLATE "C") FILTER (WHERE version >= '20260727100000')
    INTO v_count, v_head, v_pending
    FROM supabase_migrations.schema_migrations;

    IF v_count <> 116 OR v_head <> '20260823193155' THEN
        v_failures := array_append(v_failures, 'migration_history_v23');
    END IF;
    IF COALESCE(v_pending, ARRAY[]::TEXT[]) IS DISTINCT FROM ARRAY[
        '20260727100000','20260727110000','20260801050957','20260801060000',
        '20260801070000','20260801080000','20260801090000','20260801091000',
        '20260801092000','20260801093000','20260801094000','20260801105313',
        '20260801112153','20260801115044','20260801123112','20260801131844',
        '20260814043325','20260814103046','20260814105424','20260814114500',
        '20260814152000','20260814170000','20260814183000','20260814200000',
        '20260814213000','20260815220402','20260816012723','20260820012533',
        '20260820025759','20260820060216','20260822193000','20260823193155'
    ]::TEXT[] THEN
        v_failures := array_append(v_failures, 'migration_history_sequence_v23');
    END IF;
    IF private.koaryu_release_operational_manifest_v7()
       <> '61c8251b04d170bb4777de6c35570d024d6c97897ef1c524bc1adbcff97b7931' THEN
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

    RETURN QUERY SELECT cardinality(v_failures) = 0, v_count, v_head,
        COALESCE(v_pending, ARRAY[]::TEXT[]), v_failures, 'release-db-attestation-v23';
END;
$schema_preflight_v4_function_execute$;

ALTER FUNCTION public.koaryu_release_schema_preflight_v4() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.koaryu_release_schema_preflight_v4()
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.koaryu_release_schema_preflight_v4() TO service_role;
