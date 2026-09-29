#!/usr/bin/env python3
"""Prove retained V51 lead rows survive logical restore and V52 atomic updates and keyed follow-up replay."""
import hashlib
import json
import os
from pathlib import Path
import signal
import sys

from local_postgres_verification import ACL_SQL, CONSTRAINT_SQL, PAIR_PATH, LocalPostgres, normalization_plan, require

MIGRATION = "20260926194918_lead_commands_v52.sql"
TABLES = ("auth.users", "public.studios", "public.staff_roles", "public.programs", "public.leads", "public.lead_activities")
SEED_SQL = """
BEGIN;
DO $seed$
DECLARE actor UUID := gen_random_uuid(); studio UUID := gen_random_uuid(); lead UUID := gen_random_uuid();
BEGIN
    INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES(actor,'authenticated','authenticated',actor||'@example.invalid','{}','{}',now(),now());
    INSERT INTO public.studios(id,name,slug,owner_id) VALUES(studio,'Lead restore',studio::TEXT,actor);
    INSERT INTO public.staff_roles(studio_id,user_id,role) VALUES(studio,actor,'admin');
    INSERT INTO public.leads(id,studio_id,first_name,last_name,source,stage,follow_up_date,notes)
    VALUES(lead,studio,'Lead','Restore','walk_in','inquiry',CURRENT_DATE,'Retained lead');
    INSERT INTO public.lead_activities(studio_id,lead_id,activity_type,description,created_by)
    VALUES(studio,lead,'note','Retained contact history',actor);
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
        "V51_OPERATIONAL_READINESS_SQL", "EXPECTED_V51_OPERATIONAL_READINESS",
        "V51_CATALOG_STATE_SQL", "EXPECTED_V51_CATALOG_STATE", "EXPECTED_V51_RESTORED_CATALOG_STATE",
        "V51_RELEASE_MANIFEST_SQL", "EXPECTED_V51_RELEASE_MANIFEST",
        "V31_EXPECTATION_STATE_SQL", "EXPECTED_V51_EXPECTATION_STATE",
        "V31_RESOURCE_OWNERSHIP_MANIFEST_SQL", "EXPECTED_V51_RESOURCE_OWNERSHIP_MANIFEST",
        "V31_OPERATIONAL_CONTRACT_SQL", "EXPECTED_V51_OPERATIONAL_CONTRACT",
        "V31_OPERATIONAL_MANIFEST_SQL", "EXPECTED_V51_OPERATIONAL_MANIFEST_V12",
        "V51_CLOSEOUT_STATE_SQL", "EXPECTED_V51_CLOSEOUT_STATE",
        "V52_OPERATIONAL_READINESS_SQL", "EXPECTED_V52_OPERATIONAL_READINESS",
        "V50_OPERATIONAL_READINESS_SQL", "EXPECTED_V50_OPERATIONAL_READINESS",
        "V49_OPERATIONAL_READINESS_SQL", "EXPECTED_V49_OPERATIONAL_READINESS",
        "V48_OPERATIONAL_READINESS_SQL", "EXPECTED_V48_OPERATIONAL_READINESS",
        "V47_OPERATIONAL_READINESS_SQL", "EXPECTED_V47_OPERATIONAL_READINESS",
        "V46_OPERATIONAL_READINESS_SQL", "EXPECTED_V46_OPERATIONAL_READINESS",
        "V45_OPERATIONAL_READINESS_SQL", "EXPECTED_V45_OPERATIONAL_READINESS",
        "V44_OPERATIONAL_READINESS_SQL", "EXPECTED_V44_OPERATIONAL_READINESS",
        "V43_OPERATIONAL_READINESS_SQL", "EXPECTED_V43_OPERATIONAL_READINESS",
        "V42_OPERATIONAL_READINESS_SQL", "EXPECTED_V42_OPERATIONAL_READINESS",
        "V41_OPERATIONAL_READINESS_SQL", "EXPECTED_V41_OPERATIONAL_READINESS",
        "V40_OPERATIONAL_READINESS_SQL", "EXPECTED_V40_OPERATIONAL_READINESS",
        "V39_OPERATIONAL_READINESS_SQL", "EXPECTED_V39_OPERATIONAL_READINESS",
        "V38_OPERATIONAL_READINESS_SQL", "EXPECTED_V38_OPERATIONAL_READINESS",
        "V37_OPERATIONAL_READINESS_SQL", "EXPECTED_V37_OPERATIONAL_READINESS",
        "V52_CATALOG_STATE_SQL", "EXPECTED_V52_CATALOG_STATE", "EXPECTED_V52_RESTORED_CATALOG_STATE",
        "V52_RELEASE_MANIFEST_SQL", "EXPECTED_V52_RELEASE_MANIFEST",
        "V31_EXPECTATION_STATE_SQL", "EXPECTED_V52_EXPECTATION_STATE",
        "V31_RESOURCE_OWNERSHIP_MANIFEST_SQL", "EXPECTED_V52_RESOURCE_OWNERSHIP_MANIFEST",
        "V31_OPERATIONAL_CONTRACT_SQL", "EXPECTED_V52_OPERATIONAL_CONTRACT",
        "V31_OPERATIONAL_MANIFEST_SQL", "EXPECTED_V52_OPERATIONAL_MANIFEST_V12",
        "V41_PAYER_BALANCE_STATE_SQL", "EXPECTED_V50_PAYER_BALANCE_STATE",
        "V50_COLLECTION_FACTS_STATE_SQL", "EXPECTED_V50_COLLECTION_FACTS_STATE",
        "V50_PAYER_READ_STATE_SQL", "EXPECTED_V50_PAYER_READ_STATE",
        "V50_LANDING_STATE_SQL", "EXPECTED_V50_LANDING_STATE",
        "V40_RANK_COMMAND_STATE_SQL", "EXPECTED_V40_RANK_COMMAND_STATE",
        "V43_EXTERNAL_PAYMENT_STATE_SQL", "EXPECTED_V43_EXTERNAL_PAYMENT_STATE",
        "V44_LOCAL_PLAN_STATE_SQL", "EXPECTED_V44_LOCAL_PLAN_STATE",
        "V44_CLEAR_STATE_SQL", "EXPECTED_V44_CLEAR_STATE",
        "V49_SUBSCRIPTION_TERMS_STATE_SQL", "EXPECTED_V49_SUBSCRIPTION_TERMS_STATE",
        "V50_INVOICE_FACTS_STATE_SQL", "EXPECTED_V50_INVOICE_FACTS_STATE",
        "V50_ATTENTION_STATE_SQL", "EXPECTED_V50_ATTENTION_STATE",
        "CRITICAL_SURFACE_MANIFEST_SQL", "EXPECTED_V52_CRITICAL_SURFACE_MANIFEST",
        "V29_OPERATIONAL_MANIFEST_SQL", "EXPECTED_V52_OPERATIONAL_MANIFEST_V10",
        "V30_OPERATIONAL_MANIFEST_SQL", "EXPECTED_V52_OPERATIONAL_MANIFEST_V11",
        "V30_OPERATIONAL_CONTRACT_SQL", "EXPECTED_V51_V30_OPERATIONAL_CONTRACT",
        "V30_REPLAY_REPAIRS_MANIFEST_SQL", "EXPECTED_V51_V30_REPLAY_REPAIRS_MANIFEST",
        "V52_LEAD_UPDATE_STATE_SQL", "EXPECTED_V52_LEAD_UPDATE_STATE",
        "V52_LEAD_FOLLOW_UP_STATE_SQL", "EXPECTED_V52_LEAD_FOLLOW_UP_STATE",
        "V52_LEAD_RECEIPT_STATE_SQL", "EXPECTED_V52_LEAD_RECEIPT_STATE",
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

    def semantics(database):
        return {signature: local.sql(database, f"SELECT {signature};") for signature in ["private.koaryu_release_critical_surface_manifest_v16()"]}

    def predecessor(database, restored=False):
        check(database, "V51_OPERATIONAL_READINESS_SQL", "EXPECTED_V51_OPERATIONAL_READINESS")
        check(database, "V51_CATALOG_STATE_SQL", "EXPECTED_V51_RESTORED_CATALOG_STATE" if restored else "EXPECTED_V51_CATALOG_STATE")
        check(database, "V51_RELEASE_MANIFEST_SQL", "EXPECTED_V51_RELEASE_MANIFEST")
        check(database, "V31_EXPECTATION_STATE_SQL", "EXPECTED_V51_EXPECTATION_STATE")
        check(database, "V31_RESOURCE_OWNERSHIP_MANIFEST_SQL", "EXPECTED_V51_RESOURCE_OWNERSHIP_MANIFEST")
        check(database, "V31_OPERATIONAL_CONTRACT_SQL", "EXPECTED_V51_OPERATIONAL_CONTRACT")
        check(database, "V31_OPERATIONAL_MANIFEST_SQL", "EXPECTED_V51_OPERATIONAL_MANIFEST_V12")
        check(database, "V51_CLOSEOUT_STATE_SQL", "EXPECTED_V51_CLOSEOUT_STATE")
        require(local.sql(database, "SELECT count(*)=146 AND max(version)='20260925030000' FROM supabase_migrations.schema_migrations;") == "t",
                "Restore requires the actual V51 history")
        require(local.sql(database, "SELECT to_regprocedure('public.koaryu_release_schema_preflight_v33()') IS NULL AND to_regprocedure('public.update_lead_atomic(uuid,uuid,uuid,jsonb)') IS NULL AND to_regprocedure('public.follow_up_lead_atomic(uuid,uuid,uuid,uuid,jsonb)') IS NULL;") == "t",
                "Restore predecessor already contains V52 functions")

    predecessor("postgres")
    hashes = {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
              for p in sorted((root / "supabase/migrations").glob("*.sql"))}
    require(len(hashes) == 148 and list(hashes)[-3:] == [
        "20260925030000_invoice_closeout_lock_order_v51.sql", MIGRATION,
        "20260929152445_dashboard_roster_inactivity_v53.sql"], "Unexpected migration inventory")
    migration = root / "supabase/migrations" / MIGRATION
    mapping_bytes = PAIR_PATH.read_bytes()
    pairs = json.loads(mapping_bytes)
    source = f"koaryu_v52_source_{os.getpid()}"
    restored = f"koaryu_v52_restore_{os.getpid()}"
    canonical = f"koaryu_v52_canonical_{os.getpid()}"
    dump = temporary / f"v51-before-v52-{os.getpid()}.dump"
    owned, outcomes = [], {}
    try:
        for database, template in [(source, "postgres"), (restored, "template0")]:
            local.run([createdb, *local.connection, "--owner=postgres", f"--template={template}", database])
            owned.append(database)
            local.sql(database, f'ALTER DATABASE {database} SET search_path TO "$user",public,extensions;')
        seed = local.sql(source, SEED_SQL)
        before = snapshot(source)
        require(seed == "seeded" and len(before["public.leads"]) == 1
                and len(before["public.lead_activities"]) == 1,
                "Retained lead and activity fixture is incomplete")
        predecessor(source)
        expected_semantics = semantics(source)
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
                ("V52_OPERATIONAL_READINESS_SQL", "EXPECTED_V52_OPERATIONAL_READINESS"),
                ("V51_OPERATIONAL_READINESS_SQL", "EXPECTED_V51_OPERATIONAL_READINESS"),
                ("V50_OPERATIONAL_READINESS_SQL", "EXPECTED_V50_OPERATIONAL_READINESS"),
                ("V49_OPERATIONAL_READINESS_SQL", "EXPECTED_V49_OPERATIONAL_READINESS"),
                ("V48_OPERATIONAL_READINESS_SQL", "EXPECTED_V48_OPERATIONAL_READINESS"),
                ("V47_OPERATIONAL_READINESS_SQL", "EXPECTED_V47_OPERATIONAL_READINESS"),
                ("V46_OPERATIONAL_READINESS_SQL", "EXPECTED_V46_OPERATIONAL_READINESS"),
                ("V45_OPERATIONAL_READINESS_SQL", "EXPECTED_V45_OPERATIONAL_READINESS"),
                ("V44_OPERATIONAL_READINESS_SQL", "EXPECTED_V44_OPERATIONAL_READINESS"),
                ("V43_OPERATIONAL_READINESS_SQL", "EXPECTED_V43_OPERATIONAL_READINESS"),
                ("V42_OPERATIONAL_READINESS_SQL", "EXPECTED_V42_OPERATIONAL_READINESS"),
                ("V41_OPERATIONAL_READINESS_SQL", "EXPECTED_V41_OPERATIONAL_READINESS"),
                ("V40_OPERATIONAL_READINESS_SQL", "EXPECTED_V40_OPERATIONAL_READINESS"),
                ("V39_OPERATIONAL_READINESS_SQL", "EXPECTED_V39_OPERATIONAL_READINESS"),
                ("V38_OPERATIONAL_READINESS_SQL", "EXPECTED_V38_OPERATIONAL_READINESS"),
                ("V37_OPERATIONAL_READINESS_SQL", "EXPECTED_V37_OPERATIONAL_READINESS"),
                ("V52_CATALOG_STATE_SQL", "EXPECTED_V52_RESTORED_CATALOG_STATE" if is_restored else "EXPECTED_V52_CATALOG_STATE"),
                ("V52_RELEASE_MANIFEST_SQL", "EXPECTED_V52_RELEASE_MANIFEST"),
                ("V31_EXPECTATION_STATE_SQL", "EXPECTED_V52_EXPECTATION_STATE"),
                ("V31_RESOURCE_OWNERSHIP_MANIFEST_SQL", "EXPECTED_V52_RESOURCE_OWNERSHIP_MANIFEST"),
                ("V31_OPERATIONAL_CONTRACT_SQL", "EXPECTED_V52_OPERATIONAL_CONTRACT"),
                ("V31_OPERATIONAL_MANIFEST_SQL", "EXPECTED_V52_OPERATIONAL_MANIFEST_V12"),
                ("V41_PAYER_BALANCE_STATE_SQL", "EXPECTED_V50_PAYER_BALANCE_STATE"),
                ("V50_COLLECTION_FACTS_STATE_SQL", "EXPECTED_V50_COLLECTION_FACTS_STATE"),
                ("V50_PAYER_READ_STATE_SQL", "EXPECTED_V50_PAYER_READ_STATE"),
                ("V50_LANDING_STATE_SQL", "EXPECTED_V50_LANDING_STATE"),
                ("V40_RANK_COMMAND_STATE_SQL", "EXPECTED_V40_RANK_COMMAND_STATE"),
                ("V43_EXTERNAL_PAYMENT_STATE_SQL", "EXPECTED_V43_EXTERNAL_PAYMENT_STATE"),
                ("V44_LOCAL_PLAN_STATE_SQL", "EXPECTED_V44_LOCAL_PLAN_STATE"),
                ("V44_CLEAR_STATE_SQL", "EXPECTED_V44_CLEAR_STATE"),
                ("V49_SUBSCRIPTION_TERMS_STATE_SQL", "EXPECTED_V49_SUBSCRIPTION_TERMS_STATE"),
                ("V50_INVOICE_FACTS_STATE_SQL", "EXPECTED_V50_INVOICE_FACTS_STATE"),
                ("V50_ATTENTION_STATE_SQL", "EXPECTED_V50_ATTENTION_STATE"),
                ("CRITICAL_SURFACE_MANIFEST_SQL", "EXPECTED_V52_CRITICAL_SURFACE_MANIFEST"),
                ("V29_OPERATIONAL_MANIFEST_SQL", "EXPECTED_V52_OPERATIONAL_MANIFEST_V10"),
                ("V30_OPERATIONAL_MANIFEST_SQL", "EXPECTED_V52_OPERATIONAL_MANIFEST_V11"),
                ("V30_OPERATIONAL_CONTRACT_SQL", "EXPECTED_V51_V30_OPERATIONAL_CONTRACT"),
                ("V30_REPLAY_REPAIRS_MANIFEST_SQL", "EXPECTED_V51_V30_REPLAY_REPAIRS_MANIFEST"),
                ("V51_CLOSEOUT_STATE_SQL", "EXPECTED_V51_CLOSEOUT_STATE"),
                ("V52_LEAD_UPDATE_STATE_SQL", "EXPECTED_V52_LEAD_UPDATE_STATE"),
                ("V52_LEAD_FOLLOW_UP_STATE_SQL", "EXPECTED_V52_LEAD_FOLLOW_UP_STATE"),
                ("V52_LEAD_RECEIPT_STATE_SQL", "EXPECTED_V52_LEAD_RECEIPT_STATE"),
            ]
            values = {query: check(database, query, expected) for query, expected in checks}
            require(semantics(database) == expected_semantics, "Upgrade or continuation changed declared semantic manifests")
            studio = before["public.studios"][0]["id"]
            actor = before["public.staff_roles"][0]["user_id"]
            lead = before["public.leads"][0]["id"]
            # Roll back the proof so every retained source row can be compared exactly.
            proof = local.sql(database, f"""
BEGIN;
SET LOCAL ROLE service_role;
SELECT public.update_lead_atomic('{studio}','{actor}','{lead}', '{{"stage":"trial_scheduled"}}');
DO $proof$
DECLARE operation UUID := gen_random_uuid(); first_result public.leads; replay public.leads;
BEGIN
    SELECT * INTO first_result FROM public.follow_up_lead_atomic(
        '{studio}','{actor}','{lead}',operation,'{{"next_stage":"trial_completed"}}');
    SELECT * INTO replay FROM public.follow_up_lead_atomic(
        '{studio}','{actor}','{lead}',operation,'{{"next_stage":"trial_completed"}}');
    IF to_jsonb(first_result) IS DISTINCT FROM to_jsonb(replay)
       OR replay.stage <> 'trial_completed' OR replay.follow_up_date IS NOT NULL
       OR (SELECT count(*) FROM public.lead_follow_up_operations WHERE operation_id=operation) <> 1
       OR (SELECT count(*) FROM public.lead_activities WHERE lead_id='{lead}' AND activity_type='stage_change') <> 2
       OR (SELECT count(*) FROM public.lead_activities WHERE lead_id='{lead}' AND activity_type='follow_up') <> 1 THEN
        RAISE EXCEPTION 'Restored V52 command result, history or replay mismatch';
    END IF;
END;
$proof$;
ROLLBACK;
SELECT 'continued';
""")
            require(proof.splitlines()[-1] == "continued", "Lead command continuation failed")
            require(snapshot(database) == before, "Lead command rollback changed retained rows")
            require(local.sql(database, "SELECT count(*) FROM public.lead_follow_up_operations;") == "0",
                    "Rolled-back follow-up receipt survived")
            outcomes[("restored_" if is_restored else "canonical_") + "lead_command"] = "replayed and rolled back"
            require({query: check(database, query, expected) for query, expected in checks} == values,
                    "Continuation changed the attested state")
            require(semantics(database) == expected_semantics, "Upgrade or continuation changed declared semantic manifests")
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
            "tools": versions, "queries": pinned, "outcomes": outcomes, "semantics": expected_semantics,
            "business_before_sha256": hashlib.sha256(json.dumps(before, sort_keys=True).encode()).hexdigest(),
            "constraint_pairs": len(pairs), "billing_replays": 6, "acl_representations": len(statements) - 6,
        }
        (temporary / "v51-v52-restore-evidence.json").write_text(json.dumps(evidence, indent=2) + "\n")
        print("[restored V52] PASS retained leads and activities, atomic updates, keyed follow-up replay and rollback on canonical/restored copies", flush=True)
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
