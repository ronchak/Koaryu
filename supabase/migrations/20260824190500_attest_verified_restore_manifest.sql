-- Advance release readiness across the two exact PostgreSQL 17 catalog states
-- already proved by the canonical migration replay and the production logical
-- restore. Both states have zero V7 component failures and identical enforced
-- security invariants; their semantic catalog bytes differ after logical
-- restore, so the operational digest is intentionally an exact two-value set.
--
-- This migration changes only the release preflight owner. It does not repair,
-- normalize, or rewrite customer data or operational objects. Any third digest,
-- migration history, object failure, or readiness hybrid remains fail closed.

DO $verified_restore_manifest_guard$
DECLARE
    v_operational_manifest TEXT;
BEGIN
    v_operational_manifest := private.koaryu_release_operational_manifest_v7();

    IF v_operational_manifest IS DISTINCT FROM
           '61c8251b04d170bb4777de6c35570d024d6c97897ef1c524bc1adbcff97b7931'
       AND v_operational_manifest IS DISTINCT FROM
           'f9ce359c0ebf12039e8dfcb5308cd193ac18aa05cea23dad5b9f5208b0c51233' THEN
        RAISE EXCEPTION
            'Operational manifest is not a proved canonical or restored PostgreSQL 17 state';
    END IF;
END;
$verified_restore_manifest_guard$;

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
AS $schema_preflight_v4_verified_restore$
DECLARE
    v_count INTEGER;
    v_head TEXT;
    v_pending TEXT[];
    v_operational_manifest TEXT;
    v_failures TEXT[] := ARRAY[]::TEXT[];
BEGIN
    SELECT count(*)::INTEGER, max(version),
           array_agg(version ORDER BY version COLLATE "C") FILTER (WHERE version >= '20260727100000')
    INTO v_count, v_head, v_pending
    FROM supabase_migrations.schema_migrations;

    IF v_count <> 117 OR v_head <> '20260824190500' THEN
        v_failures := array_append(v_failures, 'migration_history_v24');
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
        '20260824190500'
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
        COALESCE(v_pending, ARRAY[]::TEXT[]), v_failures, 'release-db-attestation-v24';
END;
$schema_preflight_v4_verified_restore$;

ALTER FUNCTION public.koaryu_release_schema_preflight_v4() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.koaryu_release_schema_preflight_v4()
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.koaryu_release_schema_preflight_v4() TO service_role;
