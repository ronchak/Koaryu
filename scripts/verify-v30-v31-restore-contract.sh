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
   'acct_v31restore','cus_v31restore_full',1,'past_due',1000),
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
operations_before="$(table_fingerprint billing_provider_operations)"

"$psql_bin" "${restored_args[@]}" --single-transaction \
  --file="$repository_root/supabase/migrations/20260826185651_payment_refund_payer_sync_resource_ownership.sql" \
  --command="INSERT INTO supabase_migrations.schema_migrations(version,name) VALUES ('20260826185651','payment_refund_payer_sync_resource_ownership');"

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
payments_after="$(table_fingerprint billing_payments)"
refunds_after="$(table_fingerprint billing_refunds)"
disputes_after="$(table_fingerprint billing_disputes)"
operations_after="$(table_fingerprint billing_provider_operations)"

echo "RESTORED_V31_RESOURCE_OWNERSHIP_MANIFEST=$resource_manifest"
echo "RESTORED_V31_OPERATIONAL_CONTRACT=$operational_contract"
echo "RESTORED_V31_OPERATIONAL_MANIFEST=$operational_manifest"
echo "RESTORED_V31_READINESS=$readiness"
echo "RESTORED_V31_COMPAT_V30_READINESS=$compat_readiness"
echo "RESTORED_V31_EXPECTATION_STATE=$expectation_state"
echo "RESTORED_V31_CATALOG_STATE=$restored_catalog_state"
echo "RESTORED_V31_LEGACY_NORMALIZATION_STATE=$normalization_state"
echo "RESTORED_V31_PAYER_RECEIVABLE_STATE=$payer_state"
echo "RESTORED_V31_UNTOUCHED_ROW_FINGERPRINTS=$payments_after|$refunds_after|$disputes_after|$operations_after"

if [[ "$resource_manifest" != "0:88d995d82173f5ac5f42b424ec392ad1432000645265d68e9b71d2c0f829f36c" ]]; then echo "Restored V31 resource manifest mismatch." >&2; exit 1; fi
if [[ "$operational_contract" != "0:a6ba54bedd4ae2643cac443fad2abf684e406488e33330d401bb264a360e805a" ]]; then echo "Restored V31 operational contract mismatch." >&2; exit 1; fi
if [[ "$operational_manifest" != "d7b8f30fb72ad7b20308bf96711308d7d2d6b8ce4376c478cbb5b7f1eb3eb7e4" ]]; then echo "Restored V31 operational manifest mismatch." >&2; exit 1; fi
if [[ "$readiness" != "true|124|20260826185651|0||release-db-attestation-v31" ]]; then echo "Restored V31 readiness mismatch: $readiness" >&2; exit 1; fi
if [[ "$compat_readiness" != "true|123|20260826155911|0||release-db-attestation-v30" ]]; then echo "Restored V30 compatibility readiness mismatch: $compat_readiness" >&2; exit 1; fi
if [[ "$expectation_state" != "1:19c7bacdf55084069c582878a7c23e4e1eb466b8f9e03c8d9fa30580a28f4e56" ]]; then echo "Restored V31 expectation mismatch." >&2; exit 1; fi
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

echo "PASS: V30 dump/restore predecessor plus migration 124 produced the exact V31 contract."
