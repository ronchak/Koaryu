#!/usr/bin/env python3
"""Prove retained attendance survives V52 restore and V53 dashboard inactivity matches roster IDs on canonical and restored copies."""
import hashlib
import json
import os
from pathlib import Path
import signal
import sys

from local_postgres_verification import ACL_SQL, CONSTRAINT_SQL, PAIR_PATH, LocalPostgres, normalization_plan, require

MIGRATION = "20260929152445_dashboard_roster_inactivity_v53.sql"
TABLES = ("auth.users", "public.studios", "public.students", "public.class_sessions", "public.attendance")
SEED_SQL = """
BEGIN;
DO $seed$
DECLARE owner UUID := gen_random_uuid(); studio UUID := gen_random_uuid(); other UUID := gen_random_uuid();
    delayed UUID := gen_random_uuid(); recent UUID := gen_random_uuid(); future_student UUID := gen_random_uuid();
    quiet_other UUID := gen_random_uuid(); delayed_class UUID := gen_random_uuid(); recent_class UUID := gen_random_uuid();
    future_class UUID := gen_random_uuid();
BEGIN
    INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES(owner,'authenticated','authenticated',owner||'@example.invalid','{}','{}',now(),now());
    INSERT INTO public.studios(id,name,slug,owner_id,timezone) VALUES
        (studio,'Inactivity restore',studio::TEXT,owner,'UTC'),
        (other,'Other inactivity restore',other::TEXT,owner,'UTC');
    INSERT INTO public.students(id,studio_id,legal_first_name,legal_last_name,status,membership_start_date,created_at) VALUES
        (delayed,studio,'Delayed','Entry','active','2026-01-01','2026-01-01 12:00+00'),
        (recent,studio,'Recent','Class','active','2026-01-01','2026-01-01 12:00+00'),
        (future_student,studio,'Future','Only','active','2026-01-01','2026-01-01 12:00+00'),
        (quiet_other,other,'Other','Quiet','active','2026-01-01','2026-01-01 12:00+00');
    INSERT INTO public.class_sessions(id,studio_id,name,date,start_time,end_time,status,capacity) VALUES
        (delayed_class,studio,'Delayed entry','2026-04-30','10:00','11:00','scheduled',10),
        (recent_class,studio,'Recent class','2026-05-19','10:00','11:00','scheduled',10),
        (future_class,studio,'Future class','2026-05-23','10:00','11:00','scheduled',10);
    INSERT INTO public.attendance(studio_id,session_id,student_id,status,checked_in_at) VALUES
        (studio,delayed_class,delayed,'present','2026-05-20 12:00+00'),
        (studio,recent_class,recent,'present','2026-01-10 12:00+00'),
        (studio,future_class,future_student,'present','2026-05-20 12:00+00');
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
        "V52_OPERATIONAL_READINESS_SQL", "EXPECTED_V52_OPERATIONAL_READINESS",
        "V52_CATALOG_STATE_SQL", "EXPECTED_V52_CATALOG_STATE", "EXPECTED_V52_RESTORED_CATALOG_STATE",
        "V52_RELEASE_MANIFEST_SQL", "EXPECTED_V52_RELEASE_MANIFEST",
        "V31_EXPECTATION_STATE_SQL", "EXPECTED_V52_EXPECTATION_STATE",
        "V31_RESOURCE_OWNERSHIP_MANIFEST_SQL", "EXPECTED_V52_RESOURCE_OWNERSHIP_MANIFEST",
        "V31_OPERATIONAL_CONTRACT_SQL", "EXPECTED_V52_OPERATIONAL_CONTRACT",
        "V31_OPERATIONAL_MANIFEST_SQL", "EXPECTED_V52_OPERATIONAL_MANIFEST_V12",
        "CRITICAL_SURFACE_MANIFEST_SQL", "EXPECTED_V52_CRITICAL_SURFACE_MANIFEST",
        "V29_OPERATIONAL_MANIFEST_SQL", "EXPECTED_V52_OPERATIONAL_MANIFEST_V10",
        "V30_OPERATIONAL_MANIFEST_SQL", "EXPECTED_V52_OPERATIONAL_MANIFEST_V11",
        "V52_LEAD_UPDATE_STATE_SQL", "EXPECTED_V52_LEAD_UPDATE_STATE",
        "V52_LEAD_FOLLOW_UP_STATE_SQL", "EXPECTED_V52_LEAD_FOLLOW_UP_STATE",
        "V52_LEAD_RECEIPT_STATE_SQL", "EXPECTED_V52_LEAD_RECEIPT_STATE",
        "V53_OPERATIONAL_READINESS_SQL", "EXPECTED_V53_OPERATIONAL_READINESS",
        "V53_CATALOG_STATE_SQL", "EXPECTED_V53_CATALOG_STATE", "EXPECTED_V53_RESTORED_CATALOG_STATE",
        "V53_RELEASE_MANIFEST_SQL", "EXPECTED_V53_RELEASE_MANIFEST",
        "V31_EXPECTATION_STATE_SQL", "EXPECTED_V53_EXPECTATION_STATE",
        "V31_RESOURCE_OWNERSHIP_MANIFEST_SQL", "EXPECTED_V53_RESOURCE_OWNERSHIP_MANIFEST",
        "V31_OPERATIONAL_CONTRACT_SQL", "EXPECTED_V53_OPERATIONAL_CONTRACT",
        "V31_OPERATIONAL_MANIFEST_SQL", "EXPECTED_V53_OPERATIONAL_MANIFEST_V12",
        "CRITICAL_SURFACE_MANIFEST_SQL", "EXPECTED_V53_CRITICAL_SURFACE_MANIFEST",
        "V29_OPERATIONAL_MANIFEST_SQL", "EXPECTED_V53_OPERATIONAL_MANIFEST_V10",
        "V30_OPERATIONAL_MANIFEST_SQL", "EXPECTED_V53_OPERATIONAL_MANIFEST_V11",
        "V53_DASHBOARD_DEFINITION_STATE_SQL", "EXPECTED_V53_DASHBOARD_DEFINITION_SHA256",
        "V51_OPERATIONAL_READINESS_SQL", "EXPECTED_V51_OPERATIONAL_READINESS",
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
        "V30_OPERATIONAL_CONTRACT_SQL", "EXPECTED_V51_V30_OPERATIONAL_CONTRACT",
        "V30_REPLAY_REPAIRS_MANIFEST_SQL", "EXPECTED_V51_V30_REPLAY_REPAIRS_MANIFEST",
        "V51_CLOSEOUT_STATE_SQL", "EXPECTED_V51_CLOSEOUT_STATE",
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
        check(database, "V52_OPERATIONAL_READINESS_SQL", "EXPECTED_V52_OPERATIONAL_READINESS")
        check(database, "V52_CATALOG_STATE_SQL", "EXPECTED_V52_RESTORED_CATALOG_STATE" if restored else "EXPECTED_V52_CATALOG_STATE")
        check(database, "V52_RELEASE_MANIFEST_SQL", "EXPECTED_V52_RELEASE_MANIFEST")
        check(database, "V31_EXPECTATION_STATE_SQL", "EXPECTED_V52_EXPECTATION_STATE")
        check(database, "V31_RESOURCE_OWNERSHIP_MANIFEST_SQL", "EXPECTED_V52_RESOURCE_OWNERSHIP_MANIFEST")
        check(database, "V31_OPERATIONAL_CONTRACT_SQL", "EXPECTED_V52_OPERATIONAL_CONTRACT")
        check(database, "V31_OPERATIONAL_MANIFEST_SQL", "EXPECTED_V52_OPERATIONAL_MANIFEST_V12")
        check(database, "CRITICAL_SURFACE_MANIFEST_SQL", "EXPECTED_V52_CRITICAL_SURFACE_MANIFEST")
        check(database, "V29_OPERATIONAL_MANIFEST_SQL", "EXPECTED_V52_OPERATIONAL_MANIFEST_V10")
        check(database, "V30_OPERATIONAL_MANIFEST_SQL", "EXPECTED_V52_OPERATIONAL_MANIFEST_V11")
        check(database, "V52_LEAD_UPDATE_STATE_SQL", "EXPECTED_V52_LEAD_UPDATE_STATE")
        check(database, "V52_LEAD_FOLLOW_UP_STATE_SQL", "EXPECTED_V52_LEAD_FOLLOW_UP_STATE")
        check(database, "V52_LEAD_RECEIPT_STATE_SQL", "EXPECTED_V52_LEAD_RECEIPT_STATE")
        require(local.sql(database, "SELECT count(*)=147 AND max(version)='20260926194918' FROM supabase_migrations.schema_migrations;") == "t",
                "Restore requires the actual V52 history")
        require(local.sql(database, "SELECT to_regprocedure('public.koaryu_release_schema_preflight_v34()') IS NULL;") == "t",
                "Restore predecessor already contains V53 functions")

    predecessor("postgres")
    hashes = {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
              for p in sorted((root / "supabase/migrations").glob("*.sql"))}
    require(len(hashes) == 150 and list(hashes)[-4:] == [
        "20260926194918_lead_commands_v52.sql", MIGRATION,
        "20260930024404_student_profile_qa_v54.sql",
        "20260930192626_converted_lead_enrollment_v55.sql"], "Unexpected migration inventory")
    migration = root / "supabase/migrations" / MIGRATION
    mapping_bytes = PAIR_PATH.read_bytes()
    pairs = json.loads(mapping_bytes)
    source = f"koaryu_v53_source_{os.getpid()}"
    restored = f"koaryu_v53_restore_{os.getpid()}"
    canonical = f"koaryu_v53_canonical_{os.getpid()}"
    dump = temporary / f"v52-before-v53-{os.getpid()}.dump"
    owned, outcomes = [], {}
    try:
        for database, template in [(source, "postgres"), (restored, "template0")]:
            local.run([createdb, *local.connection, "--owner=postgres", f"--template={template}", database])
            owned.append(database)
            local.sql(database, f'ALTER DATABASE {database} SET search_path TO "$user",public,extensions;')
        seed = local.sql(source, SEED_SQL)
        before = snapshot(source)
        require(seed == "seeded" and len(before["public.students"]) == 4
                and len(before["public.attendance"]) == 3,
                "Retained student and attendance fixture is incomplete")
        studio = next(row["id"] for row in before["public.studios"] if row["name"] == "Inactivity restore")
        old_dashboard = json.loads(local.sql(source, f"SELECT public.dashboard_summary_facts('{studio}', 'billing_hidden', 'UTC', DATE '2026-05-20', 'dashboard-summary-v1');"))
        old_roster = json.loads(local.sql(source, f"SELECT public.list_student_roster('{studio}', NULL, NULL, NULL, 14, NULL, DATE '2026-05-20', 'name', 'asc', 200, NULL, NULL, NULL);"))
        require(old_dashboard["inactivity"]["watch_14"] != old_roster["total"],
                "V52 source no longer reproduces the delayed-entry dashboard mismatch")
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
                ("V53_OPERATIONAL_READINESS_SQL", "EXPECTED_V53_OPERATIONAL_READINESS"),
                ("V53_CATALOG_STATE_SQL", "EXPECTED_V53_RESTORED_CATALOG_STATE" if is_restored else "EXPECTED_V53_CATALOG_STATE"),
                ("V53_RELEASE_MANIFEST_SQL", "EXPECTED_V53_RELEASE_MANIFEST"),
                ("V31_EXPECTATION_STATE_SQL", "EXPECTED_V53_EXPECTATION_STATE"),
                ("V31_RESOURCE_OWNERSHIP_MANIFEST_SQL", "EXPECTED_V53_RESOURCE_OWNERSHIP_MANIFEST"),
                ("V31_OPERATIONAL_CONTRACT_SQL", "EXPECTED_V53_OPERATIONAL_CONTRACT"),
                ("V31_OPERATIONAL_MANIFEST_SQL", "EXPECTED_V53_OPERATIONAL_MANIFEST_V12"),
                ("CRITICAL_SURFACE_MANIFEST_SQL", "EXPECTED_V53_CRITICAL_SURFACE_MANIFEST"),
                ("V29_OPERATIONAL_MANIFEST_SQL", "EXPECTED_V53_OPERATIONAL_MANIFEST_V10"),
                ("V30_OPERATIONAL_MANIFEST_SQL", "EXPECTED_V53_OPERATIONAL_MANIFEST_V11"),
                ("V53_DASHBOARD_DEFINITION_STATE_SQL", "EXPECTED_V53_DASHBOARD_DEFINITION_SHA256"),
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
                ("V30_OPERATIONAL_CONTRACT_SQL", "EXPECTED_V51_V30_OPERATIONAL_CONTRACT"),
                ("V30_REPLAY_REPAIRS_MANIFEST_SQL", "EXPECTED_V51_V30_REPLAY_REPAIRS_MANIFEST"),
                ("V51_CLOSEOUT_STATE_SQL", "EXPECTED_V51_CLOSEOUT_STATE"),
            ]
            values = {query: check(database, query, expected) for query, expected in checks}
            studio = next(row["id"] for row in before["public.studios"] if row["name"] == "Inactivity restore")
            other = next(row["id"] for row in before["public.studios"] if row["name"] == "Other inactivity restore")
            for target, expected in [(studio, {14: 2, 30: 1, 90: 1}), (other, {14: 1, 30: 1, 90: 1})]:
                dashboard = json.loads(local.sql(database, f"SELECT public.dashboard_summary_facts('{target}', 'billing_hidden', 'UTC', DATE '2026-05-20', 'dashboard-summary-v1');"))
                for window, count in expected.items():
                    roster = json.loads(local.sql(database, f"SELECT public.list_student_roster('{target}', NULL, NULL, NULL, {window}, NULL, DATE '2026-05-20', 'name', 'asc', 200, NULL, NULL, NULL);"))
                    ids = {item["id"] for item in roster["items"]}
                    require(len(ids) == count and roster["total"] == count and roster["has_next"] is False
                            and dashboard["inactivity"][f"watch_{window}"] == count,
                            f"V53 dashboard/roster inactivity {window} mismatch after restore")
                if target == studio:
                    expected_names = {row["legal_first_name"] for row in before["public.students"]
                                      if row["studio_id"] == studio and row["legal_first_name"] in {"Delayed", "Future"}}
                    roster = json.loads(local.sql(database, f"SELECT public.list_student_roster('{studio}', NULL, NULL, NULL, 14, NULL, DATE '2026-05-20', 'name', 'asc', 200, NULL, NULL, NULL);"))
                    actual_names = {row["legal_first_name"] for row in before["public.students"] if row["id"] in {item["id"] for item in roster["items"]}}
                    require(actual_names == expected_names, "V53 14-day roster identities changed")
            require(snapshot(database) == before, "V53 read continuation changed retained rows")
            outcomes[("restored_" if is_restored else "canonical_") + "dashboard_roster"] = "exact 14/30/90 parity"
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
        (temporary / "v52-v53-restore-evidence.json").write_text(json.dumps(evidence, indent=2) + "\n")
        print("[restored V53] PASS retained attendance, exact dashboard/roster inactivity parity and V52 compatibility on canonical/restored copies", flush=True)
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
