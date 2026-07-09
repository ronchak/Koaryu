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

contract_files=(
  "20260425000021_program_memberships_checks.sql"
  "account_support_controls.sql"
  "belt_ladder_sync_smoke.sql"
  "billing_external_payment_overpay_guard.sql"
  "billing_invoice_item_refs_contract.sql"
  "support_triage_smoke.sql"
  "core_operational_client_write_controls.sql"
  "email_usage_rpc_contract.sql"
  "export_jobs_admin_only_contract.sql"
  "lead_conversion_atomic_contract.sql"
  "remaining_operational_client_write_controls.sql"
  "program_ladder_unification.sql"
  "recurring_class_series_delete_atomic_contract.sql"
  "stripe_event_worker_claim_controls.sql"
  "student_import_run_worker_claim_controls.sql"
  "student_import_row_atomic_contract.sql"
  "student_profile_write_atomic_contract.sql"
  "worker_claim_rpc_contract.sql"
  "record_student_promotion_rpc_contract.sql"
  "schedule_recurring_soft_delete_contract.sql"
  "student_program_filter_rpc_contract.sql"
  "studio_operational_clear_atomic_contract.sql"
  "studio_onboarding_atomic_smoke.sql"
  "tenant_rls_isolation_smoke.sql"
)

for contract_file in "${contract_files[@]}"; do
  echo "Running Supabase contract on $SUPABASE_DB_TARGET database: $contract_file"
  supabase db query "$db_target_flag" --file "$VERIFICATION_DIR/$contract_file"
done
