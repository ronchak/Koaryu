#!/usr/bin/env python3
"""Prove V58 rows survive V59 timezone reference installation and logical restore with unchanged timezone decisions."""
import hashlib
import json
import os
from pathlib import Path
import signal
import sys

from local_postgres_verification import ACL_SQL, CONSTRAINT_SQL, PAIR_PATH, LocalPostgres, normalization_plan, require

MIGRATION = "20261014083106_timezone_names_reference_v59.sql"
SEED_SQL = r"""
BEGIN;
INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
VALUES('00000000-0000-4000-8000-000000005901','authenticated','authenticated',
       'v59-restore@example.invalid','{}','{}',now(),now());
INSERT INTO public.studios(id,name,slug,owner_id,timezone)
VALUES('00000000-0000-4000-8000-000000005902','V59 retained timezone','v59-retained-timezone',
       '00000000-0000-4000-8000-000000005901','America/Los_Angeles');
COMMIT;
SELECT 'seeded';
"""


def require_v59_snapshot(before, after):
    expected = json.loads(json.dumps(before))
    rows = expected['private.koaryu_release_v31_expectations']
    require(len(rows) == 1 and rows[0]['expectation_key'] == 'operational_contract_v31'
            and rows[0]['expected_sha256'] == 'af3435a9266c9b482f7933dfc6ff5a756ec71fcf9eb7f3cba481e816226e50cb',
            'V59 requires the exact V58 singleton')
    rows[0]['expected_sha256'] = V59_EXPECTATION
    return after == expected

V59_EXPECTATION = '1513ff10defced0c619f85c7927259165f6c9eb7ef1400be076f567fd39c85b3'


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
        "V58_OPERATIONAL_READINESS_SQL", "EXPECTED_V58_OPERATIONAL_READINESS",
        "V58_CATALOG_STATE_SQL", "EXPECTED_V58_CATALOG_STATE", "EXPECTED_V58_RESTORED_CATALOG_STATE",
        "V59_OPERATIONAL_READINESS_SQL", "EXPECTED_V59_OPERATIONAL_READINESS",
        "V59_TIMEZONE_TABLE_STATE_SQL", "EXPECTED_V59_TIMEZONE_TABLE_STATE", "EXPECTED_V59_RESTORED_TIMEZONE_TABLE_STATE",
        "V59_TIMEZONE_FUNCTION_STATE_SQL", "EXPECTED_V59_TIMEZONE_FUNCTION_STATE",
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
        check(database, "V58_OPERATIONAL_READINESS_SQL", "EXPECTED_V58_OPERATIONAL_READINESS")
        check(database, "V58_CATALOG_STATE_SQL", "EXPECTED_V58_RESTORED_CATALOG_STATE" if restored else "EXPECTED_V58_CATALOG_STATE")
        require(local.sql(database, "SELECT count(*)=153 AND max(version)='20261013013243' FROM supabase_migrations.schema_migrations;") == "t",
                "Restore requires the actual V58 history")
        require(local.sql(database, "SELECT to_regprocedure('public.koaryu_release_schema_preflight_v40()') IS NULL AND to_regprocedure('private.timezone_name_known(text)') IS NULL AND to_regprocedure('private.timezone_name_or_utc(text)') IS NULL;") == "t",
                "Restore predecessor already contains V59 functions")

    predecessor("postgres")
    hashes = {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
              for p in sorted((root / "supabase/migrations").glob("*.sql"))}
    require(len(hashes) == 154 and list(hashes)[-2:] == [
        "20261013013243_live_billing_authority_repairs_v58.sql", MIGRATION], "Unexpected migration inventory")
    migration = root / "supabase/migrations" / MIGRATION
    mapping_bytes = Path(__file__).with_name("v57-restore-constraint-pairs.json").read_bytes()
    pairs = json.loads(mapping_bytes)
    source = f"koaryu_v59_source_{os.getpid()}"
    restored = f"koaryu_v59_restore_{os.getpid()}"
    canonical = f"koaryu_v59_canonical_{os.getpid()}"
    dump = temporary / f"v58-before-v59-{os.getpid()}.dump"
    owned, outcomes = [], {}
    try:
        for database, template in [(source, "postgres"), (restored, "template0")]:
            local.run([createdb, *local.connection, "--owner=postgres", f"--template={template}", database])
            owned.append(database)
            local.sql(database, f'ALTER DATABASE {database} SET search_path TO "$user",public,extensions;')
        seed = local.sql(source, SEED_SQL)
        before = snapshot(source)
        require(seed == 'seeded', 'V59 source fixture did not seed')
        require(any(row['id'] == '00000000-0000-4000-8000-000000005902'
                    and row['timezone'] == 'America/Los_Angeles' for row in before['public.studios']),
                'V59 requires a retained named timezone')
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
            require(require_v59_snapshot(before, snapshot(database)), "Migration changed retained rows before continuation")
            checks = [
                ("V59_OPERATIONAL_READINESS_SQL", "EXPECTED_V59_OPERATIONAL_READINESS"),
                ("V59_TIMEZONE_TABLE_STATE_SQL", "EXPECTED_V59_RESTORED_TIMEZONE_TABLE_STATE" if is_restored else "EXPECTED_V59_TIMEZONE_TABLE_STATE"),
                ("V59_TIMEZONE_FUNCTION_STATE_SQL", "EXPECTED_V59_TIMEZONE_FUNCTION_STATE"),
            ]
            values = {query: check(database, query, expected) for query, expected in checks}
            upgraded = snapshot(database)
            result = local.sql(database, (root / 'supabase/verification/timezone_names_reference_contract.sql').read_text())
            require(snapshot(database) == upgraded, 'Timezone continuation changed retained rows')
            outcomes[('restored_' if is_restored else 'canonical_') + 'timezone_continuation'] = result
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
        (temporary / "v58-v59-restore-evidence.json").write_text(json.dumps(evidence, indent=2) + "\n")
        print("[restored V59] PASS retained V58 rows, exact canonical/restored readiness and timezone continuation", flush=True)
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
