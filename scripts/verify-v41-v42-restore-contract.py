#!/usr/bin/env python3
"""Prove V41 logical restore and V42 independent joining-date edits without a backfill."""
import hashlib
import json
import os
from pathlib import Path
import signal
import sys

from local_postgres_verification import ACL_SQL, CONSTRAINT_SQL, PAIR_PATH, LocalPostgres, normalization_plan, require

MIGRATION = "20260910084231_independent_program_joining_dates_v42.sql"
STUDENT = "42000000-0000-4000-8000-000000000003"
STUDIO = "42000000-0000-4000-8000-000000000002"
OWNER = "42000000-0000-4000-8000-000000000001"
PROGRAMS = ["42000000-0000-4000-8000-000000000004", "42000000-0000-4000-8000-000000000005"]
SEED_SQL = f"""
BEGIN;
INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
VALUES ('{OWNER}','authenticated','authenticated','v42-restore@example.invalid','{{}}','{{}}',now(),now());
INSERT INTO public.studios(id,name,slug,owner_id)
VALUES ('{STUDIO}','V42 restore fixture','v42-restore-fixture','{OWNER}');
INSERT INTO public.programs(id,studio_id,name) VALUES
 ('{PROGRAMS[0]}','{STUDIO}','First'),('{PROGRAMS[1]}','{STUDIO}','Second');
INSERT INTO public.belt_ladders(id,studio_id,name,program_id)
VALUES ('42000000-0000-4000-8000-000000000006','{STUDIO}','First ladder','{PROGRAMS[0]}');
INSERT INTO public.belt_ranks(id,studio_id,ladder_id,name,display_order)
VALUES ('42000000-0000-4000-8000-000000000007','{STUDIO}',
 '42000000-0000-4000-8000-000000000006','White',0);
INSERT INTO public.students(id,studio_id,legal_first_name,legal_last_name,status,membership_start_date,phone)
VALUES ('{STUDENT}','{STUDIO}','Restore','Student','active','2026-01-10','original');
DO $seed$ BEGIN PERFORM public.write_student_profile_v2_atomic('{STUDENT}','{STUDIO}','{OWNER}',
 '{{}}',ARRAY['{PROGRAMS[0]}','{PROGRAMS[1]}']::uuid[],'[]',true,'student.updated'); END $seed$;
UPDATE public.student_program_memberships SET status='paused',started_at='2026-03-05'
WHERE student_id='{STUDENT}' AND program_id='{PROGRAMS[0]}';
UPDATE public.student_program_memberships SET started_at=NULL
WHERE student_id='{STUDENT}' AND program_id='{PROGRAMS[1]}';
SELECT 'seeded';
COMMIT;
"""
SNAPSHOT_SQL = f"""
SELECT jsonb_build_object(
 'student',(SELECT to_jsonb(s) FROM public.students s WHERE id='{STUDENT}'),
 'memberships',(SELECT jsonb_agg(to_jsonb(m) ORDER BY id) FROM public.student_program_memberships m WHERE student_id='{STUDENT}'),
 'ranks',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM public.belt_ranks r WHERE studio_id='{STUDIO}'),
 'audit',(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM public.audit_logs a WHERE entity_id='{STUDENT}'));
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
        "V40_CATALOG_STATE_SQL", "EXPECTED_V40_CATALOG_STATE", "EXPECTED_V40_RESTORED_CATALOG_STATE",
        "V41_OPERATIONAL_READINESS_SQL", "EXPECTED_V41_OPERATIONAL_READINESS",
        "V41_RELEASE_MANIFEST_SQL", "EXPECTED_V41_RELEASE_MANIFEST",
        "V40_RANK_COMMAND_STATE_SQL", "EXPECTED_V40_RANK_COMMAND_STATE",
        "V41_PAYER_BALANCE_STATE_SQL", "EXPECTED_V41_PAYER_BALANCE_STATE",
        "V42_OPERATIONAL_READINESS_SQL", "EXPECTED_V42_OPERATIONAL_READINESS",
        "V40_OPERATIONAL_READINESS_SQL", "EXPECTED_V40_OPERATIONAL_READINESS",
        "V39_OPERATIONAL_READINESS_SQL", "EXPECTED_V39_OPERATIONAL_READINESS",
        "V38_OPERATIONAL_READINESS_SQL", "EXPECTED_V38_OPERATIONAL_READINESS",
        "V37_OPERATIONAL_READINESS_SQL", "EXPECTED_V37_OPERATIONAL_READINESS",
        "V42_CATALOG_STATE_SQL", "EXPECTED_V42_CATALOG_STATE", "EXPECTED_V42_RESTORED_CATALOG_STATE",
        "V42_RELEASE_MANIFEST_SQL", "EXPECTED_V42_RELEASE_MANIFEST",
        "V31_EXPECTATION_STATE_SQL", "EXPECTED_V42_EXPECTATION_STATE",
        "V31_RESOURCE_OWNERSHIP_MANIFEST_SQL", "EXPECTED_V42_RESOURCE_OWNERSHIP_MANIFEST",
        "V31_OPERATIONAL_CONTRACT_SQL", "EXPECTED_V42_OPERATIONAL_CONTRACT_V31",
        "V31_OPERATIONAL_MANIFEST_SQL", "EXPECTED_V42_OPERATIONAL_MANIFEST_V12",
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
        return json.loads(local.sql(database, SNAPSHOT_SQL))

    def semantics(database):
        return {signature: local.sql(database, f"SELECT {signature};") for signature in ["private.koaryu_release_operational_contract_v26()","private.koaryu_release_operational_contract_v27()","private.koaryu_release_operational_contract_v28()","private.koaryu_release_operational_contract_v29()","private.koaryu_release_operational_contract_v30()","private.koaryu_release_operational_manifest_v10()","private.koaryu_release_operational_manifest_v11()","private.koaryu_release_critical_surface_manifest_v16()","private.koaryu_release_critical_surface_manifest_v17()","private.koaryu_release_critical_surface_manifest_v18()"]}

    def predecessor(database, restored=False):
        check(database, "V40_CATALOG_STATE_SQL", "EXPECTED_V40_RESTORED_CATALOG_STATE" if restored else "EXPECTED_V40_CATALOG_STATE")
        check(database, "V41_OPERATIONAL_READINESS_SQL", "EXPECTED_V41_OPERATIONAL_READINESS")
        check(database, "V41_RELEASE_MANIFEST_SQL", "EXPECTED_V41_RELEASE_MANIFEST")
        check(database, "V40_RANK_COMMAND_STATE_SQL", "EXPECTED_V40_RANK_COMMAND_STATE")
        check(database, "V41_PAYER_BALANCE_STATE_SQL", "EXPECTED_V41_PAYER_BALANCE_STATE")
        require(local.sql(database, "SELECT count(*)=136 AND max(version)='20260908183744' FROM supabase_migrations.schema_migrations;") == "t",
                "Restore requires the actual V41 history")
        require(local.sql(database, "SELECT to_regprocedure('public.koaryu_release_schema_preflight_v23()') IS NULL;") == "t",
                "Restore predecessor already contains V42 functions")

    predecessor("postgres")
    hashes = {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
              for p in sorted((root / "supabase/migrations").glob("*.sql"))}
    require(len(hashes) == 140 and list(hashes)[-5:] == [
        "20260908183744_serialize_billing_payer_balance_v41.sql", MIGRATION,
        "20260910093958_external_payment_command_ownership_v43.sql",
        "20260910135133_local_plan_write_ownership_v44.sql",
        "20260910185031_student_import_retry_ownership_v45.sql"], "Unexpected migration inventory")
    migration = root / "supabase/migrations" / MIGRATION
    mapping_bytes = PAIR_PATH.read_bytes()
    pairs = json.loads(mapping_bytes)
    source = f"koaryu_v42_source_{os.getpid()}"
    restored = f"koaryu_v42_restore_{os.getpid()}"
    canonical = f"koaryu_v42_canonical_{os.getpid()}"
    dump = temporary / f"v41-before-v42-{os.getpid()}.dump"
    owned, outcomes = [], {}
    try:
        for database, template in [(source, "postgres"), (restored, "template0")]:
            local.run([createdb, *local.connection, "--owner=postgres", f"--template={template}", database])
            owned.append(database)
            local.sql(database, f'ALTER DATABASE {database} SET search_path TO "$user",public,extensions;')
        seed = local.sql(source, SEED_SQL)
        before = snapshot(source)
        require(before["student"]["phone"] == "original" and len(before["memberships"]) == 2
                and {m["status"] for m in before["memberships"]} == {"paused", "active"}
                and {m["started_at"] for m in before["memberships"]} == {"2026-03-05", None}
                and len(before["ranks"]) == 1 and len(before["audit"]) >= 1, "Restore fixture is incomplete")
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
                ("V42_OPERATIONAL_READINESS_SQL", "EXPECTED_V42_OPERATIONAL_READINESS"),
                ("V41_OPERATIONAL_READINESS_SQL", "EXPECTED_V41_OPERATIONAL_READINESS"),
                ("V40_OPERATIONAL_READINESS_SQL", "EXPECTED_V40_OPERATIONAL_READINESS"),
                ("V39_OPERATIONAL_READINESS_SQL", "EXPECTED_V39_OPERATIONAL_READINESS"),
                ("V38_OPERATIONAL_READINESS_SQL", "EXPECTED_V38_OPERATIONAL_READINESS"),
                ("V37_OPERATIONAL_READINESS_SQL", "EXPECTED_V37_OPERATIONAL_READINESS"),
                ("V42_CATALOG_STATE_SQL", "EXPECTED_V42_RESTORED_CATALOG_STATE" if is_restored else "EXPECTED_V42_CATALOG_STATE"),
                ("V40_RANK_COMMAND_STATE_SQL", "EXPECTED_V40_RANK_COMMAND_STATE"),
                ("V41_PAYER_BALANCE_STATE_SQL", "EXPECTED_V41_PAYER_BALANCE_STATE"),
                ("V42_RELEASE_MANIFEST_SQL", "EXPECTED_V42_RELEASE_MANIFEST"),
                ("V31_EXPECTATION_STATE_SQL", "EXPECTED_V42_EXPECTATION_STATE"),
                ("V31_RESOURCE_OWNERSHIP_MANIFEST_SQL", "EXPECTED_V42_RESOURCE_OWNERSHIP_MANIFEST"),
                ("V31_OPERATIONAL_CONTRACT_SQL", "EXPECTED_V42_OPERATIONAL_CONTRACT_V31"),
                ("V31_OPERATIONAL_MANIFEST_SQL", "EXPECTED_V42_OPERATIONAL_MANIFEST_V12"),
            ]
            values = {query: check(database, query, expected) for query, expected in checks}
            require(semantics(database) == expected_semantics, "Upgrade or continuation changed declared semantic manifests")
            protected = ("id", "program_id", "status", "started_at", "ended_at", "current_belt_rank_id")
            original_memberships = [{key: row[key] for key in protected} for row in before["memberships"]]
            for function, date in [("write_student_profile_v2_atomic", "2026-09-01"),
                                   ("write_student_profile_atomic", "2026-08-01")]:
                payload = json.dumps({"membership_start_date": date, "phone": "updated"})
                result = json.loads(local.sql(database, f"""
                    BEGIN; SET LOCAL ROLE service_role;
                    SELECT to_jsonb(r) FROM public.{function}('{STUDENT}','{STUDIO}','{OWNER}',
                        '{payload}',ARRAY['{PROGRAMS[0]}','{PROGRAMS[1]}']::UUID[],'[]',true,'student.updated') r;
                    COMMIT;
                """))
                after = snapshot(database)
                saved = result.get("result_student", result)
                require(saved["membership_start_date"] == date and after["student"]["membership_start_date"] == date
                        and after["student"]["phone"] == "updated", "Overall joining-date edit did not persist")
                require([{key: row[key] for key in protected} for row in after["memberships"]] == original_memberships,
                        "Profile edit changed a retained program date, status or rank")
            require(len(after["audit"]) == len(before["audit"]) + 2, "Profile edits did not each record their audit")
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
        (temporary / "v41-v42-restore-evidence.json").write_text(json.dumps(evidence, indent=2) + "\n")
        print("[restored V42] PASS actual V41 backup/restore, exact normalization, no migration backfill, "
              "independent program dates through both profile writers on canonical/restored copies", flush=True)
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
