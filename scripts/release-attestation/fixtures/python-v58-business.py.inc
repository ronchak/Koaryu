# Reuse the retained diagnostic-writer fixture, excluding its current-schema
# attestation block. The historical scope RPC remains unchanged in V58.
_pilot_contract = (Path(__file__).resolve().parents[1] / "supabase/verification/studio_live_billing_authorizations_contract.sql").read_text()
SEED_SQL = "BEGIN;\n" + _pilot_contract[_pilot_contract.index("DO $contract$"):].replace("ROLLBACK;", "COMMIT;") + r"""
DO $legacy$
DECLARE s UUID; b UUID;
BEGIN
    SELECT id INTO s FROM public.studios WHERE name='Schema V3 Accountless Connect';
    SELECT bootstrap_id INTO b FROM public.prepare_connect_onboarding_bootstrap_atomic(
        s,repeat('a',40),1,
        '{"business_name":"Legacy incomplete","contact_email":null,"business_entity_type":"company","refresh_url":"https://example.invalid/refresh","return_url":"https://example.invalid/return"}',
        repeat('c',64),repeat('b',64),'koaryu-connect-account-'||s||'-g1','koaryu-connect-onboarding-'||s||'-g1-'||repeat('b',24));
    IF b IS NULL THEN RAISE EXCEPTION 'Legacy source fixture failed'; END IF;
END;
$legacy$;
-- Expire retained pilot evidence without pretending to renew or delete it.
ALTER TABLE public.studio_live_billing_authorizations DISABLE TRIGGER bind_live_billing_authorization_checkpoint;
UPDATE public.studio_live_billing_authorizations SET granted_at=now()-INTERVAL '2 days',expires_at=now()-INTERVAL '1 day';
ALTER TABLE public.studio_live_billing_authorizations ENABLE TRIGGER bind_live_billing_authorization_checkpoint;
UPDATE public.stripe_live_billing_reconciliation_checkpoints SET verified_at=now()-INTERVAL '2 days',expires_at=now()-INTERVAL '1 day';
UPDATE public.stripe_live_billing_reconciliation_checkpoints_v3 SET verified_at=now()-INTERVAL '2 days',expires_at=now()-INTERVAL '1 day';
SELECT 'seeded';
"""
