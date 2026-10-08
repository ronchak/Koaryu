#!/usr/bin/env python3
"""Common sender proof on one owned local PG17 clone, never a hosted target.

All enclosing source scopes are synthetic. This is not adoption or readiness.
Clock instrumentation changes only disposable owner definitions and a test clock;
actual preparation/attempt timestamps are immutable throughout the proof.
"""

import ast
import hashlib
import itertools
import json
import os
import queue
import re
import subprocess
import sys
import threading
import time
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from importlib.metadata import version
from pathlib import Path
from typing import Any
from uuid import uuid4

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from local_postgres_verification import LocalPostgres, require, install_final_v57

ROOT = Path(__file__).resolve().parents[1]
BASE = "35561d6b8f851ea0309723637e0996a064ba4c82"
BASE_HASH = "cab98ab987acf0c24a383be94f3e0499c6d891b922d7fd1de217e788c2a339b5"
ACCEPTED_DEPENDENCY_BASELINES = {
    "backend/app/services/automation_email.py": "35693d25429678ae77f3a7b5bddd6f3d352c5e5b",
}
MIGRATION = ROOT / "supabase/migrations/20261005105341_automation_workflow_graph_v57.sql"
CONTRACT = ROOT / "supabase/verification/automation_sender_admission_contract.sql"
INVENTORY = """SELECT jsonb_object_agg(p.oid::regprocedure::text,jsonb_build_object(
'definition',pg_get_functiondef(p.oid),'acl',p.proacl::text,'owner',pg_get_userbyid(p.proowner),
'settings',p.proconfig,'volatility',p.provolatile,'security_definer',p.prosecdef))
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname IN ('public','private') AND p.prokind='f';"""
TABLES = ("automation_sender_gate", "automation_sender_preparations", "automation_email_attempt_reservations")


def quote(value):
    if value is None:
        return "NULL"
    if isinstance(value, (dict, list)):
        value = json.dumps(value, separators=(",", ":"))
    return "'" + str(value).replace("'", "''") + "'"


def digest(value):
    return hashlib.sha256(value).hexdigest()


def main(arguments):
    require(len(arguments) in (5, 6), "Expected psql socket port unique-owned-clone evidence-file [--claim-status-only]")
    psql, socket, port, database, evidence_arg = arguments[:5]
    focus = len(arguments) == 6
    require(not focus or arguments[5] == "--claim-status-only", "Unknown proof selection")
    require(re.fullmatch(r"koaryu_sender_admission_[a-z0-9_]+", database), "Invalid owned clone")
    evidence = Path(evidence_arg)
    require(evidence.is_absolute() and not os.path.lexists(evidence), "Evidence path must be new and absolute")
    local = LocalPostgres(psql, socket, port, str(Path(socket).parent))
    temporary = Path(socket).parent
    dump = temporary / (database + ".dump")
    require(not os.path.lexists(dump), "Foreign dump path, including symlink, refused")
    require(local.sql("postgres", f"SELECT NOT EXISTS(SELECT 1 FROM pg_database WHERE datname={quote(database)});") == "t", "Foreign clone exists")
    source = MIGRATION.read_bytes()
    require(local.run(["git", "-C", str(ROOT), "rev-parse", "--is-shallow-repository"]) == "false", "Full Git history required")
    local.run(["git", "-C", str(ROOT), "merge-base", "--is-ancestor", BASE, "HEAD"])
    accepted = subprocess.check_output(["git", "-C", str(ROOT), "show", BASE + ":" + str(MIGRATION.relative_to(ROOT))], env=local.env)
    require(digest(accepted) == BASE_HASH, "Accepted complete execution SQL pin changed")
    dependencies = {}
    dependency_baselines = {}
    for path in (
        "backend/app/schemas/workflow_dispatch.py",
        "backend/app/services/automation_service.py",
        "backend/app/services/automation_email.py",
        "backend/app/services/microsoft_graph_email.py",
        "backend/app/services/automation_coordinator.py",
    ):
        dependency_base = ACCEPTED_DEPENDENCY_BASELINES.get(path, BASE)
        frozen = subprocess.check_output(
            ["git", "-C", str(ROOT), "show", dependency_base + ":" + path],
            env=local.env,
        )
        dependency_baselines[path] = dependency_base
        dependencies[path] = digest(frozen)
        require(
            (ROOT / path).read_bytes() == frozen, "Accepted dependency changed: " + path
        )
    historical = {p.name: digest(p.read_bytes()) for p in sorted(MIGRATION.parent.glob("*.sql")) if p != MIGRATION}
    require(len(historical) == 151, "Expected151 historical migrations")
    for name, checksum in historical.items():
        frozen = subprocess.check_output(["git", "-C", str(ROOT), "show", BASE + ":supabase/migrations/" + name], env=local.env)
        require(digest(frozen) == checksum, "Historical migration changed: " + name)
    baseline = local.sql("postgres", "SELECT row_to_json(p) FROM public.koaryu_release_schema_preflight_v37() p;")
    base = json.loads(baseline)
    require(base["ready"] and base["migration_count"] == 151 and base["migration_head"] == "20261004220435"
            and base["manifest_version"] == "release-db-attestation-v56", "Strict V56 template required")
    pid_file = temporary / "data/postmaster.pid"
    pid = pid_file.read_text().splitlines()[0]
    owned = dump_owned = False
    children, cases, lifetimes, files = [], [], [], []
    report = {
        "source_sha256": digest(source),
        "contract_sha256": digest(CONTRACT.read_bytes()),
        "runner_sha256": digest(Path(__file__).read_bytes()),
        "baseline": BASE,
        "historical": historical,
        "dependencies": dependencies,
        "dependency_baselines": dependency_baselines,
        "cases": cases,
        "lifetimes": lifetimes,
        "source_authority": "synthetic enclosing parents only",
        "proof_scope": "claim_status_only" if focus else "complete_common_sender",
    }

    def sql(statement, role=False):
        return local.sql(database, "SET TIME ZONE 'UTC';\n" + ("SET ROLE service_role;\n" if role else "") + statement)

    def value(statement, role=False):
        return json.loads(sql(statement, role))

    def call(name, *args):
        return value("SELECT to_jsonb(" + name + "(" + ",".join(map(quote, args)) + "));", True)

    def passed(name, **facts):
        cases.append({"case": name, **facts})
        print("[sender admission] PASS " + name, flush=True)

    def create(template="postgres"):
        nonlocal owned
        require(local.sql("postgres", f"SELECT NOT EXISTS(SELECT 1 FROM pg_database WHERE datname={quote(database)});") == "t", "Foreign clone exists")
        local.sql("postgres", f"CREATE DATABASE {database} TEMPLATE {template};")
        owned = True
        lifetimes.append({"action": "create", "database": database, "template": template, "at": time.time()})

    def drop():
        nonlocal owned
        require(owned, "No cleanup authority for database")
        local.sql("postgres", f"DROP DATABASE {database};")
        owned = False
        require(local.sql("postgres", f"SELECT NOT EXISTS(SELECT 1 FROM pg_database WHERE datname={quote(database)});") == "t", "Owned clone remains")
        lifetimes.append({"action": "drop_verified", "database": database, "at": time.time()})

    def apply_file(path):
        return local.run([psql, *local.connection, f"--dbname={database}", "--no-psqlrc", "--set=ON_ERROR_STOP=1", "--single-transaction", "--file", str(path)])

    def reset(mode="ready"):
        sql("UPDATE private.automation_sender_gate SET generation=generation+1,mode=" + quote(mode)
            + ",sender_binding=repeat('a',64),reason=" + ("NULL" if mode == "ready" else "'provider_unavailable'")
            + ",next_probe_at=" + ("clock_timestamp()-INTERVAL '1 second'" if mode == "cooldown" else "NULL")
            + ",transient_failures=0,active_preparation_id=NULL,active_probe_token=NULL,active_attempt_id=NULL,probe_expires_at=NULL;")

    def gate():
        return value("SELECT to_jsonb(g) FROM private.automation_sender_gate g;")

    def preparation(kind="normal", scope=None):
        return call("private.automation_sender_claim_v1", str(uuid4()), "a" * 64, kind, scope)["payload"]

    def prepare(claim, outcome="prepared"):
        revision = value("SELECT revision FROM private.automation_email_credentials WHERE provider_key='microsoft_graph:primary';")
        evidence = {"outcome": outcome, "credential_revision": revision if outcome == "prepared" else None,
                    "sender_binding": "a" * 64, "safe_reason": None if outcome == "prepared" else "provider_unavailable", "retry_after_seconds": None}
        response = call("public.settle_automation_sender_preparation_v1", claim["preparation_id"], claim["preparation_token"], evidence)["payload"]
        return response, revision

    def fixture(kind="workflow", shared=None, do_prepare=True):
        f = {k: str(uuid4()) for k in ("studio", "actor", "scope", "attempt", "owner")}
        f.update(kind=kind, node="email" if kind == "workflow" else None, prior=0 if kind == "legacy" else None)
        if shared:
            f.update(studio=shared["studio"], actor=shared["actor"])
        else:
            sql(f"BEGIN; INSERT INTO auth.users(id,email) VALUES({quote(f['actor'])},{quote(f['actor']+'@example.invalid')});"
                f"INSERT INTO public.studios(id,name,slug,owner_id) VALUES({quote(f['studio'])},'Synthetic sender parent',{quote(f['studio'])},{quote(f['actor'])}); COMMIT;")
        f["email"] = f["studio"] + "@example.invalid"
        if do_prepare:
            f["claim"] = preparation("synthetic_recovery" if kind == "test" else "normal", f["scope"] if kind == "test" else None)
            response, f["revision"] = prepare(f["claim"])
            require(response["outcome"] == "prepared", "Synthetic fixture preparation refused")
        return f

    def begin_sql(f):
        claim = f["claim"]
        args = [f["studio"], f["kind"], f["scope"], f["node"], f["attempt"], f["owner"], f["email"],
                claim["preparation_id"], claim["preparation_token"], claim["probe_token"], f["prior"]]
        return "SELECT private.automation_email_attempt_begin_v1(" + ",".join(map(quote, args)) + ");"

    def begin(f):
        return value(begin_sql(f), True)

    def result(f, outcome="accepted", evidence="accepted", scope=None):
        return {"outcome": outcome, "error_code": None if outcome == "accepted" else "provider_rejected", "provider_request_id": "synthetic-id",
                "retry_after_seconds": None, "submission_evidence": evidence, "failure_scope": scope, "credential_revision": f["revision"]}

    def settle(f, observed=None):
        return call("private.automation_email_attempt_settle_v1", f["attempt"], f["owner"], observed or result(f))

    def session(label, statement, hold=False, role="service_role"):
        name = f"sender_{os.getpid()}_{label}_{len(children)}"[:63]
        process = subprocess.Popen([psql, *local.connection, f"--dbname={database}", "--no-psqlrc", "--quiet", "--tuples-only", "--no-align", "--set=ON_ERROR_STOP=1"],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1, env=local.env)
        item = {"process": process, "name": name, "lines": [], "errors": [], "events": queue.Queue()}
        children.append(item)

        def drain(stream, target, events=None):
            for line in stream:
                target.append(line.rstrip())
                if events is not None:
                    events.put(line.rstrip())

        item["threads"] = [threading.Thread(target=drain, args=(process.stdout, item["lines"], item["events"]), daemon=True),
                           threading.Thread(target=drain, args=(process.stderr, item["errors"]), daemon=True)]
        for thread in item["threads"]:
            thread.start()
        process.stdin.write("\\set VERBOSITY verbose\n" + f"SET application_name={quote(name)}; SET TIME ZONE 'UTC'; BEGIN; SET LOCAL statement_timeout='20s'; SET LOCAL ROLE {role};\n{statement}\n")
        if hold:
            process.stdin.write("SELECT 'RESULT_READY';\n")
            process.stdin.flush()
        else:
            process.stdin.write("COMMIT;\n")
            process.stdin.close()
        return item

    def ready(item):
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            try:
                if item["events"].get(timeout=0.05) == "RESULT_READY":
                    return
            except queue.Empty:
                require(item["process"].poll() is None, "Holder failed: " + "\n".join(item["errors"]))
        raise RuntimeError("Holder barrier timeout")

    def finish(item, success=True, commit=None):
        if commit is not None:
            item["process"].stdin.write("COMMIT;\n" if commit else "ROLLBACK;\n")
            item["process"].stdin.close()
        code = item["process"].wait(timeout=25)
        for thread in item["threads"]:
            thread.join(timeout=2)
        require((code == 0) == success, "Unexpected session result: " + "\n".join(item["errors"]))
        if not success:
            require("P0001" in "\n".join(item["errors"]) and "AUTOMATION_STUDIO_BUSY" in "\n".join(item["errors"]), "Unexpected refusal identity")
        return [json.loads(line) for line in item["lines"] if line.startswith("{")]

    def waiting(item):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            if sql(f"SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname={quote(database)} AND application_name={quote(item['name'])} AND wait_event_type='Lock');") == "t":
                return
            require(item["process"].poll() is None, "Expected waiter exited")
            time.sleep(0.02)
        raise RuntimeError("Expected lock wait was not observed")

    @contextmanager
    def clock_at(at):
        originals = value(INVENTORY)
        sql("CREATE TABLE private.sender_proof_clock(at TIMESTAMPTZ); INSERT INTO private.sender_proof_clock VALUES(" + quote(at) + ");"
            "CREATE FUNCTION private.sender_proof_now() RETURNS TIMESTAMPTZ LANGUAGE sql VOLATILE SET search_path='' AS 'SELECT at FROM private.sender_proof_clock';"
            "GRANT SELECT ON private.sender_proof_clock TO service_role; GRANT EXECUTE ON FUNCTION private.sender_proof_now() TO service_role;")
        changed = {key: row for key, row in originals.items() if key not in retained and "clock_timestamp()" in row["definition"]}
        try:
            for row in changed.values():
                sql(row["definition"].replace("clock_timestamp()", "private.sender_proof_now()"))
            yield lambda instant: sql("UPDATE private.sender_proof_clock SET at=" + quote(instant) + ";")
        finally:
            for row in changed.values():
                sql(row["definition"])
            sql("DROP FUNCTION private.sender_proof_now(); DROP TABLE private.sender_proof_clock;")
            require(value(INVENTORY) == originals, "Clock instrumentation failed exact definition/security restoration")
            passed("disposable clock instrumentation restored exact owners", functions=len(changed))

    def claim_status_checks():
        require(version("postgrest") == "0.17.2", "Pinned PostgREST0.17.2 required")
        contract = CONTRACT.read_text()
        helpers = contract.split("DO $catalog$", 1)[0]
        status_contract = contract.split("-- BEGIN FOCUSED SENDER STATUS CONTRACT", 1)[1].split("-- END FOCUSED SENDER STATUS CONTRACT", 1)[0]
        sql(helpers + status_contract + "\nROLLBACK;")
        passed("focused status contract exact envelope STABLE ACL invalid missing corrupt and zero writes")

        def no_dotenv(event, args):
            if event == "open" and isinstance(args[0], (str, bytes)):
                require(not Path(str(args[0])).name.startswith(".env"), "Dotenv access forbidden")

        sys.addaudithook(no_dotenv)
        sys.path.insert(0, str(ROOT / "backend"))
        import httpx
        from app.schemas import workflow_dispatch as dto
        from postgrest import SyncPostgrestClient
        from postgrest.exceptions import APIError
        from postgrest.utils import SyncClient

        sql("""CREATE FUNCTION private.sender_status_proof(p_key TEXT) RETURNS JSONB
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
BEGIN
    RETURN jsonb_build_object('value',public.get_automation_sender_status_v1(p_key));
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('error',jsonb_build_object('code',SQLSTATE,'message',SQLERRM,'details',NULL,'hint',NULL));
END $$;
GRANT EXECUTE ON FUNCTION private.sender_status_proof(TEXT) TO service_role;""")
        mutation = ""

        class FocusClient(SyncPostgrestClient):
            def create_session(self, base_url, headers, timeout, verify=True, proxy=None):
                def handler(request):
                    name = request.url.path.rsplit("/", 1)[-1]
                    params = json.loads(request.content)
                    if name == "get_automation_sender_status_v1":
                        observed = value("BEGIN; " + mutation + " SET LOCAL ROLE service_role; SET LOCAL statement_timeout='2s'; SELECT private.sender_status_proof("
                                         + quote(params["p_provider_key"]) + "); ROLLBACK;")
                        return httpx.Response(400 if "error" in observed else 200, json=observed.get("error", observed.get("value")))
                    require(name == "claim_automation_sender_preparation_v1", "Unexpected focused SDK function")
                    parsed = dto.PreparationClaimRequest.model_validate(params).model_dump(mode="json")
                    return httpx.Response(200, json=call("public." + name, *parsed.values()))
                return SyncClient(base_url=base_url, headers=headers, timeout=timeout, follow_redirects=False,
                                  trust_env=False, transport=httpx.MockTransport(handler))

        def rows():
            return {table: value("SELECT coalesce(jsonb_agg(jsonb_build_object('row',to_jsonb(t),'xmin',xmin::TEXT,'ctid',ctid::TEXT) ORDER BY to_jsonb(t)::TEXT),'[]') FROM private." + table + " t;") for table in TABLES}

        try:
            with FocusClient("http://sender-proof.invalid") as client:
                for mode in ("ready", "cooldown", "auth_blocked"):
                    reset(mode)
                    before = rows()
                    expected = {"payload": {"mode": mode, "reason": None if mode == "ready" else "provider_unavailable"}}
                    actual = client.rpc("get_automation_sender_status_v1", {"p_provider_key": "microsoft_graph:primary"}).execute().data
                    require(actual == expected and rows() == before, "Actual SDK status shape or zero-write mismatch")
                holder = session("status_no_lock", "SELECT 1 FROM private.automation_sender_gate FOR UPDATE;", True)
                ready(holder)
                require(client.rpc("get_automation_sender_status_v1", {"p_provider_key": "microsoft_graph:primary"}).execute().data == expected, "Status changed under gate lock")
                finish(holder, commit=False)
                corruption = """DO $$ DECLARE r RECORD; BEGIN
FOR r IN SELECT conname FROM pg_constraint WHERE conrelid='private.automation_sender_gate'::REGCLASS AND contype='c' LOOP
EXECUTE format('ALTER TABLE private.automation_sender_gate DROP CONSTRAINT %I',r.conname); END LOOP; END $$;
UPDATE private.automation_sender_gate SET mode='unknown';"""
                for key, mutation, error in (("other", "", ("22023", "AUTOMATION_INVALID_REQUEST")),
                                             (None, "", ("22023", "AUTOMATION_INVALID_REQUEST")),
                                             ("microsoft_graph:primary", "DELETE FROM private.automation_sender_gate;", ("P0001", "AUTOMATION_SENDER_UNAVAILABLE")),
                                             ("microsoft_graph:primary", corruption, ("P0001", "AUTOMATION_SENDER_UNAVAILABLE"))):
                    before = rows()
                    caught = False
                    try:
                        client.rpc("get_automation_sender_status_v1", {"p_provider_key": key}).execute()
                    except APIError as exc:
                        require((exc.code, exc.message) == error, "Actual SDK status error identity changed")
                        caught = True
                    require(caught and rows() == before, "Status refusal mutated state or failed to refuse")
                mutation = ""
                passed("actual installed SDK status read error parsing zero writes and no gate lock")

                def replay(claim):
                    params = {"p_provider_key": "microsoft_graph:primary", "p_preparation_id": claim["preparation_id"], "p_sender_binding": "a" * 64}
                    raw = client.rpc("claim_automation_sender_preparation_v1", params).execute().data
                    dto.Envelope[dto.PreparationClaim].model_validate(raw)
                    return raw["payload"]

                reset()
                pending = preparation()
                require(replay(pending) == pending, "Pending claim replay changed")
                if sql("SELECT count(*) FROM private.automation_email_credentials WHERE provider_key='microsoft_graph:primary';") == "0":
                    call("public.save_automation_email_credential_v1", "microsoft_graph:primary", 0, "synthetic-envelope")
                require(prepare(pending)[0]["outcome"] == "prepared", "Fresh pending grant failed preparation")
                require(replay(pending) == pending, "Current prepared replay changed")
                passed("fresh pending and current prepared claim replay through actual SDK")
                for commit in (False, True):
                    claim = preparation()
                    prepared, revision = prepare(claim)
                    require(prepared["outcome"] == "prepared", "Claim CAS fixture")
                    holder = session("claim_cas", "SELECT public.save_automation_email_credential_v1('microsoft_graph:primary'," + str(revision) + ",'synthetic-cas');", True)
                    ready(holder)
                    command = "SELECT public.claim_automation_sender_preparation_v1('microsoft_graph:primary'," + quote(claim["preparation_id"]) + ",repeat('a',64));"
                    before = gate()
                    finish(session("claim_cas_nowait", command), False)
                    require(gate() == before, "Claim NOWAIT refusal changed gate")
                    finish(holder, commit=commit)
                    current = replay(claim)
                    if commit:
                        require(current["allowed"] is False and current["reason"] == "preparation_stale"
                                and all(current[key] is None for key in ("preparation_token", "probe_token", "lease_expires_at")), "CAS left a stale prepared claim grant")
                    else:
                        require(current == claim, "Rolled-back CAS invalidated current original grant")
                    passed("prepared claim credential SHARE NOWAIT and CAS visibility", commit=commit)
        finally:
            sql("DROP FUNCTION private.sender_status_proof(TEXT);")

    try:
        create()
        readiness = install_final_v57(local, database, ROOT)
        installed = value(INVENTORY)
        passed("complete final catalog body ACL security config and genuine history", readiness=readiness)
        if focus:
            claim_status_checks()
            return
        output = local.run([psql, *local.connection, f"--dbname={database}", "--no-psqlrc", "--set=ON_ERROR_STOP=1", "--file", str(CONTRACT)])
        require("sender admission contract passed" in output, "Contract completion missing")
        passed("complete SQL contract", sha256=report["contract_sha256"])
        call("public.save_automation_email_credential_v1", "microsoft_graph:primary", 0, "synthetic-envelope-no-real-credential")
        reset()
        claim_status_checks()
        reset()
        # Remaining checks are intentionally common-owner checks with synthetic parents.
        require(version("postgrest") == "0.17.2", "Pinned PostgREST0.17.2 required")

        def forbid_dotenv(event, args):
            if event == "open" and isinstance(args[0], (str, bytes)):
                require(not Path(str(args[0])).name.startswith(".env"), "Dotenv access forbidden")

        sys.addaudithook(forbid_dotenv)
        sys.path.insert(0, str(ROOT / "backend"))
        import httpx
        from app.schemas import workflow_dispatch as dto
        from app.services.automation_email import DeliveryResult
        from postgrest import SyncPostgrestClient
        from postgrest.utils import SyncClient

        class SQLClient(SyncPostgrestClient):
            def create_session(self, base_url, headers, timeout, verify=True, proxy=None):
                def handler(request):
                    name = request.url.path.rsplit("/", 1)[-1]
                    require(name in {"claim_automation_sender_preparation_v1", "settle_automation_sender_preparation_v1"}, "Unexpected SDK RPC")
                    params = json.loads(request.content)
                    request_type = dto.PreparationClaimRequest if name.startswith("claim_") else dto.PreparationSettleRequest
                    parsed = request_type.model_validate(params).model_dump(mode="json")
                    response = call("public." + name, *parsed.values())
                    return httpx.Response(200, json=response)
                return SyncClient(base_url=base_url, headers=headers, timeout=timeout, follow_redirects=False,
                                  trust_env=False, transport=httpx.MockTransport(handler))

        with SQLClient("http://sender-proof.invalid") as client:
            sdk_outputs = []

            def sdk_claim(identity=None):
                params = {"p_provider_key": "microsoft_graph:primary", "p_preparation_id": identity or str(uuid4()), "p_sender_binding": "a" * 64}
                raw = client.rpc("claim_automation_sender_preparation_v1", params).execute().data
                parsed = dto.Envelope[dto.PreparationClaim].model_validate(raw).payload
                require(str(parsed.preparation_id) == params["p_preparation_id"], "SDK claim identity differs")
                sdk_outputs.append(raw)
                return raw["payload"]

            def sdk_settle(claim, outcome="prepared", revision=None):
                revision = revision or value("SELECT revision FROM private.automation_email_credentials WHERE provider_key='microsoft_graph:primary';")
                params = {"p_preparation_id": claim["preparation_id"], "p_preparation_token": claim["preparation_token"],
                          "p_result": {"outcome": outcome, "credential_revision": revision if outcome == "prepared" else None,
                                       "sender_binding": "a" * 64, "safe_reason": None if outcome == "prepared" else "provider_unavailable", "retry_after_seconds": None}}
                raw = client.rpc("settle_automation_sender_preparation_v1", params).execute().data
                dto.Envelope[dto.PreparationSettled].model_validate(raw)
                sdk_outputs.append(raw)
                return raw["payload"]

            healthy = sdk_claim()
            require(sdk_claim(healthy["preparation_id"]) == healthy, "SDK same-ID grant changed")
            require(sdk_settle(healthy)["outcome"] == "prepared", "SDK prepare failed")
            require(sdk_settle(healthy)["outcome"] == "prepared", "SDK prepared replay failed")
            revision = value("SELECT revision FROM private.automation_email_credentials WHERE provider_key='microsoft_graph:primary';")
            call("public.save_automation_email_credential_v1", "microsoft_graph:primary", revision, "synthetic-refresh")
            require(sdk_settle(healthy, revision=revision)["outcome"] == "stale", "SDK credential stale missed")
            failure = sdk_claim()
            require(sdk_settle(failure, "sender_transient")["outcome"] == "deferred", "SDK transient branch")
            require(sdk_settle(failure, "sender_transient")["outcome"] == "deferred", "SDK failure replay")
            require(sdk_claim()["allowed"] is False, "SDK cooldown denial")
            sql("UPDATE private.automation_sender_gate SET next_probe_at=clock_timestamp()-INTERVAL '1 second';")
            probe = sdk_claim()
            require(probe["allowed"] and probe["probe_token"] and sdk_claim(probe["preparation_id"]) == probe, "SDK normal cooldown replay family")
            require(sdk_settle(probe)["outcome"] == "prepared", "SDK prepared probe")
            f = fixture(do_prepare=False)
            f.update(claim=probe, revision=revision + 1)
            require(begin(f)["outcome"] == "begun", "SDK probe begin")
            require(sdk_settle(probe)["outcome"] == "stale", "SDK consumed probe stale")
            settle(f, result(f, evidence=None))
            hard = sdk_claim()
            require(sdk_settle(hard, "sender_auth")["outcome"] == "blocked", "SDK hard failure")
            require(sdk_claim()["allowed"] is False, "SDK hard denial")
            require(sdk_settle({"preparation_id": str(uuid4()), "preparation_token": str(uuid4())})["outcome"] == "stale", "SDK missing preparation")
            reset()
            require(sdk_claim(healthy["preparation_id"])["allowed"] is False, "SDK stale replay ready denial")
            passed("actual SQL through installed SDK and accepted preparation DTO branches", replies=len(sdk_outputs), response_sha256=digest(json.dumps(sdk_outputs, sort_keys=True).encode()))

        service_source = ROOT / "backend/app/services/automation_service.py"
        tree = ast.parse(service_source.read_text())
        node = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "_delivery_result")
        namespace = {"Any": Any, "dispatch": dto, "DeliveryResult": DeliveryResult, "re": re}
        # The frozen repository function runs with explicit globals, without service/settings initialization.
        exec(compile(ast.Module(body=[node], type_ignores=[]), str(service_source), "exec"), namespace)  # noqa: S102
        combinations = []
        for outcome, evidence_value, scope, code in itertools.product(
            ["accepted", "retryable_failure", "permanent_failure", "unknown"],
            [None, "not_submitted", "rejected", "accepted", "unknown"],
            [None, "sender_auth", "sender_transient", "message", "unclassified"], sorted(dto.TRANSPORT_CODES)):
            combinations.append({"outcome": outcome, "error_code": code, "provider_request_id": "safe:id", "retry_after_seconds": None,
                                 "submission_evidence": evidence_value, "failure_scope": scope, "credential_revision": 1})
        prototype = combinations[0] | {"outcome": "permanent_failure", "submission_evidence": "rejected", "failure_scope": "unclassified"}
        for field in prototype:
            for bad in [None, True, False, [], {}, "unexpected", 0, 1.5, 86401, 9223372036854775808]:
                combinations.append(prototype | {field: bad})
        expected = []
        for item in combinations:
            observed = object.__new__(DeliveryResult)
            for key, item_value in item.items():
                object.__setattr__(observed, key, item_value)
            expected.append(namespace["_delivery_result"](observed, expected_revision=1).model_dump(mode="json"))
        actual = value("SELECT jsonb_agg(private.automation_delivery_result_v1(value,1) ORDER BY ordinality) FROM jsonb_array_elements("
                       + quote(combinations) + "::jsonb) WITH ORDINALITY;")
        differences = [i for i, pair in enumerate(zip(expected, actual)) if pair[0] != pair[1]]
        require(not differences, "SQL/Python normalization differs at " + str(differences[:10]))
        for item in actual:
            dto.Delivery.model_validate(item)
        passed("all17 transport codes and outcome evidence scope strict-type normalization parity", cases=len(actual), python_source_sha256=digest(service_source.read_bytes()))

        for lock in ("scope", "recipient", "credential", "studio"):
            for commit in (False, True):
                reset()
                f = fixture()
                target = {"scope": "SELECT pg_advisory_xact_lock(hashtextextended('koaryu.automation-email-scope:'||jsonb_build_array("
                          + ",".join(map(quote, [f["studio"], f["kind"], f["scope"], f["node"]])) + ")::text,0));",
                          "recipient": "SELECT pg_advisory_xact_lock(hashtextextended(" + quote(f["studio"] + ":" + f["email"]) + ",0));",
                          "credential": "SELECT 1 FROM private.automation_email_credentials FOR UPDATE;",
                          "studio": "SELECT 1 FROM public.studios WHERE id=" + quote(f["studio"]) + " FOR UPDATE;"}[lock]
                holder = session(lock, target, True)
                ready(holder)
                before = gate()
                refused = session("refused", begin_sql(f))
                finish(refused, False)
                require(gate() == before and sql("SELECT count(*) FROM private.automation_email_attempt_reservations WHERE id=" + quote(f["attempt"]) + ";") == "0", "Busy refusal wrote state")
                finish(holder, commit=commit)
                require(begin(f)["outcome"] == "begun", "Begin did not recover after contention")
                passed("nonblocking " + lock + " refusal and retry", holder_commit=commit)

        for commit in (False, True):
            reset()
            f = fixture()
            holder = session("first_begin", begin_sql(f), True)
            ready(holder)
            contender = dict(f, attempt=str(uuid4()), owner=str(uuid4()))
            finish(session("empty_scope_race", begin_sql(contender)), False)
            finish(holder, commit=commit)
            reply = begin(contender)
            require(reply["outcome"] == ("denied" if commit else "begun"), "Scope ownership race changed ordinal")
            passed("empty scope ordinal race", first_commit=commit)
            reset()
            f = fixture()
            holder = session("recipient_suppression", "SELECT pg_advisory_xact_lock(hashtextextended(" + quote(f["studio"] + ":" + f["email"])
                             + ",0)); INSERT INTO public.automation_suppressions(studio_id,recipient_email) VALUES(" + quote(f["studio"]) + "," + quote(f["email"]) + ");", True)
            ready(holder)
            finish(session("suppressed_begin", begin_sql(f)), False)
            finish(holder, commit=commit)
            require(begin(f)["outcome"] == ("denied" if commit else "begun"), "Suppression visibility differs")
            passed("synthetic suppression first commit rollback", suppression_commit=commit)
            reset()
            f = fixture()
            holder = session("begin_recipient", begin_sql(f), True)
            ready(holder)
            suppressor = session("suppression_waits", "SELECT pg_advisory_xact_lock(hashtextextended(" + quote(f["studio"] + ":" + f["email"])
                                 + ",0)); INSERT INTO public.automation_suppressions(studio_id,recipient_email) VALUES(" + quote(f["studio"]) + "," + quote(f["email"]) + ");")
            waiting(suppressor)
            finish(holder, commit=commit)
            finish(suppressor)
            require(sql("SELECT count(*) FROM public.automation_suppressions WHERE studio_id=" + quote(f["studio"]) + ";") == "1", "Suppression lost after begin")
            passed("common begin first synthetic suppression waits", begin_commit=commit)

        reset("cooldown")
        first_id, second_id = str(uuid4()), str(uuid4())
        holder = session("one_probe", "SELECT public.claim_automation_sender_preparation_v1('microsoft_graph:primary'," + quote(first_id) + ",repeat('a',64));", True)
        ready(holder)
        waiter = session("other_probe", "SELECT public.claim_automation_sender_preparation_v1('microsoft_graph:primary'," + quote(second_id) + ",repeat('a',64));")
        waiting(waiter)
        first = finish(holder, commit=True)[0]["payload"]
        second = finish(waiter)[0]["payload"]
        require(first["allowed"] and not second["allowed"], "Provider admitted parallel probes")
        passed("one provider-wide due probe after real gate wait")

        for late_lock in ("recipient", "credential"):
            reset()
            first, second = fixture("legacy"), fixture()
            first["claim"] = {"preparation_id": None, "preparation_token": None, "probe_token": None}
            target = "SELECT 1 FROM private.automation_email_credentials FOR UPDATE;" if late_lock == "credential" else (
                "SELECT pg_advisory_xact_lock(hashtextextended(" + quote(second["studio"] + ":" + second["email"]) + ",0));")
            holder = session("late_owner", target, True)
            ready(holder)
            failing = session("whole_parent_rollback", begin_sql(first) + "\n" + begin_sql(second))
            finish(failing, False)
            require(sql("SELECT count(*) FROM private.automation_email_attempt_reservations WHERE id=" + quote(first["attempt"]) + ";") == "0", "Earlier enclosing effect survived busy refusal")
            finish(holder, commit=False)
            passed("later refusal rolls back earlier gate-owned effect", late_lock=late_lock)

        for commit in (False, True):
            for stage in ("begin", "recovery"):
                reset("cooldown" if stage == "recovery" else "ready")
                f = fixture()
                if stage == "recovery":
                    require(begin(f)["outcome"] == "begun", "Recovery fixture begin")
                holder = session("credential_cas", "SELECT public.save_automation_email_credential_v1('microsoft_graph:primary',"
                                 + str(f["revision"]) + ",'synthetic-cas-winner');", True)
                ready(holder)
                command = begin_sql(f) if stage == "begin" else "SELECT private.automation_email_attempt_settle_v1(" + ",".join(map(quote, [f["attempt"], f["owner"], result(f)])) + ");"
                finish(session("cas_refusal", command), False)
                finish(holder, commit=commit)
                reply = begin(f) if stage == "begin" else settle(f)
                if stage == "begin":
                    require(reply["outcome"] == ("denied" if commit else "begun"), "CAS begin visibility")
                else:
                    require(reply["state"] == "accepted" and gate()["mode"] == ("cooldown" if commit else "ready"), "CAS recovery visibility")
                    require(gate()["active_attempt_id"] is None, "CAS stale acceptance left terminal probe")
                passed("credential CAS commit rollback " + stage, commit=commit)

        for commit in (False, True):
            reset()
            old, hard = fixture(), fixture()
            begin(old)
            begin(hard)
            settle(hard, result(hard, "permanent_failure", "rejected", "sender_auth"))
            probe = fixture("test")
            begin(probe)
            holder = session("later_hard_failure", "SELECT private.automation_email_attempt_settle_v1(" + ",".join(map(quote, [old["attempt"], old["owner"], result(old, "permanent_failure", "rejected", "sender_auth")])) + ");", True)
            ready(holder)
            waiter = session("probe_acceptance", "SELECT private.automation_email_attempt_settle_v1(" + ",".join(map(quote, [probe["attempt"], probe["owner"], result(probe)])) + ");")
            waiting(waiter)
            finish(holder, commit=commit)
            accepted_reply = finish(waiter)[0]
            require(accepted_reply["state"] == "accepted" and gate()["mode"] == ("auth_blocked" if commit else "ready"), "New failure fencing lost")
            passed("cross-studio hard failure races accepted recovery", failure_commit=commit)

        fixed = datetime(2030, 1, 1, tzinfo=timezone.utc)
        with clock_at(fixed.isoformat()) as advance:
            reset()
            f = fixture()
            begin(f)
            settle(f)
            advance((fixed + timedelta(minutes=60, microseconds=-1)).isoformat())
            second = fixture(shared=f)
            require(begin(second)["reason"] == "rate_limited", "Before60minute boundary admitted")
            advance((fixed + timedelta(minutes=60)).isoformat())
            require(begin(second)["outcome"] == "begun", "Exact60minute boundary refused")
            settle(second)
            advance((fixed + timedelta(hours=2)).isoformat())
            third = fixture(shared=f)
            begin(third)
            settle(third)
            advance((fixed + timedelta(hours=24, microseconds=-1)).isoformat())
            fourth = fixture(shared=f)
            require(begin(fourth)["reason"] == "rate_limited", "Third recent charge ignored")
            advance((fixed + timedelta(hours=24)).isoformat())
            require(begin(fourth)["outcome"] == "begun", "Exact24hour boundary refused")
            passed("instrumented exact60minute24hour and three-charge boundaries")
            reset("cooldown")
            f = fixture()
            preparation_end = datetime.fromisoformat(f["claim"]["lease_expires_at"])
            advance((preparation_end - timedelta(seconds=1)).isoformat())
            begun = begin(f)
            require(begun["outcome"] == "begun", "Live preparation boundary refused")
            advance(preparation_end.isoformat())
            require(prepare(f["claim"])[0]["outcome"] == "stale", "Consumed preparation replay granted")
            require(gate()["probe_expires_at"] == begun["lease_expires_at"], "Probe not transferred to original send lease")
            require(settle(f)["state"] == "accepted" and gate()["mode"] == "ready", "Valid send lease after preparation expiry did not recover")
            passed("instrumented original preparation expiry and immutable send-lease handoff")
            reset("cooldown")
            f = fixture()
            advance(f["claim"]["lease_expires_at"])
            require(begin(f)["reason"] == "preparation_stale", "Exact expired preparation admitted")
            before = gate()
            replacement = preparation()
            require(replacement["allowed"] and gate()["generation"] == before["generation"] and gate()["transient_failures"] == before["transient_failures"], "Unused probe expiry manufactured failure")
            passed("expired unused prepared probe reclaimed with original evidence retained")
            reset("cooldown")
            f = fixture()
            begun = begin(f)
            advance(begun["lease_expires_at"])
            denied = preparation()
            require(not denied["allowed"] and datetime.fromisoformat(denied["retry_at"]) >= datetime.fromisoformat(begun["lease_expires_at"]) + timedelta(seconds=60), "Consumed expiry hint missing")
            require(call("private.automation_email_attempt_expire_v1", f["attempt"])["state"] == "unknown", "Exact send expiry not unknown")
            before = gate()
            require(call("private.automation_email_attempt_expire_v1", f["attempt"])["outcome"] == "refused" and gate() == before, "Expiry counted twice")
            require(settle(f)["outcome"] == "refused", "Late accepted result rewrote unknown")
            passed("exact send expiry unknown reservation once and late acceptance refusal")

        for commit, expired in itertools.product((False, True), repeat=2):
            with clock_at(fixed.isoformat()) as advance:
                reset("cooldown")
                f = fixture()
                begun = begin(f)
                before = gate()
                holder = session("studio_delete", "DELETE FROM public.studios WHERE id=" + quote(f["studio"]) + ";", True, "postgres")
                ready(holder)
                if expired:
                    advance(begun["lease_expires_at"])
                require(call("private.automation_sender_release_orphan_probe_v1") is False, "Uncommitted studio deletion hid visible attempt")
                finish(holder, commit=commit)
                released = call("private.automation_sender_release_orphan_probe_v1")
                require(released == (commit and expired), "Orphan cleanup ignored original expiry/existence")
                stable = ("generation", "mode", "reason", "next_probe_at", "transient_failures", "failed_credential_revision", "sender_binding")
                require(all(gate()[key] == before[key] for key in stable), "Orphan cleanup changed failure state")
                if commit:
                    if not expired:
                        advance(begun["lease_expires_at"])
                    newer = preparation()
                    require(newer["allowed"], "Ordinary claim did not reclaim expired absent attempt")
                    current = gate()
                    require(settle(f)["outcome"] == "refused" and gate() == current, "Late orphan settlement touched newer probe")
                else:
                    require(sql("SELECT count(*) FROM private.automation_email_attempt_reservations WHERE id=" + quote(f["attempt"]) + ";") == "1", "Delete rollback lost attempt")
                passed("real studio cascade orphan expiry and rollback visibility", commit=commit, expired=expired)

        for commit in (False, True):
            reset("cooldown")
            f = fixture()
            begin(f)
            holder = session("delete_vs_settle", "DELETE FROM public.studios WHERE id=" + quote(f["studio"]) + ";", True, "postgres")
            ready(holder)
            waiter = session("late_settle", "SELECT private.automation_email_attempt_settle_v1(" + ",".join(map(quote, [f["attempt"], f["owner"], result(f)])) + ");")
            waiting(waiter)
            finish(holder, commit=commit)
            reply = finish(waiter)[0]
            require(reply["outcome"] == ("refused" if commit else "confirmed"), "Concurrent cascade settlement truth changed")
            passed("actual studio delete versus late settlement", delete_commit=commit)

        print("[sender admission] START real original60second lease window", flush=True)
        reset()
        old = fixture()
        hard_claim = preparation()
        old_begun = begin(old)
        prepare(hard_claim, "sender_auth")
        probe = fixture("test")
        time.sleep(2)
        probe_begun = begin(probe)
        require(probe_begun["lease_expires_at"] > probe["claim"]["lease_expires_at"], "Real send lease did not hand off")
        target = max(datetime.fromisoformat(old_begun["lease_expires_at"]), datetime.fromisoformat(probe["claim"]["lease_expires_at"])) + timedelta(milliseconds=100)
        while datetime.now(timezone.utc) < target:
            time.sleep(min(1, (target - datetime.now(timezone.utc)).total_seconds()))
        require(datetime.now(timezone.utc) < datetime.fromisoformat(probe_begun["lease_expires_at"]), "Real handoff window missed")
        require(settle(old)["state"] == "unknown", "Real late acceptance was not unknown")
        require(prepare(probe["claim"])[0]["outcome"] == "stale", "Real expired preparation granted")
        require(settle(probe)["state"] == "accepted" and gate()["mode"] == "auth_blocked", "Real stale probe erased newer failure")
        passed("real original60second expiry late response and preparation-to-send handoff", old_lease=old_begun["lease_expires_at"], probe_lease=probe_begun["lease_expires_at"])

        reset()
        replay = fixture("legacy")
        begin(replay)
        terminal = settle(replay)
        projection = {"state": "accepted", "reason": None}
        require(call("private.automation_legacy_projection_pin_v1", replay["attempt"], replay["owner"], projection), "Restore projection fixture")

        def snapshot():
            return {table: value("SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]') FROM private." + table + " t;") for table in TABLES}

        def table_facts():
            return value("SELECT jsonb_object_agg(c.relname,jsonb_build_object('owner',pg_get_userbyid(c.relowner),'acl',c.relacl::text,'logged',c.relpersistence,'rls',c.relrowsecurity,"
                         "'constraints',(SELECT jsonb_object_agg(k.conname,pg_get_constraintdef(k.oid)) FROM pg_constraint k WHERE k.conrelid=c.oid),"
                         "'indexes',(SELECT jsonb_object_agg(i.indexrelid::regclass::text,pg_get_indexdef(i.indexrelid)) FROM pg_index i WHERE i.indrelid=c.oid),"
                         "'triggers',(SELECT jsonb_object_agg(t.tgname,pg_get_triggerdef(t.oid)) FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal)))"
                         " FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='private' AND c.relname=ANY(ARRAY[" + ",".join(map(quote, TABLES)) + "]);")

        before_rows, before_facts, before_functions = snapshot(), table_facts(), value(INVENTORY)
        negative_evidence = temporary / (database + "_foreign_evidence.json")
        require(not os.path.lexists(negative_evidence), "Foreign negative evidence path exists")
        negative_command = [sys.executable, "-I", str(Path(__file__).resolve()), psql, socket, port, database, str(negative_evidence)]
        # The outer invocation owns these resources. An inner invocation must treat
        # them as foreign and leave every byte/name untouched on early refusal.
        refusal = subprocess.run(negative_command, capture_output=True, text=True, env=local.env, timeout=30, check=False)
        require(refusal.returncode != 0 and "Foreign clone exists" in refusal.stderr and snapshot() == before_rows, "Foreign clone was not preserved")
        for dangling in (False, True):
            require(not os.path.lexists(dump), "Unexpected preexisting dump")
            if dangling:
                os.symlink(temporary / (database + "_missing_target"), dump)
            else:
                with dump.open("xb") as handle:
                    handle.write(b"foreign sentinel")
            try:
                refusal = subprocess.run(negative_command, capture_output=True, text=True, env=local.env, timeout=30, check=False)
                require(refusal.returncode != 0 and "Foreign dump path" in refusal.stderr, "Foreign dump was not refused")
                require(dump.is_symlink() if dangling else dump.read_bytes() == b"foreign sentinel", "Foreign dump changed")
            finally:
                dump.unlink()
        require(not os.path.lexists(negative_evidence), "Early foreign-resource refusal wrote an evidence file")
        passed("foreign clone file and dangling-symlink preservation on early refusal")
        pg_dump, pg_restore = str(Path(psql).with_name("pg_dump")), str(Path(psql).with_name("pg_restore"))
        local.require_pg17(pg_dump, pg_restore)
        descriptor = os.open(dump, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
        dump_owned = True
        os.close(descriptor)
        local.run([pg_dump, *local.connection, f"--dbname={database}", "--format=custom", f"--file={dump}"])
        dump_hash = digest(dump.read_bytes())
        drop()
        create("template0")
        local.run([pg_restore, *local.connection, f"--dbname={database}", "--exit-on-error", str(dump)])
        require(snapshot() == before_rows and table_facts() == before_facts, "Common logical restore table facts or immutable truth changed")
        require(value(INVENTORY) == before_functions, "Logical restore function/security facts changed")
        restored = settle(replay)
        require(restored == terminal | {"outcome": "replayed"}, "Restored exact terminal replay differs")
        require(call("private.automation_legacy_projection_pin_v1", replay["attempt"], replay["owner"], projection), "Restored projection replay")
        require(digest(dump.read_bytes()) == dump_hash, "Owned dump changed during restore")
        passed("logical restore exact common rows projection catalog ACL functions and replay", dump_sha256=dump_hash)
        require(MIGRATION.read_bytes() == source and digest(CONTRACT.read_bytes()) == report["contract_sha256"], "Proof source changed while running")
        require({p.name: digest(p.read_bytes()) for p in MIGRATION.parent.glob("*.sql") if p != MIGRATION} == historical, "Historical bytes changed")
    except BaseException as exc:
        report["failure"] = {"type": type(exc).__name__, "message": str(exc)}
        raise
    finally:
        for item in children:
            if item["process"].poll() is None:
                item["process"].terminate()
                item["process"].wait(timeout=5)
        if owned:
            drop()
        if dump_owned:
            dump.unlink()
        for path in files:
            path.unlink()
        report["cleanup"] = {"clone_absent": local.sql("postgres", f"SELECT NOT EXISTS(SELECT 1 FROM pg_database WHERE datname={quote(database)});") == "t",
                             "dump_absent": not os.path.lexists(dump), "base_pid_unchanged": pid_file.read_text().splitlines()[0] == pid}
        require(local.sql("postgres", "SELECT row_to_json(p) FROM public.koaryu_release_schema_preflight_v37() p;") == baseline, "Core base preflight changed")
        with evidence.open("x") as handle:
            json.dump(report, handle, indent=2)
            handle.write("\n")
        print(json.dumps({"evidence": str(evidence), "cases": len(cases), "cleanup": report["cleanup"]}), flush=True)


if __name__ == "__main__":
    main(sys.argv[1:])
