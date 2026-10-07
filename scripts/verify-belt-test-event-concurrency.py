#!/usr/bin/env python3
"""Verify belt-test event transactions on a unique guarded local PG17 clone.

The PM owns the untouched V56 base. This script applies the partial V57 only to
its own disposable clone, uses synthetic records and never sends external mail.
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
from app.schemas.belt_test import BeltTestEventCreate, BeltTestEventUpdate
from app.schemas.belt_test_recipient import BeltTestRecipientResponse
from app.services.belt_test_service import (
    BeltTestEventMutationResult,
    BeltTestService,
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
    database = f"koaryu_belt_events_{os.getpid()}_{uuid4().hex[:10]}"
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
            for key in (
                "actor",
                "owner",
                "studio",
                "program",
                "ladder",
                "student",
                "operation",
                "recipient",
            )
        }
        sql(f"""BEGIN;
INSERT INTO auth.users(id,email,email_confirmed_at) VALUES('{ids["actor"]}','{ids["actor"]}@example.invalid',clock_timestamp()),('{ids["owner"]}','{ids["owner"]}@example.invalid',clock_timestamp());
INSERT INTO public.studios(id,name,slug,owner_id,timezone) VALUES('{ids["studio"]}','Belt race','{ids["studio"]}','{ids["owner"]}','UTC');
INSERT INTO public.staff_roles(studio_id,user_id,role) VALUES('{ids["studio"]}','{ids["actor"]}','admin'),('{ids["studio"]}','{ids["owner"]}','admin');
INSERT INTO public.studio_subscriptions(studio_id,status,comped) VALUES('{ids["studio"]}','active',false);
INSERT INTO public.programs(id,studio_id,name) VALUES('{ids["program"]}','{ids["studio"]}','Program');
INSERT INTO public.belt_ladders(id,studio_id,name,program_id) VALUES('{ids["ladder"]}','{ids["studio"]}','Ladder','{ids["program"]}');
INSERT INTO public.students(id,studio_id,legal_first_name,legal_last_name) VALUES('{ids["student"]}','{ids["studio"]}','Synthetic','Recipient');
COMMIT;""")
        return ids

    def request(ids, start=None):
        start = start or datetime.now(timezone.utc) + timedelta(days=7)
        return {
            "name": "Belt day",
            "ladder_id": ids["ladder"],
            "starts_at": start.isoformat(),
            "ends_at": (start + timedelta(hours=1)).isoformat(),
            "timezone": "UTC",
            "status": "scheduled",
            "location": "",
        }

    def mutate(ids, req, operation=None, revision=None, event=None):
        return (
            "SELECT public.mutate_belt_test_event_v1("
            + ",".join(
                map(
                    quote,
                    (
                        ids["studio"],
                        ids["actor"],
                        event,
                        operation or str(uuid4()),
                        revision,
                        req,
                    ),
                )
            )
            + ");"
        )

    def provision(ids):
        value = json.loads(sql("SET ROLE service_role;" + mutate(ids, request(ids))))
        BeltTestEventMutationResult.model_validate(value)
        ids["event"] = value["payload"]["id"]
        return value

    def edit(ids, req, revision=1, operation=None):
        return mutate(
            ids, req, operation=operation, revision=revision, event=ids["event"]
        )

    def facts(ids):
        return json.loads(
            sql(f"""SELECT jsonb_build_object(
'events',(SELECT count(*) FROM public.belt_test_events WHERE studio_id='{ids["studio"]}'),
'audits',(SELECT count(*) FROM public.audit_logs WHERE studio_id='{ids["studio"]}' AND action LIKE 'belt_test.%'),
'receipts',(SELECT count(*) FROM private.automation_command_operations WHERE studio_id='{ids["studio"]}' AND command LIKE 'belt_test.%'),
'revision',(SELECT max(revision) FROM public.belt_test_events WHERE studio_id='{ids["studio"]}'),
'schedule_revision',(SELECT max(schedule_revision) FROM public.belt_test_events WHERE studio_id='{ids["studio"]}'))""")
        )

    def session(name, statement, hold=False, role="service_role"):
        name = f"belt_events_{os.getpid()}_{name}"[:63]
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
        print(f"[belt events] PASS {name}", flush=True)

    def continue_session(item, statement, expected_error=None):
        item["lines"].clear()
        item["process"].stdin.write(statement + "\nCOMMIT;\n")
        item["process"].stdin.close()
        return finished(item, expected_error)

    def seed_recipient(ids):
        sql(f"""INSERT INTO public.belt_test_recipients(id,studio_id,event_id,student_id,approved_schedule_revision,approved_rank_context_generation,
approved_current_rank_id,approved_target_rank_id,state,approved_by,approved_at)
VALUES('{ids["recipient"]}','{ids["studio"]}','{ids["event"]}','{ids["student"]}',1,private.workflow_rank_context_generation_v1('{ids["studio"]}','{ids["student"]}',NULL),NULL,'{uuid4()}','approved','{ids["actor"]}',clock_timestamp());""")
        return BeltTestRecipientResponse.model_validate(
            json.loads(
                sql(
                    f"SELECT private.belt_test_recipient_payload_v1(b) FROM public.belt_test_recipients b WHERE id='{ids['recipient']}';"
                )
            )
        )

    def workflow_command(ids, action, revision):
        return (
            "SELECT public.command_automation_workflow_v1("
            + ",".join(
                map(
                    quote,
                    (
                        ids["studio"],
                        ids["actor"],
                        ids["workflow"],
                        str(uuid4()),
                        revision,
                        action,
                    ),
                )
            )
            + ");"
        )

    def seed_run(ids):
        graph = {
            "schema_version": 1,
            "nodes": [
                {
                    "id": "start",
                    "type": "trigger",
                    "config": {
                        "event_type": "belt_test.approved",
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
                            "Belt race",
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
VALUES('{event}','{ids["studio"]}','belt_test.approved','synthetic-proof','belt_test','{ids["recipient"]}',clock_timestamp());
INSERT INTO public.automation_workflow_runs(id,studio_id,workflow_id,version_id,event_id,activation_id,epoch,current_node_id,state,claim_token,lease_expires_at)
SELECT '{ids["run"]}',studio_id,workflow_id,version_id,'{event}',id,epoch,'start','claimed',gen_random_uuid(),clock_timestamp()+interval '1 minute'
FROM public.automation_workflow_activations WHERE workflow_id='{ids["workflow"]}' AND retired_at IS NULL;""")

    def source_claim(ids):
        # Test-only stand-in for the later begin command. It owns source facts
        # before workflow/run rows, then rechecks the captured approval revision.
        return f"""DO $proof$ BEGIN
PERFORM 1 FROM public.belt_test_events WHERE id='{ids["event"]}' FOR UPDATE;
PERFORM 1 FROM public.students WHERE id='{ids["student"]}' FOR UPDATE;
PERFORM 1 FROM public.belt_test_recipients WHERE id='{ids["recipient"]}' FOR UPDATE;
PERFORM 1 FROM public.automation_workflows WHERE id='{ids["workflow"]}' FOR UPDATE;
PERFORM 1 FROM public.automation_workflow_runs WHERE id='{ids["run"]}' FOR UPDATE;
IF EXISTS(SELECT 1 FROM public.belt_test_events e JOIN public.belt_test_recipients b ON b.event_id=e.id
WHERE e.id='{ids["event"]}' AND e.status='scheduled' AND e.starts_at>clock_timestamp()
AND b.id='{ids["recipient"]}' AND b.state='approved' AND b.revision=1 AND b.approved_schedule_revision=e.schedule_revision) THEN
 UPDATE public.automation_workflow_runs SET state='sending',next_due_at=NULL WHERE id='{ids["run"]}' AND state='claimed';
END IF;
END $proof$; SELECT '{{}}'::jsonb;"""

    class SQLRPC:
        """Pass the accepted service's exact RPC arguments through real local SQL."""

        def rpc(self, name, params):
            require(
                name
                in {
                    "mutate_belt_test_event_v1",
                    "list_belt_test_events_v1",
                    "get_belt_test_event_v1",
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
            "belt_test_event_contract.sql",
        ):
            output = sql((ROOT / "supabase/verification" / contract).read_text())
            passed(contract, result=output.strip())

        ids = fixture()
        service = BeltTestService(SQLRPC())
        request_model = BeltTestEventCreate(
            operation_id=uuid4(), **{**request(ids), "name": "\t\u00a0Belt day\u3000"}
        )
        created = service.create(ids["studio"], ids["actor"], request_model)
        require(
            created.payload.name == "Belt day"
            and created.payload.revision == created.payload.schedule_revision == 1,
            "Actual service create mismatch",
        )
        ids["event"] = str(created.payload.id)
        require(
            service.get(ids["studio"], ids["actor"], ids["event"]) == created.payload,
            "Actual service detail mismatch",
        )
        page = service.list(ids["studio"], ids["actor"])
        require(
            page.items == [created.payload]
            and not page.has_more
            and page.next_cursor is None,
            "Actual service list mismatch",
        )
        recipient = seed_recipient(ids)
        require(
            recipient.state == "approved"
            and recipient.student_program_membership_id is None,
            "Recipient DTO differs",
        )
        changed = service.update(
            ids["studio"],
            ids["actor"],
            ids["event"],
            BeltTestEventUpdate(
                operation_id=uuid4(), expected_revision=1, location="Gym"
            ),
        )
        require(
            changed.payload.schedule_revision == 2 and changed.payload.revision == 2,
            "Actual service update mismatch",
        )
        revoked = BeltTestRecipientResponse.model_validate(
            json.loads(
                sql(
                    f"SELECT private.belt_test_recipient_payload_v1(b) FROM public.belt_test_recipients b WHERE id='{ids['recipient']}';"
                )
            )
        )
        require(
            revoked.state == "revoked"
            and revoked.revision == 2
            and revoked.approved_target_rank_id == recipient.approved_target_rank_id,
            "Revoked recipient DTO differs",
        )
        # Check the exact Unicode set used by Pydantic, not locale-dependent SQL regex.
        whitespace = [
            9,
            10,
            11,
            12,
            13,
            32,
            133,
            160,
            5760,
            *range(8192, 8203),
            8232,
            8233,
            8239,
            8287,
            12288,
        ]
        for point in whitespace:
            model = BeltTestEventCreate(
                operation_id=uuid4(),
                **{**request(ids), "name": chr(point) + "Name" + chr(point)},
            )
            direct = json.loads(
                sql(
                    "SET ROLE service_role;"
                    + mutate(
                        ids, {**request(ids), "name": chr(point) + "Name" + chr(point)}
                    )
                )
            )
            require(
                direct["payload"]["name"] == model.name == "Name",
                "Unicode trim mismatch",
            )
        passed(
            "actual accepted event service and recipient DTO plus Unicode whitespace parity"
        )
        first_page = service.list(ids["studio"], ids["actor"], limit=1)
        second_page = service.list(
            ids["studio"], ids["actor"], limit=1, cursor=first_page.next_cursor
        )
        require(
            first_page.has_more and first_page.items[0].id != second_page.items[0].id,
            "Actual service keyset cursor failed",
        )
        req, op = request(ids), str(uuid4())
        original = json.loads(
            sql(
                "SET TIME ZONE 'Pacific/Kiritimati'; SET ROLE service_role;"
                + mutate(ids, req, operation=op)
            )
        )
        equivalent = {
            **req,
            **{
                key: datetime.fromisoformat(req[key])
                .astimezone(timezone(timedelta(hours=-7)))
                .isoformat()
                for key in ("starts_at", "ends_at")
            },
        }
        replay = json.loads(
            sql(
                "SET TIME ZONE 'America/Los_Angeles'; SET ROLE service_role;"
                + mutate(ids, equivalent, operation=op)
            )
        )
        require(
            replay == {**original, "replayed": True}, "UTC normalized replay differs"
        )
        passed("actual service keyset and session independent timestamp replay")

        for rollback in (False, True):
            ids = fixture()
            statement = mutate(ids, request(ids), operation=ids["operation"])
            first = session("same_operation_owner", statement, hold=True)
            original = ready(first)
            second = session("same_operation_competitor", statement)
            evidence = blocked(first, second, advisory=True)
            release(first, rollback=rollback)
            replay = finished(second)
            require(
                replay["replayed"] is (not rollback), "Same operation replay flag wrong"
            )
            if not rollback:
                require(
                    replay["payload"] == original["payload"],
                    "Lost exact creation replay",
                )
            state = facts(ids)
            require(
                state["events"] == state["audits"] == state["receipts"] == 1,
                "Creation replay duplicated facts",
            )
            passed(f"same operation create rollback={rollback}", blocking=evidence)

            ids = fixture()
            provision(ids)
            first = session("CAS_owner", edit(ids, {"location": "Owner"}), hold=True)
            ready(first)
            second = session("CAS_competitor", edit(ids, {"location": "Competitor"}))
            evidence = blocked(first, second)
            release(first, rollback=rollback)
            finished(second, None if rollback else "AUTOMATION_REVISION_CONFLICT")
            state = facts(ids)
            require(
                state["revision"] == 2 and state["audits"] == state["receipts"] == 2,
                "CAS accepted multiple winners",
            )
            passed(f"same revision competition rollback={rollback}", blocking=evidence)

        for rename_first in (False, True):
            for rollback in (False, True):
                ids = fixture()
                provision(ids)
                seed_recipient(ids)
                rename, reschedule = (
                    edit(ids, {"name": "Corrected"}),
                    edit(ids, {"location": "Gym"}),
                )
                first = session(
                    "name_schedule_owner",
                    rename if rename_first else reschedule,
                    hold=True,
                )
                ready(first)
                second = session(
                    "name_schedule_waiter", reschedule if rename_first else rename
                )
                evidence = blocked(first, second)
                release(first, rollback=rollback)
                finished(second, None if rollback else "AUTOMATION_REVISION_CONFLICT")
                rescheduled = rename_first == rollback
                require(
                    facts(ids)["schedule_revision"] == (2 if rescheduled else 1),
                    "Name race changed schedule incorrectly",
                )
                require(
                    sql(
                        f"SELECT state FROM public.belt_test_recipients WHERE id='{ids['recipient']}';"
                    )
                    == ("revoked" if rescheduled else "approved"),
                    "Name race approval wrong",
                )
                passed(
                    f"name versus schedule rename_first={rename_first} rollback={rollback}",
                    blocking=evidence,
                )

        for mutation in (
            "program_archive",
            "program_delete",
            "ladder_delete",
            "ladder_detach",
        ):
            for command_first in (False, True):
                for rollback in (False, True):
                    ids = fixture()
                    provision(ids)
                    change = {
                        "program_archive": f"UPDATE public.programs SET archived_at=clock_timestamp() WHERE id='{ids['program']}';",
                        "program_delete": f"DELETE FROM public.programs WHERE id='{ids['program']}';",
                        "ladder_delete": f"DELETE FROM public.belt_ladders WHERE id='{ids['ladder']}';",
                        "ladder_detach": f"UPDATE public.belt_ladders SET program_id=NULL WHERE id='{ids['ladder']}';",
                    }[mutation] + " SELECT '{}'::jsonb;"
                    command = edit(
                        ids, {"name": "Current context"}, operation=ids["operation"]
                    )
                    first = session(
                        "reference_owner",
                        command if command_first else change,
                        hold=True,
                        role="postgres",
                    )
                    ready(first)
                    second = session(
                        "reference_competitor",
                        change if command_first else command,
                        role="postgres",
                    )
                    if command_first:
                        evidence = blocked(first, second)
                        release(first, rollback=rollback)
                        finished(second)
                    else:
                        finished(second, "AUTOMATION_STUDIO_BUSY")
                        require(
                            facts(ids)["revision"] == facts(ids)["receipts"] == 1,
                            "NOWAIT left writes",
                        )
                        evidence = {"outcome": "NOWAIT busy"}
                        release(first, rollback=rollback)
                        finished(
                            session("reference_retry", command),
                            None
                            if rollback
                            else (
                                "AUTOMATION_NOT_FOUND"
                                if mutation == "ladder_delete"
                                else "AUTOMATION_STATE_CONFLICT"
                            ),
                        )
                    expected_revision = 2 if (command_first != rollback) else 1
                    require(
                        facts(ids)["revision"] == expected_revision,
                        "Reference contention changed wrong revision",
                    )
                    # Even a committed parent removal retains the original program and ladder IDs.
                    require(
                        json.loads(
                            sql(
                                f"SELECT jsonb_build_object('program',program_id,'ladder',ladder_id) FROM public.belt_test_events WHERE id='{ids['event']}';"
                            )
                        )
                        == {"program": ids["program"], "ladder": ids["ladder"]},
                        "Parent change rewrote logical snapshot",
                    )
                    finished(
                        session(
                            "cancel_deleted_context",
                            edit(
                                ids, {"status": "canceled"}, revision=expected_revision
                            ),
                        )
                    )
                    passed(
                        f"{mutation} command_first={command_first} rollback={rollback}",
                        blocking=evidence,
                    )

        for command_first in (False, True):
            for rollback in (False, True):
                ids = fixture()
                provision(ids)
                command = edit(ids, {"location": "Clear race"})
                clear = f"SELECT public.clear_studio_operational_data_atomic('{ids['studio']}',false); SELECT '{{}}'::jsonb;"
                first = session(
                    "clear_owner",
                    command if command_first else clear,
                    hold=True,
                    role="postgres",
                )
                ready(first)
                second = session(
                    "clear_competitor",
                    clear if command_first else command,
                    role="postgres",
                )
                if command_first:
                    evidence = blocked(first, second, advisory=True)
                    release(first, rollback=rollback)
                    finished(second)
                else:
                    finished(second, "AUTOMATION_STUDIO_BUSY")
                    require(
                        facts(ids)["revision"] == facts(ids)["receipts"] == 1,
                        "Clear busy left writes",
                    )
                    evidence = {"outcome": "shared clear try-gate busy"}
                    release(first, rollback=rollback)
                    finished(
                        session("clear_retry", command),
                        None if rollback else "AUTOMATION_NOT_FOUND",
                    )
                expected_revision = 2 if (command_first != rollback) else 1
                require(
                    facts(ids)["revision"] == expected_revision,
                    "Clear race revision wrong",
                )
                passed(
                    f"actual clear command_first={command_first} rollback={rollback}",
                    blocking=evidence,
                )

        for command_first in (False, True):
            for rollback in (False, True):
                ids = fixture()
                provision(ids)
                seed_recipient(ids)
                seed_run(ids)
                command, claim = edit(ids, {"location": "Changed"}), source_claim(ids)
                first = session(
                    "source_owner", command if command_first else claim, hold=True
                )
                ready(first)
                second = session(
                    "source_competitor", claim if command_first else command
                )
                evidence = blocked(first, second)
                release(first, rollback=rollback)
                finished(second)
                # If begin committed first its sending attempt cannot be recalled.
                sending = command_first == rollback
                require(
                    sql(
                        f"SELECT state FROM public.automation_workflow_runs WHERE id='{ids['run']}';"
                    )
                    == ("sending" if sending else "cancelled"),
                    "Source-before-run race has stale result",
                )
                passed(
                    f"synthetic recipient begin command_first={command_first} rollback={rollback}",
                    blocking=evidence,
                )

        for outcome in ("schedule", "complete"):
            ids = fixture()
            provision(ids)
            future = datetime.now(timezone.utc) + timedelta(seconds=2)
            first = session(
                "event_clock_owner",
                f"SELECT to_jsonb(e) FROM public.belt_test_events e WHERE id='{ids['event']}' FOR UPDATE;",
                hold=True,
            )
            ready(first)
            if outcome == "schedule":
                statement = edit(
                    ids,
                    {
                        "starts_at": future.isoformat(),
                        "ends_at": (future + timedelta(hours=1)).isoformat(),
                    },
                )
            else:
                # Change the fixture's clock inside the holder; the waiter sees it
                # only after the observed event lock releases.
                first["process"].stdin.write(
                    f"UPDATE public.belt_test_events SET starts_at={quote(future.isoformat())},ends_at={quote((future + timedelta(hours=1)).isoformat())} WHERE id='{ids['event']}';\n"
                )
                first["process"].stdin.flush()
                statement = edit(ids, {"status": "completed"})
            second = session("event_clock_waiter", statement)
            evidence = blocked(first, second)
            while datetime.now(timezone.utc) <= future + timedelta(milliseconds=80):
                time.sleep(0.03)
            release(first)
            finished(
                second, "AUTOMATION_STATE_CONFLICT" if outcome == "schedule" else None
            )
            require(
                facts(ids)["revision"] == (1 if outcome == "schedule" else 2),
                "Event clock used transaction time",
            )
            passed(f"{outcome} rechecks clock after event lock", blocking=evidence)

        ids = fixture()
        provision(ids)
        seed_recipient(ids)
        seed_run(ids)
        future = datetime.now(timezone.utc) + timedelta(seconds=2)
        first = session(
            "final_run_owner",
            f"SELECT to_jsonb(r) FROM public.automation_workflow_runs r WHERE id='{ids['run']}' FOR UPDATE;",
            hold=True,
        )
        ready(first)
        second = session(
            "final_run_waiter",
            edit(
                ids,
                {
                    "starts_at": future.isoformat(),
                    "ends_at": (future + timedelta(hours=1)).isoformat(),
                },
            ),
        )
        evidence = blocked(first, second)
        # Observe event and recipient ownership while the command is at its final run wait.
        for relation, identity in (
            ("belt_test_events", ids["event"]),
            ("belt_test_recipients", ids["recipient"]),
            ("automation_workflows", ids["workflow"]),
        ):
            finished(
                session(
                    "ownership_probe",
                    f"SELECT to_jsonb(x) FROM public.{relation} x WHERE id='{identity}' FOR UPDATE NOWAIT;",
                ),
                "55P03",
            )
        while datetime.now(timezone.utc) <= future + timedelta(milliseconds=80):
            time.sleep(0.03)
        release(first)
        finished(second, "AUTOMATION_STATE_CONFLICT")
        require(
            facts(ids)["revision"]
            == facts(ids)["audits"]
            == facts(ids)["receipts"]
            == 1,
            "Final run clock failure left event audit receipt",
        )
        require(
            sql(
                f"SELECT state='approved' AND revision=1 FROM public.belt_test_recipients WHERE id='{ids['recipient']}';"
            )
            == "t",
            "Final run clock failure revoked approval",
        )
        require(
            sql(
                f"SELECT state='claimed' AND claim_token IS NOT NULL FROM public.automation_workflow_runs WHERE id='{ids['run']}';"
            )
            == "t",
            "Final run clock failure cancelled claim",
        )
        passed(
            "clock after final run lock rolls back event approval audit receipt and claim",
            blocking=evidence,
        )

        ids = fixture()
        provision(ids)
        first = session(
            "list_owner", edit(ids, {"name": "Uncommitted name"}), hold=True
        )
        ready(first)
        observed = service.list(ids["studio"], ids["actor"], limit=1)
        require(
            observed.items[0].name == "Belt day" and observed.items[0].revision == 1,
            "List mixed row snapshots",
        )
        release(first)
        observed = service.list(ids["studio"], ids["actor"], limit=1)
        require(
            observed.items[0].name == "Uncommitted name"
            and observed.items[0].revision == 2,
            "List missed committed row",
        )
        passed("list uses one coherent row snapshot during concurrent edit")

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
            print(f"[belt events] cleaned {database}", flush=True)
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
