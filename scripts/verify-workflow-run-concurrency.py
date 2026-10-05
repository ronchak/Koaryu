#!/usr/bin/env python3
"""Actual metadata SQL and pinned SDK through synthetic local HTTP transport.

Only a LocalPostgres-guarded disposable clone is writable. This is not a live
PostgREST server and does not exercise traversal or provider admission.
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
CONTRACT = ROOT / "supabase/verification/workflow_run_contract.sql"


def quote(value):
    if value is None:
        return "NULL"
    if isinstance(value, (dict, list)):
        value = json.dumps(value, separators=(",", ":"))
    return "'" + str(value).replace("'", "''") + "'"


def main(arguments):
    require(len(arguments) == 4, "Expected psql socket port unique-owned-clone-name")
    psql, socket, port, database = arguments
    require(
        re.fullmatch(r"koaryu_workflow_run_[a-z0-9_]+", database),
        "Unexpected owned clone name",
    )
    local = LocalPostgres(psql, socket, port, str(Path(socket).parent))
    children, cases = [], []
    owned = False
    historical = {
        p.name: hashlib.sha256(p.read_bytes()).hexdigest()
        for p in MIGRATION.parent.glob("*.sql")
        if p != MIGRATION
    }
    require(len(historical) == 151, "Expected151 immutable migrations")

    def sql(statement):
        return local.sql(database, statement)

    def passed(name, **evidence):
        cases.append({"case": name, "outcome": "passed", **evidence})
        print("[workflow run] PASS " + name, flush=True)

    def fixture(state="queued", kind="lead.created"):
        x = json.loads(sql("SELECT run_proof.run_fixture();"))
        x["workflow"] = sql(f"SELECT run_proof.run_workflow({quote(x)},{quote(kind)});")
        x["run"] = sql(
            f"SELECT run_proof.run_seed({quote(x)},'{x['workflow']}',{quote(state)});"
        )
        return x

    def cancel(x, operation=None, revision=1, actor=None):
        return f"SELECT public.cancel_automation_workflow_run_v1('{x['studio']}','{actor or x['actor']}','{x['run']}','{operation or uuid4()}',{revision});"

    def get(x):
        return json.loads(
            sql(
                f"SELECT public.get_automation_workflow_run_v1('{x['studio']}','{x['actor']}','{x['run']}');"
            )
        )["payload"]

    def pause(x):
        return f"SELECT public.command_automation_workflow_v1('{x['studio']}','{x['actor']}','{x['workflow']}',gen_random_uuid(),3,'pause');"

    def history(x):
        x.update(
            json.loads(sql(f"SELECT run_proof.run_history({quote(x)},'{x['run']}');"))
        )

    def settlement(x):
        return f"""SELECT 1 FROM public.automation_workflows WHERE id='{x["workflow"]}' FOR UPDATE;
SELECT 1 FROM public.automation_workflow_runs WHERE id='{x["run"]}' FOR UPDATE;
UPDATE public.automation_workflow_runs SET revision=revision+1,state='completed',claim_token=NULL,lease_expires_at=NULL,next_due_at=NULL,updated_at=clock_timestamp() WHERE id='{x["run"]}';
UPDATE private.automation_workflow_run_steps SET outcome='accepted',finished_at=clock_timestamp() WHERE id='{x["step"]}';
UPDATE private.automation_workflow_email_attempts SET state='accepted',settled_at=clock_timestamp(),submission_evidence='accepted' WHERE id='{x["attempt"]}';"""

    def session(name, statement, hold=False, role="service_role"):
        name = f"workflow_run_{os.getpid()}_{name}_{len(children)}"[:63]
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
            f"SET application_name='{name}';\nBEGIN;\nSET LOCAL statement_timeout='20s';\nSET LOCAL ROLE {role};\n{statement}\n"
        )
        if hold:
            process.stdin.write("SELECT 'RESULT_READY';\n")
            process.stdin.flush()
        else:
            process.stdin.write("COMMIT;\n")
            process.stdin.close()
        return item

    def result(item):
        return next(
            (
                json.loads(line)
                for line in reversed(item["lines"])
                if line.startswith("{")
            ),
            {},
        )

    def ready(item):
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            try:
                if item["events"].get(timeout=0.05) == "RESULT_READY":
                    return result(item)
            except queue.Empty:
                require(
                    item["process"].poll() is None,
                    "Holder failed: " + "\n".join(item["errors"]),
                )
        raise RuntimeError("Session did not reach barrier")

    def finished(item, expected_error=None):
        code = item["process"].wait(timeout=25)
        for thread in item["threads"]:
            thread.join(timeout=2)
        for stream in (
            item["process"].stdin,
            item["process"].stdout,
            item["process"].stderr,
        ):
            if not stream.closed:
                stream.close()
        errors = "\n".join(item["errors"])
        if expected_error:
            require(
                code != 0 and expected_error in errors,
                f"Expected {expected_error}: {errors}",
            )
            return None
        require(code == 0, "Session failed: " + errors)
        return result(item)

    def release(item, rollback=False):
        item["process"].stdin.write("ROLLBACK;\n" if rollback else "COMMIT;\n")
        item["process"].stdin.close()
        return finished(item)

    def blocked(first, second):
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            require(
                second["process"].poll() is None,
                "Waiter exited: " + "\n".join(second["errors"]),
            )
            found = sql(
                "SELECT count(*) FROM pg_stat_activity a JOIN pg_stat_activity b ON a.datname=b.datname "
                f"WHERE a.application_name='{first['name']}' AND b.application_name='{second['name']}' AND a.pid=ANY(pg_blocking_pids(b.pid)) AND b.wait_event_type='Lock';"
            )
            if found == "1":
                return
            time.sleep(0.025)
        raise RuntimeError("Expected lock wait was not observed")

    try:
        require(
            local.sql(
                "postgres",
                f"SELECT count(*) FROM pg_database WHERE datname={quote(database)};",
            )
            == "0",
            "Owned clone already exists",
        )
        require(
            local.sql(
                "postgres",
                "SELECT count(*) FROM supabase_migrations.schema_migrations;",
            )
            == "151",
            "Base history changed",
        )
        require(
            local.sql(
                "postgres",
                "SELECT to_regclass('public.automation_workflow_runs') IS NULL AND to_regclass('private.workflow_rank_contexts') IS NULL;",
            )
            == "t",
            "Expected unchanged V56 base",
        )
        print("[workflow run] creating owned clone " + database, flush=True)
        local.sql("postgres", f"CREATE DATABASE {database} TEMPLATE postgres;")
        owned = True
        sql("BEGIN;" + MIGRATION.read_text() + "COMMIT;")
        require(
            sql("SELECT count(*) FROM supabase_migrations.schema_migrations;") == "151",
            "Partial V57 registered history",
        )
        passed(
            "transactional V57 apply without readiness closure",
            sha256=hashlib.sha256(MIGRATION.read_bytes()).hexdigest(),
        )
        print(
            "[workflow run] new SQL assertions " + sql(CONTRACT.read_text()), flush=True
        )
        for name in (
            "workflow_management",
            "trial_appointment",
            "belt_test_event",
            "workflow_rank_context",
            "workflow_domain_capture",
            "workflow_student_payment_capture",
            "belt_test_recipient",
        ):
            assertions = sql(
                (ROOT / f"supabase/verification/{name}_contract.sql").read_text()
            )
            passed("retained " + name, assertions=assertions)
        setup = CONTRACT.read_text().split("\nDO $$", 1)[0]
        setup = setup.replace("BEGIN;\n", "", 1).replace(
            "SET LOCAL statement_timeout='60s';", ""
        )
        setup = (
            setup.replace(
                "CREATE TEMP TABLE run_checks", "CREATE TABLE run_proof.run_checks"
            )
            .replace("pg_temp.", "run_proof.")
            .replace("SCHEMA pg_temp", "SCHEMA run_proof")
        )
        sql(
            "CREATE SCHEMA run_proof;GRANT USAGE ON SCHEMA run_proof TO service_role;"
            + setup
        )

        # A typed, allowlisted RPC bridge catches actual database SQLSTATEs. HTTP
        # request building and response validation use installed postgrest0.17.2.
        sql("""CREATE FUNCTION run_proof.rpc(statement TEXT) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE payload JSONB; code TEXT; message TEXT;
BEGIN
    EXECUTE statement INTO payload;
    RETURN jsonb_build_object('ok',true,'data',payload);
EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS code=RETURNED_SQLSTATE,message=MESSAGE_TEXT;
    RETURN jsonb_build_object('ok',false,'code',code,'message',message);
END $$;
GRANT EXECUTE ON FUNCTION run_proof.rpc(TEXT) TO service_role;""")
        os.environ["ENVIRONMENT"] = "test"
        os.environ["SUPABASE_URL"] = "https://placeholder.supabase.co"
        os.environ["SUPABASE_DEVELOPMENT_PROJECT_REF"] = ""
        sys.path.insert(0, str(ROOT / "backend"))
        from app.core.config import AMBIENT_TRANSPORT_ENVIRONMENT_KEYS, Settings

        Settings.model_config["env_file"] = None
        for key in AMBIENT_TRANSPORT_ENVIRONMENT_KEYS:
            os.environ.pop(key, None)
        import httpx
        from app.schemas.workflow_management import AutomationOperationResponse
        from app.schemas.workflow_run import WorkflowRunCancelRequest
        from app.services.trial_appointment_service import TrialAppointmentService
        from app.services.workflow_management_service import WorkflowManagementService
        from app.services.workflow_run_service import WorkflowRunService
        from fastapi import HTTPException
        from pydantic import TypeAdapter
        from tests.test_workflow_management import SyntheticPostgrestClient

        require(
            version("postgrest") == "0.17.2", "Expected accepted pinned PostgREST0.17.2"
        )
        allowlist = {
            "list_automation_workflow_runs_v1": {
                "p_studio_id",
                "p_actor_id",
                "p_workflow_id",
                "p_limit",
                "p_cursor",
            },
            "get_automation_workflow_run_v1": {"p_studio_id", "p_actor_id", "p_run_id"},
            "cancel_automation_workflow_run_v1": {
                "p_studio_id",
                "p_actor_id",
                "p_run_id",
                "p_operation_id",
                "p_expected_revision",
            },
            "get_lead_trial_appointment_v1": {
                "p_studio_id",
                "p_actor_id",
                "p_lead_id",
                "p_appointment_id",
            },
            "get_automation_operation_v1": {
                "p_studio_id",
                "p_actor_id",
                "p_operation_id",
            },
        }
        requests = []

        def bridge(request):
            name = request.url.path.rsplit("/", 1)[-1]
            params = json.loads(request.content)
            require(
                request.method == "POST"
                and name in allowlist
                and set(params) == allowlist[name],
                "Unexpected synthetic RPC request",
            )
            requests.append(name)
            arguments = ",".join(
                key + "=>" + (str(value) if type(value) is int else quote(value))
                for key, value in params.items()
            )
            response = json.loads(
                sql(
                    "SET ROLE service_role;SELECT run_proof.rpc("
                    + quote(f"SELECT public.{name}({arguments})")
                    + ");"
                )
            )
            if response["ok"]:
                return httpx.Response(200, json=response["data"])
            return httpx.Response(
                400,
                json={
                    "code": response["code"],
                    "message": response["message"],
                    "details": None,
                    "hint": None,
                },
            )

        client = SyntheticPostgrestClient(bridge)
        try:
            x = fixture("sending")
            history(x)
            service = WorkflowRunService(client)
            page = service.list(x["studio"], x["actor"], UUID(x["workflow"]), 1)
            detail = service.get(x["studio"], x["actor"], UUID(x["run"]))
            require(
                page.items[0] == detail.run and len(detail.attempts) == 1,
                "SQL/SDK populated metadata diverged",
            )
            operation = uuid4()
            request = WorkflowRunCancelRequest(
                operation_id=operation, expected_revision=1
            )
            first = service.cancel(x["studio"], x["actor"], UUID(x["run"]), request)
            sql(settlement(x))
            repeated = service.cancel(x["studio"], x["actor"], UUID(x["run"]), request)
            require(
                repeated.payload == first.payload
                and repeated.replayed
                and service.get(x["studio"], x["actor"], UUID(x["run"])).run.revision
                == 3,
                "SDK lost original cancellation receipt",
            )
            operation_result = WorkflowManagementService(client).operation(
                x["studio"], x["actor"], operation, "admin"
            )
            require(
                TypeAdapter(AutomationOperationResponse)
                .validate_python(operation_result)
                .result
                == first.payload,
                "Seven-variant operation union failed actual SQL run receipt",
            )
            for actor, run, expected in (
                (x["desk"], x["run"], 403),
                (x["actor"], str(uuid4()), 404),
            ):
                try:
                    service.get(x["studio"], actor, UUID(run))
                except HTTPException as exc:
                    require(
                        exc.status_code == expected, "Actual SQL error mapping failed"
                    )
                else:
                    raise RuntimeError("Expected mapped SQL error")
            trial_request = {
                "starts_at": "2090-01-01T10:00:00Z",
                "ends_at": "2090-01-01T11:00:00Z",
                "timezone": "UTC",
            }
            trial_original = json.loads(
                sql(
                    f"SELECT public.mutate_lead_trial_appointment_v1('{x['studio']}','{x['actor']}','{x['lead']}',NULL,gen_random_uuid(),NULL,{quote(trial_request)});"
                )
            )
            appointment = trial_original["payload"]["id"]
            sql(
                f"SELECT public.mutate_lead_trial_appointment_v1('{x['studio']}','{x['actor']}','{x['lead']}','{appointment}',gen_random_uuid(),1,'{{\"location\":\"Current location\"}}');"
            )
            current_trial = TrialAppointmentService(client).get(
                x["studio"], x["actor"], x["lead"], appointment
            )
            require(
                current_trial.revision == 2
                and current_trial.location == "Current location"
                and trial_original["payload"]["revision"] == 1,
                "Current trial SQL/SDK detail used receipt",
            )
            passed(
                "actual SDK plus actual SQL through synthetic local HTTP",
                postgrest=version("postgrest"),
                requested_rpcs=sorted(set(requests)),
            )
        finally:
            client.session.close()

        for rollback in (False, True):
            for same_key in (False, True):
                x = fixture()
                operation = str(uuid4())
                first = session("cancel_first", cancel(x, operation), hold=True)
                original = ready(first)
                second = session(
                    "cancel_second", cancel(x, operation if same_key else str(uuid4()))
                )
                blocked(first, second)
                release(first, rollback)
                response = finished(
                    second,
                    None if rollback or same_key else "AUTOMATION_REVISION_CONFLICT",
                )
                require(
                    get(x)["run"]["revision"] == 2
                    and get(x)["run"]["cancel_reason"] == "run_cancelled",
                    "Competing cancel duplicated revision",
                )
                if same_key and not rollback:
                    require(
                        response == {**original, "replayed": True},
                        "Concurrent same-key replay changed snapshot",
                    )
                require(
                    sql(
                        f"SELECT count(*) FROM private.automation_command_operations WHERE studio_id='{x['studio']}' AND command='run.cancel';"
                    )
                    == "1",
                    "Duplicate cancellation receipt",
                )
                passed(
                    f"cancel same_key={same_key} rollback={rollback} observed lock wait"
                )

            for cancel_first in (False, True):
                x = fixture("sending")
                history(x)
                first = session(
                    "lifecycle_first",
                    cancel(x) if cancel_first else pause(x),
                    hold=True,
                )
                ready(first)
                second = session(
                    "lifecycle_second", pause(x) if cancel_first else cancel(x)
                )
                blocked(first, second)
                release(first, rollback)
                finished(
                    second,
                    "AUTOMATION_REVISION_CONFLICT"
                    if not cancel_first and not rollback
                    else None,
                )
                expected = (
                    "run_cancelled"
                    if (cancel_first and not rollback)
                    or (not cancel_first and rollback)
                    else "workflow_paused"
                )
                detail = get(x)
                require(
                    detail["run"]["revision"] == 2
                    and detail["run"]["cancel_reason"] == expected
                    and detail["attempts"][0]["state"] == "sending"
                    and detail["steps"][0]["outcome"] == "sending",
                    "Lifecycle replaced first intent or in-flight truth",
                )
                passed(
                    f"cancel versus pause cancel_first={cancel_first} rollback={rollback}"
                )

            # A run/step/attempt/label update is either wholly visible or wholly
            # invisible to each metadata read. The held writer is an actual
            # transaction with row locks; readers need no source locks.
            x = fixture("sending")
            history(x)
            before = get(x)
            writer = session(
                "snapshot_writer",
                f"UPDATE public.leads SET first_name='New snapshot' WHERE id='{x['lead']}';"
                + settlement(x),
                hold=True,
            )
            ready(writer)
            require(get(x) == before, "Detail mixed uncommitted metadata")
            page_before = json.loads(
                sql(
                    f"SELECT public.list_automation_workflow_runs_v1('{x['studio']}','{x['actor']}','{x['workflow']}');"
                )
            )["payload"]["items"][0]
            require(
                page_before == before["run"], "List label mixed transaction snapshots"
            )
            release(writer, rollback)
            after = get(x)
            if rollback:
                require(after == before, "Rollback changed snapshot")
            else:
                require(
                    after["run"]["revision"] == 2
                    and after["run"]["subject_label"] == "New snapshot Lead"
                    and after["steps"][0]["outcome"] == "accepted"
                    and after["attempts"][0]["state"] == "accepted",
                    "Committed metadata snapshot mixed",
                )
            passed(f"coherent detail and list transaction rollback={rollback}")

            for cancel_first in (False, True):
                x = fixture("sending")
                history(x)
                operation = str(uuid4())
                first = session(
                    "settlement_first",
                    cancel(x, operation) if cancel_first else settlement(x),
                    hold=True,
                )
                original = ready(first)
                second = session(
                    "settlement_second",
                    settlement(x) if cancel_first else cancel(x, operation),
                )
                blocked(first, second)
                release(first, rollback)
                finished(
                    second,
                    "AUTOMATION_REVISION_CONFLICT"
                    if not cancel_first and not rollback
                    else None,
                )
                if cancel_first and not rollback:
                    replay = json.loads(sql(cancel(x, operation)))
                    require(
                        replay == {**original, "replayed": True}
                        and get(x)["run"]["cancel_reason"] == "run_cancelled"
                        and get(x)["attempts"][0]["state"] == "accepted",
                        "Settlement rewrote original cancel intent/receipt",
                    )
                passed(
                    f"synthetic truthful settlement cancel_first={cancel_first} rollback={rollback}"
                )

        for mutation in ("archive", "demote", "delete_auth", "entitlement"):
            for rollback in (False, True):
                for command_first in (False, True):
                    for replay in (False, True):
                        x = fixture()
                        operation = str(uuid4())
                        if replay:
                            sql(cancel(x, operation))
                        statement = {
                            "archive": f"UPDATE public.staff_roles SET archived_at=clock_timestamp() WHERE user_id='{x['actor']}';",
                            "demote": f"UPDATE public.staff_roles SET role='front_desk' WHERE user_id='{x['actor']}';",
                            "delete_auth": f"DELETE FROM auth.users WHERE id='{x['actor']}';",
                            "entitlement": f"UPDATE public.studio_subscriptions SET status='canceled' WHERE studio_id='{x['studio']}';",
                        }[mutation]
                        first = session(
                            "authority_first",
                            cancel(x, operation) if command_first else statement,
                            hold=True,
                            role="postgres",
                        )
                        ready(first)
                        second = session(
                            "authority_second",
                            statement if command_first else cancel(x, operation),
                            role="postgres",
                        )
                        blocked(first, second)
                        release(first, rollback)
                        finished(
                            second,
                            "AUTOMATION_ADMIN_REQUIRED"
                            if not command_first and not rollback
                            else None,
                        )
                        count = int(
                            sql(
                                f"SELECT count(*) FROM private.automation_command_operations WHERE studio_id='{x['studio']}' AND command='run.cancel';"
                            )
                        )
                        require(
                            count
                            == (
                                1
                                if replay
                                or (command_first and not rollback)
                                or (not command_first and rollback)
                                else 0
                            ),
                            "Authority race admitted stale command",
                        )
                        passed(
                            f"current {mutation} command_first={command_first} replay={replay} rollback={rollback}"
                        )

        # Deterministic mid-read barrier. Only this clone's serializer is briefly
        # instrumented; the actual detail/list statement remains unchanged. Its
        # original definition is restored and verified even if the test fails.
        signature = "private.workflow_run_summary_payload_v1(public.automation_workflow_runs,private.automation_workflow_events,public.automation_workflow_versions,text)"
        original_definition = sql(
            f"SELECT pg_get_functiondef('{signature}'::REGPROCEDURE);"
        )
        try:
            instrumented = original_definition.replace(
                "LANGUAGE sql", "LANGUAGE plpgsql"
            )
            body_start = instrumented.index("AS $function$")
            original_body = instrumented[
                body_start + len("AS $function$") : instrumented.rindex("$function$")
            ].strip()
            require(
                original_body.startswith("SELECT jsonb_build_object"),
                "Unexpected row serializer for barrier",
            )
            instrumented = (
                instrumented[:body_start]
                + "AS $function$\nBEGIN\nPERFORM pg_catalog.pg_advisory_xact_lock(5707001);\nRETURN "
                + original_body.removeprefix("SELECT ").rstrip(";\n")
                + ";\nEND\n$function$;"
            )
            sql(instrumented)
            for list_read in (False, True):
                for rollback in (False, True):
                    x = fixture("sending")
                    history(x)
                    # Read the baseline before taking the serializer barrier.
                    before = get(x)
                    holder = session(
                        "snapshot_gate",
                        "SELECT pg_advisory_xact_lock(5707001);",
                        hold=True,
                    )
                    ready(holder)
                    query = (
                        f"SELECT public.list_automation_workflow_runs_v1('{x['studio']}','{x['actor']}','{x['workflow']}');"
                        if list_read
                        else f"SELECT public.get_automation_workflow_run_v1('{x['studio']}','{x['actor']}','{x['run']}');"
                    )
                    reader = session("snapshot_reader", query)
                    blocked(holder, reader)
                    writer = session(
                        "mid_read_writer",
                        f"UPDATE public.leads SET first_name='After snapshot' WHERE id='{x['lead']}';"
                        + settlement(x),
                        hold=True,
                    )
                    ready(writer)
                    release(writer, rollback)
                    release(holder)
                    read = finished(reader)["payload"]
                    require(
                        (read["items"][0] if list_read else read)
                        == (before["run"] if list_read else before),
                        "Mid-read commit mixed label/run/history snapshots",
                    )
                    passed(
                        f"observed mid-read snapshot barrier list={list_read} writer_rollback={rollback}"
                    )
        finally:
            sql(original_definition)
            require(
                sql(f"SELECT pg_get_functiondef('{signature}'::REGPROCEDURE);")
                == original_definition,
                "Serializer instrumentation not restored",
            )

        # Real trial replacement and current reads. The begin probe is explicitly
        # source-first protocol proof until the sender owner exists in task08.
        def trial_fixture(state="queued"):
            x = json.loads(sql("SELECT run_proof.run_fixture();"))
            x["workflow"] = sql(
                f"SELECT run_proof.run_workflow({quote(x)},'trial.no_show');"
            )
            request = {
                "starts_at": "2090-01-01T10:00:00Z",
                "ends_at": "2090-01-01T11:00:00Z",
                "timezone": "UTC",
            }
            first = json.loads(
                sql(
                    f"SELECT public.mutate_lead_trial_appointment_v1('{x['studio']}','{x['actor']}','{x['lead']}',NULL,gen_random_uuid(),NULL,{quote(request)});"
                )
            )
            x["trial"] = first["payload"]["id"]
            sql(
                f"UPDATE public.lead_trial_appointments SET starts_at=clock_timestamp()-INTERVAL '2 hours',ends_at=clock_timestamp()-INTERVAL '1 hour' WHERE id='{x['trial']}';SELECT public.mutate_lead_trial_appointment_v1('{x['studio']}','{x['actor']}','{x['lead']}','{x['trial']}',gen_random_uuid(),1,'{{\"status\":\"no_show\"}}');"
            )
            x["run"] = sql(
                f"SELECT id FROM public.automation_workflow_runs WHERE workflow_id='{x['workflow']}';"
            )
            if state != "queued":
                sql(
                    f"UPDATE public.automation_workflow_runs SET state={quote(state)},next_due_at=NULL,claim_token=gen_random_uuid(),lease_expires_at=clock_timestamp()+INTERVAL '1 hour' WHERE id='{x['run']}';"
                )
            x["request"] = request
            return x

        def replace_trial(x, operation=None):
            return f"SELECT public.mutate_lead_trial_appointment_v1('{x['studio']}','{x['actor']}','{x['lead']}',NULL,'{operation or uuid4()}',NULL,{quote(x['request'])});"

        def begin_trial(x):
            return f"""SELECT 1 FROM public.leads WHERE id='{x["lead"]}' FOR UPDATE;
SELECT 1 FROM public.lead_trial_appointments WHERE id='{x["trial"]}' FOR UPDATE;
SELECT 1 FROM public.automation_workflows WHERE id='{x["workflow"]}' FOR UPDATE;
SELECT 1 FROM public.automation_workflow_runs WHERE id='{x["run"]}' FOR UPDATE;
UPDATE public.automation_workflow_runs SET state='sending',next_due_at=NULL,claim_token=gen_random_uuid(),lease_expires_at=clock_timestamp()+INTERVAL '1 hour'
WHERE id='{x["run"]}' AND cancel_requested_at IS NULL AND EXISTS(SELECT 1 FROM public.lead_trial_appointments WHERE id='{x["trial"]}' AND status='no_show' AND NOT rebooking_superseded);"""

        for rollback in (False, True):
            for replacement_first in (False, True):
                for probe in ("run_lock", "begin_protocol"):
                    x = trial_fixture()
                    competing = (
                        begin_trial(x)
                        if probe == "begin_protocol"
                        else f"SELECT 1 FROM public.automation_workflow_runs WHERE id='{x['run']}' FOR UPDATE;"
                    )
                    first = session(
                        "trial_first",
                        replace_trial(x) if replacement_first else competing,
                        hold=True,
                    )
                    ready(first)
                    second = session(
                        "trial_second",
                        competing if replacement_first else replace_trial(x),
                    )
                    blocked(first, second)
                    release(first, rollback)
                    finished(second)
                    marker = sql(
                        f"SELECT rebooking_superseded FROM public.lead_trial_appointments WHERE id='{x['trial']}';"
                    )
                    expected = not replacement_first or not rollback
                    require(
                        (marker == "t") == expected,
                        "Replacement marker disagrees with committed command",
                    )
                    row = get(x)["run"]
                    require(
                        (row["cancel_reason"] == "trial_replaced") == expected,
                        "Trial replacement intent missing or rolled back incorrectly",
                    )
                    if probe == "begin_protocol" and expected:
                        require(
                            row["state"]
                            == (
                                "sending"
                                if not replacement_first and not rollback
                                else "cancelled"
                            ),
                            "Begin protocol invented/revived sending",
                        )
                    passed(
                        f"trial replacement {probe} first={replacement_first} rollback={rollback}"
                    )

            x = trial_fixture("unknown")
            operation = str(uuid4())
            first = session("rebooking_first", replace_trial(x, operation), hold=True)
            original = ready(first)
            second = session("rebooking_replay", replace_trial(x, operation))
            blocked(first, second)
            release(first, rollback)
            repeated = finished(second)
            require(
                get(x)["run"]["revision"] == 2 and get(x)["run"]["state"] == "unknown",
                "Replacement replay duplicated revision or rewrote unknown",
            )
            if not rollback:
                require(
                    repeated == {**original, "replayed": True},
                    "Replacement replay replaced original receipt",
                )
            passed(
                f"new trial same-key replay versus held unknown run rollback={rollback}"
            )

            x = trial_fixture()
            replacement = json.loads(sql(replace_trial(x)))["payload"]
            appointment = replacement["id"]
            query = f"SELECT public.get_lead_trial_appointment_v1('{x['studio']}','{x['actor']}','{x['lead']}','{appointment}');"
            old = sql(query)
            update = f"SELECT public.mutate_lead_trial_appointment_v1('{x['studio']}','{x['actor']}','{x['lead']}','{appointment}',gen_random_uuid(),1,'{{\"location\":\"Changed\"}}');"
            writer = session("current_trial_writer", update, hold=True)
            ready(writer)
            require(
                sql(query) == old, "Current trial read mixed an uncommitted revision"
            )
            release(writer, rollback)
            current = json.loads(sql(query))["payload"]
            require(
                current["revision"] == (1 if rollback else 2)
                and current["location"] == ("" if rollback else "Changed"),
                "Current trial row snapshot mixed",
            )
            passed(f"current trial GET versus actual update rollback={rollback}")

        for state in ("queued", "sending"):
            for rollback in (False, True):
                for cancel_first in (False, True):
                    x = trial_fixture(state)
                    operation = str(uuid4())
                    first = session(
                        "source_cancel_first",
                        cancel(x, operation) if cancel_first else replace_trial(x),
                        hold=True,
                    )
                    original = ready(first)
                    second = session(
                        "source_cancel_second",
                        replace_trial(x) if cancel_first else cancel(x, operation),
                    )
                    blocked(first, second)
                    release(first, rollback)
                    finished(
                        second,
                        "AUTOMATION_REVISION_CONFLICT"
                        if not cancel_first and not rollback
                        else None,
                    )
                    expected = (
                        "run_cancelled"
                        if (cancel_first and not rollback)
                        or (not cancel_first and rollback)
                        else "trial_replaced"
                    )
                    current = get(x)
                    require(
                        current["run"]["revision"] == 2
                        and current["run"]["cancel_reason"] == expected,
                        "Source invalidation overwrote first cancel intent",
                    )
                    if cancel_first and not rollback:
                        require(
                            json.loads(sql(cancel(x, operation)))
                            == {**original, "replayed": True},
                            "Source invalidation rewrote original cancel receipt",
                        )
                    passed(
                        f"cancel versus actual trial replacement state={state} cancel_first={cancel_first} rollback={rollback}"
                    )

        for replay in (False, True):
            x = fixture()
            operation = str(uuid4())
            if replay:
                sql(cancel(x, operation))
            before = get(x)
            holder = session(
                "studio_busy",
                f"SELECT 1 FROM public.studios WHERE id='{x['studio']}' FOR UPDATE;",
                hold=True,
            )
            ready(holder)
            rejected = session("studio_busy_cancel", cancel(x, operation))
            finished(rejected, "AUTOMATION_STUDIO_BUSY")
            release(holder)
            require(get(x) == before, "Studio busy refusal changed run")
            passed(
                f"bounded studio busy refusal before fresh/replay cancel replay={replay}"
            )

        # Real belt command owners on synthetic exact authority. A revoked
        # fixture supplies the changed-recipient branch without bypassing the
        # public reapproval's current source/generation checks.
        rank_contract = (
            ROOT / "supabase/verification/workflow_rank_context_contract.sql"
        ).read_text()
        setup = (
            rank_contract.split("\nDO $$", 1)[0]
            .replace("BEGIN;\n", "", 1)
            .replace("SET LOCAL statement_timeout='60s';", "")
        )
        setup = (
            setup.replace(
                "CREATE TEMP TABLE rank_checks",
                "CREATE TABLE run_rank_proof.rank_checks",
            )
            .replace("pg_temp.", "run_rank_proof.")
            .replace("SCHEMA pg_temp", "SCHEMA run_rank_proof")
        )
        sql(
            "CREATE SCHEMA run_rank_proof;GRANT USAGE ON SCHEMA run_rank_proof TO service_role;"
            + setup
        )
        for state in ("queued", "sending", "unknown"):
            for action in ("event", "reapprove", "revoke"):
                for rollback in (False, True):
                    for source_first in (False, True):
                        x = json.loads(sql("SELECT run_rank_proof.rank_fixture();"))
                        w = sql(
                            f"SELECT run_rank_proof.rank_workflow({quote(x)},'belt_test.approved');"
                        )
                        approval = json.loads(
                            sql(f"SELECT run_rank_proof.rank_approve({quote(x)});")
                        )
                        recipient = approval["payload"]["items"][0]["id"]
                        run = sql(
                            f"SELECT id FROM public.automation_workflow_runs WHERE workflow_id='{w}';"
                        )
                        if state != "queued":
                            sql(
                                f"UPDATE public.automation_workflow_runs SET state={quote(state)},next_due_at=NULL,claim_token=gen_random_uuid(),lease_expires_at=clock_timestamp()+INTERVAL '1 hour' WHERE id='{run}';"
                            )
                        if action == "reapprove":
                            sql(
                                f"UPDATE public.belt_test_recipients SET state='revoked',revision=revision+1,revoked_at=clock_timestamp() WHERE id='{recipient}';"
                            )
                        source = {
                            "event": f"SELECT public.mutate_belt_test_event_v1('{x['studio']}','{x['actor']}','{x['event']}',gen_random_uuid(),1,'{{\"location\":\"Changed\"}}');",
                            "reapprove": f"SELECT run_rank_proof.rank_approve({quote(x)});",
                            "revoke": f"SELECT public.revoke_belt_test_recipient_v1('{x['studio']}','{x['actor']}','{x['event']}','{recipient}',gen_random_uuid(),1);",
                        }[action]
                        lock = f"SELECT 1 FROM public.automation_workflow_runs WHERE id='{run}' FOR UPDATE;"
                        before = json.loads(
                            sql(
                                f"SELECT to_jsonb(r) FROM public.automation_workflow_runs r WHERE id='{run}';"
                            )
                        )
                        first = session(
                            "belt_first", source if source_first else lock, hold=True
                        )
                        ready(first)
                        second = session(
                            "belt_second", lock if source_first else source
                        )
                        blocked(first, second)
                        release(first, rollback)
                        finished(second)
                        after = json.loads(
                            sql(
                                f"SELECT to_jsonb(r) FROM public.automation_workflow_runs r WHERE id='{run}';"
                            )
                        )
                        changed = not source_first or not rollback
                        require(
                            after["revision"] == (2 if changed else 1),
                            "Belt command intent revision mismatch",
                        )
                        if changed:
                            require(
                                after["cancel_reason"]
                                == (
                                    "belt_test_changed"
                                    if action == "event"
                                    else "belt_test_approval_changed"
                                )
                                and after["next_due_at"] is None,
                                "Belt command lost exact intent",
                            )
                            if state != "queued":
                                delta = {
                                    "revision",
                                    "updated_at",
                                    "cancel_requested_at",
                                    "cancel_reason",
                                }
                                require(
                                    {k: v for k, v in before.items() if k not in delta}
                                    == {
                                        k: v for k, v in after.items() if k not in delta
                                    },
                                    "Belt command rewrote in-flight truth",
                                )
                        else:
                            require(after == before, "Belt rollback changed run")
                        passed(
                            f"belt {action} versus {state} source_first={source_first} rollback={rollback}"
                        )

        passed(
            "metadata ownership proof complete; traversal and sender owners remain future tasks"
        )
        print(
            json.dumps(
                {
                    "cases": cases,
                    "source_sha256": hashlib.sha256(MIGRATION.read_bytes()).hexdigest(),
                }
            ),
            flush=True,
        )
    finally:
        for child in children:
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
            for stream in (process.stdin, process.stdout, process.stderr):
                if stream is not None and not stream.closed:
                    stream.close()
        if owned:
            local.sql("postgres", f"DROP DATABASE {database} WITH (FORCE);")
        require(
            local.sql(
                "postgres",
                f"SELECT count(*) FROM pg_database WHERE datname={quote(database)};",
            )
            == "0",
            "Owned clone cleanup failed",
        )
        require(
            historical
            == {
                p.name: hashlib.sha256(p.read_bytes()).hexdigest()
                for p in MIGRATION.parent.glob("*.sql")
                if p != MIGRATION
            },
            "Historical migration changed",
        )
        require(
            local.sql(
                "postgres",
                "SELECT count(*) FROM supabase_migrations.schema_migrations;",
            )
            == "151",
            "Base history changed",
        )
        print(
            json.dumps(
                {
                    "owned_clone_removed": database if owned else None,
                    "historical_migrations_unchanged": 151,
                }
            ),
            flush=True,
        )


if __name__ == "__main__":
    main(sys.argv[1:])
