-- Owner-approved production incident repair for the exact post-upgrade v22
-- logical-restore state. This is not a migration and must not be added to
-- supabase_migrations.schema_migrations.
--
-- Target binding is external: apply only through the Supabase management API
-- to project mimguepumzsgmcaycdsh after its authoritative project readback is
-- ACTIVE_HEALTHY on GA image 17.6.1.155.
--
-- Convergence condition: migration history remains exactly 115 at
-- 20260822193000, the operational manifest is the proved restored value, and
-- the v22 preflight is either the exact pre-repair body or this exact repaired
-- body. Any other state aborts the transaction. Re-running the exact repaired
-- state is safe.
--
-- Removal condition: retire this operator artifact when production advances
-- beyond v22 and a tracked successor migration owns the active preflight. It
-- must never be generalized to another project, migration head, manifest, or
-- failure name, and migration 20260822193000 must remain immutable.

BEGIN;

DO $repair_guard$
DECLARE
    v_body TEXT;
    v_owner NAME;
    v_security_definer BOOLEAN;
    v_config TEXT[];
    v_acl TEXT;
    v_normalized_body_sha256 TEXT;
    v_old_count INTEGER;
    v_new_count INTEGER;
    v_preflight RECORD;
BEGIN
    SELECT p.prosrc,
           pg_get_userbyid(p.proowner),
           p.prosecdef,
           p.proconfig,
           p.proacl::TEXT
    INTO v_body, v_owner, v_security_definer, v_config, v_acl
    FROM pg_proc AS p
    WHERE p.oid = 'public.koaryu_release_schema_preflight_v4()'::regprocedure;

    IF v_body IS NULL
       OR v_owner <> 'postgres'
       OR v_security_definer IS DISTINCT FROM true
       OR v_config IS DISTINCT FROM ARRAY['search_path=pg_catalog']::TEXT[]
       OR v_acl IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' THEN
        RAISE EXCEPTION 'v22 preflight identity, execution mode, search_path, owner, or ACL drifted';
    END IF;

    v_old_count := (
        length(v_body) - length(replace(
            v_body,
            '61c8251b04d170bb4777de6c35570d024d6c97897ef1c524bc1adbcff97b7931',
            ''
        ))
    ) / 64;
    v_new_count := (
        length(v_body) - length(replace(
            v_body,
            'f9ce359c0ebf12039e8dfcb5308cd193ac18aa05cea23dad5b9f5208b0c51233',
            ''
        ))
    ) / 64;
    v_normalized_body_sha256 := encode(
        extensions.digest(
            convert_to(
                replace(
                    v_body,
                    'f9ce359c0ebf12039e8dfcb5308cd193ac18aa05cea23dad5b9f5208b0c51233',
                    '61c8251b04d170bb4777de6c35570d024d6c97897ef1c524bc1adbcff97b7931'
                ),
                'UTF8'
            ),
            'sha256'
        ),
        'hex'
    );

    IF (v_old_count + v_new_count) <> 1
       OR v_normalized_body_sha256 <> 'fb14fe74165bef5d03eed1164367c27c7c37b6f06aabcbdf41f2ab775721c0fb'
       OR position('d621d0bfa18b21571132a51108dd418e66996944fb7723bd3aeb624da7fe0e79' IN v_body) <> 0 THEN
        RAISE EXCEPTION 'v22 preflight is not the exact approved source or converged repair body';
    END IF;

    IF (SELECT count(*) FROM supabase_migrations.schema_migrations) <> 115
       OR (SELECT max(version) FROM supabase_migrations.schema_migrations) <> '20260822193000'
       OR private.koaryu_release_operational_manifest_v7()
          <> 'f9ce359c0ebf12039e8dfcb5308cd193ac18aa05cea23dad5b9f5208b0c51233' THEN
        RAISE EXCEPTION 'production is not the exact proved v22 restored state';
    END IF;

    SELECT * INTO v_preflight
    FROM public.koaryu_release_schema_preflight_v4();

    IF v_preflight.migration_count <> 115
       OR v_preflight.migration_head <> '20260822193000'
       OR v_preflight.manifest_version <> 'release-db-attestation-v22'
       OR v_preflight.pending_versions IS DISTINCT FROM ARRAY[
            '20260727100000','20260727110000','20260801050957','20260801060000',
            '20260801070000','20260801080000','20260801090000','20260801091000',
            '20260801092000','20260801093000','20260801094000','20260801105313',
            '20260801112153','20260801115044','20260801123112','20260801131844',
            '20260814043325','20260814103046','20260814105424','20260814114500',
            '20260814152000','20260814170000','20260814183000','20260814200000',
            '20260814213000','20260815220402','20260816012723','20260820012533',
            '20260820025759','20260820060216','20260822193000'
       ]::TEXT[]
       OR (
            v_old_count = 1
            AND (
                v_preflight.ready IS DISTINCT FROM false
                OR v_preflight.security_failures IS DISTINCT FROM
                   ARRAY['operational_semantic_acl_manifest_v7']::TEXT[]
            )
       )
       OR (
            v_new_count = 1
            AND (
                v_preflight.ready IS DISTINCT FROM true
                OR v_preflight.security_failures IS DISTINCT FROM ARRAY[]::TEXT[]
            )
       ) THEN
        RAISE EXCEPTION 'v22 preflight tuple is not the exact approved source or converged repair result';
    END IF;
END
$repair_guard$;

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
AS $schema_preflight_v4_restored_fingerprint$
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
       <> 'f9ce359c0ebf12039e8dfcb5308cd193ac18aa05cea23dad5b9f5208b0c51233' THEN
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
$schema_preflight_v4_restored_fingerprint$;

DO $repair_verify$
DECLARE
    v_body TEXT;
    v_owner NAME;
    v_security_definer BOOLEAN;
    v_config TEXT[];
    v_acl TEXT;
    v_preflight RECORD;
BEGIN
    SELECT p.prosrc,
           pg_get_userbyid(p.proowner),
           p.prosecdef,
           p.proconfig,
           p.proacl::TEXT
    INTO v_body, v_owner, v_security_definer, v_config, v_acl
    FROM pg_proc AS p
    WHERE p.oid = 'public.koaryu_release_schema_preflight_v4()'::regprocedure;

    IF v_owner <> 'postgres'
       OR v_security_definer IS DISTINCT FROM true
       OR v_config IS DISTINCT FROM ARRAY['search_path=pg_catalog']::TEXT[]
       OR v_acl IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}'
       OR position('f9ce359c0ebf12039e8dfcb5308cd193ac18aa05cea23dad5b9f5208b0c51233' IN v_body) = 0
       OR position('61c8251b04d170bb4777de6c35570d024d6c97897ef1c524bc1adbcff97b7931' IN v_body) <> 0
       OR position('d621d0bfa18b21571132a51108dd418e66996944fb7723bd3aeb624da7fe0e79' IN v_body) <> 0 THEN
        RAISE EXCEPTION 'repaired v22 preflight definition, owner, mode, search_path, or ACL is wrong';
    END IF;

    SELECT * INTO v_preflight
    FROM public.koaryu_release_schema_preflight_v4();

    IF v_preflight.ready IS DISTINCT FROM true
       OR v_preflight.migration_count <> 115
       OR v_preflight.migration_head <> '20260822193000'
       OR v_preflight.security_failures IS DISTINCT FROM ARRAY[]::TEXT[]
       OR v_preflight.manifest_version <> 'release-db-attestation-v22'
       OR private.koaryu_release_operational_manifest_v7()
          <> 'f9ce359c0ebf12039e8dfcb5308cd193ac18aa05cea23dad5b9f5208b0c51233' THEN
        RAISE EXCEPTION 'repaired v22 preflight did not converge to exact readiness';
    END IF;

    IF (SELECT count(*) FROM supabase_migrations.schema_migrations) <> 115
       OR (SELECT max(version) FROM supabase_migrations.schema_migrations) <> '20260822193000' THEN
        RAISE EXCEPTION 'repair moved migration history';
    END IF;
END
$repair_verify$;

COMMIT;
