#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 8 ]]; then
  echo "Usage: scripts/verify-v28-v29-restore-contract.sh pg_dump pg_restore createdb psql host port temp-dir repository-root" >&2
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
restored_database="koaryu_v29_restore_contract"
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
  --command='ALTER DATABASE koaryu_v29_restore_contract SET search_path TO "$user", public, extensions;'
"$pg_restore_bin" --host="$socket_dir" --port="$pg_port" --username=postgres \
  --dbname="$restored_database" --no-password --exit-on-error "$dump_path"
"$psql_bin" "${restored_args[@]}" --single-transaction \
  --file="$repository_root/supabase/migrations/20260826051527_billing_provider_operations_and_payer_consent.sql" \
  --command="INSERT INTO supabase_migrations.schema_migrations(version,name) VALUES ('20260826051527','billing_provider_operations_and_payer_consent');"
"$psql_bin" "${restored_args[@]}" --single-transaction \
  --file="$repository_root/supabase/migrations/20260826073728_billing_provider_operation_steps.sql" \
  --command="INSERT INTO supabase_migrations.schema_migrations(version,name) VALUES ('20260826073728','billing_provider_operation_steps');"

predecessor_readiness="$("$psql_bin" "${restored_args[@]}" --tuples-only --no-align --command="SELECT ready::TEXT || '|' || migration_count::TEXT || '|' || migration_head || '|' || cardinality(security_failures)::TEXT || '|' || manifest_version FROM public.koaryu_release_schema_preflight_v9();" | tr -d '\r\n')"
if [[ "$predecessor_readiness" != "true|123|20260826073728|0|release-db-attestation-v28" ]]; then
  echo "Restored V28 predecessor readiness mismatch: $predecessor_readiness" >&2
  exit 1
fi

"$psql_bin" "${restored_args[@]}" --single-transaction \
  --file="$repository_root/supabase/migrations/20260826102840_enrollment_period_safe_transitions.sql" \
  --command="INSERT INTO supabase_migrations.schema_migrations(version,name) VALUES ('20260826102840','enrollment_period_safe_transitions');"

transition_manifest="$("$psql_bin" "${restored_args[@]}" --tuples-only --no-align --command='SELECT private.koaryu_release_enrollment_transition_manifest_v29();' | tr -d '\r\n')"
operational_contract="$("$psql_bin" "${restored_args[@]}" --tuples-only --no-align --command='SELECT private.koaryu_release_operational_contract_v29();' | tr -d '\r\n')"
operational_manifest="$("$psql_bin" "${restored_args[@]}" --tuples-only --no-align --command='SELECT private.koaryu_release_operational_manifest_v10();' | tr -d '\r\n')"
v28_canonical_manifest="$("$psql_bin" "${restored_args[@]}" --tuples-only --no-align --command='SELECT private.koaryu_release_operational_manifest_v9();' | tr -d '\r\n')"
readiness="$("$psql_bin" "${restored_args[@]}" --tuples-only --no-align --command="SELECT ready::TEXT || '|' || migration_count::TEXT || '|' || migration_head || '|' || cardinality(security_failures)::TEXT || '|' || COALESCE(array_to_string(security_failures,','),'') || '|' || manifest_version FROM public.koaryu_release_schema_preflight_v10();" | tr -d '\r\n')"
compat_readiness="$("$psql_bin" "${restored_args[@]}" --tuples-only --no-align --command="SELECT ready::TEXT || '|' || migration_count::TEXT || '|' || migration_head || '|' || cardinality(security_failures)::TEXT || '|' || COALESCE(array_to_string(security_failures,','),'') || '|' || manifest_version FROM public.koaryu_release_schema_preflight_v9();" | tr -d '\r\n')"
catalog_sql="$(cd "$repository_root" && node --input-type=module --eval "import {CATALOG_STATE_SQL} from './scripts/studio-comp-migration-rollout.mjs'; process.stdout.write(CATALOG_STATE_SQL);")"
catalog_state="$("$psql_bin" "${restored_args[@]}" --tuples-only --no-align --command="$catalog_sql" | tr -d '\r\n')"
expectation_state="$("$psql_bin" "${restored_args[@]}" --tuples-only --no-align --command="SELECT '1:' || encode(extensions.digest(convert_to('operational_contract_v29:' || expected_sha256,'UTF8'),'sha256'),'hex') FROM private.koaryu_release_v29_expectations WHERE expectation_key='operational_contract_v29';" | tr -d '\r\n')"

echo "RESTORED_V29_TRANSITION_MANIFEST=$transition_manifest"
echo "RESTORED_V29_OPERATIONAL_CONTRACT=$operational_contract"
echo "RESTORED_V29_OPERATIONAL_MANIFEST=$operational_manifest"
echo "RESTORED_V29_V28_CANONICAL_MANIFEST=$v28_canonical_manifest"
echo "RESTORED_V29_READINESS=$readiness"
echo "RESTORED_V29_COMPAT_V28_READINESS=$compat_readiness"
echo "RESTORED_V29_CATALOG_STATE=$catalog_state"
echo "RESTORED_V29_EXPECTATION_STATE=$expectation_state"

if [[ "$transition_manifest" != "0:118b8031e9393f0114f486d0704e71475099d326f7fba9ad5d7518ad5a6a2c60" ]]; then
  echo "Restored V29 transition manifest mismatch: $transition_manifest" >&2
  exit 1
fi
if [[ "$operational_contract" != "0:e2c4f27b967c5bff881a00e51416691ef752cc51e8298fb2142c96f607e4e1d0" ]]; then
  echo "Restored V29 operational contract mismatch: $operational_contract" >&2
  exit 1
fi
if [[ "$operational_manifest" != "e9034c1e146f58baea795e16ea93c6eca75fa463e0ee057eada0e09a784248c6" ]]; then
  echo "Restored V29 operational manifest mismatch: $operational_manifest" >&2
  exit 1
fi
if [[ "$v28_canonical_manifest" != "67f9fb3a6730a356ad944828eeba4398912edf114dcdd2daf0a48e4cdc7a5280" ]]; then
  echo "Restored post-V29 V28 manifest mismatch: $v28_canonical_manifest" >&2
  exit 1
fi
if [[ "$readiness" != "true|124|20260826102840|0||release-db-attestation-v29" ]]; then
  echo "Restored V29 readiness mismatch: $readiness" >&2
  exit 1
fi
if [[ "$compat_readiness" != "true|123|20260826073728|0||release-db-attestation-v28" ]]; then
  echo "Restored V28 compatibility readiness mismatch: $compat_readiness" >&2
  exit 1
fi
if [[ "$expectation_state" != "1:7e003460a485f8125432d1c2c7087bc04f1a4037728aa4f16b22640daf2eb7c7" ]]; then
  echo "Restored V29 expectation mismatch: $expectation_state" >&2
  exit 1
fi

(
  cd "$repository_root"
  node --input-type=module --eval \
    "import { validateCatalogState } from './scripts/studio-comp-migration-rollout.mjs'; validateCatalogState(process.argv[1]);" \
    "$catalog_state"
)

echo "PASS: V28 dump/restore then migration 124 produced the V29 transition contract."
