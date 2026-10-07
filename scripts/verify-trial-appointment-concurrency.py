#!/usr/bin/env python3
"""Prove trial commands using owned local PG17 clones and real competing sessions.

The caller owns the verified V56 base. This script changes and drops only its
uniquely named clone, applies partial V57 without registering migration history,
and sends no external requests.
"""

import hashlib
import json
import os
import queue
import subprocess
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

from local_postgres_verification import LocalPostgres, require, install_final_v57

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = (
    ROOT / "supabase/migrations/20261005105341_automation_workflow_graph_v57.sql"
)
sys.path.insert(0, str(ROOT / "backend"))
from app.schemas.trial_appointment import (
    TrialAppointmentCreate,
    TrialAppointmentResponse,
)
from app.services.trial_appointment_service import (
    TrialAppointmentMutationResult,
    TrialAppointmentService,
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
    database = f"koaryu_trial_appointments_{os.getpid()}"
    children, cases = [], []
    owned = False
    historical = {
        p.name: hashlib.sha256(p.read_bytes()).hexdigest()
        for p in MIGRATION.parent.glob("*.sql")
        if p != MIGRATION
    }
    require(len(historical) == 151, "Expected 151 historical migrations")

    def sql(statement):
        return local.sql(database, statement)

    def fixture():
        ids = {
            key: str(uuid4())
            for key in ("actor", "owner", "studio", "lead", "program", "operation")
        }
        sql(f"""BEGIN;
INSERT INTO auth.users(id,email,email_confirmed_at) VALUES('{ids["actor"]}','{ids["actor"]}@example.invalid',clock_timestamp()),('{ids["owner"]}','{ids["owner"]}@example.invalid',clock_timestamp());
INSERT INTO public.studios(id,name,slug,owner_id,timezone) VALUES('{ids["studio"]}','Trial race','{ids["studio"]}','{ids["owner"]}','UTC');
INSERT INTO public.staff_roles(studio_id,user_id,role) VALUES('{ids["studio"]}','{ids["actor"]}','admin'),('{ids["studio"]}','{ids["owner"]}','admin');
INSERT INTO public.studio_subscriptions(studio_id,status,comped) VALUES('{ids["studio"]}','active',false);
INSERT INTO public.programs(id,studio_id,name) VALUES('{ids["program"]}','{ids["studio"]}','Trial program');
INSERT INTO public.leads(id,studio_id,first_name,last_name,program_id) VALUES('{ids["lead"]}','{ids["studio"]}','Synthetic','Trial','{ids["program"]}');
COMMIT;""")
        return ids

    def request(start=None):
        start = start or datetime.now(timezone.utc) + timedelta(days=7)
        return {
            "starts_at": start.isoformat(),
            "ends_at": (start + timedelta(hours=1)).isoformat(),
            "timezone": "UTC",
            "location": "",
        }

    def mutate(ids, req, operation=None, revision=None, appointment=None):
        return (
            "SELECT public.mutate_lead_trial_appointment_v1("
            + ",".join(
                map(
                    quote,
                    (
                        ids["studio"],
                        ids["actor"],
                        ids["lead"],
                        appointment,
                        operation or str(uuid4()),
                        revision,
                        req,
                    ),
                )
            )
            + ");"
        )

    def provision(ids):
        value = json.loads(sql("SET ROLE service_role;" + mutate(ids, request())))
        TrialAppointmentMutationResult.model_validate(value)
        ids["appointment"] = value["payload"]["id"]
        return value

    def edit(ids, req, revision=1, operation=None):
        return mutate(
            ids,
            req,
            operation=operation,
            revision=revision,
            appointment=ids["appointment"],
        )

    def facts(ids):
        return json.loads(
            sql(f"""SELECT jsonb_build_object(
'appointments',(SELECT count(*) FROM public.lead_trial_appointments WHERE lead_id='{ids["lead"]}'),
'meetings',(SELECT count(*) FROM public.lead_activities WHERE lead_id='{ids["lead"]}' AND activity_type='meeting'),
'audits',(SELECT count(*) FROM public.audit_logs WHERE studio_id='{ids["studio"]}' AND action LIKE 'trial.%'),
'receipts',(SELECT count(*) FROM private.automation_command_operations WHERE studio_id='{ids["studio"]}' AND command LIKE 'trial.%'),
'revision',(SELECT max(revision) FROM public.lead_trial_appointments WHERE lead_id='{ids["lead"]}'),
'stage',(SELECT stage FROM public.leads WHERE id='{ids["lead"]}'));""")
        )

    def session(name, statement, hold=False, role="service_role"):
        name = f"trial_appointments_{os.getpid()}_{name}"[:63]
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

    def passed(name, **evidence):
        cases.append({"case": name, "outcome": "passed", **evidence})
        print(f"[trial appointments] PASS {name}", flush=True)

    def continue_session(item, statement, expected_error=None):
        item["lines"].clear()
        item["process"].stdin.write(statement + "\nCOMMIT;\n")
        item["process"].stdin.close()
        return finished(item, expected_error)

    def seed_run(ids):
        graph = {
            "schema_version": 1,
            "nodes": [
                {
                    "id": "start",
                    "type": "trigger",
                    "config": {
                        "event_type": "trial.scheduled",
                        "program_id": ids["program"],
                    },
                },
                {"id": "end", "type": "end", "config": {}},
            ],
            "edges": [
                {"id": "next", "source": "start", "target": "end", "port": "next"}
            ],
        }
        created = json.loads(
            sql(
                "SET ROLE service_role; SELECT public.create_automation_workflow_v1("
                + ",".join(
                    map(
                        quote,
                        (
                            ids["studio"],
                            ids["actor"],
                            str(uuid4()),
                            "Trial race",
                            "",
                            graph,
                            {},
                        ),
                    )
                )
                + ");"
            )
        )
        ids["workflow"] = created["payload"]["id"]
        for action, revision in (("publish", 1), ("start", 2)):
            sql("SET ROLE service_role;" + workflow_command(ids, action, revision))
        ids["run"] = str(uuid4())
        event = str(uuid4())
        sql(f"""INSERT INTO private.automation_workflow_events(id,studio_id,event_type,source_key,subject_kind,subject_id,occurred_at)
VALUES('{event}','{ids["studio"]}','trial.scheduled','synthetic-proof','trial','{ids["appointment"]}',clock_timestamp());
INSERT INTO public.automation_workflow_runs(id,studio_id,workflow_id,version_id,event_id,activation_id,epoch,current_node_id,state,claim_token,lease_expires_at)
SELECT '{ids["run"]}',studio_id,workflow_id,version_id,'{event}',id,epoch,'start','claimed',gen_random_uuid(),clock_timestamp()+interval '1 minute'
FROM public.automation_workflow_activations WHERE workflow_id='{ids["workflow"]}' AND retired_at IS NULL;""")

    def workflow_command(ids, action, revision, operation=None):
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

    class SQLRPC:
        """Run the accepted service's actual parameters through local SQL."""

        def rpc(self, name, params):
            require(
                name
                in {
                    "mutate_lead_trial_appointment_v1",
                    "list_lead_trial_appointments_v1",
                },
                "Unexpected RPC",
            )
            statement = (
                "SET ROLE service_role; SELECT public."
                + name
                + "("
                + ",".join(f"{key}=>{quote(value)}" for key, value in params.items())
                + ");"
            )
            return SimpleNamespace(
                execute=lambda: SimpleNamespace(data=json.loads(sql(statement)))
            )

    try:
        local.sql("postgres", f"CREATE DATABASE {database} TEMPLATE postgres;")
        owned = True
        install_final_v57(local, database, ROOT)
        require(
            sql("SELECT count(*) FROM supabase_migrations.schema_migrations;") == "152",
            "Partial migration registered history",
        )
        for contract in (
            "workflow_management_contract.sql",
            "trial_appointment_contract.sql",
        ):
            output = sql((ROOT / "supabase/verification" / contract).read_text())
            passed(contract, result=output.strip())

        ids = fixture()
        service = TrialAppointmentService(SQLRPC())
        created = service.create(
            ids["studio"],
            ids["actor"],
            ids["lead"],
            TrialAppointmentCreate(operation_id=uuid4(), **request()),
        )
        require(
            created.payload.revision == 1 and created.payload.program_id is not None,
            "Real SQL service create DTO mismatch",
        )
        ids["appointment"] = str(created.payload.id)
        page = service.list(ids["studio"], ids["actor"], ids["lead"])
        require(
            page.items == [created.payload]
            and not page.has_more
            and page.next_cursor is None,
            "Real SQL service list DTO mismatch",
        )
        # Session timezone must not alter canonical output or operation identity.
        req = request()
        op = str(uuid4())
        sql("SET ROLE service_role;" + edit(ids, {"status": "canceled"}))
        first = json.loads(
            sql(
                "SET TIME ZONE 'Pacific/Kiritimati'; SET ROLE service_role;"
                + mutate(ids, req, operation=op)
            )
        )
        equivalent = {
            **req,
            "starts_at": datetime.fromisoformat(req["starts_at"])
            .astimezone(timezone(timedelta(hours=-7)))
            .isoformat(),
            "ends_at": datetime.fromisoformat(req["ends_at"])
            .astimezone(timezone(timedelta(hours=-7)))
            .isoformat(),
        }
        replay = json.loads(
            sql(
                "SET TIME ZONE 'America/Los_Angeles'; SET ROLE service_role;"
                + mutate(ids, equivalent, operation=op)
            )
        )
        require(
            replay == {**first, "replayed": True}, "UTC normalization replay differs"
        )
        TrialAppointmentResponse.model_validate(first["payload"])
        first_page = service.list(ids["studio"], ids["actor"], ids["lead"], limit=1)
        require(
            first_page.has_more and first_page.next_cursor is not None,
            "Actual service cursor missing",
        )
        second_page = service.list(
            ids["studio"],
            ids["actor"],
            ids["lead"],
            limit=1,
            cursor=first_page.next_cursor,
        )
        require(
            not second_page.has_more
            and second_page.items[0].id != first_page.items[0].id,
            "Actual service cursor repeated a row",
        )
        passed(
            "actual accepted service mutation list DTO and session-independent UTC replay"
        )

        for rollback in (False, True):
            ids = fixture()
            first = session("create_owner", mutate(ids, request()), hold=True)
            ready(first)
            second = session("create_competitor", mutate(ids, request()))
            evidence = blocked(first, second)
            release(first, rollback=rollback)
            finished(second, None if rollback else "AUTOMATION_STATE_CONFLICT")
            state = facts(ids)
            require(
                state["appointments"]
                == state["meetings"]
                == state["audits"]
                == state["receipts"]
                == 1,
                "Competing create wrote multiple appointments",
            )
            passed(f"competing creates owner rollback={rollback}", blocking=evidence)

            ids = fixture()
            statement = mutate(ids, request(), operation=ids["operation"])
            first = session("replay_owner", statement, hold=True)
            original = ready(first)
            second = session("replay_competitor", statement)
            evidence = blocked(first, second, advisory=True)
            release(first, rollback=rollback)
            replay = finished(second)
            require(replay["replayed"] is (not rollback), "Replay identity wrong")
            if not rollback:
                require(
                    replay["payload"] == original["payload"],
                    "Replay lost original payload",
                )
            require(
                facts(ids)["meetings"] == facts(ids)["receipts"] == 1,
                "Replay duplicated activity or receipt",
            )
            passed(f"same operation owner rollback={rollback}", blocking=evidence)

            ids = fixture()
            provision(ids)
            first = session("edit_owner", edit(ids, {"location": "Changed"}), hold=True)
            ready(first)
            second = session("outcome_competitor", edit(ids, {"status": "canceled"}))
            evidence = blocked(first, second)
            release(first, rollback=rollback)
            finished(second, None if rollback else "AUTOMATION_REVISION_CONFLICT")
            require(
                facts(ids)["revision"] == 2 and facts(ids)["meetings"] == 2,
                "CAS race accepted more than one edit",
            )
            passed(
                f"reschedule versus outcome owner rollback={rollback}",
                blocking=evidence,
            )

        for domain in ("closed_lost", "conversion"):
            for trial_first in (False, True):
                for rollback in (False, True):
                    ids = fixture()
                    if domain == "closed_lost":
                        domain_command = f"SELECT to_jsonb(r) FROM public.update_lead_atomic('{ids['studio']}','{ids['actor']}','{ids['lead']}', '{{\"stage\":\"closed_lost\"}}') r;"
                    else:
                        domain_command = f"SELECT to_jsonb(r) FROM public.convert_lead_to_student_atomic('{ids['studio']}','{ids['actor']}','{ids['lead']}','{uuid4()}','{ids['program']}','active',CURRENT_DATE) r;"
                    trial = mutate(ids, request())
                    first = session(
                        "domain_first",
                        trial if trial_first else domain_command,
                        hold=True,
                    )
                    ready(first)
                    second = session(
                        "domain_second", domain_command if trial_first else trial
                    )
                    evidence = blocked(first, second)
                    release(first, rollback=rollback)
                    finished(
                        second,
                        "AUTOMATION_STATE_CONFLICT"
                        if not trial_first and not rollback
                        else None,
                    )
                    state = facts(ids)
                    expected_count = int(
                        (trial_first and not rollback) or (not trial_first and rollback)
                    )
                    require(
                        state["appointments"] == expected_count,
                        "Domain race retained wrong trial count",
                    )
                    if trial_first or not rollback:
                        require(
                            state["stage"]
                            == (
                                "enrolled" if domain == "conversion" else "closed_lost"
                            ),
                            "Trial lowered terminal lead stage",
                        )
                    passed(
                        f"{domain} trial_first={trial_first} rollback={rollback}",
                        blocking=evidence,
                    )

        for mutation in ("archive", "delete"):
            for trial_first in (False, True):
                for rollback in (False, True):
                    ids = fixture()
                    req = {**request(), "program_id": ids["program"]}
                    trial = mutate(ids, req, operation=ids["operation"])
                    change = (
                        f"UPDATE public.programs SET archived_at=clock_timestamp() WHERE id='{ids['program']}';"
                        if mutation == "archive"
                        else f"DELETE FROM public.programs WHERE id='{ids['program']}';"
                    ) + " SELECT '{}'::jsonb;"
                    first = session(
                        "reference_first",
                        trial if trial_first else change,
                        hold=True,
                        role="postgres",
                    )
                    ready(first)
                    second = session(
                        "reference_second",
                        change if trial_first else trial,
                        role="postgres",
                    )
                    if not trial_first and mutation == "archive":
                        finished(second, "AUTOMATION_STUDIO_BUSY")
                        require(
                            facts(ids)["receipts"] == 0,
                            "Busy program check left a receipt",
                        )
                        evidence = {"outcome": "NOWAIT busy"}
                        release(first, rollback=rollback)
                        finished(
                            session("reference_retry", trial),
                            None if rollback else "AUTOMATION_STATE_CONFLICT",
                        )
                    else:
                        evidence = blocked(first, second)
                        release(first, rollback=rollback)
                        finished(
                            second,
                            "AUTOMATION_NOT_FOUND"
                            if not trial_first and mutation == "delete" and not rollback
                            else None,
                        )
                    expected = int(
                        (trial_first and not rollback) or (not trial_first and rollback)
                    )
                    require(
                        facts(ids)["appointments"] == expected,
                        "Program race trial outcome wrong",
                    )
                    if trial_first and not rollback:
                        stored = sql(
                            f"SELECT program_id::text FROM public.lead_trial_appointments WHERE lead_id='{ids['lead']}';"
                        )
                        require(
                            stored == ids["program"],
                            "Program mutation rewrote logical trial context",
                        )
                    passed(
                        f"program {mutation} trial_first={trial_first} rollback={rollback}",
                        blocking=evidence,
                    )

        for command_first in (False, True):
            for rollback in (False, True):
                ids = fixture()
                trial = mutate(ids, request(), operation=ids["operation"])
                revoke = f"UPDATE public.staff_roles SET archived_at=clock_timestamp() WHERE studio_id='{ids['studio']}' AND user_id='{ids['actor']}'; SELECT '{{}}'::jsonb;"
                first = session(
                    "admin_first",
                    trial if command_first else revoke,
                    hold=True,
                    role="postgres",
                )
                ready(first)
                second = session(
                    "admin_second", revoke if command_first else trial, role="postgres"
                )
                evidence = blocked(first, second)
                release(first, rollback=rollback)
                finished(
                    second,
                    "AUTOMATION_ADMIN_REQUIRED"
                    if not command_first and not rollback
                    else None,
                )
                expected = int(
                    (command_first and not rollback) or (not command_first and rollback)
                )
                require(
                    facts(ids)["appointments"] == expected,
                    "Admin revocation race outcome wrong",
                )
                passed(
                    f"admin revocation command_first={command_first} rollback={rollback}",
                    blocking=evidence,
                )

        for command_first in (False, True):
            for rollback in (False, True):
                ids = fixture()
                trial = mutate(ids, request(), operation=ids["operation"])
                clear = f"SELECT public.clear_studio_operational_data_atomic('{ids['studio']}',false); SELECT '{{}}'::jsonb;"
                first = session(
                    "clear_first",
                    trial if command_first else clear,
                    hold=True,
                    role="postgres",
                )
                ready(first)
                second = session(
                    "clear_second", clear if command_first else trial, role="postgres"
                )
                if command_first:
                    evidence = blocked(first, second, advisory=True)
                    release(first, rollback=rollback)
                    finished(second)
                    require(
                        facts(ids)["appointments"] == 0 and facts(ids)["stage"] is None,
                        "Clear left trial or lead",
                    )
                else:
                    finished(second, "AUTOMATION_STUDIO_BUSY")
                    evidence = {"outcome": "shared gate NOWAIT busy"}
                    require(
                        facts(ids)["receipts"] == 0, "Clear-busy trial left a receipt"
                    )
                    release(first, rollback=rollback)
                    finished(
                        session("clear_explicit_retry", trial),
                        None if rollback else "AUTOMATION_NOT_FOUND",
                    )
                    require(
                        facts(ids)["appointments"] == int(rollback),
                        "Clear retry outcome wrong",
                    )
                passed(
                    f"operational clear command_first={command_first} rollback={rollback}",
                    blocking=evidence,
                )

        for outcome in ("future", "completed", "no_show"):
            ids = fixture()
            if outcome != "future":
                provision(ids)
            first = session(
                "clock_lead_holder",
                f"SELECT jsonb_build_object('held',id) FROM public.leads WHERE id='{ids['lead']}' FOR UPDATE;",
                hold=True,
            )
            ready(first)
            boundary = datetime.now(timezone.utc) + timedelta(seconds=2)
            if outcome == "future":
                statement = mutate(ids, request(boundary))
            else:
                if outcome == "completed":
                    starts_at, ends_at = boundary, boundary + timedelta(hours=1)
                else:
                    starts_at, ends_at = boundary - timedelta(hours=1), boundary
                # Only the test fixture edits the appointment clock. The held lead
                # stays owned, so the RPC cannot sample until the source barrier.
                sql(
                    f"UPDATE public.lead_trial_appointments SET starts_at={quote(starts_at.isoformat())},ends_at={quote(ends_at.isoformat())} WHERE id='{ids['appointment']}';"
                )
                statement = edit(ids, {"status": outcome})
            second = session("clock_waiter", statement)
            evidence = blocked(first, second)
            while datetime.now(timezone.utc) <= boundary:
                time.sleep(0.05)
            release(first)
            value = finished(
                second, "AUTOMATION_STATE_CONFLICT" if outcome == "future" else None
            )
            if value:
                require(
                    value["payload"]["status"] == outcome,
                    "Outcome sampled before lock wait",
                )
            passed(
                f"{outcome} clock sampled after observed lead wait", blocking=evidence
            )

        ids = fixture()
        provision(ids)
        seed_run(ids)
        holder = session(
            "future_workflow_holder",
            f"SELECT jsonb_build_object('held',id) FROM public.automation_workflows WHERE id='{ids['workflow']}' FOR UPDATE;",
            hold=True,
        )
        ready(holder)
        boundary = datetime.now(timezone.utc) + timedelta(seconds=2)
        before = facts(ids)
        operation = str(uuid4())
        waiter = session(
            "future_after_workflow_wait",
            edit(ids, request(boundary), operation=operation),
        )
        evidence = blocked(holder, waiter)
        while datetime.now(timezone.utc) <= boundary:
            time.sleep(0.05)
        release(holder)
        finished(waiter, "AUTOMATION_STATE_CONFLICT")
        require(
            facts(ids) == before,
            "Expired reschedule changed appointment activity audit or receipt",
        )
        require(
            sql(
                f"SELECT state='claimed' AND revision=1 AND claim_token IS NOT NULL FROM public.automation_workflow_runs WHERE id='{ids['run']}';"
            )
            == "t",
            "Expired reschedule retained partial cancellation",
        )
        require(
            sql(
                f"SELECT count(*) FROM private.automation_command_operations WHERE operation_id='{operation}';"
            )
            == "0",
            "Expired reschedule retained operation",
        )
        passed(
            "future reschedule expires during observed workflow wait and all writes roll back",
            blocking=evidence,
        )

        ids = fixture()
        provision(ids)
        seed_run(ids)
        holder = session(
            "workflow_cancel_owner",
            f"SELECT jsonb_build_object('held',id) FROM public.automation_workflows WHERE id='{ids['workflow']}' FOR UPDATE;",
            hold=True,
        )
        ready(holder)
        trial = session("trial_cancel_wait", edit(ids, {"status": "canceled"}))
        first_wait = blocked(holder, trial)
        deleter = session(
            "program_delete_wait",
            f"DELETE FROM public.programs WHERE id='{ids['program']}'; SELECT '{{}}'::jsonb;",
            role="postgres",
        )
        second_wait = blocked(trial, deleter)
        publish_op = str(uuid4())
        continue_session(
            holder,
            workflow_command(ids, "publish", 3, publish_op),
            "AUTOMATION_STUDIO_BUSY",
        )
        canceled = finished(trial)
        finished(deleter)
        require(
            canceled["payload"]["status"] == "canceled", "Cycle break lost cancellation"
        )
        require(
            sql(
                f"SELECT state='cancelled' AND claim_token IS NULL FROM public.automation_workflow_runs WHERE id='{ids['run']}';"
            )
            == "t",
            "Cycle break left stale claimed run",
        )
        require(
            sql(
                f"SELECT count(*) FROM private.automation_command_operations WHERE operation_id='{publish_op}';"
            )
            == "0",
            "Busy publish retained receipt",
        )
        require(
            sql(
                f"SELECT revision=3 AND status='active' FROM public.automation_workflows WHERE id='{ids['workflow']}';"
            )
            == "t",
            "Busy publish changed workflow",
        )
        passed(
            "three-session cancellation publication program-delete cycle fails busy atomically",
            trial_wait=first_wait,
            delete_wait=second_wait,
        )

        for rollback in (False, True):
            ids = fixture()
            provision(ids)
            seed_run(ids)
            first = session(
                "source_cancel_owner", edit(ids, {"location": "Changed"}), hold=True
            )
            ready(first)
            second = session(
                "source_waiter",
                f"SELECT jsonb_build_object('held',id) FROM public.leads WHERE id='{ids['lead']}' FOR UPDATE;",
            )
            third = session("workflow_waiter", workflow_command(ids, "pause", 3))
            fourth = session(
                "run_waiter",
                f"SELECT jsonb_build_object('held',id) FROM public.automation_workflow_runs WHERE id='{ids['run']}' FOR UPDATE;",
            )
            waits = [blocked(first, item) for item in (second, third, fourth)]
            release(first, rollback=rollback)
            for item in (second, third, fourth):
                finished(item)
            require(
                sql(
                    f"SELECT state='cancelled' AND claim_token IS NULL FROM public.automation_workflow_runs WHERE id='{ids['run']}';"
                )
                == "t",
                "Cancellation/pause left claimed run usable",
            )
            passed(f"source workflow run ownership rollback={rollback}", blocking=waits)

        require(
            {
                p.name: hashlib.sha256(p.read_bytes()).hexdigest()
                for p in MIGRATION.parent.glob("*.sql")
                if p != MIGRATION
            }
            == historical,
            "Historical migration bytes changed",
        )
        require(
            sql("SELECT count(*) FROM supabase_migrations.schema_migrations;") == "152",
            "Partial migration registered history",
        )
        passed("151 historical hashes unchanged and complete 152 migration history")
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
                "Clone cleanup failed",
            )
            print(f"[trial appointments] cleaned {database}", flush=True)
    print(
        json.dumps(
            {
                "outcome": "passed",
                "cases": cases,
                "clone_cleaned": owned,
                "complete_v57": True,
                "migration_history_count": 152,
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main(sys.argv[1:])
