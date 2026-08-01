-- Add the hosted operational drift signal for the exact 93-migration release.
-- Release authority remains the repository-pinned, operator-side raw-catalog
-- verifier; this function is deliberately not a cryptographic trust boundary.

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
      ('private', 'stripe_connect_account_identity_guards')
), constraint_scope_tables(schema_name, table_name) AS (
    SELECT schema_name, table_name FROM required_tables
    UNION ALL
    SELECT 'public', 'studio_payment_accounts'
), required_functions(signature) AS (
    VALUES
      ('public.preserve_studio_comp_provenance()'),
      ('public.set_studio_comp_atomic(uuid, boolean, text, uuid, text, boolean)'),
      ('public.clear_studio_comp_for_billing_event(uuid, bigint)'),
      ('public.record_stripe_live_billing_reconciliation_checkpoint(text, integer, integer, integer, integer, integer, integer, timestamp with time zone, timestamp with time zone, integer, integer, boolean, boolean, timestamp with time zone, text, text, uuid, text)'),
      ('public.record_stripe_live_billing_reconciliation_checkpoint_v2(jsonb, timestamp with time zone, text, text, uuid, text)'),
      ('public.authorize_studio_live_billing_mutation_atomic(uuid, text, text, text, text)'),
      ('public.authorize_connect_onboarding_bootstrap_account_create(uuid, text, integer, text, text, text, text, text)'),
      ('public.bind_connect_onboarding_bootstrap_account(uuid, text, integer, text, text, text)'),
      ('public.authorize_connect_onboarding_bootstrap_initial_link(uuid, text, integer, text, text, text, text, text)'),
      ('private.live_billing_event_is_in_scope(text, text)'),
      ('private.enforce_live_billing_checkpoint_processed_events()'),
      ('private.current_connect_account_generation(jsonb)'),
      ('private.bind_live_billing_authorization_checkpoint()'),
      ('public.set_studio_live_billing_authorization_atomic(uuid, text, boolean, timestamp with time zone, text, uuid, text, text)'),
      ('public.set_stripe_connect_account_exclusion_atomic(text, boolean, text, uuid, text)'),
      ('public.finish_stripe_event_processing_v2(uuid, text, text, text, text)'),
      ('public.prevent_operational_alert_append_only_mutation()'),
      ('public.enforce_operational_alert_sent_receipt()'),
      ('public.operational_alert_metric_counts()'),
      ('public.evaluate_operational_alert(text, text, bigint, integer, integer, text, text, text, text)'),
      ('public.evaluate_operational_alert(text, text, bigint, integer, integer, text, text, integer, text, text, text)'),
      ('public.acknowledge_operational_alert(text, uuid, text, text)'),
      ('public.claim_operational_alert_delivery(text, text, uuid, integer)'),
      ('public.complete_operational_alert_delivery(uuid, text, text)'),
      ('public.fail_operational_alert_delivery(uuid, text, text, integer)'),
      ('public.record_operational_alert_heartbeat(text, text, text)'),
      ('public.operational_alert_heartbeats(text)'),
      ('public.koaryu_release_schema_preflight()'),
      ('private.sync_connect_identity_mapping_guard()'),
      ('private.sync_connect_identity_exclusion_guard()')
), required_triggers(table_name, trigger_name) AS (
    VALUES
      ('studio_subscriptions', 'preserve_studio_comp_provenance_on_metadata_update'),
      ('studio_live_billing_authorizations', 'set_studio_live_billing_authorizations_updated_at'),
      ('stripe_connect_account_dispositions', 'set_stripe_connect_account_dispositions_updated_at'),
      ('studio_live_billing_authorizations', 'bind_live_billing_authorization_checkpoint'),
      ('stripe_connect_onboarding_bootstraps', 'set_stripe_connect_onboarding_bootstraps_updated_at'),
      ('stripe_live_billing_reconciliation_checkpoints', 'enforce_live_billing_checkpoint_processed_events'),
      ('operational_alert_delivery_attempts', 'prevent_operational_alert_attempt_mutation'),
      ('operational_alert_delivery_outcomes', 'prevent_operational_alert_outcome_mutation'),
      ('operational_alert_audit_events', 'prevent_operational_alert_audit_mutation'),
      ('operational_alert_outbox', 'enforce_operational_alert_sent_receipt'),
      ('studio_payment_accounts', 'sync_connect_identity_mapping_guard'),
      ('stripe_connect_account_dispositions', 'sync_connect_identity_exclusion_guard')
), function_rows AS (
    SELECT 'function:' || required.signature AS identity,
           coalesce(
             owner.rolname || ':' || language.lanname || ':' || function.prosecdef::TEXT || ':' ||
             coalesce(array_to_string(function.proconfig, ','), '') || ':' ||
             encode(extensions.digest(convert_to(function.prosrc, 'UTF8'), 'sha256'), 'hex') || ':' ||
             coalesce((
               SELECT string_agg(
                        coalesce(grantee.rolname, 'PUBLIC') || ':' || acl.privilege_type || ':' || acl.is_grantable::TEXT,
                        ',' ORDER BY coalesce(grantee.rolname, 'PUBLIC'), acl.privilege_type, acl.is_grantable
                      )
                 FROM aclexplode(coalesce(function.proacl, acldefault('f', function.proowner))) acl
                 LEFT JOIN pg_roles grantee ON grantee.oid = acl.grantee
             ), ''),
             'MISSING'
           ) AS state
      FROM required_functions required
      LEFT JOIN pg_proc function
        ON format('%I.%I(%s)',
             (SELECT nspname FROM pg_namespace WHERE oid = function.pronamespace),
             function.proname,
             oidvectortypes(function.proargtypes)
           ) = required.signature
      LEFT JOIN pg_roles owner ON owner.oid = function.proowner
      LEFT JOIN pg_language language ON language.oid = function.prolang
), preflight_acl_rows AS (
    SELECT 'function_acl:' || required.signature AS identity,
           coalesce((
             SELECT string_agg(
                      coalesce(grantee.rolname, 'PUBLIC') || ':' || acl.privilege_type || ':' || acl.is_grantable::TEXT,
                      ',' ORDER BY coalesce(grantee.rolname, 'PUBLIC'), acl.privilege_type, acl.is_grantable
                    )
               FROM aclexplode(coalesce(function.proacl, acldefault('f', function.proowner))) acl
               LEFT JOIN pg_roles grantee ON grantee.oid = acl.grantee
           ), 'MISSING') AS state
      FROM (VALUES
        ('private.koaryu_release_operational_manifest_v2()'),
        ('public.koaryu_release_schema_preflight_v2()')
      ) required(signature)
      LEFT JOIN pg_proc function ON function.oid = to_regprocedure(required.signature)
), table_rows AS (
    SELECT 'table:' || required.schema_name || '.' || required.table_name AS identity,
           coalesce(
             owner.rolname || ':' || relation.relrowsecurity::TEXT || ':' ||
             coalesce((
               SELECT string_agg(
                        coalesce(grantee.rolname, 'PUBLIC') || ':' || acl.privilege_type || ':' || acl.is_grantable::TEXT,
                        ',' ORDER BY coalesce(grantee.rolname, 'PUBLIC'), acl.privilege_type, acl.is_grantable
                      )
                 FROM aclexplode(coalesce(relation.relacl, acldefault('r', relation.relowner))) acl
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
), trigger_rows AS (
    SELECT 'trigger:' || required.table_name || '.' || required.trigger_name AS identity,
           coalesce(
             trigger.tgenabled::TEXT || ':' ||
             encode(extensions.digest(convert_to(pg_get_triggerdef(trigger.oid), 'UTF8'), 'sha256'), 'hex'),
             'MISSING'
           ) AS state
      FROM required_triggers required
      LEFT JOIN pg_class relation ON relation.relname = required.table_name
      LEFT JOIN pg_namespace namespace
        ON namespace.oid = relation.relnamespace AND namespace.nspname = 'public'
      LEFT JOIN pg_trigger trigger
        ON trigger.tgrelid = relation.oid
       AND trigger.tgname = required.trigger_name
       AND NOT trigger.tgisinternal
), index_rows AS (
    SELECT 'index:' || namespace.nspname || '.' || table_relation.relname || '.' || index_relation.relname AS identity,
           encode(extensions.digest(convert_to(pg_get_indexdef(index_state.indexrelid), 'UTF8'), 'sha256'), 'hex') AS state
      FROM pg_index index_state
      JOIN pg_class index_relation ON index_relation.oid = index_state.indexrelid
      JOIN pg_class table_relation ON table_relation.oid = index_state.indrelid
      JOIN pg_namespace namespace ON namespace.oid = table_relation.relnamespace
      JOIN constraint_scope_tables required
        ON required.schema_name = namespace.nspname
       AND required.table_name = table_relation.relname
), constraint_rows AS (
    SELECT 'constraint:' || namespace.nspname || '.' || relation.relname || '.' || constraint_state.conname AS identity,
           constraint_state.contype::TEXT || ':' || constraint_state.convalidated::TEXT || ':' ||
           encode(extensions.digest(convert_to(pg_get_constraintdef(constraint_state.oid), 'UTF8'), 'sha256'), 'hex') AS state
      FROM pg_constraint constraint_state
      JOIN pg_class relation ON relation.oid = constraint_state.conrelid
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      JOIN constraint_scope_tables required
        ON required.schema_name = namespace.nspname
       AND required.table_name = relation.relname
), manifest_rows AS (
    SELECT * FROM function_rows
    UNION ALL SELECT * FROM preflight_acl_rows
    UNION ALL SELECT * FROM table_rows
    UNION ALL SELECT * FROM trigger_rows
    UNION ALL SELECT * FROM index_rows
    UNION ALL SELECT * FROM constraint_rows
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

CREATE FUNCTION public.koaryu_release_schema_preflight_v2()
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

    -- V1 is retained and externally attested because migration 92 replaced it.
    -- Its 92-head history failure is superseded here; every object/security
    -- failure it can independently observe remains fail-closed.
    v_failures := array_remove(v_legacy.security_failures, 'migration_history');

    SELECT count(*)::INTEGER, max(version),
           array_agg(version ORDER BY version) FILTER (WHERE version >= '20260727100000'),
           count(*) FILTER (WHERE version < '20260727100000')::TEXT || ':' ||
             md5(string_agg(version || ':' || name, '|' ORDER BY version)
                 FILTER (WHERE version < '20260727100000'))
      INTO v_count, v_head, v_pending, v_baseline
      FROM supabase_migrations.schema_migrations;

    IF v_count <> 93
       OR v_head <> '20260801092000'
       OR v_pending IS DISTINCT FROM ARRAY[
           '20260727100000',
           '20260727110000',
           '20260801050957',
           '20260801060000',
           '20260801070000',
           '20260801080000',
           '20260801090000',
           '20260801091000',
           '20260801092000'
       ]::TEXT[]
       OR v_baseline <> '84:57ae4269ef4d75c249d59ef297661a3a' THEN
        v_failures := array_append(v_failures, 'migration_history_v2');
    END IF;

    IF private.koaryu_release_operational_manifest_v2()
       <> 'e7b3709c34874ef48baae2ca881d4e00a83e1d60aa3e2f47063bf6989d44be4a' THEN
        v_failures := array_append(v_failures, 'operational_semantic_acl_manifest_v2');
    END IF;

    RETURN QUERY SELECT
        cardinality(v_failures) = 0,
        v_count,
        v_head,
        COALESCE(v_pending, ARRAY[]::TEXT[]),
        v_failures,
        'release-db-attestation-v2';
END;
$$;

REVOKE ALL ON FUNCTION public.koaryu_release_schema_preflight_v2()
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.koaryu_release_schema_preflight_v2()
    TO service_role;

COMMENT ON FUNCTION public.koaryu_release_schema_preflight_v2() IS
    'Operational exact-head and semantic drift signal. Release authority is the repository-pinned operator raw-catalog verifier.';
