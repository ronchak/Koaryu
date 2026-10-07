#!/usr/bin/env python3
"""Prove retained V56 delivery and business facts survive complete V57 canonical/logical upgrade and execute final workflow contracts."""
import hashlib
import json
import os
from pathlib import Path
import signal
import sys

from local_postgres_verification import ACL_SQL, CONSTRAINT_SQL, PAIR_PATH, LocalPostgres, normalization_plan, require

MIGRATION = "20261005105341_automation_workflow_graph_v57.sql"
TABLES = ("auth.users", "public.studios", "public.staff_roles", "public.programs", "public.leads",
          "public.lead_activities", "public.lead_follow_up_operations", "public.students",
          "public.student_program_memberships", "public.guardians", "public.student_guardians", "public.audit_logs",
          "public.studio_subscriptions", "public.class_sessions", "public.attendance",
          "public.automation_rules", "public.automation_deliveries", "public.automation_suppressions",
          "private.automation_email_credentials")
SEED_SQL = """
BEGIN;
SET LOCAL TIME ZONE 'UTC';
DO $seed$
DECLARE actor UUID := gen_random_uuid(); studio UUID := gen_random_uuid(); lead UUID := gen_random_uuid();
    program UUID := gen_random_uuid(); adult UUID := gen_random_uuid(); minor UUID := gen_random_uuid();
    held UUID := gen_random_uuid(); guardian UUID := gen_random_uuid(); session_id UUID := gen_random_uuid();
    item JSONB; begun JSONB; attempts INTEGER:=0;
BEGIN
    INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES(actor,'authenticated','authenticated',actor||'@example.invalid','{}','{}',now(),now());
    INSERT INTO public.studios(id,name,slug,owner_id) VALUES(studio,'Converted lead restore',studio::TEXT,actor);
    INSERT INTO public.staff_roles(studio_id,user_id,role) VALUES(studio,actor,'admin');
    INSERT INTO public.programs(id,studio_id,name) VALUES(program,studio,'Retained program');
    INSERT INTO public.leads(id,studio_id,first_name,last_name,source,stage,program_id,is_minor,guardian_name)
    VALUES(lead,studio,'Converted','Lead','walk_in','offer_sent',program,TRUE,'Retained Guardian');
    PERFORM public.follow_up_lead_atomic(studio,actor,lead,gen_random_uuid(),'{"next_stage":"enrolled"}');
    PERFORM public.update_lead_atomic(studio,actor,lead,'{"stage":"offer_sent","follow_up_date":"2030-01-01"}');
    INSERT INTO public.studio_subscriptions(studio_id,status,comped) VALUES(studio,'active',true);
    UPDATE public.studios SET timezone='UTC' WHERE id=studio;
    INSERT INTO public.students(id,studio_id,legal_first_name,legal_last_name,email,is_minor,hold_start_date,hold_end_date)
    VALUES(adult,studio,'RestoreAdult','Fixture','adult.restore@example.invalid',false,NULL,NULL),
          (minor,studio,'RestoreMinor','Fixture','minor.restore@example.invalid',true,NULL,NULL),
          (held,studio,'RestoreHeld','Fixture','held.restore@example.invalid',false,CURRENT_DATE-1,CURRENT_DATE+1);
    INSERT INTO public.guardians(id,studio_id,first_name,last_name,email,is_primary_contact)
    VALUES(guardian,studio,'Restore','Guardian','guardian.restore@example.invalid',true);
    INSERT INTO public.student_guardians(student_id,guardian_id) VALUES(minor,guardian);
    INSERT INTO public.class_sessions(id,studio_id,name,date,start_time,end_time)
    VALUES(session_id,studio,'Restore retained class',CURRENT_DATE-20,'00:00','01:00');
    INSERT INTO public.attendance(studio_id,session_id,student_id,status,checked_in_at)
    SELECT studio,session_id,id,'present',now()-INTERVAL '20 days' FROM public.students WHERE id IN (adult,minor,held);
    PERFORM public.save_missed_class_automation_rule_v1(studio,actor,0,true,14,'Retained V56 subject','Retained V56 body','reply.restore@example.invalid');
    PERFORM public.enqueue_missed_class_automations_v1(10);
    FOR item IN SELECT value FROM jsonb_array_elements(public.claim_missed_class_automations_v1(2)->'items') LOOP
        begun:=public.begin_missed_class_automation_v1((item->>'id')::UUID,(item->>'claim_token')::UUID);
        IF begun->>'ready' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'V56 fixture did not begin'; END IF;
        attempts:=attempts+1;
        PERFORM public.settle_missed_class_automation_v1((item->>'id')::UUID,(item->>'claim_token')::UUID,
            CASE WHEN attempts=1 THEN 'accepted' ELSE 'unknown' END);
    END LOOP;
    IF attempts<>2 THEN RAISE EXCEPTION 'V56 fixture did not retain two attempted deliveries'; END IF;
    PERFORM public.save_automation_email_credential_v1('microsoft_graph:primary',0,'opaque-retained-v56-ciphertext');
END;
$seed$;
SELECT 'seeded';
COMMIT;
"""


def main(arguments):
    require(len(arguments) == 8, "Expected pg_dump pg_restore createdb psql socket port temporary root")
    pg_dump, pg_restore, createdb, psql, socket, port, temporary_arg, root_arg = arguments
    root, temporary = Path(root_arg).resolve(), Path(temporary_arg)
    local = LocalPostgres(psql, socket, port, temporary)
    versions = local.require_pg17(pg_dump, pg_restore, createdb, psql)
    source_hash = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    shared = Path(__file__).with_name("local_postgres_verification.py")
    shared_hash = hashlib.sha256(shared.read_bytes()).hexdigest()
    names = [
        "V56_OPERATIONAL_READINESS_SQL", "EXPECTED_V56_OPERATIONAL_READINESS",
        "V56_CATALOG_STATE_SQL", "EXPECTED_V56_CATALOG_STATE", "EXPECTED_V56_RESTORED_CATALOG_STATE",
        "V57_OPERATIONAL_READINESS_SQL", "EXPECTED_V57_OPERATIONAL_READINESS",
        "V57_CATALOG_STATE_SQL", "EXPECTED_V57_CATALOG_STATE", "EXPECTED_V57_RESTORED_CATALOG_STATE",
        "V57_AUTOMATION_TABLE_STATE_SQL", "EXPECTED_V57_AUTOMATION_TABLE_STATE",
        "V57_AUTOMATION_FUNCTION_STATE_SQL", "EXPECTED_V57_AUTOMATION_FUNCTION_STATE",
    ]
    module = (root / "scripts/studio-comp-migration-rollout.mjs").as_uri()
    pinned = json.loads(local.run(["node", "--input-type=module", "--eval",
        f"import * as m from {json.dumps(module)}; console.log(JSON.stringify(Object.fromEntries("
        f"{json.dumps(names)}.map(k=>[k,m[k]]))));"]))
    require(set(pinned) == set(names) and all(isinstance(v, str) and v for v in pinned.values()),
            "Incomplete version-bound restore expectations")

    def check(database, query, expected):
        value = local.sql(database, pinned[query])
        require(value == pinned[expected], f"{database}: {query} did not match {expected}")
        return value

    def snapshot(database):
        fields = []
        for table in TABLES:
            value = "to_jsonb(t)"
            fields.append(f"'{table}',(SELECT COALESCE(jsonb_agg({value} ORDER BY to_jsonb(t)->>'id',"
                          f"to_jsonb(t)::TEXT COLLATE \"C\"),'[]'::JSONB) FROM {table} t)")
        return json.loads(local.sql(database, "SET TIME ZONE 'UTC'; SELECT jsonb_build_object(" + ",".join(fields) + ");"))

    def predecessor(database, restored=False):
        check(database, "V56_OPERATIONAL_READINESS_SQL", "EXPECTED_V56_OPERATIONAL_READINESS")
        check(database, "V56_CATALOG_STATE_SQL", "EXPECTED_V56_RESTORED_CATALOG_STATE" if restored else "EXPECTED_V56_CATALOG_STATE")
        require(local.sql(database, "SELECT count(*)=151 AND max(version)='20261004220435' FROM supabase_migrations.schema_migrations;") == "t",
                "Restore requires the actual V56 history")
        require(local.sql(database, "SELECT to_regprocedure('public.koaryu_release_schema_preflight_v38()') IS NULL;") == "t",
                "Restore predecessor already contains V57 functions")

    predecessor("postgres")
    hashes = {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
              for p in sorted((root / "supabase/migrations").glob("*.sql"))}
    require(len(hashes) == 152 and list(hashes)[-2:] == [
        "20261004220435_missed_class_automation_v56.sql", MIGRATION], "Unexpected migration inventory")
    migration = root / "supabase/migrations" / MIGRATION
    mapping_bytes = PAIR_PATH.read_bytes()
    pairs = json.loads(mapping_bytes)
    source = f"koaryu_v57_source_{os.getpid()}"
    restored = f"koaryu_v57_restore_{os.getpid()}"
    canonical = f"koaryu_v57_canonical_{os.getpid()}"
    dump = temporary / f"v56-before-v57-{os.getpid()}.dump"
    owned, outcomes = [], {}
    try:
        for database, template in [(source, "postgres"), (restored, "template0")]:
            local.run([createdb, *local.connection, "--owner=postgres", f"--template={template}", database])
            owned.append(database)
            local.sql(database, f'ALTER DATABASE {database} SET search_path TO "$user",public,extensions;')
        seed = local.sql(source, SEED_SQL)
        before = snapshot(source)
        require(seed == "seeded" and len(before["public.automation_deliveries"]) == 2,
                "V56 retained delivery fixture incomplete")
        require({row["state"] for row in before["public.automation_deliveries"]} == {"accepted", "unknown"},
                "V56 fixture must retain original accepted and uncertain delivery truth")
        require(len(before["private.automation_email_credentials"]) == 1,
                "V56 encrypted credential revision fixture absent")
        predecessor(source)
        constraints, acls = json.loads(local.sql(source, CONSTRAINT_SQL)), json.loads(local.sql(source, ACL_SQL))
        local.run([pg_dump, *local.connection, f"--dbname={source}", "--format=custom", f"--file={dump}"])
        dump_hash = hashlib.sha256(dump.read_bytes()).hexdigest()
        local.run([pg_restore, *local.connection, f"--dbname={restored}", "--exit-on-error", str(dump)])
        statements, expected_constraints = normalization_plan(
            constraints, json.loads(local.sql(restored, CONSTRAINT_SQL)),
            acls, json.loads(local.sql(restored, ACL_SQL)), pairs,
        )
        local.sql(restored, "BEGIN;\n" + "\n".join(statements) + "\nCOMMIT;")
        require(json.loads(local.sql(restored, CONSTRAINT_SQL)) == expected_constraints, "Unexpected restored CHECK state")
        require(json.loads(local.sql(restored, ACL_SQL)) == acls, "Unexpected restored ACL state")
        require(snapshot(restored) == before, "Logical restore changed retained business rows")
        require(hashlib.sha256(dump.read_bytes()).hexdigest() == dump_hash, "Backup changed during restore")
        predecessor(restored, restored=True)
        local.run([createdb, *local.connection, "--owner=postgres", f"--template={source}", canonical])
        owned.append(canonical)
        for database, is_restored in [(canonical, False), (restored, True)]:
            predecessor(database, is_restored)
            require(snapshot(database) == before, "Predecessor rows changed before upgrade")
            require(hashlib.sha256(migration.read_bytes()).hexdigest() == hashes[MIGRATION], "Migration changed before execution")
            version, name = MIGRATION[:-4].split("_", 1)
            local.run([psql, *local.connection, f"--dbname={database}", "--no-psqlrc", "--set=ON_ERROR_STOP=1", "--quiet",
                       "--single-transaction", f"--file={migration}",
                       f"--command=INSERT INTO supabase_migrations.schema_migrations(version,name) VALUES('{version}','{name}');"])
            require(snapshot(database) == before, "Migration changed retained rows before continuation")
            checks = [
                ("V57_OPERATIONAL_READINESS_SQL", "EXPECTED_V57_OPERATIONAL_READINESS"),
                ("V57_CATALOG_STATE_SQL", "EXPECTED_V57_RESTORED_CATALOG_STATE" if is_restored else "EXPECTED_V57_CATALOG_STATE"),
                ("V57_AUTOMATION_FUNCTION_STATE_SQL", "EXPECTED_V57_AUTOMATION_FUNCTION_STATE"),
            ]
            values = {query: check(database, query, expected) for query, expected in checks}
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
            require({query: check(database, query, expected) for query, expected in checks} == values,
                    "Continuation changed the attested state")
            outcomes["restored" if is_restored else "canonical"] = values
        predecessor("postgres")
        predecessor(source)
        require(snapshot(source) == before, "Restore proof edited its source rows")
        require(all(hashlib.sha256((root / "supabase/migrations" / name).read_bytes()).hexdigest() == digest
                    for name, digest in hashes.items()), "Migration inputs changed during verification")
        require(hashlib.sha256(Path(__file__).read_bytes()).hexdigest() == source_hash
                and hashlib.sha256(shared.read_bytes()).hexdigest() == shared_hash,
                "Restore helper inputs changed during verification")
        evidence = {
            "migrations": hashes, "dump_sha256": dump_hash, "helper_sha256": source_hash,
            "local_tools_sha256": shared_hash, "mapping_sha256": hashlib.sha256(mapping_bytes).hexdigest(),
            "tools": versions, "queries": pinned, "outcomes": outcomes,
            "business_before_sha256": hashlib.sha256(json.dumps(before, sort_keys=True).encode()).hexdigest(),
            "constraint_pairs": len(pairs), "billing_replays": 6, "acl_representations": len(statements) - 6,
        }
        (temporary / "v56-v57-restore-evidence.json").write_text(json.dumps(evidence, indent=2) + "\n")
        print("[restored V57] PASS retained V56 business and delivery truth, complete guarded schema and actual final workflow continuation on canonical/restored copies", flush=True)
    finally:
        errors = []
        for database in reversed(owned):
            try:
                local.sql("postgres", f"DROP DATABASE {database} WITH (FORCE);")
            except Exception as error:
                errors.append(str(error))
        if errors:
            raise RuntimeError("Owned restore database cleanup failed: " + "; ".join(errors))
        dump.unlink(missing_ok=True)


if __name__ == "__main__":
    def interrupted(signum, _frame):
        raise SystemExit(128 + signum)
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    main(sys.argv[1:])
