assert_restored_preflight_rejects \
  "V8 compatibility preflight body tamper" \
  "UPDATE pg_proc SET prosrc=prosrc || chr(10) || '-- injected drift' WHERE oid='public.koaryu_release_schema_preflight_v8()'::REGPROCEDURE;"
assert_restored_preflight_rejects \
  "V9 compatibility preflight body tamper" \
  "UPDATE pg_proc SET prosrc=prosrc || chr(10) || '-- injected drift' WHERE oid='public.koaryu_release_schema_preflight_v9()'::REGPROCEDURE;"
assert_restored_preflight_rejects \
  "V10 compatibility preflight body tamper" \
  "UPDATE pg_proc SET prosrc=prosrc || chr(10) || '-- injected drift' WHERE oid='public.koaryu_release_schema_preflight_v10()'::REGPROCEDURE;"
assert_restored_preflight_rejects \
  "V11 compatibility preflight body tamper" \
  "UPDATE pg_proc SET prosrc=prosrc || chr(10) || '-- injected drift' WHERE oid='@@PREVIOUS_PREFLIGHT@@'::REGPROCEDURE;"

assert_restored_preflight_rejects \
  "V27 expectation service-role ACL broadening" \
  "GRANT SELECT ON private.koaryu_release_v27_expectations TO service_role;"
assert_restored_preflight_rejects \
  "V28 expectation browser-role ACL broadening" \
  "GRANT UPDATE ON private.koaryu_release_v28_expectations TO authenticated;"
assert_restored_preflight_rejects \
  "V29 expectation custom-role ACL broadening" \
  "CREATE ROLE koaryu_v29_expectation_acl_probe NOLOGIN; GRANT SELECT ON private.koaryu_release_v29_expectations TO koaryu_v29_expectation_acl_probe;"
assert_restored_preflight_rejects \
  "V30 expectation service-role GRANT OPTION drift" \
  "GRANT UPDATE ON private.koaryu_release_v30_expectations TO service_role WITH GRANT OPTION;"

assert_restored_preflight_rejects \
  "due-transition claim custom-role EXECUTE drift" \
  "CREATE ROLE koaryu_due_claim_acl_probe NOLOGIN; GRANT EXECUTE ON FUNCTION public.claim_due_billing_enrollment_transitions_v1(uuid,integer,integer) TO koaryu_due_claim_acl_probe;"
assert_restored_preflight_rejects \
  "due-transition claim service-role GRANT OPTION drift" \
  "GRANT EXECUTE ON FUNCTION public.claim_due_billing_enrollment_transitions_v1(uuid,integer,integer) TO service_role WITH GRANT OPTION;"
assert_restored_preflight_rejects \
  "payer-autopay disable custom-role EXECUTE drift" \
  "CREATE ROLE koaryu_disable_autopay_acl_probe NOLOGIN; GRANT EXECUTE ON FUNCTION public.disable_billing_payer_autopay_v1(uuid,uuid,uuid,timestamp with time zone,text) TO koaryu_disable_autopay_acl_probe;"
assert_restored_preflight_rejects \
  "payer-autopay disable service-role GRANT OPTION drift" \
  "GRANT EXECUTE ON FUNCTION public.disable_billing_payer_autopay_v1(uuid,uuid,uuid,timestamp with time zone,text) TO service_role WITH GRANT OPTION;"
assert_restored_preflight_rejects \
  "payer-setup projection custom-role EXECUTE drift" \
  "CREATE ROLE koaryu_finalize_payer_acl_probe NOLOGIN; GRANT EXECUTE ON FUNCTION public.finalize_billing_payer_setup_projection_v1(uuid,uuid,uuid,uuid,uuid,text,text,text,integer) TO koaryu_finalize_payer_acl_probe;"
assert_restored_preflight_rejects \
  "payer-setup projection service-role GRANT OPTION drift" \
  "GRANT EXECUTE ON FUNCTION public.finalize_billing_payer_setup_projection_v1(uuid,uuid,uuid,uuid,uuid,text,text,text,integer) TO service_role WITH GRANT OPTION;"

drift_ready="$(read_restored "BEGIN; ALTER FUNCTION private.validate_billing_payment_identity_change() SET search_path=public; SELECT ready::TEXT FROM @@CURRENT_PREFLIGHT@@; ROLLBACK;")"
if [[ "$drift_ready" != "false" ]]; then
  echo "Restored V31 preflight accepted payment-identity function drift." >&2
  exit 1
fi

schedule_body_ready="$(read_restored "BEGIN; UPDATE pg_proc SET prosrc=prosrc || chr(10) || '-- injected schedule-window drift' WHERE oid='public.schedule_window_read(uuid,date,date,text)'::REGPROCEDURE; SELECT ready::TEXT FROM @@CURRENT_PREFLIGHT@@; ROLLBACK;")"
if [[ "$schedule_body_ready" != "false" ]]; then
  echo "Restored V31 preflight accepted schedule-window function-body drift." >&2
  exit 1
fi

schedule_acl_ready="$(read_restored "BEGIN; REVOKE EXECUTE ON FUNCTION public.schedule_window_read(UUID,DATE,DATE,TEXT) FROM service_role; SELECT ready::TEXT FROM @@CURRENT_PREFLIGHT@@; ROLLBACK;")"
if [[ "$schedule_acl_ready" != "false" ]]; then
  echo "Restored V31 preflight accepted schedule-window ACL drift." >&2
  exit 1
fi

schedule_manifest_body_ready="$(read_restored "BEGIN; CREATE TEMP TABLE v31_schedule_manifest_spoof(value TEXT); INSERT INTO v31_schedule_manifest_spoof SELECT private.koaryu_release_schedule_window_manifest_v1(); CREATE OR REPLACE FUNCTION private.koaryu_release_schedule_window_manifest_v1() RETURNS TEXT LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog AS 'SELECT value FROM pg_temp.v31_schedule_manifest_spoof LIMIT 1'; SELECT ready::TEXT FROM @@CURRENT_PREFLIGHT@@; ROLLBACK;")"
if [[ "$schedule_manifest_body_ready" != "false" ]]; then
  echo "Restored V31 preflight accepted schedule-window manifest helper substitution." >&2
  exit 1
fi

resource_body_ready="$(read_restored "BEGIN; CREATE TEMP TABLE v31_manifest_spoof(value TEXT); INSERT INTO v31_manifest_spoof SELECT private.koaryu_release_resource_ownership_manifest_v31(); CREATE OR REPLACE FUNCTION private.koaryu_release_resource_ownership_manifest_v31() RETURNS TEXT LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog AS 'SELECT value FROM pg_temp.v31_manifest_spoof LIMIT 1'; SELECT ready::TEXT FROM @@CURRENT_PREFLIGHT@@; ROLLBACK;")"
if [[ "$resource_body_ready" != "false" ]]; then
  echo "Restored V31 preflight accepted resource-manifest body substitution." >&2
  exit 1
fi

contract_body_ready="$(read_restored "BEGIN; CREATE TEMP TABLE v31_contract_spoof(value TEXT); INSERT INTO v31_contract_spoof SELECT private.koaryu_release_operational_contract_v31(); CREATE OR REPLACE FUNCTION private.koaryu_release_operational_contract_v31() RETURNS TEXT LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog SET \"TimeZone\"='UTC' AS 'SELECT value FROM pg_temp.v31_contract_spoof LIMIT 1'; SELECT ready::TEXT FROM @@CURRENT_PREFLIGHT@@; ROLLBACK;")"
if [[ "$contract_body_ready" != "false" ]]; then
  echo "Restored V31 preflight accepted operational-contract body substitution." >&2
  exit 1
fi

provider_body_ready="$(read_restored "BEGIN; CREATE TEMP TABLE v31_provider_spoof(value TEXT); INSERT INTO v31_provider_spoof SELECT private.koaryu_release_provider_operation_steps_manifest_v28(); CREATE OR REPLACE FUNCTION private.koaryu_release_provider_operation_steps_manifest_v28() RETURNS TEXT LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog AS 'SELECT value FROM pg_temp.v31_provider_spoof LIMIT 1'; SELECT ready::TEXT FROM @@CURRENT_PREFLIGHT@@; ROLLBACK;")"
if [[ "$provider_body_ready" != "false" ]]; then
  echo "Restored V31 preflight accepted provider-manifest body substitution." >&2
  exit 1
fi

expectation_acl_ready="$(read_restored "BEGIN; GRANT UPDATE ON private.koaryu_release_v31_expectations TO service_role; SELECT ready::TEXT FROM @@CURRENT_PREFLIGHT@@; ROLLBACK;")"
if [[ "$expectation_acl_ready" != "false" ]]; then
  echo "Restored V31 preflight accepted broadened expectation-table ACLs." >&2
  exit 1
fi

owner_integrity_ready="$(read_restored "BEGIN; ALTER TABLE public.billing_invoice_mutation_owners DROP CONSTRAINT billing_invoice_mutation_owners_pkey; ALTER TABLE public.billing_invoice_mutation_owners DROP CONSTRAINT billing_invoice_mutation_owners_payer_id_fkey; SELECT ready::TEXT FROM @@CURRENT_PREFLIGHT@@; ROLLBACK;")"
if [[ "$owner_integrity_ready" != "false" ]]; then
  echo "Restored V31 preflight accepted invoice-owner PK/FK removal." >&2
  exit 1
fi

owner_acl_ready="$(read_restored "BEGIN; GRANT UPDATE ON public.billing_invoice_mutation_owners TO service_role; SELECT ready::TEXT FROM @@CURRENT_PREFLIGHT@@; ROLLBACK;")"
if [[ "$owner_acl_ready" != "false" ]]; then
  echo "Restored V31 preflight accepted broadened invoice-owner ACLs." >&2
  exit 1
fi

owner_custom_acl_ready="$(read_restored "BEGIN; CREATE ROLE v31_owner_acl_probe NOLOGIN; GRANT SELECT ON public.billing_invoice_mutation_owners TO v31_owner_acl_probe; SELECT ready::TEXT FROM @@CURRENT_PREFLIGHT@@; ROLLBACK;")"
if [[ "$owner_custom_acl_ready" != "false" ]]; then
  echo "Restored V31 preflight accepted a custom-role invoice-owner grant." >&2
  exit 1
fi

owner_extra_column_ready="$(read_restored "BEGIN; ALTER TABLE public.billing_invoice_mutation_owners ADD COLUMN unexpected_probe TEXT; SELECT ready::TEXT FROM @@CURRENT_PREFLIGHT@@; ROLLBACK;")"
if [[ "$owner_extra_column_ready" != "false" ]]; then
  echo "Restored V31 preflight accepted an unexpected invoice-owner column." >&2
  exit 1
fi

owner_trigger_ready="$(read_restored "BEGIN; DROP TRIGGER preserve_billing_invoice_mutation_owner_v31 ON public.billing_invoice_mutation_owners; CREATE TRIGGER preserve_billing_invoice_mutation_owner_v31 AFTER UPDATE ON public.billing_invoice_mutation_owners FOR EACH ROW EXECUTE FUNCTION private.preserve_billing_invoice_mutation_owner_v31(); SELECT ready::TEXT FROM @@CURRENT_PREFLIGHT@@; ROLLBACK;")"
if [[ "$owner_trigger_ready" != "false" ]]; then
  echo "Restored V31 preflight accepted wrong invoice-owner trigger topology." >&2
  exit 1
fi

maintenance_trigger_ready="$(read_restored "BEGIN; DROP TRIGGER maintain_billing_invoice_mutation_owner_v31 ON public.billing_provider_operation_resources; CREATE TRIGGER maintain_billing_invoice_mutation_owner_v31 AFTER UPDATE OF operation_id ON public.billing_provider_operation_resources FOR EACH ROW EXECUTE FUNCTION private.maintain_billing_invoice_mutation_owner_v31(); SELECT ready::TEXT FROM @@CURRENT_PREFLIGHT@@; ROLLBACK;")"
if [[ "$maintenance_trigger_ready" != "false" ]]; then
  echo "Restored V31 preflight accepted wrong maintenance-trigger topology." >&2
  exit 1
fi
maintenance_catalog_state="$(read_restored "BEGIN; DROP TRIGGER maintain_billing_invoice_mutation_owner_v31 ON public.billing_provider_operation_resources; CREATE TRIGGER maintain_billing_invoice_mutation_owner_v31 AFTER UPDATE OF operation_id ON public.billing_provider_operation_resources FOR EACH ROW EXECUTE FUNCTION private.maintain_billing_invoice_mutation_owner_v31(); ${catalog_sql}; ROLLBACK;")"
expected_restored_catalog="$(cd "$repository_root" && node --input-type=module --eval "import { EXPECTED_V31_RESTORED_CATALOG_STATE } from './scripts/studio-comp-migration-rollout.mjs'; process.stdout.write(EXPECTED_V31_RESTORED_CATALOG_STATE);")"
if [[ "$maintenance_catalog_state" == "$expected_restored_catalog" ]]; then
  echo "Restored V31 rollout catalog accepted wrong maintenance-trigger topology." >&2
  exit 1
fi
