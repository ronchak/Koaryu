#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 8 ]]; then
  echo "Usage: scripts/verify-v29-v30-restore-contract.sh pg_dump pg_restore createdb psql host port temp-dir repository-root" >&2
  exit 2
fi

pg_dump_bin="$1"
pg_restore_bin="$2"
createdb_bin="$3"
psql_bin="$4"
socket_dir="$5"
pg_port="$6"
temp_dir="$7"
repository_root="$8"
restored_database="koaryu_v30_restore_contract"
dump_path="$temp_dir/v26-before-v27.dump"
source_args=(--host="$socket_dir" --port="$pg_port" --username=postgres --dbname=postgres --no-password --no-psqlrc --set=ON_ERROR_STOP=1 --quiet)
restored_args=(--host="$socket_dir" --port="$pg_port" --username=postgres --dbname="$restored_database" --no-password --no-psqlrc --set=ON_ERROR_STOP=1 --quiet)

cleanup() {
  "$psql_bin" "${source_args[@]}" --command="DROP DATABASE IF EXISTS $restored_database WITH (FORCE);" >/dev/null 2>&1 || true
}
trap cleanup EXIT HUP INT TERM
cleanup

if [[ ! -f "$dump_path" ]]; then
  echo "Verified V26 restore artifact is missing: $dump_path" >&2
  exit 1
fi

"$createdb_bin" --host="$socket_dir" --port="$pg_port" --username=postgres \
  --no-password --owner=postgres --template=template0 "$restored_database"
"$psql_bin" "${restored_args[@]}" \
  --command='ALTER DATABASE koaryu_v30_restore_contract SET search_path TO "$user", public, extensions;'
"$pg_restore_bin" --host="$socket_dir" --port="$pg_port" --username=postgres \
  --dbname="$restored_database" --no-password --exit-on-error "$dump_path"

apply_migration() {
  local version="$1"
  local name="$2"
  "$psql_bin" "${restored_args[@]}" --single-transaction \
    --file="$repository_root/supabase/migrations/${version}_${name}.sql" \
    --command="INSERT INTO supabase_migrations.schema_migrations(version,name) VALUES ('$version','$name');"
}

apply_migration "20260826051527" "billing_provider_operations_and_payer_consent"
apply_migration "20260826073728" "billing_provider_operation_steps"
apply_migration "20260826102840" "enrollment_period_safe_transitions"

predecessor_readiness="$("$psql_bin" "${restored_args[@]}" --tuples-only --no-align --command="SELECT ready::TEXT || '|' || migration_count::TEXT || '|' || migration_head || '|' || cardinality(security_failures)::TEXT || '|' || COALESCE(array_to_string(security_failures,','),'') || '|' || manifest_version FROM public.koaryu_release_schema_preflight_v10();" | tr -d '\r\n')"
if [[ "$predecessor_readiness" != "true|124|20260826102840|0||release-db-attestation-v29" ]]; then
  echo "Restored V29 predecessor readiness mismatch: $predecessor_readiness" >&2
  exit 1
fi

apply_migration "20260826155911" "payments_workflow_catalog_and_replay_repairs"

read_value() {
  "$psql_bin" "${restored_args[@]}" --tuples-only --no-align --command="$1" | tr -d '\r\n'
}

replay_manifest="$(read_value 'SELECT private.koaryu_release_payments_replay_repairs_manifest_v30();')"
operational_contract="$(read_value 'SELECT private.koaryu_release_operational_contract_v30();')"
operational_manifest="$(read_value 'SELECT private.koaryu_release_operational_manifest_v11();')"
predecessor_manifest="$(read_value 'SELECT private.koaryu_release_operational_manifest_v10();')"
transition_manifest="$(read_value 'SELECT private.koaryu_release_enrollment_transition_manifest_v29();')"
readiness="$(read_value "SELECT ready::TEXT || '|' || migration_count::TEXT || '|' || migration_head || '|' || cardinality(security_failures)::TEXT || '|' || COALESCE(array_to_string(security_failures,','),'') || '|' || manifest_version FROM public.koaryu_release_schema_preflight_v11();")"
compat_readiness="$(read_value "SELECT ready::TEXT || '|' || migration_count::TEXT || '|' || migration_head || '|' || cardinality(security_failures)::TEXT || '|' || COALESCE(array_to_string(security_failures,','),'') || '|' || manifest_version FROM public.koaryu_release_schema_preflight_v10();")"
catalog_sql="$(cd "$repository_root" && node --input-type=module --eval "import {CATALOG_STATE_SQL} from './scripts/studio-comp-migration-rollout.mjs'; process.stdout.write(CATALOG_STATE_SQL);")"
catalog_state="$(read_value "$catalog_sql")"
v28_expectation="$(read_value "SELECT count(*)::TEXT || ':' || encode(extensions.digest(convert_to(COALESCE(string_agg(expectation_key || ':' || expected_sha256, '|' ORDER BY expectation_key COLLATE \"C\"),''),'UTF8'),'sha256'),'hex') FROM private.koaryu_release_v28_expectations;")"
v29_expectation="$(read_value "SELECT count(*)::TEXT || ':' || encode(extensions.digest(convert_to(COALESCE(string_agg(expectation_key || ':' || expected_sha256, '|' ORDER BY expectation_key COLLATE \"C\"),''),'UTF8'),'sha256'),'hex') FROM private.koaryu_release_v29_expectations;")"
v30_expectation="$(read_value "SELECT count(*)::TEXT || ':' || encode(extensions.digest(convert_to(COALESCE(string_agg(expectation_key || ':' || expected_sha256, '|' ORDER BY expectation_key COLLATE \"C\"),''),'UTF8'),'sha256'),'hex') FROM private.koaryu_release_v30_expectations;")"
authorization_surface="$(read_value "SELECT has_function_privilege('service_role','public.set_studio_live_billing_authorization_operations_v1(uuid,text,boolean,timestamp with time zone,text,uuid,text[],text,text)','EXECUTE')::TEXT || ':' || has_function_privilege('service_role','public.set_studio_live_billing_authorization_scope_v3(uuid,text,boolean,timestamp with time zone,text,uuid,text,text)','EXECUTE')::TEXT || ':' || has_function_privilege('service_role','public.authorize_studio_live_billing_mutation_atomic(uuid,text,text,text,text)','EXECUTE')::TEXT || ':' || has_function_privilege('service_role','public.authorize_studio_live_billing_scope_v3(uuid,text,text,text,text)','EXECUTE')::TEXT || ':' || has_function_privilege('service_role','public.set_studio_live_billing_authorization_atomic(uuid,text,boolean,timestamp with time zone,text,uuid,text,text)','EXECUTE')::TEXT;")"
allowlist_column="$(read_value "SELECT format_type(a.atttypid,a.atttypmod) || ':' || a.attnotnull::TEXT || ':' || COALESCE(pg_get_expr(d.adbin,d.adrelid),'') FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid='public.studio_live_billing_authorizations'::REGCLASS AND a.attname='allowed_operations' AND NOT a.attisdropped;")"
allowlist_constraint="$(read_value "SELECT contype::TEXT || ':' || convalidated::TEXT FROM pg_constraint WHERE conrelid='public.studio_live_billing_authorizations'::REGCLASS AND conname='studio_live_billing_authorizations_operation_set_exact';")"

echo "RESTORED_V30_REPLAY_REPAIRS_MANIFEST=$replay_manifest"
echo "RESTORED_V30_OPERATIONAL_CONTRACT=$operational_contract"
echo "RESTORED_V30_OPERATIONAL_MANIFEST=$operational_manifest"
echo "RESTORED_V30_PREDECESSOR_OPERATIONAL_MANIFEST=$predecessor_manifest"
echo "RESTORED_V30_TRANSITION_MANIFEST=$transition_manifest"
echo "RESTORED_V30_READINESS=$readiness"
echo "RESTORED_V30_COMPAT_V29_READINESS=$compat_readiness"
echo "RESTORED_V30_CATALOG_STATE=$catalog_state"
echo "RESTORED_V30_V28_EXPECTATION_STATE=$v28_expectation"
echo "RESTORED_V30_V29_EXPECTATION_STATE=$v29_expectation"
echo "RESTORED_V30_EXPECTATION_STATE=$v30_expectation"
echo "RESTORED_V30_AUTHORIZATION_SURFACE=$authorization_surface"
echo "RESTORED_V30_ALLOWLIST_COLUMN=$allowlist_column"
echo "RESTORED_V30_ALLOWLIST_CONSTRAINT=$allowlist_constraint"

if [[ "$replay_manifest" != "0:bf7208ee6b49620e3ef146812c6e69fa8bc73058086d6d7df12c91ec41888f55" ]]; then echo "Restored V30 replay manifest mismatch." >&2; exit 1; fi
if [[ "$operational_contract" != "0:6396d71a8da8966ca50d412e6d5caccb7dc624775e69aef993b61e303f5d0400" ]]; then echo "Restored V30 operational contract mismatch." >&2; exit 1; fi
if [[ "$operational_manifest" != "f0fcffe6a705b1d66df0e1c87ae04fb92070b2ed4308da354979a46e47087460" ]]; then echo "Restored V30 operational manifest mismatch." >&2; exit 1; fi
if [[ "$predecessor_manifest" != "32107329f69000537b2e8167d12674a90f46a7a7c8978149b70b8dac5edc7e17" ]]; then echo "Restored V30 predecessor manifest mismatch." >&2; exit 1; fi
if [[ "$transition_manifest" != "0:118b8031e9393f0114f486d0704e71475099d326f7fba9ad5d7518ad5a6a2c60" ]]; then echo "Restored V30 transition manifest mismatch." >&2; exit 1; fi
if [[ "$readiness" != "true|125|20260826155911|0||release-db-attestation-v30" ]]; then echo "Restored V30 readiness mismatch: $readiness" >&2; exit 1; fi
if [[ "$compat_readiness" != "true|124|20260826102840|0||release-db-attestation-v29" ]]; then echo "Restored V29 compatibility readiness mismatch: $compat_readiness" >&2; exit 1; fi
if [[ "$v28_expectation" != "1:e57560e15d366056bd249ecf52225162403b0866c4fea4929b34c8ef84c3df11" ]]; then echo "Restored V30 V28 expectation mismatch." >&2; exit 1; fi
if [[ "$v29_expectation" != "1:b0e1d3777d1686ff48b9f5d73a255cc1f6d6fea974736215c7c21a621dbaa1a5" ]]; then echo "Restored V30 V29 expectation mismatch." >&2; exit 1; fi
if [[ "$v30_expectation" != "1:64daabcda5df9823fa4b32e7320e715d1d96dd0d0acc697ebed4570256655643" ]]; then echo "Restored V30 expectation mismatch." >&2; exit 1; fi
if [[ "$authorization_surface" != "true:false:true:false:true" ]]; then echo "Restored V30 authorization ACL mismatch: $authorization_surface" >&2; exit 1; fi
if [[ "$allowlist_column" != "text[]:true:ARRAY[]::text[]" ]]; then echo "Restored V30 allowlist column mismatch: $allowlist_column" >&2; exit 1; fi
if [[ "$allowlist_constraint" != "c:true" ]]; then echo "Restored V30 allowlist constraint mismatch: $allowlist_constraint" >&2; exit 1; fi

(
  cd "$repository_root"
  node --input-type=module --eval \
    "import { validateCatalogState } from './scripts/studio-comp-migration-rollout.mjs'; validateCatalogState(process.argv[1]);" \
    "$catalog_state"
)

acl_drift_ready="$(read_value "BEGIN; GRANT EXECUTE ON FUNCTION public.authorize_studio_live_billing_scope_v3(uuid,text,text,text,text) TO service_role; SELECT ready::TEXT FROM public.koaryu_release_schema_preflight_v11(); ROLLBACK;")"
if [[ "$acl_drift_ready" != "false" ]]; then echo "Restored V30 preflight accepted legacy scope authorization." >&2; exit 1; fi
constraint_drift_ready="$(read_value "BEGIN; ALTER TABLE public.studio_live_billing_authorizations DROP CONSTRAINT studio_live_billing_authorizations_operation_set_exact; SELECT ready::TEXT FROM public.koaryu_release_schema_preflight_v11(); ROLLBACK;")"
if [[ "$constraint_drift_ready" != "false" ]]; then echo "Restored V30 preflight accepted allowlist-constraint drift." >&2; exit 1; fi

echo "PASS: V29 dump/restore predecessor plus migration 125 produced the exact V30 operation-bound contract."
