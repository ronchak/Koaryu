#!/usr/bin/env python3
"""Prove a local V38 logical backup preserves memberships through the V39 upgrade.

Called only by verify-supabase-contracts-local.sh before migration 134. This owns
its two newly created databases, never the caller's cluster or source database.
The fixed CHECK pairs cover PostgreSQL 17 dump/parser representation changes;
unknown definitions or privilege differences stop the proof before repair.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import signal
import sys

from local_postgres_verification import ACL_SQL, CONSTRAINT_SQL, PAIR_PATH, LocalPostgres, normalization_plan, require

MIGRATION = "20260908080420_student_membership_preservation_v39.sql"
STUDENT = "39000000-0000-4000-8000-000000000003"
STUDIO = "39000000-0000-4000-8000-000000000002"
OWNER = "39000000-0000-4000-8000-000000000001"
PROGRAMS = ["39000000-0000-4000-8000-000000000004", "39000000-0000-4000-8000-000000000005"]
SEED_SQL = f"""
INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
VALUES ('{OWNER}','authenticated','authenticated','v39-restore@example.invalid','{{}}','{{}}',now(),now());
INSERT INTO public.studios(id,name,slug,owner_id)
VALUES ('{STUDIO}','V39 restore fixture','v39-restore-fixture','{OWNER}');
INSERT INTO public.programs(id,studio_id,name) VALUES
 ('{PROGRAMS[0]}','{STUDIO}','First'),('{PROGRAMS[1]}','{STUDIO}','Second');
INSERT INTO public.belt_ladders(id,studio_id,name,program_id)
VALUES ('39000000-0000-4000-8000-000000000006','{STUDIO}','First ladder','{PROGRAMS[0]}');
INSERT INTO public.belt_ranks(id,studio_id,ladder_id,name,display_order)
VALUES ('39000000-0000-4000-8000-000000000007','{STUDIO}',
 '39000000-0000-4000-8000-000000000006','White',0);
INSERT INTO public.students(id,studio_id,legal_first_name,legal_last_name,status,membership_start_date,phone)
VALUES ('{STUDENT}','{STUDIO}','Restore','Student','active','2026-01-10','original');
SELECT public.write_student_profile_v2_atomic('{STUDENT}','{STUDIO}','{OWNER}',
 '{{}}',ARRAY['{PROGRAMS[0]}','{PROGRAMS[1]}']::uuid[],'[]',true,'student.updated');
UPDATE public.student_program_memberships SET status='paused',started_at='2026-03-05'
WHERE student_id='{STUDENT}' AND program_id='{PROGRAMS[0]}';
UPDATE public.student_program_memberships SET started_at=NULL
WHERE student_id='{STUDENT}' AND program_id='{PROGRAMS[1]}';
"""
SNAPSHOT_SQL = f"""
SELECT jsonb_build_object(
 'student',(SELECT to_jsonb(s) FROM public.students s WHERE id='{STUDENT}'),
 'memberships',(SELECT jsonb_agg(to_jsonb(m) ORDER BY id) FROM public.student_program_memberships m WHERE student_id='{STUDENT}'),
 'ranks',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM public.belt_ranks r WHERE studio_id='{STUDIO}'),
 'audit',(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM public.audit_logs a WHERE entity_id='{STUDENT}'));
"""
EDIT_SQL = f"""
SET ROLE service_role;
SELECT to_jsonb(r) FROM public.write_student_profile_v2_atomic('{STUDENT}','{STUDIO}','{OWNER}',
 '{{"phone":"updated","status":"active","membership_start_date":"2026-01-10","program_id":"{PROGRAMS[0]}"}}',
 ARRAY['{PROGRAMS[0]}','{PROGRAMS[1]}']::uuid[],'[]',true,'student.updated') r;
"""


def main(arguments):
    require(len(arguments) == 8, "Expected pg_dump pg_restore createdb psql socket port temp-dir repository-root")
    pg_dump, pg_restore, createdb, psql, socket_arg, port, temporary_arg, root_arg = arguments
    socket, temporary, root = Path(socket_arg), Path(temporary_arg), Path(root_arg).resolve()
    local = LocalPostgres(psql, socket, port, temporary)
    run, sql, connection = local.run, local.sql, local.connection
    versions = local.require_pg17(pg_dump, pg_restore, createdb, psql)
    exports = ["CATALOG_STATE_SQL", "V31_EXPECTATION_STATE_SQL", "V38_OPERATIONAL_READINESS_SQL",
               "V39_OPERATIONAL_READINESS_SQL", "V37_OPERATIONAL_READINESS_SQL", "V38_BILLING_MANIFEST_SQL",
               "V39_RELEASE_MANIFEST_SQL", "EXPECTED_V37_CATALOG_STATE", "EXPECTED_V37_RESTORED_CATALOG_STATE",
               "EXPECTED_V39_RESTORED_CATALOG_STATE", "EXPECTED_V39_EXPECTATION_STATE",
               "EXPECTED_V38_OPERATIONAL_READINESS", "EXPECTED_V39_OPERATIONAL_READINESS",
               "EXPECTED_V37_OPERATIONAL_READINESS", "EXPECTED_V38_BILLING_MANIFEST", "EXPECTED_V39_RELEASE_MANIFEST"]
    module = (root / "scripts/studio-comp-migration-rollout.mjs").as_uri()
    pinned = json.loads(run(["node", "--input-type=module", "--eval",
                            f"import * as m from {json.dumps(module)}; console.log(JSON.stringify(Object.fromEntries("
                            f"{json.dumps(exports)}.map(k=>[k,m[k]]))));"]))

    def check(database, query, expected):
        value = sql(database, pinned[query])
        require(value == pinned[expected], f"{database}: {query} did not match {expected}")
        return value

    check("postgres", "V38_OPERATIONAL_READINESS_SQL", "EXPECTED_V38_OPERATIONAL_READINESS")
    check("postgres", "CATALOG_STATE_SQL", "EXPECTED_V37_CATALOG_STATE")
    check("postgres", "V38_BILLING_MANIFEST_SQL", "EXPECTED_V38_BILLING_MANIFEST")
    source, restored = f"koaryu_v39_source_{os.getpid()}", f"koaryu_v39_restore_{os.getpid()}"
    owned = []
    dump = temporary / f"v38-before-v39-{os.getpid()}.dump"
    migration = root / "supabase/migrations" / MIGRATION
    hashes = {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
              for p in sorted((root / "supabase/migrations").glob("*.sql"))}
    require(len(hashes) == 135 and list(hashes)[133:] == [MIGRATION,
            "20260908133504_rank_history_command_ownership_v40.sql"],
            "Unexpected V39 historical prefix or current migration suffix")
    mapping_bytes = PAIR_PATH.read_bytes()
    pairs = json.loads(mapping_bytes)
    try:
        for database, template in [(source, "postgres"), (restored, "template0")]:
            run([createdb, *connection, "--owner=postgres", f"--template={template}", database])
            owned.append(database)
            sql(database, f'ALTER DATABASE {database} SET search_path TO "$user", public, extensions;')
        sql(source, "BEGIN;\n" + SEED_SQL + "\nCOMMIT;")
        before = json.loads(sql(source, SNAPSHOT_SQL))
        require(before["student"]["phone"] == "original" and len(before["memberships"]) == 2
                and {m["status"] for m in before["memberships"]} == {"paused", "active"}
                and {m["started_at"] for m in before["memberships"]} == {"2026-03-05", None}
                and len(before["ranks"]) == 1 and len(before["audit"]) >= 1, "Restore fixture is incomplete")
        constraints = json.loads(sql(source, CONSTRAINT_SQL))
        acls = json.loads(sql(source, ACL_SQL))
        run([pg_dump, *connection, f"--dbname={source}", "--format=custom", f"--file={dump}"])
        dump_hash = hashlib.sha256(dump.read_bytes()).hexdigest()
        run([pg_restore, *connection, f"--dbname={restored}", "--exit-on-error", str(dump)])
        require(hashlib.sha256(dump.read_bytes()).hexdigest() == dump_hash, "Backup changed during restore")
        statements, expected_constraints = normalization_plan(
            constraints, json.loads(sql(restored, CONSTRAINT_SQL)), acls, json.loads(sql(restored, ACL_SQL)), pairs)
        sql(restored, "BEGIN;\n" + "\n".join(statements) + "\nCOMMIT;")
        require(json.loads(sql(restored, CONSTRAINT_SQL)) == expected_constraints, "CHECK repair changed an unexpected definition")
        require(json.loads(sql(restored, ACL_SQL)) == acls, "Default ACL representation repair differed")
        require(json.loads(sql(restored, SNAPSHOT_SQL)) == before, "Logical restore changed business rows")
        check(restored, "CATALOG_STATE_SQL", "EXPECTED_V37_RESTORED_CATALOG_STATE")
        check(restored, "V38_OPERATIONAL_READINESS_SQL", "EXPECTED_V38_OPERATIONAL_READINESS")
        check(restored, "V38_BILLING_MANIFEST_SQL", "EXPECTED_V38_BILLING_MANIFEST")
        require(hashlib.sha256(migration.read_bytes()).hexdigest() == hashes[MIGRATION], "Migration changed during restore")
        version, name = MIGRATION[:-4].split("_", 1)
        run([psql, *connection, f"--dbname={restored}", "--no-psqlrc", "--set=ON_ERROR_STOP=1", "--quiet",
             "--single-transaction", f"--file={migration}",
             f"--command=INSERT INTO supabase_migrations.schema_migrations(version,name) VALUES ('{version}','{name}');"])
        require(json.loads(sql(restored, SNAPSHOT_SQL)) == before, "V39 migration rewrote business rows")
        outcomes = {}
        for query, expected in [
            ("V39_OPERATIONAL_READINESS_SQL", "EXPECTED_V39_OPERATIONAL_READINESS"),
            ("V38_OPERATIONAL_READINESS_SQL", "EXPECTED_V38_OPERATIONAL_READINESS"),
            ("V37_OPERATIONAL_READINESS_SQL", "EXPECTED_V37_OPERATIONAL_READINESS"),
            ("CATALOG_STATE_SQL", "EXPECTED_V39_RESTORED_CATALOG_STATE"),
            ("V31_EXPECTATION_STATE_SQL", "EXPECTED_V39_EXPECTATION_STATE"),
            ("V39_RELEASE_MANIFEST_SQL", "EXPECTED_V39_RELEASE_MANIFEST"),
        ]:
            outcomes[query] = check(restored, query, expected)
        result = json.loads(sql(restored, EDIT_SQL))
        after = json.loads(sql(restored, SNAPSHOT_SQL))
        require(result["result_student"]["phone"] == "updated" and after["student"]["phone"] == "updated",
                "Restored writer did not save the requested edit")
        protected = ("id", "program_id", "status", "started_at", "ended_at", "current_belt_rank_id")
        facts = lambda rows: [{k: row[k] for k in protected} for row in rows]
        require(facts(after["memberships"]) == facts(before["memberships"]), "Restored writer mutated retained membership facts")
        require(len(after["audit"]) == len(before["audit"]) + 1, "Restored writer audit insert did not continue")
        for database in ("postgres", source):
            check(database, "V38_OPERATIONAL_READINESS_SQL", "EXPECTED_V38_OPERATIONAL_READINESS")
            check(database, "CATALOG_STATE_SQL", "EXPECTED_V37_CATALOG_STATE")
            require(sql(database, "SELECT to_regprocedure('public.koaryu_release_schema_preflight_v20()') IS NULL;") == "t",
                    "Restore proof upgraded its source database")
        require(json.loads(sql(source, SNAPSHOT_SQL)) == before, "Restore proof edited its source rows")
        require(all(hashlib.sha256((root / 'supabase/migrations' / name).read_bytes()).hexdigest() == digest
                    for name, digest in hashes.items()), "Migration inputs changed during verification")
        evidence = {"migrations": hashes, "dump_sha256": dump_hash,
                    "helper_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), "local_tools_sha256": hashlib.sha256(Path(__file__).with_name("local_postgres_verification.py").read_bytes()).hexdigest(),
                    "mapping_sha256": hashlib.sha256(mapping_bytes).hexdigest(), "tools": versions,
                    "queries": pinned, "outcomes": outcomes,
                    "business_before_sha256": hashlib.sha256(json.dumps(before, sort_keys=True).encode()).hexdigest(),
                    "constraint_pairs": len(pairs), "billing_replays": 6, "acl_representations": len(statements)-6}
        (temporary / "v38-v39-restore-evidence.json").write_text(json.dumps(evidence, indent=2) + "\n")
        print("[restored V39] PASS V38 dump/restore, exact normalization, V39 upgrade, V19/V18 compatibility, and retained membership edit", flush=True)
    finally:
        # createdb must have succeeded before a name becomes ours. Never remove a
        # preexisting database and never stop or delete the caller's cluster.
        errors = []
        for database in reversed(owned):
            try:
                sql("postgres", f"DROP DATABASE {database} WITH (FORCE);")
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
