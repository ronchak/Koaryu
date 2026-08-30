#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 8 ]]; then
  echo "Usage: scripts/verify-v25-v26-restore-contract.sh pg_dump pg_restore createdb psql host port temp-dir repository-root" >&2
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
restored_database="koaryu_v26_restore_contract"
dump_path="$temp_dir/v25-before-v26.dump"

source_args=(
  --host="$socket_dir"
  --port="$pg_port"
  --username=postgres
  --dbname=postgres
  --no-password
  --no-psqlrc
  --set=ON_ERROR_STOP=1
  --quiet
)
restored_args=(
  --host="$socket_dir"
  --port="$pg_port"
  --username=postgres
  --dbname="$restored_database"
  --no-password
  --no-psqlrc
  --set=ON_ERROR_STOP=1
  --quiet
)

cleanup() {
  "$psql_bin" "${source_args[@]}" \
    --command="DROP DATABASE IF EXISTS $restored_database WITH (FORCE);" \
    >/dev/null 2>&1 || true
}
trap cleanup EXIT HUP INT TERM

cleanup

"$pg_dump_bin" \
  --host="$socket_dir" \
  --port="$pg_port" \
  --username=postgres \
  --dbname=postgres \
  --no-password \
  --format=custom \
  --file="$dump_path"

"$createdb_bin" \
  --host="$socket_dir" \
  --port="$pg_port" \
  --username=postgres \
  --no-password \
  --owner=postgres \
  --template=template0 \
  "$restored_database"

"$psql_bin" "${restored_args[@]}" \
  --command='ALTER DATABASE koaryu_v26_restore_contract SET search_path TO "$user", public, extensions;'

"$pg_restore_bin" \
  --host="$socket_dir" \
  --port="$pg_port" \
  --username=postgres \
  --dbname="$restored_database" \
  --no-password \
  --exit-on-error \
  "$dump_path"

"$psql_bin" "${restored_args[@]}" \
  --single-transaction \
  --file="$repository_root/supabase/migrations/20260826030249_payments_adjustment_convergence.sql" \
  --command="INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ('20260826030249', 'payments_adjustment_convergence');"

restored_operational_manifest="$(
  "$psql_bin" "${restored_args[@]}" --tuples-only --no-align \
    --command='SELECT private.koaryu_release_operational_manifest_v7();'
)"
restored_operational_manifest="$(printf '%s' "$restored_operational_manifest" | tr -d '\r\n')"

catalog_sql="$(
  cd "$repository_root"
  node --input-type=module --eval \
    "import { CATALOG_STATE_SQL } from './scripts/studio-comp-migration-rollout.mjs'; process.stdout.write(CATALOG_STATE_SQL);"
)"
restored_catalog_state="$(
  "$psql_bin" "${restored_args[@]}" --tuples-only --no-align \
    --command="$catalog_sql"
)"
restored_catalog_state="$(printf '%s' "$restored_catalog_state" | tr -d '\r\n')"

expectation_sql="$(
  cd "$repository_root"
  node --input-type=module --eval \
    "import { V26_EXPECTATION_STATE_SQL } from './scripts/studio-comp-migration-rollout.mjs'; process.stdout.write(V26_EXPECTATION_STATE_SQL);"
)"
restored_expectation_state="$(
  "$psql_bin" "${restored_args[@]}" --tuples-only --no-align \
    --command="$expectation_sql"
)"
restored_expectation_state="$(printf '%s' "$restored_expectation_state" | tr -d '\r\n')"

restored_readiness="$(
  "$psql_bin" "${restored_args[@]}" --tuples-only --no-align <<'SQL'
SELECT ready::TEXT || '|' || migration_count::TEXT || '|' || migration_head || '|' ||
       array_to_string(pending_versions, ',') || '|' ||
       cardinality(security_failures)::TEXT || '|' ||
       COALESCE(array_to_string(security_failures, ','), '') || '|' ||
       manifest_version
FROM public.koaryu_release_schema_preflight_v7();
SQL
)"
restored_readiness="$(printf '%s' "$restored_readiness" | tr -d '\r\n')"

restored_operational_contract="$(
  "$psql_bin" "${restored_args[@]}" --tuples-only --no-align \
    --command='SELECT private.koaryu_release_operational_contract_v26();'
)"
restored_expected_contract="$(
  "$psql_bin" "${restored_args[@]}" --tuples-only --no-align \
    --command="SELECT '0:' || expected_sha256 FROM private.koaryu_release_v26_expectations WHERE expectation_key = 'operational_contract_v26';"
)"
restored_operational_contract="$(printf '%s' "$restored_operational_contract" | tr -d '\r\n')"
restored_expected_contract="$(printf '%s' "$restored_expected_contract" | tr -d '\r\n')"

echo "RESTORED_V26_OPERATIONAL_MANIFEST=$restored_operational_manifest"
echo "RESTORED_V26_CATALOG_STATE=$restored_catalog_state"
echo "RESTORED_V26_EXPECTATION_STATE=$restored_expectation_state"
echo "RESTORED_V26_READINESS=$restored_readiness"
echo "RESTORED_V26_OPERATIONAL_CONTRACT=$restored_operational_contract"

if [[ "$restored_operational_contract" != "$restored_expected_contract" ]]; then
  echo "Restored V26 operational contract did not match its private expectation row." >&2
  exit 1
fi

(
  cd "$repository_root"
  node --input-type=module --eval '
    import {
      validateCatalogState,
      validateOperationalManifest,
      validateV26OperationalReadiness,
      validateV26ExpectationState,
    } from "./scripts/studio-comp-migration-rollout.mjs";
    validateOperationalManifest(process.argv[1]);
    validateCatalogState(process.argv[2]);
    validateV26ExpectationState(process.argv[3]);
    validateV26OperationalReadiness(process.argv[4]);
  ' \
    "$restored_operational_manifest" \
    "$restored_catalog_state" \
    "$restored_expectation_state" \
    "$restored_readiness"
)

echo "PASS: V25 dump/restore then migration 121 produced the exact accepted V26 post-state."
