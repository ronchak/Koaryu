#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 8 ]]; then
  echo "Usage: scripts/verify-v26-v27-restore-contract.sh pg_dump pg_restore createdb psql host port temp-dir repository-root" >&2
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
restored_database="koaryu_v27_restore_contract"
dump_path="$temp_dir/v26-before-v27.dump"
source_args=(--host="$socket_dir" --port="$pg_port" --username=postgres --dbname=postgres --no-password --no-psqlrc --set=ON_ERROR_STOP=1 --quiet)
restored_args=(--host="$socket_dir" --port="$pg_port" --username=postgres --dbname="$restored_database" --no-password --no-psqlrc --set=ON_ERROR_STOP=1 --quiet)

cleanup() {
  "$psql_bin" "${source_args[@]}" --command="DROP DATABASE IF EXISTS $restored_database WITH (FORCE);" >/dev/null 2>&1 || true
}
trap cleanup EXIT HUP INT TERM
cleanup

"$pg_dump_bin" --host="$socket_dir" --port="$pg_port" --username=postgres --dbname=postgres --no-password --format=custom --file="$dump_path"
"$createdb_bin" --host="$socket_dir" --port="$pg_port" --username=postgres --no-password --owner=postgres --template=template0 "$restored_database"
"$psql_bin" "${restored_args[@]}" --command='ALTER DATABASE koaryu_v27_restore_contract SET search_path TO "$user", public, extensions;'
"$pg_restore_bin" --host="$socket_dir" --port="$pg_port" --username=postgres --dbname="$restored_database" --no-password --exit-on-error "$dump_path"
"$psql_bin" "${restored_args[@]}" --single-transaction \
  --file="$repository_root/supabase/migrations/20260826051527_billing_provider_operations_and_payer_consent.sql" \
  --command="INSERT INTO supabase_migrations.schema_migrations(version,name) VALUES ('20260826051527','billing_provider_operations_and_payer_consent');"

provider_manifest="$("$psql_bin" "${restored_args[@]}" --tuples-only --no-align --command='SELECT private.koaryu_release_provider_operations_manifest_v27();' | tr -d '\r\n')"
operational_contract="$("$psql_bin" "${restored_args[@]}" --tuples-only --no-align --command='SELECT private.koaryu_release_operational_contract_v27();' | tr -d '\r\n')"
operational_manifest="$("$psql_bin" "${restored_args[@]}" --tuples-only --no-align --command='SELECT private.koaryu_release_operational_manifest_v8();' | tr -d '\r\n')"
operational_manifest_v7="$("$psql_bin" "${restored_args[@]}" --tuples-only --no-align --command='SELECT private.koaryu_release_operational_manifest_v7();' | tr -d '\r\n')"
readiness="$("$psql_bin" "${restored_args[@]}" --tuples-only --no-align --command="SELECT ready::TEXT || '|' || migration_count::TEXT || '|' || migration_head || '|' || cardinality(security_failures)::TEXT || '|' || manifest_version FROM public.koaryu_release_schema_preflight_v7();" | tr -d '\r\n')"
catalog_sql="$(cd "$repository_root" && node --input-type=module --eval "import {CATALOG_STATE_SQL} from './scripts/studio-comp-migration-rollout.mjs'; process.stdout.write(CATALOG_STATE_SQL);")"
catalog_state="$("$psql_bin" "${restored_args[@]}" --tuples-only --no-align --command="$catalog_sql" | tr -d '\r\n')"
v26_expectation_sql="$(cd "$repository_root" && node --input-type=module --eval "import {V26_EXPECTATION_STATE_SQL} from './scripts/studio-comp-migration-rollout.mjs'; process.stdout.write(V26_EXPECTATION_STATE_SQL);")"
v26_expectation_state="$("$psql_bin" "${restored_args[@]}" --tuples-only --no-align --command="$v26_expectation_sql" | tr -d '\r\n')"
v27_expectation_sql="$(cd "$repository_root" && node --input-type=module --eval "import {V27_EXPECTATION_STATE_SQL} from './scripts/studio-comp-migration-rollout.mjs'; process.stdout.write(V27_EXPECTATION_STATE_SQL);")"
v27_expectation_state="$("$psql_bin" "${restored_args[@]}" --tuples-only --no-align --command="$v27_expectation_sql" | tr -d '\r\n')"
readiness_sql="$(cd "$repository_root" && node --input-type=module --eval "import {V27_OPERATIONAL_READINESS_SQL} from './scripts/studio-comp-migration-rollout.mjs'; process.stdout.write(V27_OPERATIONAL_READINESS_SQL);")"
full_readiness="$("$psql_bin" "${restored_args[@]}" --tuples-only --no-align --command="$readiness_sql" | tr -d '\r\n')"

echo "RESTORED_V27_PROVIDER_MANIFEST=$provider_manifest"
echo "RESTORED_V27_OPERATIONAL_CONTRACT=$operational_contract"
echo "RESTORED_V27_OPERATIONAL_MANIFEST=$operational_manifest"
echo "RESTORED_V27_OPERATIONAL_MANIFEST_V7=$operational_manifest_v7"
echo "RESTORED_V27_READINESS=$readiness"
echo "RESTORED_V27_CATALOG_STATE=$catalog_state"
echo "RESTORED_V27_COMPAT_V26_EXPECTATION_STATE=$v26_expectation_state"
echo "RESTORED_V27_EXPECTATION_STATE=$v27_expectation_state"
echo "RESTORED_V27_FULL_READINESS=$full_readiness"

[[ "$provider_manifest" == "0:33ef02ac5db886e340359ee735d5dd3d152cda3538be270903a2302dba3d29f8" ]]
[[ "$operational_contract" == "0:8c4c13d6ca202e3e670ba9ae5ededabbe31dbca8652c264dc71d86d859299ab8" ]]
[[ "$operational_manifest" == "e3ae8ee20adb9f04f202c0fc27b64204c524614ddff9a68a1ca709479e5a937b" ]]
[[ "$readiness" == "true|120|20260826051527|0|release-db-attestation-v27" ]]

(
  cd "$repository_root"
  node --input-type=module --eval '
    import {
      validateOperationalManifest,
      validateV27OperationalReadiness,
      validateV27CatalogState,
      validateV27CompatV26ExpectationState,
      validateV27ExpectationState,
    } from "./scripts/studio-comp-migration-rollout.mjs";
    validateOperationalManifest(process.argv[1]);
    validateV27CatalogState(process.argv[2]);
    validateV27CompatV26ExpectationState(process.argv[3]);
    validateV27ExpectationState(process.argv[4]);
    validateV27OperationalReadiness(process.argv[5]);
  ' \
    "$operational_manifest_v7" \
    "$catalog_state" \
    "$v26_expectation_state" \
    "$v27_expectation_state" \
    "$full_readiness"
)

echo "PASS: V26 dump/restore then migration 120 produced the exact accepted V27 contract."
