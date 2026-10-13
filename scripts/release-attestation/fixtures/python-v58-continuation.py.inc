            require(local.sql(database, "SELECT expected_sha256 FROM private.koaryu_release_v31_expectations WHERE expectation_key='operational_contract_v31';")
                    == "af3435a9266c9b482f7933dfc6ff5a756ec71fcf9eb7f3cba481e816226e50cb",
                    "V58 did not install the exact declared attestation singleton")
            continued = local.sql(database, """
BEGIN;
DO $legacy$
DECLARE s UUID; ready_studio UUID; b public.stripe_connect_onboarding_bootstraps; result RECORD;
BEGIN
    SELECT id INTO ready_studio FROM public.studios WHERE name='Schema V3 Live Billing Contract';
    SELECT id INTO s FROM public.studios WHERE name='Schema V3 Accountless Connect';
    IF EXISTS(SELECT 1 FROM public.studio_live_billing_authorizations WHERE expires_at>now())
       OR EXISTS(SELECT 1 FROM public.stripe_live_billing_reconciliation_checkpoints WHERE expires_at>now()) THEN
        RAISE EXCEPTION 'Legacy fixture must contain only expired authority';
    END IF;
    PERFORM public.authorize_studio_live_billing_mutation_atomic(ready_studio,'connected_invoice.pay','connect_payments','acct_ContractReadyV3',repeat('e',40));
    IF NOT FOUND THEN RAISE EXCEPTION 'Expired pilot history blocked GA payments'; END IF;
    SELECT * INTO b FROM public.stripe_connect_onboarding_bootstraps WHERE studio_id=s;
    SELECT * INTO result FROM public.preflight_connect_onboarding_bootstrap_resume(s,repeat('a',40));
    IF result.eligible IS DISTINCT FROM false OR result.phase IS DISTINCT FROM 'support_required' THEN
        RAISE EXCEPTION 'Legacy incomplete request silently converted to GA'; END IF;
    PERFORM public.load_connect_onboarding_bootstrap_recovery_context(s,repeat('a',40));
    IF FOUND THEN RAISE EXCEPTION 'Legacy recovery context reopened'; END IF;
    PERFORM public.prepare_connect_onboarding_bootstrap_atomic(s,repeat('a',40),1,b.recovery_context,b.account_create_payload_sha256,b.initial_link_context_sha256,b.account_create_idempotency_key,b.initial_link_idempotency_key);
    IF FOUND THEN RAISE EXCEPTION 'Legacy request prepared under GA'; END IF;
    PERFORM public.authorize_connect_onboarding_bootstrap_account_create_v2(b.id,s,repeat('a',40),1,b.account_create_payload_sha256,b.account_create_idempotency_key);
    IF FOUND THEN RAISE EXCEPTION 'Legacy request authorized account creation'; END IF;
    BEGIN
        PERFORM public.bind_connect_onboarding_bootstrap_account_v2(b.id,s,repeat('a',40),1,'acct_LegacyUnexpected','company');
        RAISE EXCEPTION 'Legacy account binding accepted';
    EXCEPTION WHEN SQLSTATE 'P0B21' THEN NULL;
    END;
END;
$legacy$;
ROLLBACK;
SELECT 'continued';
""")
            require(continued == "continued" and snapshot(database) == before,
                    "V58 legacy recovery barriers or retained pilot audit history changed")
            result = local.sql(database, (root / "supabase/verification/live_billing_ga_contract.sql").read_text())
            require(snapshot(database) == before, "GA continuation changed retained source rows")
            outcomes[("restored_" if is_restored else "canonical_") + "ga_continuation"] = result
