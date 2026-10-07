#!/usr/bin/env python3
"""Guarded PG17 nonmail progression, real sessions, SDK parsing and restore proof.

One owned clone only. No hosted database, live PostgREST, provider, dotenv or mail.
Sending expiry belongs to08C and is deliberately not claimed by this verifier.
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
from datetime import datetime
from importlib.metadata import version
from pathlib import Path
from uuid import uuid4

from local_postgres_verification import LocalPostgres, require, install_final_v57

ROOT = Path(__file__).resolve().parents[1]
ACCEPTED_BASE = "35561d6b8f851ea0309723637e0996a064ba4c82"
MIGRATION = (
    ROOT / "supabase/migrations/20261005105341_automation_workflow_graph_v57.sql"
)
CONTRACT = ROOT / "supabase/verification/workflow_advance_contract.sql"


def quote(value):
    if value is None:
        return "NULL"
    if isinstance(value, (dict, list)):
        value = json.dumps(value, separators=(",", ":"))
    if isinstance(value, bool):
        value = "true" if value else "false"
    return "'" + str(value).replace("'", "''") + "'"


def main(arguments):
    require(len(arguments) == 4, "Expected psql socket port unique-owned-clone-name")
    psql, socket, port, database = arguments
    require(
        re.fullmatch(r"koaryu_workflow_advance_[a-z0-9_]+", database), "Invalid clone"
    )
    local = LocalPostgres(psql, socket, port, str(Path(socket).parent))
    frozen = MIGRATION.read_bytes()
    historical = {
        p.name: hashlib.sha256(p.read_bytes()).hexdigest()
        for p in MIGRATION.parent.glob("*.sql")
        if p != MIGRATION
    }
    require(len(historical) == 151, "Expected151 immutable historical files")
    base_before = local.sql(
        "postgres",
        "SELECT row_to_json(p) FROM public.koaryu_release_schema_preflight_v37() p;",
    )
    base = json.loads(base_before)
    require(
        base["ready"]
        and base["migration_count"] == 151
        and base["migration_head"] == "20261004220435"
        and base["manifest_version"] == "release-db-attestation-v56",
        "Expected strict V56 base",
    )
    pid_file = Path(socket).parent / "data/postmaster.pid"
    pid = pid_file.read_text().splitlines()[0]
    children, cases = [], []
    owned = False
    dump_owned = False
    dump = Path(socket).parent / (database + ".dump")
    require(not os.path.lexists(dump), "Dump path already exists")

    def sql(statement):
        return local.sql(database, "SET TIME ZONE 'UTC';\n" + statement)

    def value(statement):
        return json.loads(sql(statement))

    def passed(name, **evidence):
        cases.append({"case": name, "outcome": "passed", **evidence})
        print("[workflow advance] PASS " + name, flush=True)

    def fixture(kind="lead.created", mode="end", config=None):
        x = value(
            f"SELECT advance_proof.advance_seed(advance_proof.advance_fixture(),{quote(kind)},advance_proof.advance_path({quote(kind)},{quote(mode)},{quote(config)}));"
        )
        return value(f"SELECT advance_proof.advance_claim({quote(x)});")

    def command(x, limit=10):
        return f"SELECT public.advance_automation_workflow_run_v1({quote(x['studio'])},{quote(x['run'])},{quote(x['token'])},{limit});"

    def invoke(statement):
        return value(
            "SET ROLE service_role; SELECT advance_proof.rpc(" + quote(statement) + ");"
        )

    def advance(x, limit=10):
        result = invoke(command(x, limit))
        require(result["ok"], "Unexpected advance error: " + json.dumps(result))
        return result["data"]["payload"]

    def snapshot(x):
        return value(f"SELECT advance_proof.advance_snapshot({quote(x)});")

    def session(label, statement, hold=False, role="service_role"):
        name = f"advance_{os.getpid()}_{label}_{len(children)}"[:63]
        process = subprocess.Popen(
            [
                psql,
                *local.connection,
                f"--dbname={database}",
                "--no-psqlrc",
                "--quiet",
                "--tuples-only",
                "--no-align",
                "--set=ON_ERROR_STOP=1",
                "--set=VERBOSITY=verbose",
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
            env=local.env,
        )
        item = {
            "process": process,
            "name": name,
            "lines": [],
            "errors": [],
            "events": queue.Queue(),
        }
        children.append(item)

        def drain(stream, target, events=None):
            for line in stream:
                target.append(line.rstrip())
                if events is not None:
                    events.put(line.rstrip())

        item["threads"] = [
            threading.Thread(
                target=drain,
                args=(process.stdout, item["lines"], item["events"]),
                daemon=True,
            ),
            threading.Thread(
                target=drain, args=(process.stderr, item["errors"]), daemon=True
            ),
        ]
        for thread in item["threads"]:
            thread.start()
        process.stdin.write(
            f"SET application_name={quote(name)}; SET TIME ZONE 'UTC'; BEGIN; SET LOCAL statement_timeout='20s'; SET LOCAL ROLE {role};\n{statement}\n"
        )
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
                require(
                    item["process"].poll() is None,
                    "Holder failed: " + "\n".join(item["errors"]),
                )
        raise RuntimeError("Holder barrier timeout")

    def finished(item):
        code = item["process"].wait(timeout=25)
        for thread in item["threads"]:
            thread.join(timeout=2)
        require(code == 0, "Session failed: " + "\n".join(item["errors"]))
        parsed = [json.loads(line) for line in item["lines"] if line.startswith("{")]
        return parsed[-1] if parsed else None

    def release(item, rollback=False):
        item["process"].stdin.write("ROLLBACK;\n" if rollback else "COMMIT;\n")
        item["process"].stdin.close()
        return finished(item)

    def blocked(holder, reader):
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            require(
                reader["process"].poll() is None,
                "Waiter exited: " + "\n".join(reader["errors"]),
            )
            found = sql(
                f"SELECT EXISTS(SELECT 1 FROM pg_stat_activity h JOIN pg_stat_activity r ON h.pid=ANY(pg_blocking_pids(r.pid)) WHERE h.application_name={quote(holder['name'])} AND r.application_name={quote(reader['name'])});"
            )
            if found == "t":
                return
            time.sleep(0.025)
        raise RuntimeError("Missing observed blocking relationship")

    def close_children():
        for item in children:
            process = item["process"]
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
            for thread in item["threads"]:
                thread.join(timeout=2)
            for stream in (process.stdin, process.stdout, process.stderr):
                if stream is not None and not stream.closed:
                    stream.close()

    inventory_sql = """SELECT jsonb_object_agg(p.oid::regprocedure::text,jsonb_build_object('body',p.prosrc,'acl',p.proacl::text,'owner',pg_get_userbyid(p.proowner),'settings',p.proconfig,'volatility',p.provolatile,'security_definer',p.prosecdef)) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('public','private');"""
    try:
        require(
            local.sql(
                "postgres",
                f"SELECT NOT EXISTS(SELECT 1 FROM pg_database WHERE datname={quote(database)});",
            )
            == "t",
            "Clone already exists",
        )
        require(
            local.sql(
                "postgres",
                "SELECT count(*) FROM pg_stat_activity WHERE datname='postgres' AND pid<>pg_backend_pid();",
            )
            == "0",
            "Base has another session",
        )
        # Compare the installed accepted predecessor and candidate in this same
        # owned name. There is never a second worker database or a template write.
        accepted = subprocess.check_output(
            ["git", "show", ACCEPTED_BASE + ":" + str(MIGRATION.relative_to(ROOT))],
            cwd=ROOT,
            env=local.env,
            text=True,
        )
        require(hashlib.sha256(accepted.encode()).hexdigest()
                == "cab98ab987acf0c24a383be94f3e0499c6d891b922d7fd1de217e788c2a339b5",
                "Accepted complete execution SQL pin differs")
        local.sql("postgres", f"CREATE DATABASE {database} TEMPLATE postgres;")
        owned = True
        sql("BEGIN;\n" + accepted + "\nCOMMIT;")
        retained = value(inventory_sql)
        local.sql("postgres", f"DROP DATABASE {database};")
        local.sql("postgres", f"CREATE DATABASE {database} TEMPLATE postgres;")
        install_final_v57(local, database, ROOT)
        installed = value(inventory_sql)
        require(
            all(installed.get(k) == v for k, v in retained.items() if k != "koaryu_release_schema_preflight_v37()"),
            "Retained function body/ACL changed",
        )
        require(
            sql("SELECT count(*) FROM supabase_migrations.schema_migrations;") == "152",
            "Complete V57 migration history differs",
        )
        passed(
            "transactional install and exact retained function ACL/body",
            functions=len(retained),
            sha256=hashlib.sha256(frozen).hexdigest(),
        )
        passed(
            "complete rollback advance contract", assertions=sql(CONTRACT.read_text())
        )
        for name in (
            "workflow_management",
            "workflow_run",
            "workflow_rank_context",
            "workflow_financial_authority",
            "workflow_current_facts",
            "workflow_domain_capture",
        ):
            passed(
                "retained " + name,
                assertions=sql(
                    (ROOT / f"supabase/verification/{name}_contract.sql").read_text()
                ),
            )
        setup = (
            CONTRACT.read_text()
            .split("\nDO $$", 1)[0]
            .replace("BEGIN;\n", "", 1)
            .replace("SET LOCAL statement_timeout='90s';", "")
            .replace("SET LOCAL TIME ZONE 'UTC';", "")
        )
        setup = (
            setup.replace(
                "CREATE TEMP TABLE advance_checks",
                "CREATE TABLE advance_proof.advance_checks",
            )
            .replace("pg_temp.", "advance_proof.")
            .replace("SCHEMA pg_temp", "SCHEMA advance_proof")
        )
        sql(
            "CREATE SCHEMA advance_proof; GRANT USAGE ON SCHEMA advance_proof TO service_role;\n"
            + setup
        )
        sql("""CREATE FUNCTION advance_proof.rpc(statement TEXT) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE payload JSONB; code TEXT; message TEXT;
BEGIN
    EXECUTE statement INTO payload;
    RETURN jsonb_build_object('ok',true,'data',payload);
EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS code=RETURNED_SQLSTATE,message=MESSAGE_TEXT;
    RETURN jsonb_build_object('ok',false,'code',code,'message',message);
END $$; GRANT EXECUTE ON FUNCTION advance_proof.rpc(TEXT) TO service_role;""")
        os.environ["ENVIRONMENT"] = "test"
        os.environ["SUPABASE_URL"] = "https://placeholder.supabase.co"
        os.environ["SUPABASE_DEVELOPMENT_PROJECT_REF"] = ""
        sys.path.insert(0, str(ROOT / "backend"))
        from app.core.config import AMBIENT_TRANSPORT_ENVIRONMENT_KEYS, Settings

        Settings.model_config["env_file"] = None
        for key in AMBIENT_TRANSPORT_ENVIRONMENT_KEYS:
            os.environ.pop(key, None)
        import httpx
        from app.schemas import workflow_dispatch as dto
        from app.schemas.workflow import WorkflowGraph
        from app.schemas.workflow_run import WorkflowRunDetail
        from app.services.automation_service import _dispatch_rpc
        from app.services.workflow_catalog import CATALOG
        from app.services.workflow_policies import (
            MISSING,
            condition_fact_available,
            condition_matches,
        )
        from app.services.workflow_simulation_service import (
            _decode_facts,
            _Facts,
            _walk,
        )
        from tests.test_workflow_management import SyntheticPostgrestClient

        require(version("postgrest") == "0.17.2", "Expected installed PostgREST0.17.2")
        corruption = None
        names = {
            "claim_automation_workflow_runs_v1",
            "advance_automation_workflow_run_v1",
            "defer_automation_workflow_run_v1",
            "get_automation_workflow_run_v1",
        }

        def bridge(request):
            name = request.url.path.rsplit("/", 1)[-1]
            params = json.loads(request.content)
            require(
                request.method == "POST" and name in names, "Unexpected SDK request"
            )
            statement = (
                f"SELECT public.{name}("
                + ",".join(k + "=>" + quote(v) for k, v in params.items())
                + ");"
            )
            reply = invoke(statement)
            if reply["ok"]:
                data = reply["data"]
                if corruption is not None:
                    corruption(data)
                return httpx.Response(200, json=data)
            return httpx.Response(
                400,
                json={
                    "code": reply["code"],
                    "message": reply["message"],
                    "details": None,
                    "hint": None,
                },
            )

        with SyntheticPostgrestClient(bridge) as client:
            x = fixture(mode="email")
            scope = {
                "p_studio_id": x["studio"],
                "p_run_id": x["run"],
                "p_claim_token": x["token"],
            }
            got = _dispatch_rpc(
                client,
                "advance_automation_workflow_run_v1",
                dto.AdvanceRequest(**scope, p_step_limit=10),
                dto.Transition,
            )
            require(got.outcome == "email", "SQL SDK email boundary")
            raw = (
                client.rpc(
                    "get_automation_workflow_run_v1",
                    {
                        "p_studio_id": x["studio"],
                        "p_actor_id": x["actor"],
                        "p_run_id": x["run"],
                    },
                )
                .execute()
                .data
            )
            detail = WorkflowRunDetail.model_validate(raw["payload"])
            require(len(detail.steps) == 2 and not detail.attempts, "SQL history DTO")
            for key in ("studio_id", "run_id", "claim_token"):
                corruption = lambda data, key=key: data["payload"].__setitem__(
                    key, str(uuid4())
                )
                try:
                    _dispatch_rpc(
                        client,
                        "advance_automation_workflow_run_v1",
                        dto.AdvanceRequest(**scope, p_step_limit=10),
                        dto.Transition,
                    )
                except ValueError as exc:
                    require(
                        str(exc) == "invalid_automation_dispatch_result",
                        "Unsafe malformed result error",
                    )
                else:
                    raise RuntimeError("Foreign SDK identity accepted")
            for corrupt in (
                lambda data: data["payload"].pop("run"),
                lambda data: data["payload"].__setitem__("extra", True),
                lambda data: data["payload"]["run"].__setitem__("state", "queued"),
            ):
                corruption = corrupt
                try:
                    _dispatch_rpc(
                        client,
                        "advance_automation_workflow_run_v1",
                        dto.AdvanceRequest(**scope, p_step_limit=10),
                        dto.Transition,
                    )
                except ValueError:
                    pass
                else:
                    raise RuntimeError("Malformed SQL reply accepted")
            corruption = None
            got = _dispatch_rpc(
                client,
                "defer_automation_workflow_run_v1",
                dto.DeferRequest(**scope, p_reason="sender_unavailable"),
                dto.Deferred,
            )
            require(got.outcome == "waiting", "SQL SDK defer")
            sql(
                f"UPDATE public.automation_workflow_runs SET next_due_at=clock_timestamp()-INTERVAL '1 second' WHERE id={quote(x['run'])};"
            )
            claims = _dispatch_rpc(
                client,
                "claim_automation_workflow_runs_v1",
                dto.ClaimRequest(p_limit=1),
                dto.Claims,
            )
            require(
                len(claims.claims) == 1 and str(claims.claims[0].run_id) == x["run"],
                "SQL SDK claims",
            )
            lost = _dispatch_rpc(
                client,
                "advance_automation_workflow_run_v1",
                dto.AdvanceRequest(**scope, p_step_limit=10),
                dto.Transition,
            )
            require(
                lost.outcome == "lease_lost" and lost.run is None,
                "SDK old token refusal",
            )
        passed(
            "installed SDK Claims Transition Deferred history and malformed scope/shape",
            installed_sdk=version("postgrest"),
        )

        # Every field/operator has actual, missing, null, malformed, membership and
        # UUID spelling checks against the real Python comparator, in one SQL batch.
        comparisons = []
        for field, meta in CATALOG["fields"].items():
            values = (
                [True, False]
                if meta["value_type"] == "boolean"
                else list(
                    meta.get(
                        "values",
                        [
                            "12345678-abcd-1234-abcd-123456789abc",
                            "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
                        ],
                    )
                )
            )
            actuals = values + [MISSING, None, 0, 1, "invalid", [], {}, "true"]
            if meta["value_type"] == "uuid":
                actuals += [
                    values[0].upper(),
                    values[0].replace("-", ""),
                    "{" + values[0] + "}",
                    "urn:uuid:" + values[0],
                ]
            for op in meta["operators"]:
                expected_values = (
                    [values[:1], values, [values[0]] * 100]
                    if op in {"in", "not_in"}
                    else values + ([None] if meta["nullable"] else [])
                )
                for expected in expected_values:
                    for actual in actuals:
                        result = (
                            condition_matches(field, op, expected, actual)
                            if condition_fact_available(field, actual)
                            else None
                        )
                        comparisons.append((field, op, expected, actual, result))
        expressions = [
            f"private.workflow_condition_result_v1({quote(f)},{quote(op)},{quote(json.dumps(exp))}::jsonb,{('NULL' if act is MISSING else quote(json.dumps(act)) + '::jsonb')})"
            for f, op, exp, act, _ in comparisons
        ]
        actual_results = value(
            "SELECT jsonb_build_array("
            + ",".join(
                "to_jsonb(ARRAY[" + ",".join(expressions[i : i + 70]) + "]::boolean[])"
                for i in range(0, len(expressions), 70)
            )
            + ");"
        )
        actual_results = [item for group in actual_results for item in group]
        require(
            actual_results == [item[4] for item in comparisons],
            "SQL/Python condition parity mismatch",
        )
        passed(
            "all14 fields typed operator/null/MISSING/UUID/max100 parity",
            comparisons=len(comparisons),
        )

        # Compare exact runtime history to actual accepted _walk at the same first
        # entered instant; mail is a boundary, not simulated delivery here.
        for mode, config in (
            ("end", None),
            (
                "condition",
                {"field": "lead.unconverted", "operator": "neq", "value": False},
            ),
            ("lead_follow_up", None),
            ("delay", {"mode": "duration", "minutes": 0}),
            ("delay", {"mode": "duration", "minutes": 60}),
        ):
            x = fixture(mode=mode, config=config)
            graph = value(
                f"SELECT v.graph FROM public.automation_workflow_runs r JOIN public.automation_workflow_versions v ON v.id=r.version_id WHERE r.id={quote(x['run'])};"
            )
            advance(x)
            history = value(
                f"SELECT private.workflow_run_detail_v1({quote(x['studio'])},{quote(x['run'])});"
            )
            reference = datetime.fromisoformat(
                history["steps"][0]["entered_at"].replace("Z", "+00:00")
            )
            trigger = next(
                n["config"] for n in graph["nodes"] if n["type"] == "trigger"
            )
            facts = value(
                f"SELECT private.workflow_current_source_facts_v1({quote(x['studio'])},'lead.created',{quote(x['subject'])},(SELECT context FROM private.automation_workflow_events WHERE id={quote(x['source_event'])}),{quote(trigger)},{quote(reference.isoformat())},'{{}}')->'facts';"
            )
            preview = _walk(
                WorkflowGraph.model_validate(graph),
                "lead.created",
                _decode_facts(
                    _Facts.model_validate(facts), "lead.created", frozenset()
                ),
                reference,
            )
            runtime = history["steps"]
            require(
                [r["node_id"] for r in runtime] == [r.node_id for r in preview],
                "Runtime/preview node path",
            )
            for row, projected in zip(runtime, preview, strict=True):
                expected = (
                    "would_follow_up"
                    if row["node_type"] == "lead_follow_up"
                    and row["outcome"] == "completed"
                    else "entered"
                    if row["node_type"] in {"trigger", "delay"}
                    and row["outcome"] == "completed"
                    else row["outcome"]
                )
                require(
                    (expected, row["edge_id"], row["reason"])
                    == (projected.outcome, projected.edge_id, projected.reason),
                    "Runtime/preview node semantics",
                )
                if row["node_type"] == "delay":
                    # Runtime duration starts at this node's actual entry; compare
                    # accepted walk using that same authority instead of wall clocks.
                    node_reference = datetime.fromisoformat(
                        row["entered_at"].replace("Z", "+00:00")
                    )
                    at_node = _walk(
                        WorkflowGraph.model_validate(graph),
                        "lead.created",
                        _decode_facts(
                            _Facts.model_validate(facts), "lead.created", frozenset()
                        ),
                        node_reference,
                    )
                    due = next(
                        r.scheduled_at for r in at_node if r.node_id == row["node_id"]
                    )
                    require(
                        datetime.fromisoformat(
                            row["scheduled_at"].replace("Z", "+00:00")
                        )
                        == due,
                        "Duration reference parity",
                    )
        passed("actual nonmail simulation path/edge/action/first-futurewait parity")

        # Fairness across a deliberately uneven backlog; all rows still use the
        # real run/event/activation constraints and one global cursor.
        studios = [fixture() for _ in range(3)]
        studios.sort(key=lambda x: x["studio"])
        sql(
            "UPDATE public.automation_workflow_runs SET next_due_at=clock_timestamp()+INTERVAL '1 day' WHERE state IN ('queued','waiting');"
        )
        for index, x in enumerate(studios):
            count = 2000 if index == 0 else 4
            sql(f"""WITH events AS (
                INSERT INTO private.automation_workflow_events(studio_id,event_type,source_key,subject_kind,subject_id,occurred_at,context)
                SELECT e.studio_id,e.event_type,'backlog:'||gen_random_uuid()::text,e.subject_kind,e.subject_id,e.occurred_at,e.context
                FROM private.automation_workflow_events e CROSS JOIN generate_series(1,{count}) WHERE e.id={quote(x["source_event"])} RETURNING id,studio_id)
                INSERT INTO public.automation_workflow_runs(studio_id,workflow_id,version_id,event_id,activation_id,epoch,current_node_id,next_due_at)
                SELECT r.studio_id,r.workflow_id,r.version_id,e.id,r.activation_id,r.epoch,'trigger',clock_timestamp()-INTERVAL '1 minute'
                FROM events e JOIN public.automation_workflow_runs r ON r.studio_id=e.studio_id AND r.id={quote(x["run"])};""")
        sql(
            "UPDATE private.automation_workflow_dispatch_cursor SET last_studio_id=NULL; ANALYZE public.automation_workflow_runs;"
        )
        seen = [
            invoke("SELECT public.claim_automation_workflow_runs_v1(1);")["data"][
                "payload"
            ]["claims"][0]["studio_id"]
            for _ in range(6)
        ]
        require(
            seen == [x["studio"] for x in studios] * 2, "Limit1 studio rotation failed"
        )
        batch = invoke("SELECT public.claim_automation_workflow_runs_v1(6);")["data"][
            "payload"
        ]["claims"]
        require(
            [x["studio_id"] for x in batch] == [x["studio"] for x in studios] * 2,
            "Batch repeated studio before full turn",
        )
        require(
            len({x["run_id"] for x in batch}) == len(batch)
            and len({x["claim_token"] for x in batch}) == len(batch),
            "Claim batch reused a run or token",
        )
        sql(
            "UPDATE private.automation_workflow_dispatch_cursor SET last_studio_id=NULL;"
        )
        held_run = sql(
            "SELECT id FROM public.automation_workflow_runs WHERE state='queued' AND next_due_at<=clock_timestamp() ORDER BY studio_id,next_due_at,created_at,id LIMIT 1;"
        )
        run_holder = session(
            "skip_run",
            f"SELECT 1 FROM public.automation_workflow_runs WHERE id={quote(held_run)} FOR UPDATE;",
            hold=True,
        )
        ready(run_holder)
        skipped = invoke("SELECT public.claim_automation_workflow_runs_v1(1);")["data"][
            "payload"
        ]["claims"]
        require(
            len(skipped) == 1 and skipped[0]["run_id"] != held_run,
            "Row SKIP LOCKED did not bypass a busy run",
        )
        release(run_holder)
        plan = value(
            "EXPLAIN (FORMAT JSON) SELECT * FROM public.automation_workflow_runs r WHERE state IN ('queued','waiting','claimed','running') AND studio_id> '00000000-0000-0000-0000-000000000000'::uuid AND next_due_at<=clock_timestamp() AND cancel_requested_at IS NULL ORDER BY studio_id,next_due_at,created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED;"
        )
        require(
            "automation_workflow_runs_studio_due" in json.dumps(plan),
            "Large backlog did not use studio index",
        )
        holder = session(
            "cursor",
            "SELECT * FROM private.automation_workflow_dispatch_cursor FOR UPDATE;",
            hold=True,
        )
        ready(holder)
        refused = invoke("SELECT public.claim_automation_workflow_runs_v1(1);")["data"][
            "payload"
        ]
        require(
            refused == {"claims": [], "has_more": True},
            "Busy cursor did not skip truthfully",
        )
        release(holder)
        before_cursor = value(
            "SELECT to_jsonb(c) FROM private.automation_workflow_dispatch_cursor c;"
        )
        claimant = session(
            "claim_rollback",
            "SELECT public.claim_automation_workflow_runs_v1(2);",
            hold=True,
        )
        ready(claimant)
        release(claimant, rollback=True)
        require(
            value(
                "SELECT to_jsonb(c) FROM private.automation_workflow_dispatch_cursor c;"
            )
            == before_cursor,
            "Cursor rollback changed position",
        )
        passed(
            "2000-row indexed backlog deterministic studio rotation cursor skip/rollback"
        )
        # Contended exact run and concurrent cursor ownership grant each run once.
        sql(
            "UPDATE public.automation_workflow_runs SET next_due_at=clock_timestamp()+INTERVAL '1 day' WHERE state IN ('queued','waiting');"
        )
        x = fixture()
        sql(
            f"UPDATE public.automation_workflow_runs SET lease_expires_at=clock_timestamp()-INTERVAL '1 second' WHERE id={quote(x['run'])};"
        )
        first = session(
            "claim_a", "SELECT public.claim_automation_workflow_runs_v1(1);", hold=True
        )
        ready(first)
        second = finished(
            session("claim_b", "SELECT public.claim_automation_workflow_runs_v1(1);")
        )
        require(second["payload"]["claims"] == [], "Concurrent duplicate claim")
        grant = release(first)["payload"]["claims"]
        require(
            len(grant) == 1 and grant[0]["run_id"] == x["run"], "First claimant missing"
        )
        require(advance(x)["outcome"] == "lease_lost", "Old claim survived reclaim")
        for state in ("sending", "unknown", "completed", "cancelled", "failed"):
            sql(
                f"UPDATE public.automation_workflow_runs SET state={quote(state)},next_due_at=NULL,claim_token=CASE WHEN {quote(state)} IN ('sending','unknown') THEN gen_random_uuid() END,lease_expires_at=CASE WHEN {quote(state)} IN ('sending','unknown') THEN clock_timestamp()-INTERVAL '1 day' END WHERE id={quote(x['run'])};"
            )
            require(
                invoke("SELECT public.claim_automation_workflow_runs_v1(1);")["data"][
                    "payload"
                ]["claims"]
                == [],
                "Reclaimed unsafe state " + state,
            )
        passed(
            "two workers fresh unique grant stale token and no sending/unknown/terminal reclaim"
        )

        def mutation(x):
            kind = x["kind"]
            if kind.startswith("lead."):
                return f"UPDATE public.leads SET stage='closed_lost' WHERE id={quote(x['lead'])};"
            if kind.startswith("trial."):
                return f"UPDATE public.lead_trial_appointments SET status='canceled' WHERE id={quote(x['trial_appointment'])};"
            if kind.startswith("belt_test."):
                return f"UPDATE public.belt_test_events SET status='canceled' WHERE id={quote(x['event'])};"
            if kind == "student.enrolled":
                return f"UPDATE public.students SET status='inactive' WHERE id={quote(x['student'])};"
            if kind == "student.promoted":
                return (
                    f"DELETE FROM public.promotions WHERE id={quote(x['promotion'])};"
                )
            if kind == "invoice.overdue":
                return f"UPDATE public.billing_invoices SET status='void' WHERE id={quote(x['invoice'])};"
            return f"UPDATE public.billing_payments SET status='succeeded',net_collected_amount_cents=amount_cents WHERE id={quote(x['payment'])};"

        for kind in CATALOG["triggers"]:
            for rollback in (False, True):
                x = fixture(kind)
                before = snapshot(x)
                writer = session(
                    "source_first", mutation(x), hold=True, role="postgres"
                )
                ready(writer)
                got = invoke(command(x))
                require(
                    not got["ok"]
                    and (got["code"], got["message"])
                    == ("P0001", "AUTOMATION_STUDIO_BUSY"),
                    "Source contention not a definite refusal " + kind,
                )
                require(
                    snapshot(x) == before, "Busy advance wrote before source ownership"
                )
                release(writer, rollback=rollback)
                result = advance(x)
                state = snapshot(x)["run"]["state"]
                require(
                    state == ("completed" if rollback else "cancelled"),
                    "Source commit/rollback not current " + kind + " " + str(result),
                )
                x = fixture(kind)
                owner = session("advance_first", command(x), hold=True)
                ready(owner)
                writer = session("source_after", mutation(x), role="postgres")
                blocked(owner, writer)
                release(owner, rollback=rollback)
                finished(writer)
                if rollback:
                    advance(x)
                require(
                    snapshot(x)["run"]["state"]
                    == ("cancelled" if rollback else "completed"),
                    "Reverse source ordering changed effect truth " + kind,
                )
            passed(
                "paired source current mutation in both commit/rollback orders " + kind
            )

        for table, predicate, change in (
            ("public.studio_subscriptions", "studio_id", "status='canceled'"),
            ("public.programs", "id", "archived_at=clock_timestamp()"),
        ):
            for rollback in (False, True):
                x = fixture(mode="lead_follow_up")
                identifier = x["studio"] if predicate == "studio_id" else x["program"]
                writer = session(
                    "parent_first",
                    f"UPDATE {table} SET {change} WHERE {predicate}={quote(identifier)};",
                    hold=True,
                    role="postgres",
                )
                ready(writer)
                got = invoke(command(x))
                require(
                    not got["ok"] and got["message"] == "AUTOMATION_STUDIO_BUSY",
                    "Parent lock not held",
                )
                release(writer, rollback=rollback)
                result = advance(x)
                expected = (
                    "completed"
                    if rollback
                    else "waiting"
                    if table.endswith("studio_subscriptions")
                    else "cancelled"
                )
                require(
                    result["run"]["state"] == expected,
                    "Current parent state was ignored",
                )
            passed("current parent commit/rollback " + table)

        for action in ("publish", "pause", "archive", "cancel"):
            for rollback in (False, True):
                x = fixture(mode="lead_follow_up")
                if action == "cancel":
                    statement = f"SELECT public.cancel_automation_workflow_run_v1({quote(x['studio'])},{quote(x['actor'])},{quote(x['run'])},gen_random_uuid(),2);"
                else:
                    statement = f"SELECT public.command_automation_workflow_v1({quote(x['studio'])},{quote(x['actor'])},{quote(x['workflow'])},gen_random_uuid(),3,{quote(action)});"
                manager = session("management", statement, hold=True)
                ready(manager)
                got = invoke(command(x))
                require(
                    not got["ok"] and got["message"] == "AUTOMATION_STUDIO_BUSY",
                    "Management contention escaped",
                )
                release(manager, rollback=rollback)
                result = advance(x)
                current = snapshot(x)
                require(
                    current["run"]["state"]
                    == (
                        "completed" if rollback or action == "publish" else "cancelled"
                    ),
                    "Management commit/rollback not preserved",
                )
                require(
                    len(current["actions"])
                    == (1 if rollback or action == "publish" else 0),
                    "Management action side effect",
                )
            passed("workflow management race " + action)

        # Actual retained clear acquires its exclusive gate before source deletion.
        for rollback in (False, True):
            x = fixture(mode="lead_follow_up")
            clear = session(
                "clear_first",
                f"SELECT public.clear_studio_operational_data_atomic({quote(x['studio'])},false);",
                hold=True,
                role="postgres",
            )
            ready(clear)
            got = invoke(command(x))
            require(
                not got["ok"] and got["message"] == "AUTOMATION_STUDIO_BUSY",
                "Clear-first did not exclude advance",
            )
            release(clear, rollback=rollback)
            advance(x)
            current = snapshot(x)
            require(
                (current["lead"] is not None) == rollback
                and len(current["actions"]) == int(rollback),
                "Clear resurrected source",
            )
            x = fixture(mode="lead_follow_up")
            owner = session("advance_clear", command(x), hold=True)
            ready(owner)
            clear = session(
                "clear_after",
                f"SELECT public.clear_studio_operational_data_atomic({quote(x['studio'])},false);",
                role="postgres",
            )
            blocked(owner, clear)
            release(owner, rollback=rollback)
            finished(clear)
            current = snapshot(x)
            require(
                current["lead"] is None
                and len(current["actions"]) == int(not rollback),
                "Begin-first logical receipt/clear truth",
            )
        passed(
            "actual operational clear first/advance first commit/rollback without resurrection"
        )

        # Build real uncertain settlement evidence by temporarily removing payer
        # identity, recording a succeeded payment, then restoring the parent only.
        financial_text = (
            ROOT / "supabase/verification/workflow_financial_authority_contract.sql"
        ).read_text()
        start = financial_text.index("CREATE FUNCTION pg_temp.financial_payment(")
        end = financial_text.index("CREATE FUNCTION pg_temp.financial_workflow(", start)
        sql(financial_text[start:end].replace("pg_temp.", "advance_proof."))

        def uncertain(x):
            return value(f"""UPDATE public.billing_payers SET stripe_account_id=NULL,stripe_customer_id=NULL,connect_account_generation=NULL WHERE id={quote(x["payer"])};
                SELECT to_jsonb(advance_proof.financial_payment({quote(x)}));""")

        def restore_payer(x):
            sql(
                f"UPDATE public.billing_payers SET stripe_account_id='acct_'||replace(studio_id::text,'-',''),stripe_customer_id='cus_'||id,connect_account_generation=1 WHERE id={quote(x['payer'])};"
            )

        def finance(x):
            return value(
                f"SELECT jsonb_build_object('authority',(SELECT to_jsonb(a) FROM private.workflow_invoice_settlement_authority a WHERE invoice_id={quote(x['invoice'])}),'observations',(SELECT jsonb_agg(to_jsonb(o) ORDER BY payment_id) FROM private.workflow_payment_settlement_observations o WHERE studio_id={quote(x['studio'])}),'runs',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM public.automation_workflow_runs r WHERE studio_id={quote(x['studio'])}));"
            )

        x = fixture("invoice.payment_failed")
        uncertain(x)
        restore_payer(x)
        result = advance(x)
        require(
            result["outcome"] == "stopped"
            and result["run"]["state"] == "cancelled"
            and result["run"]["reason"] == "payment_settled",
            "Self-cancel repair undone by cleared token",
        )
        require(
            finance(x)["authority"]["generation"] == 2 and not snapshot(x)["steps"],
            "Self-cancel repair/step truth",
        )
        passed("financial repair self-cancels and retains stopped original-token echo")
        for desired in (False, True):
            for _ in range(20):
                failed = fixture("invoice.payment_failed")
                target = value(
                    f"SELECT advance_proof.advance_seed({quote(failed)},'invoice.overdue');"
                )
                target = value(f"SELECT advance_proof.advance_claim({quote(target)});")
                if (target["workflow"] > failed["workflow"]) == desired:
                    break
            else:
                raise RuntimeError("Could not construct workflow ordering fixture")
            uncertain(target)
            restore_payer(target)
            before = finance(target)
            manager = session(
                "target_busy",
                f"SELECT 1 FROM public.automation_workflows WHERE id={quote(target['workflow'])} FOR UPDATE;",
                hold=True,
            )
            ready(manager)
            got = invoke(command(target))
            require(
                not got["ok"] and got["message"] == "AUTOMATION_STUDIO_BUSY",
                "Late target did not refuse",
            )
            require(
                finance(target) == before,
                "Late target refusal leaked repair or cancellation",
            )
            release(manager)
            require(
                advance(target)["run"]["state"] == "completed",
                "Retry after definite busy did not progress",
            )
            require(
                snapshot(failed)["run"]["state"] == "cancelled",
                "Required cancellation skipped",
            )
        passed(
            "financial cancellation versus lower/higher target NOWAIT atomic rollback"
        )
        for external_cancel in (False, True):
            failed = fixture("invoice.payment_failed")
            target = (
                failed
                if external_cancel
                else value(
                    f"SELECT advance_proof.advance_seed({quote(failed)},'invoice.overdue');"
                )
            )
            if not external_cancel:
                target = value(f"SELECT advance_proof.advance_claim({quote(target)});")
            uncertain(target)
            restore_payer(target)
            sql(
                f"UPDATE public.automation_workflow_runs SET lease_expires_at=clock_timestamp()+INTERVAL '1 second' WHERE id={quote(target['run'])};"
            )
            before = finance(target)
            manager = session(
                "cancel_union",
                f"SELECT 1 FROM public.automation_workflows WHERE id={quote(failed['workflow'])} FOR UPDATE;",
                hold=True,
            )
            ready(manager)
            worker = session("repair_wait", command(target))
            blocked(manager, worker)
            if external_cancel:
                manager["process"].stdin.write(
                    f"SELECT private.workflow_cancel_runs_v1({quote(failed['studio'])},ARRAY[{quote(failed['run'])}]::uuid[],clock_timestamp(),'run_cancelled');\n"
                )
                manager["process"].stdin.flush()
            time.sleep(1.1)
            release(manager)
            result = finished(worker)["payload"]
            if external_cancel:
                require(
                    result["outcome"] == "stopped"
                    and result["run"]["reason"] == "run_cancelled",
                    "External cancellation lost to expiry",
                )
            else:
                require(
                    result["outcome"] == "lease_lost"
                    and result["run"] is None
                    and finance(target) == before,
                    "Post-wait executable expiry leaked preparation",
                )
        passed(
            "real cancellation-union wait external cancellation and executable lease expiry rollback"
        )

        # A local diagnostic barrier introduces no authority: the real source
        # owner executes unchanged, then final clock/token checks must still run.
        signature = "private.workflow_lock_run_sources_v1(uuid,private.automation_workflow_events,jsonb)"
        original = sql(f"SELECT pg_get_functiondef({quote(signature)}::regprocedure);")
        for lease in (False, True):
            x = fixture("trial.scheduled", "lead_follow_up")
            if lease:
                sql(
                    f"UPDATE public.automation_workflow_runs SET lease_expires_at=clock_timestamp()+INTERVAL '1 second' WHERE id={quote(x['run'])};"
                )
            else:
                sql(
                    f"UPDATE public.lead_trial_appointments SET starts_at=clock_timestamp()+INTERVAL '1 second',ends_at=clock_timestamp()+INTERVAL '1 hour' WHERE id={quote(x['trial_appointment'])};"
                )
            before = snapshot(x)
            gate = session(
                "final_clock_gate",
                "SELECT pg_advisory_xact_lock(57003001);",
                hold=True,
                role="postgres",
            )
            ready(gate)
            sql(
                "ALTER FUNCTION "
                + signature
                + " RENAME TO workflow_lock_run_sources_proof;"
            )
            try:
                sql("""CREATE FUNCTION private.workflow_lock_run_sources_v1(uuid,private.automation_workflow_events,jsonb) RETURNS void LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
BEGIN PERFORM private.workflow_lock_run_sources_proof($1,$2,$3); PERFORM pg_catalog.pg_advisory_xact_lock(57003001); END $$;
REVOKE ALL ON FUNCTION private.workflow_lock_run_sources_v1(uuid,private.automation_workflow_events,jsonb) FROM PUBLIC; GRANT EXECUTE ON FUNCTION private.workflow_lock_run_sources_v1(uuid,private.automation_workflow_events,jsonb) TO service_role;""")
                worker = session("final_clock_worker", command(x))
                blocked(gate, worker)
                time.sleep(1.1)
                release(gate)
                result = finished(worker)["payload"]
                if lease:
                    require(
                        result["outcome"] == "lease_lost" and snapshot(x) == before,
                        "Late lease expiry created action",
                    )
                else:
                    require(
                        result["outcome"] == "stopped"
                        and result["run"]["reason"] == "trial_unavailable"
                        and not snapshot(x)["actions"],
                        "Late event expiry created action",
                    )
            finally:
                sql(
                    "DROP FUNCTION "
                    + signature
                    + "; ALTER FUNCTION private.workflow_lock_run_sources_proof(uuid,private.automation_workflow_events,jsonb) RENAME TO workflow_lock_run_sources_v1;"
                )
            require(
                sql(f"SELECT pg_get_functiondef({quote(signature)}::regprocedure);")
                == original,
                "Diagnostic source definition not restored",
            )
        passed(
            "diagnostic final-lock barrier rechecks physical lease and preevent window"
        )

        # Pause precisely between mutable promotion rank-parent discovery and
        # reference acquisition. Only this diagnostic copy gains the barrier.
        anchor = "SELECT ladder_id INTO v_ladder FROM public.belt_ranks WHERE studio_id=p_studio_id AND id=v_promotion.to_rank_id;"
        require(anchor in original, "Expected exact rank-parent discovery seam")
        for rollback in (False, True):
            x = fixture("student.promoted")
            ladder = str(uuid4())
            sql(
                f"INSERT INTO public.belt_ladders(id,studio_id,name,program_id) VALUES({quote(ladder)},{quote(x['studio'])},'Reparent fixture',{quote(x['program2'])});"
            )
            gate = session(
                "rank_parent_gate",
                "SELECT pg_advisory_xact_lock(57003002);",
                hold=True,
                role="postgres",
            )
            ready(gate)
            sql(
                original.replace(
                    anchor,
                    anchor + " PERFORM pg_catalog.pg_advisory_xact_lock(57003002);",
                )
            )
            try:
                worker = session(
                    "rank_parent_worker",
                    "SELECT advance_proof.rpc(" + quote(command(x)) + ");",
                )
                blocked(gate, worker)
                writer = session(
                    "rank_reparent",
                    f"UPDATE public.belt_ranks SET ladder_id={quote(ladder)} WHERE id={quote(x['rank2'])};",
                    hold=True,
                    role="postgres",
                )
                ready(writer)
                release(writer, rollback=rollback)
                release(gate)
                got = finished(worker)
                require(
                    (
                        got["ok"]
                        and got["data"]["payload"]["run"]["state"] == "completed"
                    )
                    if rollback
                    else (not got["ok"] and got["message"] == "AUTOMATION_STUDIO_BUSY"),
                    "Rank-parent reparent escape",
                )
            finally:
                sql(original)
        passed("mutable promotion rank-parent commit/rollback discovery gap")

        # A synthetic historical failed event refers to a payment whose invoice
        # association is still absent. The retained writer permits NULL->invoice.
        for rollback in (False, True):
            base_payment = fixture("invoice.payment_failed")
            orphan = value(
                f"SELECT to_jsonb(advance_proof.financial_payment({quote(base_payment)},'failed','{{\"invoice_id\":null}}'));"
            )
            x = value(f"""WITH event AS (
                INSERT INTO private.automation_workflow_events(studio_id,event_type,source_key,subject_kind,subject_id,occurred_at,context)
                SELECT studio_id,event_type,'late-association-fixture:'||{quote(orphan)},subject_kind,{quote(orphan)}::uuid,occurred_at,
                    jsonb_set(jsonb_set(context,'{{payment_id}}',to_jsonb({quote(orphan)}::uuid)),'{{payment_evidence,payment_id}}',to_jsonb({quote(orphan)}::uuid))
                FROM private.automation_workflow_events WHERE id={quote(base_payment["source_event"])} RETURNING id),
                run AS (INSERT INTO public.automation_workflow_runs(studio_id,workflow_id,version_id,event_id,activation_id,epoch,current_node_id)
                SELECT studio_id,workflow_id,version_id,event.id,activation_id,epoch,'trigger' FROM public.automation_workflow_runs CROSS JOIN event WHERE public.automation_workflow_runs.id={quote(base_payment["run"])} RETURNING id,event_id)
                SELECT {quote(base_payment)}::jsonb||jsonb_build_object('run',id,'source_event',event_id,'payment',{quote(orphan)},'subject',{quote(orphan)}) FROM run;""")
            x = value(f"SELECT advance_proof.advance_claim({quote(x)});")
            writer = session(
                "late_invoice",
                f"UPDATE public.billing_payments SET invoice_id={quote(x['invoice'])} WHERE id={quote(orphan)};",
                hold=True,
                role="postgres",
            )
            ready(writer)
            got = invoke(command(x))
            require(
                not got["ok"] and got["message"] == "AUTOMATION_STUDIO_BUSY",
                "Late association was read before payment ownership",
            )
            release(writer, rollback=rollback)
            owner = session("late_invoice_advance", command(x), hold=True)
            ready(owner)
            if not rollback:
                refused = invoke(
                    f"SELECT to_jsonb(i) FROM public.billing_invoices i WHERE id={quote(x['invoice'])} FOR UPDATE NOWAIT;"
                )
                require(
                    not refused["ok"] and refused["code"] == "55P03",
                    "Current late-associated invoice was not locked",
                )
            got = release(owner)["payload"]
            require(
                got["run"]["state"] == ("cancelled" if rollback else "completed"),
                "Late association current fact mismatch",
            )
        passed(
            "real late payment association commit/rollback and current invoice ownership"
        )

        # The accepted overflow correction and runtime both wait when the valid
        # event anchor plus one minute lies beyond the Python/DTO year9999 bound.
        x = fixture(
            "trial.scheduled",
            "delay",
            {"mode": "until", "field": "trial.starts_at", "offset_minutes": 1},
        )
        sql(
            f"UPDATE public.lead_trial_appointments SET starts_at='9999-12-31 23:59:00+00',ends_at='9999-12-31 23:59:30+00' WHERE id={quote(x['trial_appointment'])};"
        )
        got = advance(x)
        graph = value(
            f"SELECT v.graph FROM public.automation_workflow_runs r JOIN public.automation_workflow_versions v ON v.id=r.version_id WHERE r.id={quote(x['run'])};"
        )
        trigger = next(n["config"] for n in graph["nodes"] if n["type"] == "trigger")
        facts = value(
            f"SELECT private.workflow_current_source_facts_v1({quote(x['studio'])},'trial.scheduled',{quote(x['subject'])},(SELECT context FROM private.automation_workflow_events WHERE id={quote(x['source_event'])}),{quote(trigger)},clock_timestamp(),'{{}}')->'facts';"
        )
        reference = datetime.fromisoformat(
            snapshot(x)["steps"][0]["entered_at"].replace("Z", "+00:00")
        )
        projected = _walk(
            WorkflowGraph.model_validate(graph),
            "trial.scheduled",
            _decode_facts(_Facts.model_validate(facts), "trial.scheduled", frozenset()),
            reference,
        )
        require(
            got["outcome"] == "waiting"
            and got["run"]["reason"] == "facts_unavailable"
            and projected[-1].outcome == "waiting"
            and projected[-1].reason == "facts_unavailable"
            and projected[-1].scheduled_at is None,
            "Overflow arithmetic parity drift",
        )
        passed("actual accepted simulation overflow and runtime unavailable parity")

        # Explicit midnight reference proves the scheduling DATE belongs to the
        # studio and the activity/receipt share the passed final effect clock.
        x = fixture(mode="lead_follow_up")
        advance(x, 1)
        sql(
            f"UPDATE public.studios SET timezone='America/Los_Angeles' WHERE id={quote(x['studio'])};"
        )
        got = value(f"""BEGIN; DO $$ BEGIN PERFORM pg_advisory_xact_lock_shared(hashtextextended('koaryu.local-plan-clear:'||{quote(x["studio"])},0));
            PERFORM 1 FROM public.leads WHERE id={quote(x["lead"])} FOR UPDATE;
            PERFORM 1 FROM public.automation_workflows WHERE id={quote(x["workflow"])} FOR UPDATE;
            PERFORM 1 FROM public.automation_workflow_runs WHERE id={quote(x["run"])} FOR UPDATE;
            INSERT INTO private.automation_workflow_run_steps(studio_id,run_id,sequence,node_id,node_type,outcome,entered_at)
            VALUES({quote(x["studio"])},{quote(x["run"])},2,'work','lead_follow_up','entered','2026-10-06T00:30:00Z');
            PERFORM private.workflow_apply_lead_follow_up_v1({quote(x["studio"])},{quote(x["run"])},(SELECT id FROM private.automation_workflow_run_steps WHERE run_id={quote(x["run"])} AND node_id='work'),'work',{quote(x["lead"])},'{{"due_in_days":0,"note":""}}','2026-10-06T00:30:00Z'); END $$;
            SELECT jsonb_build_object('date',r.due_date,'equal',r.created_at=a.created_at) FROM private.automation_workflow_follow_up_actions r JOIN public.lead_activities a ON a.id=r.activity_id WHERE r.run_id={quote(x["run"])}; COMMIT;""")
        require(
            got == {"date": "2026-10-05", "equal": True},
            "Studio midnight/effect clock not preserved",
        )
        passed("studio-local midnight date and exact activity/receipt clock")

        passed("unique final component cases complete; assembled V57 upgrade and post-install restore is separate")
        require(MIGRATION.read_bytes() == frozen, "Source changed during proof")
        final_inventory = value(inventory_sql)
        require(
            all(final_inventory.get(k) == v for k, v in installed.items()),
            "Retained installed functions changed",
        )
        print(
            json.dumps(
                {
                    "cases": cases,
                    "source_sha256": hashlib.sha256(frozen).hexdigest(),
                    "contract_sha256": hashlib.sha256(
                        CONTRACT.read_bytes()
                    ).hexdigest(),
                    "runner_sha256": hashlib.sha256(
                        Path(__file__).read_bytes()
                    ).hexdigest(),
                    "sdk": version("postgrest"),
                    "bridge": "actual guarded SQL via synthetic HTTP transport, not live PostgREST",
                    "limits": "Sending expiry and all attempt/gate/reservation/provider owners remain08C. Timed enrollment and V57 readiness are not claimed.",
                }
            ),
            flush=True,
        )
    finally:
        close_children()
        try:
            if owned:
                local.sql(
                    "postgres", f"DROP DATABASE IF EXISTS {database} WITH (FORCE);"
                )
        finally:
            if dump_owned and dump.exists():
                dump.unlink()
        require(
            local.sql(
                "postgres",
                f"SELECT NOT EXISTS(SELECT 1 FROM pg_database WHERE datname={quote(database)});",
            )
            == "t",
            "Owned clone not removed",
        )
        require(pid_file.read_text().splitlines()[0] == pid, "PM cluster PID changed")
        require(
            local.sql(
                "postgres",
                "SELECT row_to_json(p) FROM public.koaryu_release_schema_preflight_v37() p;",
            )
            == base_before,
            "PM base changed",
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
        print(
            json.dumps(
                {
                    "owned_clone_removed": database if owned else None,
                    "historical_unchanged": 151,
                    "base_preflight_unchanged": True,
                    "pm_pid_unchanged": pid,
                }
            ),
            flush=True,
        )


if __name__ == "__main__":
    main(sys.argv[1:])
