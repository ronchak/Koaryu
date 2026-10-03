#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 8 ]]; then
  echo "Usage: scripts/verify-v24-v25-restore-contract.sh pg_dump pg_restore createdb psql host port temp-dir repository-root" >&2
  exit 2
fi

pg_dump_bin="$1"; pg_restore_bin="$2"; createdb_bin="$3"; psql_bin="$4"
socket_dir="$5"; pg_port="$6"; temp_dir="$7"; repository_root="$8"
restored_database="koaryu_v25_restore_contract"
dump_path="$temp_dir/v24-before-v25.dump"
source_args=(--host="$socket_dir" --port="$pg_port" --username=postgres --dbname=postgres --no-password --no-psqlrc --set=ON_ERROR_STOP=1 --quiet)
restored_args=(--host="$socket_dir" --port="$pg_port" --username=postgres --dbname="$restored_database" --no-password --no-psqlrc --set=ON_ERROR_STOP=1 --quiet)

apply_migration() {
  local version="$1"
  local name="$2"

  "$psql_bin" "${restored_args[@]}" --single-transaction \
    --file="$repository_root/supabase/migrations/${version}_${name}.sql" \
    --command="INSERT INTO supabase_migrations.schema_migrations (version,name) VALUES ('$version','$name');"
}

cleanup() {
  "$psql_bin" "${source_args[@]}" --command="DROP DATABASE IF EXISTS $restored_database WITH (FORCE);" >/dev/null 2>&1 || true
}
trap cleanup EXIT HUP INT TERM
cleanup

predecessor_readiness="$("$psql_bin" "${source_args[@]}" --tuples-only --no-align --command="SELECT ready::TEXT || '|' || migration_count::TEXT || '|' || migration_head || '|' || cardinality(security_failures)::TEXT || '|' || manifest_version FROM public.koaryu_release_schema_preflight_v4();" | tr -d '\r\n')"
if [[ "$predecessor_readiness" != "true|117|20260824190500|0|release-db-attestation-v24" ]]; then
  echo "Source database is not the exact ready V24 predecessor: $predecessor_readiness" >&2
  exit 1
fi

"$pg_dump_bin" --host="$socket_dir" --port="$pg_port" --username=postgres --dbname=postgres --no-password --format=custom --file="$dump_path"
"$createdb_bin" --host="$socket_dir" --port="$pg_port" --username=postgres --no-password --owner=postgres --template=template0 "$restored_database"
"$psql_bin" "${restored_args[@]}" --command='ALTER DATABASE koaryu_v25_restore_contract SET search_path TO "$user", public, extensions;'
"$pg_restore_bin" --host="$socket_dir" --port="$pg_port" --username=postgres --dbname="$restored_database" --no-password --exit-on-error "$dump_path"

restored_predecessor="$("$psql_bin" "${restored_args[@]}" --tuples-only --no-align --command="SELECT ready::TEXT || '|' || migration_count::TEXT || '|' || migration_head || '|' || cardinality(security_failures)::TEXT || '|' || manifest_version FROM public.koaryu_release_schema_preflight_v4();" | tr -d '\r\n')"
if [[ "$restored_predecessor" != "$predecessor_readiness" ]]; then
  echo "Restored V24 predecessor readiness drifted: $restored_predecessor" >&2
  exit 1
fi

apply_migration "20260825042838" "schedule_window_read_rpc"
apply_migration "20260825043911" "attest_schedule_window_release"

restored_schedule_readiness="$("$psql_bin" "${restored_args[@]}" --tuples-only --no-align --command="SELECT ready::TEXT || '|' || migration_count::TEXT || '|' || migration_head || '|' || cardinality(security_failures)::TEXT || '|' || manifest_version FROM public.koaryu_release_schema_preflight_v5();" | tr -d '\r\n')"
if [[ "$restored_schedule_readiness" != "true|119|20260825043911|0|release-db-attestation-v25" ]]; then
  echo "Restored schedule V25 readiness did not match exact post-state: $restored_schedule_readiness" >&2
  exit 1
fi

restored_schedule_v24_compat="$("$psql_bin" "${restored_args[@]}" --tuples-only --no-align --command="SELECT ready::TEXT || '|' || migration_count::TEXT || '|' || migration_head || '|' || cardinality(security_failures)::TEXT || '|' || manifest_version FROM public.koaryu_release_schema_preflight_v4();" | tr -d '\r\n')"
if [[ "$restored_schedule_v24_compat" != "true|117|20260824190500|0|release-db-attestation-v24" ]]; then
  echo "Restored schedule V25 did not preserve exact V24 compatibility: $restored_schedule_v24_compat" >&2
  exit 1
fi

apply_migration "20260826030234" "live_billing_reconciliation_v3"

restored_readiness="$("$psql_bin" "${restored_args[@]}" --tuples-only --no-align --command="SELECT ready::TEXT || '|' || migration_count::TEXT || '|' || migration_head || '|' || cardinality(security_failures)::TEXT || '|' || manifest_version FROM public.koaryu_release_schema_preflight_v6();" | tr -d '\r\n')"
if [[ "$restored_readiness" != "true|120|20260826030234|0|release-db-attestation-v25" ]]; then
  echo "Restored Payments V25 readiness did not match exact post-state: $restored_readiness" >&2
  exit 1
fi

restored_schedule_compat="$("$psql_bin" "${restored_args[@]}" --tuples-only --no-align --command="SELECT ready::TEXT || '|' || migration_count::TEXT || '|' || migration_head || '|' || cardinality(security_failures)::TEXT || '|' || manifest_version FROM public.koaryu_release_schema_preflight_v5();" | tr -d '\r\n')"
if [[ "$restored_schedule_compat" != "true|119|20260825043911|0|release-db-attestation-v25" ]]; then
  echo "Restored Payments V25 did not preserve exact schedule V25 compatibility: $restored_schedule_compat" >&2
  exit 1
fi

restored_v24_compat="$("$psql_bin" "${restored_args[@]}" --tuples-only --no-align --command="SELECT ready::TEXT || '|' || migration_count::TEXT || '|' || migration_head || '|' || cardinality(security_failures)::TEXT || '|' || manifest_version FROM public.koaryu_release_schema_preflight_v4();" | tr -d '\r\n')"
if [[ "$restored_v24_compat" != "true|117|20260824190500|0|release-db-attestation-v24" ]]; then
  echo "Restored Payments V25 did not preserve exact V24 compatibility: $restored_v24_compat" >&2
  exit 1
fi

actual_contract="$("$psql_bin" "${restored_args[@]}" --tuples-only --no-align --command='SELECT private.koaryu_release_operational_contract_v25();' | tr -d '\r\n')"
expected_contract="0:bde4877c461840d0f1e42fe3faccaddad8ae8c97ca7cde1a7a2ba1cee1fda0c4"
if [[ "$actual_contract" != "$expected_contract" ]]; then
  echo "Restored V25 operational contract did not match its expectation." >&2
  exit 1
fi

echo "RESTORED_V24_PREDECESSOR_READINESS=$restored_predecessor"
echo "RESTORED_SCHEDULE_V25_READINESS=$restored_schedule_readiness"
echo "RESTORED_SCHEDULE_V25_COMPAT_V24_READINESS=$restored_schedule_v24_compat"
echo "RESTORED_PAYMENTS_V25_READINESS=$restored_readiness"
echo "RESTORED_PAYMENTS_V25_COMPAT_SCHEDULE_READINESS=$restored_schedule_compat"
echo "RESTORED_PAYMENTS_V25_COMPAT_V24_READINESS=$restored_v24_compat"
echo "RESTORED_V25_OPERATIONAL_CONTRACT=$actual_contract"
echo "PASS: V24 dump/restore, schedule migrations 118-119, and Payments migration 120 produced the exact accepted V25 compatibility chain."
