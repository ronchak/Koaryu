-- Close the final column-level ACL visibility gap without rewriting V4.
-- The repository-pinned raw catalog remains release authority. This helper
-- compositionally carries the complete V4/V3 surface and adds every ordinary,
-- non-dropped column across the exact 14-table ACL scope. A NULL attacl is an
-- explicit empty column-ACL state; table privileges remain separately attested.

CREATE FUNCTION private.koaryu_release_operational_manifest_v5()
RETURNS TEXT
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $$
WITH acl_scope_tables(schema_name, table_name) AS (
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
), column_acl_rows AS (
    SELECT namespace.nspname AS schema_name,
           relation.relname AS table_name,
           attribute.attnum,
           attribute.attname AS column_name,
           coalesce((
             SELECT string_agg(
                      coalesce(grantor.rolname, 'PUBLIC') || '>' ||
                      coalesce(grantee.rolname, 'PUBLIC') || ':' ||
                      acl.privilege_type || ':' || acl.is_grantable::TEXT,
                      ',' ORDER BY coalesce(grantor.rolname, 'PUBLIC'),
                                   coalesce(grantee.rolname, 'PUBLIC'),
                                   acl.privilege_type, acl.is_grantable
                    )
               FROM aclexplode(attribute.attacl) acl
               LEFT JOIN pg_roles grantor ON grantor.oid = acl.grantor
               LEFT JOIN pg_roles grantee ON grantee.oid = acl.grantee
           ), '') AS acl_state
      FROM pg_class relation
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      JOIN acl_scope_tables covered
        ON covered.schema_name = namespace.nspname
       AND covered.table_name = relation.relname
      JOIN pg_attribute attribute
        ON attribute.attrelid = relation.oid
       AND attribute.attnum > 0
       AND NOT attribute.attisdropped
     WHERE relation.relkind = 'r'
), column_acl_summary AS (
    SELECT count(*)::TEXT AS column_count,
           encode(
             extensions.digest(
               convert_to(
                 coalesce(string_agg(
                   schema_name || '.' || table_name || ':' || attnum::TEXT || ':' ||
                   column_name || ':' || acl_state,
                   '|' ORDER BY schema_name, table_name, attnum
                 ), ''),
                 'UTF8'
               ),
               'sha256'
             ),
             'hex'
           ) AS column_acl_sha256
      FROM column_acl_rows
), manifest_rows(identity, state) AS (
    SELECT 'prior_v4_surface', private.koaryu_release_operational_manifest_v4()
    UNION ALL
    SELECT 'column_acl_count', column_count FROM column_acl_summary
    UNION ALL
    SELECT 'column_acl_sha256', column_acl_sha256 FROM column_acl_summary
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

REVOKE ALL ON FUNCTION private.koaryu_release_operational_manifest_v5()
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

    -- V5 preserves every independent V1 check except the stale history and
    -- pre-V3 function manifest signals superseded by the exact manifests.
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

    IF v_count <> 98
       OR v_head <> '20260801115044'
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
           '20260801115044'
       ]::TEXT[]
       OR v_baseline <> '84:57ae4269ef4d75c249d59ef297661a3a' THEN
        v_failures := array_append(v_failures, 'migration_history_v5');
    END IF;

    IF private.koaryu_release_operational_manifest_v5()
       <> '7f3329d8adc0bebbdf63f23da1e40df88984c177917cc613df664eeb4ffc478e' THEN
        v_failures := array_append(v_failures, 'operational_semantic_acl_manifest_v5');
    END IF;

    RETURN QUERY SELECT
        cardinality(v_failures) = 0,
        v_count,
        v_head,
        COALESCE(v_pending, ARRAY[]::TEXT[]),
        v_failures,
        'release-db-attestation-v5';
END;
$$;

REVOKE ALL ON FUNCTION public.koaryu_release_schema_preflight_v2()
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.koaryu_release_schema_preflight_v2()
    TO service_role;

COMMENT ON FUNCTION public.koaryu_release_schema_preflight_v2() IS
    'Operational exact-head and column-ACL drift signal through release attestation V5. Release authority remains the repository-pinned operator raw-catalog verifier; hosted exposed-schema and schema ACL readback are separate operator gates.';
