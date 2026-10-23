#!/usr/bin/env python3
"""Prove V59 rows survive the V60 missed-class gap guards and logical restore with exact readiness and V59 compatibility."""
import hashlib
import json
import os
from pathlib import Path
import signal
import sys

from local_postgres_verification import ACL_SQL, CONSTRAINT_SQL, PAIR_PATH, LocalPostgres, normalization_plan, require

MIGRATION = "20261021093000_missed_class_gap_guards_v60.sql"
SEED_SQL = r"""
BEGIN;
INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
VALUES('00000000-0000-4000-8000-000000006001','authenticated','authenticated',
       'v60-restore@example.invalid','{}','{}',now(),now());
INSERT INTO public.studios(id,name,slug,owner_id,timezone)
VALUES('00000000-0000-4000-8000-000000006002','V60 retained gaps','v60-retained-gaps',
       '00000000-0000-4000-8000-000000006001','UTC');
INSERT INTO public.students(id,studio_id,legal_first_name,legal_last_name,email) VALUES
    ('00000000-0000-4000-8000-000000006003','00000000-0000-4000-8000-000000006002','Closure','Student','closure@example.invalid'),
    ('00000000-0000-4000-8000-000000006004','00000000-0000-4000-8000-000000006002','Capped','Student','capped@example.invalid'),
    ('00000000-0000-4000-8000-000000006005','00000000-0000-4000-8000-000000006002','Peer','Student','peer@example.invalid');
INSERT INTO public.class_sessions(id,studio_id,name,date,start_time,end_time) VALUES
    ('00000000-0000-4000-8000-000000006011','00000000-0000-4000-8000-000000006002','Capped visit','2019-12-01','10:00','11:00'),
    ('00000000-0000-4000-8000-000000006012','00000000-0000-4000-8000-000000006002','Peer class','2020-02-20','10:00','11:00'),
    ('00000000-0000-4000-8000-000000006013','00000000-0000-4000-8000-000000006002','Closure visit','2020-03-01','10:00','11:00'),
    ('00000000-0000-4000-8000-000000006014','00000000-0000-4000-8000-000000006002','Reopening class','2020-03-20','10:00','11:00');
INSERT INTO public.attendance(studio_id,session_id,student_id,checked_in_at) VALUES
    ('00000000-0000-4000-8000-000000006002','00000000-0000-4000-8000-000000006011','00000000-0000-4000-8000-000000006004','2019-12-01 10:05+00'),
    ('00000000-0000-4000-8000-000000006002','00000000-0000-4000-8000-000000006012','00000000-0000-4000-8000-000000006005','2020-02-20 10:05+00'),
    ('00000000-0000-4000-8000-000000006002','00000000-0000-4000-8000-000000006013','00000000-0000-4000-8000-000000006003','2020-03-01 10:05+00'),
    ('00000000-0000-4000-8000-000000006002','00000000-0000-4000-8000-000000006014','00000000-0000-4000-8000-000000006005','2020-03-20 10:05+00');
COMMIT;
SELECT 'seeded';
"""

# Retained rows decide V60's gaps at explicit references, without the wall clock.
V60_GAP_PROBES_SQL = r"""
SELECT jsonb_build_object(
 'closure_before_reopening',(SELECT jsonb_build_array(skip_reason,days_absent) FROM private.missed_class_automation_candidates(
     '00000000-0000-4000-8000-000000006002',14,'00000000-0000-4000-8000-000000006003',NULL,'2020-03-19 12:00+00')),
 'closure_after_missed_classes',(SELECT jsonb_build_array(skip_reason,days_absent) FROM private.missed_class_automation_candidates(
     '00000000-0000-4000-8000-000000006002',14,'00000000-0000-4000-8000-000000006003',NULL,'2020-04-03 12:00+00')),
 'beyond_lookback',(SELECT jsonb_build_array(skip_reason,days_absent) FROM private.missed_class_automation_candidates(
     '00000000-0000-4000-8000-000000006002',14,'00000000-0000-4000-8000-000000006004',NULL,'2020-04-03 12:00+00')));
"""
V60_EXPECTED_GAP_PROBES = {
    'closure_before_reopening': ['recent_attendance', 18],
    'closure_after_missed_classes': [None, 33],
    'beyond_lookback': ['inactive', 124],
}
V60_COMPATIBILITY_DRIFT_SQL = """
BEGIN;
GRANT EXECUTE ON FUNCTION private.missed_class_automation_candidates(UUID,INTEGER,UUID,UUID,TIMESTAMPTZ) TO anon;
DO $compatibility$
DECLARE old RECORD; current RECORD;
BEGIN
    SELECT * INTO old FROM public.koaryu_release_schema_preflight_v40();
    SELECT * INTO current FROM public.koaryu_release_schema_preflight_v41();
    IF old.ready IS DISTINCT FROM FALSE OR current.ready IS DISTINCT FROM FALSE
       OR old.security_failures IS DISTINCT FROM ARRAY['automation_functions_v56','missed_class_functions_v60']::TEXT[]
       OR old.security_failures IS DISTINCT FROM current.security_failures
       OR old.migration_count IS DISTINCT FROM 155 OR old.migration_head IS DISTINCT FROM '20261021093000'
       OR old.pending_versions IS DISTINCT FROM current.pending_versions
       OR old.manifest_version IS DISTINCT FROM 'release-db-attestation-v59' THEN
        RAISE EXCEPTION 'V40 compatibility did not refuse V60 drift: %',row_to_json(old);
    END IF;
END;
$compatibility$;
ROLLBACK;
SELECT 'compatibility drift refused';
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
        "V59_OPERATIONAL_READINESS_SQL", "EXPECTED_V59_OPERATIONAL_READINESS",
        "V59_CATALOG_STATE_SQL", "EXPECTED_V59_CATALOG_STATE", "EXPECTED_V59_RESTORED_CATALOG_STATE",
        "V60_OPERATIONAL_READINESS_SQL", "EXPECTED_V60_OPERATIONAL_READINESS",
        "V60_AUTOMATION_TABLE_STATE_SQL", "EXPECTED_V60_AUTOMATION_TABLE_STATE", "EXPECTED_V60_RESTORED_AUTOMATION_TABLE_STATE",
        "V60_AUTOMATION_FUNCTION_STATE_SQL", "EXPECTED_V60_AUTOMATION_FUNCTION_STATE",
        "V60_CATALOG_STATE_SQL", "EXPECTED_V60_CATALOG_STATE", "EXPECTED_V60_RESTORED_CATALOG_STATE",
        "V60_RELEASE_MANIFEST_SQL", "EXPECTED_V60_RELEASE_MANIFEST",
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
        tables = json.loads(local.sql(database, "SELECT jsonb_agg(n.nspname||'.'||c.relname ORDER BY n.nspname,c.relname) "
            "FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='r' "
            "AND n.nspname IN ('public','private','auth') AND c.oid<>coalesce(to_regclass('private.timezone_names'),0);"))
        fields = ["SELECT '" + table + "' AS name,(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::TEXT COLLATE \"C\"),'[]') FROM " + table + " t) AS rows" for table in tables]
        return json.loads(local.sql(database, "SET TIME ZONE 'UTC'; SELECT jsonb_object_agg(name,rows) FROM (" + " UNION ALL ".join(fields) + ") retained;"))

    def predecessor(database, restored=False):
        check(database, "V59_OPERATIONAL_READINESS_SQL", "EXPECTED_V59_OPERATIONAL_READINESS")
        check(database, "V59_CATALOG_STATE_SQL", "EXPECTED_V59_RESTORED_CATALOG_STATE" if restored else "EXPECTED_V59_CATALOG_STATE")
        require(local.sql(database, "SELECT count(*)=154 AND max(version)='20261014083106' FROM supabase_migrations.schema_migrations;") == "t",
                "Restore requires the actual V59 history")
        require(local.sql(database, "SELECT to_regprocedure('public.koaryu_release_schema_preflight_v41()') IS NULL;") == "t",
                "Restore predecessor already contains V60 functions")

    predecessor("postgres")
    hashes = {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
              for p in sorted((root / "supabase/migrations").glob("*.sql"))}
    require(len(hashes) == 156 and list(hashes)[-3:] == [
        "20261014083106_timezone_names_reference_v59.sql", MIGRATION,
        "20261022190000_student_import_identity_guard_v61.sql"], "Unexpected migration inventory")
    migration = root / "supabase/migrations" / MIGRATION
    mapping_bytes = Path(__file__).with_name("v57-restore-constraint-pairs.json").read_bytes()
    pairs = json.loads(mapping_bytes)
    source = f"koaryu_v60_source_{os.getpid()}"
    restored = f"koaryu_v60_restore_{os.getpid()}"
    canonical = f"koaryu_v60_canonical_{os.getpid()}"
    dump = temporary / f"v59-before-v60-{os.getpid()}.dump"
    owned, outcomes = [], {}
    try:
        for database, template in [(source, "postgres"), (restored, "template0")]:
            local.run([createdb, *local.connection, "--owner=postgres", f"--template={template}", database])
            owned.append(database)
            local.sql(database, f'ALTER DATABASE {database} SET search_path TO "$user",public,extensions;')
        seed = local.sql(source, SEED_SQL)
        before = snapshot(source)
        require(seed == 'seeded', 'V60 source fixture did not seed')
        require(len(before['public.attendance']) >= 4 and any(row['id'] == '00000000-0000-4000-8000-000000006002'
                for row in before['public.studios']), 'V60 requires retained attendance gaps')
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
                ("V60_OPERATIONAL_READINESS_SQL", "EXPECTED_V60_OPERATIONAL_READINESS"),
                ("V60_AUTOMATION_TABLE_STATE_SQL", "EXPECTED_V60_RESTORED_AUTOMATION_TABLE_STATE" if is_restored else "EXPECTED_V60_AUTOMATION_TABLE_STATE"),
                ("V60_AUTOMATION_FUNCTION_STATE_SQL", "EXPECTED_V60_AUTOMATION_FUNCTION_STATE"),
                ("V60_CATALOG_STATE_SQL", "EXPECTED_V60_RESTORED_CATALOG_STATE" if is_restored else "EXPECTED_V60_CATALOG_STATE"),
                ("V60_RELEASE_MANIFEST_SQL", "EXPECTED_V60_RELEASE_MANIFEST"),
            ]
            values = {query: check(database, query, expected) for query, expected in checks}
            upgraded = snapshot(database)
            probes = json.loads(local.sql(database, V60_GAP_PROBES_SQL))
            require(probes == V60_EXPECTED_GAP_PROBES, 'V60 retained gaps differ: ' + json.dumps(probes))
            require(snapshot(database) == upgraded, 'Gap probes changed retained rows')
            outcomes[('restored_' if is_restored else 'canonical_') + 'gap_rules'] = probes
            check(database, 'V59_OPERATIONAL_READINESS_SQL', 'EXPECTED_V59_OPERATIONAL_READINESS')
            refused = local.sql(database, V60_COMPATIBILITY_DRIFT_SQL)
            require(refused == 'compatibility drift refused', 'V40 drift-refusal proof failed')
            check(database, 'V59_OPERATIONAL_READINESS_SQL', 'EXPECTED_V59_OPERATIONAL_READINESS')
            print('[V60 compatibility] PASS exact V59 success rows and V40 drift refusal on ' + ('restored' if is_restored else 'canonical'), flush=True)
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
        (temporary / "v59-v60-restore-evidence.json").write_text(json.dumps(evidence, indent=2) + "\n")
        print("[restored V60] PASS retained V59 rows, exact canonical/restored readiness, gap rules and V59 compatibility", flush=True)
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
