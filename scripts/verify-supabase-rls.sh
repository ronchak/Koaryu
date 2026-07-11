#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERIFICATION_DIR="$ROOT_DIR/supabase/verification"
SUPABASE_DB_TARGET="${SUPABASE_DB_TARGET:-local}"
SQL_RUNNER="$ROOT_DIR/scripts/run-supabase-sql.sh"

rls_contract_files=(
  "core_operational_client_write_controls.sql"
  "remaining_operational_client_write_controls.sql"
  "account_support_controls.sql"
  "stripe_event_worker_claim_controls.sql"
  "tenant_rls_isolation_smoke.sql"
)

for contract_file in "${rls_contract_files[@]}"; do
  echo "Running Supabase RLS contract on $SUPABASE_DB_TARGET database: $contract_file"
  "$SQL_RUNNER" "$VERIFICATION_DIR/$contract_file"
done
