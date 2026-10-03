resource_manifest="$(read_restored 'SELECT private.koaryu_release_resource_ownership_manifest_v31();')"
operational_contract="$(read_restored 'SELECT private.koaryu_release_operational_contract_v31();')"
operational_manifest="$(read_restored 'SELECT private.koaryu_release_operational_manifest_v12();')"
readiness="$(read_restored "SELECT ready::TEXT || '|' || migration_count::TEXT || '|' || migration_head || '|' || cardinality(security_failures)::TEXT || '|' || COALESCE(array_to_string(security_failures,','),'') || '|' || manifest_version FROM @@CURRENT_PREFLIGHT@@;")"
compat_readiness="$(read_restored "SELECT ready::TEXT || '|' || migration_count::TEXT || '|' || migration_head || '|' || cardinality(security_failures)::TEXT || '|' || COALESCE(array_to_string(security_failures,','),'') || '|' || manifest_version FROM @@PREVIOUS_PREFLIGHT@@;")"
expectation_state="$(read_restored "SELECT count(*)::TEXT || ':' || encode(extensions.digest(convert_to(COALESCE(string_agg(expectation_key || ':' || expected_sha256, '|' ORDER BY expectation_key COLLATE \"C\"),''),'UTF8'),'sha256'),'hex') FROM private.koaryu_release_v31_expectations;")"
catalog_sql="$(cd "$repository_root" && node --input-type=module --eval "import { CATALOG_STATE_SQL } from './scripts/studio-comp-migration-rollout.mjs'; process.stdout.write(CATALOG_STATE_SQL);")"
restored_catalog_state="$(read_restored "$catalog_sql")"
normalization_state="$(read_restored "SELECT string_agg(id::TEXT || ':' || status || ':' || amount_paid_cents::TEXT || ':' || amount_remaining_cents::TEXT || ':' || COALESCE(paid_at IS NOT NULL,false)::TEXT, '|' ORDER BY id) FROM public.billing_invoices WHERE id BETWEEN '31000000-0000-4000-8000-000000000006'::uuid AND '31000000-0000-4000-8000-000000000009'::uuid;")"
payer_state="$(read_restored "SELECT string_agg(id::TEXT || ':' || billing_status || ':' || balance_cents::TEXT, '|' ORDER BY id) FROM public.billing_payers WHERE id BETWEEN '31000000-0000-4000-8000-000000000003'::uuid AND '31000000-0000-4000-8000-000000000005'::uuid;")"
payer_generation_state="$(read_restored "SELECT string_agg(id::TEXT || ':' || COALESCE(connect_account_generation::TEXT,''), '|' ORDER BY id) FROM public.billing_payers WHERE id BETWEEN '31000000-0000-4000-8000-000000000003'::uuid AND '31000000-0000-4000-8000-000000000005'::uuid;")"
invoice_generation_state="$(read_restored "SELECT string_agg(id::TEXT || ':' || CASE WHEN NOT (metadata ? 'connect_account_generation') THEN '<missing>' WHEN metadata->>'connect_account_generation' = '' THEN '<empty>' ELSE COALESCE(metadata->>'connect_account_generation','<json-null>') END, '|' ORDER BY id) FROM public.billing_invoices WHERE id BETWEEN '31000000-0000-4000-8000-000000000015'::uuid AND '31000000-0000-4000-8000-000000000019'::uuid;")"
plan_price_generation_state="$(read_restored "SELECT string_agg(id::TEXT || ':' || COALESCE(metadata->>'connect_account_generation','<missing>') || ':' || COALESCE(metadata->>'legacy_marker','<none>'), '|' ORDER BY id) FROM public.billing_plan_prices WHERE id BETWEEN '31000000-0000-4000-8000-000000000022'::uuid AND '31000000-0000-4000-8000-000000000023'::uuid;")"
subscription_generation_state="$(read_restored "SELECT string_agg(id::TEXT || ':' || COALESCE(metadata->>'connect_account_generation','<missing>') || ':' || COALESCE(metadata->>'legacy_marker','<none>'), '|' ORDER BY id) FROM public.billing_subscriptions WHERE id BETWEEN '31000000-0000-4000-8000-000000000024'::uuid AND '31000000-0000-4000-8000-000000000026'::uuid;")"
demo_fixture_state="$(read_restored "SELECT payer.stripe_account_id || ':' || payer.stripe_customer_id || ':' || COALESCE(payer.connect_account_generation::TEXT,'<null>') || ':' || COALESCE((payer.metadata->>'demo')::BOOLEAN,false)::TEXT || ':' || account.status || ':' || COALESCE(account.stripe_connected_account_id,'<null>') || ':' || account.charges_enabled::TEXT || ':' || account.payouts_enabled::TEXT || ':' || subscription.stripe_subscription_id || ':' || invoice.stripe_invoice_id || ':' || payment.stripe_charge_id || ':' || COALESCE(payment.connect_account_generation::TEXT,'<null>') FROM public.billing_payers AS payer JOIN public.studio_payment_accounts AS account ON account.studio_id=payer.studio_id JOIN public.billing_subscriptions AS subscription ON subscription.payer_id=payer.id JOIN public.billing_invoices AS invoice ON invoice.payer_id=payer.id JOIN public.billing_payments AS payment ON payment.payer_id=payer.id WHERE payer.id='32000000-0000-4000-8000-000000000003'::UUID;")"
connected_demo_fixture_state="$(read_restored "SELECT COALESCE(payer.stripe_account_id,'<null>') || ':' || COALESCE(payer.stripe_customer_id,'<null>') || ':' || COALESCE(payer.connect_account_generation::TEXT,'<null>') || ':' || payer.autopay_status || ':' || COALESCE(payer.default_payment_method_id,'<null>') || ':' || COALESCE(payer.autopay_authorized_at::TEXT,'<null>') || ':' || COALESCE(payer.autopay_terms_accepted_at::TEXT,'<null>') || ':' || COALESCE(payer.metadata#>>'{v31_demo_provider_identity_normalization,reason}','<missing>') || ':' || COALESCE(payer.metadata#>>'{v31_demo_provider_identity_normalization,synthetic_customer_id}','<missing>') || ':' || account.stripe_connected_account_id || ':' || private.current_connect_account_generation(account.metadata)::TEXT FROM public.billing_payers AS payer JOIN public.studio_payment_accounts AS account ON account.studio_id=payer.studio_id WHERE payer.id='33000000-0000-4000-8000-000000000003'::UUID;")"
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
echo "RESTORED_V31_PLAN_PRICE_GENERATION_STATE=$plan_price_generation_state"
echo "RESTORED_V31_SUBSCRIPTION_GENERATION_STATE=$subscription_generation_state"
echo "RESTORED_V31_DEMO_FIXTURE_STATE=$demo_fixture_state"
echo "RESTORED_V31_CONNECTED_DEMO_FIXTURE_STATE=$connected_demo_fixture_state"
echo "RESTORED_V31_UNTOUCHED_ROW_FINGERPRINTS=$payments_after|$refunds_after|$disputes_after|$operations_after"

if [[ "$resource_manifest" != "0:7003a83b5deea53d0c365ec3e2eca4dd5281f7658fe0a41d053c1e1618d709c1" ]]; then echo "Restored V31 resource manifest mismatch." >&2; exit 1; fi
if [[ "$operational_contract" != "0:b0bf5a376dab5ece5a6d9e44b7ea3067ce7700200361c20f0b1f0166395f0c3b" ]]; then echo "Restored V31 operational contract mismatch." >&2; exit 1; fi
if [[ "$operational_manifest" != "26373f66ff1800369b7bad388a1b38452e48615b2635cc796d173a3fa92707fc" ]]; then echo "Restored V31 operational manifest mismatch." >&2; exit 1; fi
if [[ "$readiness" != "@@CURRENT_READINESS@@" ]]; then echo "Restored V31 readiness mismatch: $readiness" >&2; exit 1; fi
if [[ "$compat_readiness" != "@@PREVIOUS_READINESS@@" ]]; then echo "Restored V30 compatibility readiness mismatch: $compat_readiness" >&2; exit 1; fi
if [[ "$expectation_state" != "1:b20f61ed99dae99c64e82856b2a4ba563089f28945ae303ff8a78bef88af733a" ]]; then echo "Restored V31 expectation mismatch." >&2; exit 1; fi
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
if [[ "$plan_price_generation_state" != "31000000-0000-4000-8000-000000000022:1:keep|31000000-0000-4000-8000-000000000023:<missing>:keep" ]]; then
  echo "Restored V31 plan-price generation adoption mismatch: $plan_price_generation_state" >&2
  exit 1
fi
if [[ "$subscription_generation_state" != "31000000-0000-4000-8000-000000000024:1:keep|31000000-0000-4000-8000-000000000025:<missing>:keep|31000000-0000-4000-8000-000000000026:9:<none>" ]]; then
  echo "Restored V31 subscription generation adoption mismatch: $subscription_generation_state" >&2
  exit 1
fi
if [[ "$demo_fixture_state" != "acct_demo_river_city:cus_demo_restore:<null>:true:not_connected:<null>:false:false:sub_demo_restore:in_demo_restore:ch_demo_restore:<null>" ]]; then
  echo "Restored V31 canonical demo fixture drifted or became live-capable: $demo_fixture_state" >&2
  exit 1
fi
if [[ "$connected_demo_fixture_state" != "<null>:<null>:<null>:not_configured:<null>:<null>:<null>:synthetic_customer_under_connected_account:cus_demo_connected:acct_v31connected:3" ]]; then
  echo "Restored V31 connected demo fixture was not normalized safely: $connected_demo_fixture_state" >&2
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
