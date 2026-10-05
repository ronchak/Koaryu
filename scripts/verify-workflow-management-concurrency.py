#!/usr/bin/env python3
"""Check the partial workflow SQL pilot in one owned disposable PG17 clone.

No hosted targets, credentials, migration-history registration, or release-readiness
claim. The caller owns the base cluster; this script always drops its own clone.
"""

import hashlib
import json
import os
import queue
import subprocess
import sys
import threading
import time
from copy import deepcopy
from pathlib import Path
from uuid import uuid4

from local_postgres_verification import LocalPostgres, require

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = (
    ROOT / "supabase/migrations/20261005105341_automation_workflow_graph_v57.sql"
)
CONTRACT = ROOT / "supabase/verification/workflow_management_contract.sql"
sys.path.insert(0, str(ROOT / "backend"))
from app.services.workflow_catalog import CATALOG, _copy_json
from app.services.workflow_graph import (
    validate_workflow_draft,
    validate_workflow_graph,
)


def quote(value):
    if value is None:
        return "NULL"
    if isinstance(value, (dict, list)):
        value = json.dumps(value, ensure_ascii=True, separators=(",", ":"))
    return "'" + str(value).replace("'", "''") + "'"


def main(arguments):
    require(len(arguments) == 3, "Expected psql socket port")
    psql, socket, port = arguments
    local = LocalPostgres(psql, socket, port, str(Path(socket).parent))
    database = f"koaryu_workflow_management_{os.getpid()}"
    children = []
    cases = []
    owned = False
    historical = {
        p.name: hashlib.sha256(p.read_bytes()).hexdigest()
        for p in MIGRATION.parent.glob("*.sql")
        if p != MIGRATION
    }
    require(len(historical) == 151, "Expected exactly 151 historical migrations")
    simple = {
        "schema_version": 1,
        "nodes": [
            {
                "id": "start",
                "type": "trigger",
                "config": {"event_type": "lead.created"},
            },
            {"id": "end", "type": "end", "config": {}},
        ],
        "edges": [{"id": "next", "source": "start", "target": "end", "port": "next"}],
    }

    def sql(statement):
        return local.sql(database, statement)

    def fixture():
        ids = {
            key: str(uuid4()) for key in ("actor", "other_actor", "studio", "operation")
        }
        sql(f"""BEGIN;
INSERT INTO auth.users(id,email) VALUES('{ids["actor"]}','{ids["actor"]}@example.invalid'),
('{ids["other_actor"]}','{ids["other_actor"]}@example.invalid');
UPDATE auth.users SET email_confirmed_at=clock_timestamp() WHERE id IN ('{ids["actor"]}','{ids["other_actor"]}');
INSERT INTO public.studios(id,name,slug,owner_id,timezone)
VALUES('{ids["studio"]}','Workflow concurrency','{ids["studio"]}','{ids["other_actor"]}','UTC');
INSERT INTO public.staff_roles(studio_id,user_id,role) VALUES
('{ids["studio"]}','{ids["actor"]}','admin'),('{ids["studio"]}','{ids["other_actor"]}','admin');
INSERT INTO public.studio_subscriptions(studio_id,status,comped) VALUES('{ids["studio"]}','active',false);
COMMIT;""")
        return ids

    def create(ids, operation=None, name="Workflow", actor=None, graph=None):
        return (
            "SELECT public.create_automation_workflow_v1("
            + ",".join(
                map(
                    quote,
                    (
                        ids["studio"],
                        actor or ids["actor"],
                        operation or ids["operation"],
                        name,
                        "",
                        graph or simple,
                        {},
                    ),
                )
            )
            + ");"
        )

    def save(ids, operation=None, name="Saved", revision=1):
        return (
            "SELECT public.save_automation_workflow_v1("
            + ",".join(
                map(
                    quote,
                    (
                        ids["studio"],
                        ids["actor"],
                        ids["workflow"],
                        operation or str(uuid4()),
                        revision,
                        name,
                        "",
                        simple,
                        {},
                    ),
                )
            )
            + ");"
        )

    def command(ids, action, revision, operation=None):
        return (
            "SELECT public.command_automation_workflow_v1("
            + ",".join(
                map(
                    quote,
                    (
                        ids["studio"],
                        ids["actor"],
                        ids["workflow"],
                        operation or str(uuid4()),
                        revision,
                        action,
                    ),
                )
            )
            + ");"
        )

    def provision(ids):
        ids["workflow"] = json.loads(sql(create(ids)))["payload"]["id"]

    def session(name, statement, hold=False, role="service_role"):
        name = f"workflow_management_{os.getpid()}_{name}"[:63]
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
            "lines": [],
            "errors": [],
            "events": queue.Queue(),
            "name": name,
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
            f"SET application_name='{name}';\nBEGIN;\nSET LOCAL statement_timeout='20s';\n"
            f"SET LOCAL ROLE {role};\n{statement}\n"
        )
        if hold:
            process.stdin.write("SELECT 'RESULT_READY';\n")
            process.stdin.flush()
        else:
            process.stdin.write("COMMIT;\n")
            process.stdin.close()
        return item

    def result(item):
        rows = [json.loads(line) for line in item["lines"] if line.startswith("{")]
        require(len(rows) == 1, f"Expected exactly one JSON result: {item['lines']}")
        return rows[0]

    def ready(item):
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            try:
                if item["events"].get(timeout=0.05) == "RESULT_READY":
                    return result(item)
            except queue.Empty:
                require(
                    item["process"].poll() is None,
                    "Holding session failed: " + "\n".join(item["errors"]),
                )
        raise RuntimeError("Session did not reach result barrier")

    def finished(item, expected_error=None):
        code = item["process"].wait(timeout=25)
        for thread in item["threads"]:
            thread.join(timeout=2)
        errors = "\n".join(item["errors"])
        require("40P01" not in errors, f"Deadlock: {errors}")
        if expected_error:
            require(
                code != 0 and expected_error in errors,
                f"Wrong expected error: {errors}",
            )
            return None
        require(code == 0, f"Session failed: {errors}")
        return result(item)

    def release(item, rollback=False):
        item["process"].stdin.write("ROLLBACK;\n" if rollback else "COMMIT;\n")
        item["process"].stdin.close()
        return finished(item)

    def blocked(first, second, advisory=False):
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            require(
                second["process"].poll() is None,
                "Waiter exited before lock observation: " + "\n".join(second["errors"]),
            )
            row = json.loads(
                sql(
                    "SELECT COALESCE(jsonb_agg(jsonb_build_object('wait',b.wait_event,'type',b.wait_event_type)),'[]'::jsonb) "
                    "FROM pg_stat_activity a JOIN pg_stat_activity b ON a.datname=b.datname "
                    f"WHERE a.application_name='{first['name']}' AND b.application_name='{second['name']}' "
                    "AND a.pid=ANY(pg_blocking_pids(b.pid));"
                )
            )
            if row and row[0]["type"] == "Lock":
                require(
                    not advisory or row[0]["wait"] == "advisory",
                    "Expected advisory serialization",
                )
                return row[0]
            time.sleep(0.025)
        raise RuntimeError("Expected competing PostgreSQL lock was not observed")

    def passed(name, **facts):
        cases.append({"case": name, "outcome": "passed", **facts})
        print(f"[workflow management] PASS {name}", flush=True)

    def graph_parity():
        projection = {
            key: _copy_json(CATALOG[key])
            for key in ("triggers", "fields", "recipients", "variables", "delay_fields")
        }
        canonical = json.dumps(
            projection, sort_keys=True, separators=(",", ":"), ensure_ascii=True
        )
        digest = hashlib.sha256(canonical.encode()).hexdigest()
        require(
            f"-- catalog-source-sha256: {digest}" in MIGRATION.read_text(),
            "SQL catalog source hash drift",
        )
        require(
            json.loads(sql("SELECT private.workflow_catalog_v1();")) == projection,
            "SQL catalog metadata drift",
        )
        passed("exact catalog metadata and source hash")
        specimens = [
            (f"preset {p['id']}", _copy_json(p["graph"]), {})
            for p in CATALOG["presets"]
        ]
        require(len(specimens) == 9, "Expected all nine catalog presets")
        specimens += [
            ("empty draft", {"schema_version": 1, "nodes": [], "edges": []}, {}),
            ("null graph", None, {}),
        ]

        def variant(label, edit):
            g, layout = deepcopy(simple), {}
            edit(g, layout)
            specimens.append((label, g, layout))

        variant("unknown top key", lambda g, _: g.update(code="execute"))
        variant("boolean schema", lambda g, _: g.update(schema_version=True))
        variant("null schema", lambda g, _: g.update(schema_version=None))
        variant("unknown schema", lambda g, _: g.update(schema_version=2))
        variant(
            "bad node identifier",
            lambda g, _: g["nodes"][0].update(id="secret <payload>"),
        )
        variant(
            "duplicate node", lambda g, _: g["nodes"].append(deepcopy(g["nodes"][0]))
        )
        variant("unknown node type", lambda g, _: g["nodes"][0].update(type="script"))
        variant("missing node config", lambda g, _: g["nodes"][0].pop("config"))
        variant(
            "unknown config",
            lambda g, _: g["nodes"][0]["config"].update(arbitrary="code"),
        )
        variant(
            "unknown trigger",
            lambda g, _: g["nodes"][0]["config"].update(event_type="lead.injected"),
        )
        variant(
            "blank trigger", lambda g, _: g["nodes"][0]["config"].update(event_type="")
        )
        variant(
            "missing trigger", lambda g, _: g["nodes"][0]["config"].pop("event_type")
        )
        variant(
            "bool trigger", lambda g, _: g["nodes"][0]["config"].update(event_type=True)
        )
        variant(
            "nonupcoming offset",
            lambda g, _: g["nodes"][0]["config"].update(offset_minutes=-1),
        )
        variant(
            "upcoming zero",
            lambda g, _: g["nodes"][0]["config"].update(
                event_type="trial.upcoming", offset_minutes=0
            ),
        )
        variant(
            "upcoming omitted",
            lambda g, _: g["nodes"][0]["config"].update(event_type="trial.upcoming"),
        )
        variant(
            "upcoming lower bound",
            lambda g, _: g["nodes"][0]["config"].update(
                event_type="trial.upcoming", offset_minutes=-129600
            ),
        )
        variant(
            "upcoming exceeds bound",
            lambda g, _: g["nodes"][0]["config"].update(
                event_type="trial.upcoming", offset_minutes=-129601
            ),
        )
        variant(
            "invoice program filter",
            lambda g, _: g["nodes"][0]["config"].update(
                event_type="invoice.overdue", program_id=str(uuid4())
            ),
        )
        variant(
            "malformed program UUID",
            lambda g, _: g["nodes"][0]["config"].update(program_id="x"),
        )
        variant(
            "unknown edge key", lambda g, _: g["edges"][0].update(source_port="next")
        )
        variant(
            "unknown edge target", lambda g, _: g["edges"][0].update(target="missing")
        )
        variant(
            "duplicate edge", lambda g, _: g["edges"].append(deepcopy(g["edges"][0]))
        )
        variant(
            "unsupported edge port", lambda g, _: g["edges"][0].update(port="maybe")
        )
        variant("wrong output port", lambda g, _: g["edges"][0].update(port="yes"))
        variant("disconnected draft", lambda g, _: g.update(edges=[]))
        variant(
            "cyclic draft",
            lambda g, _: g["edges"].append(
                {"id": "back", "source": "end", "target": "start", "port": "next"}
            ),
        )
        variant(
            "unknown layout node",
            lambda g, l: l.update(positions={"missing": {"x": 1, "y": 2}}),
        )
        variant(
            "layout boundary",
            lambda g, l: l.update(positions={"start": {"x": -100000, "y": 100000}}),
        )
        variant(
            "layout outside boundary",
            lambda g, l: l.update(positions={"start": {"x": -100001, "y": 0}}),
        )
        variant(
            "boolean layout",
            lambda g, l: l.update(positions={"start": {"x": True, "y": 0}}),
        )
        variant("unknown layout field", lambda g, l: l.update(positions={}, zoom=1))
        variant(
            "over nodes",
            lambda g, _: g.update(
                nodes=[{"id": f"n{i}", "type": "end", "config": {}} for i in range(41)],
                edges=[],
            ),
        )
        variant(
            "over edges",
            lambda g, _: g.update(
                edges=[
                    {"id": f"e{i}", "source": "start", "target": "end", "port": "next"}
                    for i in range(61)
                ]
            ),
        )

        def with_node(kind, config, trigger="lead.created"):
            g = deepcopy(simple)
            g["nodes"][0]["config"]["event_type"] = trigger
            g["nodes"].insert(1, {"id": "middle", "type": kind, "config": config})
            g["edges"][0]["target"] = "middle"
            g["edges"].append(
                {
                    "id": "middle_next",
                    "source": "middle",
                    "target": "end",
                    "port": "next",
                }
            )
            if kind == "condition":
                g["edges"][-1]["port"] = "yes"
                g["edges"].append(
                    {
                        "id": "middle_no",
                        "source": "middle",
                        "target": "end",
                        "port": "no",
                    }
                )
            return g

        for whitespace in ("\u00a0", "\u2007", "\u202f", "\x1c"):
            whitespace_graph = deepcopy(simple)
            whitespace_graph["nodes"][0]["config"]["event_type"] = whitespace
            specimens.append(
                ("Python whitespace trigger " + ascii(whitespace), whitespace_graph, {})
            )
            specimens.append(
                (
                    "Python whitespace operator " + ascii(whitespace),
                    with_node(
                        "condition",
                        {
                            "field": "lead.stage",
                            "operator": whitespace,
                            "value": "inquiry",
                        },
                    ),
                    {},
                )
            )
        specimens.append(
            (
                "Python whitespace templates",
                with_node(
                    "email",
                    {
                        "recipient": "lead_or_guardian",
                        "subject_template": "\u00a0",
                        "body_template": "\u2007",
                    },
                ),
                {},
            )
        )

        for label, config in [
            ("omitted nullable value", {"field": "program.id", "operator": "eq"}),
            (
                "explicit nullable null",
                {"field": "program.id", "operator": "eq", "value": None},
            ),
            (
                "nonnullable null",
                {"field": "lead.unconverted", "operator": "eq", "value": None},
            ),
            (
                "bool comparison",
                {"field": "lead.unconverted", "operator": "eq", "value": True},
            ),
            (
                "numeric bool mismatch",
                {"field": "lead.unconverted", "operator": "eq", "value": 1},
            ),
            (
                "enum membership",
                {
                    "field": "lead.stage",
                    "operator": "in",
                    "value": ["inquiry", "trial_scheduled"],
                },
            ),
            (
                "invalid enum",
                {"field": "lead.stage", "operator": "eq", "value": "invented"},
            ),
            (
                "empty membership",
                {"field": "lead.stage", "operator": "in", "value": []},
            ),
            (
                "null membership member",
                {"field": "lead.stage", "operator": "in", "value": [None]},
            ),
            (
                "over membership bound",
                {"field": "lead.stage", "operator": "in", "value": ["inquiry"] * 101},
            ),
            (
                "membership before operator",
                {"field": "lead.stage", "value": ["inquiry"]},
            ),
            ("missing selections", {}),
            ("nested value", {"value": {"script": "code"}}),
            ("overlong value", {"value": "x" * 501}),
            (
                "unsupported ordering",
                {"field": "lead.stage", "operator": "gt", "value": "inquiry"},
            ),
            ("unknown condition field", {"field": "student.secret"}),
            (
                "inapplicable condition",
                {"field": "student.status", "operator": "eq", "value": "active"},
            ),
        ]:
            specimens.append((label, with_node("condition", config), {}))
        for label, config in [
            ("blank email", {}),
            (
                "blank explicit email",
                {
                    "recipient": None,
                    "subject_template": "",
                    "body_template": "",
                    "reply_to_email": "",
                },
            ),
            (
                "valid email",
                {
                    "recipient": "lead_or_guardian",
                    "subject_template": "Hi {{recipient_name}}",
                    "body_template": "{{studio_name}}\nHello\tthere",
                },
            ),
            ("wrong recipient family", {"recipient": "invoice_payer"}),
            ("unknown recipient", {"recipient": "arbitrary_email"}),
            ("unsafe expression", {"subject_template": "{{ recipient_name }}"}),
            ("unknown variable", {"subject_template": "{{credit_card}}"}),
            ("inapplicable variable", {"subject_template": "{{student_first_name}}"}),
            ("subject newline", {"subject_template": "Hello\nWorld"}),
            ("body carriage return", {"body_template": "Hello\rWorld"}),
            ("body C1", {"body_template": "Hello\u0085World"}),
            ("null template", {"subject_template": None}),
            ("long subject", {"subject_template": "x" * 201}),
            ("long body", {"body_template": "x" * 5001}),
            ("valid reply", {"reply_to_email": " Sender@Example.Invalid "}),
            ("bad reply", {"reply_to_email": "wrong@localhost"}),
        ]:
            specimens.append((label, with_node("email", config), {}))
        for label, config in [
            ("duration incomplete", {"mode": "duration"}),
            ("duration zero", {"mode": "duration", "minutes": 0}),
            ("duration upper", {"mode": "duration", "minutes": 129600}),
            ("duration over", {"mode": "duration", "minutes": 129601}),
            ("duration bool", {"mode": "duration", "minutes": True}),
            (
                "duration unknown key",
                {"mode": "duration", "minutes": 1, "field": "trial.starts_at"},
            ),
            (
                "until valid",
                {
                    "mode": "until",
                    "field": "trial.starts_at",
                    "offset_minutes": -129600,
                },
            ),
            ("until wrong event", {"mode": "until", "field": "belt_test.starts_at"}),
            ("until missing selection", {"mode": "until"}),
            ("delay unknown mode", {"mode": "script"}),
        ]:
            specimens.append((label, with_node("delay", config, "trial.scheduled"), {}))
        for config in (
            {},
            {"due_in_days": 0},
            {"due_in_days": 90},
            {"due_in_days": 91},
            {"due_in_days": True},
            {"note": "x" * 1001},
            {"note": None},
        ):
            specimens.append(
                (
                    "follow up " + str(len(specimens)),
                    with_node("lead_follow_up", config),
                    {},
                )
            )
        specimens.append(
            (
                "follow up wrong subject",
                with_node("lead_follow_up", {"due_in_days": 0}, "student.enrolled"),
                {},
            )
        )
        values = []
        expected = []
        for index, (label, graph, layout) in enumerate(specimens):
            draft = validate_workflow_draft(graph, catalog=CATALOG, layout=layout).valid
            executable = validate_workflow_graph(
                graph, catalog=CATALOG, layout=layout
            ).valid
            expected.append((label, draft, executable))
            values.append(f"({index},{quote(graph)}::jsonb,{quote(layout)}::jsonb)")
        observed = json.loads(
            sql(
                "SELECT jsonb_agg(jsonb_build_array(i,private.workflow_validate_v1(g,l,false)='[]'::jsonb,"
                "private.workflow_validate_v1(g,l,true)='[]'::jsonb) ORDER BY i) FROM (VALUES "
                + ",".join(values)
                + ") specimen(i,g,l);"
            )
        )
        for index, draft, executable in observed:
            label, expected_draft, expected_exec = expected[index]
            require(
                (draft, executable) == (expected_draft, expected_exec),
                f"Graph parity mismatch {label}: SQL {(draft, executable)}, Python {(expected_draft, expected_exec)}",
            )
        omitted = with_node("condition", {"field": "program.id", "operator": "eq"})
        normalized = json.loads(
            sql(f"SELECT private.workflow_semantic_graph_v1({quote(omitted)}::jsonb);")
        )
        require(
            "value"
            not in next(n for n in normalized["nodes"] if n["id"] == "middle")[
                "config"
            ],
            "Omitted nullable value became null",
        )
        mixed = {
            "schema_version": 1,
            "nodes": [
                {"id": i, "type": "end", "config": {}}
                for i in ("z", "Z", "a", "A", "_")
            ],
            "edges": [],
        }
        reordered = {**mixed, "nodes": list(reversed(mixed["nodes"]))}
        result = json.loads(
            sql(
                f"SELECT jsonb_build_object('graph',private.workflow_semantic_graph_v1({quote(mixed)}),"
                f"'same',private.workflow_hash_v1(private.workflow_semantic_graph_v1({quote(mixed)}))="
                f"private.workflow_hash_v1(private.workflow_semantic_graph_v1({quote(reordered)})));"
            )
        )
        require(
            result["same"]
            and [n["id"] for n in result["graph"]["nodes"]]
            == ["A", "Z", "_", "a", "z"],
            "Canonical C ordering drift",
        )
        passed(
            "SQL Python graph acceptance parity",
            specimens=len(specimens),
            validation_results=2 * len(specimens),
            presets=9,
        )
        passed("canonical ordering and omitted nullable value preserved")

    try:
        local.sql("postgres", f"CREATE DATABASE {database} TEMPLATE postgres;")
        owned = True
        local.run(
            [
                psql,
                *local.connection,
                f"--dbname={database}",
                "--no-psqlrc",
                "--set=ON_ERROR_STOP=1",
                "--quiet",
                "--single-transaction",
                f"--file={MIGRATION}",
            ]
        )
        require(
            sql("SELECT count(*) FROM supabase_migrations.schema_migrations;") == "151",
            "Pilot registered migration history",
        )
        passed(
            "transactional draft migration from exact V56 without history registration"
        )
        graph_parity()
        contract_result = local.run(
            [
                psql,
                *local.connection,
                f"--dbname={database}",
                "--no-psqlrc",
                "--set=ON_ERROR_STOP=1",
                "--quiet",
                "--tuples-only",
                "--no-align",
                f"--file={CONTRACT}",
            ]
        )
        contract_count = int(contract_result.splitlines()[-1])
        require(contract_count >= 60, "Focused SQL contract omitted expected checks")
        require(
            sql("SELECT count(*) FROM public.automation_workflows;") == "0",
            "Focused SQL contract did not roll back",
        )
        passed("rollback SQL management contract", checks=contract_count)

        ids = fixture()
        provision(ids)
        first = session("save_owner", save(ids), hold=True)
        ready(first)
        second = session("save_stale", save(ids))
        blocked(first, second)
        release(first)
        finished(second, "AUTOMATION_REVISION_CONFLICT")
        require(
            sql(
                f"SELECT revision FROM public.automation_workflows WHERE id='{ids['workflow']}';"
            )
            == "2",
            "CAS had more than one winner",
        )
        passed("two same-revision saves one winner")

        ids = fixture()
        first = session("create_owner", create(ids), hold=True)
        original = ready(first)
        second = session("create_replay", create(ids))
        blocked(first, second, advisory=True)
        release(first)
        replay = finished(second)
        require(
            replay == {**original, "replayed": True},
            "Competing create did not replay original result",
        )
        require(
            sql(
                f"SELECT count(*) FROM public.automation_workflows WHERE studio_id='{ids['studio']}';"
            )
            == "1",
            "Competing operation created extra workflow",
        )
        passed("same operation competing create returns original single workflow")

        ids = fixture()
        first = session("payload_owner", create(ids), hold=True)
        ready(first)
        second = session("payload_conflict", create(ids, name="Changed"))
        blocked(first, second, advisory=True)
        release(first)
        finished(second, "AUTOMATION_OPERATION_CONFLICT")
        passed("same key different payload conflicts after lock")
        finished(
            session("actor_conflict", create(ids, actor=ids["other_actor"])),
            "AUTOMATION_OPERATION_CONFLICT",
        )
        passed("same key different current admin conflicts")

        ids = fixture()
        provision(ids)
        sql(command(ids, "publish", 1))
        sql(command(ids, "start", 2))
        event, token = str(uuid4()), str(uuid4())
        sql(f"""INSERT INTO private.automation_workflow_events(id,studio_id,event_type,source_key,subject_kind,subject_id,occurred_at)
VALUES('{event}','{ids["studio"]}','lead.created','synthetic','lead','{event}',clock_timestamp());
INSERT INTO public.automation_workflow_runs(studio_id,workflow_id,version_id,event_id,activation_id,epoch,current_node_id,state,claim_token,lease_expires_at)
SELECT studio_id,workflow_id,version_id,'{event}',id,epoch,'start','claimed','{token}',clock_timestamp()+INTERVAL '1 minute'
FROM public.automation_workflow_activations WHERE workflow_id='{ids["workflow"]}' AND retired_at IS NULL;""")
        first = session(
            "held_workflow",
            f"SELECT jsonb_build_object('held',id) FROM public.automation_workflows WHERE id='{ids['workflow']}' FOR UPDATE;",
            hold=True,
        )
        ready(first)
        second = session("pause_waiting", command(ids, "pause", 3))
        blocked(first, second)
        release(first)
        paused = finished(second)
        require(
            paused["payload"]["pending_run_count"] == 0,
            "Pause returned stale pending count",
        )
        require(
            sql(
                f"SELECT state='cancelled' AND claim_token IS NULL AND lease_expires_at IS NULL AND revision=2 FROM public.automation_workflow_runs WHERE event_id='{event}';"
            )
            == "t",
            "Pause left a usable synthetic claim",
        )
        passed("pause serializes on workflow and invalidates held claim")

        ids = fixture()
        provision(ids)
        first = session(
            "revoke_owner",
            f"UPDATE public.staff_roles SET role='front_desk' WHERE studio_id='{ids['studio']}' AND user_id='{ids['actor']}' RETURNING jsonb_build_object('role',role);",
            hold=True,
        )
        ready(first)
        second = session("revoked_save", save(ids))
        blocked(first, second)
        release(first)
        finished(second, "AUTOMATION_ADMIN_REQUIRED")
        require(
            sql(
                f"SELECT revision FROM public.automation_workflows WHERE id='{ids['workflow']}';"
            )
            == "1",
            "Revoked admin wrote after waiting",
        )
        passed("revocation first denies waiting command")

        ids = fixture()
        provision(ids)
        first = session("staff_lock_owner", save(ids), hold=True)
        ready(first)
        second = session(
            "revoke_waiting",
            f"UPDATE public.staff_roles SET role='front_desk' WHERE studio_id='{ids['studio']}' AND user_id='{ids['actor']}' RETURNING jsonb_build_object('role',role);",
        )
        blocked(first, second)
        release(first)
        require(
            finished(second)["role"] == "front_desk",
            "Revocation did not complete after command",
        )
        passed("command staff lock makes revocation wait then succeed")

        ids = fixture()
        first = session("rollback_owner", create(ids), hold=True)
        rolled_back = ready(first)
        second = session("rollback_retry", create(ids))
        blocked(first, second, advisory=True)
        release(first, rollback=True)
        retry = finished(second)
        require(
            retry["replayed"] is False
            and retry["payload"]["id"] != rolled_back["payload"]["id"],
            "Rollback left a ghost receipt",
        )
        require(
            sql(
                f"SELECT count(*) FROM private.automation_command_operations WHERE studio_id='{ids['studio']}';"
            )
            == "1",
            "Rollback left extra operation receipts",
        )
        passed("rolled-back operation permits later retry without ghost receipt")

        ids = fixture()
        program = str(uuid4())
        sql(
            f"INSERT INTO public.programs(id,studio_id,name) VALUES('{program}','{ids['studio']}','Clock fixture');"
        )
        graph = deepcopy(simple)
        graph["nodes"][0]["config"]["program_id"] = program
        ids["workflow"] = json.loads(sql(create(ids, graph=graph)))["payload"]["id"]
        first = session(
            "program_parent_owner",
            f"SELECT jsonb_build_object('held',id) FROM public.programs WHERE id='{program}' FOR UPDATE;",
            hold=True,
        )
        ready(first)
        second = session("publish_program_wait", command(ids, "publish", 1))
        blocked(first, second)
        observed_after_wait = sql("SELECT clock_timestamp();")
        release(first)
        finished(second)
        require(
            sql(
                f"SELECT published_at >= {quote(observed_after_wait)}::timestamptz FROM public.automation_workflows WHERE id='{ids['workflow']}';"
            )
            == "t",
            "Publication timestamp preceded referenced-parent wait",
        )
        passed("publication clock sampled after referenced program lock")

        ids = fixture()
        first = session("admission_owner", create(ids), hold=True)
        ready(first)
        second = session("admission_conflict", create(ids, operation=str(uuid4())))
        finished(second, "AUTOMATION_STUDIO_BUSY")
        release(first)
        passed("different operation admission lock fails promptly")
        require(
            {
                p.name: hashlib.sha256(p.read_bytes()).hexdigest()
                for p in MIGRATION.parent.glob("*.sql")
                if p != MIGRATION
            }
            == historical,
            "Historical migration bytes changed",
        )
        passed("all 151 historical migration hashes unchanged")
    finally:
        for item in children:
            process = item["process"]
            if process.poll() is None:
                process.kill()
                process.wait(timeout=5)
            for thread in item["threads"]:
                thread.join(timeout=2)
        if owned:
            local.sql("postgres", f"DROP DATABASE {database} WITH (FORCE);")
            require(
                local.sql(
                    "postgres",
                    f"SELECT count(*) FROM pg_database WHERE datname='{database}';",
                )
                == "0",
                "Owned clone cleanup failed",
            )
            print(f"[workflow management] cleaned {database}", flush=True)
    print(
        json.dumps(
            {
                "outcome": "passed",
                "cases": cases,
                "clone_cleaned": owned,
                "partial_v57": True,
                "migration_history_count": 151,
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main(sys.argv[1:])
