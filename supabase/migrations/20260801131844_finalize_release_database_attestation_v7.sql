-- Converge the two runtime-dependent table ACLs to one explicit least-privilege
-- policy, then replace the hosted drift signal with a locale- and timezone-stable
-- V7 manifest. Release authority remains the independently executed raw catalog
-- verifier; this database helper is an operational readiness signal only.

REVOKE ALL PRIVILEGES ON TABLE public.stripe_events
    FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.stripe_events
    TO service_role;

REVOKE ALL PRIVILEGES ON TABLE public.studio_payment_accounts
    FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.studio_payment_accounts
    TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.studio_payment_accounts
    TO service_role;

ALTER FUNCTION public.koaryu_release_schema_preflight_v2()
    RENAME TO koaryu_release_schema_preflight_v6;
ALTER FUNCTION public.koaryu_release_schema_preflight_v6() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.koaryu_release_schema_preflight_v6()
    FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION private.koaryu_release_operational_manifest_v7()
RETURNS TEXT
LANGUAGE sql
STABLE
SET search_path = pg_catalog
SET TimeZone = 'UTC'
AS $v7$

with required_tables(schema_name, table_name, rls_enabled, service_privileges) as (
  values
    ('public', 'studio_live_billing_authorizations', true, 'SELECT'),
    ('public', 'stripe_live_billing_reconciliation_checkpoints', true, 'SELECT'),
    ('public', 'stripe_connect_account_dispositions', true, 'SELECT'),
    ('public', 'stripe_live_billing_reconciliation_account_evidence', true, 'SELECT'),
    ('public', 'stripe_connect_onboarding_bootstraps', true, ''),
    ('public', 'operational_alert_episodes', true, 'INSERT,SELECT,UPDATE'),
    ('public', 'operational_alert_outbox', true, 'INSERT,SELECT,UPDATE'),
    ('public', 'operational_alert_delivery_attempts', true, 'INSERT,SELECT'),
    ('public', 'operational_alert_delivery_outcomes', true, 'INSERT,SELECT'),
    ('public', 'operational_alert_audit_events', true, 'INSERT,SELECT'),
    ('public', 'operational_alert_heartbeats', true, 'INSERT,SELECT,UPDATE'),
    ('private', 'stripe_connect_account_identity_guards', false, '')
),
acl_scope_tables(schema_name, table_name) as (
  select schema_name, table_name from required_tables
  union all
  values
    ('public', 'studio_payment_accounts'),
    ('public', 'stripe_events')
),
scoped_definition_tables(schema_name, table_name) as (
  select schema_name, table_name from required_tables
  union all
  select 'public', 'studio_payment_accounts'
),
table_actual as (
  select
    namespace.nspname as schema_name,
    relation.relname as table_name,
    owner.rolname as owner_name,
    relation.relrowsecurity,
    coalesce((
      select string_agg(
               coalesce(grantor.rolname, 'PUBLIC') || '>' ||
               coalesce(grantee.rolname, 'PUBLIC') || ':' || acl.privilege_type || ':' || acl.is_grantable::text,
               ',' order by coalesce(grantor.rolname, 'PUBLIC') collate "C", coalesce(grantee.rolname, 'PUBLIC') collate "C", acl.privilege_type collate "C", acl.is_grantable
             )
        from aclexplode(coalesce(relation.relacl, acldefault('r', relation.relowner))) acl
        left join pg_roles grantor on grantor.oid = acl.grantor
        left join pg_roles grantee on grantee.oid = acl.grantee
    ), '') as acl_state,
    exists (
      select 1
        from aclexplode(coalesce(relation.relacl, acldefault('r', relation.relowner))) acl
       where acl.grantee = 0
    ) as public_access,
    has_table_privilege('anon', relation.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') as anon_access,
    has_table_privilege('authenticated', relation.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') as authenticated_access,
    concat_ws(',',
      case when has_table_privilege('service_role', relation.oid, 'INSERT') then 'INSERT' end,
      case when has_table_privilege('service_role', relation.oid, 'SELECT') then 'SELECT' end,
      case when has_table_privilege('service_role', relation.oid, 'UPDATE') then 'UPDATE' end,
      case when has_table_privilege('service_role', relation.oid, 'DELETE') then 'DELETE' end,
      case when has_table_privilege('service_role', relation.oid, 'TRUNCATE') then 'TRUNCATE' end,
      case when has_table_privilege('service_role', relation.oid, 'REFERENCES') then 'REFERENCES' end,
      case when has_table_privilege('service_role', relation.oid, 'TRIGGER') then 'TRIGGER' end
    ) as service_privileges
  from pg_class relation
  join pg_namespace namespace on namespace.oid = relation.relnamespace
  join pg_roles owner on owner.oid = relation.relowner
  join required_tables required
    on required.schema_name = namespace.nspname and required.table_name = relation.relname
  where relation.relkind = 'r'
),
table_compared as (
  select required.*, actual.owner_name, actual.relrowsecurity,
         actual.public_access, actual.anon_access, actual.authenticated_access,
         actual.service_privileges as actual_service_privileges,
         actual.acl_state
    from required_tables required
    left join table_actual actual using (schema_name, table_name)
),
table_acl_definitions as (
  select namespace.nspname as schema_name, relation.relname as table_name,
         owner.rolname as owner_name,
         coalesce((
           select string_agg(
                    coalesce(grantor.rolname, 'PUBLIC') || '>' ||
                    coalesce(grantee.rolname, 'PUBLIC') || ':' || acl.privilege_type || ':' || acl.is_grantable::text,
                    ',' order by coalesce(grantor.rolname, 'PUBLIC') collate "C", coalesce(grantee.rolname, 'PUBLIC') collate "C", acl.privilege_type collate "C", acl.is_grantable
                  )
             from aclexplode(coalesce(relation.relacl, acldefault('r', relation.relowner))) acl
             left join pg_roles grantor on grantor.oid = acl.grantor
             left join pg_roles grantee on grantee.oid = acl.grantee
         ), '') as acl_state
    from pg_class relation
    join pg_namespace namespace on namespace.oid = relation.relnamespace
    join pg_roles owner on owner.oid = relation.relowner
    join acl_scope_tables covered
      on covered.schema_name = namespace.nspname and covered.table_name = relation.relname
   where relation.relkind = 'r'
),
column_acl_definitions as (
  select namespace.nspname as schema_name,
         relation.relname as table_name,
         attribute.attnum,
         attribute.attname as column_name,
         coalesce((
           select string_agg(
                    coalesce(grantor.rolname, 'PUBLIC') || '>' ||
                    coalesce(grantee.rolname, 'PUBLIC') || ':' ||
                    acl.privilege_type || ':' || acl.is_grantable::text,
                    ',' order by coalesce(grantor.rolname, 'PUBLIC') collate "C",
                                 coalesce(grantee.rolname, 'PUBLIC') collate "C",
                                 acl.privilege_type collate "C", acl.is_grantable
                  )
             from aclexplode(attribute.attacl) acl
             left join pg_roles grantor on grantor.oid = acl.grantor
             left join pg_roles grantee on grantee.oid = acl.grantee
         ), '') as acl_state
    from pg_class relation
    join pg_namespace namespace on namespace.oid = relation.relnamespace
    join acl_scope_tables covered
      on covered.schema_name = namespace.nspname and covered.table_name = relation.relname
    join pg_attribute attribute
      on attribute.attrelid = relation.oid
     and attribute.attnum > 0
     and not attribute.attisdropped
   where relation.relkind = 'r'
),
required_policies(table_name, policy_name, permissive, command_name, role_names, predicate_kind) as (
  values
    ('studio_live_billing_authorizations', 'studio_live_billing_authorizations_no_client_access', false, '*', 'anon,authenticated', 'deny_all'),
    ('studio_live_billing_authorizations', 'reject_ambiguous_staff_membership_access', false, '*', 'authenticated', 'membership_guard'),
    ('stripe_live_billing_reconciliation_checkpoints', 'stripe_live_billing_reconciliation_checkpoints_no_client_access', false, '*', 'anon,authenticated', 'deny_all'),
    ('stripe_live_billing_reconciliation_checkpoints', 'reject_ambiguous_staff_membership_access', false, '*', 'authenticated', 'membership_guard'),
    ('stripe_connect_account_dispositions', 'stripe_connect_account_dispositions_no_client_access', false, '*', 'anon,authenticated', 'deny_all'),
    ('stripe_connect_account_dispositions', 'reject_ambiguous_staff_membership_access', false, '*', 'authenticated', 'membership_guard'),
    ('stripe_live_billing_reconciliation_account_evidence', 'stripe_live_billing_account_evidence_no_client_access', false, '*', 'anon,authenticated', 'deny_all'),
    ('stripe_live_billing_reconciliation_account_evidence', 'reject_ambiguous_staff_membership_access', false, '*', 'authenticated', 'membership_guard'),
    ('stripe_connect_onboarding_bootstraps', 'stripe_connect_onboarding_bootstraps_no_client_access', false, '*', 'anon,authenticated', 'deny_all'),
    ('stripe_connect_onboarding_bootstraps', 'reject_ambiguous_staff_membership_access', false, '*', 'authenticated', 'membership_guard'),
    ('operational_alert_episodes', 'reject_ambiguous_staff_membership_access', false, '*', 'authenticated', 'membership_guard'),
    ('operational_alert_outbox', 'reject_ambiguous_staff_membership_access', false, '*', 'authenticated', 'membership_guard'),
    ('operational_alert_delivery_attempts', 'reject_ambiguous_staff_membership_access', false, '*', 'authenticated', 'membership_guard'),
    ('operational_alert_delivery_outcomes', 'reject_ambiguous_staff_membership_access', false, '*', 'authenticated', 'membership_guard'),
    ('operational_alert_audit_events', 'reject_ambiguous_staff_membership_access', false, '*', 'authenticated', 'membership_guard'),
    ('operational_alert_heartbeats', 'reject_ambiguous_staff_membership_access', false, '*', 'authenticated', 'membership_guard')
),
policy_actual as (
  select relation.relname as table_name, policy.polname as policy_name,
         policy.polpermissive as permissive, policy.polcmd::text as command_name,
         (select string_agg(role.rolname, ',' order by role.rolname collate "C")
            from unnest(policy.polroles) role_oid
            join pg_roles role on role.oid = role_oid) as role_names,
         case
           when regexp_replace(pg_get_expr(policy.polqual, policy.polrelid), '[[:space:]()]', '', 'g') = 'false'
            and regexp_replace(pg_get_expr(policy.polwithcheck, policy.polrelid), '[[:space:]()]', '', 'g') = 'false'
             then 'deny_all'
           when regexp_replace(
                  regexp_replace(pg_get_expr(policy.polqual, policy.polrelid), '[[:space:]()]', '', 'g'),
                  'AShas_unambiguous_studio_membership$', ''
                ) = 'SELECTprivate.has_unambiguous_studio_membership'
            and regexp_replace(
                  regexp_replace(pg_get_expr(policy.polwithcheck, policy.polrelid), '[[:space:]()]', '', 'g'),
                  'AShas_unambiguous_studio_membership$', ''
                ) = 'SELECTprivate.has_unambiguous_studio_membership'
             then 'membership_guard'
           else 'unexpected'
         end as predicate_kind
    from pg_policy policy
    join pg_class relation on relation.oid = policy.polrelid
    join pg_namespace namespace on namespace.oid = relation.relnamespace
    join required_tables covered
      on covered.schema_name = 'public' and covered.table_name = relation.relname
   where namespace.nspname = 'public'
),
policy_compared as (
  select coalesce(required.table_name, actual.table_name) as table_name,
         coalesce(required.policy_name, actual.policy_name) as policy_name,
         required.permissive, required.command_name, required.role_names,
         required.predicate_kind,
         actual.permissive as actual_permissive,
         actual.command_name as actual_command_name,
         actual.role_names as actual_role_names,
         actual.predicate_kind as actual_predicate_kind,
         required.table_name is not null as expected_policy,
         actual.table_name is not null as actual_policy
    from required_policies required
    full join policy_actual actual using (table_name, policy_name)
),
required_functions(signature, search_path_config, security_definer, service_execute) as (
  values
    ('public.preserve_studio_comp_provenance()', 'search_path=pg_catalog', false, false),
    ('public.set_studio_comp_atomic(uuid, boolean, text, uuid, text, boolean)', 'search_path=public, pg_temp', false, true),
    ('public.clear_studio_comp_for_billing_event(uuid, bigint)', 'search_path=public, pg_temp', false, true),
    ('public.record_stripe_live_billing_reconciliation_checkpoint(text, integer, integer, integer, integer, integer, integer, timestamp with time zone, timestamp with time zone, integer, integer, boolean, boolean, timestamp with time zone, text, text, uuid, text)', 'search_path=public, pg_temp', true, false),
    ('public.record_stripe_live_billing_reconciliation_checkpoint_v2(jsonb, timestamp with time zone, text, text, uuid, text)', 'search_path=""', true, true),
    ('public.authorize_studio_live_billing_mutation_atomic(uuid, text, text, text, text)', 'search_path=""', true, true),
    ('public.authorize_connect_onboarding_bootstrap_account_create(uuid, text, integer, text, text, text, text, text)', 'search_path=""', true, false),
    ('public.bind_connect_onboarding_bootstrap_account(uuid, text, integer, text, text, text)', 'search_path=""', true, false),
    ('public.authorize_connect_onboarding_bootstrap_initial_link(uuid, text, integer, text, text, text, text, text)', 'search_path=""', true, false),
    ('private.connect_onboarding_bootstrap_link_checkpoint(uuid, text)', 'search_path=""', true, false),
    ('public.preflight_connect_onboarding_bootstrap_begin(uuid, text)', 'search_path=""', true, true),
    ('public.preflight_connect_onboarding_bootstrap_resume(uuid, text)', 'search_path=""', true, true),
    ('public.prepare_connect_onboarding_bootstrap_atomic(uuid, text, integer, jsonb, text, text, text, text)', 'search_path=""', true, true),
    ('public.load_connect_onboarding_bootstrap_recovery_context(uuid, text)', 'search_path=""', true, true),
    ('public.authorize_connect_onboarding_bootstrap_account_create_v2(uuid, uuid, text, integer, text, text)', 'search_path=""', true, true),
    ('public.bind_connect_onboarding_bootstrap_account_v2(uuid, uuid, text, integer, text, text)', 'search_path=""', true, true),
    ('public.authorize_connect_onboarding_bootstrap_initial_link_v2(uuid, uuid, text, integer, text, text, text, text)', 'search_path=""', true, true),
    ('public.record_connect_onboarding_bootstrap_initial_link_response(uuid, uuid, text, integer, text, text, text, text, text, text)', 'search_path=""', true, true),
    ('public.acknowledge_connect_onboarding_bootstrap_initial_link_delivery(uuid, text, text)', 'search_path=""', true, true),
    ('private.live_billing_event_is_in_scope(text, text)', 'search_path=""', true, false),
    ('private.enforce_live_billing_checkpoint_processed_events()', 'search_path=""', true, false),
    ('private.current_connect_account_generation(jsonb)', 'search_path=""', false, true),
    ('private.bind_live_billing_authorization_checkpoint()', 'search_path=""', true, false),
    ('public.set_studio_live_billing_authorization_atomic(uuid, text, boolean, timestamp with time zone, text, uuid, text, text)', 'search_path=public, pg_temp', true, true),
    ('public.set_stripe_connect_account_exclusion_atomic(text, boolean, text, uuid, text)', 'search_path=public, pg_temp', true, true),
    ('public.finish_stripe_event_processing_v2(uuid, text, text, text, text)', 'search_path=public, pg_temp', false, true),
    ('public.prevent_operational_alert_append_only_mutation()', 'search_path=""', false, false),
    ('public.enforce_operational_alert_sent_receipt()', 'search_path=""', false, false),
    ('public.operational_alert_metric_counts()', 'search_path=public, pg_temp', false, true),
    ('public.evaluate_operational_alert(text, text, bigint, integer, integer, text, text, text, text)', 'search_path=public, pg_temp', false, false),
    ('public.evaluate_operational_alert(text, text, bigint, integer, integer, text, text, integer, text, text, text)', 'search_path=public, pg_temp', false, true),
    ('public.acknowledge_operational_alert(text, uuid, text, text)', 'search_path=public, pg_temp', false, true),
    ('public.claim_operational_alert_delivery(text, text, uuid, integer)', 'search_path=public, pg_temp', false, true),
    ('public.complete_operational_alert_delivery(uuid, text, text)', 'search_path=public, pg_temp', false, true),
    ('public.fail_operational_alert_delivery(uuid, text, text, integer)', 'search_path=public, pg_temp', false, true),
    ('public.record_operational_alert_heartbeat(text, text, text)', 'search_path=public, pg_temp', false, true),
    ('public.operational_alert_heartbeats(text)', 'search_path=public, pg_temp', false, true),
    ('public.koaryu_release_schema_preflight()', 'search_path=pg_catalog', true, true),
    ('public.koaryu_release_schema_preflight_v6()', 'search_path=pg_catalog', true, false),
    ('private.koaryu_release_operational_manifest_v2()', 'search_path=pg_catalog', false, false),
    ('private.koaryu_release_operational_manifest_v2_base()', 'search_path=pg_catalog', false, false),
    ('private.koaryu_release_operational_manifest_v4()', 'search_path=pg_catalog', false, false),
    ('private.koaryu_release_operational_manifest_v5()', 'search_path=pg_catalog', false, false),
    ('private.koaryu_release_operational_manifest_v6()', 'search_path=pg_catalog', false, false),
    ('private.sync_connect_identity_mapping_guard()', 'search_path=pg_catalog', true, false),
    ('private.sync_connect_identity_exclusion_guard()', 'search_path=pg_catalog', true, false)
),
function_actual as (
  select format('%I.%I(%s)', namespace.nspname, function.proname, oidvectortypes(function.proargtypes)) as signature,
         owner.rolname as owner_name, language.lanname as language_name,
         function.prosecdef as security_definer,
         coalesce(array_to_string(function.proconfig, ','), '') as search_path_config,
         exists (select 1 from aclexplode(coalesce(function.proacl, acldefault('f', function.proowner))) acl where acl.grantee = 0 and acl.privilege_type = 'EXECUTE') as public_execute,
         has_function_privilege('anon', function.oid, 'EXECUTE') as anon_execute,
         has_function_privilege('authenticated', function.oid, 'EXECUTE') as authenticated_execute,
         has_function_privilege('service_role', function.oid, 'EXECUTE') as service_execute,
         encode(extensions.digest(convert_to(function.prosrc, 'UTF8'), 'sha256'), 'hex') as body_sha256,
         coalesce((
           select string_agg(
                    coalesce(grantor.rolname, 'PUBLIC') || '>' ||
                    coalesce(grantee.rolname, 'PUBLIC') || ':' || acl.privilege_type || ':' || acl.is_grantable::text,
                    ',' order by coalesce(grantor.rolname, 'PUBLIC') collate "C", coalesce(grantee.rolname, 'PUBLIC') collate "C", acl.privilege_type collate "C", acl.is_grantable
                  )
             from aclexplode(coalesce(function.proacl, acldefault('f', function.proowner))) acl
             left join pg_roles grantor on grantor.oid = acl.grantor
             left join pg_roles grantee on grantee.oid = acl.grantee
         ), '') as acl_state,
         exists (
           select 1
             from aclexplode(coalesce(function.proacl, acldefault('f', function.proowner))) acl
             left join pg_roles grantee on grantee.oid = acl.grantee
            where acl.privilege_type = 'EXECUTE'
              and acl.grantee <> function.proowner
              and not (
                grantee.rolname = 'service_role'
                and required.service_execute
                and not acl.is_grantable
              )
         ) as unexpected_execute_grant
    from pg_proc function
    join pg_namespace namespace on namespace.oid = function.pronamespace
    join pg_roles owner on owner.oid = function.proowner
    join pg_language language on language.oid = function.prolang
    join required_functions required
      on required.signature = format('%I.%I(%s)', namespace.nspname, function.proname, oidvectortypes(function.proargtypes))
),
function_compared as (
  select required.*, actual.owner_name, actual.language_name,
         actual.security_definer as actual_security_definer,
         actual.search_path_config as actual_search_path_config,
         actual.public_execute, actual.anon_execute, actual.authenticated_execute,
         actual.service_execute as actual_service_execute,
         actual.body_sha256, actual.acl_state, actual.unexpected_execute_grant
    from required_functions required
    left join function_actual actual using (signature)
),
required_triggers(table_name, trigger_name, function_schema, function_name, trigger_type) as (
  values
    ('studio_subscriptions', 'preserve_studio_comp_provenance_on_metadata_update', 'public', 'preserve_studio_comp_provenance', 19),
    ('studio_live_billing_authorizations', 'set_studio_live_billing_authorizations_updated_at', 'public', 'update_updated_at_column', 19),
    ('stripe_connect_account_dispositions', 'set_stripe_connect_account_dispositions_updated_at', 'public', 'update_updated_at_column', 19),
    ('studio_live_billing_authorizations', 'bind_live_billing_authorization_checkpoint', 'private', 'bind_live_billing_authorization_checkpoint', 23),
    ('stripe_connect_onboarding_bootstraps', 'set_stripe_connect_onboarding_bootstraps_updated_at', 'public', 'update_updated_at_column', 19),
    ('stripe_live_billing_reconciliation_checkpoints', 'enforce_live_billing_checkpoint_processed_events', 'private', 'enforce_live_billing_checkpoint_processed_events', 7),
    ('operational_alert_delivery_attempts', 'prevent_operational_alert_attempt_mutation', 'public', 'prevent_operational_alert_append_only_mutation', 27),
    ('operational_alert_delivery_outcomes', 'prevent_operational_alert_outcome_mutation', 'public', 'prevent_operational_alert_append_only_mutation', 27),
    ('operational_alert_audit_events', 'prevent_operational_alert_audit_mutation', 'public', 'prevent_operational_alert_append_only_mutation', 27),
    ('operational_alert_outbox', 'enforce_operational_alert_sent_receipt', 'public', 'enforce_operational_alert_sent_receipt', 23),
    ('studio_payment_accounts', 'sync_connect_identity_mapping_guard', 'private', 'sync_connect_identity_mapping_guard', 29),
    ('stripe_connect_account_dispositions', 'sync_connect_identity_exclusion_guard', 'private', 'sync_connect_identity_exclusion_guard', 29)
),
trigger_actual as (
  select relation.relname as table_name, trigger.tgname as trigger_name,
         function_namespace.nspname as function_schema, function.proname as function_name,
         trigger.tgtype::integer as trigger_type, trigger.tgenabled, trigger.tgisinternal,
         encode(extensions.digest(convert_to(pg_get_triggerdef(trigger.oid), 'UTF8'), 'sha256'), 'hex') as definition_sha256
    from pg_trigger trigger
    join pg_class relation on relation.oid = trigger.tgrelid
    join pg_namespace namespace on namespace.oid = relation.relnamespace
    join pg_proc function on function.oid = trigger.tgfoid
    join pg_namespace function_namespace on function_namespace.oid = function.pronamespace
    join required_triggers required
      on required.table_name = relation.relname and required.trigger_name = trigger.tgname
   where namespace.nspname = 'public'
),
trigger_compared as (
  select required.*, actual.function_schema as actual_function_schema,
         actual.function_name as actual_function_name,
         actual.trigger_type as actual_trigger_type,
         actual.tgenabled, actual.tgisinternal, actual.definition_sha256
    from required_triggers required
    left join trigger_actual actual using (table_name, trigger_name)
),
required_indexes(index_name, table_name, unique_index, partial_index) as (
  values
    ('idx_studio_live_billing_authorizations_enabled', 'studio_live_billing_authorizations', false, true),
    ('idx_stripe_live_billing_reconciliation_checkpoints_latest', 'stripe_live_billing_reconciliation_checkpoints', false, false),
    ('idx_stripe_events_error_reference', 'stripe_events', true, true),
    ('idx_stripe_events_live_billing_ingest_sequence', 'stripe_events', true, false),
    ('idx_stripe_connect_onboarding_bootstraps_generation_once', 'stripe_connect_onboarding_bootstraps', true, false),
    ('idx_stripe_connect_onboarding_bootstraps_delivery_receipt', 'stripe_connect_onboarding_bootstraps', true, true),
    ('operational_alert_episodes_one_unresolved', 'operational_alert_episodes', true, true),
    ('operational_alert_episodes_recent', 'operational_alert_episodes', false, false),
    ('operational_alert_outbox_claim', 'operational_alert_outbox', false, true),
    ('operational_alert_delivery_attempts_delivery', 'operational_alert_delivery_attempts', false, false),
    ('operational_alert_audit_events_episode', 'operational_alert_audit_events', false, false)
),
index_actual as (
  select index_relation.relname as index_name, table_relation.relname as table_name,
         index.indisunique as unique_index, index.indpred is not null as partial_index,
         index.indisvalid, index.indisready,
         encode(extensions.digest(convert_to(pg_get_indexdef(index.indexrelid), 'UTF8'), 'sha256'), 'hex') as definition_sha256
    from pg_index index
    join pg_class index_relation on index_relation.oid = index.indexrelid
    join pg_class table_relation on table_relation.oid = index.indrelid
    join pg_namespace namespace on namespace.oid = table_relation.relnamespace
    join required_indexes required on required.index_name = index_relation.relname
   where namespace.nspname = 'public'
),
index_compared as (
  select required.*, actual.table_name as actual_table_name,
         actual.unique_index as actual_unique_index,
         actual.partial_index as actual_partial_index,
         actual.indisvalid, actual.indisready, actual.definition_sha256
    from required_indexes required
    left join index_actual actual using (index_name)
),
required_sequences(table_name, column_name, service_usage, service_select, service_update) as (
  values
    ('stripe_live_billing_reconciliation_checkpoints', 'checkpoint_sequence', true, true, false),
    ('stripe_events', 'live_billing_ingest_sequence', true, true, false),
    ('operational_alert_audit_events', 'id', true, true, false)
),
sequence_actual as (
  select table_relation.relname as table_name, attribute.attname as column_name,
         owner.rolname as owner_name,
         coalesce((
           select string_agg(
                    coalesce(grantor.rolname, 'PUBLIC') || '>' ||
                    coalesce(grantee.rolname, 'PUBLIC') || ':' || acl.privilege_type || ':' || acl.is_grantable::text,
                    ',' order by coalesce(grantor.rolname, 'PUBLIC') collate "C", coalesce(grantee.rolname, 'PUBLIC') collate "C", acl.privilege_type collate "C", acl.is_grantable
                  )
             from aclexplode(coalesce(sequence.relacl, acldefault('S', sequence.relowner))) acl
             left join pg_roles grantor on grantor.oid = acl.grantor
             left join pg_roles grantee on grantee.oid = acl.grantee
         ), '') as acl_state,
         exists (select 1 from aclexplode(coalesce(sequence.relacl, acldefault('S', sequence.relowner))) acl where acl.grantee = 0) as public_access,
         has_sequence_privilege('anon', sequence.oid, 'USAGE,SELECT,UPDATE') as anon_access,
         has_sequence_privilege('authenticated', sequence.oid, 'USAGE,SELECT,UPDATE') as authenticated_access,
         has_sequence_privilege('service_role', sequence.oid, 'USAGE') as service_usage,
         has_sequence_privilege('service_role', sequence.oid, 'SELECT') as service_select,
         has_sequence_privilege('service_role', sequence.oid, 'UPDATE') as service_update
    from pg_class sequence
    join pg_depend dependency on dependency.objid = sequence.oid and dependency.deptype in ('a', 'i')
    join pg_class table_relation on table_relation.oid = dependency.refobjid
    join pg_attribute attribute on attribute.attrelid = table_relation.oid and attribute.attnum = dependency.refobjsubid
    join pg_namespace namespace on namespace.oid = table_relation.relnamespace
    join pg_roles owner on owner.oid = sequence.relowner
    join required_sequences required on required.table_name = table_relation.relname and required.column_name = attribute.attname
   where namespace.nspname = 'public' and sequence.relkind = 'S'
),
sequence_compared as (
  select required.*, actual.owner_name, actual.public_access,
         actual.anon_access, actual.authenticated_access,
         actual.service_usage as actual_service_usage,
         actual.service_select as actual_service_select,
         actual.service_update as actual_service_update,
         actual.acl_state
    from required_sequences required
    left join sequence_actual actual using (table_name, column_name)
),
required_columns(table_name, column_name, data_type, nullable, identity_column) as (
  values
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
    ('stripe_connect_onboarding_bootstraps', 'bootstrap_token_sha256', 'text', false, false),
    ('stripe_connect_onboarding_bootstraps', 'connect_account_generation', 'integer', false, false),
    ('stripe_connect_onboarding_bootstraps', 'initial_link_payload_sha256', 'text', true, false),
    ('stripe_connect_onboarding_bootstraps', 'stripe_connected_account_id', 'text', true, false),
    ('stripe_connect_onboarding_bootstraps', 'expires_at', 'timestamp with time zone', false, false),
    ('stripe_connect_onboarding_bootstraps', 'initial_link_claimed_at', 'timestamp with time zone', true, false),
    ('stripe_connect_onboarding_bootstraps', 'recovery_context', 'jsonb', true, false),
    ('stripe_connect_onboarding_bootstraps', 'recovery_expires_at', 'timestamp with time zone', true, false),
    ('stripe_connect_onboarding_bootstraps', 'initial_link_response_sha256', 'text', true, false),
    ('stripe_connect_onboarding_bootstraps', 'initial_link_response_recorded_at', 'timestamp with time zone', true, false),
    ('stripe_connect_onboarding_bootstraps', 'initial_link_delivery_receipt_sha256', 'text', true, false),
    ('stripe_connect_onboarding_bootstraps', 'initial_link_delivery_receipt_expires_at', 'timestamp with time zone', true, false),
    ('stripe_connect_onboarding_bootstraps', 'initial_link_delivered_at', 'timestamp with time zone', true, false),
    ('stripe_connect_onboarding_bootstraps', 'initial_link_support_required_at', 'timestamp with time zone', true, false),
    ('operational_alert_episodes', 'backup_destination_id', 'text', false, false),
    ('operational_alert_episodes', 'escalation_after_minutes', 'integer', false, false),
    ('operational_alert_episodes', 'acknowledged_at', 'timestamp with time zone', true, false),
    ('operational_alert_episodes', 'acknowledged_by_role', 'text', true, false),
    ('operational_alert_episodes', 'acknowledged_actor_ref', 'text', true, false),
    ('operational_alert_outbox', 'event_kind', 'text', false, false),
    ('operational_alert_outbox', 'destination_role', 'text', false, false)
),
column_compared as (
  select required.*,
         actual.data_type as actual_data_type,
         actual.is_nullable = 'YES' as actual_nullable,
         actual.is_identity = 'YES' as actual_identity_column
    from required_columns required
    left join information_schema.columns actual
      on actual.table_schema = 'public'
     and actual.table_name = required.table_name
     and actual.column_name = required.column_name
),
required_constraints(table_name, constraint_identity, constraint_type) as (
  values
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
    ('operational_alert_audit_events', 'operational_alert_audit_events_event_type_check', 'c'),
    ('stripe_connect_onboarding_bootstraps', 'stripe_connect_onboarding_bootstraps_recovery_pair', 'c'),
    ('stripe_connect_onboarding_bootstraps', 'stripe_connect_onboarding_bootstraps_recovery_context_object', 'c'),
    ('stripe_connect_onboarding_bootstraps', 'stripe_connect_onboarding_bootstraps_recovery_expiry', 'c'),
    ('stripe_connect_onboarding_bootstraps', 'stripe_connect_onboarding_bootstraps_response_hash', 'c'),
    ('stripe_connect_onboarding_bootstraps', 'stripe_connect_onboarding_bootstraps_receipt_hash', 'c'),
    ('stripe_connect_onboarding_bootstraps', 'stripe_connect_onboarding_bootstraps_response_pair', 'c'),
    ('stripe_connect_onboarding_bootstraps', 'stripe_connect_onboarding_bootstraps_receipt_pair', 'c'),
    ('stripe_connect_onboarding_bootstraps', 'stripe_connect_onboarding_bootstraps_delivery_order', 'c'),
    ('stripe_connect_onboarding_bootstraps', 'stripe_connect_onboarding_bootstraps_receipt_expiry', 'c'),
    ('stripe_connect_onboarding_bootstraps', 'stripe_connect_onboarding_bootstraps_delivered_state', 'c'),
    ('stripe_connect_onboarding_bootstraps', 'stripe_connect_onboarding_bootstraps_terminal_state', 'c')
),
constraint_actual as (
  select relation.relname as table_name,
         case
           when relation.relname = 'stripe_live_billing_reconciliation_account_evidence'
            and constraint_state.contype = 'p'
             then 'primary:' || columns.column_names
           when relation.relname = 'stripe_live_billing_reconciliation_account_evidence'
            and constraint_state.contype = 'u'
             then 'unique:' || columns.column_names
           else constraint_state.conname
         end as constraint_identity,
         constraint_state.contype::text as constraint_type,
         constraint_state.convalidated,
         encode(extensions.digest(convert_to(pg_get_constraintdef(constraint_state.oid), 'UTF8'), 'sha256'), 'hex') as definition_sha256
    from pg_constraint constraint_state
    join pg_class relation on relation.oid = constraint_state.conrelid
    join pg_namespace namespace on namespace.oid = relation.relnamespace
    left join lateral (
      select string_agg(attribute.attname, ',' order by key_position.ordinality) as column_names
        from unnest(constraint_state.conkey) with ordinality key_position(attnum, ordinality)
        join pg_attribute attribute
          on attribute.attrelid = constraint_state.conrelid
         and attribute.attnum = key_position.attnum
    ) columns on true
   where namespace.nspname = 'public'
),
constraint_compared as (
  select required.*,
         actual.constraint_type as actual_constraint_type,
         actual.convalidated, actual.definition_sha256
    from required_constraints required
    left join constraint_actual actual using (table_name, constraint_identity)
),
scoped_index_definitions as (
  select namespace.nspname as schema_name, table_relation.relname as table_name,
         index_relation.relname as index_name,
         encode(extensions.digest(convert_to(pg_get_indexdef(index_state.indexrelid), 'UTF8'), 'sha256'), 'hex') as definition_sha256
    from pg_index index_state
    join pg_class index_relation on index_relation.oid = index_state.indexrelid
    join pg_class table_relation on table_relation.oid = index_state.indrelid
    join pg_namespace namespace on namespace.oid = table_relation.relnamespace
    join scoped_definition_tables covered
      on covered.schema_name = namespace.nspname and covered.table_name = table_relation.relname
),
scoped_constraint_definitions as (
  select namespace.nspname as schema_name, relation.relname as table_name,
         constraint_state.conname as constraint_name,
         constraint_state.contype::text as constraint_type,
         constraint_state.convalidated,
         encode(extensions.digest(convert_to(pg_get_constraintdef(constraint_state.oid), 'UTF8'), 'sha256'), 'hex') as definition_sha256
    from pg_constraint constraint_state
    join pg_class relation on relation.oid = constraint_state.conrelid
    join pg_namespace namespace on namespace.oid = relation.relnamespace
    join scoped_definition_tables covered
      on covered.schema_name = namespace.nspname and covered.table_name = relation.relname
),
states as (
  select 'tables' as category, count(*)::integer as object_count,
         encode(extensions.digest(convert_to(coalesce(string_agg(schema_name || '.' || table_name || ':' || coalesce(owner_name, '') || ':' || coalesce(relrowsecurity::text, '') || ':' || coalesce(actual_service_privileges, '') || ':' || coalesce(acl_state, ''), '|' order by schema_name collate "C", table_name collate "C"), ''), 'UTF8'), 'sha256'), 'hex') as state_digest,
         count(*) filter (where owner_name is null or owner_name <> 'postgres' or relrowsecurity is distinct from rls_enabled or public_access or anon_access or authenticated_access or actual_service_privileges is distinct from service_privileges)::integer as failures
    from table_compared
  union all
  select 'table_acls', count(*)::integer,
         encode(extensions.digest(convert_to(coalesce(string_agg(schema_name || '.' || table_name || ':' || owner_name || ':' || acl_state, '|' order by schema_name collate "C", table_name collate "C"), ''), 'UTF8'), 'sha256'), 'hex'),
         0::integer
    from table_acl_definitions
  union all
  select 'column_acls', count(*)::integer,
         encode(extensions.digest(convert_to(coalesce(string_agg(schema_name || '.' || table_name || ':' || attnum::text || ':' || column_name || ':' || acl_state, '|' order by schema_name collate "C", table_name collate "C", attnum), ''), 'UTF8'), 'sha256'), 'hex'),
         0::integer
    from column_acl_definitions
  union all
  select 'policies', count(*)::integer,
         encode(extensions.digest(convert_to(coalesce(string_agg(table_name || ':' || policy_name || ':' || coalesce(actual_permissive::text, '') || ':' || coalesce(actual_command_name, '') || ':' || coalesce(actual_role_names, '') || ':' || coalesce(actual_predicate_kind, ''), '|' order by table_name collate "C", policy_name collate "C"), ''), 'UTF8'), 'sha256'), 'hex'),
         count(*) filter (where not expected_policy or not actual_policy or actual_permissive is distinct from permissive or actual_command_name is distinct from command_name or actual_role_names is distinct from role_names or actual_predicate_kind is distinct from predicate_kind)::integer
    from policy_compared
  union all
  select 'functions', count(*)::integer,
         encode(extensions.digest(convert_to(coalesce(string_agg(signature || ':' || coalesce(owner_name, '') || ':' || coalesce(language_name, '') || ':' || coalesce(actual_security_definer::text, '') || ':' || coalesce(actual_search_path_config, '') || ':' || coalesce(actual_service_execute::text, '') || ':' || coalesce(body_sha256, '') || ':' || coalesce(acl_state, ''), '|' order by signature collate "C"), ''), 'UTF8'), 'sha256'), 'hex'),
         count(*) filter (where owner_name is null or owner_name <> 'postgres' or language_name not in ('sql', 'plpgsql') or actual_security_definer is distinct from security_definer or actual_search_path_config is distinct from search_path_config or public_execute or anon_execute or authenticated_execute or actual_service_execute is distinct from service_execute or unexpected_execute_grant)::integer
    from function_compared
  union all
  select 'triggers', count(*)::integer,
         encode(extensions.digest(convert_to(coalesce(string_agg(table_name || ':' || trigger_name || ':' || coalesce(actual_function_schema, '') || '.' || coalesce(actual_function_name, '') || ':' || coalesce(actual_trigger_type::text, '') || ':' || coalesce(tgenabled::text, '') || ':' || coalesce(definition_sha256, ''), '|' order by table_name collate "C", trigger_name collate "C"), ''), 'UTF8'), 'sha256'), 'hex'),
         count(*) filter (where actual_function_schema is distinct from function_schema or actual_function_name is distinct from function_name or actual_trigger_type is distinct from trigger_type or tgenabled is distinct from 'O' or tgisinternal is distinct from false)::integer
    from trigger_compared
  union all
  select 'indexes', count(*)::integer,
         encode(extensions.digest(convert_to(coalesce(string_agg(index_name || ':' || coalesce(actual_table_name, '') || ':' || coalesce(actual_unique_index::text, '') || ':' || coalesce(actual_partial_index::text, '') || ':' || coalesce(indisvalid::text, '') || ':' || coalesce(indisready::text, '') || ':' || coalesce(definition_sha256, ''), '|' order by index_name collate "C"), ''), 'UTF8'), 'sha256'), 'hex'),
         count(*) filter (where actual_table_name is distinct from table_name or actual_unique_index is distinct from unique_index or actual_partial_index is distinct from partial_index or indisvalid is distinct from true or indisready is distinct from true)::integer
    from index_compared
  union all
  select 'sequences', count(*)::integer,
         encode(extensions.digest(convert_to(coalesce(string_agg(table_name || '.' || column_name || ':' || coalesce(owner_name, '') || ':' || coalesce(actual_service_usage::text, '') || ':' || coalesce(actual_service_select::text, '') || ':' || coalesce(actual_service_update::text, '') || ':' || coalesce(acl_state, ''), '|' order by table_name collate "C", column_name collate "C"), ''), 'UTF8'), 'sha256'), 'hex'),
         count(*) filter (where owner_name is null or owner_name <> 'postgres' or public_access or anon_access or authenticated_access or actual_service_usage is distinct from service_usage or actual_service_select is distinct from service_select or actual_service_update is distinct from service_update)::integer
    from sequence_compared
  union all
  select 'columns', count(*)::integer,
         encode(extensions.digest(convert_to(coalesce(string_agg(table_name || '.' || column_name || ':' || coalesce(actual_data_type, '') || ':' || coalesce(actual_nullable::text, '') || ':' || coalesce(actual_identity_column::text, ''), '|' order by table_name collate "C", column_name collate "C"), ''), 'UTF8'), 'sha256'), 'hex'),
         count(*) filter (where actual_data_type is distinct from data_type or actual_nullable is distinct from nullable or actual_identity_column is distinct from identity_column)::integer
    from column_compared
  union all
  select 'constraints', count(*)::integer,
         encode(extensions.digest(convert_to(coalesce(string_agg(table_name || ':' || constraint_identity || ':' || coalesce(actual_constraint_type, '') || ':' || coalesce(convalidated::text, '') || ':' || coalesce(definition_sha256, ''), '|' order by table_name collate "C", constraint_identity collate "C"), ''), 'UTF8'), 'sha256'), 'hex'),
         count(*) filter (where actual_constraint_type is distinct from constraint_type or convalidated is distinct from true)::integer
    from constraint_compared
  union all
  select 'scoped_indexes', count(*)::integer,
         encode(extensions.digest(convert_to(coalesce(string_agg(schema_name || '.' || table_name || ':' || index_name || ':' || definition_sha256, '|' order by schema_name collate "C", table_name collate "C", index_name collate "C"), ''), 'UTF8'), 'sha256'), 'hex'),
         0::integer
    from scoped_index_definitions
  union all
  select 'scoped_constraints', count(*)::integer,
         encode(extensions.digest(convert_to(coalesce(string_agg(schema_name || '.' || table_name || ':' || constraint_name || ':' || constraint_type || ':' || convalidated::text || ':' || definition_sha256, '|' order by schema_name collate "C", table_name collate "C", constraint_name collate "C"), ''), 'UTF8'), 'sha256'), 'hex'),
         count(*) filter (where not convalidated)::integer
    from scoped_constraint_definitions
)
select encode(
         extensions.digest(
           convert_to(string_agg(category || '=' || object_count::text || ':' || state_digest || ':' || failures::text, ';' order by category collate "C"), 'UTF8'),
           'sha256'
         ),
         'hex'
       )
  from states
$v7$;

ALTER FUNCTION private.koaryu_release_operational_manifest_v7() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.koaryu_release_operational_manifest_v7()
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
AS $preflight$
DECLARE
    v_count INTEGER;
    v_head TEXT;
    v_pending TEXT[];
    v_baseline TEXT;
    v_prior RECORD;
    v_failures TEXT[] := ARRAY[]::TEXT[];
BEGIN
    SELECT * INTO v_prior
      FROM public.koaryu_release_schema_preflight_v6();

    -- V7 supersedes only V6's exact-head and runtime-divergent manifest
    -- signals. Every independent history/object/security failure survives.
    v_failures := array_remove(
        array_remove(v_prior.security_failures, 'migration_history_v6'),
        'operational_semantic_acl_manifest_v6'
    );

    SELECT count(*)::INTEGER, max(version),
           array_agg(version ORDER BY version COLLATE "C")
             FILTER (WHERE version >= '20260727100000'),
           count(*) FILTER (WHERE version < '20260727100000')::TEXT || ':' ||
             md5(string_agg(version || ':' || name, '|' ORDER BY version COLLATE "C")
                 FILTER (WHERE version < '20260727100000'))
      INTO v_count, v_head, v_pending, v_baseline
      FROM supabase_migrations.schema_migrations;

    IF v_count <> 100
       OR v_head <> '20260801131844'
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
           '20260801115044',
           '20260801123112',
           '20260801131844'
       ]::TEXT[]
       OR v_baseline <> '84:57ae4269ef4d75c249d59ef297661a3a' THEN
        v_failures := array_append(v_failures, 'migration_history_v7');
    END IF;

    IF private.koaryu_release_operational_manifest_v7()
       <> 'd621d0bfa18b21571132a51108dd418e66996944fb7723bd3aeb624da7fe0e79' THEN
        v_failures := array_append(v_failures, 'operational_semantic_acl_manifest_v7');
    END IF;

    RETURN QUERY SELECT
        cardinality(v_failures) = 0,
        v_count,
        v_head,
        COALESCE(v_pending, ARRAY[]::TEXT[]),
        v_failures,
        'release-db-attestation-v7';
END;
$preflight$;

ALTER FUNCTION public.koaryu_release_schema_preflight_v2() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.koaryu_release_schema_preflight_v2()
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.koaryu_release_schema_preflight_v2()
    TO service_role;

COMMENT ON FUNCTION public.koaryu_release_schema_preflight_v2() IS
    'Operational exact-head V7 drift signal with runtime-invariant semantic ordering and exact least-privilege ACL state. Release authority remains the repository-pinned raw-catalog verifier; hosted exposed-schema and schema ACL readback remain separate operator gates.';
