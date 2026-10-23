#!/usr/bin/env python3
"""Prove V59 records survive read-only MCP authorization installation and restored connections retain their access boundary."""
import hashlib
import json
import os
from pathlib import Path
import signal
import sys

from local_postgres_verification import ACL_SQL, CONSTRAINT_SQL, PAIR_PATH, LocalPostgres, normalization_plan, require

MIGRATION = "20261022233855_flexible_read_mcp.sql"
SEED_SQL = r"""
BEGIN;
INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,email_confirmed_at,created_at,updated_at)
VALUES('00000000-0000-4000-8000-000000006101','authenticated','authenticated','mcp-retained@example.invalid','{}','{}',now(),now(),now());
INSERT INTO public.studios(id,name,slug,owner_id,timezone)
VALUES('00000000-0000-4000-8000-000000006102','MCP retained studio','mcp-retained-studio','00000000-0000-4000-8000-000000006101','America/Los_Angeles');
INSERT INTO public.staff_roles(user_id,studio_id,role)
VALUES('00000000-0000-4000-8000-000000006101','00000000-0000-4000-8000-000000006102','admin') ON CONFLICT DO NOTHING;
COMMIT;
SELECT 'seeded';
"""


def require_v60_snapshot(before, after):
    expected = json.loads(json.dumps(before))
    rows = expected['private.koaryu_release_v31_expectations']
    require(len(rows) == 1 and rows[0]['expectation_key'] == 'operational_contract_v31'
            and rows[0]['expected_sha256'] == '1513ff10defced0c619f85c7927259165f6c9eb7ef1400be076f567fd39c85b3',
            'V60 requires the exact V59 expectation singleton')
    rows[0]['expected_sha256'] = '5ffe9cc634eadd091b227bdb2e291bc3be209a4cd6de9f4448e29c8ba701f50c'
    return after == expected


MCP_GRANT_SEED = r"""
SELECT public.authorize_mcp_connection(
 '00000000-0000-4000-8000-000000006101','00000000-0000-4000-8000-000000006102',
 '00000000-0000-4000-8000-000000006105','Restore assistant','00000000-0000-4000-8000-000000006106',
 ARRAY['schedule','students'],'https://mcp.example.invalid/mcp',now()+interval '1 day');
SET ROLE supabase_auth_admin;
SELECT public.mcp_access_token_hook('{"user_id":"00000000-0000-4000-8000-000000006101","authentication_method":"oauth_provider/authorization_code","claims":{"sub":"00000000-0000-4000-8000-000000006101","aud":"authenticated","role":"authenticated","client_id":"00000000-0000-4000-8000-000000006105","session_id":"00000000-0000-4000-8000-000000006107"}}');
RESET ROLE;
"""


def verify_populated_mcp_restore(local, database, pg_dump, pg_restore, createdb, temporary):
    source = f'koaryu_mcp_backup_source_{os.getpid()}'
    restored = f'koaryu_mcp_backup_restored_{os.getpid()}'
    dump = temporary / f'mcp-populated-{os.getpid()}.dump'
    owned = []
    try:
        local.run([createdb, *local.connection, '--template='+database, source]); owned.append(source)
        local.sql(source, MCP_GRANT_SEED)
        before = local.sql(source, 'SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM public.mcp_connections c;')
        local.run([pg_dump, *local.connection, '--dbname='+source, '--format=custom', '--file='+str(dump)])
        local.run([createdb, *local.connection, restored]); owned.append(restored)
        local.run([pg_restore, *local.connection, '--dbname='+restored, '--exit-on-error', str(dump)])
        require(local.sql(restored, 'SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM public.mcp_connections c;') == before,
                'Logical restore changed a connection, grant, expiry or session binding')
        refreshed = local.sql(restored, MCP_GRANT_SEED[MCP_GRANT_SEED.index('SET ROLE'):].replace('oauth_provider/authorization_code', 'token_refresh'))
        require('https://mcp.example.invalid/mcp' in refreshed and 'koaryu_connection_id' in refreshed,
                'Restored native Auth hook cannot refresh the retained connection')
        print('[V60 populated restore] PASS connection and session preservation', flush=True)
    finally:
        for name in reversed(owned):
            local.sql('postgres', f'DROP DATABASE {name} WITH (FORCE);')
        dump.unlink(missing_ok=True)


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
        "V59_TIMEZONE_TABLE_STATE_SQL", "EXPECTED_V59_TIMEZONE_TABLE_STATE", "EXPECTED_V59_RESTORED_TIMEZONE_TABLE_STATE",
        "FINAL_OPERATIONAL_READINESS_SQL", "EXPECTED_OPERATIONAL_READINESS",
        "V60_MCP_TABLE_STATE_SQL", "EXPECTED_V60_MCP_TABLE_STATE", "EXPECTED_V60_RESTORED_MCP_TABLE_STATE",
        "V60_MCP_FUNCTION_STATE_SQL", "EXPECTED_V60_MCP_FUNCTION_STATE",
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
            "AND n.nspname IN ('public','private','auth') AND n.nspname||'.'||c.relname<>'public.mcp_connections';"))
        fields = ["SELECT '" + table + "' AS name,(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::TEXT COLLATE \"C\"),'[]') FROM " + table + " t) AS rows" for table in tables]
        return json.loads(local.sql(database, "SET TIME ZONE 'UTC'; SELECT jsonb_object_agg(name,rows) FROM (" + " UNION ALL ".join(fields) + ") retained;"))

    def predecessor(database, restored=False):
        check(database, "V59_OPERATIONAL_READINESS_SQL", "EXPECTED_V59_OPERATIONAL_READINESS")
        check(database, "V59_TIMEZONE_TABLE_STATE_SQL", "EXPECTED_V59_RESTORED_TIMEZONE_TABLE_STATE" if restored else "EXPECTED_V59_TIMEZONE_TABLE_STATE")
        require(local.sql(database, "SELECT count(*)=154 AND max(version)='20261014083106' FROM supabase_migrations.schema_migrations;") == "t",
                "Restore requires the actual V59 history")
        require(local.sql(database, "SELECT to_regprocedure('public.koaryu_release_schema_preflight_v41()') IS NULL AND to_regprocedure('public.mcp_access_token_hook(jsonb)') IS NULL AND to_regprocedure('public.authorize_mcp_connection(uuid,uuid,uuid,text,uuid,text[],text,timestamp with time zone)') IS NULL;") == "t",
                "Restore predecessor already contains V60 functions")

    predecessor("postgres")
    hashes = {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
              for p in sorted((root / "supabase/migrations").glob("*.sql"))}
    require(len(hashes) == 155 and list(hashes)[-2:] == [
        "20261014083106_timezone_names_reference_v59.sql", MIGRATION], "Unexpected migration inventory")
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
        require(seed == 'seeded', 'MCP predecessor fixture did not seed')
        require(any(row['id'] == '00000000-0000-4000-8000-000000006102' for row in before['public.studios']),
                'MCP restore requires a retained studio')
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
            require(require_v60_snapshot(before, snapshot(database)), "Migration changed retained rows before continuation")
            checks = [
                ("FINAL_OPERATIONAL_READINESS_SQL", "EXPECTED_OPERATIONAL_READINESS"),
                ("V60_MCP_TABLE_STATE_SQL", "EXPECTED_V60_RESTORED_MCP_TABLE_STATE" if is_restored else "EXPECTED_V60_MCP_TABLE_STATE"),
                ("V60_MCP_FUNCTION_STATE_SQL", "EXPECTED_V60_MCP_FUNCTION_STATE"),
            ]
            values = {query: check(database, query, expected) for query, expected in checks}
            upgraded = snapshot(database)
            result = local.sql(database, (root / 'supabase/verification/mcp_read_connections_contract.sql').read_text())
            require(result == 'MCP connection ownership, audience, sessions, revocation and deletion passed', 'MCP continuation failed')
            require(snapshot(database) == upgraded, 'MCP continuation changed retained rows')
            check(database, 'V59_OPERATIONAL_READINESS_SQL', 'EXPECTED_V59_OPERATIONAL_READINESS')
            if not is_restored:
                verify_populated_mcp_restore(local, database, pg_dump, pg_restore, createdb, temporary)
            outcomes[('restored_' if is_restored else 'canonical_')+'mcp_continuation'] = result
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
        print("[restored V60] PASS retained V59 rows, exact readiness and read-only connection continuation", flush=True)
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
