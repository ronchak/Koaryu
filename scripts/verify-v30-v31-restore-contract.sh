#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 8 ]]; then
  echo "Usage: scripts/verify-v30-v31-restore-contract.sh pg_dump pg_restore createdb psql host port temp-dir repository-root" >&2
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
restored_database="koaryu_v31_restore_contract"
dump_path="$temp_dir/v26-before-v27.dump"
source_args=(--host="$socket_dir" --port="$pg_port" --username=postgres --dbname=postgres --no-password --no-psqlrc --set=ON_ERROR_STOP=1 --quiet)
restored_args=(--host="$socket_dir" --port="$pg_port" --username=postgres --dbname="$restored_database" --no-password --no-psqlrc --set=ON_ERROR_STOP=1 --quiet)

cleanup() {
  "$psql_bin" "${source_args[@]}" --command="DROP DATABASE IF EXISTS $restored_database WITH (FORCE);" >/dev/null 2>&1 || true
}
trap cleanup EXIT HUP INT TERM
cleanup

read_restored() {
  "$psql_bin" "${restored_args[@]}" --tuples-only --no-align --command="$1" | tr -d '\r\n'
}

if [[ ! -f "$dump_path" ]]; then
  echo "Verified V26 restore artifact is missing: $dump_path" >&2
  exit 1
fi

"$createdb_bin" --host="$socket_dir" --port="$pg_port" --username=postgres \
  --no-password --owner=postgres --template=template0 "$restored_database"
"$psql_bin" "${restored_args[@]}" \
  --command='ALTER DATABASE koaryu_v31_restore_contract SET search_path TO "$user", public, extensions;'
"$pg_restore_bin" --host="$socket_dir" --port="$pg_port" --username=postgres \
  --dbname="$restored_database" --no-password --exit-on-error "$dump_path"

apply_migration() {
  local version="$1"
  local name="$2"
  "$psql_bin" "${restored_args[@]}" --single-transaction \
    --file="$repository_root/supabase/migrations/${version}_${name}.sql" \
    --command="INSERT INTO supabase_migrations.schema_migrations(version,name) VALUES ('$version','$name');"
}

apply_migration "20260826051527" "billing_provider_operations_and_payer_consent"
apply_migration "20260826073728" "billing_provider_operation_steps"
apply_migration "20260826102840" "enrollment_period_safe_transitions"
apply_migration "20260826155911" "payments_workflow_catalog_and_replay_repairs"

restored_predecessor="$(read_restored "SELECT ready::TEXT || '|' || migration_count::TEXT || '|' || migration_head || '|' || cardinality(security_failures)::TEXT || '|' || COALESCE(array_to_string(security_failures,','),'') || '|' || manifest_version FROM public.koaryu_release_schema_preflight_v10();")"
if [[ "$restored_predecessor" != "true|123|20260826155911|0||release-db-attestation-v30" ]]; then
  echo "Restored V30 predecessor readiness drifted: $restored_predecessor" >&2
  exit 1
fi

"$psql_bin" "${restored_args[@]}" <<'SQL'
INSERT INTO auth.users(
  id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at
) VALUES(
  '31000000-0000-4000-8000-000000000001','authenticated','authenticated',
  'v31-restore@example.invalid','{}','{}',now(),now()
);
INSERT INTO public.studios(id,name,slug,owner_id) VALUES(
  '31000000-0000-4000-8000-000000000002','V31 restore normalization',
  'v31-restore-normalization','31000000-0000-4000-8000-000000000001'
);
INSERT INTO public.staff_roles(studio_id,user_id,role) VALUES(
  '31000000-0000-4000-8000-000000000002',
  '31000000-0000-4000-8000-000000000001','admin'
);
INSERT INTO public.studio_payment_accounts(
  studio_id,stripe_connected_account_id,metadata
) VALUES(
  '31000000-0000-4000-8000-000000000002','acct_v31restore',
  '{"connect_account_generation":1}'
);
INSERT INTO public.billing_payers(
  id,studio_id,display_name,stripe_account_id,stripe_customer_id,
  connect_account_generation,billing_status,balance_cents
) VALUES
  ('31000000-0000-4000-8000-000000000003',
   '31000000-0000-4000-8000-000000000002','Fully refunded legacy payer',
   'acct_v31restore','cus_v31restore_full',NULL,'past_due',1000),
  ('31000000-0000-4000-8000-000000000004',
   '31000000-0000-4000-8000-000000000002','Partially refunded legacy payer',
   'acct_v31restore','cus_v31restore_partial',1,'past_due',400),
  ('31000000-0000-4000-8000-000000000005',
   '31000000-0000-4000-8000-000000000002','Underpaid legacy payer',
   'acct_v31restore','cus_v31restore_underpaid',1,'current',0);
INSERT INTO public.billing_invoices(
  id,studio_id,payer_id,status,amount_due_cents,amount_paid_cents,
  amount_remaining_cents,currency,paid_at
) VALUES
  ('31000000-0000-4000-8000-000000000006',
   '31000000-0000-4000-8000-000000000002',
   '31000000-0000-4000-8000-000000000003','refunded',1000,0,1000,'usd',NULL),
  ('31000000-0000-4000-8000-000000000007',
   '31000000-0000-4000-8000-000000000002',
   '31000000-0000-4000-8000-000000000004','partially_refunded',1000,600,400,'usd',NULL),
  ('31000000-0000-4000-8000-000000000008',
   '31000000-0000-4000-8000-000000000002',
   '31000000-0000-4000-8000-000000000005','partially_refunded',1000,300,700,'usd',NULL),
  ('31000000-0000-4000-8000-000000000009',
   '31000000-0000-4000-8000-000000000002',
   '31000000-0000-4000-8000-000000000005','void',500,0,500,'usd',NULL);
INSERT INTO public.billing_invoices(
  id,studio_id,payer_id,status,amount_due_cents,amount_paid_cents,
  amount_remaining_cents,currency,stripe_invoice_id,stripe_account_id,
  stripe_customer_id,collection_method,external,metadata
) VALUES
(
  '31000000-0000-4000-8000-000000000013',
  '31000000-0000-4000-8000-000000000002',
  '31000000-0000-4000-8000-000000000004','draft',0,0,0,'usd',
  'in_v31overlap','acct_v31restore','cus_v31restore_partial','send_invoice',false,
  jsonb_build_object('connect_account_generation',1)
),
(
  '31000000-0000-4000-8000-000000000015',
  '31000000-0000-4000-8000-000000000002',
  '31000000-0000-4000-8000-000000000004','draft',0,0,0,'usd',
  'in_v31legacy_exact','acct_v31restore','cus_v31restore_partial','send_invoice',false,
  '{}'::jsonb
),
(
  '31000000-0000-4000-8000-000000000016',
  '31000000-0000-4000-8000-000000000002',
  '31000000-0000-4000-8000-000000000004','draft',0,0,0,'usd',
  'in_v31legacy_empty','acct_v31restore','cus_v31restore_partial','send_invoice',false,
  jsonb_build_object('connect_account_generation','')
),
(
  '31000000-0000-4000-8000-000000000017',
  '31000000-0000-4000-8000-000000000002',
  '31000000-0000-4000-8000-000000000004','draft',0,0,0,'usd',
  'in_v31legacy_customer','acct_v31restore','cus_v31restore_other','send_invoice',false,
  '{}'::jsonb
),
(
  '31000000-0000-4000-8000-000000000018',
  '31000000-0000-4000-8000-000000000002',
  '31000000-0000-4000-8000-000000000004','draft',0,0,0,'usd',
  'in_v31legacy_account','acct_v31stale','cus_v31restore_partial','send_invoice',false,
  '{}'::jsonb
),
(
  '31000000-0000-4000-8000-000000000019',
  '31000000-0000-4000-8000-000000000002',
  '31000000-0000-4000-8000-000000000004','draft',0,0,0,'usd',
  'in_v31legacy_external','acct_v31restore','cus_v31restore_partial','send_invoice',true,
  '{}'::jsonb
);
INSERT INTO public.billing_payments(
  id,studio_id,payer_id,invoice_id,stripe_customer_id,
  stripe_payment_intent_id,stripe_charge_id,stripe_account_id,
  connect_account_generation,status,amount_cents,currency,
  net_collected_amount_cents,refundable_amount_cents,processed_at,idempotency_key
) VALUES
  ('31000000-0000-4000-8000-00000000000a',
   '31000000-0000-4000-8000-000000000002',
   '31000000-0000-4000-8000-000000000003',
   '31000000-0000-4000-8000-000000000006','cus_v31restore_full',
   'pi_v31restore_full','ch_v31restore_full','acct_v31restore',1,
   'succeeded',1000,'usd',1000,1000,now(),NULL),
  ('31000000-0000-4000-8000-00000000000b',
   '31000000-0000-4000-8000-000000000002',
   '31000000-0000-4000-8000-000000000004',
   '31000000-0000-4000-8000-000000000007','cus_v31restore_partial',
   'pi_v31restore_partial','ch_v31restore_partial','acct_v31restore',1,
   'succeeded',1000,'usd',1000,1000,now(),NULL),
  ('31000000-0000-4000-8000-00000000000c',
   '31000000-0000-4000-8000-000000000002',
   '31000000-0000-4000-8000-000000000005',
   '31000000-0000-4000-8000-000000000008',NULL,NULL,NULL,NULL,NULL,
   'externally_recorded',300,'usd',300,0,now(),'v31-restore-external-payment'),
  ('31000000-0000-4000-8000-00000000000d',
   '31000000-0000-4000-8000-000000000002',
   '31000000-0000-4000-8000-000000000005',NULL,'cus_v31restore_dispute',
   'pi_v31restore_dispute','ch_v31restore_dispute','acct_v31restore',1,
   'succeeded',200,'usd',200,200,now(),NULL);
INSERT INTO public.billing_refunds(
  id,studio_id,payment_id,stripe_refund_id,stripe_charge_id,
  stripe_payment_intent_id,stripe_account_id,connect_account_generation,
  amount_cents,status
) VALUES
  ('31000000-0000-4000-8000-00000000000e',
   '31000000-0000-4000-8000-000000000002',
   '31000000-0000-4000-8000-00000000000a','re_v31restore_full',
   'ch_v31restore_full','pi_v31restore_full','acct_v31restore',1,1000,'succeeded'),
  ('31000000-0000-4000-8000-00000000000f',
   '31000000-0000-4000-8000-000000000002',
   '31000000-0000-4000-8000-00000000000b','re_v31restore_partial',
   'ch_v31restore_partial','pi_v31restore_partial','acct_v31restore',1,400,'succeeded');
INSERT INTO public.billing_disputes(
  id,studio_id,payment_id,stripe_dispute_id,stripe_charge_id,
  stripe_payment_intent_id,stripe_account_id,connect_account_generation,
  amount_cents,status,state_category
) VALUES(
  '31000000-0000-4000-8000-000000000010',
  '31000000-0000-4000-8000-000000000002',
  '31000000-0000-4000-8000-00000000000d','dp_v31restore',
  'ch_v31restore_dispute','pi_v31restore_dispute','acct_v31restore',1,
  100,'needs_response','active'
);
INSERT INTO public.billing_provider_operations(
  id,studio_id,actor_id,operation_type,caller_request_key,request_sha256,
  stripe_connected_account_id,connect_account_generation,state,
  lease_owner,lease_acquired_at,lease_expires_at
) VALUES(
  '31000000-0000-4000-8000-000000000011',
  '31000000-0000-4000-8000-000000000002',
  '31000000-0000-4000-8000-000000000001','payer.sync',
  'v31-restore-provider-evidence',repeat('a',64),'acct_v31restore',1,
  'started','31000000-0000-4000-8000-000000000012',now(),now()+interval '30 seconds'
);
SQL

table_fingerprint() {
  local table_name="$1"
  read_restored "SELECT count(*)::TEXT || ':' || encode(extensions.digest(convert_to(COALESCE(string_agg(to_jsonb(row_state)::TEXT, '|' ORDER BY row_state.id),''),'UTF8'),'sha256'),'hex') FROM public.${table_name} AS row_state;"
}

payments_before="$(table_fingerprint billing_payments)"
refunds_before="$(table_fingerprint billing_refunds)"
disputes_before="$(table_fingerprint billing_disputes)"
operations_before="$(read_restored "SELECT count(*)::TEXT || ':' || encode(extensions.digest(convert_to(COALESCE(string_agg(to_jsonb(row_state)::TEXT, '|' ORDER BY row_state.id),''),'UTF8'),'sha256'),'hex') FROM public.billing_provider_operations AS row_state WHERE NOT (operation_type='invoice.finalize' AND caller_request_key='v31-overlap-finalize');")"
legacy_invoice_negative_before="$(read_restored "SELECT encode(extensions.digest(convert_to(string_agg(to_jsonb(row_state)::TEXT, '|' ORDER BY row_state.id),'UTF8'),'sha256'),'hex') FROM public.billing_invoices AS row_state WHERE id BETWEEN '31000000-0000-4000-8000-000000000016'::uuid AND '31000000-0000-4000-8000-000000000019'::uuid;")"

overlap_log="$temp_dir/v31-overlap-claim.log"
PGAPPNAME=koaryu_v31_overlap_claim "$psql_bin" "${restored_args[@]}" >"$overlap_log" 2>&1 <<'SQL' &
BEGIN;
SELECT public.claim_billing_invoice_closeout_operation_v1(
  '31000000-0000-4000-8000-000000000002'::UUID,
  '31000000-0000-4000-8000-000000000001'::UUID,
  'invoice.finalize','invoice_finalize',
  '31000000-0000-4000-8000-000000000013'::UUID,
  '31000000-0000-4000-8000-000000000004'::UUID,
  'v31-overlap-finalize',repeat('9',64),
  'acct_v31restore',1,
  '31000000-0000-4000-8000-000000000014'::UUID,30
);
SELECT pg_sleep(5);
COMMIT;
SQL
overlap_pid=$!
overlap_active="false"
for _ in $(seq 1 50); do
  overlap_active="$(read_restored "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='koaryu_v31_overlap_claim' AND state='active' AND query LIKE '%pg_sleep%')::TEXT;")"
  if [[ "$overlap_active" == "true" ]]; then break; fi
  sleep 0.1
done
if [[ "$overlap_active" != "true" ]]; then
  kill "$overlap_pid" >/dev/null 2>&1 || true
  wait "$overlap_pid" >/dev/null 2>&1 || true
  echo "V31 overlap claim did not reach its held transaction." >&2
  sed -n '1,80p' "$overlap_log" >&2
  exit 1
fi

"$psql_bin" "${restored_args[@]}" --single-transaction \
  --file="$repository_root/supabase/migrations/20260826185651_payment_refund_payer_sync_resource_ownership.sql" \
  --command="INSERT INTO supabase_migrations.schema_migrations(version,name) VALUES ('20260826185651','payment_refund_payer_sync_resource_ownership');"
if ! wait "$overlap_pid"; then
  echo "V31 overlapping compatibility claim failed." >&2
  sed -n '1,80p' "$overlap_log" >&2
  exit 1
fi
overlap_owner_state="$(read_restored "SELECT count(*)::TEXT || ':' || bool_and(owner.operation_id=alias.operation_id AND owner.resource_claim_id=alias.resource_claim_id AND operation.state='started')::TEXT FROM public.billing_invoice_mutation_owners AS owner JOIN public.billing_provider_operation_resource_aliases AS alias ON alias.studio_id=owner.studio_id AND alias.resource_id=owner.invoice_id AND alias.caller_request_key='v31-overlap-finalize' JOIN public.billing_provider_operations AS operation ON operation.id=alias.operation_id WHERE owner.invoice_id='31000000-0000-4000-8000-000000000013'::UUID;")"
if [[ "$overlap_owner_state" != "1:true" ]]; then
  echo "V31 migration did not adopt the overlapping compatibility claim: $overlap_owner_state" >&2
  exit 1
fi

resource_manifest="$(read_restored 'SELECT private.koaryu_release_resource_ownership_manifest_v31();')"
operational_contract="$(read_restored 'SELECT private.koaryu_release_operational_contract_v31();')"
operational_manifest="$(read_restored 'SELECT private.koaryu_release_operational_manifest_v12();')"
readiness="$(read_restored "SELECT ready::TEXT || '|' || migration_count::TEXT || '|' || migration_head || '|' || cardinality(security_failures)::TEXT || '|' || COALESCE(array_to_string(security_failures,','),'') || '|' || manifest_version FROM public.koaryu_release_schema_preflight_v11();")"
compat_readiness="$(read_restored "SELECT ready::TEXT || '|' || migration_count::TEXT || '|' || migration_head || '|' || cardinality(security_failures)::TEXT || '|' || COALESCE(array_to_string(security_failures,','),'') || '|' || manifest_version FROM public.koaryu_release_schema_preflight_v10();")"
expectation_state="$(read_restored "SELECT count(*)::TEXT || ':' || encode(extensions.digest(convert_to(COALESCE(string_agg(expectation_key || ':' || expected_sha256, '|' ORDER BY expectation_key COLLATE \"C\"),''),'UTF8'),'sha256'),'hex') FROM private.koaryu_release_v31_expectations;")"
catalog_sql="$(cd "$repository_root" && node --input-type=module --eval "import { CATALOG_STATE_SQL } from './scripts/studio-comp-migration-rollout.mjs'; process.stdout.write(CATALOG_STATE_SQL);")"
restored_catalog_state="$(read_restored "$catalog_sql")"
normalization_state="$(read_restored "SELECT string_agg(id::TEXT || ':' || status || ':' || amount_paid_cents::TEXT || ':' || amount_remaining_cents::TEXT || ':' || COALESCE(paid_at IS NOT NULL,false)::TEXT, '|' ORDER BY id) FROM public.billing_invoices WHERE id BETWEEN '31000000-0000-4000-8000-000000000006'::uuid AND '31000000-0000-4000-8000-000000000009'::uuid;")"
payer_state="$(read_restored "SELECT string_agg(id::TEXT || ':' || billing_status || ':' || balance_cents::TEXT, '|' ORDER BY id) FROM public.billing_payers WHERE id BETWEEN '31000000-0000-4000-8000-000000000003'::uuid AND '31000000-0000-4000-8000-000000000005'::uuid;")"
payer_generation_state="$(read_restored "SELECT string_agg(id::TEXT || ':' || COALESCE(connect_account_generation::TEXT,''), '|' ORDER BY id) FROM public.billing_payers WHERE id BETWEEN '31000000-0000-4000-8000-000000000003'::uuid AND '31000000-0000-4000-8000-000000000005'::uuid;")"
invoice_generation_state="$(read_restored "SELECT string_agg(id::TEXT || ':' || CASE WHEN NOT (metadata ? 'connect_account_generation') THEN '<missing>' WHEN metadata->>'connect_account_generation' = '' THEN '<empty>' ELSE COALESCE(metadata->>'connect_account_generation','<json-null>') END, '|' ORDER BY id) FROM public.billing_invoices WHERE id BETWEEN '31000000-0000-4000-8000-000000000015'::uuid AND '31000000-0000-4000-8000-000000000019'::uuid;")"
payments_after="$(table_fingerprint billing_payments)"
refunds_after="$(table_fingerprint billing_refunds)"
disputes_after="$(table_fingerprint billing_disputes)"
operations_after="$(read_restored "SELECT count(*)::TEXT || ':' || encode(extensions.digest(convert_to(COALESCE(string_agg(to_jsonb(row_state)::TEXT, '|' ORDER BY row_state.id),''),'UTF8'),'sha256'),'hex') FROM public.billing_provider_operations AS row_state WHERE NOT (operation_type='invoice.finalize' AND caller_request_key='v31-overlap-finalize');")"
legacy_invoice_negative_after="$(read_restored "SELECT encode(extensions.digest(convert_to(string_agg(to_jsonb(row_state)::TEXT, '|' ORDER BY row_state.id),'UTF8'),'sha256'),'hex') FROM public.billing_invoices AS row_state WHERE id BETWEEN '31000000-0000-4000-8000-000000000016'::uuid AND '31000000-0000-4000-8000-000000000019'::uuid;")"

echo "RESTORED_V31_RESOURCE_OWNERSHIP_MANIFEST=$resource_manifest"
echo "RESTORED_V31_OPERATIONAL_CONTRACT=$operational_contract"
echo "RESTORED_V31_OPERATIONAL_MANIFEST=$operational_manifest"
echo "RESTORED_V31_READINESS=$readiness"
echo "RESTORED_V31_COMPAT_V30_READINESS=$compat_readiness"
echo "RESTORED_V31_EXPECTATION_STATE=$expectation_state"
echo "RESTORED_V31_CATALOG_STATE=$restored_catalog_state"
echo "RESTORED_V31_LEGACY_NORMALIZATION_STATE=$normalization_state"
echo "RESTORED_V31_PAYER_RECEIVABLE_STATE=$payer_state"
echo "RESTORED_V31_PAYER_GENERATION_STATE=$payer_generation_state"
echo "RESTORED_V31_INVOICE_GENERATION_STATE=$invoice_generation_state"
echo "RESTORED_V31_UNTOUCHED_ROW_FINGERPRINTS=$payments_after|$refunds_after|$disputes_after|$operations_after"

if [[ "$resource_manifest" != "0:2338b921f8ae442e304e6ba964ef1af2120dfb25ab9f3d17cb42a59048d180b2" ]]; then echo "Restored V31 resource manifest mismatch." >&2; exit 1; fi
if [[ "$operational_contract" != "0:100b9908bafdd63bffaf7a92a2de2a54816dd6fb4aafe26fec0b853f0f65c49d" ]]; then echo "Restored V31 operational contract mismatch." >&2; exit 1; fi
if [[ "$operational_manifest" != "9f8d37dbe6f761baa42518aaa4debdad9715d83c0733c73665acb37e322e916e" ]]; then echo "Restored V31 operational manifest mismatch." >&2; exit 1; fi
if [[ "$readiness" != "true|124|20260826185651|0||release-db-attestation-v31" ]]; then echo "Restored V31 readiness mismatch: $readiness" >&2; exit 1; fi
if [[ "$compat_readiness" != "true|123|20260826155911|0||release-db-attestation-v30" ]]; then echo "Restored V30 compatibility readiness mismatch: $compat_readiness" >&2; exit 1; fi
if [[ "$expectation_state" != "1:8994fd34dffbb0db5c1531a4f83f299881e0a2277b5b6c685858efc481ce02e8" ]]; then echo "Restored V31 expectation mismatch." >&2; exit 1; fi
if ! (
  cd "$repository_root"
  node --input-type=module --eval '
    import { EXPECTED_V31_RESTORED_CATALOG_STATE } from "./scripts/studio-comp-migration-rollout.mjs";
    if (process.argv[1] !== EXPECTED_V31_RESTORED_CATALOG_STATE) process.exit(1);
  ' "$restored_catalog_state"
); then
  echo "Restored V31 raw catalog mismatch." >&2
  exit 1
fi
if [[ "$normalization_state" != "31000000-0000-4000-8000-000000000006:paid:1000:0:true|31000000-0000-4000-8000-000000000007:paid:1000:0:true|31000000-0000-4000-8000-000000000008:open:300:700:false|31000000-0000-4000-8000-000000000009:void:0:500:false" ]]; then
  echo "Restored V31 legacy normalization mismatch: $normalization_state" >&2
  exit 1
fi
if [[ "$payer_state" != "31000000-0000-4000-8000-000000000003:current:0|31000000-0000-4000-8000-000000000004:current:0|31000000-0000-4000-8000-000000000005:past_due:700" ]]; then
  echo "Restored V31 payer receivable recomputation mismatch: $payer_state" >&2
  exit 1
fi
if [[ "$payer_generation_state" != "31000000-0000-4000-8000-000000000003:1|31000000-0000-4000-8000-000000000004:1|31000000-0000-4000-8000-000000000005:1" ]]; then
  echo "Restored V31 payer generation backfill mismatch: $payer_generation_state" >&2
  exit 1
fi
if [[ "$invoice_generation_state" != "31000000-0000-4000-8000-000000000015:1|31000000-0000-4000-8000-000000000016:<empty>|31000000-0000-4000-8000-000000000017:<missing>|31000000-0000-4000-8000-000000000018:<missing>|31000000-0000-4000-8000-000000000019:<missing>" ]]; then
  echo "Restored V31 invoice generation backfill mismatch: $invoice_generation_state" >&2
  exit 1
fi
if [[ "$legacy_invoice_negative_before" != "$legacy_invoice_negative_after" ]]; then
  echo "V31 invoice generation backfill mutated ambiguous or external invoices." >&2
  exit 1
fi
if [[ "$payments_before" != "$payments_after" || "$refunds_before" != "$refunds_after" || "$disputes_before" != "$disputes_after" || "$operations_before" != "$operations_after" ]]; then
  echo "V31 normalization mutated payment/refund/dispute/provider evidence rows." >&2
  exit 1
fi

"$psql_bin" "${restored_args[@]}" <<'SQL'
BEGIN;
DO $resource_contract$
DECLARE
  v_studio UUID := '31000000-0000-4000-8000-000000000002';
  v_actor UUID := '31000000-0000-4000-8000-000000000001';
  v_other UUID := gen_random_uuid();
  v_payer UUID := gen_random_uuid();
  v_sync_payer UUID := gen_random_uuid();
  v_payment UUID := gen_random_uuid();
  v_pending_payment UUID := gen_random_uuid();
  v_pending_operation UUID;
  v_plan UUID := gen_random_uuid();
  v_product_plan UUID := gen_random_uuid();
  v_product_operation UUID;
  v_operation UUID;
  v_old_operation UUID;
  v_old_version TEXT;
  v_result JSONB;
  v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
  VALUES(v_other,'authenticated','authenticated',
         'v31-resource-'||replace(v_other::TEXT,'-','')||'@example.invalid','{}','{}',v_now,v_now);
  INSERT INTO public.staff_roles(studio_id,user_id,role) VALUES(v_studio,v_other,'admin');
  INSERT INTO public.billing_payers(
    id,studio_id,display_name,email,stripe_account_id,stripe_customer_id,
    connect_account_generation
  ) VALUES
    (v_payer,v_studio,'V31 refund owner','refund-owner@example.invalid',
     'acct_v31restore','cus_v31owner',1),
    (v_sync_payer,v_studio,'V31 sync owner','sync-owner@example.invalid',NULL,NULL,NULL);
  INSERT INTO public.billing_payments(
    id,studio_id,payer_id,stripe_customer_id,stripe_payment_intent_id,
    stripe_charge_id,stripe_account_id,connect_account_generation,status,
    amount_cents,currency,net_collected_amount_cents,refundable_amount_cents,processed_at
  ) VALUES(
    v_payment,v_studio,v_payer,'cus_v31owner','pi_v31owner','ch_v31owner',
    'acct_v31restore',1,'succeeded',1000,'usd',1000,1000,v_now
  );

  v_result := public.claim_billing_provider_operation_resource_v1(
    v_studio,v_actor,'payment.refund','payment',v_payment,v_payer,
    'v31-refund-key-a',repeat('a',64),'acct_v31restore',1,gen_random_uuid(),30
  );
  v_old_operation := (v_result->'operation'->>'id')::UUID;
  v_old_version := v_result->'resource'->>'resource_version_sha256';
  IF v_result->>'outcome'<>'claimed' OR v_old_version !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Initial refund owner was not versioned: %',v_result;
  END IF;
  v_result := public.claim_billing_provider_operation_resource_v1(
    v_studio,v_actor,'payment.refund','payment',v_payment,v_payer,
    'v31-refund-key-b',repeat('a',64),'acct_v31restore',1,gen_random_uuid(),30
  );
  IF v_result->>'outcome'<>'adopted'
     OR (v_result->'operation'->>'id')::UUID<>v_old_operation THEN
    RAISE EXCEPTION 'Concurrent same-version refund did not collapse: %',v_result;
  END IF;
  BEGIN
    PERFORM public.claim_billing_provider_operation_resource_v1(
      v_studio,v_actor,'payment.refund','payment',v_payment,v_payer,
      'v31-refund-different-input',repeat('b',64),
      'acct_v31restore',1,gen_random_uuid(),30
    );
    RAISE EXCEPTION 'Different amount/hash replaced an unchanged refund version.';
  EXCEPTION WHEN unique_violation THEN
    IF SQLERRM<>'billing_provider_operation_resource_request_conflict' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.claim_billing_provider_operation_resource_v1(
      v_studio,v_other,'payment.refund','payment',v_payment,v_payer,
      'v31-refund-key-a',repeat('a',64),'acct_v31restore',1,gen_random_uuid(),30
    );
    RAISE EXCEPTION 'Cross-actor refund replay was accepted.';
  EXCEPTION WHEN unique_violation THEN
    IF SQLERRM<>'billing_provider_operation_resource_actor_conflict' THEN RAISE; END IF;
  END;
  UPDATE public.billing_provider_operations SET
    state='completed',provider_request_attempt_count=1,provider_object_id='re_v31owner',
    result_code='payment_refund_completed',provider_request_in_flight_at=v_now,
    provider_succeeded_at=v_now,projected_at=v_now,completed_at=v_now,
    lease_owner=NULL,lease_acquired_at=NULL,lease_expires_at=NULL,
    revision=revision+1,updated_at=v_now
  WHERE id=v_old_operation;
  BEGIN
    PERFORM public.claim_billing_provider_operation_resource_v1(
      v_studio,v_actor,'payment.refund','payment',v_payment,v_payer,
      'v31-refund-before-version',repeat('b',64),
      'acct_v31restore',1,gen_random_uuid(),30
    );
    RAISE EXCEPTION 'Completed unchanged refund version accepted a different input.';
  EXCEPTION WHEN unique_violation THEN
    IF SQLERRM<>'billing_provider_operation_resource_request_conflict' THEN RAISE; END IF;
  END;
  INSERT INTO public.billing_refunds(
    studio_id,payment_id,stripe_refund_id,stripe_charge_id,stripe_payment_intent_id,
    stripe_account_id,connect_account_generation,amount_cents,status
  ) VALUES(v_studio,v_payment,'re_v31owner','ch_v31owner','pi_v31owner',
           'acct_v31restore',1,100,'succeeded');
  v_result := public.claim_billing_provider_operation_resource_v1(
    v_studio,v_actor,'payment.refund','payment',v_payment,v_payer,
    'v31-refund-key-a',repeat('a',64),'acct_v31restore',1,gen_random_uuid(),30
  );
  IF v_result->>'outcome'<>'replay'
     OR (v_result->'operation'->>'id')::UUID<>v_old_operation THEN
    RAISE EXCEPTION 'Old key did not replay after refund totals advanced: %',v_result;
  END IF;
  v_result := public.claim_billing_provider_operation_resource_v1(
    v_studio,v_actor,'payment.refund','payment',v_payment,v_payer,
    'v31-refund-key-c',repeat('a',64),'acct_v31restore',1,gen_random_uuid(),30
  );
  IF v_result->>'outcome'<>'replaced'
     OR (v_result->'operation'->>'id')::UUID=v_old_operation
     OR v_result->'resource'->>'resource_version_sha256'=v_old_version THEN
    RAISE EXCEPTION 'Advanced refund version did not replace its projected owner: %',v_result;
  END IF;

  INSERT INTO public.billing_payments(
    id,studio_id,payer_id,stripe_customer_id,stripe_payment_intent_id,
    stripe_charge_id,stripe_account_id,connect_account_generation,status,
    amount_cents,currency,net_collected_amount_cents,refundable_amount_cents,processed_at
  ) VALUES(
    v_pending_payment,v_studio,v_payer,'cus_v31owner','pi_v31pending','ch_v31pending',
    'acct_v31restore',1,'succeeded',500,'usd',500,500,v_now
  );
  v_result := public.claim_billing_provider_operation_resource_v1(
    v_studio,v_actor,'payment.refund','payment',v_pending_payment,v_payer,
    'v31-pending-refund-key-a',repeat('e',64),
    'acct_v31restore',1,gen_random_uuid(),30
  );
  v_pending_operation := (v_result->'operation'->>'id')::UUID;
  UPDATE public.billing_provider_operations SET
    state='completed',provider_request_attempt_count=1,
    provider_object_id='re_v31pending',result_code='payment_refund_completed',
    provider_request_in_flight_at=v_now,provider_succeeded_at=v_now,
    projected_at=v_now,completed_at=v_now,lease_owner=NULL,
    lease_acquired_at=NULL,lease_expires_at=NULL,revision=revision+1,
    updated_at=clock_timestamp()
  WHERE id=v_pending_operation;
  INSERT INTO public.billing_refunds(
    studio_id,payment_id,stripe_refund_id,stripe_charge_id,stripe_payment_intent_id,
    stripe_account_id,connect_account_generation,amount_cents,status
  ) VALUES(v_studio,v_pending_payment,'re_v31pending','ch_v31pending','pi_v31pending',
           'acct_v31restore',1,100,'pending');
  BEGIN
    PERFORM public.claim_billing_provider_operation_resource_v1(
      v_studio,v_actor,'payment.refund','payment',v_pending_payment,v_payer,
      'v31-pending-refund-key-b',repeat('e',64),
      'acct_v31restore',1,gen_random_uuid(),30
    );
    RAISE EXCEPTION 'A new refund request replayed an unsettled prior refund.';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN
    IF SQLERRM<>'billing_provider_operation_resource_prior_refund_unsettled' THEN RAISE; END IF;
  END;
  v_result := public.claim_billing_provider_operation_resource_v1(
    v_studio,v_actor,'payment.refund','payment',v_pending_payment,v_payer,
    'v31-pending-refund-key-a',repeat('e',64),
    'acct_v31restore',1,gen_random_uuid(),30
  );
  IF v_result->>'outcome'<>'replay'
     OR (v_result->'operation'->>'id')::UUID<>v_pending_operation THEN
    RAISE EXCEPTION 'Exact pending refund key did not replay: %',v_result;
  END IF;

  INSERT INTO public.billing_plans(
    id,studio_id,name,amount_cents,currency,billing_interval,status
  ) VALUES(v_plan,v_studio,'V31 resource plan',12000,'usd','monthly','pending');
  v_result := public.claim_billing_provider_operation_resource_v1(
    v_studio,v_actor,'plan.sync','plan',v_plan,NULL,
    'v31-plan-key-a',repeat('f',64),'acct_v31restore',1,gen_random_uuid(),30
  );
  v_old_operation := (v_result->'operation'->>'id')::UUID;
  IF v_result->>'outcome'<>'claimed'
     OR v_result->'resource'->>'payer_id' IS NOT NULL THEN
    RAISE EXCEPTION 'Initial plan resource owner was invalid: %',v_result;
  END IF;
  v_result := public.claim_billing_provider_operation_resource_v1(
    v_studio,v_actor,'plan.sync','plan',v_plan,NULL,
    'v31-plan-key-b',repeat('f',64),'acct_v31restore',1,gen_random_uuid(),30
  );
  IF v_result->>'outcome'<>'adopted'
     OR (v_result->'operation'->>'id')::UUID<>v_old_operation THEN
    RAISE EXCEPTION 'Same-version plan sync did not collapse: %',v_result;
  END IF;
  UPDATE public.billing_provider_operations SET
    provider_step_plan_sha256=repeat('2',64),
    provider_step_expected_count=2,
    provider_step_plan_registered_at=clock_timestamp(),
    revision=revision+1,
    updated_at=clock_timestamp()
  WHERE id=v_old_operation;
  INSERT INTO public.billing_provider_operation_steps(
    operation_id,studio_id,stripe_connected_account_id,
    connect_account_generation,step_order,step_name,provider_operation,
    request_sha256,stripe_idempotency_key,state,
    provider_request_attempt_count,provider_object_id,result_code,
    provider_succeeded_at
  ) VALUES
    (v_old_operation,v_studio,'acct_v31restore',1,1,'product',
     'connected_product.create',repeat('3',64),'v31-plan-step-product',
     'provider_succeeded',1,'prod_v31plan','plan_sync_product_succeeded',v_now),
    (v_old_operation,v_studio,'acct_v31restore',1,2,'price',
     'connected_price.create',repeat('4',64),'v31-plan-step-price',
     'provider_succeeded',1,'price_v31plan','plan_sync_price_succeeded',v_now);
  UPDATE public.billing_provider_operations SET
    state='completed',provider_request_attempt_count=1,
    provider_object_id='price_v31plan',result_code='plan_sync_completed',
    result_summary='plan_sync_mode:product_price_steps',
    provider_request_in_flight_at=v_now,provider_succeeded_at=v_now,
    projected_at=v_now,completed_at=v_now,lease_owner=NULL,
    lease_acquired_at=NULL,lease_expires_at=NULL,revision=revision+1,
    updated_at=clock_timestamp()
  WHERE id=v_old_operation;
  UPDATE public.billing_plans SET stripe_account_id='acct_v31restore',
    stripe_product_id='prod_v31plan',stripe_price_id='price_v31plan',
    stripe_price_version=1,status='active',
    updated_at=clock_timestamp() WHERE id=v_plan;
  BEGIN
    PERFORM public.claim_billing_provider_operation_resource_v1(
      v_studio,v_actor,'plan.sync','plan',v_plan,NULL,
      'v31-plan-key-unchanged',repeat('1',64),
      'acct_v31restore',1,gen_random_uuid(),30
    );
    RAISE EXCEPTION 'A caller-selected hash replaced an unchanged completed plan.';
  EXCEPTION WHEN unique_violation THEN
    IF SQLERRM<>'billing_provider_operation_resource_request_conflict' THEN RAISE; END IF;
  END;
  UPDATE public.billing_plans SET
    name='V31 resource plan updated',stripe_product_id='prod_v31plan_drift',
    updated_at=clock_timestamp() WHERE id=v_plan;
  BEGIN
    PERFORM public.claim_billing_provider_operation_resource_v1(
      v_studio,v_other,'plan.sync','plan',v_plan,NULL,
      'v31-plan-key-c',repeat('1',64),'acct_v31restore',1,gen_random_uuid(),30
    );
    RAISE EXCEPTION 'Plan replacement accepted corrupted product projection evidence.';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM<>'billing_provider_operation_resource_prior_projection_unverified' THEN RAISE; END IF;
  END;
  UPDATE public.billing_plans SET
    stripe_product_id='prod_v31plan',stripe_price_id='price_v31plan_drift',
    updated_at=clock_timestamp() WHERE id=v_plan;
  BEGIN
    PERFORM public.claim_billing_provider_operation_resource_v1(
      v_studio,v_other,'plan.sync','plan',v_plan,NULL,
      'v31-plan-key-c',repeat('1',64),'acct_v31restore',1,gen_random_uuid(),30
    );
    RAISE EXCEPTION 'Plan replacement accepted corrupted price projection evidence.';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM<>'billing_provider_operation_resource_prior_projection_unverified' THEN RAISE; END IF;
  END;
  UPDATE public.billing_plans SET stripe_price_id='price_v31plan',
    updated_at=clock_timestamp() WHERE id=v_plan;
  v_result := public.claim_billing_provider_operation_resource_v1(
    v_studio,v_other,'plan.sync','plan',v_plan,NULL,
    'v31-plan-key-c',repeat('1',64),'acct_v31restore',1,gen_random_uuid(),30
  );
  IF v_result->>'outcome'<>'replaced'
     OR (v_result->'operation'->>'id')::UUID=v_old_operation
     OR (v_result->'operation'->>'actor_id')::UUID<>v_other THEN
    RAISE EXCEPTION 'Changed plan resource did not transfer to another active Admin: %',v_result;
  END IF;

  INSERT INTO public.billing_plans(
    id,studio_id,name,amount_cents,currency,billing_interval,status,
    stripe_account_id,stripe_product_id,stripe_price_id,stripe_price_version
  ) VALUES(
    v_product_plan,v_studio,'V31 product-only plan',9000,'usd','monthly','active',
    'acct_v31restore','prod_v31product','price_v31product',1
  );
  v_result:=public.claim_billing_provider_operation_resource_v1(
    v_studio,v_actor,'plan.sync','plan',v_product_plan,NULL,
    'v31-product-plan-key-a',repeat('5',64),
    'acct_v31restore',1,gen_random_uuid(),30
  );
  v_product_operation:=(v_result->'operation'->>'id')::UUID;
  UPDATE public.billing_provider_operations SET
    provider_step_plan_sha256=repeat('6',64),
    provider_step_expected_count=2,
    provider_step_plan_registered_at=clock_timestamp(),
    revision=revision+1,updated_at=clock_timestamp()
  WHERE id=v_product_operation;
  UPDATE public.billing_provider_operations SET
    state='completed',provider_request_attempt_count=1,
    provider_object_id='prod_v31product',result_code='plan_sync_completed',
    result_summary='plan_sync_mode:product_update_only',
    provider_request_in_flight_at=clock_timestamp(),
    provider_succeeded_at=clock_timestamp(),projected_at=clock_timestamp(),
    completed_at=clock_timestamp(),lease_owner=NULL,
    lease_acquired_at=NULL,lease_expires_at=NULL,
    revision=revision+1,updated_at=clock_timestamp()
  WHERE id=v_product_operation;
  UPDATE public.billing_plans SET name='V31 product-only plan updated',
    updated_at=clock_timestamp() WHERE id=v_product_plan;
  BEGIN
    PERFORM public.claim_billing_provider_operation_resource_v1(
      v_studio,v_actor,'plan.sync','plan',v_product_plan,NULL,
      'v31-product-plan-key-b',repeat('7',64),
      'acct_v31restore',1,gen_random_uuid(),30
    );
    RAISE EXCEPTION 'Product-only plan replacement accepted step-plan evidence.';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM<>'billing_provider_operation_resource_prior_projection_unverified' THEN RAISE; END IF;
  END;

  v_result := public.claim_billing_provider_operation_resource_v1(
    v_studio,v_actor,'payer.sync','payer',v_sync_payer,v_sync_payer,
    'v31-payer-key-a',repeat('c',64),'acct_v31restore',1,gen_random_uuid(),30
  );
  v_old_operation := (v_result->'operation'->>'id')::UUID;
  v_old_version := v_result->'resource'->>'resource_version_sha256';
  UPDATE public.billing_provider_operations SET
    state='completed',provider_request_attempt_count=1,provider_object_id='cus_v31sync',
    result_code='payer_sync_completed',provider_request_in_flight_at=v_now,
    provider_succeeded_at=v_now,projected_at=v_now,completed_at=v_now,
    lease_owner=NULL,lease_acquired_at=NULL,lease_expires_at=NULL,
    revision=revision+1,updated_at=v_now
  WHERE id=v_old_operation;
  UPDATE public.billing_payers SET stripe_account_id='acct_v31restore',
    stripe_customer_id='cus_v31sync',connect_account_generation=1,
    updated_at=clock_timestamp() WHERE id=v_sync_payer;
  v_result := public.claim_billing_provider_operation_resource_v1(
    v_studio,v_actor,'payer.sync','payer',v_sync_payer,v_sync_payer,
    'v31-payer-key-b',repeat('c',64),'acct_v31restore',1,gen_random_uuid(),30
  );
  IF v_result->>'outcome'<>'adopted'
     OR (v_result->'operation'->>'id')::UUID<>v_old_operation THEN
    RAISE EXCEPTION 'Provider-assigned customer identity changed payer desired version: %',v_result;
  END IF;
  UPDATE public.billing_payers SET email='sync-owner-updated@example.invalid',
    updated_at=clock_timestamp() WHERE id=v_sync_payer;
  v_result := public.claim_billing_provider_operation_resource_v1(
    v_studio,v_actor,'payer.sync','payer',v_sync_payer,v_sync_payer,
    'v31-payer-key-a',repeat('c',64),'acct_v31restore',1,gen_random_uuid(),30
  );
  IF v_result->>'outcome'<>'replay'
     OR (v_result->'operation'->>'id')::UUID<>v_old_operation THEN
    RAISE EXCEPTION 'Old payer key did not replay after desired state advanced: %',v_result;
  END IF;
  v_result := public.claim_billing_provider_operation_resource_v1(
    v_studio,v_actor,'payer.sync','payer',v_sync_payer,v_sync_payer,
    'v31-payer-key-c',repeat('d',64),'acct_v31restore',1,gen_random_uuid(),30
  );
  v_operation := (v_result->'operation'->>'id')::UUID;
  IF v_result->>'outcome'<>'replaced' OR v_operation=v_old_operation
     OR v_result->'resource'->>'resource_version_sha256'=v_old_version THEN
    RAISE EXCEPTION 'Changed payer state did not replace its projected owner: %',v_result;
  END IF;
END;
$resource_contract$;

DO $sparse_payment_contract$
DECLARE
  v_payment public.billing_payments%ROWTYPE;
BEGIN
  SELECT * INTO v_payment FROM public.billing_payments
  WHERE id='31000000-0000-4000-8000-00000000000d';
  UPDATE public.billing_payments SET payer_id=NULL,invoice_id=NULL,
    stripe_customer_id=NULL,stripe_invoice_id=NULL,stripe_payment_intent_id=NULL,
    stripe_charge_id=NULL,stripe_account_id=NULL,connect_account_generation=NULL,
    stripe_payment_method_id=NULL
  WHERE id=v_payment.id;
  IF NOT EXISTS(
    SELECT 1 FROM public.billing_payments AS current
    WHERE current.id=v_payment.id
      AND current.payer_id IS NOT DISTINCT FROM v_payment.payer_id
      AND current.invoice_id IS NOT DISTINCT FROM v_payment.invoice_id
      AND current.stripe_customer_id IS NOT DISTINCT FROM v_payment.stripe_customer_id
      AND current.stripe_invoice_id IS NOT DISTINCT FROM v_payment.stripe_invoice_id
      AND current.stripe_payment_intent_id IS NOT DISTINCT FROM v_payment.stripe_payment_intent_id
      AND current.stripe_charge_id IS NOT DISTINCT FROM v_payment.stripe_charge_id
      AND current.stripe_account_id IS NOT DISTINCT FROM v_payment.stripe_account_id
      AND current.connect_account_generation IS NOT DISTINCT FROM v_payment.connect_account_generation
      AND current.stripe_payment_method_id IS NOT DISTINCT FROM v_payment.stripe_payment_method_id
      AND current.status=v_payment.status
  ) THEN RAISE EXCEPTION 'Sparse payment projection did not preserve established identity.'; END IF;
  BEGIN
    UPDATE public.billing_payments SET stripe_charge_id='ch_v31conflict'
    WHERE id=v_payment.id;
    RAISE EXCEPTION 'Established charge replacement was accepted.';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM<>'Established billing payment identity cannot change.' THEN RAISE; END IF;
  END;
END;
$sparse_payment_contract$;

DO $due_reclaim_contract$
DECLARE
  v_studio UUID := '31000000-0000-4000-8000-000000000002';
  v_actor UUID := '31000000-0000-4000-8000-000000000001';
  v_payer UUID := gen_random_uuid();
  v_plan UUID := gen_random_uuid();
  v_student UUID := gen_random_uuid();
  v_subscription UUID := gen_random_uuid();
  v_enrollment UUID := gen_random_uuid();
  v_schedule UUID := gen_random_uuid();
  v_execute UUID := gen_random_uuid();
  v_operation UUID := gen_random_uuid();
  v_old_worker UUID := gen_random_uuid();
  v_new_worker UUID := gen_random_uuid();
  v_claimed UUID;
  v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  INSERT INTO public.billing_payers(
    id,studio_id,display_name,stripe_account_id,stripe_customer_id,
    connect_account_generation
  ) VALUES(v_payer,v_studio,'V31 due payer','acct_v31restore','cus_v31due',1);
  INSERT INTO public.billing_plans(id,studio_id,name,amount_cents,billing_interval,status)
  VALUES(v_plan,v_studio,'V31 due plan',1000,'monthly','active');
  INSERT INTO public.students(id,studio_id,legal_first_name,legal_last_name)
  VALUES(v_student,v_studio,'Due','Reclaim');
  INSERT INTO public.billing_subscriptions(
    id,studio_id,payer_id,stripe_account_id,stripe_customer_id,
    stripe_subscription_id,collection_mode,billing_interval,currency,status,
    current_period_end,metadata
  ) VALUES(v_subscription,v_studio,v_payer,'acct_v31restore','cus_v31due',
           'sub_v31due','invoice_link','monthly','usd','active',
           v_now-interval '1 minute',jsonb_build_object('connect_account_generation',1));
  INSERT INTO public.student_billing_enrollments(
    id,studio_id,student_id,payer_id,billing_plan_id,billing_subscription_id,
    collection_mode,status,stripe_subscription_id,stripe_subscription_item_id
  ) VALUES(v_enrollment,v_studio,v_student,v_payer,v_plan,v_subscription,
           'invoice_link','active','sub_v31due','si_v31due');
  INSERT INTO public.billing_provider_operations(
    id,studio_id,actor_id,operation_type,caller_request_key,request_sha256,
    stripe_connected_account_id,connect_account_generation,state,
    provider_request_attempt_count,lease_owner,lease_acquired_at,lease_expires_at,
    started_at,created_at,updated_at
  ) VALUES(v_operation,v_studio,v_actor,'enrollment.cancel.period_end.execute',
           'v31-due-provider',repeat('e',64),'acct_v31restore',1,'started',0,
           v_old_worker,v_now-interval '2 minutes',v_now-interval '1 minute',
           v_now-interval '2 minutes',v_now-interval '2 minutes',v_now-interval '2 minutes');
  INSERT INTO public.billing_enrollment_transition_intents(
    id,studio_id,enrollment_id,payer_id,billing_subscription_id,
    transition_kind,mutation_strategy,request_sha256,stripe_connected_account_id,
    connect_account_generation,stripe_subscription_id,stripe_subscription_item_id,
    period_boundary,expected_quantity,expected_subscription_item_count,
    same_item_active_count,provider_quantity,initiated_by,reason_code,state,
    due_claimed_at,created_at,updated_at
  ) VALUES(v_schedule,v_studio,v_enrollment,v_payer,v_subscription,
           'schedule_period_end','subscription_item_delete_at_period_end',repeat('f',64),
           'acct_v31restore',1,'sub_v31due','si_v31due',v_now-interval '1 minute',
           0,2,1,1,v_actor,'v31.due','due_claimed',v_now-interval '2 minutes',
           v_now-interval '2 minutes',v_now-interval '2 minutes');
  INSERT INTO public.billing_enrollment_transition_intents(
    id,studio_id,enrollment_id,payer_id,billing_subscription_id,source_intent_id,
    provider_operation_id,transition_kind,mutation_strategy,request_sha256,
    provider_caller_request_key,provider_request_sha256,stripe_connected_account_id,
    connect_account_generation,stripe_subscription_id,stripe_subscription_item_id,
    period_boundary,expected_quantity,expected_subscription_item_count,
    same_item_active_count,provider_quantity,initiated_by,reason_code,state,
    lease_owner,lease_acquired_at,lease_expires_at,due_claimed_at,created_at,updated_at
  ) VALUES(v_execute,v_studio,v_enrollment,v_payer,v_subscription,v_schedule,v_operation,
           'execute_due','subscription_item_delete_at_period_end',repeat('f',64),
           'v31-due-provider',repeat('e',64),'acct_v31restore',1,'sub_v31due','si_v31due',
           v_now-interval '1 minute',0,2,1,1,v_actor,'v31.due','due_claimed',
           v_old_worker,v_now-interval '2 minutes',v_now-interval '1 minute',
           v_now-interval '2 minutes',v_now-interval '2 minutes',v_now-interval '2 minutes');
  SELECT due.id INTO v_claimed
  FROM public.claim_due_billing_enrollment_transitions_v1(v_new_worker,30,1) AS due;
  IF v_claimed IS DISTINCT FROM v_execute
     OR (SELECT lease_owner FROM public.billing_enrollment_transition_intents
         WHERE id=v_execute) IS DISTINCT FROM v_new_worker
     OR (SELECT lease_owner FROM public.billing_provider_operations
         WHERE id=v_operation) IS DISTINCT FROM v_new_worker
     OR (SELECT revision FROM public.billing_enrollment_transition_intents
         WHERE id=v_execute)<>2
     OR (SELECT revision FROM public.billing_provider_operations
         WHERE id=v_operation)<>2
     OR (SELECT count(*) FROM public.billing_enrollment_transition_intents
         WHERE source_intent_id=v_schedule AND transition_kind='execute_due')<>1 THEN
    RAISE EXCEPTION 'Bound expired due work did not reclaim one exact durable operation.';
  END IF;
END;
$due_reclaim_contract$;
ROLLBACK;
SQL

drift_ready="$(read_restored "BEGIN; ALTER FUNCTION private.validate_billing_payment_identity_change() SET search_path=public; SELECT ready::TEXT FROM public.koaryu_release_schema_preflight_v11(); ROLLBACK;")"
if [[ "$drift_ready" != "false" ]]; then
  echo "Restored V31 preflight accepted payment-identity function drift." >&2
  exit 1
fi

resource_body_ready="$(read_restored "BEGIN; CREATE TEMP TABLE v31_manifest_spoof(value TEXT); INSERT INTO v31_manifest_spoof SELECT private.koaryu_release_resource_ownership_manifest_v31(); CREATE OR REPLACE FUNCTION private.koaryu_release_resource_ownership_manifest_v31() RETURNS TEXT LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog AS 'SELECT value FROM pg_temp.v31_manifest_spoof LIMIT 1'; SELECT ready::TEXT FROM public.koaryu_release_schema_preflight_v11(); ROLLBACK;")"
if [[ "$resource_body_ready" != "false" ]]; then
  echo "Restored V31 preflight accepted resource-manifest body substitution." >&2
  exit 1
fi

contract_body_ready="$(read_restored "BEGIN; CREATE TEMP TABLE v31_contract_spoof(value TEXT); INSERT INTO v31_contract_spoof SELECT private.koaryu_release_operational_contract_v31(); CREATE OR REPLACE FUNCTION private.koaryu_release_operational_contract_v31() RETURNS TEXT LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog SET \"TimeZone\"='UTC' AS 'SELECT value FROM pg_temp.v31_contract_spoof LIMIT 1'; SELECT ready::TEXT FROM public.koaryu_release_schema_preflight_v11(); ROLLBACK;")"
if [[ "$contract_body_ready" != "false" ]]; then
  echo "Restored V31 preflight accepted operational-contract body substitution." >&2
  exit 1
fi

provider_body_ready="$(read_restored "BEGIN; CREATE TEMP TABLE v31_provider_spoof(value TEXT); INSERT INTO v31_provider_spoof SELECT private.koaryu_release_provider_operation_steps_manifest_v28(); CREATE OR REPLACE FUNCTION private.koaryu_release_provider_operation_steps_manifest_v28() RETURNS TEXT LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog AS 'SELECT value FROM pg_temp.v31_provider_spoof LIMIT 1'; SELECT ready::TEXT FROM public.koaryu_release_schema_preflight_v11(); ROLLBACK;")"
if [[ "$provider_body_ready" != "false" ]]; then
  echo "Restored V31 preflight accepted provider-manifest body substitution." >&2
  exit 1
fi

expectation_acl_ready="$(read_restored "BEGIN; GRANT UPDATE ON private.koaryu_release_v31_expectations TO service_role; SELECT ready::TEXT FROM public.koaryu_release_schema_preflight_v11(); ROLLBACK;")"
if [[ "$expectation_acl_ready" != "false" ]]; then
  echo "Restored V31 preflight accepted broadened expectation-table ACLs." >&2
  exit 1
fi

owner_integrity_ready="$(read_restored "BEGIN; ALTER TABLE public.billing_invoice_mutation_owners DROP CONSTRAINT billing_invoice_mutation_owners_pkey; ALTER TABLE public.billing_invoice_mutation_owners DROP CONSTRAINT billing_invoice_mutation_owners_payer_id_fkey; SELECT ready::TEXT FROM public.koaryu_release_schema_preflight_v11(); ROLLBACK;")"
if [[ "$owner_integrity_ready" != "false" ]]; then
  echo "Restored V31 preflight accepted invoice-owner PK/FK removal." >&2
  exit 1
fi

owner_acl_ready="$(read_restored "BEGIN; GRANT UPDATE ON public.billing_invoice_mutation_owners TO service_role; SELECT ready::TEXT FROM public.koaryu_release_schema_preflight_v11(); ROLLBACK;")"
if [[ "$owner_acl_ready" != "false" ]]; then
  echo "Restored V31 preflight accepted broadened invoice-owner ACLs." >&2
  exit 1
fi

owner_custom_acl_ready="$(read_restored "BEGIN; CREATE ROLE v31_owner_acl_probe NOLOGIN; GRANT SELECT ON public.billing_invoice_mutation_owners TO v31_owner_acl_probe; SELECT ready::TEXT FROM public.koaryu_release_schema_preflight_v11(); ROLLBACK;")"
if [[ "$owner_custom_acl_ready" != "false" ]]; then
  echo "Restored V31 preflight accepted a custom-role invoice-owner grant." >&2
  exit 1
fi

owner_extra_column_ready="$(read_restored "BEGIN; ALTER TABLE public.billing_invoice_mutation_owners ADD COLUMN unexpected_probe TEXT; SELECT ready::TEXT FROM public.koaryu_release_schema_preflight_v11(); ROLLBACK;")"
if [[ "$owner_extra_column_ready" != "false" ]]; then
  echo "Restored V31 preflight accepted an unexpected invoice-owner column." >&2
  exit 1
fi

owner_trigger_ready="$(read_restored "BEGIN; DROP TRIGGER preserve_billing_invoice_mutation_owner_v31 ON public.billing_invoice_mutation_owners; CREATE TRIGGER preserve_billing_invoice_mutation_owner_v31 AFTER UPDATE ON public.billing_invoice_mutation_owners FOR EACH ROW EXECUTE FUNCTION private.preserve_billing_invoice_mutation_owner_v31(); SELECT ready::TEXT FROM public.koaryu_release_schema_preflight_v11(); ROLLBACK;")"
if [[ "$owner_trigger_ready" != "false" ]]; then
  echo "Restored V31 preflight accepted wrong invoice-owner trigger topology." >&2
  exit 1
fi

maintenance_trigger_ready="$(read_restored "BEGIN; DROP TRIGGER maintain_billing_invoice_mutation_owner_v31 ON public.billing_provider_operation_resources; CREATE TRIGGER maintain_billing_invoice_mutation_owner_v31 AFTER UPDATE OF operation_id ON public.billing_provider_operation_resources FOR EACH ROW EXECUTE FUNCTION private.maintain_billing_invoice_mutation_owner_v31(); SELECT ready::TEXT FROM public.koaryu_release_schema_preflight_v11(); ROLLBACK;")"
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

echo "PASS: V30 dump/restore predecessor plus migration 124 produced the exact V31 contract."
