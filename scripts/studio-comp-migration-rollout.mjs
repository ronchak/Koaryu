#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIR, "..");

export const ROLLOUT = Object.freeze({
  cliVersion: "2.95.4",
  stagingRef: "nxgsektqsgrtyfhawxbc",
  productionRef: "mimguepumzsgmcaycdsh",
  preHistory: "84:57ae4269ef4d75c249d59ef297661a3a",
  finalMigrationCount: 95,
  finalPendingVersions: Object.freeze([
    "20260727100000",
    "20260727110000",
    "20260801050957",
    "20260801060000",
    "20260801070000",
    "20260801080000",
    "20260801090000",
    "20260801091000",
    "20260801092000",
    "20260801093000",
    "20260801094000",
  ]),
  requiredAncestry: Object.freeze([
    "d12f5b8cb7fabf82383227a0e5d41113d32ff928",
    "a615bdfc9755b6c3e611e9f8829fdaf387b4f981",
    "0294fdbd2eecc72a8204222c244b7874fe35ada4",
  ]),
  migrations: Object.freeze([
    Object.freeze({
      filename: "20260727100000_atomic_studio_comp_management.sql",
      sha256: "2cd1e15dbe5a8224a0e4829bc92c6b01aae4699006d603d613d18cb4bc82c5c6",
    }),
    Object.freeze({
      filename: "20260727110000_order_billing_events_after_studio_comps.sql",
      sha256: "22faa79522ba2018780fb260401cd23830df553ee3faf0546b2af689eb51bfc0",
    }),
  ]),
});

export const EXPECTED_OPERATIONAL_MANIFEST =
  "53f7f07e127fcc6fc0c89717d603e31cc732a8ca49c7b86591f2c2711263831a";

export const EXPECTED_OPERATIONAL_READINESS =
  "true|95|20260801094000|" +
  ROLLOUT.finalPendingVersions.join(",") +
  "|0||release-db-attestation-v3";

export const EXPECTED_CATALOG_STATE =
  "columns=35:bdd37497e490bde0a8491192935ce84bb7c9c65d2021f8b487e993586c6bce46:0;" +
  "constraints=15:c5bf7762e24e3704c2541d2c17c5bff85f54bb0fd7eb4430cb958849afaedb3b:0;" +
  "functions=41:a132ecf3b41840c130df99d12b72b85e8955b81d0fd7ac8205e0d24b0f50fab4:0;" +
  "indexes=10:0d1e6e31bc5366e04d8ad554b3d7ce6d43d1e73e6fe91c1f50fed7a766636afb:0;" +
  "policies=16:259cc99c295d80442450cea438a462efd44748f2ace47456fca13133b52d17b8:0;" +
  "scoped_constraints=141:1ba160bb85d392c5b5a78142fc35d0e84fa75ffdca5d1e7ba2e6ccc9765734aa:0;" +
  "scoped_indexes=32:029ff9098f63de005a410481e5c4ad26148fc05bd6d47c0d0f7ad30cf3e81a77:0;" +
  "sequences=3:27451af3027130cfb193bd4eb9f59221773a89e46bcb855a7a809df1b54a7574:0;" +
  "table_acls=14:d34439755bc5f66626a1626c81f72d583a1b847b70ec02bc07ad127b2a270ddb:0;" +
  "tables=12:f56508ae1d3c712e7b239a1fe965adf88cec4e7f41f8d6b6db9ffce95f1bb76b:0;" +
  "triggers=12:61039a9e58e55b3aba5e7e2a40088fd492352560123bc5df30c7966cfd6d9efc:0";

export function validateOperationalManifest(value) {
  if (value !== EXPECTED_OPERATIONAL_MANIFEST) {
    throw new RolloutError(`Operational semantic/ACL manifest mismatch: ${value}.`);
  }
  return value;
}

export function validateOperationalReadiness(value) {
  if (value !== EXPECTED_OPERATIONAL_READINESS) {
    throw new RolloutError("V3 operational readiness did not match the exact release state.");
  }
  return value;
}

export const OPERATIONAL_READINESS_SQL = `
select ready::text || '|' || migration_count::text || '|' || migration_head || '|' ||
       array_to_string(pending_versions, ',') || '|' || cardinality(security_failures)::text || '|' ||
       coalesce(array_to_string(security_failures, ','), '') || '|' || manifest_version
  as operational_readiness
from public.koaryu_release_schema_preflight_v2()
`;

const HISTORY_SCHEMA_SQL = `
select
  count(*) filter (where column_name ~* '(hash|checksum|digest)')::text
  || ':' ||
  count(*) filter (
    where column_name = 'statements'
      and data_type = 'ARRAY'
      and udt_name = '_text'
  )::text
  || ':' ||
  count(*) filter (where column_name = 'version')::text
  || ':' ||
  count(*) filter (where column_name = 'name')::text
  || ':' ||
  count(*) filter (where column_name not in ('version', 'name', 'statements'))::text
  as history_schema
from information_schema.columns
where table_schema = 'supabase_migrations'
  and table_name = 'schema_migrations'
`;

const HISTORY_SQL = `
select count(*)::text || ':' ||
       md5(string_agg(version || ':' || name, '|' order by version))
  as history_state
from supabase_migrations.schema_migrations
`;

const TARGET_HISTORY_SQL = `
select coalesce(
         string_agg(version || ':' || name, '|' order by version),
         ''
       ) as target_history
from supabase_migrations.schema_migrations
where version >= '20260727100000'
`;

const OBJECT_COUNTS_SQL = `
select
  (select count(*)
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'preserve_studio_comp_provenance',
        'set_studio_comp_atomic',
        'clear_studio_comp_for_billing_event'
      ))::text
  || ':' ||
  (select count(*)
     from pg_trigger t
     join pg_class c on c.oid = t.tgrelid
     join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'studio_subscriptions'
      and t.tgname = 'preserve_studio_comp_provenance_on_metadata_update'
      and not t.tgisinternal)::text
  as object_counts
`;

const FUNCTION_STATE_SQL = `
with expected(signature, expected_config, service_execute) as (
  values
    (
      'public.preserve_studio_comp_provenance()',
      array['search_path=pg_catalog']::text[],
      false
    ),
    (
      'public.set_studio_comp_atomic(uuid, boolean, text, uuid, text, boolean)',
      array['search_path=public, pg_temp']::text[],
      true
    ),
    (
      'public.clear_studio_comp_for_billing_event(uuid, bigint)',
      array['search_path=public, pg_temp']::text[],
      true
    )
),
actual as (
  select
    format('%I.%I(%s)', n.nspname, p.proname, oidvectortypes(p.proargtypes)) as signature,
    md5(pg_get_functiondef(p.oid)) as definition_md5,
    owner.rolname as owner_name,
    p.prosecdef,
    p.proconfig,
    exists (
      select 1
        from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
       where acl.grantee = 0
         and acl.privilege_type = 'EXECUTE'
    ) as public_execute,
    has_function_privilege('anon', p.oid, 'EXECUTE') as anon_execute,
    has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_execute,
    exists (
      select 1
        from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
        join pg_roles granted on granted.oid = acl.grantee
       where granted.rolname = 'service_role'
         and acl.privilege_type = 'EXECUTE'
         and not acl.is_grantable
    ) as service_execute,
    exists (
      select 1
        from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
        left join pg_roles granted on granted.oid = acl.grantee
       where acl.privilege_type = 'EXECUTE'
         and acl.grantee <> p.proowner
         and not (
           granted.rolname = 'service_role'
           and p.proname in (
             'set_studio_comp_atomic',
             'clear_studio_comp_for_billing_event'
           )
           and not acl.is_grantable
         )
    ) as unexpected_execute_grant
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  join pg_roles owner on owner.oid = p.proowner
  where n.nspname = 'public'
    and p.proname in (
      'preserve_studio_comp_provenance',
      'set_studio_comp_atomic',
      'clear_studio_comp_for_billing_event'
    )
),
compared as (
  select
    e.signature,
    a.definition_md5,
    a.owner_name,
    a.prosecdef,
    a.proconfig,
    a.public_execute,
    a.anon_execute,
    a.authenticated_execute,
    a.service_execute,
    a.unexpected_execute_grant,
    e.expected_config,
    e.service_execute as expected_service_execute
  from expected e
  full join actual a using (signature)
)
select
  count(definition_md5)::text || ':' ||
  coalesce(
    md5(string_agg(
      signature || ':' || definition_md5 || ':' || owner_name || ':' ||
      prosecdef::text || ':' || array_to_string(proconfig, ',') || ':' ||
      public_execute::text || ':' || anon_execute::text || ':' ||
      authenticated_execute::text || ':' || service_execute::text,
      '|' order by signature
    )),
    md5('')
  ) || ':' ||
  count(*) filter (
    where definition_md5 is null
       or owner_name <> 'postgres'
       or prosecdef
       or proconfig is distinct from expected_config
       or public_execute
       or anon_execute
       or authenticated_execute
       or service_execute is distinct from expected_service_execute
       or unexpected_execute_grant
  )::text as function_state
from compared
`;

const TRIGGER_STATE_SQL = `
with actual as (
  select
    t.oid,
    md5(pg_get_triggerdef(t.oid)) as definition_md5,
    t.tgenabled,
    t.tgtype,
    t.tgattr::text as trigger_attributes,
    metadata.attnum::text as metadata_attribute,
    table_owner.rolname as table_owner,
    fn_namespace.nspname as function_schema,
    fn.proname as function_name,
    oidvectortypes(fn.proargtypes) as function_arguments
  from pg_trigger t
  join pg_class c on c.oid = t.tgrelid
  join pg_namespace n on n.oid = c.relnamespace
  join pg_roles table_owner on table_owner.oid = c.relowner
  join pg_proc fn on fn.oid = t.tgfoid
  join pg_namespace fn_namespace on fn_namespace.oid = fn.pronamespace
  join pg_attribute metadata
    on metadata.attrelid = c.oid
   and metadata.attname = 'metadata'
   and not metadata.attisdropped
  where n.nspname = 'public'
    and c.relname = 'studio_subscriptions'
    and t.tgname = 'preserve_studio_comp_provenance_on_metadata_update'
    and not t.tgisinternal
)
select
  count(*)::text || ':' ||
  coalesce(
    md5(string_agg(definition_md5 || ':' || table_owner, '|' order by definition_md5)),
    md5('')
  ) || ':' ||
  count(*) filter (
    where tgenabled <> 'O'
       or tgtype <> 19
       or trigger_attributes <> metadata_attribute
       or table_owner <> 'postgres'
       or function_schema <> 'public'
       or function_name <> 'preserve_studio_comp_provenance'
       or function_arguments <> ''
  )::text as trigger_state
from actual
`;

export const CATALOG_STATE_SQL = `
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
               ',' order by coalesce(grantor.rolname, 'PUBLIC'), coalesce(grantee.rolname, 'PUBLIC'), acl.privilege_type, acl.is_grantable
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
                    ',' order by coalesce(grantor.rolname, 'PUBLIC'), coalesce(grantee.rolname, 'PUBLIC'), acl.privilege_type, acl.is_grantable
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
         (select string_agg(role.rolname, ',' order by role.rolname)
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
    ('public.koaryu_release_schema_preflight_v2()', 'search_path=pg_catalog', true, true),
    ('private.koaryu_release_operational_manifest_v2()', 'search_path=pg_catalog', false, false),
    ('private.koaryu_release_operational_manifest_v2_base()', 'search_path=pg_catalog', false, false),
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
                    ',' order by coalesce(grantor.rolname, 'PUBLIC'), coalesce(grantee.rolname, 'PUBLIC'), acl.privilege_type, acl.is_grantable
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
                    ',' order by coalesce(grantor.rolname, 'PUBLIC'), coalesce(grantee.rolname, 'PUBLIC'), acl.privilege_type, acl.is_grantable
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
    ('stripe_connect_onboarding_bootstraps', 'stripe_connect_onboarding_bootstraps_recovery_expiry', 'c')
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
         encode(extensions.digest(convert_to(coalesce(string_agg(schema_name || '.' || table_name || ':' || coalesce(owner_name, '') || ':' || coalesce(relrowsecurity::text, '') || ':' || coalesce(actual_service_privileges, '') || ':' || coalesce(acl_state, ''), '|' order by schema_name, table_name), ''), 'UTF8'), 'sha256'), 'hex') as state_digest,
         count(*) filter (where owner_name is null or owner_name <> 'postgres' or relrowsecurity is distinct from rls_enabled or public_access or anon_access or authenticated_access or actual_service_privileges is distinct from service_privileges)::integer as failures
    from table_compared
  union all
  select 'table_acls', count(*)::integer,
         encode(extensions.digest(convert_to(coalesce(string_agg(schema_name || '.' || table_name || ':' || owner_name || ':' || acl_state, '|' order by schema_name, table_name), ''), 'UTF8'), 'sha256'), 'hex'),
         0::integer
    from table_acl_definitions
  union all
  select 'policies', count(*)::integer,
         encode(extensions.digest(convert_to(coalesce(string_agg(table_name || ':' || policy_name || ':' || coalesce(actual_permissive::text, '') || ':' || coalesce(actual_command_name, '') || ':' || coalesce(actual_role_names, '') || ':' || coalesce(actual_predicate_kind, ''), '|' order by table_name, policy_name), ''), 'UTF8'), 'sha256'), 'hex'),
         count(*) filter (where not expected_policy or not actual_policy or actual_permissive is distinct from permissive or actual_command_name is distinct from command_name or actual_role_names is distinct from role_names or actual_predicate_kind is distinct from predicate_kind)::integer
    from policy_compared
  union all
  select 'functions', count(*)::integer,
         encode(extensions.digest(convert_to(coalesce(string_agg(signature || ':' || coalesce(owner_name, '') || ':' || coalesce(language_name, '') || ':' || coalesce(actual_security_definer::text, '') || ':' || coalesce(actual_search_path_config, '') || ':' || coalesce(actual_service_execute::text, '') || ':' || coalesce(body_sha256, '') || ':' || coalesce(acl_state, ''), '|' order by signature), ''), 'UTF8'), 'sha256'), 'hex'),
         count(*) filter (where owner_name is null or owner_name <> 'postgres' or language_name not in ('sql', 'plpgsql') or actual_security_definer is distinct from security_definer or actual_search_path_config is distinct from search_path_config or public_execute or anon_execute or authenticated_execute or actual_service_execute is distinct from service_execute or unexpected_execute_grant)::integer
    from function_compared
  union all
  select 'triggers', count(*)::integer,
         encode(extensions.digest(convert_to(coalesce(string_agg(table_name || ':' || trigger_name || ':' || coalesce(actual_function_schema, '') || '.' || coalesce(actual_function_name, '') || ':' || coalesce(actual_trigger_type::text, '') || ':' || coalesce(tgenabled::text, '') || ':' || coalesce(definition_sha256, ''), '|' order by table_name, trigger_name), ''), 'UTF8'), 'sha256'), 'hex'),
         count(*) filter (where actual_function_schema is distinct from function_schema or actual_function_name is distinct from function_name or actual_trigger_type is distinct from trigger_type or tgenabled is distinct from 'O' or tgisinternal is distinct from false)::integer
    from trigger_compared
  union all
  select 'indexes', count(*)::integer,
         encode(extensions.digest(convert_to(coalesce(string_agg(index_name || ':' || coalesce(actual_table_name, '') || ':' || coalesce(actual_unique_index::text, '') || ':' || coalesce(actual_partial_index::text, '') || ':' || coalesce(indisvalid::text, '') || ':' || coalesce(indisready::text, '') || ':' || coalesce(definition_sha256, ''), '|' order by index_name), ''), 'UTF8'), 'sha256'), 'hex'),
         count(*) filter (where actual_table_name is distinct from table_name or actual_unique_index is distinct from unique_index or actual_partial_index is distinct from partial_index or indisvalid is distinct from true or indisready is distinct from true)::integer
    from index_compared
  union all
  select 'sequences', count(*)::integer,
         encode(extensions.digest(convert_to(coalesce(string_agg(table_name || '.' || column_name || ':' || coalesce(owner_name, '') || ':' || coalesce(actual_service_usage::text, '') || ':' || coalesce(actual_service_select::text, '') || ':' || coalesce(actual_service_update::text, '') || ':' || coalesce(acl_state, ''), '|' order by table_name, column_name), ''), 'UTF8'), 'sha256'), 'hex'),
         count(*) filter (where owner_name is null or owner_name <> 'postgres' or public_access or anon_access or authenticated_access or actual_service_usage is distinct from service_usage or actual_service_select is distinct from service_select or actual_service_update is distinct from service_update)::integer
    from sequence_compared
  union all
  select 'columns', count(*)::integer,
         encode(extensions.digest(convert_to(coalesce(string_agg(table_name || '.' || column_name || ':' || coalesce(actual_data_type, '') || ':' || coalesce(actual_nullable::text, '') || ':' || coalesce(actual_identity_column::text, ''), '|' order by table_name, column_name), ''), 'UTF8'), 'sha256'), 'hex'),
         count(*) filter (where actual_data_type is distinct from data_type or actual_nullable is distinct from nullable or actual_identity_column is distinct from identity_column)::integer
    from column_compared
  union all
  select 'constraints', count(*)::integer,
         encode(extensions.digest(convert_to(coalesce(string_agg(table_name || ':' || constraint_identity || ':' || coalesce(actual_constraint_type, '') || ':' || coalesce(convalidated::text, '') || ':' || coalesce(definition_sha256, ''), '|' order by table_name, constraint_identity), ''), 'UTF8'), 'sha256'), 'hex'),
         count(*) filter (where actual_constraint_type is distinct from constraint_type or convalidated is distinct from true)::integer
    from constraint_compared
  union all
  select 'scoped_indexes', count(*)::integer,
         encode(extensions.digest(convert_to(coalesce(string_agg(schema_name || '.' || table_name || ':' || index_name || ':' || definition_sha256, '|' order by schema_name, table_name, index_name), ''), 'UTF8'), 'sha256'), 'hex'),
         0::integer
    from scoped_index_definitions
  union all
  select 'scoped_constraints', count(*)::integer,
         encode(extensions.digest(convert_to(coalesce(string_agg(schema_name || '.' || table_name || ':' || constraint_name || ':' || constraint_type || ':' || convalidated::text || ':' || definition_sha256, '|' order by schema_name, table_name, constraint_name), ''), 'UTF8'), 'sha256'), 'hex'),
         count(*) filter (where not convalidated)::integer
    from scoped_constraint_definitions
)
select string_agg(category || '=' || object_count::text || ':' || state_digest || ':' || failures::text, ';' order by category) as catalog_state
from states
`;

class RolloutError extends Error {}

function digest(algorithm, value) {
  return createHash(algorithm).update(value).digest("hex");
}

function hashFile(filename) {
  return digest("sha256", fs.readFileSync(filename));
}

function assertPlainText(name, value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new RolloutError(`${name} is required.`);
  }
  if (!/^[\x20-\x7e]+$/.test(value) || value.trim() !== value) {
    throw new RolloutError(`${name} must be plain printable ASCII without surrounding whitespace.`);
  }
  return value;
}

export function assertSafeCredentialedTransport(env) {
  const trustOverrideNames = new Set([
    "CURL_CA_BUNDLE",
    "NODE_EXTRA_CA_CERTS",
    "NODE_TLS_REJECT_UNAUTHORIZED",
    "PGSSLMODE",
    "PGSSLROOTCERT",
    "REQUESTS_CA_BUNDLE",
    "SSL_CERT_DIR",
    "SSL_CERT_FILE",
  ]);
  const overrideNames = Object.keys(env).filter(
    (name) =>
      /^(?:https?|all|ftp)_proxy$/i.test(name) ||
      name === "GIT_PROXY_COMMAND" ||
      trustOverrideNames.has(name),
  );
  const active = overrideNames.filter(
    (name) => typeof env[name] === "string" && env[name].length > 0,
  );
  if (active.length > 0) {
    throw new RolloutError(
      `Refusing credentialed work while ambient proxy or TLS trust override variables are present: ${active.sort().join(", ")}.`,
    );
  }
}

export function parseArguments(argv) {
  const result = {
    mode: "inspect",
    target: null,
    candidateSha: null,
    confirmProject: null,
    approvalRecord: null,
    inspectionToken: null,
    expectedProviderFingerprint: null,
    confirmedRestoreWindow: null,
    restoreDecisionAuthority: null,
    approveStagingApply: false,
    humanProductionOperator: false,
  };
  const valueOptions = new Map([
    ["--mode", "mode"],
    ["--target", "target"],
    ["--candidate-sha", "candidateSha"],
    ["--confirm-project", "confirmProject"],
    ["--approval-record", "approvalRecord"],
    ["--inspection-token", "inspectionToken"],
    ["--expected-provider-fingerprint", "expectedProviderFingerprint"],
    ["--confirmed-restore-window", "confirmedRestoreWindow"],
    ["--restore-decision-authority", "restoreDecisionAuthority"],
  ]);
  const booleanOptions = new Map([
    ["--approve-staging-apply", "approveStagingApply"],
    ["--human-production-operator", "humanProductionOperator"],
  ]);
  const seen = new Set();

  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (seen.has(option)) {
      throw new RolloutError(`Duplicate option: ${option}`);
    }
    seen.add(option);
    if (valueOptions.has(option)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new RolloutError(`${option} requires a value.`);
      }
      result[valueOptions.get(option)] = assertPlainText(option, value);
      index += 1;
      continue;
    }
    if (booleanOptions.has(option)) {
      result[booleanOptions.get(option)] = true;
      continue;
    }
    throw new RolloutError(`Unknown option: ${option}`);
  }

  if (!new Set(["packet", "inspect", "dry-run", "apply"]).has(result.mode)) {
    throw new RolloutError("--mode must be packet, inspect, dry-run, or apply.");
  }
  if (result.mode !== "packet" && !new Set(["staging", "production"]).has(result.target)) {
    throw new RolloutError("--target must be staging or production.");
  }
  if (result.mode === "packet" && result.target !== null) {
    throw new RolloutError("--mode packet is local-only and must not specify --target.");
  }
  if (!/^[0-9a-f]{40}$/.test(result.candidateSha ?? "")) {
    throw new RolloutError("--candidate-sha must be a full lowercase 40-character commit SHA.");
  }
  if (
    result.expectedProviderFingerprint !== null &&
    !/^functions=3:[0-9a-f]{32}:0;trigger=1:[0-9a-f]{32}:0;catalog=[a-z0-9_=;:]+$/.test(
      result.expectedProviderFingerprint,
    )
  ) {
    throw new RolloutError("--expected-provider-fingerprint has an invalid shape.");
  }
  if (result.inspectionToken !== null && !/^[0-9a-f]{64}$/.test(result.inspectionToken)) {
    throw new RolloutError("--inspection-token has an invalid shape.");
  }
  if (new Set(["packet", "inspect"]).has(result.mode) && result.inspectionToken !== null) {
    throw new RolloutError("--inspection-token is created by inspect and cannot be supplied to inspect.");
  }
  if (new Set(["dry-run", "apply"]).has(result.mode) && result.inspectionToken === null) {
    throw new RolloutError("Target inspection evidence is required through --inspection-token.");
  }
  if (result.mode !== "apply") {
    const applyOnly = [
      result.confirmProject,
      result.approvalRecord,
      result.confirmedRestoreWindow,
      result.restoreDecisionAuthority,
      result.approveStagingApply,
      result.humanProductionOperator,
    ];
    if (applyOnly.some(Boolean)) {
      throw new RolloutError("Apply authorization options are valid only with --mode apply.");
    }
  }
  if (new Set(["packet", "dry-run"]).has(result.mode) && result.expectedProviderFingerprint) {
    throw new RolloutError(
      "--expected-provider-fingerprint is valid only for inspection comparison or production apply.",
    );
  }
  return result;
}

export function validateApplyAuthorization(config) {
  if (config.mode !== "apply") return;
  const projectRef = config.target === "staging" ? ROLLOUT.stagingRef : ROLLOUT.productionRef;
  if (config.confirmProject !== projectRef) {
    throw new RolloutError(`--confirm-project must exactly equal the pinned ${config.target} ref.`);
  }
  assertPlainText("--approval-record", config.approvalRecord);
  if (config.target === "staging") {
    if (
      !config.approveStagingApply ||
      config.humanProductionOperator ||
      config.expectedProviderFingerprint ||
      config.confirmedRestoreWindow ||
      config.restoreDecisionAuthority
    ) {
      throw new RolloutError(
        "Staging apply requires --approve-staging-apply and must not use production-only authorization fields.",
      );
    }
    return;
  }
  if (!config.humanProductionOperator) {
    throw new RolloutError("Production apply requires --human-production-operator.");
  }
  if (!config.expectedProviderFingerprint) {
    throw new RolloutError(
      "Production apply requires the approved staging --expected-provider-fingerprint.",
    );
  }
  assertPlainText("--confirmed-restore-window", config.confirmedRestoreWindow);
  assertPlainText("--restore-decision-authority", config.restoreDecisionAuthority);
}

export function buildInspectionToken(packet, target, state) {
  return digest(
    "sha256",
    [packet.candidateSha, packet.postHistory, packet.sourceManifestSha256, target, state].join("|"),
  );
}

export function verifySourceTree(sourceRoot, candidateSha, commandRunner = runCommand) {
  const actualSha = commandRunner("git", ["-C", sourceRoot, "rev-parse", "HEAD"], {
    label: "candidate SHA read",
  }).trim();
  if (actualSha !== candidateSha) {
    throw new RolloutError(
      `Candidate SHA mismatch: expected ${candidateSha}, found ${actualSha}.`,
    );
  }

  for (const requiredSha of ROLLOUT.requiredAncestry) {
    commandRunner("git", ["-C", sourceRoot, "merge-base", "--is-ancestor", requiredSha, candidateSha], {
      label: `required ancestry check for ${requiredSha}`,
    });
  }

  const migrationsDirectory = path.join(sourceRoot, "supabase", "migrations");
  const filenames = fs
    .readdirSync(migrationsDirectory)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  if (filenames.length < 86) {
    throw new RolloutError(`Candidate must contain at least 86 migrations, found ${filenames.length}.`);
  }
  for (const filename of filenames) {
    if (!/^[0-9]{14}_[A-Za-z0-9_]+\.sql$/.test(filename)) {
      throw new RolloutError(`Invalid migration filename in candidate: ${filename}`);
    }
  }

  const orderedHistory = filenames
    .map((filename) => {
      const separator = filename.indexOf("_");
      return `${filename.slice(0, separator)}:${filename.slice(separator + 1, -4)}`;
    })
    .join("|");
  const preHistory = `84:${digest("md5", filenames.slice(0, 84)
    .map((filename) => {
      const separator = filename.indexOf("_");
      return `${filename.slice(0, separator)}:${filename.slice(separator + 1, -4)}`;
    })
    .join("|"))}`;
  const postHistory = `${filenames.length}:${digest("md5", orderedHistory)}`;
  if (preHistory !== ROLLOUT.preHistory) {
    throw new RolloutError("Candidate's first 84 migration names do not match the production baseline.");
  }
  const expectedTail = ROLLOUT.migrations.map(({ filename }) => filename);
  if (JSON.stringify(filenames.slice(84, 86)) !== JSON.stringify(expectedTail)) {
    throw new RolloutError("The July studio-comp pair must be the first two migrations after baseline 84.");
  }

  for (const migration of ROLLOUT.migrations) {
    const actualHash = hashFile(path.join(migrationsDirectory, migration.filename));
    if (actualHash !== migration.sha256) {
      throw new RolloutError(`Source hash mismatch for ${migration.filename}.`);
    }
  }

  const pendingMigrations = filenames.slice(84);
  const pendingVersions = pendingMigrations.map((filename) => filename.slice(0, 14));
  const pendingManifest = pendingMigrations.map((filename) => ({
    filename,
    sha256: hashFile(path.join(migrationsDirectory, filename)),
  }));
  return {
    candidateSha,
    migrationCount: filenames.length,
    postHistory,
    postTargetHistory: pendingMigrations
      .map((filename) => {
        const separator = filename.indexOf("_");
        return `${filename.slice(0, separator)}:${filename.slice(separator + 1, -4)}`;
      })
      .join("|"),
    pendingMigrations,
    integrationComplete:
      filenames.length === ROLLOUT.finalMigrationCount &&
      JSON.stringify(pendingVersions) === JSON.stringify(ROLLOUT.finalPendingVersions),
    sourceManifestSha256: digest(
      "sha256",
      pendingManifest.map(({ filename, sha256 }) => `${filename}:${sha256}`).join("|"),
    ),
    pendingManifest,
  };
}

export function classifyStateSnapshot(snapshot, packet, expectedProviderFingerprint = null) {
  const {
    history,
    targetHistory,
    objectCounts,
    functionState,
    triggerState,
    catalogState,
    operationalReadiness,
  } = snapshot;
  if (snapshot.historySchema !== "0:1:1:1:0") {
    throw new RolloutError(
      "Supabase migration history did not have the expected no-hash/statement-array shape.",
    );
  }
  if (history === ROLLOUT.preHistory) {
    if (targetHistory !== "" || objectCounts !== "0:0") {
      throw new RolloutError(
        "Migration history is pre-state but studio-comp objects already exist; stop for drift review.",
      );
    }
    return { state: "pre", providerFingerprint: null };
  }
  if (history === packet.postHistory) {
    if (!packet.integrationComplete) {
      throw new RolloutError(
        "Candidate does not contain the exact final 95-migration sequence; post-state cannot be certified.",
      );
    }
    if (targetHistory !== packet.postTargetHistory || objectCounts !== "3:1") {
      throw new RolloutError("Post-state history does not have the exact expected studio-comp objects.");
    }
    if (!/^3:[0-9a-f]{32}:0$/.test(functionState ?? "")) {
      throw new RolloutError("Function owner, definition, security, search path, or ACL checks failed.");
    }
    if (!/^1:[0-9a-f]{32}:0$/.test(triggerState ?? "")) {
      throw new RolloutError("Trigger definition, binding, enabled state, or metadata column check failed.");
    }
    validateCatalogState(catalogState);
    validateOperationalReadiness(operationalReadiness);
    const providerFingerprint =
      `functions=${functionState};trigger=${triggerState};catalog=${catalogState}`;
    if (expectedProviderFingerprint && providerFingerprint !== expectedProviderFingerprint) {
      throw new RolloutError("Provider fingerprint does not match the approved staging evidence.");
    }
    return { state: "post", providerFingerprint };
  }
  throw new RolloutError(
    `Unexpected migration history ${history}; expected exact pre-state or post-state.`,
  );
}

export function validateCatalogState(catalogState) {
  const expectedCatalog = new Map(
    EXPECTED_CATALOG_STATE.split(";").map((part) => {
      const match = /^([a-z_]+)=([0-9]+):([0-9a-f]{64}):0$/.exec(part);
      return [match[1], [Number(match[2]), match[3]]];
    }),
  );
  const catalogParts = (catalogState ?? "").split(";");
  if (catalogParts.length !== expectedCatalog.size) {
    throw new RolloutError("Required pending-migration catalog fingerprint is incomplete.");
  }
  for (const part of catalogParts) {
    const match = /^([a-z_]+)=([0-9]+):([0-9a-f]{64}):([0-9]+)$/.exec(part);
    const expected = match ? expectedCatalog.get(match[1]) : null;
    if (
      !match ||
      expected?.[0] !== Number(match[2]) ||
      expected?.[1] !== match[3] ||
      match[4] !== "0"
    ) {
      throw new RolloutError(
        `Repository-pinned raw catalog manifest mismatch: ${catalogState}.`,
      );
    }
  }
  if (new Set(catalogParts.map((part) => part.split("=")[0])).size !== expectedCatalog.size) {
    throw new RolloutError("Required pending-migration catalog categories are duplicated.");
  }
  return catalogState;
}

export function extractPendingMigrations(output) {
  return [...output.matchAll(/\b(20[0-9]{12}_[A-Za-z0-9_]+\.sql)\b/g)].map(
    (match) => match[1],
  );
}

export function assertExactPendingMigrations(output, packet) {
  const expected = packet.pendingMigrations;
  const actual = extractPendingMigrations(output);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new RolloutError(
      `Dry-run migration set mismatch: expected ${expected.join(", ")}; found ${actual.join(", ") || "none"}.`,
    );
  }
  return actual;
}

function runCommand(command, args, { cwd = REPOSITORY_ROOT, env = process.env, label = command } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) {
    throw new RolloutError(`${label} failed (exit ${result.status ?? "unavailable"}).`);
  }
  return result.stdout;
}

export function parseSingleValueCsv(output, expectedHeader) {
  const malformed = (reason) => {
    throw new RolloutError(`${expectedHeader} query returned ${reason}.`);
  };
  if (typeof output !== "string") {
    malformed("an unexpected CSV shape");
  }
  if (/[\x00-\x09\x0b\x0c\x0e-\x1f\x7f]/.test(output)) {
    malformed("noncanonical control characters");
  }

  const records = [];
  let record = [];
  let field = "";
  let state = "start";
  let justEndedRecord = false;

  const endField = () => {
    record.push(field);
    field = "";
    state = "start";
  };
  const endRecord = () => {
    endField();
    records.push(record);
    record = [];
    justEndedRecord = true;
  };

  for (let index = 0; index < output.length;) {
    const character = output[index];
    justEndedRecord = false;

    if (state === "quoted") {
      if (character === '"') {
        if (output[index + 1] === '"') {
          field += '"';
          index += 2;
        } else {
          state = "after_quote";
          index += 1;
        }
      } else if (character === "\r") {
        if (output[index + 1] !== "\n") {
          malformed("a malformed CSV record ending");
        }
        field += "\r\n";
        index += 2;
      } else {
        field += character;
        index += 1;
      }
      continue;
    }

    if (state === "after_quote") {
      if (character === ",") {
        endField();
        index += 1;
      } else if (character === "\n") {
        endRecord();
        index += 1;
      } else if (character === "\r" && output[index + 1] === "\n") {
        endRecord();
        index += 2;
      } else {
        malformed("malformed CSV quoting");
      }
      continue;
    }

    if (character === '"') {
      if (state !== "start") {
        malformed("malformed CSV quoting");
      }
      state = "quoted";
      index += 1;
    } else if (character === ",") {
      endField();
      index += 1;
    } else if (character === "\n") {
      endRecord();
      index += 1;
    } else if (character === "\r") {
      if (output[index + 1] !== "\n") {
        malformed("a malformed CSV record ending");
      }
      endRecord();
      index += 2;
    } else {
      field += character;
      state = "unquoted";
      index += 1;
    }
  }

  if (state === "quoted") {
    malformed("malformed CSV quoting");
  }
  if (!justEndedRecord) {
    endRecord();
  }
  if (
    records.length !== 2 ||
    records[0].length !== 1 ||
    records[0][0] !== expectedHeader ||
    records[1].length !== 1
  ) {
    malformed("an unexpected CSV shape");
  }
  return records[1][0];
}

function querySingleValue(sourceRoot, sql, header, env) {
  const output = runCommand(
    "supabase",
    ["db", "query", "--linked", "--agent=no", "--output", "csv", sql],
    { cwd: sourceRoot, env, label: `${header} read` },
  );
  return parseSingleValueCsv(output, header);
}

export function readRemoteState(
  sourceRoot,
  packet,
  env,
  expectedProviderFingerprint = null,
  query = querySingleValue,
) {
  const snapshot = {
    historySchema: query(sourceRoot, HISTORY_SCHEMA_SQL, "history_schema", env),
    history: query(sourceRoot, HISTORY_SQL, "history_state", env),
    targetHistory: query(sourceRoot, TARGET_HISTORY_SQL, "target_history", env),
    objectCounts: query(sourceRoot, OBJECT_COUNTS_SQL, "object_counts", env),
    functionState: null,
    triggerState: null,
    catalogState: null,
    operationalReadiness: null,
  };
  if (snapshot.history === packet.postHistory && snapshot.objectCounts === "3:1") {
    snapshot.functionState = query(
      sourceRoot,
      FUNCTION_STATE_SQL,
      "function_state",
      env,
    );
    snapshot.triggerState = query(
      sourceRoot,
      TRIGGER_STATE_SQL,
      "trigger_state",
      env,
    );
    snapshot.catalogState = query(
      sourceRoot,
      CATALOG_STATE_SQL,
      "catalog_state",
      env,
    );
    snapshot.operationalReadiness = query(
      sourceRoot,
      OPERATIONAL_READINESS_SQL,
      "operational_readiness",
      env,
    );
  }
  return classifyStateSnapshot(snapshot, packet, expectedProviderFingerprint);
}

function assertLinkedProjectRef(sourceRoot, expectedRef) {
  const refPath = path.join(sourceRoot, "supabase", ".temp", "project-ref");
  const raw = fs.readFileSync(refPath, "utf8");
  if (raw !== expectedRef && raw !== `${expectedRef}\n`) {
    throw new RolloutError("Saved Supabase project ref is missing, noncanonical, or mismatched.");
  }
}

function runDryRun(sourceRoot, packet, env) {
  const output = runCommand(
    "supabase",
    ["db", "push", "--linked", "--dry-run", "--agent=no"],
    { cwd: sourceRoot, env, label: "Supabase migration dry-run" },
  );
  return assertExactPendingMigrations(output, packet);
}

export function buildProductionConfirmationPhrase(packet) {
  return [
    "APPLY",
    packet.pendingMigrations.length,
    "MIGRATIONS FROM",
    packet.candidateSha,
    "MANIFEST",
    packet.sourceManifestSha256,
    "TO",
    ROLLOUT.productionRef,
  ].join(" ");
}

async function confirmProductionApply(packet) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new RolloutError("Production apply requires an interactive human terminal.");
  }
  const expected = buildProductionConfirmationPhrase(packet);
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await prompt.question(`Type exactly '${expected}' to continue: `);
  prompt.close();
  if (answer !== expected) {
    throw new RolloutError("Production confirmation did not match exactly.");
  }
}

function usage() {
  return `Usage:
  node scripts/studio-comp-migration-rollout.mjs --mode packet --candidate-sha <full-sha>
  node scripts/studio-comp-migration-rollout.mjs --target <staging|production> --candidate-sha <full-sha> [--mode <inspect|dry-run|apply>]

Dry-run and apply require the inspection_token from a preceding inspect. Apply additionally requires:
  --confirm-project <exact-ref> --approval-record <durable-id-or-url>
  staging:    --approve-staging-apply
  production: --human-production-operator --expected-provider-fingerprint <staging-fingerprint>
              --confirmed-restore-window <window-or-record>
              --restore-decision-authority <named-person>

inspect is the default mode. Agents must never use production apply.`;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const config = parseArguments(argv);
  validateApplyAuthorization(config);

  if (config.mode !== "packet") {
    assertSafeCredentialedTransport(env);
  }

  const cliVersion = runCommand("supabase", ["--version"], { env, label: "Supabase CLI version read" })
    .split("\n")[0];
  if (cliVersion !== ROLLOUT.cliVersion) {
    throw new RolloutError(
      `Supabase CLI version mismatch: expected ${ROLLOUT.cliVersion}, found ${cliVersion}.`,
    );
  }

  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "koaryu-studio-comp-rollout-"));
  const sourceRoot = path.join(temporaryRoot, "candidate");
  let worktreeAdded = false;
  try {
    runCommand("git", ["worktree", "add", "--detach", sourceRoot, config.candidateSha], {
      label: "detached candidate worktree creation",
    });
    worktreeAdded = true;
    const packet = verifySourceTree(sourceRoot, config.candidateSha);
    if (config.mode === "packet") {
      console.log(`candidate_sha=${packet.candidateSha}`);
      console.log(`cli_version=${ROLLOUT.cliVersion}`);
      console.log(`pre_history=${ROLLOUT.preHistory}`);
      console.log(`post_history=${packet.postHistory}`);
      console.log(`pending_migrations=${packet.pendingMigrations.join(",")}`);
      console.log(`source_manifest_sha256=${packet.sourceManifestSha256}`);
      console.log(`integration_complete=${packet.integrationComplete}`);
      console.log("remote_content_hashes=absent");
      return;
    }

    const projectRef = config.target === "staging" ? ROLLOUT.stagingRef : ROLLOUT.productionRef;
    if (!packet.integrationComplete) {
      throw new RolloutError(
        "Provider inspection requires the exact final 95-migration candidate through 094000.",
      );
    }
    runCommand(
      "supabase",
      ["link", "--project-ref", projectRef, "--yes", "--agent=no"],
      { cwd: sourceRoot, env, label: "Supabase project link" },
    );
    assertLinkedProjectRef(sourceRoot, projectRef);

    const before = readRemoteState(
      sourceRoot,
      packet,
      env,
      config.mode === "inspect" ? config.expectedProviderFingerprint : null,
    );
    const inspectionToken = buildInspectionToken(packet, config.target, before.state);
    if (config.mode === "inspect") {
      console.log(`target=${config.target}`);
      console.log(`project_ref=${projectRef}`);
      console.log(`candidate_sha=${packet.candidateSha}`);
      console.log(`post_history=${packet.postHistory}`);
      console.log(`pending_migrations=${packet.pendingMigrations.join(",")}`);
      console.log(`source_manifest_sha256=${packet.sourceManifestSha256}`);
      console.log("remote_content_hashes=absent");
      console.log(`state=${before.state}`);
      console.log(`inspection_token=${inspectionToken}`);
      if (before.providerFingerprint) {
        console.log(`provider_fingerprint=${before.providerFingerprint}`);
      }
      return;
    }
    if (before.state !== "pre") {
      throw new RolloutError(`${config.mode} requires the exact 84-migration pre-state.`);
    }
    if (config.inspectionToken !== inspectionToken) {
      throw new RolloutError(
        "--inspection-token does not match the preceding inspection's candidate, target, and state.",
      );
    }

    const pending = runDryRun(sourceRoot, packet, env);
    console.log(`dry_run_migrations=${pending.join(",")}`);
    if (config.mode === "dry-run") return;

    if (config.target === "production") {
      await confirmProductionApply(packet);
    }
    try {
      runCommand("supabase", ["db", "push", "--linked", "--agent=no"], {
        cwd: sourceRoot,
        env,
        label: "Supabase migration apply",
      });
    } catch (error) {
      throw new RolloutError(
        `Migration apply failed and may have changed remote state. Stop and inspect; do not revert history or objects. ${error.message}`,
      );
    }
    const after = readRemoteState(sourceRoot, packet, env, config.expectedProviderFingerprint);
    if (after.state !== "post") {
      throw new RolloutError("Migration apply did not reach the exact expected post-state.");
    }
    console.log(`target=${config.target}`);
    console.log(`project_ref=${projectRef}`);
    console.log(`candidate_sha=${packet.candidateSha}`);
    console.log(`post_history=${packet.postHistory}`);
    console.log(`source_manifest_sha256=${packet.sourceManifestSha256}`);
    console.log("state=post");
    console.log(`provider_fingerprint=${after.providerFingerprint}`);
  } finally {
    if (worktreeAdded) {
      spawnSync("git", ["worktree", "remove", "--force", sourceRoot], {
        cwd: REPOSITORY_ROOT,
        encoding: "utf8",
        stdio: "ignore",
      });
    }
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`Studio-comp migration rollout refused: ${error.message}`);
    console.error(usage());
    process.exitCode = error instanceof RolloutError ? 1 : 2;
  });
}
