DO $guard$
DECLARE previous record;
BEGIN
 SELECT * INTO previous FROM public.koaryu_release_schema_preflight_v18();
 IF previous.ready IS DISTINCT FROM true OR previous.migration_count<>132
 OR previous.migration_head<>'20260902001000' OR previous.manifest_version<>'release-db-attestation-v37'
 OR cardinality(previous.security_failures)<>0 THEN
  RAISE EXCEPTION 'Billing landing V38 requires exact ready V37.';
 END IF;
END $guard$;

-- Service-role reads only. FastAPI resolves membership and subscription before financial access.
CREATE FUNCTION public.billing_payment_cohort(p_studio_id uuid, p_period_start timestamptz, p_period_end timestamptz)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
WITH gross AS (
 SELECT status, greatest(0, coalesce(gross_paid_amount_cents, amount_cents, 0))::bigint AS gross,
        refunded_amount_cents, disputed_amount_cents, net_collected_amount_cents
 FROM public.billing_payments
 WHERE studio_id = p_studio_id
 AND status IN ('succeeded','refunded','disputed','externally_recorded')
 AND processed_at >= p_period_start AND processed_at < p_period_end
), refunds AS (
 SELECT *, least(gross, greatest(0, coalesce(refunded_amount_cents,0))) AS refunded FROM gross
), adjustments AS (
 SELECT *, least(greatest(0,gross-refunded),greatest(0,coalesce(disputed_amount_cents,0))) AS disputed FROM refunds
), net AS (
 SELECT *, greatest(0,coalesce(net_collected_amount_cents,gross-refunded-disputed)) AS net FROM adjustments
)
SELECT jsonb_build_object(
 'period_start',p_period_start,'period_end',p_period_end,'payment_count',count(*),
 'gross_paid_amount_cents',coalesce(sum(gross),0),'refunded_amount_cents',coalesce(sum(refunded),0),
 'disputed_amount_cents',coalesce(sum(disputed),0),'net_amount_cents',coalesce(sum(net),0),
 'stripe_net_amount_cents',coalesce(sum(net) FILTER (WHERE status <> 'externally_recorded'),0),
 'external_net_amount_cents',coalesce(sum(net) FILTER (WHERE status = 'externally_recorded'),0)) FROM net;
$$;

CREATE FUNCTION public.billing_landing_aggregates(p_studio_id uuid, p_period_start timestamptz, p_period_end timestamptz)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
SELECT jsonb_build_object(
 'active_student_count',(SELECT count(*) FROM public.students WHERE studio_id=p_studio_id AND status='active'),
 'active_subscription_count',(SELECT count(*) FROM public.billing_subscriptions WHERE studio_id=p_studio_id AND status IN ('active','trialing')),
 'failed_payer_count',(SELECT count(*) FROM public.billing_payers WHERE studio_id=p_studio_id AND billing_status IN ('past_due','failed')),
 'open_invoice_amount_cents',(SELECT coalesce(sum(greatest(amount_remaining_cents,0)),0) FROM public.billing_invoices WHERE studio_id=p_studio_id AND status IN ('draft','open','partially_refunded','uncollectible')),
 'has_billing_plans',EXISTS(SELECT 1 FROM public.billing_plans WHERE studio_id=p_studio_id AND archived_at IS NULL),
 'has_family_accounts',EXISTS(SELECT 1 FROM public.billing_payers WHERE studio_id=p_studio_id),
 'has_student_billing',EXISTS(SELECT 1 FROM public.student_billing_enrollments WHERE studio_id=p_studio_id AND status NOT IN ('canceled','ended')),
 'has_collection_history',EXISTS(SELECT 1 FROM public.billing_invoices WHERE studio_id=p_studio_id) OR EXISTS(SELECT 1 FROM public.billing_payments WHERE studio_id=p_studio_id),
 'payment_cohort',public.billing_payment_cohort(p_studio_id,p_period_start,p_period_end));
$$;

CREATE FUNCTION public.billing_webhook_health(p_account_id text, p_expected_livemode boolean, p_stale_before timestamptz)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
WITH scopes AS (SELECT NULL::text AS account_id UNION ALL SELECT p_account_id WHERE p_account_id IS NOT NULL),
health AS (
 SELECT scopes.account_id, count(*) FILTER (WHERE e.processing_status='pending') AS pending_count,
 count(*) FILTER (WHERE e.processing_status='processing') AS processing_count,
 count(*) FILTER (WHERE e.processing_status='failed') AS failed_count,
 count(*) FILTER (WHERE e.processing_status='processing' AND (e.processing_started_at<=p_stale_before OR (e.processing_started_at IS NULL AND e.created_at<=p_stale_before))) AS stale_processing_count,
 count(*) FILTER (WHERE p_expected_livemode IS NOT NULL AND e.livemode<>p_expected_livemode) AS mode_mismatch_count
 FROM scopes LEFT JOIN public.stripe_events e ON e.stripe_account_id IS NOT DISTINCT FROM scopes.account_id GROUP BY scopes.account_id
)
SELECT jsonb_object_agg(coalesce(h.account_id,'platform'),to_jsonb(h)-'account_id' || jsonb_build_object(
 'stripe_account_id',h.account_id,'latest_processed_at',latest.processed_at,'latest_event_type',latest.type))
FROM health h LEFT JOIN LATERAL (
 SELECT e.processed_at,e.type FROM public.stripe_events e WHERE e.stripe_account_id IS NOT DISTINCT FROM h.account_id
 AND e.processing_status='processed' AND e.processed_at IS NOT NULL ORDER BY e.processed_at DESC,e.id DESC LIMIT 1
) latest ON true;
$$;
REVOKE ALL ON FUNCTION public.billing_payment_cohort(uuid,timestamptz,timestamptz), public.billing_landing_aggregates(uuid,timestamptz,timestamptz), public.billing_webhook_health(text,boolean,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.billing_payment_cohort(uuid,timestamptz,timestamptz), public.billing_landing_aggregates(uuid,timestamptz,timestamptz), public.billing_webhook_health(text,boolean,timestamptz) TO service_role;

-- V38 attests the new reads and retains the exact V37 adapter for rolling deploys.
DO $build_v19$
DECLARE definition text;
BEGIN
 SELECT pg_get_functiondef('public.koaryu_release_schema_preflight_v18()'::regprocedure) INTO definition;
 definition := replace(definition,'CREATE OR REPLACE FUNCTION public.koaryu_release_schema_preflight_v18()', 'CREATE OR REPLACE FUNCTION public.koaryu_release_schema_preflight_v19()');
 definition := replace(definition,'v_count <> 132 OR v_head <> ''20260902001000''', 'v_count <> 133 OR v_head <> ''20260905022339''');
 definition := replace(definition,'migration_history_v37','migration_history_v38');
 definition := replace(definition,'''20260831054918'',''20260902001000''', '''20260831054918'',''20260902001000'',''20260905022339''');
 definition := replace(definition,'''release-db-attestation-v37''::TEXT;', '''release-db-attestation-v38''::TEXT;');
 definition := replace(definition,'RETURN QUERY SELECT cardinality(v_failures) = 0,', $inject$
 IF EXISTS (
  SELECT 1 FROM (VALUES
  ('public.billing_payment_cohort(uuid,timestamptz,timestamptz)','5d6f683e3c56fe05db7e4101073d1a23792081192219cfa9eda4db8dcf734a1d'),
  ('public.billing_landing_aggregates(uuid,timestamptz,timestamptz)','8341aba1a37f078c6b1bc87e96b6e7d3257275f18c0772cab16619bcbce5d05a'),
  ('public.billing_webhook_health(text,boolean,timestamptz)','3bdcc77c7d768e5ede8750900c0b75ac98bdffbb14ada059c580185133a9fd52')
  ) expected(signature,body_hash)
  LEFT JOIN pg_catalog.pg_proc p ON p.oid=to_regprocedure(expected.signature)
  WHERE p.oid IS NULL OR p.prosecdef OR p.provolatile<>'s'
  OR p.proowner <> 'postgres'::regrole OR p.prorettype<>'jsonb'::regtype
  OR NOT ('search_path=""'=ANY(coalesce(p.proconfig,ARRAY[]::text[])))
  OR encode(extensions.digest(convert_to(p.prosrc,'UTF8'),'sha256'),'hex')<>expected.body_hash
  OR NOT has_function_privilege('service_role',p.oid,'EXECUTE')
  OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
            WHERE a.privilege_type='EXECUTE' AND a.grantee NOT IN ('postgres'::regrole,'service_role'::regrole))
 ) THEN v_failures:=array_append(v_failures,'billing_landing_reads_v38'); END IF;
 RETURN QUERY SELECT cardinality(v_failures) = 0,$inject$);
 EXECUTE definition;
END $build_v19$;
ALTER FUNCTION public.koaryu_release_schema_preflight_v19() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.koaryu_release_schema_preflight_v19() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.koaryu_release_schema_preflight_v19() TO service_role;

CREATE OR REPLACE FUNCTION public.koaryu_release_schema_preflight_v18()
RETURNS TABLE(ready boolean,migration_count integer,migration_head text,pending_versions text[],security_failures text[],manifest_version text)
LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path=pg_catalog AS $$
DECLARE v record;
BEGIN
 SELECT * INTO v FROM public.koaryu_release_schema_preflight_v19();
 IF v.ready AND v.migration_count=133 AND v.migration_head='20260905022339' THEN
  RETURN QUERY SELECT true,132,'20260902001000'::text,v.pending_versions[1:cardinality(v.pending_versions)-1],ARRAY[]::text[],'release-db-attestation-v37'::text;
  RETURN;
 END IF;
 RETURN QUERY SELECT false,v.migration_count,v.migration_head,v.pending_versions,v.security_failures,'release-db-attestation-v37'::text;
END $$;
ALTER FUNCTION public.koaryu_release_schema_preflight_v18() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.koaryu_release_schema_preflight_v18() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.koaryu_release_schema_preflight_v18() TO service_role;
