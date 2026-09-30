#!/usr/bin/env python3
"""Prove V53 retained student and guardian data survives logical restore and V54 repairs only explicit source-lead minor knowledge."""
import hashlib
import json
import os
from pathlib import Path
import signal
import sys

from local_postgres_verification import ACL_SQL, CONSTRAINT_SQL, PAIR_PATH, LocalPostgres, normalization_plan, require

MIGRATION = "20260930024404_student_profile_qa_v54.sql"
TABLES = ("auth.users", "public.studios", "public.staff_roles", "public.students", "public.leads",
          "public.guardians", "public.student_guardians", "public.student_program_memberships", "public.audit_logs")
SEED_SQL = """
BEGIN;
DO $seed$
DECLARE owner UUID := gen_random_uuid(); studio UUID := gen_random_uuid(); other UUID := gen_random_uuid();
    converted UUID := gen_random_uuid(); adult UUID := gen_random_uuid(); nonminor UUID := gen_random_uuid();
    unknown UUID := gen_random_uuid(); future_student UUID := gen_random_uuid(); guardian UUID := gen_random_uuid();
BEGIN
    INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES(owner,'authenticated','authenticated',owner||'@example.invalid','{}','{}',now(),now());
    INSERT INTO public.studios(id,name,slug,owner_id,timezone) VALUES
        (studio,'Student profile restore',studio::TEXT,owner,'UTC'),
        (other,'Other profile restore',other::TEXT,owner,'America/Los_Angeles');
    INSERT INTO public.staff_roles(studio_id,user_id,role) VALUES(studio,owner,'admin');
    INSERT INTO public.students(id,studio_id,legal_first_name,legal_last_name,status,date_of_birth,created_at,updated_at) VALUES
        (converted,studio,'Converted','Minor','active',NULL,'2026-01-01 12:00+00','2026-01-01 12:00+00'),
        (adult,studio,'Known','Adult','active','2000-01-01','2026-01-01 12:00+00','2026-01-01 12:00+00'),
        (nonminor,studio,'Nonminor','Lead','active',NULL,'2026-01-01 12:00+00','2026-01-01 12:00+00'),
        (unknown,other,'Unknown','Age','active',NULL,'2026-01-01 12:00+00','2026-01-01 12:00+00'),
        (future_student,studio,'Legacy','Future','active',CURRENT_DATE+30,'2026-01-01 12:00+00','2026-01-01 12:00+00');
    INSERT INTO public.leads(studio_id,first_name,last_name,is_minor,converted_student_id,stage) VALUES
        (studio,'Converted','Minor',TRUE,converted,'enrolled'),
        (studio,'Known','Adult',TRUE,adult,'enrolled'),
        (studio,'Nonminor','Lead',FALSE,nonminor,'enrolled'),
        (studio,'Legacy','Future',TRUE,future_student,'enrolled');
    INSERT INTO public.guardians(id,studio_id,first_name,last_name,email,is_primary_contact)
    VALUES(guardian,studio,'Original','Guardian','original@example.invalid',TRUE);
    INSERT INTO public.student_guardians(student_id,guardian_id) VALUES (converted,guardian),(adult,guardian);
END;
$seed$;
SELECT 'seeded';
COMMIT;
"""


def verify_upgrade_snapshot(before, after):
    # The reviewed repair permits only the same-studio explicit source lead's
    # missing-DOB student flag and its ordinary update timestamp to change.
    expected = json.loads(json.dumps(before))
    repaired = {student["id"] for student in before["public.students"]
                if student["date_of_birth"] is None and student["is_minor"] is not True
                and any(lead["converted_student_id"] == student["id"]
                        and lead["studio_id"] == student["studio_id"] and lead["is_minor"] is True
                        for lead in before["public.leads"])}
    require(len(repaired) == 1, "Backfill fixture does not isolate one explicit minor source")
    normalized = json.loads(json.dumps(after))
    for rows in (expected["public.students"], normalized["public.students"]):
        for student in rows:
            if student["id"] in repaired:
                if rows is expected["public.students"]:
                    student["is_minor"] = True
                student.pop("updated_at")
    for student in after["public.students"]:
        original = next(row for row in before["public.students"] if row["id"] == student["id"])
        if student["id"] in repaired:
            require(student["updated_at"] >= original["updated_at"], "Backfill timestamp moved backwards")
    return normalized == expected


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
        "FINAL_OPERATIONAL_READINESS_SQL", "EXPECTED_OPERATIONAL_READINESS",
        "V54_CATALOG_STATE_SQL", "EXPECTED_V54_CATALOG_STATE", "EXPECTED_V54_RESTORED_CATALOG_STATE",
        "V54_RELEASE_MANIFEST_SQL", "EXPECTED_V54_RELEASE_MANIFEST",
        "V31_EXPECTATION_STATE_SQL", "EXPECTED_V54_EXPECTATION_STATE",
        "V31_RESOURCE_OWNERSHIP_MANIFEST_SQL", "EXPECTED_V54_RESOURCE_OWNERSHIP_MANIFEST",
        "V31_OPERATIONAL_CONTRACT_SQL", "EXPECTED_V54_OPERATIONAL_CONTRACT",
        "V31_OPERATIONAL_MANIFEST_SQL", "EXPECTED_V54_OPERATIONAL_MANIFEST_V12",
        "CRITICAL_SURFACE_MANIFEST_SQL", "EXPECTED_V54_CRITICAL_SURFACE_MANIFEST",
        "V29_OPERATIONAL_MANIFEST_SQL", "EXPECTED_V54_OPERATIONAL_MANIFEST_V10",
        "V30_OPERATIONAL_MANIFEST_SQL", "EXPECTED_V54_OPERATIONAL_MANIFEST_V11",
        "V54_STUDENT_PROFILE_STATE_SQL", "EXPECTED_V54_STUDENT_PROFILE_STATE",
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
            fields.append(f"'{table}',(SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)->>'id',"
                          f"to_jsonb(t)::TEXT COLLATE \"C\"),'[]'::JSONB) FROM {table} t)")
        return json.loads(local.sql(database, "SET TIME ZONE 'UTC'; SELECT jsonb_build_object(" + ",".join(fields) + ");"))

    def predecessor(database, restored=False):
        check(database, "V53_OPERATIONAL_READINESS_SQL", "EXPECTED_V53_OPERATIONAL_READINESS")
        check(database, "V53_CATALOG_STATE_SQL", "EXPECTED_V53_RESTORED_CATALOG_STATE" if restored else "EXPECTED_V53_CATALOG_STATE")
        check(database, "V53_RELEASE_MANIFEST_SQL", "EXPECTED_V53_RELEASE_MANIFEST")
        check(database, "V31_EXPECTATION_STATE_SQL", "EXPECTED_V53_EXPECTATION_STATE")
        check(database, "V31_RESOURCE_OWNERSHIP_MANIFEST_SQL", "EXPECTED_V53_RESOURCE_OWNERSHIP_MANIFEST")
        check(database, "V31_OPERATIONAL_CONTRACT_SQL", "EXPECTED_V53_OPERATIONAL_CONTRACT")
        check(database, "V31_OPERATIONAL_MANIFEST_SQL", "EXPECTED_V53_OPERATIONAL_MANIFEST_V12")
        check(database, "CRITICAL_SURFACE_MANIFEST_SQL", "EXPECTED_V53_CRITICAL_SURFACE_MANIFEST")
        check(database, "V29_OPERATIONAL_MANIFEST_SQL", "EXPECTED_V53_OPERATIONAL_MANIFEST_V10")
        check(database, "V30_OPERATIONAL_MANIFEST_SQL", "EXPECTED_V53_OPERATIONAL_MANIFEST_V11")
        check(database, "V53_DASHBOARD_DEFINITION_STATE_SQL", "EXPECTED_V53_DASHBOARD_DEFINITION_SHA256")
        require(local.sql(database, "SELECT count(*)=148 AND max(version)='20260929152445' FROM supabase_migrations.schema_migrations;") == "t",
                "Restore requires the actual V53 history")
        require(local.sql(database, "SELECT to_regprocedure('public.koaryu_release_schema_preflight_v35()') IS NULL AND to_regprocedure('public.student_business_date(uuid)') IS NULL AND to_regprocedure('public.validate_student_birth_date()') IS NULL;") == "t",
                "Restore predecessor already contains V54 functions")

    predecessor("postgres")
    hashes = {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
              for p in sorted((root / "supabase/migrations").glob("*.sql"))}
    require(len(hashes) == 149 and list(hashes)[-2:] == [
        "20260929152445_dashboard_roster_inactivity_v53.sql", MIGRATION], "Unexpected migration inventory")
    migration = root / "supabase/migrations" / MIGRATION
    mapping_bytes = PAIR_PATH.read_bytes()
    pairs = json.loads(mapping_bytes)
    source = f"koaryu_v54_source_{os.getpid()}"
    restored = f"koaryu_v54_restore_{os.getpid()}"
    canonical = f"koaryu_v54_canonical_{os.getpid()}"
    dump = temporary / f"v53-before-v54-{os.getpid()}.dump"
    owned, outcomes = [], {}
    try:
        for database, template in [(source, "postgres"), (restored, "template0")]:
            local.run([createdb, *local.connection, "--owner=postgres", f"--template={template}", database])
            owned.append(database)
            local.sql(database, f'ALTER DATABASE {database} SET search_path TO "$user",public,extensions;')
        seed = local.sql(source, SEED_SQL)
        before = snapshot(source)
        require(seed == "seeded" and len(before["public.students"]) == 5
                and len(before["public.leads"]) == 4 and len(before["public.guardians"]) == 1
                and len(before["public.student_guardians"]) == 2,
                "Retained minor, guardian, adult and legacy birthdate fixture is incomplete")
        require(next(row for row in before["public.students"] if row["legal_first_name"] == "Converted")["is_minor"] is False,
                "V53 fixture no longer reproduces lost explicit minor knowledge")
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
            require(verify_upgrade_snapshot(before, snapshot(database)), "Migration changed retained rows before continuation")
            checks = [
                ("FINAL_OPERATIONAL_READINESS_SQL", "EXPECTED_OPERATIONAL_READINESS"),
                ("V54_CATALOG_STATE_SQL", "EXPECTED_V54_RESTORED_CATALOG_STATE" if is_restored else "EXPECTED_V54_CATALOG_STATE"),
                ("V54_RELEASE_MANIFEST_SQL", "EXPECTED_V54_RELEASE_MANIFEST"),
                ("V31_EXPECTATION_STATE_SQL", "EXPECTED_V54_EXPECTATION_STATE"),
                ("V31_RESOURCE_OWNERSHIP_MANIFEST_SQL", "EXPECTED_V54_RESOURCE_OWNERSHIP_MANIFEST"),
                ("V31_OPERATIONAL_CONTRACT_SQL", "EXPECTED_V54_OPERATIONAL_CONTRACT"),
                ("V31_OPERATIONAL_MANIFEST_SQL", "EXPECTED_V54_OPERATIONAL_MANIFEST_V12"),
                ("CRITICAL_SURFACE_MANIFEST_SQL", "EXPECTED_V54_CRITICAL_SURFACE_MANIFEST"),
                ("V29_OPERATIONAL_MANIFEST_SQL", "EXPECTED_V54_OPERATIONAL_MANIFEST_V10"),
                ("V30_OPERATIONAL_MANIFEST_SQL", "EXPECTED_V54_OPERATIONAL_MANIFEST_V11"),
                ("V54_STUDENT_PROFILE_STATE_SQL", "EXPECTED_V54_STUDENT_PROFILE_STATE"),
                ("V53_DASHBOARD_DEFINITION_STATE_SQL", "EXPECTED_V53_DASHBOARD_DEFINITION_SHA256"),
                ("V53_OPERATIONAL_READINESS_SQL", "EXPECTED_V53_OPERATIONAL_READINESS"),
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
            after = snapshot(database)
            studio = next(row["id"] for row in after["public.studios"] if row["name"] == "Student profile restore")
            actor = next(row["user_id"] for row in after["public.staff_roles"] if row["studio_id"] == studio)
            student = next(row["id"] for row in after["public.students"] if row["legal_first_name"] == "Converted")
            guardian = after["public.guardians"][0]["id"]
            future_student = next(row["id"] for row in after["public.students"] if row["legal_first_name"] == "Legacy")
            proof = local.sql(database, f"""
BEGIN;
SET LOCAL ROLE service_role;
DO $proof$
DECLARE result RECORD; rejected BOOLEAN := FALSE;
BEGIN
    SELECT * INTO result FROM public.write_student_profile_v2_atomic(
        '{student}','{studio}','{actor}','{{"notes":"Retained minor edit","date_of_birth":null}}',
        NULL,'[{{"id":"{guardian}","phone":"555-0101"}}]',FALSE,'student.updated');
    IF (result.result_student->>'is_minor')::BOOLEAN IS DISTINCT FROM TRUE
       OR result.result_student->>'date_of_birth' IS NOT NULL
       OR jsonb_array_length(result.result_guardians) IS DISTINCT FROM 1
       OR result.result_guardians->0->>'email' IS DISTINCT FROM 'original@example.invalid'
       OR result.result_guardians->0->>'phone' IS DISTINCT FROM '555-0101' THEN
        RAISE EXCEPTION 'Restored minor edit lost age or omitted guardian facts';
    END IF;
    SELECT * INTO result FROM public.write_student_profile_v2_atomic(
        '{student}','{studio}','{actor}','{{"notes":"Guardian addition"}}',NULL,
        '[{{"first_name":"Added","last_name":"Guardian","is_primary_contact":false}}]',FALSE,'student.updated');
    IF jsonb_array_length(result.result_guardians) IS DISTINCT FROM 2 THEN
        RAISE EXCEPTION 'Restored profile did not add a guardian';
    END IF;
    BEGIN
        PERFORM public.write_student_profile_v2_atomic(
            '{student}','{studio}','{actor}',jsonb_build_object('date_of_birth',public.student_business_date('{studio}')+1),
            NULL,'[]',FALSE,'student.updated');
    EXCEPTION WHEN check_violation THEN
        IF SQLERRM IS DISTINCT FROM 'Date of birth cannot be in the future.' THEN RAISE; END IF;
        rejected := TRUE;
    END;
    IF NOT rejected THEN RAISE EXCEPTION 'Restored profile accepted a future birth date'; END IF;
    PERFORM public.write_student_profile_v2_atomic(
        '{future_student}','{studio}','{actor}','{{"notes":"Legacy unrelated edit"}}',
        NULL,'[]',FALSE,'student.updated');
    IF (SELECT date_of_birth FROM public.students WHERE id='{future_student}') IS DISTINCT FROM CURRENT_DATE+30
       OR (SELECT is_minor FROM public.students WHERE id='{future_student}') IS DISTINCT FROM FALSE THEN
        RAISE EXCEPTION 'Legacy future date continuation changed DOB or derived a minor age';
    END IF;
END;
$proof$;
ROLLBACK;
SELECT 'continued';
""")
            require(proof.splitlines()[-1] == "continued", "V54 profile continuation failed")
            require(snapshot(database) == after, "V54 continuation rollback changed retained rows")
            outcomes[("restored_" if is_restored else "canonical_") + "student_profile"] = "minor and guardian edits retained, future DOB rejected"
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
        (temporary / "v53-v54-restore-evidence.json").write_text(json.dumps(evidence, indent=2) + "\n")
        print("[restored V54] PASS scoped minor backfill, guardian editing, future DOB rejection and V53 compatibility on canonical/restored copies", flush=True)
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
