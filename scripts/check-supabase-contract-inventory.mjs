#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const EXPECTED_SUPABASE_CONTRACTS = Object.freeze([
  "20260425000021_program_memberships_checks.sql",
  "account_support_controls.sql",
  "belt_ladder_sync_smoke.sql",
  "billing_external_payment_overpay_guard.sql",
  "billing_enrollment_period_safe_transitions.sql",
  "billing_invoice_item_refs_contract.sql",
  "billing_invoice_mutation_serialization_v31.sql",
  "billing_invoice_retry_preread_lease_v32.sql",
  "billing_invoice_retry_compatibility_v33.sql",
  "billing_invoice_retry_operations.sql",
  "billing_payment_adjustment_convergence.sql",
  "billing_provider_operation_steps.sql",
  "billing_provider_operations_and_payer_consent.sql",
  "client_read_access_controls.sql",
  "core_operational_client_write_controls.sql",
  "email_usage_rpc_contract.sql",
  "export_jobs_admin_only_contract.sql",
  "friendly_pilot_authorization.sql",
  "function_execution_security.sql",
  "dashboard_summary_facts_contract.sql",
  "student_roster_rpc_contract.sql",
  "student_bulk_archive_rpc_contract.sql",
  "lead_conversion_atomic_contract.sql",
  "operational_alert_delivery_state.sql",
  "operational_alert_activation.sql",
  "payments_workflow_replay_repairs.sql",
  "program_ladder_unification.sql",
  "record_student_promotion_rpc_contract.sql",
  "release_ui_atomic_contract.sql",
  "recurring_class_series_delete_atomic_contract.sql",
  "recurring_session_materialization_atomic_contract.sql",
  "remaining_operational_client_write_controls.sql",
  "schedule_recurring_soft_delete_contract.sql",
  "schedule_window_read_contract.sql",
  "stripe_event_worker_claim_controls.sql",
  "student_import_row_atomic_contract.sql",
  "student_import_run_worker_claim_controls.sql",
  "student_profile_write_atomic_contract.sql",
  "student_program_filter_rpc_contract.sql",
  "studio_comp_atomic_contract.sql",
  "studio_live_billing_authorizations_contract.sql",
  "studio_onboarding_atomic_smoke.sql",
  "studio_operational_clear_atomic_contract.sql",
  "support_triage_smoke.sql",
  "tenant_rls_isolation_smoke.sql",
  "worker_claim_rpc_contract.sql",
]);

export function compareSupabaseContractInventory(actual) {
  const expected = [...EXPECTED_SUPABASE_CONTRACTS].sort();
  const normalizedActual = [...actual].sort();
  const missing = expected.filter((name) => !normalizedActual.includes(name));
  const unexpected = normalizedActual.filter((name) => !expected.includes(name));
  return { missing, unexpected, matches: missing.length === 0 && unexpected.length === 0 };
}

export function readSupabaseContractInventory(root = repositoryRoot) {
  return fs
    .readdirSync(path.join(root, "supabase", "verification"), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort();
}

function main() {
  const result = compareSupabaseContractInventory(readSupabaseContractInventory());
  if (!result.matches) {
    throw new Error(
      `Supabase contract inventory drift. Missing: ${result.missing.join(", ") || "none"}. ` +
        `Unexpected: ${result.unexpected.join(", ") || "none"}.`,
    );
  }
  process.stdout.write(
    `Supabase contract inventory complete: ${EXPECTED_SUPABASE_CONTRACTS.length} files.\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
