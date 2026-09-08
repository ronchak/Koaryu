"""Local PostgreSQL target checks and strict logical-restore normalization.

These helpers accept only the contract verifier's disposable Unix-socket cluster.
They do not create, remove, migrate or select a hosted database.
"""
import json
import os
from pathlib import Path
import re
import stat
import subprocess

PAIR_PATH = Path(__file__).with_name("v38-restore-constraint-pairs.json")

CONSTRAINT_SQL = """
SET search_path=pg_catalog;
SELECT jsonb_object_agg(n.nspname||'.'||c.relname||'.'||k.conname,
 jsonb_build_object('type',k.contype::text,'validated',k.convalidated,
 'local',k.conislocal,'inheritance',k.coninhcount,'no_inherit',k.connoinherit,
 'definition',pg_get_constraintdef(k.oid),'hash',md5(pg_get_constraintdef(k.oid))))
FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid
JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','private');
"""

ACL_SQL = """
SELECT jsonb_object_agg(n.nspname||'.'||c.relname,jsonb_build_object(
 'kind',c.relkind::text,'owner',pg_get_userbyid(c.relowner),
 'acl',coalesce(c.relacl::text,'NULL'),
 'default',acldefault((CASE WHEN c.relkind='S' THEN 'S' ELSE 'r' END)::"char",c.relowner)::text))
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname IN ('public','private') AND c.relkind IN ('r','p','v','m','S');
"""

def require(condition, message):
    if not condition:
        raise RuntimeError(message)

def quoted_identity(identity):
    parts = identity.split(".")
    require(all(re.fullmatch(r"[a-z_][a-z0-9_]*", p) for p in parts), "Unsafe catalog identity")
    return ".".join(f'"{p}"' for p in parts)

def normalization_plan(source, restored, source_acls, restored_acls, pairs):
    """Validate the complete difference set before returning any repair SQL."""
    require(source.keys() == restored.keys(), "Restore constraint identities differ")
    drift = {key for key in source if source[key] != restored[key]}
    require(drift == pairs.keys(), "Restore constraint drift is not the exact approved set")
    expected = dict(source)
    statements = []
    for identity in sorted(drift):
        old, new, pair = source[identity], restored[identity], pairs[identity]
        require(pair["identity"] == identity, "Restore pair identity mismatch")
        require(old["type"] == "c" and old["validated"] is True and old["local"] is True
                and old["inheritance"] == 0 and old["no_inherit"] is False,
                f"Unsupported CHECK metadata: {identity}")
        require(old["hash"] == pair["source_hash"] and old["definition"] == pair["source_definition"]
                and new == {**old, "hash": pair["restored_hash"], "definition": pair["restored_definition"]},
                f"Unapproved CHECK change: {identity}")
        if pair["replay_definition"] is None:
            expected[identity] = new
        else:
            schema, table, constraint = identity.split(".")
            statements.append(f"ALTER TABLE {quoted_identity(schema+'.'+table)} DROP CONSTRAINT {quoted_identity(constraint)}, "
                              f"ADD CONSTRAINT {quoted_identity(constraint)} {pair['replay_definition']};")
    require(len(statements) == 6, "Expected exactly six billing CHECK replays")
    require(source_acls.keys() == restored_acls.keys(), "Restore relation identities differ")
    for identity in sorted(source_acls):
        old, new = source_acls[identity], restored_acls[identity]
        if old == new:
            continue
        require(old["owner"] == "postgres" and old["acl"] == old["default"]
                and new == {**old, "acl": "NULL"}, f"Unapproved ACL change: {identity}")
        kind = "SEQUENCE" if old["kind"] == "S" else "TABLE"
        statements.append(f"REVOKE ALL ON {kind} {quoted_identity(identity)} FROM PUBLIC;")
    return statements, expected

def validate_local_paths(socket, port, temporary):
    require(re.fullmatch(r"/tmp/koaryu-pg\.[A-Za-z0-9]+", str(temporary)) is not None,
            "Expected the local verifier's disposable directory")
    require(socket == temporary / "socket" and port == "5432", "Unexpected local socket or port")
    require(not temporary.is_symlink() and not socket.is_symlink(), "Symlinked local target refused")
    require(stat.S_ISSOCK((socket / f".s.PGSQL.{port}").stat().st_mode), "Expected a live Unix socket")
    require((temporary / "data/postmaster.pid").is_file(), "Local verifier postmaster is missing")

class LocalPostgres:
    def __init__(self, psql, socket, port, temporary):
        self.psql = psql
        self.socket = Path(socket)
        self.temporary = Path(temporary)
        validate_local_paths(self.socket, port, self.temporary)
        self.env = {key: value for key, value in os.environ.items() if not key.startswith("PG")}
        self.env["LC_ALL"] = "C"
        self.connection = [f"--host={self.socket}", f"--port={port}", "--username=postgres", "--no-password"]
        self.require_pg17(psql)
        target = json.loads(self.sql("postgres", "SELECT jsonb_build_object('data',current_setting('data_directory'),"
            "'database',current_database(),'version',current_setting('server_version_num'),"
            "'listen',current_setting('listen_addresses'),'address',inet_server_addr());"))
        require(Path(target["data"]).resolve() == (self.temporary / "data").resolve()
                and target["database"] == "postgres" and target["version"].startswith("17")
                and target["listen"] == "" and target["address"] is None,
                "Connected server is not the caller's isolated PostgreSQL 17 cluster")

    def run(self, command, text=None):
        result = subprocess.run(command, input=text, text=True, capture_output=True,
                                env=self.env, timeout=120)
        require(result.returncode == 0, f"Local PostgreSQL command failed: {result.stderr[-3000:]}")
        return result.stdout.strip()

    def sql(self, database, statement):
        require(re.fullmatch(r"[a-z_][a-z0-9_]*", database) is not None, "Invalid local database name")
        return self.run([self.psql, *self.connection, f"--dbname={database}", "--no-psqlrc",
                         "--set=ON_ERROR_STOP=1", "--quiet", "--tuples-only", "--no-align"], statement)

    def require_pg17(self, *binaries):
        versions = {Path(binary).name: self.run([binary, "--version"]) for binary in binaries}
        require(all(re.search(r"\(PostgreSQL\) 17\.", version) for version in versions.values()),
                "PostgreSQL 17 tools required")
        return versions
