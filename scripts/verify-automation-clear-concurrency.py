#!/usr/bin/env python3
"""One owned PG17 clone: real clear owners, cached V44 call and body-free truth.

The final V57 readiness and combined logical restore belong to release closure.
Auth/source fixtures here are synthetic; role checks, RPCs and attempts are real.
"""

import hashlib
import json
import os
import queue
import re
import subprocess
import sys
import threading
import time
from pathlib import Path
from uuid import uuid4

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from local_postgres_verification import LocalPostgres, require

ROOT = Path(__file__).resolve().parents[1]
BASE = "7a3150691f5c29be0452c196f372e3379353c1e9"
BASE_HASH = "39fe92f0a9fb98122d17cbb3adf8e75bfa15f7263c7b4238d0e9e93a24c9dca1"
MIGRATION = (
    ROOT / "supabase/migrations/20261005105341_automation_workflow_graph_v57.sql"
)
CONTRACT = ROOT / "supabase/verification/automation_clear_contract.sql"
MARKER = "\n-- Operational clear owns cancellation and retention"
OLD_GUARD = "IF NOT EXISTS(SELECT 1 FROM public.automation_workflow_runs WHERE studio_id=OLD.studio_id AND id=OLD.run_id AND cancel_requested_at IS NOT NULL)"
NEW_GUARD = "IF NOT EXISTS(SELECT 1 FROM public.automation_workflow_runs WHERE studio_id=OLD.studio_id AND id=OLD.run_id\n        AND (cancel_requested_at IS NOT NULL OR state IN ('completed','failed','cancelled')))"
INVENTORY = """SET search_path=''; SELECT jsonb_object_agg(p.oid::regprocedure::text,jsonb_build_object(
'definition',pg_get_functiondef(p.oid),'acl',p.proacl::text,'owner',pg_get_userbyid(p.proowner),
'settings',p.proconfig,'volatility',p.provolatile,'security_definer',p.prosecdef))
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname IN ('public','private') AND p.prokind='f';"""


def quote(value):
    if value is None:
        return "NULL"
    if isinstance(value, (dict, list)):
        value = json.dumps(value, separators=(",", ":"))
    return "'" + str(value).replace("'", "''") + "'"


def statement(name, params):
    return (
        "SELECT public."
        + name
        + "("
        + ",".join(
            k
            + "=>"
            + (
                "ARRAY[" + ",".join(map(quote, v)) + "]::TEXT[]"
                if isinstance(v, list) and k == "p_allowed_recipients"
                else "true"
                if v is True
                else "false"
                if v is False
                else quote(v)
            )
            for k, v in params.items()
        )
        + ");"
    )


class Sessions:
    def __init__(self, local, database, psql):
        self.local, self.database, self.psql = local, database, psql
        self.children = []

    def start(self, command, hold=True, role="service_role"):
        name = "automation_clear_" + str(os.getpid()) + "_" + str(len(self.children))
        process = subprocess.Popen(
            [
                self.psql,
                *self.local.connection,
                "--dbname=" + self.database,
                "--no-psqlrc",
                "--set=ON_ERROR_STOP=1",
                "--quiet",
                "--tuples-only",
                "--no-align",
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
            env=self.local.env,
        )
        item = {
            "process": process,
            "name": name,
            "lines": [],
            "errors": [],
            "events": queue.Queue(),
            "threads": [],
        }
        self.children.append(item)

        def drain(stream, target):
            for line in stream:
                target.append(line.strip())
                if line.strip() == "RESULT_READY":
                    item["events"].put(True)

        for stream, target in (
            (process.stdout, item["lines"]),
            (process.stderr, item["errors"]),
        ):
            thread = threading.Thread(target=drain, args=(stream, target), daemon=True)
            thread.start()
            item["threads"].append(thread)
        process.stdin.write(
            "SET application_name="
            + quote(name)
            + "; SET statement_timeout='20s'; BEGIN; SET ROLE "
            + role
            + ";\n"
            + command
            + "\nSELECT 'RESULT_READY';\n"
        )
        if hold:
            process.stdin.flush()
        else:
            process.stdin.write("COMMIT;\n")
            process.stdin.close()
        return item

    def ready(self, item):
        end = time.monotonic() + 10
        while time.monotonic() < end:
            try:
                if item["events"].get(timeout=0.05):
                    return
            except queue.Empty:
                require(
                    item["process"].poll() is None,
                    "Holder failed " + str(item["errors"]),
                )
        raise RuntimeError("Holder barrier timeout")

    def finish(self, item, expected_error=None):
        code = item["process"].wait(timeout=25)
        for thread in item["threads"]:
            thread.join(timeout=2)
        if expected_error:
            require(
                code != 0 and expected_error in "\n".join(item["errors"]),
                "Expected session error " + str(item["errors"]),
            )
        else:
            require(code == 0, "Session failed " + str(item["errors"]))
        rows = [json.loads(line) for line in item["lines"] if line.startswith("{")]
        return rows[-1] if rows else None

    def release(self, item, rollback=False):
        item["process"].stdin.write("ROLLBACK;\n" if rollback else "COMMIT;\n")
        item["process"].stdin.close()
        return self.finish(item)

    def blocked(self, holder, waiter):
        end = time.monotonic() + 8
        while time.monotonic() < end:
            require(
                waiter["process"].poll() is None,
                "Waiter exited " + str(waiter["errors"]),
            )
            if (
                self.local.sql(
                    self.database,
                    "SELECT EXISTS(SELECT 1 FROM pg_stat_activity h JOIN pg_stat_activity w ON h.pid=ANY(pg_blocking_pids(w.pid)) WHERE h.application_name="
                    + quote(holder["name"])
                    + " AND w.application_name="
                    + quote(waiter["name"])
                    + ");",
                )
                == "t"
            ):
                return
            time.sleep(0.025)
        raise RuntimeError("Missing observed blocking relation")

    def close(self):
        for child in self.children:
            process = child["process"]
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
            for thread in child["threads"]:
                thread.join(timeout=2)


def main(args):
    require(
        len(args) == 5,
        "Expected psql socket port unique-owned-clone new-private-evidence-file",
    )
    psql, socket, port, database, output = args
    require(
        re.fullmatch(r"koaryu_automation_clear_[a-z0-9_]+", database),
        "Unsafe clone name",
    )
    evidence = Path(output)
    require(
        evidence.is_absolute() and not os.path.lexists(evidence),
        "Evidence must be a new absolute path",
    )
    require(
        not evidence.is_relative_to(ROOT), "Evidence must remain outside repository"
    )
    local = LocalPostgres(psql, socket, port, str(Path(socket).parent))
    pid_path = Path(socket).parent / "data/postmaster.pid"
    observed_pid = pid_path.read_text().splitlines()[0]
    baseline = local.sql(
        "postgres",
        "SELECT row_to_json(p) FROM public.koaryu_release_schema_preflight_v37() p;",
    )
    b = json.loads(baseline)
    require(
        b["ready"]
        and b["migration_count"] == 151
        and b["migration_head"] == "20261004220435"
        and b["manifest_version"] == "release-db-attestation-v56",
        "Strict V56 template required",
    )
    require(
        local.sql(
            "postgres",
            f"SELECT NOT EXISTS(SELECT 1 FROM pg_database WHERE datname={quote(database)});",
        )
        == "t",
        "Foreign clone refused",
    )
    local.run(["git", "-C", str(ROOT), "merge-base", "--is-ancestor", BASE, "HEAD"])
    accepted = subprocess.check_output(
        ["git", "-C", str(ROOT), "show", BASE + ":" + str(MIGRATION.relative_to(ROOT))],
        env=local.env,
    )
    require(
        hashlib.sha256(accepted).hexdigest() == BASE_HASH, "Accepted source pin differs"
    )
    source = MIGRATION.read_bytes()
    prefix, suffix = source.decode().split(MARKER, 1)
    require(
        prefix == accepted.decode().replace(OLD_GUARD, NEW_GUARD),
        "Only the named terminal payload guard hunk may change before clear suffix",
    )
    guard = prefix.split(
        "CREATE FUNCTION private.workflow_email_payload_delete_v1()", 1
    )[1].split("END $$;", 1)[0]
    delta = (
        "CREATE OR REPLACE FUNCTION private.workflow_email_payload_delete_v1()"
        + guard
        + "END $$;\n"
        + MARKER
        + suffix
    )
    historical = {
        p.name: hashlib.sha256(p.read_bytes()).hexdigest()
        for p in MIGRATION.parent.glob("*.sql")
        if p != MIGRATION
    }
    require(len(historical) == 151, "151 historical files required")
    files = [MIGRATION, CONTRACT, Path(__file__)]
    frozen = {
        str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest()
        for p in files
    }
    owned = False
    installed = None
    sessions = Sessions(local, database, psql)
    cases = []
    diagnostics = []
    start = time.monotonic()

    def sql(command):
        return local.sql(database, "SET TIME ZONE 'UTC';\n" + command)

    def value(command):
        return json.loads(sql(command))

    def passed(name, **details):
        cases.append({"case": name, "outcome": "passed", **details})
        print("[clear] PASS " + name, flush=True)

    try:
        print("[clear] copy strict V56 template to owned clone " + database, flush=True)
        local.sql("postgres", f"CREATE DATABASE {database} TEMPLATE postgres;")
        owned = True
        sql("BEGIN;\n" + accepted.decode() + "\nCOMMIT;")
        retained = value(INVENTORY)
        fixtures = (
            CONTRACT.read_text()
            .split("-- fixture owners start.")[1]
            .split("-- fixture owners end.")[0]
        )
        sql(
            "CREATE SCHEMA clear_proof;\n"
            + fixtures.replace("pg_temp.", "clear_proof.")
            + """
CREATE FUNCTION clear_proof.rpc(statement TEXT) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE got JSONB; code TEXT; message TEXT;
BEGIN BEGIN EXECUTE statement INTO got; RETURN jsonb_build_object('ok',true,'data',got);
EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS code=RETURNED_SQLSTATE,message=MESSAGE_TEXT;
RETURN jsonb_build_object('ok',false,'error',jsonb_build_object('code',code,'message',message,'details',NULL,'hint',NULL)); END; END $$;
GRANT USAGE ON SCHEMA clear_proof TO service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA clear_proof TO service_role;"""
        )
        # Actual old OID/body is executing, not a copied surrogate function.
        x = value("SELECT clear_proof.clear_fixture();")
        sql(
            "INSERT INTO public.automation_rules(studio_id,enabled,inactivity_days,subject_template,body_template,reply_to_email,revision) VALUES("
            + quote(x["studio"])
            + ",true,14,'Subject','Body','reply@example.invalid',1); DELETE FROM public.programs WHERE studio_id="
            + quote(x["studio"])
            + ";"
        )
        holder = sessions.start(
            "SELECT pg_advisory_xact_lock_shared(hashtextextended('koaryu.local-plan-clear:'||"
            + quote(x["studio"])
            + ",0));"
        )
        sessions.ready(holder)
        old = sessions.start(
            "UPDATE public.studios SET name='old transaction must roll back' WHERE id="
            + quote(x["studio"])
            + "; SELECT public.clear_studio_operational_data_atomic("
            + quote(x["studio"])
            + ");",
            hold=False,
        )
        sessions.blocked(holder, old)
        sql("BEGIN;\n" + delta + "\nCOMMIT;")
        installed = value(INVENTORY)
        allowed = {
            "public.clear_studio_operational_data_atomic(uuid,boolean)",
            "private.workflow_email_payload_delete_v1()",
        }
        # regprocedure prints spaces after commas on some PostgreSQL builds.
        changed = {
            k.replace(", ", ",") for k, v in retained.items() if installed.get(k) != v
        }
        require(
            changed == allowed, "Unexpected retained function delta " + str(changed)
        )
        old_void = next(
            v
            for k, v in retained.items()
            if k.replace(", ", ",") in allowed and k.startswith("public.")
        )
        new_void = next(
            v
            for k, v in installed.items()
            if k.replace(", ", ",") in allowed and k.startswith("public.")
        )
        require(
            all(old_void[k] == new_void[k] for k in old_void if k != "definition"),
            "Old VOID authority changed",
        )
        sessions.release(holder)
        sessions.finish(old, "AUTOMATION_STUDIO_BUSY")
        require(
            sql("SELECT name FROM public.studios WHERE id=" + quote(x["studio"]) + ";")
            == "Clear fixture",
            "Old transaction did not roll back",
        )
        require(
            sql(
                "SELECT enabled FROM public.automation_rules WHERE studio_id="
                + quote(x["studio"])
                + ";"
            )
            == "t",
            "Old call silently mutated rule",
        )
        fresh = value(
            "SET ROLE service_role; SELECT public.clear_studio_operational_data_v2("
            + quote(x["studio"])
            + ");"
        )["payload"]
        require(
            fresh["workflows_paused"] == 1 and fresh["attendance_rule_paused"],
            "Fresh owner failed empty studio",
        )
        passed(
            "actual cached V44 EMPTY clear crosses replacement, fails whole transaction and fresh owner succeeds"
        )
        passed(
            "exact retained definition delta and VOID default ACL owner configuration"
        )
        passed("focused clear SQL contract", output=sql(CONTRACT.read_text()))
        # Reuse the accepted source fixtures, without re-running their matrices.
        graph = (
            (ROOT / "supabase/verification/workflow_graph_mail_contract.sql")
            .read_text()
            .split("CREATE FUNCTION pg_temp.advance_graph", 1)[1]
            .split("\nDO $$", 1)[0]
        )
        tests = (
            (ROOT / "supabase/verification/automation_test_email_contract.sql")
            .read_text()
            .split("-- fixture owners start.")[1]
            .split("-- fixture owners end.")[0]
        )
        sql(
            ("CREATE FUNCTION pg_temp.advance_graph" + graph + tests).replace(
                "pg_temp.", "clear_proof."
            )
            + "\nGRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA clear_proof TO service_role;"
        )
        run_proof(sql, value, passed, sessions)
        sql("DROP SCHEMA clear_proof CASCADE;")
        require(value(INVENTORY) == installed, "Proof changed installed functions")
        passed("temporary proof owners restored exactly")
    except Exception as exc:
        diagnostics.append({"type": type(exc).__name__, "message": str(exc)})
        raise
    finally:
        sessions.close()
        require(
            local.sql(
                "postgres",
                "SELECT count(*) FROM pg_stat_activity WHERE datname="
                + quote(database)
                + ";",
            )
            == "0",
            "Owned sessions remain before clone cleanup",
        )
        if owned:
            local.sql("postgres", f"DROP DATABASE {database};")
        absent = (
            local.sql(
                "postgres",
                f"SELECT NOT EXISTS(SELECT 1 FROM pg_database WHERE datname={quote(database)});",
            )
            == "t"
        )
        require(absent, "Owned clone remains")
        require(
            pid_path.read_text().splitlines()[0] == observed_pid,
            "Observed postmaster changed",
        )
        require(
            local.sql(
                "postgres",
                "SELECT row_to_json(p) FROM public.koaryu_release_schema_preflight_v37() p;",
            )
            == baseline,
            "Template state changed",
        )
        require(
            historical
            == {
                p.name: hashlib.sha256(p.read_bytes()).hexdigest()
                for p in MIGRATION.parent.glob("*.sql")
                if p != MIGRATION
            },
            "Historical files changed",
        )
        require(
            frozen
            == {
                str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest()
                for p in files
            },
            "Frozen source changed during proof",
        )
        report = {
            "base": BASE,
            "files": frozen,
            "cases": cases,
            "diagnostics": diagnostics,
            "elapsed_seconds": round(time.monotonic() - start, 3),
            "boundary": "real local RPC/SDK/role/attempt owners; synthetic Auth/data; final readiness/combined restore separate",
            "cleanup": {
                "clone_absent": absent,
                "owned_sessions_absent": True,
                "template_unchanged": True,
                "observed_postmaster_pid": observed_pid,
            },
        }
        with evidence.open("x") as out:
            os.chmod(evidence, 0o600)
            json.dump(report, out, indent=2)
            out.write("\n")
        print(
            "[clear] owned clone/sessions absent; strict V56 template and observed postmaster unchanged",
            flush=True,
        )


def run_proof(sql, value, passed, sessions):
    def no_dotenv(event, args):
        if event == "open" and isinstance(args[0], (str, bytes)):
            require(
                not Path(str(args[0])).name.startswith(".env"), "Dotenv read forbidden"
            )

    sys.addaudithook(no_dotenv)
    sys.path.insert(0, str(ROOT / "backend"))
    from importlib.metadata import version

    import httpx
    from app.schemas import workflow_dispatch as graph_dto
    from app.schemas.demo import AutomationClearEffects
    from app.services import workflow_test_email_service as test_dto
    from app.services.automation_email import assemble_synthetic_test_email
    from app.services.automation_service import _dispatch_rpc
    from app.services.demo_data_access import DemoDataAccess
    from app.services.workflow_email import render_workflow_email
    from app.services.workflow_simulation_service import (
        _decode_facts,
        build_synthetic_workflow_facts,
    )
    from fastapi import HTTPException
    from postgrest import SyncPostgrestClient
    from postgrest.utils import SyncClient

    require(version("postgrest") == "0.17.2", "Pinned installed SDK required")
    requests = []
    lost = set()

    class SQLClient(SyncPostgrestClient):
        def create_session(self, base_url, headers, timeout, verify=True, proxy=None):
            def handler(request):
                name = request.url.path.rsplit("/", 1)[-1]
                require(
                    request.method == "POST" and re.fullmatch("[a-z_0-9]+", name),
                    "Unexpected SDK operation",
                )
                observed = value(
                    "SET ROLE service_role; SELECT clear_proof.rpc("
                    + quote(statement(name, json.loads(request.content)))
                    + ");"
                )
                requests.append({"rpc": name, "ok": observed["ok"]})
                if name in lost:
                    raise httpx.ReadError("Synthetic lost reply after commit")
                return httpx.Response(
                    200 if observed["ok"] else 400,
                    json=observed.get("data", observed.get("error")),
                )

            return SyncClient(
                base_url=base_url,
                headers=headers,
                timeout=timeout,
                trust_env=False,
                follow_redirects=False,
                transport=httpx.MockTransport(handler),
            )

    def rpc(name, params):
        return client.rpc(name, params).execute().data

    def clear(x):
        before = len(requests)
        got = DemoDataAccess(client).clear_studio_surface(
            x["studio"], include_platform_rows=False
        )
        require(
            isinstance(got, AutomationClearEffects) and len(requests) == before + 1,
            "Clear must parse exact DTO once",
        )
        return got.model_dump()

    def fail(command, message="AUTOMATION_STUDIO_BUSY"):
        got = value(
            "SET ROLE service_role; SELECT clear_proof.rpc(" + quote(command) + ");"
        )
        require(
            not got["ok"] and got["error"]["message"] == message,
            "Expected " + message + ", got " + str(got),
        )

    def snapshot(x):
        return value(
            "SELECT jsonb_build_object('workflow',(SELECT jsonb_agg(to_jsonb(w) ORDER BY id) FROM public.automation_workflows w WHERE studio_id="
            + quote(x["studio"])
            + "),'runs',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM public.automation_workflow_runs r WHERE studio_id="
            + quote(x["studio"])
            + "),'rule',(SELECT to_jsonb(r) FROM public.automation_rules r WHERE studio_id="
            + quote(x["studio"])
            + "),'attempts',(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM private.automation_email_attempt_reservations a WHERE studio_id="
            + quote(x["studio"])
            + "),'programs',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM public.programs p WHERE studio_id="
            + quote(x["studio"])
            + "));"
        )

    def reset_gate():
        # Independent local schedules start from the same synthetic provider state.
        # This never runs inside clear and is not a sender-recovery claim.
        sql(
            "UPDATE private.automation_sender_gate SET generation=generation+1,mode='ready',reason=NULL,next_probe_at=NULL,transient_failures=0,active_preparation_id=NULL,active_probe_token=NULL,active_attempt_id=NULL,probe_expires_at=NULL,updated_at=clock_timestamp();"
        )

    def delivery(outcome="accepted"):
        return graph_dto.Delivery(
            outcome=outcome,
            error_code=None if outcome == "accepted" else "provider_submission_unknown",
            provider_request_id="synthetic-clear-proof",
            retry_after_seconds=None,
            submission_evidence=outcome,
            failure_scope=None if outcome == "accepted" else "unclassified",
            credential_revision=1,
        )

    def preparation():
        c = _dispatch_rpc(
            client,
            "claim_automation_sender_preparation_v1",
            graph_dto.PreparationClaimRequest(
                p_provider_key="microsoft_graph:primary",
                p_preparation_id=uuid4(),
                p_sender_binding="a" * 64,
            ),
            graph_dto.PreparationClaim,
        )
        require(c.allowed, "Synthetic preparation denied")
        got = _dispatch_rpc(
            client,
            "settle_automation_sender_preparation_v1",
            graph_dto.PreparationSettleRequest(
                p_preparation_id=c.preparation_id,
                p_preparation_token=c.preparation_token,
                p_result=graph_dto.PreparationResult(
                    outcome="prepared",
                    credential_revision=1,
                    sender_binding="a" * 64,
                    safe_reason=None,
                    retry_after_seconds=None,
                ),
            ),
            graph_dto.PreparationSettled,
        )
        require(got.outcome == "prepared", "Synthetic preparation failed")
        return got

    def graph_fixture():
        x = value(
            "SELECT clear_proof.advance_seed(clear_proof.advance_fixture(),'lead.stage_changed',clear_proof.advance_path('lead.stage_changed','email'));"
        )
        x = value("SELECT clear_proof.advance_claim(" + quote(x) + ");")
        require(
            value("SELECT clear_proof.advance_call(" + quote(x) + ");")["payload"][
                "outcome"
            ]
            == "email",
            "Actual email step missing",
        )
        return x

    def graph_scope(x):
        return {
            "p_studio_id": x["studio"],
            "p_run_id": x["run"],
            "p_claim_token": x["token"],
            "p_node_id": "work",
            "p_allowed_recipients": [],
            "p_default_reply_to": "reply@example.invalid",
            "p_public_api_url": "https://mail.example.invalid/api/v1",
        }

    def plan(x):
        return _dispatch_rpc(
            client,
            "get_workflow_email_plan_v1",
            graph_dto.PlanRequest(
                **graph_scope(x),
                p_candidate_unsubscribe_token=hashlib.sha256(
                    x["run"].encode()
                ).hexdigest(),
            ),
            graph_dto.Planned,
        ).plan

    def graph_begin_request(x, p, prep=None):
        prep = prep or preparation()
        facts = _decode_facts(p.facts, p.event_type, frozenset({p.recipient_policy}))
        content = render_workflow_email(
            p.event_type,
            p.subject_template,
            p.body_template,
            {
                **facts.template_facts,
                **facts.recipients[p.recipient_policy].template_facts,
            },
            unsubscribe_url=p.unsubscribe_url,
        )
        return graph_dto.BeginRequest(
            **graph_scope(x),
            p_plan_fingerprint=p.fingerprint,
            p_unsubscribe_token=p.unsubscribe_token,
            p_rendered=graph_dto.Rendered(
                subject=content.subject,
                text_body=content.text_body,
                html_body=content.html_body,
            ),
            p_preparation_id=prep.preparation_id,
            p_preparation_token=prep.preparation_token,
            p_probe_token=prep.probe_token,
        )

    def graph_begin(x, p):
        return _dispatch_rpc(
            client,
            "begin_workflow_email_v1",
            graph_begin_request(x, p),
            graph_dto.Begun,
        )

    def graph_settle(x, b, result=None):
        return _dispatch_rpc(
            client,
            "settle_workflow_email_v1",
            graph_dto.SettleRequest(
                p_studio_id=x["studio"],
                p_attempt_id=b.attempt.id,
                p_claim_token=x["token"],
                p_result=result or delivery(),
            ),
            graph_dto.Settled,
        )

    runtime = test_dto.Runtime(
        sender_binding="a" * 64,
        default_reply_to="reply@example.invalid",
        allowed_recipients=[],
    )

    def test_fixture(x=None):
        x = x or value("SELECT clear_proof.test_email_fixture();")
        req = test_dto.ReserveRequest(
            p_studio_id=x["studio"],
            p_actor_id=x["actor"],
            p_workflow_id=x["workflow"],
            p_operation_id=uuid4(),
            p_graph=x["graph"],
            p_email_node_id="mail",
            p_runtime=runtime,
            p_replay_only=False,
        )
        got = test_dto._test_rpc(client, test_dto.CREATE, req, test_dto.Reserved)
        return x, got

    def test_scope(x, r):
        return {
            "p_studio_id": x["studio"],
            "p_test_delivery_id": r.result.test_delivery_id,
            "p_execution_token": r.execution.execution_token,
        }

    def test_begin_request(x, r):
        c = test_dto._test_rpc(
            client,
            test_dto.PREPARE,
            test_dto.PreparationRequest(
                **test_scope(x, r),
                p_actor_id=x["actor"],
                p_preparation_id=uuid4(),
                p_sender_binding="a" * 64,
                p_allowed_recipients=[],
            ),
            test_dto.PreparationClaim,
        )
        prep = _dispatch_rpc(
            client,
            "settle_automation_sender_preparation_v1",
            graph_dto.PreparationSettleRequest(
                p_preparation_id=c.preparation_id,
                p_preparation_token=c.preparation_token,
                p_result=graph_dto.PreparationResult(
                    outcome="prepared",
                    credential_revision=1,
                    sender_binding="a" * 64,
                    safe_reason=None,
                    retry_after_seconds=None,
                ),
            ),
            graph_dto.PreparationSettled,
        )
        e = r.execution
        facts = build_synthetic_workflow_facts(
            e.event_type,
            e.reference_time,
            program_id=e.trigger_context.program_id,
            offset_minutes=e.trigger_context.offset_minutes,
            recipient_ids=frozenset({e.recipient_policy}),
        )
        content = render_workflow_email(
            e.event_type,
            e.subject_template,
            e.body_template,
            {
                **facts.template_facts,
                **facts.recipients[e.recipient_policy].template_facts,
            },
            unsubscribe_url=None,
        )
        content = assemble_synthetic_test_email(content.subject, content.text_body)
        return test_dto.BeginRequest(
            **test_scope(x, r),
            p_actor_id=x["actor"],
            p_preparation_id=prep.preparation_id,
            p_preparation_token=prep.preparation_token,
            p_probe_token=prep.probe_token,
            p_allowed_recipients=[],
            p_scope_fingerprint=e.scope_fingerprint,
            p_rendered=test_dto.Rendered(
                subject=content.subject,
                text_body=content.text_body,
                html_body=content.html_body,
            ),
        )

    def test_begin(x, r):
        return test_dto._test_rpc(
            client, test_dto.BEGIN, test_begin_request(x, r), test_dto.Begun
        )

    def test_settle(x, r, b, result=None):
        return test_dto._test_rpc(
            client,
            test_dto.SETTLE,
            test_dto.SettleRequest(
                **test_scope(x, r),
                p_attempt_id=b.attempt.id,
                p_result=result or delivery(),
            ),
            test_dto.Settled,
        )

    def legacy_fixture():
        x = value("SELECT clear_proof.clear_fixture(false);")
        student = str(uuid4())
        session = str(uuid4())
        sql(
            "INSERT INTO public.students(id,studio_id,legal_first_name,legal_last_name,email) VALUES("
            + quote(student)
            + ","
            + quote(x["studio"])
            + ",'Synthetic','Attendance',"
            + quote(student + "@example.invalid")
            + "); INSERT INTO public.class_sessions(id,studio_id,name,date,start_time,end_time) VALUES("
            + quote(session)
            + ","
            + quote(x["studio"])
            + ",'Old class',current_date-20,'00:00','01:00'); INSERT INTO public.attendance(studio_id,session_id,student_id,checked_in_at) VALUES("
            + quote(x["studio"])
            + ","
            + quote(session)
            + ","
            + quote(student)
            + ",clock_timestamp()-INTERVAL '20 days');"
        )
        rpc(
            "save_missed_class_automation_rule_v1",
            {
                "p_studio_id": x["studio"],
                "p_actor_id": x["actor"],
                "p_expected_revision": 0,
                "p_enabled": True,
                "p_inactivity_days": 14,
                "p_subject_template": "Subject",
                "p_body_template": "Body",
                "p_reply_to_email": "reply@example.invalid",
            },
        )
        rpc(
            "enqueue_missed_class_automations_v1",
            {"p_limit": 1, "p_allowed_recipients": [student + "@example.invalid"]},
        )
        got = rpc(
            "claim_missed_class_automations_v1",
            {"p_limit": 1, "p_allowed_recipients": [student + "@example.invalid"]},
        )["items"][0]
        return {
            **x,
            "delivery": got["id"],
            "token": got["claim_token"],
            "recipient": student + "@example.invalid",
        }

    def legacy_request(x):
        prep = preparation()
        return {
            "p_delivery_id": x["delivery"],
            "p_claim_token": x["token"],
            "p_preparation_id": str(prep.preparation_id),
            "p_preparation_token": str(prep.preparation_token),
            "p_probe_token": str(prep.probe_token) if prep.probe_token else None,
            "p_allowed_recipients": [x["recipient"]],
        }

    def legacy_settle(x, b, result=None):
        return rpc(
            "settle_missed_class_automation_v2",
            {
                "p_delivery_id": x["delivery"],
                "p_claim_token": x["token"],
                "p_attempt_id": b["attempt_id"],
                "p_result": (result or delivery()).model_dump(mode="json"),
            },
        )["payload"]

    with SQLClient("http://automation-clear-proof.invalid") as client:
        sql(
            "INSERT INTO private.automation_email_credentials(provider_key,encrypted_credentials,revision) VALUES('microsoft_graph:primary','synthetic-local-only',1) ON CONFLICT DO NOTHING;"
        )
        x = value("SELECT clear_proof.clear_fixture();")
        before = len(requests)
        got = clear(x)
        require(
            len(got) == 9
            and got["workflows_paused"] == 1
            and not got["attendance_rule_paused"],
            "Installed SDK nine-field parse",
        )
        passed(
            "actual v2 through installed SDK and strict DemoDataAccess nine-field parse"
        )
        x = value("SELECT clear_proof.clear_fixture();")
        before = len(requests)
        lost.add("clear_studio_operational_data_v2")
        try:
            DemoDataAccess(client).clear_studio_surface(
                x["studio"], include_platform_rows=False
            )
            raise RuntimeError("Lost reply should fail")
        except HTTPException as exc:
            require(
                exc.status_code == 503 and len(requests) == before + 1,
                "Uncertain clear was repeated",
            )
        finally:
            lost.clear()
        require(
            sql(
                "SELECT status FROM public.automation_workflows WHERE id="
                + quote(x["workflow"])
                + ";"
            )
            == "paused",
            "Lost reply did not commit original clear",
        )
        passed(
            "lost actual commit returns fixed503 and no automatic destructive repeat"
        )
        # Inject errors at the first physical delete and after all business deletes.
        for table in ("billing_disputes", "programs"):
            x = value("SELECT clear_proof.clear_fixture();")
            before = snapshot(x)
            sql(
                "CREATE FUNCTION clear_proof.fail_delete() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION USING ERRCODE='PCL02',MESSAGE='synthetic_clear_failure'; END $$; CREATE TRIGGER zz_clear_failure AFTER DELETE ON public."
                + table
                + " FOR EACH STATEMENT EXECUTE FUNCTION clear_proof.fail_delete();"
            )
            fail(
                statement(
                    "clear_studio_operational_data_v2", {"p_studio_id": x["studio"]}
                ),
                "synthetic_clear_failure",
            )
            require(
                snapshot(x) == before, "Partial clear survived rollback at " + table
            )
            sql(
                "DROP TRIGGER zz_clear_failure ON public."
                + table
                + "; DROP FUNCTION clear_proof.fail_delete();"
            )
            passed(
                "whole clear rollback "
                + (
                    "after cancellation"
                    if table == "billing_disputes"
                    else "after deletion"
                )
            )
        # Graph: real renderer/grant/callback survives physical parent+payload purge.
        reset_gate()
        x = graph_fixture()
        p = plan(x)
        b = graph_begin(x, p)
        require(b.outcome == "begun", "Graph actual begin")
        truth = value(
            "SELECT to_jsonb(a) FROM private.automation_email_attempt_reservations a WHERE id="
            + quote(b.attempt.id)
            + ";"
        )
        got = clear(x)
        require(
            got["sending_attempts_preserved"] == 1
            and got["workflow_cancellation_intents_added"] == 1,
            "Graph sending counts",
        )
        require(
            value(
                "SELECT to_jsonb(a) FROM private.automation_email_attempt_reservations a WHERE id="
                + quote(b.attempt.id)
                + ";"
            )
            == truth,
            "Clear rewrote sending truth",
        )
        require(
            sql(
                "SELECT count(*) FROM private.workflow_email_attempt_payloads WHERE studio_id="
                + quote(x["studio"])
                + ";"
            )
            == "0"
            and sql(
                "SELECT count(*) FROM private.workflow_email_unsubscribe_pins WHERE studio_id="
                + quote(x["studio"])
                + ";"
            )
            == "0",
            "Graph payload or plaintext pin retained",
        )
        got = graph_settle(x, b)
        require(
            got.updated and got.state == "accepted" and got.run.state == "cancelled",
            "Graph original callback after purge",
        )
        require(graph_settle(x, b).replayed, "Graph callback replay after purge")
        rpc("suppress_missed_class_automation_v1", {"p_token": p.unsubscribe_token})
        require(
            sql(
                "SELECT count(*) FROM public.automation_suppressions WHERE studio_id="
                + quote(x["studio"])
                + ";"
            )
            == "1",
            "Hash opt-out lost",
        )
        passed(
            "graph sending preserved, payload/plaintext purge, original accepted callback/replay/hash opt-out"
        )
        reset_gate()
        x = graph_fixture()
        p = plan(x)
        req = graph_begin_request(x, p)
        clear(x)
        got = _dispatch_rpc(client, "begin_workflow_email_v1", req, graph_dto.Begun)
        require(
            got.attempt is None
            and sql(
                "SELECT count(*) FROM private.automation_email_attempt_reservations WHERE scope_id="
                + quote(x["run"])
                + ";"
            )
            == "0",
            "Graph clear-first sent",
        )
        passed(
            "graph clear-first invalidates actual prior plan and grant without attempt"
        )
        # Completed accepted rows need no fabricated cancellation intent to purge.
        reset_gate()
        x = graph_fixture()
        p = plan(x)
        b = graph_begin(x, p)
        graph_settle(x, b)
        claimed = value("SELECT clear_proof.advance_claim(" + quote(x) + ");")
        value("SELECT clear_proof.advance_call(" + quote(claimed) + ");")
        require(
            sql(
                "SELECT state FROM public.automation_workflow_runs WHERE id="
                + quote(x["run"])
                + ";"
            )
            == "completed",
            "Real accepted path not completed",
        )
        got = clear(x)
        require(
            got["workflow_cancellation_intents_added"] == 0
            and got["sending_attempts_preserved"] == 0,
            "Completed path got intent/pending count",
        )
        require(
            sql(
                "SELECT count(*) FROM private.workflow_email_attempt_payloads WHERE studio_id="
                + quote(x["studio"])
                + ";"
            )
            == "0",
            "Completed accepted payload purge failed",
        )
        require(graph_settle(x, b).replayed, "Completed accepted replay lost")
        passed(
            "actual completed accepted path payload purge and original terminal replay"
        )
        reset_gate()
        x = graph_fixture()
        p = plan(x)
        b = graph_begin(x, p)
        graph_settle(x, b, delivery("unknown"))
        before = value(
            "SELECT to_jsonb(a) FROM private.automation_email_attempt_reservations a WHERE id="
            + quote(b.attempt.id)
            + ";"
        )
        gate = value("SELECT to_jsonb(g) FROM private.automation_sender_gate g;")
        got = clear(x)
        require(
            got["unknown_attempts_preserved"] == 1
            and got["workflow_cancellation_intents_added"] == 1,
            "Unknown counts",
        )
        require(
            value(
                "SELECT to_jsonb(a) FROM private.automation_email_attempt_reservations a WHERE id="
                + quote(b.attempt.id)
                + ";"
            )
            == before
            and value("SELECT to_jsonb(g) FROM private.automation_sender_gate g;")
            == gate,
            "Clear changed unknown sender/frequency truth",
        )
        require(
            graph_settle(x, b, delivery("unknown")).replayed, "Unknown replay failed"
        )
        passed(
            "actual unknown outcome/frequency/provider mode retained without recovery or resend"
        )
        # Synthetic scopes retain original grants only as ownership, never payload.
        reset_gate()
        x, r = test_fixture()
        req = test_begin_request(x, r)
        clear(x)
        got = test_dto._test_rpc(client, test_dto.BEGIN, req, test_dto.Begun)
        require(
            got.attempt is None
            and sql(
                "SELECT count(*) FROM private.automation_email_attempt_reservations WHERE scope_id="
                + quote(r.result.test_delivery_id)
                + ";"
            )
            == "0",
            "Queued test reused pre-clear grant",
        )
        current = test_dto._test_rpc(
            client,
            test_dto.CURRENT,
            test_dto.CurrentRequest(
                p_studio_id=x["studio"],
                p_actor_id=x["actor"],
                p_test_delivery_id=r.result.test_delivery_id,
            ),
            test_dto.Current,
        )
        require(current.result.state == "failed", "Queued test not failed")
        require(
            sql(
                "SELECT reason FROM private.automation_test_email_scopes WHERE id="
                + quote(r.result.test_delivery_id)
                + ";"
            )
            == "sender_unavailable",
            "Queued reason changed",
        )
        x = {**x, "graph": json.loads(json.dumps(x["graph"]))}
        x["graph"]["nodes"][0]["config"]["program_id"] = None
        x, new = test_fixture(x)
        require(new.result.state == "queued", "New explicit post-clear test refused")
        passed(
            "queued synthetic clear-first no attempt, sender_unavailable and new explicit post-clear operation"
        )
        reset_gate()
        x, r = test_fixture()
        b = test_begin(x, r)
        require(b.outcome == "begun", "Test actual begin")
        scope_before = value(
            "SELECT to_jsonb(s) FROM private.automation_test_email_scopes s WHERE id="
            + quote(r.result.test_delivery_id)
            + ";"
        )
        got = clear(x)
        require(got["sending_attempts_preserved"] == 1, "Test sending count")
        require(
            value(
                "SELECT to_jsonb(s) FROM private.automation_test_email_scopes s WHERE id="
                + quote(r.result.test_delivery_id)
                + ";"
            )
            == scope_before,
            "Clear rewrote sending test token/lease",
        )
        require(
            sql(
                "SELECT count(*) FROM private.automation_test_email_payloads WHERE studio_id="
                + quote(x["studio"])
                + ";"
            )
            == "0",
            "Sample/render retained",
        )
        require(
            test_settle(x, r, b).updated and test_settle(x, r, b).replayed,
            "Original synthetic callback after purge",
        )
        passed(
            "synthetic begin-first preserves sending scope/lease, purges sample/render and settles/replays"
        )
        # Legacy actual outbox cascade retains the common sidecar and hash map.
        reset_gate()
        x = legacy_fixture()
        req = legacy_request(x)
        b = rpc("begin_missed_class_automation_v2", req)["payload"]
        require(b["ready"], "Legacy actual begin")
        before = value(
            "SELECT to_jsonb(a) FROM private.automation_email_attempt_reservations a WHERE id="
            + quote(b["attempt_id"])
            + ";"
        )
        got = clear(x)
        require(
            got["sending_attempts_preserved"] == 1 and got["attendance_rule_paused"],
            "Legacy count/rule",
        )
        require(
            sql(
                "SELECT count(*) FROM public.automation_deliveries WHERE id="
                + quote(x["delivery"])
                + ";"
            )
            == "0",
            "Legacy outbox not cascaded",
        )
        require(
            value(
                "SELECT to_jsonb(a) FROM private.automation_email_attempt_reservations a WHERE id="
                + quote(b["attempt_id"])
                + ";"
            )
            == before,
            "Legacy common truth changed",
        )
        require(
            legacy_settle(x, b)["updated"] and legacy_settle(x, b)["replayed"],
            "Legacy original callback/replay after clear",
        )
        rpc(
            "suppress_missed_class_automation_v1",
            {"p_token": b["message"]["unsubscribe_token"]},
        )
        passed(
            "legacy begin-first physical outbox clear, sidecar retained and original settlement/replay/hash token"
        )
        reset_gate()
        x = legacy_fixture()
        req = legacy_request(x)
        got = clear(x)
        b = rpc("begin_missed_class_automation_v2", req)["payload"]
        require(
            got["attendance_deliveries_cancelled"] == 1
            and not b["ready"]
            and b["attempt_id"] is None,
            "Legacy clear-first granted",
        )
        passed("legacy safe claimed cancellation count and clear-first no attempt")
        # Real begin transactions retain their shared fence past the function return.
        for engine in ("graph", "test", "legacy"):
            for rollback in (False, True):
                reset_gate()
                if engine == "graph":
                    x = graph_fixture()
                    p = plan(x)
                    req = graph_begin_request(x, p).model_dump(mode="json")
                    name = "begin_workflow_email_v1"
                elif engine == "test":
                    x, r = test_fixture()
                    req = test_begin_request(x, r).model_dump(mode="json")
                    name = test_dto.BEGIN
                else:
                    x = legacy_fixture()
                    req = legacy_request(x)
                    name = "begin_missed_class_automation_v2"
                holder = sessions.start(statement(name, req))
                sessions.ready(holder)
                waiter = sessions.start(
                    statement(
                        "clear_studio_operational_data_v2",
                        {"p_studio_id": x["studio"]},
                    ),
                    hold=False,
                )
                sessions.blocked(holder, waiter)
                begun = sessions.release(holder, rollback)
                got = sessions.finish(waiter)["payload"]
                require(
                    got["sending_attempts_preserved"] == (0 if rollback else 1),
                    "Begin/clear transaction count " + engine,
                )
                if not rollback:
                    if engine == "graph":
                        graph_settle(
                            x,
                            graph_dto.Envelope[graph_dto.Begun]
                            .model_validate(begun)
                            .payload,
                        )
                    elif engine == "test":
                        test_settle(
                            x,
                            r,
                            graph_dto.Envelope[test_dto.Begun]
                            .model_validate(begun)
                            .payload,
                        )
                    else:
                        legacy_settle(x, begun["payload"])
                passed(
                    engine
                    + " actual begin whole-transaction fence "
                    + ("rollback" if rollback else "commit")
                )
        # Late common observations must refuse immediately, after parent ownership.
        reset_gate()
        x = graph_fixture()
        p = plan(x)
        b = graph_begin(x, p)
        before = snapshot(x)
        holder = sessions.start(
            "SELECT 1 FROM private.automation_email_attempt_reservations WHERE id="
            + quote(b.attempt.id)
            + " FOR UPDATE;"
        )
        sessions.ready(holder)
        fail(
            statement("clear_studio_operational_data_v2", {"p_studio_id": x["studio"]})
        )
        require(snapshot(x) == before, "Common contention left partial cancellation")
        sessions.release(holder, True)
        clear(x)
        graph_settle(x, b)
        passed(
            "late common NOWAIT contention returns busy and rolls back all clear effects"
        )
        passed(
            "installed SDK exact wire requests",
            calls=len(requests),
            external_requests=0,
        )


if __name__ == "__main__":
    main(sys.argv[1:])
