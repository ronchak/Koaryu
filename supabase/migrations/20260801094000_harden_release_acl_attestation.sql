-- Close the final ACL and hosted-certification gaps without rewriting the
-- already-applied release attestation migration. The raw-catalog verifier in
-- the repository remains release authority; this database manifest is only an
-- operational drift signal.

ALTER FUNCTION private.koaryu_release_operational_manifest_v2()
    RENAME TO koaryu_release_operational_manifest_v2_base;

REVOKE ALL ON FUNCTION private.koaryu_release_operational_manifest_v2_base()
    FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION private.koaryu_release_operational_manifest_v2()
RETURNS TEXT
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $$
WITH required_tables(schema_name, table_name) AS (
    VALUES
      ('public', 'studio_live_billing_authorizations'),
      ('public', 'stripe_live_billing_reconciliation_checkpoints'),
      ('public', 'stripe_connect_account_dispositions'),
      ('public', 'stripe_live_billing_reconciliation_account_evidence'),
      ('public', 'stripe_connect_onboarding_bootstraps'),
      ('public', 'operational_alert_episodes'),
      ('public', 'operational_alert_outbox'),
      ('public', 'operational_alert_delivery_attempts'),
      ('public', 'operational_alert_delivery_outcomes'),
      ('public', 'operational_alert_audit_events'),
      ('public', 'operational_alert_heartbeats'),
      ('private', 'stripe_connect_account_identity_guards'),
      ('public', 'studio_payment_accounts'),
      ('public', 'stripe_events')
), required_sequences(table_name, column_name) AS (
    VALUES
      ('stripe_live_billing_reconciliation_checkpoints', 'checkpoint_sequence'),
      ('stripe_events', 'live_billing_ingest_sequence'),
      ('operational_alert_audit_events', 'id')
), required_billing_functions(signature) AS (
    VALUES
      ('private.connect_onboarding_bootstrap_link_checkpoint(uuid, text)'),
      ('public.preflight_connect_onboarding_bootstrap_begin(uuid, text)'),
      ('public.preflight_connect_onboarding_bootstrap_resume(uuid, text)'),
      ('public.prepare_connect_onboarding_bootstrap_atomic(uuid, text, integer, jsonb, text, text, text, text)'),
      ('public.load_connect_onboarding_bootstrap_recovery_context(uuid, text)'),
      ('public.authorize_connect_onboarding_bootstrap_account_create_v2(uuid, uuid, text, integer, text, text)'),
      ('public.bind_connect_onboarding_bootstrap_account_v2(uuid, uuid, text, integer, text, text)'),
      ('public.authorize_connect_onboarding_bootstrap_initial_link_v2(uuid, uuid, text, integer, text, text, text, text)')
), required_recovery_columns(column_name) AS (
    VALUES ('recovery_context'), ('recovery_expires_at')
), base_row AS (
    SELECT 'base_manifest'::TEXT AS identity,
           private.koaryu_release_operational_manifest_v2_base() AS state
), table_acl_rows AS (
    SELECT 'table_acl:' || required.schema_name || '.' || required.table_name AS identity,
           coalesce(
             owner.rolname || ':' || coalesce((
               SELECT string_agg(
                        coalesce(grantor.rolname, 'PUBLIC') || '>' ||
                        coalesce(grantee.rolname, 'PUBLIC') || ':' ||
                        acl.privilege_type || ':' || acl.is_grantable::TEXT,
                        ',' ORDER BY coalesce(grantor.rolname, 'PUBLIC'),
                                     coalesce(grantee.rolname, 'PUBLIC'),
                                     acl.privilege_type, acl.is_grantable
                      )
                 FROM aclexplode(coalesce(relation.relacl, acldefault('r', relation.relowner))) acl
                 LEFT JOIN pg_roles grantor ON grantor.oid = acl.grantor
                 LEFT JOIN pg_roles grantee ON grantee.oid = acl.grantee
             ), ''),
             'MISSING'
           ) AS state
      FROM required_tables required
      LEFT JOIN pg_namespace namespace ON namespace.nspname = required.schema_name
      LEFT JOIN pg_class relation
        ON relation.relnamespace = namespace.oid
       AND relation.relname = required.table_name
       AND relation.relkind = 'r'
      LEFT JOIN pg_roles owner ON owner.oid = relation.relowner
), sequence_acl_rows AS (
    SELECT 'sequence_acl:' || required.table_name || '.' || required.column_name AS identity,
           coalesce(
             owner.rolname || ':' || sequence.relname || ':' || coalesce((
               SELECT string_agg(
                        coalesce(grantor.rolname, 'PUBLIC') || '>' ||
                        coalesce(grantee.rolname, 'PUBLIC') || ':' ||
                        acl.privilege_type || ':' || acl.is_grantable::TEXT,
                        ',' ORDER BY coalesce(grantor.rolname, 'PUBLIC'),
                                     coalesce(grantee.rolname, 'PUBLIC'),
                                     acl.privilege_type, acl.is_grantable
                      )
                 FROM aclexplode(coalesce(sequence.relacl, acldefault('S', sequence.relowner))) acl
                 LEFT JOIN pg_roles grantor ON grantor.oid = acl.grantor
                 LEFT JOIN pg_roles grantee ON grantee.oid = acl.grantee
             ), ''),
             'MISSING'
           ) AS state
      FROM required_sequences required
      LEFT JOIN pg_class table_relation
        ON table_relation.relname = required.table_name
       AND table_relation.relnamespace = to_regnamespace('public')
      LEFT JOIN pg_attribute attribute
        ON attribute.attrelid = table_relation.oid
       AND attribute.attname = required.column_name
      LEFT JOIN pg_depend dependency
        ON dependency.refobjid = table_relation.oid
       AND dependency.refobjsubid = attribute.attnum
       AND dependency.deptype IN ('a', 'i')
      LEFT JOIN pg_class sequence
        ON sequence.oid = dependency.objid
       AND sequence.relkind = 'S'
      LEFT JOIN pg_roles owner ON owner.oid = sequence.relowner
), billing_function_rows AS (
    SELECT 'billing_function:' || required.signature AS identity,
           coalesce(
             owner.rolname || ':' || language.lanname || ':' || function.prosecdef::TEXT || ':' ||
             coalesce(array_to_string(function.proconfig, ','), '') || ':' ||
             encode(extensions.digest(convert_to(function.prosrc, 'UTF8'), 'sha256'), 'hex') || ':' ||
             coalesce((
               SELECT string_agg(
                        coalesce(grantor.rolname, 'PUBLIC') || '>' ||
                        coalesce(grantee.rolname, 'PUBLIC') || ':' ||
                        acl.privilege_type || ':' || acl.is_grantable::TEXT,
                        ',' ORDER BY coalesce(grantor.rolname, 'PUBLIC'),
                                     coalesce(grantee.rolname, 'PUBLIC'),
                                     acl.privilege_type, acl.is_grantable
                      )
                 FROM aclexplode(coalesce(function.proacl, acldefault('f', function.proowner))) acl
                 LEFT JOIN pg_roles grantor ON grantor.oid = acl.grantor
                 LEFT JOIN pg_roles grantee ON grantee.oid = acl.grantee
             ), ''),
             'MISSING'
           ) AS state
      FROM required_billing_functions required
      LEFT JOIN pg_proc function ON function.oid = to_regprocedure(required.signature)
      LEFT JOIN pg_roles owner ON owner.oid = function.proowner
      LEFT JOIN pg_language language ON language.oid = function.prolang
), recovery_column_rows AS (
    SELECT 'recovery_column:' || required.column_name AS identity,
           coalesce(
             column_state.data_type || ':' || column_state.is_nullable || ':' ||
             column_state.is_identity || ':' || coalesce(column_state.column_default, ''),
             'MISSING'
           ) AS state
      FROM required_recovery_columns required
      LEFT JOIN information_schema.columns column_state
        ON column_state.table_schema = 'public'
       AND column_state.table_name = 'stripe_connect_onboarding_bootstraps'
       AND column_state.column_name = required.column_name
), manifest_rows AS (
    SELECT * FROM base_row
    UNION ALL SELECT * FROM table_acl_rows
    UNION ALL SELECT * FROM sequence_acl_rows
    UNION ALL SELECT * FROM billing_function_rows
    UNION ALL SELECT * FROM recovery_column_rows
)
SELECT encode(
         extensions.digest(
           convert_to(string_agg(identity || '=' || state, '|' ORDER BY identity), 'UTF8'),
           'sha256'
         ),
         'hex'
       )
  FROM manifest_rows
$$;

REVOKE ALL ON FUNCTION private.koaryu_release_operational_manifest_v2()
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
AS $$
DECLARE
    v_count INTEGER;
    v_head TEXT;
    v_pending TEXT[];
    v_baseline TEXT;
    v_legacy RECORD;
    v_failures TEXT[] := ARRAY[]::TEXT[];
BEGIN
    SELECT * INTO v_legacy
      FROM public.koaryu_release_schema_preflight();

    -- Migration 93 intentionally revoked the legacy bootstrap RPCs. V3
    -- supersedes that stale service-execute expectation with the exact stored
    -- function/ACL manifest above; all other independently observable V1
    -- failures remain fail-closed.
    v_failures := array_remove(
        array_remove(v_legacy.security_failures, 'migration_history'),
        'billing_alert_function_manifest'
    );

    SELECT count(*)::INTEGER, max(version),
           array_agg(version ORDER BY version) FILTER (WHERE version >= '20260727100000'),
           count(*) FILTER (WHERE version < '20260727100000')::TEXT || ':' ||
             md5(string_agg(version || ':' || name, '|' ORDER BY version)
                 FILTER (WHERE version < '20260727100000'))
      INTO v_count, v_head, v_pending, v_baseline
      FROM supabase_migrations.schema_migrations;

    IF v_count <> 95
       OR v_head <> '20260801094000'
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
           '20260801094000'
       ]::TEXT[]
       OR v_baseline <> '84:57ae4269ef4d75c249d59ef297661a3a' THEN
        v_failures := array_append(v_failures, 'migration_history_v3');
    END IF;

    IF private.koaryu_release_operational_manifest_v2()
       <> '53f7f07e127fcc6fc0c89717d603e31cc732a8ca49c7b86591f2c2711263831a' THEN
        v_failures := array_append(v_failures, 'operational_semantic_acl_manifest_v3');
    END IF;

    RETURN QUERY SELECT
        cardinality(v_failures) = 0,
        v_count,
        v_head,
        COALESCE(v_pending, ARRAY[]::TEXT[]),
        v_failures,
        'release-db-attestation-v3';
END;
$$;

REVOKE ALL ON FUNCTION public.koaryu_release_schema_preflight_v2()
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.koaryu_release_schema_preflight_v2()
    TO service_role;

COMMENT ON FUNCTION public.koaryu_release_schema_preflight_v2() IS
    'Operational exact-head and semantic drift signal. Release authority is the repository-pinned operator raw-catalog verifier.';
