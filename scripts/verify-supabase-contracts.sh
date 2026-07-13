#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERIFICATION_DIR="$ROOT_DIR/supabase/verification"
SUPABASE_DB_TARGET="${SUPABASE_DB_TARGET:-local}"
SQL_RUNNER="$ROOT_DIR/scripts/run-supabase-sql.sh"

contract_files=(
  "20260425000021_program_memberships_checks.sql"
  "account_support_controls.sql"
  "belt_ladder_sync_smoke.sql"
  "billing_external_payment_overpay_guard.sql"
  "billing_invoice_item_refs_contract.sql"
  "billing_invoice_retry_operations.sql"
  "support_triage_smoke.sql"
  "core_operational_client_write_controls.sql"
  "email_usage_rpc_contract.sql"
  "export_jobs_admin_only_contract.sql"
  "friendly_pilot_authorization.sql"
  "function_execution_security.sql"
  "lead_conversion_atomic_contract.sql"
  "remaining_operational_client_write_controls.sql"
  "program_ladder_unification.sql"
  "recurring_class_series_delete_atomic_contract.sql"
  "recurring_session_materialization_atomic_contract.sql"
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
  "$SQL_RUNNER" "$VERIFICATION_DIR/$contract_file"
done
