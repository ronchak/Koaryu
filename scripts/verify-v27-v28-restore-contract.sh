#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 8 ]]; then
  echo "Usage: scripts/verify-v27-v28-restore-contract.sh pg_dump pg_restore createdb psql host port temp-dir repository-root" >&2
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
restored_database="koaryu_v28_restore_contract"
source_args=(--host="$socket_dir" --port="$pg_port" --username=postgres --dbname=postgres --no-password --no-psqlrc --set=ON_ERROR_STOP=1 --quiet)
restored_args=(--host="$socket_dir" --port="$pg_port" --username=postgres --dbname="$restored_database" --no-password --no-psqlrc --set=ON_ERROR_STOP=1 --quiet)

cleanup() {
  "$psql_bin" "${source_args[@]}" --command="DROP DATABASE IF EXISTS $restored_database WITH (FORCE);" >/dev/null 2>&1 || true
}
trap cleanup EXIT HUP INT TERM
cleanup

dump_path="$temp_dir/v26-before-v27.dump"
if [[ ! -f "$dump_path" ]]; then
  echo "Verified V26 restore artifact is missing: $dump_path" >&2
  exit 1
fi
"$createdb_bin" --host="$socket_dir" --port="$pg_port" --username=postgres \
  --no-password --owner=postgres --template=template0 "$restored_database"
"$psql_bin" "${restored_args[@]}" \
  --command='ALTER DATABASE koaryu_v28_restore_contract SET search_path TO "$user", public, extensions;'
"$pg_restore_bin" --host="$socket_dir" --port="$pg_port" --username=postgres \
  --dbname="$restored_database" --no-password --exit-on-error "$dump_path"
"$psql_bin" "${restored_args[@]}" --single-transaction \
  --file="$repository_root/supabase/migrations/20260826051527_billing_provider_operations_and_payer_consent.sql" \
  --command="INSERT INTO supabase_migrations.schema_migrations(version,name) VALUES ('20260826051527','billing_provider_operations_and_payer_consent');"
predecessor_readiness="$("$psql_bin" "${restored_args[@]}" --tuples-only --no-align --command="SELECT ready::TEXT || '|' || migration_count::TEXT || '|' || migration_head || '|' || COALESCE(array_to_string(security_failures,','),'') || '|' || manifest_version FROM public.koaryu_release_schema_preflight_v7();" | tr -d '\r\n')"
predecessor_provider_manifest="$("$psql_bin" "${restored_args[@]}" --tuples-only --no-align --command='SELECT private.koaryu_release_provider_operations_manifest_v27();' | tr -d '\r\n')"
predecessor_operational_contract="$("$psql_bin" "${restored_args[@]}" --tuples-only --no-align --command='SELECT private.koaryu_release_operational_contract_v27();' | tr -d '\r\n')"
echo "RESTORED_V27_PREDECESSOR_READINESS=$predecessor_readiness"
echo "RESTORED_V27_PREDECESSOR_PROVIDER_MANIFEST=$predecessor_provider_manifest"
echo "RESTORED_V27_PREDECESSOR_OPERATIONAL_CONTRACT=$predecessor_operational_contract"
"$psql_bin" "${restored_args[@]}" --single-transaction \
  --file="$repository_root/supabase/migrations/20260826073728_billing_provider_operation_steps.sql" \
  --command="INSERT INTO supabase_migrations.schema_migrations(version,name) VALUES ('20260826073728','billing_provider_operation_steps');"

steps_manifest="$("$psql_bin" "${restored_args[@]}" --tuples-only --no-align --command='SELECT private.koaryu_release_provider_operation_steps_manifest_v28();' | tr -d '\r\n')"
operational_contract="$("$psql_bin" "${restored_args[@]}" --tuples-only --no-align --command='SELECT private.koaryu_release_operational_contract_v28();' | tr -d '\r\n')"
operational_manifest="$("$psql_bin" "${restored_args[@]}" --tuples-only --no-align --command='SELECT private.koaryu_release_operational_manifest_v8();' | tr -d '\r\n')"
canonical_manifest="$("$psql_bin" "${restored_args[@]}" --tuples-only --no-align --command='SELECT private.koaryu_release_operational_manifest_v9();' | tr -d '\r\n')"
readiness="$("$psql_bin" "${restored_args[@]}" --tuples-only --no-align --command="SELECT ready::TEXT || '|' || migration_count::TEXT || '|' || migration_head || '|' || cardinality(security_failures)::TEXT || '|' || manifest_version FROM public.koaryu_release_schema_preflight_v8();" | tr -d '\r\n')"
compat_readiness="$("$psql_bin" "${restored_args[@]}" --tuples-only --no-align --command="SELECT ready::TEXT || '|' || migration_count::TEXT || '|' || migration_head || '|' || cardinality(security_failures)::TEXT || '|' || manifest_version FROM public.koaryu_release_schema_preflight_v7();" | tr -d '\r\n')"
catalog_sql="$(cd "$repository_root" && node --input-type=module --eval "import {CATALOG_STATE_SQL} from './scripts/studio-comp-migration-rollout.mjs'; process.stdout.write(CATALOG_STATE_SQL);")"
catalog_state="$("$psql_bin" "${restored_args[@]}" --tuples-only --no-align --command="$catalog_sql" | tr -d '\r\n')"
v27_expectation_state="$("$psql_bin" "${restored_args[@]}" --tuples-only --no-align --command="SELECT '1:' || encode(extensions.digest(convert_to('operational_contract_v27:' || expected_sha256,'UTF8'),'sha256'),'hex') FROM private.koaryu_release_v27_expectations WHERE expectation_key='operational_contract_v27';" | tr -d '\r\n')"
v28_expectation_state="$("$psql_bin" "${restored_args[@]}" --tuples-only --no-align --command="SELECT '1:' || encode(extensions.digest(convert_to('operational_contract_v28:' || expected_sha256,'UTF8'),'sha256'),'hex') FROM private.koaryu_release_v28_expectations WHERE expectation_key='operational_contract_v28';" | tr -d '\r\n')"
payer_generation_state="$("$psql_bin" "${restored_args[@]}" --tuples-only --no-align --command="SELECT format_type(attribute.atttypid, attribute.atttypmod) || ':' || attribute.attnotnull::TEXT || ':' || COALESCE(pg_get_expr(default_value.adbin, default_value.adrelid), '') || ':' || COALESCE((SELECT pg_get_constraintdef(constraint_state.oid) FROM pg_constraint AS constraint_state WHERE constraint_state.conrelid = 'public.billing_payers'::REGCLASS AND constraint_state.conname = 'billing_payers_connect_account_generation_positive'), '') FROM pg_attribute AS attribute LEFT JOIN pg_attrdef AS default_value ON default_value.adrelid = attribute.attrelid AND default_value.adnum = attribute.attnum WHERE attribute.attrelid = 'public.billing_payers'::REGCLASS AND attribute.attname = 'connect_account_generation' AND NOT attribute.attisdropped;" | tr -d '\r\n')"
resource_claim_state="$("$psql_bin" "${restored_args[@]}" --tuples-only --no-align --command="SELECT (SELECT count(*) FROM pg_class AS relation WHERE relation.oid IN ('public.billing_provider_operation_resources'::REGCLASS, 'public.billing_provider_operation_resource_aliases'::REGCLASS) AND relation.relrowsecurity AND NOT has_table_privilege('service_role', relation.oid, 'SELECT,INSERT,UPDATE,DELETE'))::TEXT || ':' || has_function_privilege('service_role', 'public.claim_billing_provider_operation_resource_v1(uuid,uuid,text,text,uuid,uuid,text,text,text,integer,uuid,integer)', 'EXECUTE')::TEXT || ':' || has_function_privilege('authenticated', 'public.claim_billing_provider_operation_resource_v1(uuid,uuid,text,text,uuid,uuid,text,text,text,integer,uuid,integer)', 'EXECUTE')::TEXT;" | tr -d '\r\n')"

echo "RESTORED_V28_STEPS_MANIFEST=$steps_manifest"
echo "RESTORED_V28_OPERATIONAL_CONTRACT=$operational_contract"
echo "RESTORED_V28_OPERATIONAL_MANIFEST=$operational_manifest"
echo "RESTORED_V28_CANONICAL_MANIFEST=$canonical_manifest"
echo "RESTORED_V28_READINESS=$readiness"
echo "RESTORED_V28_COMPAT_V27_READINESS=$compat_readiness"
echo "RESTORED_V28_CATALOG_STATE=$catalog_state"
echo "RESTORED_V28_V27_EXPECTATION_STATE=$v27_expectation_state"
echo "RESTORED_V28_EXPECTATION_STATE=$v28_expectation_state"
echo "RESTORED_V28_PAYER_GENERATION_STATE=$payer_generation_state"
echo "RESTORED_V28_RESOURCE_CLAIM_STATE=$resource_claim_state"

if [[ "$steps_manifest" != "0:1de704b805b929154bf88e1727838d0d95c1c3da16246c3d48c3bdafafcb5931" ]]; then
  echo "Restored V28 provider-operation manifest mismatch: $steps_manifest" >&2
  exit 1
fi
if [[ "$operational_contract" != "0:e8802a0d7f2f7eb77d416d8c95af1cc10686425ef48a6852406cbd01d9059b4d" ]]; then
  echo "Restored V28 operational contract mismatch: $operational_contract" >&2
  exit 1
fi
if [[ "$canonical_manifest" != "5641619e5c03ccf472b87226fd633f366b382a44e227adf581ca1b5c900ccfd1" ]]; then
  echo "Restored V28 canonical manifest mismatch: $canonical_manifest" >&2
  exit 1
fi
if [[ "$readiness" != "true|121|20260826073728|0|release-db-attestation-v28" ]]; then
  echo "Restored V28 readiness mismatch: $readiness" >&2
  exit 1
fi
if [[ "$compat_readiness" != "true|120|20260826051527|0|release-db-attestation-v27" ]]; then
  echo "Restored V27 compatibility readiness mismatch: $compat_readiness" >&2
  exit 1
fi
if [[ "$v27_expectation_state" != "1:60918ae6ec16fdc78fe22e76b9751c48b413b641cd1063f137aac6a863c48b9a" ]]; then
  echo "Restored V28-compatible V27 expectation mismatch: $v27_expectation_state" >&2
  exit 1
fi
if [[ "$v28_expectation_state" != "1:4b7bbc8c6a4a7bd183b952a8a08f5fd2b4e23369a3fe463874b609a21b31fc1b" ]]; then
  echo "Restored V28 expectation mismatch: $v28_expectation_state" >&2
  exit 1
fi
if [[ "$payer_generation_state" != "integer:false::CHECK ((connect_account_generation > 0))" ]]; then
  echo "Restored V28 payer-generation column mismatch: $payer_generation_state" >&2
  exit 1
fi
if [[ "$resource_claim_state" != "2:true:false" ]]; then
  echo "Restored V28 resource-claim ACL mismatch: $resource_claim_state" >&2
  exit 1
fi

(
  cd "$repository_root"
  node --input-type=module --eval \
    "import { validateV27CatalogState } from './scripts/studio-comp-migration-rollout.mjs'; validateV27CatalogState(process.argv[1]);" \
    "$catalog_state"
)

echo "PASS: V27 dump/restore then migration 121 produced the exact V28 step contract."
