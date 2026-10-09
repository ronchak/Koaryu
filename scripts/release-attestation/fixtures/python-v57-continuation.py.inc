            require(local.sql(database, HOSTED_LEGACY_GRANTS_SQL) == "0",
                    "V57 must converge hosted legacy trigger-function grants to the canonical ACL")
            for timezone, datestyle, intervalstyle in (("UTC", "ISO, YMD", "postgres"),
                                                      ("America/Los_Angeles", "SQL, DMY", "sql_standard")):
                guc_rows = local.sql(database, "BEGIN; SET LOCAL TimeZone='" + timezone + "'; SET LOCAL DateStyle='" + datestyle + "'; SET LOCAL IntervalStyle='" + intervalstyle + "'; "
                    "SELECT jsonb_build_array(current_setting('TimeZone'),current_setting('DateStyle'),current_setting('IntervalStyle')); "
                    "SELECT row_to_json(r) FROM public.koaryu_release_schema_preflight_v38() r; "
                    "SELECT jsonb_build_array(current_setting('TimeZone'),current_setting('DateStyle'),current_setting('IntervalStyle')); ROLLBACK;").splitlines()
                guc_before, guc_guard, guc_after = map(json.loads, guc_rows)
                require(guc_before == guc_after == [timezone, datestyle, intervalstyle]
                        and guc_guard["ready"] is True and guc_guard["security_failures"] == []
                        and guc_guard["migration_count"] == 152 and guc_guard["migration_head"] == "20261005105341",
                        "Final catalog attestation depends on or leaks caller deparse settings")
            for filename in ("workflow_management_contract.sql", "workflow_graph_mail_contract.sql",
                             "automation_test_email_contract.sql", "automation_clear_contract.sql"):
                contract = root / "supabase/verification" / filename
                result = local.sql(database, contract.read_text())
                require(snapshot(database) == before,
                        "Final workflow contract changed retained V56 delivery or business truth: " + filename)
                outcomes[("restored_" if is_restored else "canonical_") + filename] = {
                    "sha256": hashlib.sha256(contract.read_bytes()).hexdigest(), "output": result,
                }
            continued = local.sql(database, """
BEGIN;
SET LOCAL ROLE service_role;
DO $proof$
DECLARE delivery public.automation_deliveries; j JSONB; actor UUID; studio UUID;
BEGIN
    SELECT id,owner_id INTO studio,actor FROM public.studios WHERE name='Converted lead restore';
    IF (public.get_missed_class_automation_rule_v1(studio,actor)->'rule'->>'revision')::BIGINT<>1 THEN
        RAISE EXCEPTION 'Retained rule revision changed'; END IF;
    FOR delivery IN SELECT * FROM public.automation_deliveries WHERE studio_id=studio LOOP
        PERFORM public.suppress_missed_class_automation_v1(delivery.unsubscribe_token);
        IF NOT EXISTS(SELECT 1 FROM public.automation_suppressions s
            WHERE s.studio_id=studio AND s.recipient_email=delivery.recipient_email) THEN
            RAISE EXCEPTION 'V57 lost original recipient/token binding'; END IF;
    END LOOP;
    IF (public.enqueue_missed_class_automations_v1(10)->>'enqueued')::INTEGER<>0 THEN
        RAISE EXCEPTION 'V57 reopened accepted or uncertain legacy delivery'; END IF;
    j:=public.save_automation_email_credential_v1('microsoft_graph:primary',1,'opaque-continuation-v57-ciphertext');
    IF j->>'revision' IS DISTINCT FROM '2' THEN RAISE EXCEPTION 'Credential CAS continuation failed'; END IF;
END;
$proof$;
ROLLBACK;
SELECT 'continued';
""")
            require(continued == "continued" and snapshot(database) == before,
                    "V57 original-recipient suppression, durable terminal truth or credential continuation failed")
            if not is_restored:
                # Seed real final publication, source capture, run/step and
                # follow-up receipt before backing up the installed V57 data.
                fixture_bytes = (root / "supabase/verification/workflow_advance_contract.sql").read_text()
                fixture_sql = fixture_bytes.split('-- fixture owners start.')[1].split('-- fixture owners end.')[0]
                local.sql(database, "CREATE SCHEMA v57_restore_proof;\n" + "--" + fixture_sql.replace("pg_temp.", "v57_restore_proof."))
                graph = json.loads(local.sql(database, """
BEGIN;
SELECT v57_restore_proof.advance_seed(v57_restore_proof.advance_fixture(),'lead.created',
    v57_restore_proof.advance_path('lead.created','lead_follow_up')) AS fixture \gset
SELECT v57_restore_proof.advance_claim(:'fixture') AS fixture \gset
SELECT v57_restore_proof.advance_call(:'fixture',10);
COMMIT;
SELECT :'fixture';
""").splitlines()[-1])
                require(local.sql(database, "SELECT count(*) FROM private.automation_workflow_follow_up_actions WHERE run_id='" + graph["run"] + "';") == "1",
                        "Post-V57 restore must retain one actual committed follow-up receipt")
                tables = json.loads(local.sql(database, "SELECT jsonb_agg(n.nspname||'.'||c.relname ORDER BY n.nspname,c.relname) "
                    "FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='r' "
                    "AND n.nspname IN ('public','private','auth');"))
                def all_rows(db):
                    fields = ["SELECT '" + table + "' AS name,(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::TEXT COLLATE \"C\"),'[]') FROM " + table + " t) AS rows" for table in tables]
                    return json.loads(local.sql(db, "SET TIME ZONE 'UTC'; SELECT jsonb_object_agg(name,rows) FROM (" + " UNION ALL ".join(fields) + ") all_tables;"))
                check(database, "V57_OPERATIONAL_READINESS_SQL", "EXPECTED_V57_OPERATIONAL_READINESS")
                post_before = all_rows(database)
                source_constraints = json.loads(local.sql(database, CONSTRAINT_SQL))
                source_acls = json.loads(local.sql(database, ACL_SQL))
                post_dump = temporary / f"v57-installed-{os.getpid()}.dump"
                require(not os.path.lexists(post_dump), "Foreign final V57 dump refused")
                local.run([pg_dump, *local.connection, f"--dbname={database}", "--format=custom", f"--file={post_dump}"])
                post_hash = hashlib.sha256(post_dump.read_bytes()).hexdigest()
                post_restored = f"koaryu_v57_post_restore_{os.getpid()}"
                local.run([createdb, *local.connection, "--owner=postgres", "--template=template0", post_restored])
                owned.append(post_restored)
                local.run([pg_restore, *local.connection, f"--dbname={post_restored}", "--exit-on-error", str(post_dump)])
                final_pairs_path = root / "scripts/v57-restore-constraint-pairs.json"
                final_pairs_bytes = final_pairs_path.read_bytes()
                final_pairs = json.loads(final_pairs_bytes)
                active_pairs = {identity: pair for identity, pair in final_pairs.items()
                                if source_constraints[identity]["hash"] == pair["source_hash"]}
                repairs, post_constraints = normalization_plan(source_constraints,
                    json.loads(local.sql(post_restored, CONSTRAINT_SQL)), source_acls,
                    json.loads(local.sql(post_restored, ACL_SQL)), active_pairs)
                local.sql(post_restored, "BEGIN;\n" + "\n".join(repairs) + "\nCOMMIT;")
                require(json.loads(local.sql(post_restored, CONSTRAINT_SQL)) == post_constraints
                        and json.loads(local.sql(post_restored, ACL_SQL)) == source_acls,
                        "Post-V57 restore changed an unapproved CHECK or ACL")
                require(all_rows(post_restored) == post_before, "Post-V57 logical restore changed durable data")
                check(post_restored, "V57_OPERATIONAL_READINESS_SQL", "EXPECTED_V57_OPERATIONAL_READINESS")
                check(post_restored, "V57_CATALOG_STATE_SQL", "EXPECTED_V57_RESTORED_CATALOG_STATE")
                check(post_restored, "V57_AUTOMATION_FUNCTION_STATE_SQL", "EXPECTED_V57_AUTOMATION_FUNCTION_STATE")
                readback = json.loads(local.sql(post_restored,
                    "SELECT public.get_automation_workflow_run_v1('" + graph["studio"] + "','" + graph["actor"] + "','" + graph["run"] + "');"))
                require(readback["payload"]["run"]["state"] == "completed"
                        and all_rows(post_restored) == post_before,
                        "Restored original run/receipt continuation changed truth or resent an effect")
                require(final_pairs_path.read_bytes() == final_pairs_bytes
                        and hashlib.sha256(post_dump.read_bytes()).hexdigest() == post_hash,
                        "Final restore evidence changed during proof")
                outcomes["post_v57_restore"] = {"dump_sha256": post_hash,
                    "normalization_sha256": hashlib.sha256(final_pairs_bytes).hexdigest(),
                    "retained_tables": len(tables), "actual_follow_up_receipts": 1,
                    "complete_readiness": True}
                post_dump.unlink()
