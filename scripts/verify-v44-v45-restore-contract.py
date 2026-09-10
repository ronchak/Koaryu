#!/usr/bin/env python3
"""Prove V44 restore preserves legacy imports and V45 receipt-owned continuation without historical backfill."""
import hashlib
import json
import os
from pathlib import Path
import signal
import sys

from local_postgres_verification import ACL_SQL, CONSTRAINT_SQL, PAIR_PATH, LocalPostgres, normalization_plan, require

MIGRATION = "20260910185031_student_import_retry_ownership_v45.sql"
STUDIO = "95000000-0000-4000-8000-000000000001"
ACTOR = "95000000-0000-4000-8000-000000000002"
PROGRAM = "95000000-0000-4000-8000-000000000003"
STUDENT = "95000000-0000-4000-8000-000000000004"
GUARDIAN = "95000000-0000-4000-8000-000000000005"
COMPLETE_RUN = "95000000-0000-4000-8000-000000000006"
FAILED_RUN = "95000000-0000-4000-8000-000000000007"
TABLES = ("auth.users", "public.staff_profiles", "public.studios", "public.staff_roles",
          "public.programs", "public.students", "public.student_program_memberships", "public.guardians",
          "public.student_guardians", "public.student_import_runs", "public.audit_logs",
          "public.billing_plans", "public.billing_invoices", "public.billing_payments")
LEGACY_RESULT = {"total_rows": 1, "valid_rows": 1, "error_rows": 0, "imported_count": 1,
                 "non_critical_errors": ["Historical import warning"]}
SEED_SQL = f"""
BEGIN;
INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
VALUES('{ACTOR}','authenticated','authenticated','import-restore@example.invalid','{{}}','{{}}',now(),now());
INSERT INTO public.studios(id,name,slug,owner_id) VALUES('{STUDIO}','Import restore','import-restore','{ACTOR}');
INSERT INTO public.staff_roles(studio_id,user_id,role) VALUES('{STUDIO}','{ACTOR}','admin');
INSERT INTO public.programs(id,studio_id,name) VALUES('{PROGRAM}','{STUDIO}','Legacy program');
INSERT INTO public.students(id,studio_id,legal_first_name,legal_last_name,phone,program_id,membership_start_date)
VALUES('{STUDENT}','{STUDIO}','Retained','Student','staff-edited-phone','{PROGRAM}','2015-01-02');
INSERT INTO public.student_program_memberships(studio_id,student_id,program_id,status,started_at)
SELECT '{STUDIO}','{STUDENT}','{PROGRAM}','paused','2014-03-04'
WHERE NOT EXISTS(SELECT 1 FROM public.student_program_memberships WHERE student_id='{STUDENT}' AND program_id='{PROGRAM}' AND ended_at IS NULL);
UPDATE public.student_program_memberships SET status='paused',started_at='2014-03-04' WHERE student_id='{STUDENT}';
INSERT INTO public.guardians(id,studio_id,first_name,last_name,phone)
VALUES('{GUARDIAN}','{STUDIO}','Retained','Guardian','staff-edited-guardian');
INSERT INTO public.student_guardians(student_id,guardian_id) VALUES('{STUDENT}','{GUARDIAN}');
INSERT INTO public.student_import_runs(id,studio_id,actor_id,idempotency_key,request_hash,status,result_json,processing_token,completed_at)
VALUES('{COMPLETE_RUN}','{STUDIO}','{ACTOR}','legacy-complete','completed-hash','completed','{json.dumps(LEGACY_RESULT)}',NULL,'2020-01-01'),
      ('{FAILED_RUN}','{STUDIO}','{ACTOR}','legacy-failed','failed-hash','failed',NULL,NULL,NULL);
INSERT INTO public.billing_plans(studio_id,name,amount_cents,currency,status)
VALUES('{STUDIO}','Historical EUR plan',1200,'eur','active');
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
        "V44_OPERATIONAL_READINESS_SQL", "EXPECTED_V44_OPERATIONAL_READINESS",
        "V42_CATALOG_STATE_SQL", "EXPECTED_V42_CATALOG_STATE", "EXPECTED_V42_RESTORED_CATALOG_STATE",
        "V44_RELEASE_MANIFEST_SQL", "EXPECTED_V44_RELEASE_MANIFEST",
        "V40_RANK_COMMAND_STATE_SQL", "EXPECTED_V40_RANK_COMMAND_STATE",
        "V41_PAYER_BALANCE_STATE_SQL", "EXPECTED_V41_PAYER_BALANCE_STATE",
        "V43_EXTERNAL_PAYMENT_STATE_SQL", "EXPECTED_V43_EXTERNAL_PAYMENT_STATE",
        "V44_LOCAL_PLAN_STATE_SQL", "EXPECTED_V44_LOCAL_PLAN_STATE",
        "V44_CLEAR_STATE_SQL", "EXPECTED_V44_CLEAR_STATE",
        "FINAL_OPERATIONAL_READINESS_SQL", "EXPECTED_OPERATIONAL_READINESS",
        "V43_OPERATIONAL_READINESS_SQL", "EXPECTED_V43_OPERATIONAL_READINESS",
        "V42_OPERATIONAL_READINESS_SQL", "EXPECTED_V42_OPERATIONAL_READINESS",
        "V41_OPERATIONAL_READINESS_SQL", "EXPECTED_V41_OPERATIONAL_READINESS",
        "V40_OPERATIONAL_READINESS_SQL", "EXPECTED_V40_OPERATIONAL_READINESS",
        "V39_OPERATIONAL_READINESS_SQL", "EXPECTED_V39_OPERATIONAL_READINESS",
        "V38_OPERATIONAL_READINESS_SQL", "EXPECTED_V38_OPERATIONAL_READINESS",
        "V37_OPERATIONAL_READINESS_SQL", "EXPECTED_V37_OPERATIONAL_READINESS",
        "V45_CATALOG_STATE_SQL", "EXPECTED_V45_CATALOG_STATE", "EXPECTED_V45_RESTORED_CATALOG_STATE",
        "V45_RELEASE_MANIFEST_SQL", "EXPECTED_V45_RELEASE_MANIFEST",
        "V31_EXPECTATION_STATE_SQL", "EXPECTED_V45_EXPECTATION_STATE",
        "V31_RESOURCE_OWNERSHIP_MANIFEST_SQL", "EXPECTED_V45_RESOURCE_OWNERSHIP_MANIFEST",
        "V31_OPERATIONAL_CONTRACT_SQL", "EXPECTED_V45_OPERATIONAL_CONTRACT",
        "V31_OPERATIONAL_MANIFEST_SQL", "EXPECTED_V45_OPERATIONAL_MANIFEST_V12",
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
            value = "to_jsonb(t)-'receipts_enabled'" if table == "public.student_import_runs" else "to_jsonb(t)"
            fields.append(f"'{table}',(SELECT COALESCE(jsonb_agg({value} ORDER BY to_jsonb(t)->>'id',"
                          f"to_jsonb(t)::TEXT COLLATE \"C\"),'[]'::JSONB) FROM {table} t)")
        return json.loads(local.sql(database, "SET TIME ZONE 'UTC'; SELECT jsonb_build_object(" + ",".join(fields) + ");"))
    contract_sources = {
        name: (root / "supabase" / "verification" / name).read_bytes()
        for name in ("student_import_row_atomic_contract.sql", "worker_claim_rpc_contract.sql")
    }

    def semantics(database):
        return {signature: local.sql(database, f"SELECT {signature};") for signature in ["private.koaryu_release_critical_surface_manifest_v16()","private.koaryu_release_critical_surface_manifest_v17()","private.koaryu_release_critical_surface_manifest_v18()","private.koaryu_release_operational_manifest_v10()","private.koaryu_release_operational_manifest_v11()"]}

    def predecessor(database, restored=False):
        check(database, "V44_OPERATIONAL_READINESS_SQL", "EXPECTED_V44_OPERATIONAL_READINESS")
        check(database, "V42_CATALOG_STATE_SQL", "EXPECTED_V42_RESTORED_CATALOG_STATE" if restored else "EXPECTED_V42_CATALOG_STATE")
        check(database, "V44_RELEASE_MANIFEST_SQL", "EXPECTED_V44_RELEASE_MANIFEST")
        check(database, "V40_RANK_COMMAND_STATE_SQL", "EXPECTED_V40_RANK_COMMAND_STATE")
        check(database, "V41_PAYER_BALANCE_STATE_SQL", "EXPECTED_V41_PAYER_BALANCE_STATE")
        check(database, "V43_EXTERNAL_PAYMENT_STATE_SQL", "EXPECTED_V43_EXTERNAL_PAYMENT_STATE")
        check(database, "V44_LOCAL_PLAN_STATE_SQL", "EXPECTED_V44_LOCAL_PLAN_STATE")
        check(database, "V44_CLEAR_STATE_SQL", "EXPECTED_V44_CLEAR_STATE")
        require(local.sql(database, "SELECT count(*)=139 AND max(version)='20260910135133' FROM supabase_migrations.schema_migrations;") == "t",
                "Restore requires the actual V44 history")
        require(local.sql(database, "SELECT to_regprocedure('public.koaryu_release_schema_preflight_v26()') IS NULL AND to_regprocedure('public.claim_student_import_run_v2(uuid,uuid,text,text,text,text,integer)') IS NULL AND to_regprocedure('public.prepare_student_import_program_v1(uuid,uuid,text,text,uuid,text,uuid,boolean,boolean)') IS NULL AND to_regprocedure('public.prepare_student_import_belts_v1(uuid,uuid,text,uuid,uuid,jsonb,boolean)') IS NULL;") == "t",
                "Restore predecessor already contains V45 functions")

    predecessor("postgres")
    hashes = {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
              for p in sorted((root / "supabase/migrations").glob("*.sql"))}
    require(len(hashes) == 140 and list(hashes)[-2:] == [
        "20260910135133_local_plan_write_ownership_v44.sql", MIGRATION], "Unexpected migration inventory")
    migration = root / "supabase/migrations" / MIGRATION
    mapping_bytes = PAIR_PATH.read_bytes()
    pairs = json.loads(mapping_bytes)
    source = f"koaryu_v45_source_{os.getpid()}"
    restored = f"koaryu_v45_restore_{os.getpid()}"
    canonical = f"koaryu_v45_canonical_{os.getpid()}"
    dump = temporary / f"v44-before-v45-{os.getpid()}.dump"
    owned, outcomes = [], {}
    try:
        for database, template in [(source, "postgres"), (restored, "template0")]:
            local.run([createdb, *local.connection, "--owner=postgres", f"--template={template}", database])
            owned.append(database)
            local.sql(database, f'ALTER DATABASE {database} SET search_path TO "$user",public,extensions;')
        seed = local.sql(source, SEED_SQL)
        before = snapshot(source)
        require(seed == "seeded" and len(before["public.student_import_runs"]) == 2
                and len(before["public.students"]) == 1 and len(before["public.student_guardians"]) == 1
                and before["public.student_program_memberships"][0]["status"] == "paused"
                and before["public.student_program_memberships"][0]["started_at"] == "2014-03-04"
                and before["public.billing_plans"][0]["currency"] == "eur", "Import restore seed is incomplete")
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
                ("FINAL_OPERATIONAL_READINESS_SQL", "EXPECTED_OPERATIONAL_READINESS"),
                ("V44_OPERATIONAL_READINESS_SQL", "EXPECTED_V44_OPERATIONAL_READINESS"),
                ("V43_OPERATIONAL_READINESS_SQL", "EXPECTED_V43_OPERATIONAL_READINESS"),
                ("V42_OPERATIONAL_READINESS_SQL", "EXPECTED_V42_OPERATIONAL_READINESS"),
                ("V41_OPERATIONAL_READINESS_SQL", "EXPECTED_V41_OPERATIONAL_READINESS"),
                ("V40_OPERATIONAL_READINESS_SQL", "EXPECTED_V40_OPERATIONAL_READINESS"),
                ("V39_OPERATIONAL_READINESS_SQL", "EXPECTED_V39_OPERATIONAL_READINESS"),
                ("V38_OPERATIONAL_READINESS_SQL", "EXPECTED_V38_OPERATIONAL_READINESS"),
                ("V37_OPERATIONAL_READINESS_SQL", "EXPECTED_V37_OPERATIONAL_READINESS"),
                ("V45_CATALOG_STATE_SQL", "EXPECTED_V45_RESTORED_CATALOG_STATE" if is_restored else "EXPECTED_V45_CATALOG_STATE"),
                ("V45_RELEASE_MANIFEST_SQL", "EXPECTED_V45_RELEASE_MANIFEST"),
                ("V40_RANK_COMMAND_STATE_SQL", "EXPECTED_V40_RANK_COMMAND_STATE"),
                ("V41_PAYER_BALANCE_STATE_SQL", "EXPECTED_V41_PAYER_BALANCE_STATE"),
                ("V43_EXTERNAL_PAYMENT_STATE_SQL", "EXPECTED_V43_EXTERNAL_PAYMENT_STATE"),
                ("V44_LOCAL_PLAN_STATE_SQL", "EXPECTED_V44_LOCAL_PLAN_STATE"),
                ("V44_CLEAR_STATE_SQL", "EXPECTED_V44_CLEAR_STATE"),
                ("V31_EXPECTATION_STATE_SQL", "EXPECTED_V45_EXPECTATION_STATE"),
                ("V31_RESOURCE_OWNERSHIP_MANIFEST_SQL", "EXPECTED_V45_RESOURCE_OWNERSHIP_MANIFEST"),
                ("V31_OPERATIONAL_CONTRACT_SQL", "EXPECTED_V45_OPERATIONAL_CONTRACT"),
                ("V31_OPERATIONAL_MANIFEST_SQL", "EXPECTED_V45_OPERATIONAL_MANIFEST_V12"),
            ]
            values = {query: check(database, query, expected) for query, expected in checks}
            require(semantics(database) == expected_semantics, "Upgrade or continuation changed declared semantic manifests")
            require(local.sql(database, "SELECT count(*)=0 FROM private.student_import_receipts;") == "t"
                    and local.sql(database, "SELECT bool_and(NOT receipts_enabled) FROM public.student_import_runs;") == "t",
                    "Migration invented completion receipts for legacy imports")
            for function in ("claim_student_import_run", "claim_student_import_run_v2"):
                complete = json.loads(local.sql(database, f"SET ROLE service_role; SELECT to_jsonb(r) FROM public.{function}('{STUDIO}','{ACTOR}','students_csv_execute','legacy-complete','completed-hash','cache-token',45) r;"))
                require(complete["claim_status"] == "completed" and complete["run_row"]["result_json"] == LEGACY_RESULT,
                        "Completed pre-migration cache changed or stopped replaying")
                failed = json.loads(local.sql(database, f"SET ROLE service_role; SELECT to_jsonb(r) FROM public.{function}('{STUDIO}','{ACTOR}','students_csv_execute','legacy-failed','failed-hash','retry-token',45) r;"))
                require(failed["claim_status"] == "unsupported_run", "Untracked pre-migration partial import was resumed")
            require(snapshot(database) == before, "Legacy cache/refusal changed retained customer or financial data")
            # Reuse the maintained behavioral contracts on both restored and canonical
            # schemas instead of copying their row/setup/claim algorithms into this runner.
            for name, content in contract_sources.items():
                local.sql(database, content.decode("utf8"))
                require((root / "supabase" / "verification" / name).read_bytes() == content,
                        "Continuation contract changed during verification")
            outcomes["contract_inputs"] = {name: hashlib.sha256(content).hexdigest() for name, content in contract_sources.items()}
            require(snapshot(database) == before, "Rollback-scoped continuation checks changed retained data")
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
        (temporary / "v44-v45-restore-evidence.json").write_text(json.dumps(evidence, indent=2) + "\n")
        print("[restored V45] PASS actual V44 backup/restore, retained legacy data and completed caches, "
              "untracked retry refusal and maintained import contracts on canonical/restored copies", flush=True)
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
