"""Reject unapproved logical-restore changes before returning repair commands.

The actual dump/restore and writer continuation run in the PostgreSQL 17 suite.
"""
from copy import deepcopy
import importlib.util
import json
from pathlib import Path
import subprocess
import sys

import pytest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts/verify-v38-v39-restore-contract.py"
spec = importlib.util.spec_from_file_location("local_postgres_verification", ROOT / "scripts/local_postgres_verification.py")
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


def restore_pair_catalogs():
    pairs = json.loads(guard.PAIR_PATH.read_text())
    metadata = {"type": "c", "validated": True, "local": True, "inheritance": 0, "no_inherit": False}
    source = {key: {**metadata, "hash": pair["source_hash"], "definition": pair["source_definition"]}
              for key, pair in pairs.items()}
    restored = {key: {**metadata, "hash": pair["restored_hash"], "definition": pair["restored_definition"]}
                for key, pair in pairs.items()}
    return pairs, source, restored


def test_restore_normalization_accepts_only_the_reviewed_constraint_changes():
    pairs, source, restored = restore_pair_catalogs()
    statements, expected = guard.normalization_plan(source, restored, {}, {}, pairs)
    assert len(statements) == 6
    assert all("billing_" in statement for statement in statements)
    assert all(expected[key] == (restored[key] if pair["replay_definition"] is None else source[key])
               for key, pair in pairs.items())
    key = next(iter(pairs))
    for field, value in [
        ("definition", restored[key]["definition"].replace("255", "256")),
        ("definition", restored[key]["definition"].replace("[[:cntrl:]]", "[0-9]")),
        ("hash", "0" * 32), ("validated", False), ("type", "f"),
    ]:
        changed = deepcopy(restored)
        changed[key][field] = value
        with pytest.raises(RuntimeError, match="Unapproved CHECK change"):
            guard.normalization_plan(source, changed, {}, {}, pairs)
    for changed in [
        {k: v for k, v in restored.items() if k != key},
        {**restored, "public.unexpected.constraint": restored[key]},
        {**restored, key: source[key]},
    ]:
        with pytest.raises(RuntimeError, match="constraint identities|exact approved set"):
            guard.normalization_plan(source, changed, {}, {}, pairs)
    changed_source = deepcopy(source)
    changed_source[key]["definition"] = "CHECK (true)"
    with pytest.raises(RuntimeError, match="Unapproved CHECK change"):
        guard.normalization_plan(changed_source, restored, {}, {}, pairs)


def test_restore_normalization_does_not_repair_extra_grants_or_ownership():
    pairs, source, restored = restore_pair_catalogs()
    identity = "public.restore_fixture"
    original = {"kind": "r", "owner": "postgres", "acl": "{postgres=arwdDxtm/postgres}",
                "default": "{postgres=arwdDxtm/postgres}"}
    target = {**original, "acl": "NULL"}
    statements, _ = guard.normalization_plan(source, restored, {identity: original}, {identity: target}, pairs)
    assert statements[-1] == 'REVOKE ALL ON TABLE "public"."restore_fixture" FROM PUBLIC;'
    for field, value in [("owner", "service_role"), ("kind", "S"), ("default", "{}"),
                         ("acl", "{postgres=arwdDxtm/postgres,service_role=r/postgres}")]:
        with pytest.raises(RuntimeError, match="Unapproved ACL change"):
            guard.normalization_plan(source, restored, {identity: original}, {identity: {**target, field: value}}, pairs)
    with pytest.raises(RuntimeError, match="relation identities"):
        guard.normalization_plan(source, restored, {identity: original}, {}, pairs)


def test_restore_helper_refuses_remote_or_unowned_targets_before_invoking_tools(tmp_path):
    sentinel = tmp_path / "called"
    executable = tmp_path / "forbidden-tool"
    executable.write_text(f"#!/bin/sh\ntouch '{sentinel}'\nexit 1\n")
    executable.chmod(0o700)
    for socket, port, temporary in [
        ("db.mimguepumzsgmcaycdsh.supabase.co", "5432", str(tmp_path)),
        ("127.0.0.1", "5432", "/tmp/koaryu-pg.example"),
        ("/tmp/koaryu-pg.example/socket", "6543", "/tmp/koaryu-pg.example"),
        (str(tmp_path / "socket"), "5432", str(tmp_path)),
    ]:
        for script, arguments in [
            (SCRIPT, [str(executable)] * 4 + [socket, port, temporary, str(ROOT)]),
            (ROOT / "scripts/verify-v39-v40-restore-contract.py", [str(executable)] * 4 + [socket, port, temporary, str(ROOT)]),
            (ROOT / "scripts/verify-student-write-concurrency.py", [str(executable), socket, port]),
            (ROOT / "scripts/verify-v40-v41-restore-contract.py", [str(executable)] * 4 + [socket, port, temporary, str(ROOT)]),
            (ROOT / "scripts/verify-v41-v42-restore-contract.py", [str(executable)] * 4 + [socket, port, temporary, str(ROOT)]),
            (ROOT / "scripts/verify-v42-v43-restore-contract.py", [str(executable)] * 4 + [socket, port, temporary, str(ROOT)]),
            (ROOT / "scripts/verify-v43-v44-restore-contract.py", [str(executable)] * 4 + [socket, port, temporary, str(ROOT)]),
            (ROOT / "scripts/verify-v44-v45-restore-contract.py", [str(executable)] * 4 + [socket, port, temporary, str(ROOT)]),
            (ROOT / "scripts/verify-billing-command-concurrency.py", [str(executable), socket, port]),
        ]:
            result = subprocess.run([sys.executable, str(script), *arguments], capture_output=True, text=True)
            assert result.returncode != 0
            assert "Expected the local verifier" in result.stderr or "Unexpected local socket or port" in result.stderr
    assert not sentinel.exists()
