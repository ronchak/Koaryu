-- Remove direct PostgREST read access to public tables from the API roles.
--
-- The browser uses supabase-js for authentication only; it makes no PostgREST
-- data calls anywhere in frontend/src. The backend connects with the service
-- role. Nothing in the product reads public tables as `anon` or `authenticated`,
-- yet both roles held SELECT on 35 of 36 tables in production, so RLS was the
-- only control standing between the public internet and student, billing,
-- guardian, lead, audit, and support rows.
--
-- `public.students` already showed the intended shape: migration
-- 20260713010426 revoked its SELECT, so PostgREST answers `permission denied`
-- before RLS is ever consulted. This extends that precedent to the rest of the
-- schema and closes the default that keeps reopening it.

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;

-- Without this, every future CREATE TABLE in public re-grants the API roles.
-- Production's default ACL still carried arwdDxtm for both roles, so a new
-- table shipped internet-readable and writable, gated only by whatever RLS the
-- creating migration remembered to add.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    REVOKE ALL ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    REVOKE ALL ON FUNCTIONS FROM anon, authenticated;

-- Fail closed rather than leaving a partially hardened schema behind.
DO $$
DECLARE
    v_leaked TEXT;
BEGIN
    -- MATERIALIZED keeps the privilege probe from being pushed down onto rows
    -- the relkind filter excludes; without it the planner can call it on a
    -- toast relation and error out.
    WITH candidates AS MATERIALIZED (
        SELECT c.oid, c.relname
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
         WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
    )
    SELECT string_agg(format('%s(%s)', candidates.relname, r.rolname), ', '
                      ORDER BY candidates.relname, r.rolname)
      INTO v_leaked
      FROM candidates
      CROSS JOIN (VALUES ('anon'), ('authenticated')) AS r(rolname)
     WHERE has_table_privilege(
             r.rolname,
             candidates.oid,
             'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
           );

    IF v_leaked IS NOT NULL THEN
        RAISE EXCEPTION 'API roles retain privileges on public relations: %', v_leaked;
    END IF;
END;
$$;

-- Keep the release preflight pointed at this additive exact head. The function
-- is intentionally replaced here rather than rewriting the historical readiness
-- migration. Only the operational manifest moves: revoking the API roles
-- changes table ACLs, which that manifest hashes. The starting-belt,
-- student-rank-writer, and critical-surface manifests are unchanged, and the
-- raw catalog fingerprint moves only in its table_acls section.
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
AS $schema_preflight_v4_client_read$
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

    IF v_count <> 115 OR v_head <> '20260822193000' THEN
        v_failures := array_append(v_failures, 'migration_history_v22');
    END IF;
    IF COALESCE(v_pending, ARRAY[]::TEXT[]) IS DISTINCT FROM ARRAY[
        '20260727100000','20260727110000','20260801050957','20260801060000',
        '20260801070000','20260801080000','20260801090000','20260801091000',
        '20260801092000','20260801093000','20260801094000','20260801105313',
        '20260801112153','20260801115044','20260801123112','20260801131844',
        '20260814043325','20260814103046','20260814105424','20260814114500',
        '20260814152000','20260814170000','20260814183000','20260814200000',
        '20260814213000','20260815220402','20260816012723','20260820012533',
        '20260820025759','20260820060216','20260822193000'
    ]::TEXT[] THEN
        v_failures := array_append(v_failures, 'migration_history_sequence_v22');
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
        COALESCE(v_pending, ARRAY[]::TEXT[]), v_failures, 'release-db-attestation-v22';
END;
$schema_preflight_v4_client_read$;

ALTER FUNCTION public.koaryu_release_schema_preflight_v4() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.koaryu_release_schema_preflight_v4()
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.koaryu_release_schema_preflight_v4() TO service_role;
