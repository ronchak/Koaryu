#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERIFICATION_DIR="$ROOT_DIR/supabase/verification"
SUPABASE_DB_TARGET="${SUPABASE_DB_TARGET:-local}"

if ! command -v supabase >/dev/null 2>&1; then
  echo "Supabase CLI is required to run this check." >&2
  exit 127
fi

case "$SUPABASE_DB_TARGET" in
  linked)
    db_target_flag="--linked"
    ;;
  local)
    db_target_flag="--local"
    ;;
  *)
    echo "SUPABASE_DB_TARGET must be 'linked' or 'local'." >&2
    exit 2
    ;;
esac

rls_contract_files=(
  "core_operational_client_write_controls.sql"
  "remaining_operational_client_write_controls.sql"
  "account_support_controls.sql"
  "stripe_event_worker_claim_controls.sql"
  "tenant_rls_isolation_smoke.sql"
)

for contract_file in "${rls_contract_files[@]}"; do
  echo "Running Supabase RLS contract on $SUPABASE_DB_TARGET database: $contract_file"
  supabase db query "$db_target_flag" --file "$VERIFICATION_DIR/$contract_file"
done
