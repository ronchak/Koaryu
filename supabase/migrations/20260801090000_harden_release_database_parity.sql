-- Final database-parity repair for the launch candidate.
--
-- This migration deliberately runs after the reserved 070000 billing and
-- 080000 alert migrations. It is additive because 050957 and 060000 may
-- already have been rehearsed outside production.

DO $$
DECLARE
    v_checkpoint_sequence REGCLASS;
    v_audit_sequence REGCLASS;
    v_event_sequence REGCLASS;
BEGIN
    v_checkpoint_sequence := pg_get_serial_sequence(
        'public.stripe_live_billing_reconciliation_checkpoints',
        'checkpoint_sequence'
    )::REGCLASS;
    v_audit_sequence := pg_get_serial_sequence(
        'public.operational_alert_audit_events',
        'id'
    )::REGCLASS;
    v_event_sequence := pg_get_serial_sequence(
        'public.stripe_events',
        'live_billing_ingest_sequence'
    )::REGCLASS;
    IF v_checkpoint_sequence IS NULL OR v_audit_sequence IS NULL
       OR v_event_sequence IS NULL THEN
        RAISE EXCEPTION 'Required release identity sequence dependency is missing.';
    END IF;
    EXECUTE format(
        'REVOKE ALL ON SEQUENCE %s FROM PUBLIC, anon, authenticated, service_role',
        v_checkpoint_sequence
    );
    EXECUTE format(
        'REVOKE ALL ON SEQUENCE %s FROM PUBLIC, anon, authenticated, service_role',
        v_audit_sequence
    );
    EXECUTE format(
        'REVOKE ALL ON SEQUENCE %s FROM PUBLIC, anon, authenticated, service_role',
        v_event_sequence
    );
    EXECUTE format(
        'GRANT USAGE, SELECT ON SEQUENCE %s TO service_role',
        v_audit_sequence
    );
    EXECUTE format(
        'GRANT USAGE, SELECT ON SEQUENCE %s TO service_role',
        v_checkpoint_sequence
    );
    EXECUTE format(
        'GRANT USAGE, SELECT ON SEQUENCE %s TO service_role',
        v_event_sequence
    );
END;
$$;

-- One row is the serialized source of truth for whether a Connect identity is
-- mapped or excluded. Both public source tables update this row through AFTER
-- triggers. Concurrent opposite-direction UPSERTs therefore contend on the
-- same primary-key row, and the CHECK constraint rejects the losing state.
CREATE TABLE private.stripe_connect_account_identity_guards (
    stripe_connected_account_id TEXT PRIMARY KEY CHECK (
        stripe_connected_account_id ~ '^acct_[A-Za-z0-9]+$'
    ),
    mapped_studio_id UUID UNIQUE
        REFERENCES public.studio_payment_accounts(studio_id) ON DELETE SET NULL,
    excluded BOOLEAN NOT NULL DEFAULT false,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CHECK (mapped_studio_id IS NULL OR NOT excluded)
);

REVOKE ALL ON TABLE private.stripe_connect_account_identity_guards
    FROM PUBLIC, anon, authenticated, service_role;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
          FROM public.studio_payment_accounts account
          JOIN public.stripe_connect_account_dispositions disposition
            ON disposition.stripe_connected_account_id = account.stripe_connected_account_id
         WHERE account.stripe_connected_account_id IS NOT NULL
           AND disposition.excluded
    ) THEN
        RAISE EXCEPTION 'Existing Connect identity is both mapped and excluded.'
            USING ERRCODE = '23514';
    END IF;
END;
$$;

INSERT INTO private.stripe_connect_account_identity_guards (
    stripe_connected_account_id,
    mapped_studio_id,
    excluded
)
SELECT account.stripe_connected_account_id, account.studio_id, false
  FROM public.studio_payment_accounts account
 WHERE account.stripe_connected_account_id IS NOT NULL;

INSERT INTO private.stripe_connect_account_identity_guards AS guard (
    stripe_connected_account_id,
    excluded
)
SELECT disposition.stripe_connected_account_id, disposition.excluded
  FROM public.stripe_connect_account_dispositions disposition
ON CONFLICT (stripe_connected_account_id) DO UPDATE
   SET excluded = EXCLUDED.excluded,
       updated_at = clock_timestamp();

CREATE FUNCTION private.sync_connect_identity_mapping_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
    IF TG_OP IN ('UPDATE', 'DELETE')
       AND OLD.stripe_connected_account_id IS NOT NULL
       AND (
           TG_OP = 'DELETE'
           OR OLD.stripe_connected_account_id IS DISTINCT FROM NEW.stripe_connected_account_id
       ) THEN
        UPDATE private.stripe_connect_account_identity_guards guard
           SET mapped_studio_id = NULL,
               updated_at = clock_timestamp()
         WHERE guard.stripe_connected_account_id = OLD.stripe_connected_account_id
           AND guard.mapped_studio_id = OLD.studio_id;
    END IF;

    IF TG_OP <> 'DELETE' AND NEW.stripe_connected_account_id IS NOT NULL THEN
        INSERT INTO private.stripe_connect_account_identity_guards AS guard (
            stripe_connected_account_id,
            mapped_studio_id,
            excluded
        ) VALUES (
            NEW.stripe_connected_account_id,
            NEW.studio_id,
            false
        )
        ON CONFLICT (stripe_connected_account_id) DO UPDATE
           SET mapped_studio_id = EXCLUDED.mapped_studio_id,
               updated_at = clock_timestamp();
    END IF;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$;

CREATE FUNCTION private.sync_connect_identity_exclusion_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
    IF TG_OP IN ('UPDATE', 'DELETE')
       AND (
           TG_OP = 'DELETE'
           OR OLD.stripe_connected_account_id IS DISTINCT FROM NEW.stripe_connected_account_id
       ) THEN
        UPDATE private.stripe_connect_account_identity_guards guard
           SET excluded = false,
               updated_at = clock_timestamp()
         WHERE guard.stripe_connected_account_id = OLD.stripe_connected_account_id;
    END IF;

    IF TG_OP <> 'DELETE' THEN
        INSERT INTO private.stripe_connect_account_identity_guards AS guard (
            stripe_connected_account_id,
            excluded
        ) VALUES (
            NEW.stripe_connected_account_id,
            NEW.excluded
        )
        ON CONFLICT (stripe_connected_account_id) DO UPDATE
           SET excluded = EXCLUDED.excluded,
               updated_at = clock_timestamp();
    END IF;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION private.sync_connect_identity_mapping_guard()
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.sync_connect_identity_exclusion_guard()
    FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER sync_connect_identity_mapping_guard
    AFTER INSERT OR UPDATE OF stripe_connected_account_id OR DELETE
    ON public.studio_payment_accounts
    FOR EACH ROW
    EXECUTE FUNCTION private.sync_connect_identity_mapping_guard();

CREATE TRIGGER sync_connect_identity_exclusion_guard
    AFTER INSERT OR UPDATE OF stripe_connected_account_id, excluded OR DELETE
    ON public.stripe_connect_account_dispositions
    FOR EACH ROW
    EXECUTE FUNCTION private.sync_connect_identity_exclusion_guard();

-- Hosted readiness calls this service-role-only RPC. It is intentionally
-- formatting-independent: checks use catalog identities, privilege predicates,
-- RLS flags, and structural flags rather than pg_get_* rendering hashes.
CREATE FUNCTION public.koaryu_release_schema_preflight()
RETURNS TABLE (
    ready BOOLEAN,
    migration_count INTEGER,
    migration_head TEXT,
    pending_versions TEXT[],
    security_failures TEXT[]
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
    v_failures TEXT[] := ARRAY[]::TEXT[];
    v_required_tables CONSTANT TEXT[] := ARRAY[
        'operational_alert_audit_events',
        'operational_alert_delivery_attempts',
        'operational_alert_delivery_outcomes',
        'operational_alert_episodes',
        'operational_alert_heartbeats',
        'operational_alert_outbox',
        'stripe_connect_account_dispositions',
        'stripe_live_billing_reconciliation_account_evidence',
        'stripe_live_billing_reconciliation_checkpoints',
        'studio_live_billing_authorizations'
    ];
    v_required_functions CONSTANT TEXT[] := ARRAY[
        'public.claim_operational_alert_delivery(text,text,uuid,integer)',
        'public.clear_studio_comp_for_billing_event(uuid,bigint)',
        'public.complete_operational_alert_delivery(uuid,text,text)',
        'public.enforce_operational_alert_sent_receipt()',
        'public.evaluate_operational_alert(text,text,bigint,integer,integer,text,text,text,text)',
        'public.evaluate_operational_alert(text,text,bigint,integer,integer,text,text,integer,text,text,text)',
        'public.fail_operational_alert_delivery(uuid,text,text,integer)',
        'public.finish_stripe_event_processing_v2(uuid,text,text,text,text)',
        'public.koaryu_release_schema_preflight()',
        'public.operational_alert_heartbeats(text)',
        'public.operational_alert_metric_counts()',
        'public.preserve_studio_comp_provenance()',
        'public.prevent_operational_alert_append_only_mutation()',
        'public.record_operational_alert_heartbeat(text,text,text)',
        'public.record_stripe_live_billing_reconciliation_checkpoint(text,integer,integer,integer,integer,integer,integer,timestamp with time zone,timestamp with time zone,integer,integer,boolean,boolean,timestamp with time zone,text,text,uuid,text)',
        'public.record_stripe_live_billing_reconciliation_checkpoint_v2(jsonb,timestamp with time zone,text,text,uuid,text)',
        'public.authorize_studio_live_billing_mutation_atomic(uuid,text,text,text,text)',
        'public.acknowledge_operational_alert(text,uuid,text,text)',
        'private.current_connect_account_generation(jsonb)',
        'private.bind_live_billing_authorization_checkpoint()',
        'public.set_stripe_connect_account_exclusion_atomic(text,boolean,text,uuid,text)',
        'public.set_studio_comp_atomic(uuid,boolean,text,uuid,text,boolean)',
        'public.set_studio_live_billing_authorization_atomic(uuid,text,boolean,timestamp with time zone,text,uuid,text,text)'
    ];
    v_function TEXT;
    v_table TEXT;
BEGIN
    SELECT count(*)::INTEGER, max(version),
           array_agg(version ORDER BY version) FILTER (WHERE version >= '20260727100000'),
           count(*) FILTER (WHERE version < '20260727100000')::TEXT || ':' ||
             md5(string_agg(version || ':' || name, '|' ORDER BY version)
                 FILTER (WHERE version < '20260727100000'))
      INTO v_count, v_head, v_pending, v_baseline
      FROM supabase_migrations.schema_migrations;

    IF v_count <> 91
       OR v_head <> '20260801090000'
       OR v_pending IS DISTINCT FROM ARRAY[
           '20260727100000',
           '20260727110000',
           '20260801050957',
           '20260801060000',
           '20260801070000',
           '20260801080000',
           '20260801090000'
       ]::TEXT[]
       OR v_baseline <> '84:57ae4269ef4d75c249d59ef297661a3a' THEN
        v_failures := array_append(v_failures, 'migration_history');
    END IF;

    FOREACH v_table IN ARRAY v_required_tables LOOP
        IF NOT EXISTS (
            SELECT 1
              FROM pg_class relation
              JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
             WHERE namespace.nspname = 'public'
               AND relation.relname = v_table
               AND relation.relkind = 'r'
               AND relation.relrowsecurity
               AND NOT EXISTS (
                   SELECT 1
                     FROM aclexplode(coalesce(
                         relation.relacl,
                         acldefault('r', relation.relowner)
                     )) acl
                    WHERE acl.grantee = 0
                      AND acl.privilege_type IN (
                          'SELECT', 'INSERT', 'UPDATE', 'DELETE',
                          'TRUNCATE', 'REFERENCES', 'TRIGGER'
                      )
               )
               AND NOT has_table_privilege('anon', relation.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
               AND NOT has_table_privilege('authenticated', relation.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        ) THEN
            v_failures := array_append(v_failures, 'table:' || v_table);
        END IF;
    END LOOP;

    IF EXISTS (
        WITH expected(
            table_name, policy_name, permissive, command_name,
            role_names, predicate_kind
        ) AS (
            VALUES
              ('studio_live_billing_authorizations', 'studio_live_billing_authorizations_no_client_access', false, '*', 'anon,authenticated', 'deny_all'),
              ('studio_live_billing_authorizations', 'reject_ambiguous_staff_membership_access', false, '*', 'authenticated', 'membership_guard'),
              ('stripe_live_billing_reconciliation_checkpoints', 'stripe_live_billing_reconciliation_checkpoints_no_client_access', false, '*', 'anon,authenticated', 'deny_all'),
              ('stripe_live_billing_reconciliation_checkpoints', 'reject_ambiguous_staff_membership_access', false, '*', 'authenticated', 'membership_guard'),
              ('stripe_connect_account_dispositions', 'stripe_connect_account_dispositions_no_client_access', false, '*', 'anon,authenticated', 'deny_all'),
              ('stripe_connect_account_dispositions', 'reject_ambiguous_staff_membership_access', false, '*', 'authenticated', 'membership_guard'),
              ('stripe_live_billing_reconciliation_account_evidence', 'stripe_live_billing_account_evidence_no_client_access', false, '*', 'anon,authenticated', 'deny_all'),
              ('stripe_live_billing_reconciliation_account_evidence', 'reject_ambiguous_staff_membership_access', false, '*', 'authenticated', 'membership_guard'),
              ('operational_alert_episodes', 'reject_ambiguous_staff_membership_access', false, '*', 'authenticated', 'membership_guard'),
              ('operational_alert_outbox', 'reject_ambiguous_staff_membership_access', false, '*', 'authenticated', 'membership_guard'),
              ('operational_alert_delivery_attempts', 'reject_ambiguous_staff_membership_access', false, '*', 'authenticated', 'membership_guard'),
              ('operational_alert_delivery_outcomes', 'reject_ambiguous_staff_membership_access', false, '*', 'authenticated', 'membership_guard'),
              ('operational_alert_audit_events', 'reject_ambiguous_staff_membership_access', false, '*', 'authenticated', 'membership_guard'),
              ('operational_alert_heartbeats', 'reject_ambiguous_staff_membership_access', false, '*', 'authenticated', 'membership_guard')
        ),
        actual AS (
            SELECT relation.relname AS table_name,
                   policy.polname AS policy_name,
                   policy.polpermissive AS permissive,
                   policy.polcmd::TEXT AS command_name,
                   (
                       SELECT string_agg(role.rolname, ',' ORDER BY role.rolname)
                         FROM unnest(policy.polroles) role_oid
                         JOIN pg_roles role ON role.oid = role_oid
                   ) AS role_names,
                   CASE
                     WHEN regexp_replace(pg_get_expr(policy.polqual, policy.polrelid), '[[:space:]()]', '', 'g') = 'false'
                      AND regexp_replace(pg_get_expr(policy.polwithcheck, policy.polrelid), '[[:space:]()]', '', 'g') = 'false'
                       THEN 'deny_all'
                     WHEN regexp_replace(
                            regexp_replace(pg_get_expr(policy.polqual, policy.polrelid), '[[:space:]()]', '', 'g'),
                            'AShas_unambiguous_studio_membership$', ''
                          ) = 'SELECTprivate.has_unambiguous_studio_membership'
                      AND regexp_replace(
                            regexp_replace(pg_get_expr(policy.polwithcheck, policy.polrelid), '[[:space:]()]', '', 'g'),
                            'AShas_unambiguous_studio_membership$', ''
                          ) = 'SELECTprivate.has_unambiguous_studio_membership'
                       THEN 'membership_guard'
                     ELSE 'unexpected'
                   END AS predicate_kind
              FROM pg_policy policy
              JOIN pg_class relation ON relation.oid = policy.polrelid
              JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
             WHERE namespace.nspname = 'public'
               AND relation.relname = ANY(v_required_tables)
        ),
        compared AS (
            SELECT expected.table_name AS expected_table,
                   actual.table_name AS actual_table,
                   expected.policy_name AS expected_policy,
                   actual.policy_name AS actual_policy,
                   expected.permissive AS expected_permissive,
                   actual.permissive AS actual_permissive,
                   expected.command_name AS expected_command,
                   actual.command_name AS actual_command,
                   expected.role_names AS expected_roles,
                   actual.role_names AS actual_roles,
                   expected.predicate_kind AS expected_predicate,
                   actual.predicate_kind AS actual_predicate
              FROM expected
              FULL JOIN actual USING (table_name, policy_name)
        )
        SELECT 1
          FROM compared
         WHERE expected_table IS NULL
            OR actual_table IS NULL
            OR actual_permissive IS DISTINCT FROM expected_permissive
            OR actual_command IS DISTINCT FROM expected_command
            OR actual_roles IS DISTINCT FROM expected_roles
            OR actual_predicate IS DISTINCT FROM expected_predicate
    ) THEN
        v_failures := array_append(v_failures, 'policy_manifest');
    END IF;

    IF to_regclass('private.stripe_connect_account_identity_guards') IS NULL
       OR has_table_privilege('anon', 'private.stripe_connect_account_identity_guards', 'SELECT,INSERT,UPDATE,DELETE')
       OR has_table_privilege('authenticated', 'private.stripe_connect_account_identity_guards', 'SELECT,INSERT,UPDATE,DELETE')
       OR has_table_privilege('service_role', 'private.stripe_connect_account_identity_guards', 'SELECT,INSERT,UPDATE,DELETE')
       OR EXISTS (
           SELECT 1
             FROM pg_class relation
             JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
             CROSS JOIN LATERAL aclexplode(coalesce(
                 relation.relacl,
                 acldefault('r', relation.relowner)
             )) acl
            WHERE namespace.nspname = 'private'
              AND relation.relname = 'stripe_connect_account_identity_guards'
              AND acl.grantee = 0
       ) THEN
        v_failures := array_append(v_failures, 'private_identity_guard');
    END IF;

    IF pg_get_serial_sequence('public.stripe_live_billing_reconciliation_checkpoints', 'checkpoint_sequence') IS NULL
       OR pg_get_serial_sequence('public.operational_alert_audit_events', 'id') IS NULL
       OR pg_get_serial_sequence('public.stripe_events', 'live_billing_ingest_sequence') IS NULL
       OR has_sequence_privilege('anon', pg_get_serial_sequence('public.stripe_live_billing_reconciliation_checkpoints', 'checkpoint_sequence'), 'USAGE,SELECT,UPDATE')
       OR has_sequence_privilege('authenticated', pg_get_serial_sequence('public.stripe_live_billing_reconciliation_checkpoints', 'checkpoint_sequence'), 'USAGE,SELECT,UPDATE')
       OR has_sequence_privilege('anon', pg_get_serial_sequence('public.operational_alert_audit_events', 'id'), 'USAGE,SELECT,UPDATE')
       OR has_sequence_privilege('authenticated', pg_get_serial_sequence('public.operational_alert_audit_events', 'id'), 'USAGE,SELECT,UPDATE')
       OR has_sequence_privilege('anon', pg_get_serial_sequence('public.stripe_events', 'live_billing_ingest_sequence'), 'USAGE,SELECT,UPDATE')
       OR has_sequence_privilege('authenticated', pg_get_serial_sequence('public.stripe_events', 'live_billing_ingest_sequence'), 'USAGE,SELECT,UPDATE')
       OR NOT has_sequence_privilege('service_role', pg_get_serial_sequence('public.stripe_live_billing_reconciliation_checkpoints', 'checkpoint_sequence'), 'USAGE')
       OR NOT has_sequence_privilege('service_role', pg_get_serial_sequence('public.stripe_live_billing_reconciliation_checkpoints', 'checkpoint_sequence'), 'SELECT')
       OR has_sequence_privilege('service_role', pg_get_serial_sequence('public.stripe_live_billing_reconciliation_checkpoints', 'checkpoint_sequence'), 'UPDATE')
       OR NOT has_sequence_privilege('service_role', pg_get_serial_sequence('public.operational_alert_audit_events', 'id'), 'USAGE')
       OR NOT has_sequence_privilege('service_role', pg_get_serial_sequence('public.operational_alert_audit_events', 'id'), 'SELECT')
       OR has_sequence_privilege('service_role', pg_get_serial_sequence('public.operational_alert_audit_events', 'id'), 'UPDATE')
       OR NOT has_sequence_privilege('service_role', pg_get_serial_sequence('public.stripe_events', 'live_billing_ingest_sequence'), 'USAGE')
       OR NOT has_sequence_privilege('service_role', pg_get_serial_sequence('public.stripe_events', 'live_billing_ingest_sequence'), 'SELECT')
       OR has_sequence_privilege('service_role', pg_get_serial_sequence('public.stripe_events', 'live_billing_ingest_sequence'), 'UPDATE')
       OR EXISTS (
           SELECT 1
             FROM pg_class sequence
             JOIN pg_namespace namespace ON namespace.oid = sequence.relnamespace
             CROSS JOIN LATERAL aclexplode(coalesce(
                 sequence.relacl,
                 acldefault('S', sequence.relowner)
             )) acl
            WHERE namespace.nspname = 'public'
              AND sequence.oid IN (
                  to_regclass(pg_get_serial_sequence('public.stripe_live_billing_reconciliation_checkpoints', 'checkpoint_sequence')),
                  to_regclass(pg_get_serial_sequence('public.operational_alert_audit_events', 'id')),
                  to_regclass(pg_get_serial_sequence('public.stripe_events', 'live_billing_ingest_sequence'))
              )
              AND acl.grantee = 0
       ) THEN
        v_failures := array_append(v_failures, 'sequence_acl');
    END IF;

    FOREACH v_function IN ARRAY v_required_functions LOOP
        IF to_regprocedure(v_function) IS NULL
           OR has_function_privilege('anon', v_function, 'EXECUTE')
           OR has_function_privilege('authenticated', v_function, 'EXECUTE')
           OR EXISTS (
               SELECT 1
                 FROM pg_proc function
                WHERE function.oid = to_regprocedure(v_function)
                  AND EXISTS (
                      SELECT 1
                        FROM aclexplode(coalesce(
                            function.proacl,
                            acldefault('f', function.proowner)
                        )) acl
                       WHERE acl.grantee = 0
                         AND acl.privilege_type = 'EXECUTE'
                  )
           ) THEN
            v_failures := array_append(v_failures, 'function:' || v_function);
        END IF;
    END LOOP;

    IF NOT has_table_privilege('service_role', 'public.stripe_live_billing_reconciliation_account_evidence', 'SELECT')
       OR has_table_privilege('service_role', 'public.stripe_live_billing_reconciliation_account_evidence', 'INSERT,UPDATE,DELETE') THEN
        v_failures := array_append(v_failures, 'billing_account_evidence_acl');
    END IF;

    IF EXISTS (
        WITH expected(signature, search_path_config, security_definer, service_execute) AS (
            VALUES
              ('public.record_stripe_live_billing_reconciliation_checkpoint(text, integer, integer, integer, integer, integer, integer, timestamp with time zone, timestamp with time zone, integer, integer, boolean, boolean, timestamp with time zone, text, text, uuid, text)', 'search_path=public, pg_temp', true, false),
              ('public.record_stripe_live_billing_reconciliation_checkpoint_v2(jsonb, timestamp with time zone, text, text, uuid, text)', 'search_path=""', true, true),
              ('public.authorize_studio_live_billing_mutation_atomic(uuid, text, text, text, text)', 'search_path=""', true, true),
              ('private.current_connect_account_generation(jsonb)', 'search_path=""', false, true),
              ('private.bind_live_billing_authorization_checkpoint()', 'search_path=""', true, false),
              ('public.evaluate_operational_alert(text, text, bigint, integer, integer, text, text, text, text)', 'search_path=public, pg_temp', false, false),
              ('public.evaluate_operational_alert(text, text, bigint, integer, integer, text, text, integer, text, text, text)', 'search_path=public, pg_temp', false, true),
              ('public.acknowledge_operational_alert(text, uuid, text, text)', 'search_path=public, pg_temp', false, true),
              ('public.claim_operational_alert_delivery(text, text, uuid, integer)', 'search_path=public, pg_temp', false, true),
              ('public.complete_operational_alert_delivery(uuid, text, text)', 'search_path=public, pg_temp', false, true),
              ('public.fail_operational_alert_delivery(uuid, text, text, integer)', 'search_path=public, pg_temp', false, true)
        ), actual AS (
            SELECT format('%I.%I(%s)', namespace.nspname, function.proname, oidvectortypes(function.proargtypes)) AS signature,
                   owner.rolname AS owner_name,
                   language.lanname AS language_name,
                   function.prosecdef AS security_definer,
                   coalesce(array_to_string(function.proconfig, ','), '') AS search_path_config,
                   has_function_privilege('service_role', function.oid, 'EXECUTE') AS service_execute
              FROM pg_proc function
              JOIN pg_namespace namespace ON namespace.oid = function.pronamespace
              JOIN pg_roles owner ON owner.oid = function.proowner
              JOIN pg_language language ON language.oid = function.prolang
        )
        SELECT 1 FROM expected
        LEFT JOIN actual USING (signature)
        WHERE actual.signature IS NULL
           OR actual.owner_name <> 'postgres'
           OR actual.language_name <> 'plpgsql'
           OR actual.security_definer IS DISTINCT FROM expected.security_definer
           OR actual.search_path_config IS DISTINCT FROM expected.search_path_config
           OR actual.service_execute IS DISTINCT FROM expected.service_execute
    ) THEN
        v_failures := array_append(v_failures, 'billing_alert_function_manifest');
    END IF;

    IF EXISTS (
        WITH expected(table_name, column_name, data_type, nullable, identity_column) AS (
            VALUES
              ('stripe_events', 'error_reference', 'text', true, false),
              ('stripe_events', 'live_billing_ingest_sequence', 'bigint', false, true),
              ('stripe_live_billing_reconciliation_checkpoints', 'evidence_source', 'text', true, false),
              ('stripe_live_billing_reconciliation_checkpoints', 'deployment_ready_url', 'text', true, false),
              ('stripe_live_billing_reconciliation_checkpoints', 'deployment_ready_sha', 'text', true, false),
              ('stripe_live_billing_reconciliation_checkpoints', 'deployment_ready_verified_at', 'timestamp with time zone', true, false),
              ('stripe_live_billing_reconciliation_checkpoints', 'event_window_started_at', 'timestamp with time zone', true, false),
              ('stripe_live_billing_reconciliation_checkpoints', 'event_window_ended_at', 'timestamp with time zone', true, false),
              ('stripe_live_billing_reconciliation_checkpoints', 'local_event_ingest_watermark', 'bigint', true, false),
              ('stripe_live_billing_reconciliation_checkpoints', 'bounded_provider_event_count', 'integer', true, false),
              ('stripe_live_billing_reconciliation_checkpoints', 'bounded_local_event_count', 'integer', true, false),
              ('stripe_live_billing_reconciliation_checkpoints', 'provider_only_event_count', 'integer', true, false),
              ('stripe_live_billing_reconciliation_checkpoints', 'local_only_event_count', 'integer', true, false),
              ('stripe_live_billing_reconciliation_checkpoints', 'platform_provider_event_count', 'integer', true, false),
              ('stripe_live_billing_reconciliation_checkpoints', 'platform_local_event_count', 'integer', true, false),
              ('stripe_live_billing_reconciliation_checkpoints', 'platform_delivery_verified_at', 'timestamp with time zone', true, false),
              ('stripe_live_billing_reconciliation_checkpoints', 'unexpected_enabled_endpoint_count', 'integer', true, false),
              ('stripe_live_billing_reconciliation_checkpoints', 'account_evidence_count', 'integer', true, false),
              ('studio_live_billing_authorizations', 'reconciliation_checkpoint_id', 'uuid', true, false),
              ('studio_live_billing_authorizations', 'local_event_ingest_watermark', 'bigint', true, false),
              ('operational_alert_episodes', 'backup_destination_id', 'text', false, false),
              ('operational_alert_episodes', 'escalation_after_minutes', 'integer', false, false),
              ('operational_alert_episodes', 'acknowledged_at', 'timestamp with time zone', true, false),
              ('operational_alert_episodes', 'acknowledged_by_role', 'text', true, false),
              ('operational_alert_episodes', 'acknowledged_actor_ref', 'text', true, false),
              ('operational_alert_outbox', 'event_kind', 'text', false, false),
              ('operational_alert_outbox', 'destination_role', 'text', false, false)
        )
        SELECT 1 FROM expected
        LEFT JOIN information_schema.columns actual
          ON actual.table_schema = 'public'
         AND actual.table_name = expected.table_name
         AND actual.column_name = expected.column_name
        WHERE actual.column_name IS NULL
           OR actual.data_type IS DISTINCT FROM expected.data_type
           OR (actual.is_nullable = 'YES') IS DISTINCT FROM expected.nullable
           OR (actual.is_identity = 'YES') IS DISTINCT FROM expected.identity_column
    ) THEN
        v_failures := array_append(v_failures, 'column_manifest');
    END IF;

    IF EXISTS (
        WITH expected(table_name, constraint_identity, constraint_type) AS (
            VALUES
              ('stripe_live_billing_reconciliation_checkpoints', 'stripe_live_checkpoint_source_contract', 'c'),
              ('stripe_live_billing_reconciliation_checkpoints', 'stripe_live_checkpoint_ready_url_contract', 'c'),
              ('stripe_live_billing_reconciliation_checkpoints', 'stripe_live_checkpoint_ready_sha_contract', 'c'),
              ('stripe_live_billing_reconciliation_checkpoints', 'stripe_live_checkpoint_window_contract', 'c'),
              ('stripe_live_billing_reconciliation_checkpoints', 'stripe_live_checkpoint_watermark_contract', 'c'),
              ('stripe_live_billing_reconciliation_checkpoints', 'stripe_live_checkpoint_gap_contract', 'c'),
              ('studio_live_billing_authorizations', 'studio_live_billing_checkpoint_binding', 'c'),
              ('stripe_live_billing_reconciliation_account_evidence', 'primary:checkpoint_id,stripe_connected_account_id', 'p'),
              ('stripe_live_billing_reconciliation_account_evidence', 'unique:checkpoint_id,studio_id', 'u'),
              ('operational_alert_episodes', 'operational_alert_episode_ack_complete', 'c'),
              ('operational_alert_outbox', 'operational_alert_outbox_episode_event_role_key', 'u'),
              ('operational_alert_audit_events', 'operational_alert_audit_events_event_type_check', 'c')
        ), actual AS (
            SELECT relation.relname AS table_name,
                   CASE
                     WHEN relation.relname = 'stripe_live_billing_reconciliation_account_evidence'
                      AND constraint_state.contype = 'p'
                       THEN 'primary:' || columns.column_names
                     WHEN relation.relname = 'stripe_live_billing_reconciliation_account_evidence'
                      AND constraint_state.contype = 'u'
                       THEN 'unique:' || columns.column_names
                     ELSE constraint_state.conname
                   END AS constraint_identity,
                   constraint_state.contype::TEXT AS constraint_type,
                   constraint_state.convalidated
              FROM pg_constraint constraint_state
              JOIN pg_class relation ON relation.oid = constraint_state.conrelid
              JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
              LEFT JOIN LATERAL (
                  SELECT string_agg(attribute.attname, ',' ORDER BY key_position.ordinality) AS column_names
                    FROM unnest(constraint_state.conkey) WITH ORDINALITY key_position(attnum, ordinality)
                    JOIN pg_attribute attribute
                      ON attribute.attrelid = constraint_state.conrelid
                     AND attribute.attnum = key_position.attnum
              ) columns ON true
             WHERE namespace.nspname = 'public'
        )
        SELECT 1 FROM expected
        LEFT JOIN actual USING (table_name, constraint_identity)
        WHERE actual.constraint_identity IS NULL
           OR actual.constraint_type IS DISTINCT FROM expected.constraint_type
           OR NOT actual.convalidated
    ) THEN
        v_failures := array_append(v_failures, 'constraint_manifest');
    END IF;

    IF NOT EXISTS (
        SELECT 1
          FROM pg_trigger trigger
          JOIN pg_class relation ON relation.oid = trigger.tgrelid
          JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
         WHERE namespace.nspname = 'public'
           AND relation.relname = 'studio_payment_accounts'
           AND trigger.tgname = 'sync_connect_identity_mapping_guard'
           AND trigger.tgenabled = 'O'
           AND NOT trigger.tgisinternal
    ) OR NOT EXISTS (
        SELECT 1
          FROM pg_trigger trigger
          JOIN pg_class relation ON relation.oid = trigger.tgrelid
          JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
         WHERE namespace.nspname = 'public'
           AND relation.relname = 'stripe_connect_account_dispositions'
           AND trigger.tgname = 'sync_connect_identity_exclusion_guard'
           AND trigger.tgenabled = 'O'
           AND NOT trigger.tgisinternal
    ) THEN
        v_failures := array_append(v_failures, 'identity_guard_triggers');
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger trigger
        WHERE trigger.tgrelid = 'public.studio_live_billing_authorizations'::REGCLASS
          AND trigger.tgname = 'bind_live_billing_authorization_checkpoint'
          AND trigger.tgfoid = 'private.bind_live_billing_authorization_checkpoint()'::REGPROCEDURE
          AND trigger.tgtype = 23 AND trigger.tgenabled = 'O' AND NOT trigger.tgisinternal
    ) OR NOT EXISTS (
        SELECT 1 FROM pg_index index_state
        WHERE index_state.indexrelid = 'public.idx_stripe_events_live_billing_ingest_sequence'::REGCLASS
          AND index_state.indrelid = 'public.stripe_events'::REGCLASS
          AND index_state.indisunique AND index_state.indisvalid AND index_state.indisready
    ) THEN
        v_failures := array_append(v_failures, 'billing_trigger_index_manifest');
    END IF;

    RETURN QUERY SELECT
        cardinality(v_failures) = 0,
        v_count,
        v_head,
        COALESCE(v_pending, ARRAY[]::TEXT[]),
        v_failures;
END;
$$;

REVOKE ALL ON FUNCTION public.koaryu_release_schema_preflight()
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.koaryu_release_schema_preflight()
    TO service_role;
