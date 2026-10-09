#!/usr/bin/env python3
"""Prove committed source capture in a unique LocalPostgres-guarded V56 clone.

No provider, environment-file, mail, Docker or base-database writes. The caller
owns the base cluster; this process owns and finally removes only its clone.
"""

import asyncio
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
from app.schemas.lead import LeadCreate, LeadResponse
from app.services.lead_service import LeadService


def quote(value):
    if value is None:
        return "NULL"
    if isinstance(value, (dict, list)):
        value = json.dumps(value, separators=(",", ":"))
    return "'" + str(value).replace("'", "''") + "'"


def call(name, *args):
    return "SELECT public." + name + "(" + ",".join(map(quote, args)) + ");"


def main(arguments):
    require(len(arguments) == 3, "Expected psql socket port")
    psql, socket, port = arguments
    local = LocalPostgres(psql, socket, port, str(Path(socket).parent))
    database = f"koaryu_domain_capture_{os.getpid()}_{uuid4().hex[:8]}"
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

    def passed(name, **evidence):
        cases.append({"case": name, "outcome": "passed", **evidence})
        print(f"[domain capture] PASS {name}", flush=True)

    def fixture():
        ids = {
            k: str(uuid4())
            for k in (
                "actor",
                "owner",
                "studio",
                "program",
                "lead",
                "ladder",
                "rank",
                "student",
                "event",
            )
        }
        sql(f"""BEGIN;
INSERT INTO auth.users(id,email,email_confirmed_at) VALUES('{ids["actor"]}','{ids["actor"]}@example.invalid',clock_timestamp()),('{ids["owner"]}','{ids["owner"]}@example.invalid',clock_timestamp());
INSERT INTO public.studios(id,name,slug,owner_id,timezone) VALUES('{ids["studio"]}','Capture race','{ids["studio"]}','{ids["owner"]}','UTC');
INSERT INTO public.staff_roles(studio_id,user_id,role) VALUES('{ids["studio"]}','{ids["actor"]}','admin'),('{ids["studio"]}','{ids["owner"]}','admin');
INSERT INTO public.studio_subscriptions(studio_id,status,comped) VALUES('{ids["studio"]}','active',false);
INSERT INTO public.programs(id,studio_id,name) VALUES('{ids["program"]}','{ids["studio"]}','Program');
INSERT INTO public.leads(id,studio_id,first_name,last_name,program_id) VALUES('{ids["lead"]}','{ids["studio"]}','Synthetic','Lead','{ids["program"]}');
INSERT INTO public.belt_ladders(id,studio_id,name) VALUES('{ids["ladder"]}','{ids["studio"]}','Unscoped');
INSERT INTO public.belt_ranks(id,studio_id,ladder_id,name,min_classes,min_months) VALUES('{ids["rank"]}','{ids["studio"]}','{ids["ladder"]}','First',0,0);
INSERT INTO public.students(id,studio_id,legal_first_name,legal_last_name,status,program_id,membership_start_date) VALUES('{ids["student"]}','{ids["studio"]}','Synthetic','Student','active','{ids["program"]}',CURRENT_DATE-120);
INSERT INTO public.belt_test_events(id,studio_id,name,ladder_id,starts_at,ends_at,timezone,status) VALUES('{ids["event"]}','{ids["studio"]}','Test','{ids["ladder"]}',clock_timestamp()+interval '7 days',clock_timestamp()+interval '7 days 1 hour','UTC','scheduled');
COMMIT;""")
        return ids

    def graph(event="lead.created", program=None):
        return {
            "schema_version": 1,
            "nodes": [
                {
                    "id": "trigger",
                    "type": "trigger",
                    "config": {"event_type": event, "program_id": program},
                },
                {"id": "end", "type": "end", "config": {}},
            ],
            "edges": [
                {"id": "next", "source": "trigger", "target": "end", "port": "next"}
            ],
        }

    def workflow(ids, event="lead.created", active=True, program=None):
        r = json.loads(
            sql(
                "SET ROLE service_role;"
                + call(
                    "create_automation_workflow_v1",
                    ids["studio"],
                    ids["actor"],
                    str(uuid4()),
                    "Capture",
                    "",
                    graph(event, program),
                    {},
                )
            )
        )
        w = r["payload"]["id"]
        sql("SET ROLE service_role;" + lifecycle(ids, w, "publish", 1))
        if active:
            sql("SET ROLE service_role;" + lifecycle(ids, w, "start", 2))
        return w

    def lifecycle(ids, w, action, revision):
        return call(
            "command_automation_workflow_v1",
            ids["studio"],
            ids["actor"],
            w,
            str(uuid4()),
            revision,
            action,
        )

    def create(ids, op=None):
        return call(
            "create_lead_atomic_v1",
            ids["studio"],
            ids["actor"],
            op or str(uuid4()),
            {
                "first_name": "Synthetic",
                "last_name": "Created",
                "program_id": ids["program"],
            },
        )

    def trial(ids, appointment=None, revision=None, req=None):
        start = datetime.now(timezone.utc) + timedelta(days=7)
        req = req or {
            "starts_at": start.isoformat(),
            "ends_at": (start + timedelta(hours=1)).isoformat(),
            "timezone": "UTC",
        }
        return call(
            "mutate_lead_trial_appointment_v1",
            ids["studio"],
            ids["actor"],
            ids["lead"],
            appointment,
            str(uuid4()),
            revision,
            req,
        )

    def approve(ids, recipients=None):
        return call(
            "approve_belt_test_recipients_v1",
            ids["studio"],
            ids["actor"],
            ids["event"],
            str(uuid4()),
            1,
            recipients or [{"student_id": ids["student"]}],
        )

    def facts(ids):
        return json.loads(
            sql(f"""SELECT jsonb_build_object(
'leads',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY id),'[]') FROM public.leads r WHERE studio_id='{ids["studio"]}'),
'appointments',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY id),'[]') FROM public.lead_trial_appointments r WHERE studio_id='{ids["studio"]}'),
'recipients',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY id),'[]') FROM public.belt_test_recipients r WHERE studio_id='{ids["studio"]}'),
'activities',(SELECT count(*) FROM public.lead_activities WHERE studio_id='{ids["studio"]}'),
'audits',(SELECT count(*) FROM public.audit_logs WHERE studio_id='{ids["studio"]}'),
'events',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY id),'[]') FROM private.automation_workflow_events r WHERE studio_id='{ids["studio"]}'),
'runs',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY id),'[]') FROM public.automation_workflow_runs r WHERE studio_id='{ids["studio"]}'),
'receipts',(SELECT count(*) FROM private.automation_command_operations WHERE studio_id='{ids["studio"]}'));""")
        )

    def session(name, statement, hold=False, role="service_role"):
        name = f"domain_capture_{os.getpid()}_{name}_{len(children)}"[:63]
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
        return [json.loads(line) for line in item["lines"] if line.startswith("{")][-1]

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
        errors = "\n".join(item["errors"])
        if expected_error:
            require(
                code != 0 and expected_error in errors,
                f"Expected {expected_error}: {errors}",
            )
            return None
        require(code == 0, f"Session failed: {errors}")
        return result(item)

    def release(item, rollback=False):
        item["process"].stdin.write("ROLLBACK;\n" if rollback else "COMMIT;\n")
        item["process"].stdin.close()
        return finished(item)

    def continue_session(item, statement):
        item["process"].stdin.write(statement + "\nCOMMIT;\n")
        item["process"].stdin.close()

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

    def lock_row(table, identity):
        return f"SELECT 1 FROM {table} WHERE id='{identity}' FOR UPDATE;SELECT '{{}}'::JSONB;"

    class SQLRPC:
        def rpc(self, name, params):
            require(name == "create_lead_atomic_v1", "Unexpected lead RPC")
            statement = (
                "SET ROLE service_role; SELECT public."
                + name
                + "("
                + ",".join(f"{k}=>{quote(v)}" for k, v in params.items())
                + ");"
            )
            return SimpleNamespace(
                execute=lambda: SimpleNamespace(data=json.loads(sql(statement)))
            )

    try:
        local.sql("postgres", f"CREATE DATABASE {database} TEMPLATE postgres;")
        owned = True
        print(f"[domain capture] owned clone {database}", flush=True)
        install_final_v57(local, database, ROOT)
        for contract in (
            "workflow_management_contract.sql",
            "workflow_domain_capture_contract.sql",
            "trial_appointment_contract.sql",
            "belt_test_event_contract.sql",
            "belt_test_recipient_contract.sql",
        ):
            passed(
                contract,
                result=sql((ROOT / "supabase/verification" / contract).read_text()),
            )

        ids = fixture()
        sql(
            f"UPDATE public.staff_roles SET role='front_desk' WHERE user_id='{ids['actor']}';"
        )
        service = LeadService(SQLRPC())
        data = LeadCreate(
            first_name="  retained  ",
            last_name="",
            phone="unchanged",
            operation_id=uuid4(),
            ignored_extra="ignored",
        )
        first = asyncio.run(service.create_lead(data, ids["studio"], ids["actor"]))
        second = asyncio.run(service.create_lead(data, ids["studio"], ids["actor"]))
        legacy = asyncio.run(
            service.create_lead(
                LeadCreate(first_name="Legacy", last_name="Caller"),
                ids["studio"],
                ids["actor"],
            )
        )
        require(
            first == second
            and legacy.id != first.id
            and set(first.model_dump()) == set(LeadResponse.model_fields),
            "Actual lead service result mismatch",
        )
        require(
            len(facts(ids)["events"]) == 2, "Service path duplicated or lost events"
        )
        passed(
            "accepted LeadService through SQL, front desk, legacy optional key and exact response"
        )

        # Committed receipt replay must not reinterpret DATE under a new session.
        for raw_date, first_settings, replay_settings in (
            (
                "today",
                "SET TIME ZONE 'Pacific/Kiritimati';",
                "SET TIME ZONE 'Pacific/Honolulu';",
            ),
            (
                "03/04/2030",
                "SET DateStyle TO 'ISO, MDY';",
                "SET DateStyle TO 'ISO, DMY';",
            ),
        ):
            ids = fixture()
            operation = str(uuid4())
            statement = call(
                "create_lead_atomic_v1",
                ids["studio"],
                ids["actor"],
                operation,
                {
                    "first_name": "Date",
                    "last_name": "Replay",
                    "follow_up_date": raw_date,
                },
            )
            original = json.loads(
                sql("SET ROLE service_role;" + first_settings + statement)
            )
            replay = json.loads(
                sql("SET ROLE service_role;" + replay_settings + statement)
            )
            require(
                replay == {**original, "replayed": True},
                "Committed date receipt changed with session settings",
            )
            state = facts(ids)
            require(
                len(state["events"]) == 1
                and state["receipts"] == 1
                and len(state["leads"]) == 2,
                "Date receipt replay created duplicate facts",
            )
            passed(
                f"committed raw date {raw_date} replays across independent session settings"
            )

        # Same/new operation contenders own one lead per operation under commit/rollback.
        for rollback in (False, True):
            ids = fixture()
            op = str(uuid4())
            statement = create(ids, op)
            first = session("create_owner", statement, hold=True)
            original = ready(first)
            second = session("create_waiter", statement)
            blocked(first, second)
            release(first, rollback)
            value = finished(second)
            require(value["replayed"] is (not rollback), "Receipt replay mismatch")
            require(
                (value["payload"]["id"] == original["payload"]["id"]) is (not rollback),
                "Aborted lead identity reused",
            )
            require(
                len(facts(ids)["events"]) == 1, "Create produced duplicate occurrences"
            )
            passed(f"lead same-key commit rollback={rollback}")

        def assignee_fixture():
            value = fixture()
            value["assignee"] = str(uuid4())
            sql(
                f"INSERT INTO auth.users(id,email) VALUES('{value['assignee']}','{value['assignee']}@example.invalid'); INSERT INTO public.staff_roles(studio_id,user_id,role) VALUES('{value['studio']}','{value['assignee']}','instructor'); UPDATE public.staff_roles SET invited_by='{value['assignee']}' WHERE studio_id='{value['studio']}' AND user_id='{value['actor']}';"
            )
            return value

        def assigned_create(ids, operation):
            return call(
                "create_lead_atomic_v1",
                ids["studio"],
                ids["actor"],
                operation,
                {
                    "first_name": "Assigned",
                    "last_name": "Source",
                    "assigned_staff_id": ids["assignee"],
                },
            )

        ids = assignee_fixture()
        deleter = session(
            "rejected_auth_parent",
            lock_row("auth.users", ids["assignee"]),
            hold=True,
            role="postgres",
        )
        ready(deleter)
        old_order = session(
            "rejected_staff_then_auth",
            f"SELECT private.workflow_require_actor_v1('{ids['studio']}','{ids['actor']}',true); SELECT private.lock_student_import_actor('{ids['assignee']}'); SELECT '{{}}'::JSONB;",
        )
        blocked(deleter, old_order)
        continue_session(
            deleter,
            f"DELETE FROM auth.users WHERE id='{ids['assignee']}'; SELECT '{{}}'::JSONB;",
        )
        for item in (deleter, old_order):
            item["process"].wait(timeout=25)
            for thread in item["threads"]:
                thread.join(timeout=2)
        require(
            sum("40P01" in "\n".join(item["errors"]) for item in (deleter, old_order))
            == 1,
            "Actual invited_by/Auth cycle not reproduced",
        )
        passed(
            "rejected blocking assignee Auth order reproduces actual invited_by cleanup deadlock"
        )

        for rollback in (False, True):
            ids = assignee_fixture()
            operation = str(uuid4())
            before = facts(ids)
            deleter = session(
                "safe_assignee_parent",
                lock_row("auth.users", ids["assignee"]),
                hold=True,
                role="postgres",
            )
            ready(deleter)
            finished(
                session("busy_assignee_source", assigned_create(ids, operation)),
                "AUTOMATION_STUDIO_BUSY",
            )
            require(
                facts(ids) == before,
                "Auth busy left lead activity audit event or receipt",
            )
            deleter["process"].stdin.write(
                f"DELETE FROM auth.users WHERE id='{ids['assignee']}';\n"
                + ("ROLLBACK;\n" if rollback else "COMMIT;\n")
            )
            deleter["process"].stdin.close()
            finished(deleter)
            if rollback:
                retry_result = finished(
                    session("assignee_retry", assigned_create(ids, operation))
                )
                require(
                    retry_result["payload"]["assigned_staff_id"] == ids["assignee"]
                    and len(facts(ids)["events"]) == 1,
                    "Explicit retry did not commit one assigned lead",
                )
                # Replay succeeds while dynamic assignee Auth is now unavailable.
                deleter = session(
                    "replay_assignee_parent",
                    lock_row("auth.users", ids["assignee"]),
                    hold=True,
                    role="postgres",
                )
                ready(deleter)
                replay = finished(
                    session(
                        "historical_assignee_replay", assigned_create(ids, operation)
                    )
                )
                require(
                    replay == {**retry_result, "replayed": True},
                    "Historical replay reached dynamic assignee lock",
                )
                release(deleter, True)
            else:
                finished(
                    session("assignee_missing_retry", assigned_create(ids, operation)),
                    "AUTOMATION_NOT_FOUND",
                )
                require(facts(ids) == before, "Missing assignee left source facts")
            passed(
                f"actual assignee Auth cleanup busy rollback and historical replay rollback={rollback}"
            )

        # Authority is still locked and checked before receipt replay.
        ids = assignee_fixture()
        operation = str(uuid4())
        finished(session("authorized_create", assigned_create(ids, operation)))
        sql(
            f"UPDATE public.staff_roles SET role='instructor' WHERE user_id='{ids['actor']}';"
        )
        finished(
            session("demoted_replay", assigned_create(ids, operation)),
            "AUTOMATION_ADMIN_REQUIRED",
        )
        require(
            len(facts(ids)["events"]) == 1, "Unauthorized replay emitted another event"
        )
        passed(
            "current actor authority still precedes assigned historical receipt replay"
        )

        # Capture waits for every active candidate and reads its version only after wait.
        for action in ("publish", "pause"):
            for rollback in (False, True):
                for source_first in (False, True):
                    ids = fixture()
                    w = workflow(ids)
                    old_version = sql(
                        f"SELECT published_version_id FROM public.automation_workflows WHERE id='{w}';"
                    )
                    source_stmt = create(ids)
                    lifecycle_stmt = lifecycle(ids, w, action, 3)
                    first = session(
                        "first",
                        source_stmt if source_first else lifecycle_stmt,
                        hold=True,
                    )
                    ready(first)
                    second = session(
                        "second", lifecycle_stmt if source_first else source_stmt
                    )
                    blocked(first, second)
                    release(first, rollback)
                    finished(second)
                    state = facts(ids)
                    events = state["events"]
                    runs = state["runs"]
                    expected_events = 0 if source_first and rollback else 1
                    require(
                        len(events) == expected_events,
                        "Source rollback occurrence mismatch",
                    )
                    if expected_events:
                        expected_runs = (
                            0
                            if not source_first and action == "pause" and not rollback
                            else 1
                        )
                        require(
                            len(runs) == expected_runs,
                            "Locked lifecycle target missing or backfilled",
                        )
                        if runs:
                            expected_version = (
                                old_version
                                if source_first or rollback
                                else sql(
                                    f"SELECT published_version_id FROM public.automation_workflows WHERE id='{w}';"
                                )
                            )
                            require(
                                runs[0]["version_id"] == expected_version,
                                "Stale outer snapshot selected wrong version",
                            )
                            if source_first and action == "pause":
                                require(
                                    runs[0]["state"] == "cancelled",
                                    "Pause failed to cancel committed source run",
                                )
                    passed(
                        f"{action} versus source source_first={source_first} rollback={rollback}"
                    )

        # Admission uses the existing shared/exclusive key. Busy never drops an event.
        for rollback in (False, True):
            ids = fixture()
            w = workflow(ids, active=False)
            before = facts(ids)
            holder = session("starting", lifecycle(ids, w, "start", 2), hold=True)
            ready(holder)
            finished(session("source_refused", create(ids)), "AUTOMATION_STUDIO_BUSY")
            require(facts(ids) == before, "Busy source left partial data")
            release(holder, rollback)
            finished(session("explicit_source_retry", create(ids)))
            require(
                len(facts(ids)["runs"]) == (0 if rollback else 1),
                "Start commit boundary target mismatch",
            )
            passed(f"start admission first rollback={rollback}")
        ids = fixture()
        w = workflow(ids, active=False)
        holder = session("source_admission", create(ids), hold=True)
        ready(holder)
        finished(
            session("start_refused", lifecycle(ids, w, "start", 2)),
            "AUTOMATION_STUDIO_BUSY",
        )
        finished(
            session(
                "create_workflow_refused",
                call(
                    "create_automation_workflow_v1",
                    ids["studio"],
                    ids["actor"],
                    str(uuid4()),
                    "Other",
                    "",
                    graph(),
                    {},
                ),
            ),
            "AUTOMATION_STUDIO_BUSY",
        )
        release(holder)
        finished(session("start_retry", lifecycle(ids, w, "start", 2)))
        require(len(facts(ids)["runs"]) == 0, "Start backfilled source during pause")
        passed("source shared admission refuses create/start and never backfills")

        for kind in ("create", "patch", "follow_up"):
            for source_first in (False, True):
                for rollback in (False, True):
                    ids = fixture()
                    statement = (
                        create(ids)
                        if kind == "create"
                        else call(
                            "update_lead_atomic",
                            ids["studio"],
                            ids["actor"],
                            ids["lead"],
                            {"stage": "offer_sent"},
                        )
                        if kind == "patch"
                        else call(
                            "follow_up_lead_atomic",
                            ids["studio"],
                            ids["actor"],
                            ids["lead"],
                            str(uuid4()),
                            {"next_stage": "offer_sent"},
                        )
                    )
                    # Composite retained command results need JSON serialization for barriers.
                    if kind != "create":
                        statement = statement.replace(
                            "SELECT public.", "SELECT to_jsonb(public.", 1
                        ).replace(");", "));")
                    clear = f"SELECT public.clear_studio_operational_data_atomic('{ids['studio']}',false); SELECT '{{}}'::JSONB;"
                    before = facts(ids)
                    first = session(
                        "clear_first_owner",
                        statement if source_first else clear,
                        hold=True,
                    )
                    ready(first)
                    second = session(
                        "clear_second_owner", clear if source_first else statement
                    )
                    if source_first:
                        blocked(first, second)
                        release(first, rollback)
                        finished(second)
                        require(
                            not facts(ids)["leads"]
                            and len(facts(ids)["events"]) == (0 if rollback else 1),
                            "Clear lost or invented committed occurrence",
                        )
                    else:
                        finished(
                            second,
                            "AUTOMATION_STUDIO_BUSY"
                            if kind == "create"
                            else "LEAD_STUDIO_BUSY",
                        )
                        require(
                            facts(ids) == before,
                            "Clear TRY refusal left partial source facts",
                        )
                        release(first, rollback)
                        if rollback:
                            finished(
                                session("explicit_after_clear_rollback", statement)
                            )
                            require(
                                len(facts(ids)["events"]) == 1,
                                "Explicit retry after clear rollback failed",
                            )
                        else:
                            require(
                                not facts(ids)["leads"] and not facts(ids)["events"],
                                "Clear commit left source facts",
                            )
                    passed(
                        f"actual clear versus {kind} source_first={source_first} rollback={rollback}"
                    )

        # A matching target is held past the future boundary; the complete trial rejects.
        ids = fixture()
        w = workflow(ids, "trial.scheduled")
        holder = session(
            "last_workflow", lock_row("public.automation_workflows", w), hold=True
        )
        ready(holder)
        start = datetime.now(timezone.utc) + timedelta(seconds=1)
        req = {
            "starts_at": start.isoformat(),
            "ends_at": (start + timedelta(hours=1)).isoformat(),
            "timezone": "UTC",
        }
        before = facts(ids)
        waiter = session("trial_expiry", trial(ids, req=req))
        blocked(holder, waiter)
        time.sleep(max(0, (start - datetime.now(timezone.utc)).total_seconds()) + 0.1)
        release(holder)
        finished(waiter, "AUTOMATION_STATE_CONFLICT")
        require(facts(ids) == before, "Workflow wait expiry left a source fact")
        passed("trial expiry after final capture workflow lock rejects all writes")

        # Old run ownership is the last wait after the whole capture/invalidation union.
        ids = fixture()
        workflow(ids, "trial.scheduled")
        appointment = json.loads(sql("SET ROLE service_role;" + trial(ids)))["payload"][
            "id"
        ]
        run = facts(ids)["runs"][0]["id"]
        holder = session(
            "last_trial_run",
            lock_row("public.automation_workflow_runs", run),
            hold=True,
        )
        ready(holder)
        sql(
            f"UPDATE public.lead_trial_appointments SET starts_at=clock_timestamp()+interval '1 second',ends_at=clock_timestamp()+interval '1 hour' WHERE id='{appointment}';"
        )
        before = facts(ids)
        waiter = session(
            "trial_run_expiry", trial(ids, appointment, 1, {"location": "Changed"})
        )
        blocked(holder, waiter)
        time.sleep(1.2)
        release(holder)
        finished(waiter, "AUTOMATION_STATE_CONFLICT")
        require(
            facts(ids) == before, "Final run expiry left cancellation or new capture"
        )
        passed(
            "trial expiry after final invalidated run lock rolls back cancellation and capture"
        )

        for gate in ("workflow", "run"):
            ids = fixture()
            w = workflow(ids, "belt_test.approved")
            if gate == "run":
                recipient = json.loads(sql("SET ROLE service_role;" + approve(ids)))[
                    "payload"
                ]["items"][0]["id"]
                sql(
                    f"UPDATE public.belt_test_recipients SET state='revoked',revision=revision+1,revoked_at=clock_timestamp() WHERE id='{recipient}';"
                )
                held_table, held_id = (
                    "public.automation_workflow_runs",
                    facts(ids)["runs"][0]["id"],
                )
            else:
                held_table, held_id = "public.automation_workflows", w
            holder = session(
                "belt_last_" + gate, lock_row(held_table, held_id), hold=True
            )
            ready(holder)
            sql(
                f"UPDATE public.belt_test_events SET starts_at=clock_timestamp()+interval '1 second',ends_at=clock_timestamp()+interval '1 hour' WHERE id='{ids['event']}';"
            )
            before = facts(ids)
            waiter = session("belt_expiry", approve(ids))
            blocked(holder, waiter)
            time.sleep(1.2)
            release(holder)
            finished(waiter, "AUTOMATION_STATE_CONFLICT")
            require(
                facts(ids) == before, "Belt expiry left approval/capture/cancellation"
            )
            passed(f"belt expiry after last {gate} lock rejects all writes")

        # The source's studio-local hold date must be read after the final wait.
        ids = fixture()
        w = workflow(ids, "belt_test.approved")
        sql(
            f"UPDATE public.studios SET timezone='Etc/GMT+12' WHERE id='{ids['studio']}'; UPDATE public.students SET hold_start_date=(clock_timestamp() AT TIME ZONE 'Etc/GMT-14')::DATE WHERE id='{ids['student']}';"
        )
        holder = session(
            "hold_boundary", lock_row("public.automation_workflows", w), hold=True
        )
        ready(holder)
        before = facts(ids)
        waiter = session("held_approval", approve(ids))
        blocked(holder, waiter)
        sql(
            f"UPDATE public.studios SET timezone='Etc/GMT-14' WHERE id='{ids['studio']}';"
        )
        release(holder)
        finished(waiter, "AUTOMATION_STATE_CONFLICT")
        require(facts(ids) == before, "Final lock allowed currently held student")
        passed("fresh studio-local hold boundary after final capture lock")

        # Reproduce the rejected SHARE-all then UPDATE-one order as a real deadlock.
        ids = fixture()
        ws = sorted(
            [workflow(ids, "trial.scheduled"), workflow(ids, "trial.scheduled")]
        )
        share = f"SELECT 1 FROM public.leads WHERE id='{ids['lead']}' FOR UPDATE; SELECT 1 FROM public.automation_workflows WHERE id IN ({quote(ws[0])},{quote(ws[1])}) ORDER BY id FOR SHARE; SELECT '{{}}'::JSONB;"
        first = session("bad_order_a", share, hold=True)
        ready(first)
        other_lead = str(uuid4())
        sql(
            f"INSERT INTO public.leads(id,studio_id,first_name,last_name) VALUES('{other_lead}','{ids['studio']}','Other','Source');"
        )
        second = session(
            "bad_order_b", share.replace(ids["lead"], other_lead), hold=True
        )
        ready(second)
        continue_session(first, lock_row("public.automation_workflows", ws[0]))
        blocked(second, first)
        continue_session(second, lock_row("public.automation_workflows", ws[1]))
        for item in (first, second):
            item["process"].wait(timeout=25)
            for thread in item["threads"]:
                thread.join(timeout=2)
        errors = ["\n".join(item["errors"]) for item in (first, second)]
        require(
            sum("40P01" in e for e in errors) == 1
            and sum(item["process"].returncode == 0 for item in (first, second)) == 1,
            "Rejected lock-order counterexample not reproduced",
        )
        passed(
            "rejected two-source two-workflow SHARE-to-UPDATE order reproduces 40P01"
        )
        # Actual two-source commands lock that union at UPDATE once and serialize.
        for rollback in (False, True):
            left = json.loads(sql("SET ROLE service_role;" + trial(ids)))["payload"][
                "id"
            ]
            other = {**ids, "lead": other_lead}
            right = json.loads(sql("SET ROLE service_role;" + trial(other)))["payload"][
                "id"
            ]
            first = session(
                "good_union_a", trial(ids, left, 1, {"location": "First"}), hold=True
            )
            ready(first)
            second = session(
                "good_union_b", trial(other, right, 1, {"location": "Second"})
            )
            blocked(first, second)
            release(first, rollback)
            finished(second)
            require(
                sql(
                    f"SELECT revision FROM public.lead_trial_appointments WHERE id='{left}';"
                )
                == ("1" if rollback else "2"),
                "First source transaction mismatch",
            )
            require(
                sql(
                    f"SELECT revision FROM public.lead_trial_appointments WHERE id='{right}';"
                )
                == "2",
                "Second source lost update",
            )
            sql(
                f"UPDATE public.lead_trial_appointments SET status='canceled' WHERE id IN ('{left}','{right}');"
            )
            passed(
                f"actual two-source two-workflow final UPDATE union rollback={rollback}"
            )

        ids = fixture()
        ws = sorted(
            [workflow(ids, "belt_test.approved"), workflow(ids, "belt_test.approved")]
        )
        other_student = str(uuid4())
        sql(
            f"INSERT INTO public.students(id,studio_id,legal_first_name,legal_last_name,status,membership_start_date) VALUES('{other_student}','{ids['studio']}','Other','Approved','active',CURRENT_DATE-120);"
        )
        recipients = [{"student_id": ids["student"]}, {"student_id": other_student}]
        approved = json.loads(sql("SET ROLE service_role;" + approve(ids, recipients)))[
            "payload"
        ]["items"]
        # Keep only deliberately reversed old mappings as pending invalidation.
        sql(
            f"UPDATE public.automation_workflow_runs SET state='completed',next_due_at=NULL WHERE studio_id='{ids['studio']}';"
        )
        for recipient, wid in zip(
            sorted(approved, key=lambda r: r["id"]), reversed(ws)
        ):
            eid = str(uuid4())
            sql(f"""INSERT INTO private.automation_workflow_events(id,studio_id,event_type,source_key,subject_kind,subject_id,occurred_at)
VALUES('{eid}','{ids["studio"]}','belt_test.approved','reversed:{eid}','belt_test','{recipient["id"]}',clock_timestamp());
INSERT INTO public.automation_workflow_runs(studio_id,workflow_id,version_id,event_id,activation_id,epoch,current_node_id)
SELECT studio_id,workflow_id,version_id,'{eid}',id,epoch,'trigger' FROM public.automation_workflow_activations WHERE workflow_id='{wid}' AND retired_at IS NULL;
UPDATE public.belt_test_recipients SET state='revoked',revision=revision+1,revoked_at=clock_timestamp() WHERE id='{recipient["id"]}';""")
        holder = session(
            "reversed_low", lock_row("public.automation_workflows", ws[0]), hold=True
        )
        ready(holder)
        waiter = session("reversed_batch", approve(ids, recipients))
        blocked(holder, waiter)
        probe = session(
            "higher_unheld",
            "SET LOCAL lock_timeout='500ms';"
            + lock_row("public.automation_workflows", ws[1]),
        )
        finished(probe)
        release(holder)
        finished(waiter)
        state = facts(ids)
        require(
            sum(r["state"] == "cancelled" for r in state["runs"]) == 2
            and sum(r["state"] == "queued" for r in state["runs"]) == 4,
            "Reversed batch missed old cancellation or new targets",
        )
        passed(
            "reversed recipient mappings acquire global final-mode workflow union before runs"
        )

        # A transaction-bound packet is unusable after its acquiring transaction commits.
        ids = fixture()
        packet = json.loads(
            sql(
                f"SET ROLE service_role; SELECT private.workflow_prepare_capture_v1('{ids['studio']}');"
            )
        )
        event = {
            "event_type": "lead.created",
            "source_key": ids["lead"],
            "subject_kind": "lead",
            "subject_id": ids["lead"],
            "occurred_at": datetime.now(timezone.utc).isoformat(),
            "context": {"lead_id": ids["lead"], "program_id": None, "stage": "inquiry"},
        }
        finished(
            session(
                "old_transaction_packet",
                f"SELECT private.workflow_capture_events_v1({quote(ids['studio'])},{quote([event])},{quote(packet)});",
            ),
            "AUTOMATION_INVALID_REQUEST",
        )
        require(facts(ids)["events"] == [], "Stale transaction packet emitted an event")
        passed("committed transaction packet cannot be reused by another transaction")

        # A clone-only instrument rejects a backward explicit Auth acquisition.
        # Both definitions are restored in this transaction; production source is untouched.
        prepare_def = sql(
            "SELECT pg_get_functiondef('private.workflow_prepare_capture_v1(uuid,uuid[],boolean)'::regprocedure);"
        )
        actor_def = sql(
            "SELECT pg_get_functiondef('private.lock_student_import_actor(uuid)'::regprocedure);"
        )
        prepare_probe = prepare_def.replace(
            "RETURN jsonb_build_object('studio_id',p_studio_id",
            "PERFORM set_config('koaryu.capture_prepared_probe','true',true);\n    RETURN jsonb_build_object('studio_id',p_studio_id",
        )
        actor_probe = actor_def.replace(
            "BEGIN\n",
            "BEGIN\n    IF current_setting('koaryu.capture_prepared_probe',true)='true' THEN RAISE EXCEPTION 'LATE_AUTH_PARENT'; END IF;\n",
            1,
        )
        require(
            prepare_probe != prepare_def and actor_probe != actor_def,
            "Ownership probe instrumentation did not bind",
        )
        ids = fixture()
        workflow(ids, "lead.stage_changed")
        statements = [
            create(ids),
            call(
                "update_lead_atomic",
                ids["studio"],
                ids["actor"],
                ids["lead"],
                {"stage": "offer_sent"},
            ),
            call(
                "follow_up_lead_atomic",
                ids["studio"],
                ids["actor"],
                ids["lead"],
                str(uuid4()),
                {"next_stage": "trial_completed"},
            ),
            trial(ids),
            approve(ids),
        ]
        for statement in statements:
            sql(
                "BEGIN;"
                + prepare_probe
                + ";"
                + actor_probe
                + ";"
                + "SET LOCAL ROLE service_role;"
                + statement
                + "RESET ROLE;"
                + prepare_def
                + ";"
                + actor_def
                + ";"
                + "COMMIT;"
            )
        require(
            sql(
                "SELECT pg_get_functiondef('private.lock_student_import_actor(uuid)'::regprocedure);"
            )
            == actor_def,
            "Auth probe was not restored",
        )
        passed(
            "actual create PATCH nested follow-up trial and approval acquire no late Auth helper after preparation"
        )

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
            "Complete V57 migration history differs",
        )
        passed("151 historical migration hashes and history unchanged")
    finally:
        for item in children:
            process = item["process"]
            if process.poll() is None:
                process.kill()
                process.wait(timeout=5)
            for thread in item["threads"]:
                thread.join(timeout=2)
            for stream in (process.stdin, process.stdout, process.stderr):
                if stream and not stream.closed:
                    stream.close()
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
            print(f"[domain capture] cleaned {database}", flush=True)
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
