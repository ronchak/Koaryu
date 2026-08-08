-- Extend the operational release drift signal through the final Connect
-- delivery-state migration without rewriting the already-landed V3 attestor.
-- The repository-pinned raw catalog remains release authority. This helper
-- compositionally carries the V3 surface and adds every migration-96 object;
-- it deliberately does not attest its own body.

CREATE FUNCTION private.koaryu_release_operational_manifest_v4()
RETURNS TEXT
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $$
WITH required_delivery_columns(column_name) AS (
    VALUES
      ('initial_link_response_sha256'),
      ('initial_link_response_recorded_at'),
      ('initial_link_delivery_receipt_sha256'),
      ('initial_link_delivery_receipt_expires_at'),
      ('initial_link_delivered_at'),
      ('initial_link_support_required_at')
), required_delivery_constraints(constraint_name) AS (
    VALUES
      ('stripe_connect_onboarding_bootstraps_response_hash'),
      ('stripe_connect_onboarding_bootstraps_receipt_hash'),
      ('stripe_connect_onboarding_bootstraps_response_pair'),
      ('stripe_connect_onboarding_bootstraps_receipt_pair'),
      ('stripe_connect_onboarding_bootstraps_delivery_order'),
      ('stripe_connect_onboarding_bootstraps_receipt_expiry'),
      ('stripe_connect_onboarding_bootstraps_delivered_state'),
      ('stripe_connect_onboarding_bootstraps_terminal_state')
), required_delivery_indexes(index_name) AS (
    VALUES ('idx_stripe_connect_onboarding_bootstraps_delivery_receipt')
), required_delivery_functions(signature) AS (
    VALUES
      ('public.preflight_connect_onboarding_bootstrap_resume(uuid, text)'),
      ('public.authorize_connect_onboarding_bootstrap_initial_link_v2(uuid, uuid, text, integer, text, text, text, text)'),
      ('public.record_connect_onboarding_bootstrap_initial_link_response(uuid, uuid, text, integer, text, text, text, text, text, text)'),
      ('public.acknowledge_connect_onboarding_bootstrap_initial_link_delivery(uuid, text, text)')
), prior_manifest_row AS (
    SELECT 'prior_v3_surface'::TEXT AS identity,
           private.koaryu_release_operational_manifest_v2() AS state
), delivery_column_rows AS (
    SELECT 'delivery_column:' || required.column_name AS identity,
           coalesce(
             column_state.data_type || ':' || column_state.is_nullable || ':' ||
             column_state.is_identity || ':' || coalesce(column_state.column_default, ''),
             'MISSING'
           ) AS state
      FROM required_delivery_columns required
      LEFT JOIN information_schema.columns column_state
        ON column_state.table_schema = 'public'
       AND column_state.table_name = 'stripe_connect_onboarding_bootstraps'
       AND column_state.column_name = required.column_name
), delivery_constraint_rows AS (
    SELECT 'delivery_constraint:' || required.constraint_name AS identity,
           coalesce(
             constraint_state.contype::TEXT || ':' || constraint_state.convalidated::TEXT || ':' ||
             encode(
               extensions.digest(
                 convert_to(pg_get_constraintdef(constraint_state.oid), 'UTF8'),
                 'sha256'
               ),
               'hex'
             ),
             'MISSING'
           ) AS state
      FROM required_delivery_constraints required
      LEFT JOIN pg_constraint constraint_state
        ON constraint_state.conrelid = 'public.stripe_connect_onboarding_bootstraps'::REGCLASS
       AND constraint_state.conname = required.constraint_name
), delivery_index_rows AS (
    SELECT 'delivery_index:' || required.index_name AS identity,
           coalesce(
             owner.rolname || ':' || index_state.indisunique::TEXT || ':' ||
             (index_state.indpred IS NOT NULL)::TEXT || ':' ||
             index_state.indisvalid::TEXT || ':' || index_state.indisready::TEXT || ':' ||
             encode(
               extensions.digest(
                 convert_to(pg_get_indexdef(index_state.indexrelid), 'UTF8'),
                 'sha256'
               ),
               'hex'
             ),
             'MISSING'
           ) AS state
      FROM required_delivery_indexes required
      LEFT JOIN pg_class index_relation
        ON index_relation.relnamespace = to_regnamespace('public')
       AND index_relation.relname = required.index_name
       AND index_relation.relkind = 'i'
      LEFT JOIN pg_index index_state ON index_state.indexrelid = index_relation.oid
      LEFT JOIN pg_roles owner ON owner.oid = index_relation.relowner
), delivery_function_rows AS (
    SELECT 'delivery_function:' || required.signature AS identity,
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
      FROM required_delivery_functions required
      LEFT JOIN pg_proc function ON function.oid = to_regprocedure(required.signature)
      LEFT JOIN pg_roles owner ON owner.oid = function.proowner
      LEFT JOIN pg_language language ON language.oid = function.prolang
), manifest_rows AS (
    SELECT * FROM prior_manifest_row
    UNION ALL SELECT * FROM delivery_column_rows
    UNION ALL SELECT * FROM delivery_constraint_rows
    UNION ALL SELECT * FROM delivery_index_rows
    UNION ALL SELECT * FROM delivery_function_rows
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

REVOKE ALL ON FUNCTION private.koaryu_release_operational_manifest_v4()
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

    -- V4 preserves the independent V1 checks except the stale history and
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

    IF v_count <> 97
       OR v_head <> '20260801112153'
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
           '20260801112153'
       ]::TEXT[]
       OR v_baseline <> '84:57ae4269ef4d75c249d59ef297661a3a' THEN
        v_failures := array_append(v_failures, 'migration_history_v4');
    END IF;

    IF private.koaryu_release_operational_manifest_v4()
       <> 'a490b80a20d18bc23e194c4d0ca4917c02c4c200f18a8c43d15f863e2f34b037' THEN
        v_failures := array_append(v_failures, 'operational_semantic_acl_manifest_v4');
    END IF;

    RETURN QUERY SELECT
        cardinality(v_failures) = 0,
        v_count,
        v_head,
        COALESCE(v_pending, ARRAY[]::TEXT[]),
        v_failures,
        'release-db-attestation-v4';
END;
$$;

REVOKE ALL ON FUNCTION public.koaryu_release_schema_preflight_v2()
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.koaryu_release_schema_preflight_v2()
    TO service_role;

COMMENT ON FUNCTION public.koaryu_release_schema_preflight_v2() IS
    'Operational exact-head and semantic drift signal through Connect delivery retirement. Release authority is the repository-pinned operator raw-catalog verifier.';
