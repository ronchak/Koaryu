#!/usr/bin/env python3
"""One guarded PG17 clone, real fact SQL and installed SDK synthetic HTTP bridge.

No live PostgREST server, providers, credentials, environment files or mail.
Preview snapshot evidence does not establish runtime admission or traversal parity.
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
from importlib.metadata import version
from pathlib import Path
from uuid import UUID, uuid4

from local_postgres_verification import LocalPostgres, require

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = (
    ROOT / "supabase/migrations/20261005105341_automation_workflow_graph_v57.sql"
)
CONTRACT = ROOT / "supabase/verification/workflow_current_facts_contract.sql"


def quote(value):
    if value is None:
        return "NULL"
    if isinstance(value, (dict, list)):
        value = json.dumps(value, separators=(",", ":"))
    return "'" + str(value).replace("'", "''") + "'"


def include(path):
    value = str(path.resolve())
    require(not any(c in value for c in "\r\n\x00"), "Unsafe include path")
    return "\\i '" + value.replace("\\", "\\\\").replace("'", "''") + "'"


def main(arguments):
    require(len(arguments) == 4, "Expected psql socket port unique-owned-clone-name")
    psql, socket, port, database = arguments
    require(
        re.fullmatch(r"koaryu_current_facts_[a-z0-9_]+", database),
        "Unexpected clone name",
    )
    local = LocalPostgres(psql, socket, port, str(Path(socket).parent))
    historical = {
        p.name: hashlib.sha256(p.read_bytes()).hexdigest()
        for p in MIGRATION.parent.glob("*.sql")
        if p != MIGRATION
    }
    require(len(historical) == 151, "Expected151 historical migrations")
    frozen = MIGRATION.read_bytes()
    source_hash = hashlib.sha256(frozen).hexdigest()
    pid = (Path(socket).parent / "data/postmaster.pid").read_text().splitlines()[0]
    children, cases = [], []
    owned = False
    base_before = local.sql(
        "postgres",
        "SELECT row_to_json(p) FROM public.koaryu_release_schema_preflight_v37() p;",
    )

    def sql(statement):
        return local.sql(database, "SET TIME ZONE 'UTC';\n" + statement)

    def value(statement):
        return json.loads(sql(statement))

    def passed(name, **evidence):
        cases.append({"case": name, "outcome": "passed", **evidence})
        print("[current facts] PASS " + name, flush=True)

    def fixture():
        return value("SELECT facts_proof.fact_fixture();")

    def graph(kind, policy=None):
        return value(f"SELECT facts_proof.fact_graph({quote(kind)},{quote(policy)});")

    def query(x, kind):
        return f"SELECT facts_proof.fact_private({quote(x)},{quote(kind)});"

    def snapshot():
        return sql("SELECT md5(facts_proof.fact_snapshot()::TEXT);")

    def session(label, statement, hold=False, role="service_role"):
        name = f"current_facts_{os.getpid()}_{label}_{len(children)}"[:63]
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
            f"SET application_name={quote(name)};\nSET TIME ZONE 'UTC';\nBEGIN;\nSET LOCAL statement_timeout='20s';\nSET LOCAL ROLE {role};\n{statement}\n"
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
        raise RuntimeError("Session did not reach barrier")

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
            require(reader["process"].poll() is None, "Reader exited before barrier")
            observed = sql(
                f"SELECT EXISTS(SELECT 1 FROM pg_stat_activity h JOIN pg_stat_activity r ON h.pid=ANY(pg_blocking_pids(r.pid)) WHERE h.application_name={quote(holder['name'])} AND r.application_name={quote(reader['name'])});"
            )
            if observed == "t":
                return
            time.sleep(0.025)
        raise RuntimeError("No observed blocking relationship")

    def definition(signature):
        return sql(f"SELECT pg_get_functiondef({quote(signature)}::REGPROCEDURE);")

    def replace_body(original, body):
        start = original.index("AS $function$")
        return original[:start] + "AS $function$\n" + body + "\n$function$;"

    try:
        require(
            local.sql(
                "postgres",
                f"SELECT NOT EXISTS(SELECT 1 FROM pg_database WHERE datname={quote(database)});",
            )
            == "t",
            "Owned clone already exists",
        )
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
        print("[current facts] creating owned clone " + database, flush=True)
        local.sql("postgres", f"CREATE DATABASE {database} TEMPLATE postgres;")
        owned = True
        sql("BEGIN;\n" + include(MIGRATION) + "\nCOMMIT;")
        require(
            sql("SELECT count(*) FROM supabase_migrations.schema_migrations;") == "151",
            "Partial V57 registered history",
        )
        passed("transactional V57 install preserves151 history", sha256=source_hash)
        assertions = sql(CONTRACT.read_text())
        passed("complete rollback fact contract", assertions=assertions)
        # These retained contracts exercise dependencies; their bytes remain fixed.
        for name in (
            "workflow_management",
            "workflow_rank_context",
            "workflow_financial_authority",
            "belt_test_recipient",
            "workflow_run",
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
            .replace("SET LOCAL statement_timeout='60s';", "")
            .replace("SET LOCAL TIME ZONE 'UTC';", "")
        )
        setup = (
            setup.replace(
                "CREATE TEMP TABLE current_fact_checks",
                "CREATE TABLE facts_proof.current_fact_checks",
            )
            .replace("pg_temp.", "facts_proof.")
            .replace("SCHEMA pg_temp", "SCHEMA facts_proof")
        )
        sql(
            "CREATE SCHEMA facts_proof;GRANT USAGE ON SCHEMA facts_proof TO service_role;\n"
            + setup
        )
        sql("""CREATE FUNCTION facts_proof.rpc(statement TEXT) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE payload JSONB; code TEXT; message TEXT;
BEGIN
    EXECUTE statement INTO payload;
    RETURN jsonb_build_object('ok',true,'data',payload);
EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS code=RETURNED_SQLSTATE,message=MESSAGE_TEXT;
    RETURN jsonb_build_object('ok',false,'code',code,'message',message);
END $$;
GRANT EXECUTE ON FUNCTION facts_proof.rpc(TEXT) TO service_role;""")
        os.environ["ENVIRONMENT"] = "test"
        os.environ["SUPABASE_URL"] = "https://placeholder.supabase.co"
        os.environ["SUPABASE_DEVELOPMENT_PROJECT_REF"] = ""
        sys.path.insert(0, str(ROOT / "backend"))
        from app.core.config import AMBIENT_TRANSPORT_ENVIRONMENT_KEYS, Settings

        Settings.model_config["env_file"] = None
        for key in AMBIENT_TRANSPORT_ENVIRONMENT_KEYS:
            os.environ.pop(key, None)
        import httpx
        from app.schemas.workflow_simulation import WorkflowSimulationRequest
        from app.services.belt_test_recipient_service import BeltTestRecipientService
        from app.services.workflow_catalog import CATALOG
        from app.services.workflow_simulation_service import WorkflowSimulationService
        from fastapi import HTTPException
        from tests.test_workflow_management import SyntheticPostgrestClient

        require(version("postgrest") == "0.17.2", "Expected pinned PostgREST0.17.2")
        allowlist = {
            "get_automation_workflow_simulation_facts_v1": {
                "p_studio_id",
                "p_actor_id",
                "p_workflow_id",
                "p_graph",
                "p_context",
            },
            "get_belt_test_recipient_v1": {
                "p_studio_id",
                "p_actor_id",
                "p_event_id",
                "p_recipient_id",
            },
        }
        requests = []
        corruption = None

        def bridge(request):
            name = request.url.path.rsplit("/", 1)[-1]
            params = json.loads(request.content)
            require(
                request.method == "POST"
                and name in allowlist
                and set(params) == allowlist[name],
                "Unexpected RPC bridge request",
            )
            requests.append(name)
            arguments = ",".join(
                key + "=>" + quote(data) for key, data in params.items()
            )
            reply = value(
                "SET ROLE service_role;SELECT facts_proof.rpc("
                + quote(f"SELECT public.{name}({arguments})")
                + ");"
            )
            if reply["ok"]:
                if corruption is not None:
                    corruption(reply["data"])
                return httpx.Response(200, json=reply["data"])
            return httpx.Response(
                400,
                json={
                    "code": reply["code"],
                    "message": reply["message"],
                    "details": None,
                    "hint": None,
                },
            )

        def invoke(client, x, kind, supplied_graph=None, supplied_context=None):
            data = WorkflowSimulationRequest.model_validate(
                {
                    "graph": supplied_graph or graph(kind),
                    "context": supplied_context
                    or {
                        "kind": "entity",
                        "entity_type": CATALOG["triggers"][kind][
                            "simulation_entity_type"
                        ],
                        "entity_id": x[
                            CATALOG["triggers"][kind]["simulation_entity_type"]
                        ],
                    },
                }
            )
            return WorkflowSimulationService(client).simulate(
                x["studio"], x["actor"], UUID(x["workflow"]), data
            )

        def http_error(call, expected):
            try:
                call()
            except HTTPException as exc:
                require(
                    exc.status_code == expected,
                    f"Unexpected HTTP status {exc.status_code}",
                )
                return
            raise RuntimeError(f"Expected HTTP{expected}")

        with SyntheticPostgrestClient(bridge) as client:
            x = fixture()
            for kind, metadata in CATALOG["triggers"].items():
                outcome = (
                    kind.split(".")[1]
                    if kind in ("trial.completed", "trial.no_show")
                    else "scheduled"
                )
                sql(
                    f"UPDATE public.lead_trial_appointments SET status={quote(outcome)} WHERE id={quote(x['trial_appointment'])};"
                )
                g = graph(kind)
                g["nodes"][1]["config"]["body_template"] = "\n".join(
                    "{{" + var + "}}" for var in metadata["template_variables"]
                )
                before = snapshot()
                result = invoke(client, x, kind, g)
                require(
                    result.valid
                    and any(row.outcome == "would_send" for row in result.trace),
                    "SDK did not consume eligible " + kind,
                )
                require(snapshot() == before, "SDK positive wrote " + kind)
                sample = invoke(client, x, kind, g, {"kind": "synthetic"})
                require(
                    sample.valid
                    and any(row.outcome == "would_send" for row in sample.trace),
                    "Synthetic factory did not consume " + kind,
                )
                entity = dict(x)
                entity[metadata["simulation_entity_type"]] = str(uuid4())
                http_error(
                    lambda entity=entity, kind=kind: invoke(client, entity, kind), 404
                )
                passed("real SQL and installed SDK " + kind)
            for policy in ("lead_or_guardian", "assigned_staff"):
                result = invoke(
                    client, x, "lead.created", graph("lead.created", policy)
                )
                text = next(
                    row.rendered_subject
                    for row in result.trace
                    if row.outcome == "would_send"
                )
                require(
                    (
                        "Assigned Teacher"
                        if policy == "assigned_staff"
                        else "Lead Person"
                    )
                    in text,
                    "Recipient-specific name lost",
                )
            passed("per-role names survive SDK and renderer")
            for key in ("studio_id", "workflow_id", "context"):

                def corrupt(data, key=key):
                    data["payload"][key] = (
                        {"kind": "synthetic"} if key == "context" else str(uuid4())
                    )

                corruption = corrupt
                http_error(lambda: invoke(client, x, "lead.created"), 503)
            corruption = None
            passed("actual SDK rejects scope and context echo corruption")
            belt = BeltTestRecipientService(client)
            first = belt.get_recipient(
                x["studio"], x["actor"], x["event"], x["belt_test_recipient"]
            )
            require(first.revision == 1, "Belt DTO first revision")
            sql(
                f"SELECT public.revoke_belt_test_recipient_v1({quote(x['studio'])},{quote(x['actor'])},{quote(x['event'])},{quote(x['belt_test_recipient'])},gen_random_uuid(),1);"
            )
            revoked = belt.get_recipient(
                x["studio"], x["actor"], x["event"], x["belt_test_recipient"]
            )
            require(
                revoked.state == "revoked" and revoked.revision == 2,
                "Current belt DTO lost revoke",
            )
            passed("actual current belt SQL to accepted service DTO")
            # Renderer receives known invalid values, while unavailable facts wait.
            sql(
                f"UPDATE public.leads SET first_name={quote('x' * 6000)} WHERE id={quote(x['lead'])};"
            )
            g = graph("lead.created")
            g["nodes"][1]["config"]["subject_template"] = "{{lead_first_name}}"
            result = invoke(client, x, "lead.created", g)
            require(
                any(row.reason == "invalid_email_context" for row in result.trace),
                "Oversize source became renderable",
            )
            sql(
                f"UPDATE public.leads SET first_name='Lead' WHERE id={quote(x['lead'])};"
            )
            sql(
                f"UPDATE public.billing_invoices SET currency='ZZZ' WHERE id={quote(x['invoice'])};UPDATE public.billing_payments SET currency='ZZZ' WHERE id={quote(x['payment'])};"
            )
            g = graph("invoice.overdue")
            g["nodes"][1]["config"]["body_template"] = "{{invoice_balance}}"
            result = invoke(client, x, "invoice.overdue", g)
            require(
                any(row.reason == "unsupported_currency" for row in result.trace),
                "Unsupported currency lost formatter outcome",
            )
            passed("known oversized and unsupported currency render failures")
            x = fixture()
            g = graph("lead.created")
            g["nodes"].insert(
                1,
                {
                    "id": "condition",
                    "type": "condition",
                    "config": {
                        "field": "lead.source",
                        "operator": "eq",
                        "value": "referral",
                    },
                },
            )
            g["edges"] = [
                {
                    "id": "first",
                    "source": "trigger",
                    "target": "condition",
                    "port": "next",
                },
                {"id": "yes", "source": "condition", "target": "mail", "port": "yes"},
                {"id": "no", "source": "condition", "target": "end", "port": "no"},
                {"id": "done", "source": "mail", "target": "end", "port": "next"},
            ]
            sql(f"UPDATE public.leads SET source=NULL WHERE id={quote(x['lead'])};")
            result = invoke(client, x, "lead.created", g)
            require(
                result.trace[-1].outcome == "waiting" and not result.next_actions,
                "Unavailable condition selected a branch",
            )
            g["nodes"][1]["config"] = {
                "field": "program.id",
                "operator": "eq",
                "value": None,
            }
            sql(f"UPDATE public.leads SET program_id=NULL WHERE id={quote(x['lead'])};")
            result = invoke(client, x, "lead.created", g)
            require(
                any(row.outcome == "matched" for row in result.trace),
                "Known nullable fact became missing",
            )
            passed("actual SDK selected missing versus known-null condition")

        # Invalid graph validation must finish before the fact owner is entered.
        source_signature = "private.workflow_current_source_facts_v1(uuid,text,uuid,jsonb,jsonb,timestamptz,text[])"
        original_source = definition(source_signature)
        try:
            sql(
                replace_body(
                    original_source,
                    "BEGIN RAISE EXCEPTION 'ENTITY_READER_WAS_CALLED'; END",
                )
            )
            x = fixture()
            invalid = graph("lead.created")
            invalid["edges"] = []
            result = value(
                f"SELECT facts_proof.fact_read({quote(x)},'lead.created',{quote(invalid)});"
            )
            require(
                not result["payload"]["valid"] and result["payload"]["facts"] is None,
                "Invalid graph entered source owner",
            )
            invalid = graph("lead.created")
            invalid["nodes"][0]["config"]["program_id"] = str(uuid4())
            result = value(
                f"SELECT facts_proof.fact_read({quote(x)},'lead.created',{quote(invalid)});"
            )
            require(
                not result["payload"]["valid"], "Foreign reference entered source owner"
            )
            passed("invalid graph and reference before instrumented entity read")
        finally:
            sql(original_source)
            require(
                definition(source_signature) == original_source,
                "Source definition not restored",
            )
        # Stable text serialization is a pure seam in production. This clone-only
        # advisory barrier preserves its volatility and holds no source row lock.
        text_signature = "private.workflow_fact_text_v1(text)"
        original_text = definition(text_signature)
        try:
            instrumented = original_text.replace("LANGUAGE sql", "LANGUAGE plpgsql")
            body = "BEGIN\nIF current_setting('koaryu.fact_barrier',true)='on' THEN PERFORM pg_catalog.pg_advisory_xact_lock(5707201); END IF;\nRETURN jsonb_build_object('kind','text','value',left(p_value,5001));\nEND"
            sql(replace_body(instrumented, body))
            for scenario in ("rank_authority", "lead_and_staff", "payer_contact"):
                for rollback in (False, True):
                    x = fixture()
                    kind = {
                        "rank_authority": "student.promoted",
                        "lead_and_staff": "lead.created",
                        "payer_contact": "invoice.overdue",
                    }[scenario]
                    before = value(query(x, kind))
                    holder = session(
                        "gate", "SELECT pg_advisory_xact_lock(5707201);", hold=True
                    )
                    ready(holder)
                    reader = session(
                        "reader",
                        "SET LOCAL koaryu.fact_barrier='on';\n" + query(x, kind),
                    )
                    blocked(holder, reader)
                    if scenario == "rank_authority":
                        mutation = f"UPDATE public.student_program_memberships SET current_belt_rank_id={quote(x['rank0'])} WHERE id={quote(x['membership'])};SET CONSTRAINTS private.workflow_rank_deferred IMMEDIATE;"
                    elif scenario == "lead_and_staff":
                        mutation = f"UPDATE public.leads SET first_name='After',email='after.lead@example.invalid' WHERE id={quote(x['lead'])};UPDATE public.staff_profiles SET legal_first_name='After' WHERE user_id={quote(x['staff'])};UPDATE auth.users SET email='after.staff@example.invalid' WHERE id={quote(x['staff'])};"
                    else:
                        mutation = f"UPDATE public.billing_payers SET display_name='After payer',email='after.payer@example.invalid' WHERE id={quote(x['payer'])};UPDATE public.billing_invoices SET amount_remaining_cents=1000 WHERE id={quote(x['invoice'])};"
                    writer = session("writer", mutation, hold=True, role="postgres")
                    ready(writer)
                    release(writer, rollback)
                    release(holder)
                    observed = finished(reader)
                    require(
                        observed == before,
                        "Stable fact read mixed versions in " + scenario,
                    )
                    after = value(query(x, kind))
                    require(
                        (after == before) == rollback,
                        "Post-transaction fact state disagrees " + scenario,
                    )
                    passed(f"mid-read {scenario} rollback={rollback}")
        finally:
            sql(original_text)
            require(
                definition(text_signature) == original_text,
                "Text serializer not restored",
            )
        # A second read after instrumentation is removed must see current versions.
        x = fixture()
        old = value(query(x, "lead.created"))
        sql(
            f"UPDATE public.leads SET first_name='Uninstrumented' WHERE id={quote(x['lead'])};"
        )
        new = value(query(x, "lead.created"))
        require(
            old != new
            and new["facts"]["template_facts"]["lead_first_name"]["value"]
            == "Uninstrumented",
            "Restored serializer did not read current source",
        )
        passed("uninstrumented stable read observes next committed statement")

        belt_signature = (
            "private.belt_test_recipient_payload_v1(public.belt_test_recipients)"
        )
        original_belt = definition(belt_signature)
        try:
            instrumented = original_belt.replace("LANGUAGE sql", "LANGUAGE plpgsql")
            raw_body = (
                original_belt.split("AS $function$", 1)[1]
                .rsplit("$function$", 1)[0]
                .strip()
            )
            require(raw_body.startswith("SELECT "), "Unexpected belt serializer")
            body = (
                "BEGIN\nIF current_setting('koaryu.fact_barrier',true)='on' THEN PERFORM pg_catalog.pg_advisory_xact_lock(5707202); END IF;\nRETURN "
                + raw_body.removeprefix("SELECT ").rstrip(";\n")
                + ";\nEND"
            )
            sql(replace_body(instrumented, body))
            for rollback in (False, True):
                x = fixture()
                read = f"SELECT public.get_belt_test_recipient_v1({quote(x['studio'])},{quote(x['actor'])},{quote(x['event'])},{quote(x['belt_test_recipient'])});"
                before = value(read)
                holder = session(
                    "belt_gate", "SELECT pg_advisory_xact_lock(5707202);", hold=True
                )
                ready(holder)
                reader = session(
                    "belt_reader", "SET LOCAL koaryu.fact_barrier='on';\n" + read
                )
                blocked(holder, reader)
                writer = session(
                    "belt_writer",
                    f"SELECT public.revoke_belt_test_recipient_v1({quote(x['studio'])},{quote(x['actor'])},{quote(x['event'])},{quote(x['belt_test_recipient'])},gen_random_uuid(),1);",
                    hold=True,
                )
                ready(writer)
                release(writer, rollback)
                release(holder)
                require(
                    finished(reader) == before,
                    "Exact belt read mixed recipient versions",
                )
                after = value(read)
                require(
                    (after == before) == rollback,
                    "Current belt read missed committed revoke",
                )
                passed(f"exact belt row snapshot rollback={rollback}")
        finally:
            sql(original_belt)
            require(
                definition(belt_signature) == original_belt,
                "Belt serializer not restored",
            )

        # Forbidden readers would mutate authority. Poison their bodies, read all
        # normal source kinds, and restore exact definitions regardless of outcome.
        forbidden = [
            "private.workflow_rank_context_generation_v1(uuid,uuid,uuid)",
            "private.workflow_rank_compare_pending_v1(uuid,uuid)",
            "private.workflow_prepare_financial_context_v1(uuid,uuid,uuid)",
            "private.workflow_observe_payment_settlement_v1(uuid,uuid)",
        ]
        originals = {signature: definition(signature) for signature in forbidden}
        x = fixture()
        before = snapshot()
        try:
            for original in originals.values():
                sql(
                    replace_body(
                        original, "BEGIN RAISE EXCEPTION 'FORBIDDEN_FACT_REPAIR'; END"
                    )
                )
            for kind in CATALOG["triggers"]:
                value(query(x, kind))
            require(
                snapshot() == before, "Reads with poisoned repair owners wrote data"
            )
            passed("all triggers avoid rank and financial mutation owners")
        finally:
            for signature, original in originals.items():
                sql(original)
                require(
                    definition(signature) == original,
                    "Forbidden owner not restored " + signature,
                )

        # The public projection itself must hold the source/recipient snapshot.
        x = fixture()
        before = value(f"SELECT facts_proof.fact_read({quote(x)},'lead.created');")[
            "payload"
        ]["facts"]
        original_text = definition(text_signature)
        try:
            instrumented = original_text.replace("LANGUAGE sql", "LANGUAGE plpgsql")
            sql(
                replace_body(
                    instrumented,
                    "BEGIN IF current_setting('koaryu.fact_barrier',true)='on' THEN PERFORM pg_advisory_xact_lock(5707203); END IF; RETURN jsonb_build_object('kind','text','value',left(p_value,5001)); END",
                )
            )
            holder = session(
                "public_gate", "SELECT pg_advisory_xact_lock(5707203);", hold=True
            )
            ready(holder)
            reader = session(
                "public_reader",
                "SET LOCAL koaryu.fact_barrier='on';"
                + f"SELECT facts_proof.fact_read({quote(x)},'lead.created');",
            )
            blocked(holder, reader)
            sql(
                f"UPDATE public.leads SET first_name='New public',email='new.public@example.invalid' WHERE id={quote(x['lead'])};"
            )
            release(holder)
            result = finished(reader)
            require(
                result["payload"]["facts"] == before, "Public wrapper mixed snapshots"
            )
            passed("actual public projection source and recipient snapshot")
        finally:
            sql(original_text)
            require(
                definition(text_signature) == original_text,
                "Public barrier not restored",
            )

        passed(
            "uninstrumented full contract after exact definition restoration",
            assertions=sql(CONTRACT.read_text()),
        )

        inventory = value("""SELECT jsonb_agg(jsonb_build_object('identity',p.oid::REGPROCEDURE::TEXT,'definition',pg_get_functiondef(p.oid),
            'owner',pg_get_userbyid(p.proowner),'volatility',p.provolatile,'security_definer',p.prosecdef,'settings',p.proconfig,'acl',p.proacl::TEXT) ORDER BY p.oid::REGPROCEDURE::TEXT)
            FROM pg_proc p WHERE p.proname IN ('workflow_fact_text_v1','workflow_staff_auth_email_v1','workflow_current_staff_recipient_v1',
            'workflow_current_rank_authority_v1','workflow_current_source_facts_v1','workflow_graph_read_issues_v1','workflow_simulation_projection_v1',
            'get_automation_workflow_simulation_facts_v1','get_belt_test_recipient_v1');""")
        require(len(inventory) == 9, "Unexpected new definition inventory")
        require(MIGRATION.read_bytes() == frozen, "Migration changed during proof")
        print(
            json.dumps(
                {
                    "cases": cases,
                    "source_sha256": source_hash,
                    "contract_sha256": hashlib.sha256(
                        CONTRACT.read_bytes()
                    ).hexdigest(),
                    "runner_sha256": hashlib.sha256(
                        Path(__file__).read_bytes()
                    ).hexdigest(),
                    "definitions": inventory,
                    "installed_sdk": version("postgrest"),
                    "bridge": "synthetic HTTP transport to actual guarded local SQL; not live PostgREST",
                    "limits": "No runtime admission/traversal parity, router mount, V57 readiness, hosted services or mail",
                }
            ),
            flush=True,
        )
    finally:
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
        if owned:
            print("[current facts] dropping owned clone " + database, flush=True)
            local.sql("postgres", f"DROP DATABASE {database} WITH (FORCE);")
        require(
            local.sql(
                "postgres",
                f"SELECT NOT EXISTS(SELECT 1 FROM pg_database WHERE datname={quote(database)});",
            )
            == "t",
            "Owned clone cleanup failed",
        )
        require(
            historical
            == {
                p.name: hashlib.sha256(p.read_bytes()).hexdigest()
                for p in MIGRATION.parent.glob("*.sql")
                if p != MIGRATION
            },
            "Historical migrations changed",
        )
        require(
            (Path(socket).parent / "data/postmaster.pid").read_text().splitlines()[0]
            == pid,
            "PM server lifetime changed",
        )
        require(
            local.sql(
                "postgres",
                "SELECT row_to_json(p) FROM public.koaryu_release_schema_preflight_v37() p;",
            )
            == base_before,
            "Base V56 preflight changed",
        )
        print(
            json.dumps(
                {
                    "owned_clone_removed": database if owned else None,
                    "historical_migrations_unchanged": 151,
                    "pm_postmaster_pid_unchanged": pid,
                    "base_preflight_unchanged": True,
                }
            ),
            flush=True,
        )


if __name__ == "__main__":
    main(sys.argv[1:])
