negative_log="$temp_dir/v31-demo-negative.log"
"$psql_bin" "${restored_args[@]}" --command="
  INSERT INTO public.billing_payers(
    id,studio_id,display_name,stripe_account_id,stripe_customer_id,
    connect_account_generation,billing_status,balance_cents,metadata
  ) VALUES(
    '32000000-0000-4000-8000-000000000007',
    '32000000-0000-4000-8000-000000000002','Unmarked provider-shaped payer',
    'acct_demo_river_city','cus_demo_unmarked',NULL,'current',0,'{}'::JSONB
  );
"
if "$psql_bin" "${restored_args[@]}" --single-transaction \
  --file="$repository_root/supabase/migrations/@@MIGRATION_FILE@@" \
  >"$negative_log" 2>&1; then
  echo "V31 accepted an unmarked provider-shaped payer in a disconnected demo studio." >&2
  exit 1
fi
negative_output="$(<"$negative_log")"
if [[ "$negative_output" != *"billing_payer_connect_generation_backfill_incomplete"* ]]; then
  echo "V31 negative demo-fixture probe failed for an unexpected reason." >&2
  sed -n '1,80p' "$negative_log" >&2
  exit 1
fi
"$psql_bin" "${restored_args[@]}" --command="
  DELETE FROM public.billing_payers
  WHERE id='32000000-0000-4000-8000-000000000007'::UUID;
"

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
  --file="$repository_root/supabase/migrations/@@MIGRATION_FILE@@" \
  --command="INSERT INTO supabase_migrations.schema_migrations(version,name) VALUES ('@@MIGRATION_VERSION@@','@@MIGRATION_NAME@@');"
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
