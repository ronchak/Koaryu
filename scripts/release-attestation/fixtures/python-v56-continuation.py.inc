            contract = root / "supabase/verification/missed_class_automation_contract.sql"
            require(local.run(["git", "-C", str(root), "rev-parse", "--is-shallow-repository"]) == "false",
                    "Historical V56 contract requires full Git history")
            local.run(["git", "-C", str(root), "merge-base", "--is-ancestor", CONTRACT_BASE, "HEAD"])
            # This immutable V56 input predates the final shared V57 assertions.
            # Preserve the original bytes and reviewed hash rather than repinning history.
            contract_bytes = subprocess.check_output(
                ["git", "-C", str(root), "show", CONTRACT_BASE + ":supabase/verification/missed_class_automation_contract.sql"],
                env=local.env,
            )
            require(hashlib.sha256(contract_bytes).hexdigest() == CONTRACT_SHA256,
                    "Automation business contract differs from its reviewed restore input")
            local.sql(database, contract_bytes.decode())
            require(snapshot(database) == before, "Automation contract changed retained V55 rows")
            proof = local.sql(database, """
BEGIN;
SET LOCAL ROLE service_role;
DO $proof$
DECLARE studio UUID; actor UUID; j JSONB; k JSONB; claims JSONB; item JSONB;
    first_token TEXT; first_recipient TEXT; count_attempts INTEGER:=0; conflict BOOLEAN;
BEGIN
    SELECT id,owner_id INTO studio,actor FROM public.studios WHERE name='Converted lead restore';
    IF public.get_missed_class_automation_rule_v1(studio,actor) IS DISTINCT FROM '{"rule":null}'::JSONB
       OR EXISTS(SELECT 1 FROM public.automation_rules) THEN RAISE EXCEPTION 'Restore missing-rule read wrote state'; END IF;
    j:=public.save_missed_class_automation_rule_v1(studio,actor,0,true,14,'Restore subject','Restore body','reply.restore@example.invalid');
    IF j->'rule'->>'revision' IS DISTINCT FROM '1' THEN RAISE EXCEPTION 'Restore rule revision1 missing'; END IF;
    conflict:=false;
    BEGIN PERFORM public.save_missed_class_automation_rule_v1(studio,actor,0,true,14,'Stale','Stale','reply.restore@example.invalid');
    EXCEPTION WHEN SQLSTATE 'P0001' THEN IF SQLERRM<>'AUTOMATION_RULE_CONFLICT' THEN RAISE; END IF; conflict:=true; END;
    IF NOT conflict THEN RAISE EXCEPTION 'Restore stale rule CAS succeeded'; END IF;
    j:=public.save_missed_class_automation_rule_v1(studio,actor,1,true,14,'Restore subject2','Restore body2','reply.restore@example.invalid');
    IF j->'rule'->>'revision' IS DISTINCT FROM '2' THEN RAISE EXCEPTION 'Restore rule revision did not continue'; END IF;
    j:=public.preview_missed_class_automation_v1(studio,actor,14);
    IF (j->>'eligible_count')::INTEGER<>2 OR NOT EXISTS(
        SELECT 1 FROM jsonb_array_elements(j->'recipients') r WHERE r->>'recipient_kind'='guardian' AND r->>'recipient_email'='guardian.restore@example.invalid' AND r->>'skip_reason' IS NULL)
       OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(j->'recipients') r WHERE r->>'skip_reason'='on_hold') THEN
        RAISE EXCEPTION 'Restore guardian routing or effective hold changed'; END IF;
    j:=public.enqueue_missed_class_automations_v1(10);
    IF (j->>'enqueued')::INTEGER<>2 THEN RAISE EXCEPTION 'Restore enqueue count changed'; END IF;
    claims:=public.claim_missed_class_automations_v1(2);
    IF jsonb_array_length(claims->'items')<>2 THEN RAISE EXCEPTION 'Restore claim count changed'; END IF;
    FOR item IN SELECT * FROM jsonb_array_elements(claims->'items') LOOP
        j:=public.begin_missed_class_automation_v1((item->>'id')::UUID,(item->>'claim_token')::UUID);
        IF j->>'ready' IS DISTINCT FROM 'true' OR j->>'state' IS DISTINCT FROM 'sending' THEN RAISE EXCEPTION 'Restore begin did not commit sending'; END IF;
        count_attempts:=count_attempts+1;
        IF count_attempts=1 THEN first_token:=j->'message'->>'unsubscribe_token'; first_recipient:=j->'message'->>'recipient_email'; END IF;
        k:=public.settle_missed_class_automation_v1((item->>'id')::UUID,(item->>'claim_token')::UUID,
            CASE WHEN count_attempts=1 THEN 'accepted' ELSE 'unknown' END);
        IF k->>'updated' IS DISTINCT FROM 'true' OR k->>'state' IS DISTINCT FROM (CASE WHEN count_attempts=1 THEN 'accepted' ELSE 'unknown' END) THEN
            RAISE EXCEPTION 'Restore accepted or unknown settlement changed'; END IF;
    END LOOP;
    IF (public.enqueue_missed_class_automations_v1(10)->>'enqueued')::INTEGER<>0 THEN RAISE EXCEPTION 'Restore reopened attempted episode'; END IF;
    PERFORM public.suppress_missed_class_automation_v1(first_token);
    IF NOT EXISTS(SELECT 1 FROM public.automation_suppressions s WHERE s.studio_id=studio AND s.recipient_email=first_recipient) THEN
        RAISE EXCEPTION 'Restore original recipient suppression was not retained'; END IF;
    j:=public.get_automation_email_credential_v1('microsoft_graph:primary');
    IF j->>'revision' IS DISTINCT FROM '0' OR j->>'encrypted_credentials' IS NOT NULL THEN RAISE EXCEPTION 'Restore credential absence mismatch'; END IF;
    j:=public.save_automation_email_credential_v1('microsoft_graph:primary',0,'opaque-ciphertext-fixture-v1');
    k:=public.save_automation_email_credential_v1('microsoft_graph:primary',1,'opaque-ciphertext-fixture-v2');
    IF j->>'revision' IS DISTINCT FROM '1' OR k->>'revision' IS DISTINCT FROM '2' THEN RAISE EXCEPTION 'Restore encrypted credential revision did not continue'; END IF;
    conflict:=false;
    BEGIN PERFORM public.save_automation_email_credential_v1('microsoft_graph:primary',1,'stale-opaque-ciphertext-fixture');
    EXCEPTION WHEN SQLSTATE 'P0001' THEN IF SQLERRM<>'AUTOMATION_EMAIL_CREDENTIAL_CONFLICT' THEN RAISE; END IF; conflict:=true; END;
    IF NOT conflict OR public.get_automation_email_credential_v1('microsoft_graph:primary') IS DISTINCT FROM k THEN
        RAISE EXCEPTION 'Restore credential CAS overwrote newer ciphertext'; END IF;
END;
$proof$;
ROLLBACK;
SELECT 'continued';
""")
            require(proof.splitlines()[-1] == "continued", "Automation restore continuation failed")
            require(snapshot(database) == before, "Automation continuation changed retained V55 rows")
            outcomes[("restored_" if is_restored else "canonical_") + "automation"] = {
                "rule_revision": 2, "eligible": 2, "accepted": 1, "unknown": 1,
                "suppressed": 1, "credential_revision": 2, "contract_sha256": CONTRACT_SHA256,
            }
