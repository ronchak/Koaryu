#!/usr/bin/env python3
"""Exercise explicit recipient commands against real owners in a guarded PG17 clone."""

import hashlib
import json
import os
import queue
import subprocess
import sys
import threading
import time
from pathlib import Path
from uuid import uuid4

from local_postgres_verification import LocalPostgres, require, install_final_v57

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = (
    ROOT / "supabase/migrations/20261005105341_automation_workflow_graph_v57.sql"
)


def quote(value):
    if value is None:
        return "NULL"
    if isinstance(value, (dict, list)):
        value = json.dumps(value, separators=(",", ":"))
    return "'" + str(value).replace("'", "''") + "'"


def main(arguments):
    require(len(arguments) == 3, "Expected psql socket port")
    psql, socket, port = arguments
    local = LocalPostgres(psql, socket, port, str(Path(socket).parent))
    database = f"koaryu_belt_recipients_{os.getpid()}_{uuid4().hex[:10]}"
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
                "membership",
                "rank0",
                "rank1",
                "rank2",
                "session",
                "attendance",
                "event",
            )
        }
        sql(f"""BEGIN;
INSERT INTO auth.users(id,email,email_confirmed_at) VALUES('{ids["actor"]}','{ids["actor"]}@example.invalid',clock_timestamp()),('{ids["owner"]}','{ids["owner"]}@example.invalid',clock_timestamp());
INSERT INTO public.studios(id,name,slug,owner_id,timezone) VALUES('{ids["studio"]}','Recipient race','{ids["studio"]}','{ids["owner"]}','UTC');
INSERT INTO public.staff_roles(studio_id,user_id,role) VALUES('{ids["studio"]}','{ids["actor"]}','admin'),('{ids["studio"]}','{ids["owner"]}','admin');
INSERT INTO public.studio_subscriptions(studio_id,status,comped) VALUES('{ids["studio"]}','active',false);
INSERT INTO public.programs(id,studio_id,name) VALUES('{ids["program"]}','{ids["studio"]}','Program');
INSERT INTO public.programs(studio_id,name,is_system) SELECT '{ids["studio"]}','Unassigned',true WHERE NOT EXISTS(SELECT 1 FROM public.programs WHERE studio_id='{ids["studio"]}' AND is_system AND lower(name)='unassigned');
INSERT INTO public.belt_ladders(id,studio_id,name,program_id) VALUES('{ids["ladder"]}','{ids["studio"]}','Ladder','{ids["program"]}');
INSERT INTO public.belt_ranks(id,studio_id,ladder_id,name,display_order,min_classes,requires_approval) VALUES
('{ids["rank0"]}','{ids["studio"]}','{ids["ladder"]}','First',0,0,false),
('{ids["rank1"]}','{ids["studio"]}','{ids["ladder"]}','Next',1,1,true),
('{ids["rank2"]}','{ids["studio"]}','{ids["ladder"]}','Last',2,1,false);
UPDATE public.belt_ranks SET created_at=clock_timestamp()-interval '3 days'+display_order*interval '1 day' WHERE ladder_id='{ids["ladder"]}';
INSERT INTO public.students(id,studio_id,legal_first_name,legal_last_name,status,program_id,current_belt_rank_id,membership_start_date)
VALUES('{ids["student"]}','{ids["studio"]}','Synthetic','Recipient','active','{ids["program"]}','{ids["rank0"]}',CURRENT_DATE-120);
INSERT INTO public.student_program_memberships(id,studio_id,student_id,program_id,status,started_at,current_belt_rank_id)
VALUES('{ids["membership"]}','{ids["studio"]}','{ids["student"]}','{ids["program"]}','active',CURRENT_DATE-120,'{ids["rank0"]}');
INSERT INTO public.class_sessions(id,studio_id,name,date,start_time,end_time,program_id,status)
VALUES('{ids["session"]}','{ids["studio"]}','Class',CURRENT_DATE-1,'10:00','11:00','{ids["program"]}','completed');
INSERT INTO public.attendance(id,studio_id,session_id,student_id,status,checked_in_at)
VALUES('{ids["attendance"]}','{ids["studio"]}','{ids["session"]}','{ids["student"]}','present',clock_timestamp()-interval '1 day');
INSERT INTO public.belt_test_events(id,studio_id,name,ladder_id,program_id,starts_at,ends_at,timezone,status)
VALUES('{ids["event"]}','{ids["studio"]}','Test','{ids["ladder"]}','{ids["program"]}',clock_timestamp()+interval '7 days',clock_timestamp()+interval '7 days 1 hour','UTC','scheduled');
COMMIT;""")
        return ids

    def approve(ids, operation=None, revision=1, recipients=None):
        recipients = recipients or [
            {
                "student_id": ids["student"],
                "student_program_membership_id": ids["membership"],
            }
        ]
        return (
            "SELECT public.approve_belt_test_recipients_v1("
            + ",".join(
                map(
                    quote,
                    (
                        ids["studio"],
                        ids["actor"],
                        ids["event"],
                        operation or str(uuid4()),
                        revision,
                        recipients,
                    ),
                )
            )
            + ");"
        )

    def revoke(ids, operation=None, revision=1):
        return (
            "SELECT public.revoke_belt_test_recipient_v1("
            + ",".join(
                map(
                    quote,
                    (
                        ids["studio"],
                        ids["actor"],
                        ids["event"],
                        ids["recipient"],
                        operation or str(uuid4()),
                        revision,
                    ),
                )
            )
            + ");"
        )

    def facts(ids):
        return json.loads(
            sql(f"""SELECT jsonb_build_object(
'recipients',(SELECT COALESCE(jsonb_agg(to_jsonb(b) ORDER BY b.id),'[]'::jsonb) FROM public.belt_test_recipients b WHERE studio_id='{ids["studio"]}'),
'audits',(SELECT count(*) FROM public.audit_logs WHERE studio_id='{ids["studio"]}' AND action LIKE 'belt_test.%'),
'receipts',(SELECT count(*) FROM private.automation_command_operations WHERE studio_id='{ids["studio"]}' AND command IN ('belt_test.approve','belt_test.revoke')),
'event_revision',(SELECT revision FROM public.belt_test_events WHERE id='{ids["event"]}'))""")
        )

    def session(name, statement, hold=False, role="service_role"):
        name = f"belt_recipients_{os.getpid()}_{name}"[:63]
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
        item["process"].stdout.close()
        item["process"].stderr.close()
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
        print(f"[belt recipients] PASS {name}", flush=True)

    def continue_session(item, statement, expected_error=None):
        item["lines"].clear()
        item["process"].stdin.write(statement + "\nCOMMIT;\n")
        item["process"].stdin.close()
        return finished(item, expected_error)

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

    def source(ids, kind):
        marker = "SELECT '{\"owner\":true}'::jsonb;"
        if kind == "rank_insert":
            ids["inserted_rank"] = str(uuid4())
            statement = f"INSERT INTO public.belt_ranks(id,studio_id,ladder_id,name,display_order,is_tip,min_classes) VALUES('{ids['inserted_rank']}','{ids['studio']}','{ids['ladder']}','Tip',0,true,0);"
        elif kind == "rank_reorder":
            statement = f"UPDATE public.belt_ranks SET display_order=0 WHERE id='{ids['rank2']}';"
        elif kind == "rank_requirement":
            statement = (
                f"UPDATE public.belt_ranks SET min_classes=2 WHERE id='{ids['rank1']}';"
            )
        elif kind == "rank_transition":
            statement = (
                "SELECT public.record_student_rank_transition_v3("
                + ",".join(
                    map(
                        quote,
                        (
                            ids["studio"],
                            ids["student"],
                            ids["membership"],
                            ids["program"],
                            ids["rank1"],
                            ids["actor"],
                            None,
                            "promotion",
                            str(uuid4()),
                        ),
                    )
                )
                + ");"
            )
        elif kind == "sync_assigned_delete":
            ranks = [
                {
                    "id": ids[k],
                    "name": k,
                    "color_hex": "#ffffff",
                    "min_classes": 1,
                    "min_months": 0,
                    "requires_approval": False,
                    "is_tip": False,
                }
                for k in ("rank1", "rank2")
            ]
            statement = (
                "SELECT id FROM public.sync_belt_ladder_ranks_v2("
                + ",".join(
                    map(
                        quote,
                        (
                            ids["ladder"],
                            ids["studio"],
                            ids["actor"],
                            str(uuid4()),
                            "Stripe",
                            ranks,
                        ),
                    )
                )
                + ");"
            )
        elif kind == "membership_remove":
            statement = (
                "SELECT public.mutate_student_program_membership_atomic("
                + ",".join(
                    map(
                        quote,
                        (
                            ids["student"],
                            ids["studio"],
                            ids["actor"],
                            "remove",
                            ids["membership"],
                            {},
                        ),
                    )
                )
                + ");"
            )
        elif kind == "program_archive":
            statement = f"UPDATE public.programs SET archived_at=clock_timestamp() WHERE id='{ids['program']}';"
        elif kind == "ladder_detach":
            statement = f"UPDATE public.belt_ladders SET program_id=NULL WHERE id='{ids['ladder']}';"
        elif kind == "attendance_delete":
            statement = f"DELETE FROM public.attendance WHERE id='{ids['attendance']}';"
        elif kind == "attendance_credit":
            statement = f"UPDATE public.attendance SET counts_toward_eligibility=false WHERE id='{ids['attendance']}';"
        elif kind == "attendance_upsert":
            statement = f"INSERT INTO public.attendance(studio_id,session_id,student_id,status) VALUES('{ids['studio']}','{ids['session']}','{ids['student']}','absent') ON CONFLICT(session_id,student_id) DO UPDATE SET status=EXCLUDED.status;"
        elif kind == "attendance_insert":
            statement = f"INSERT INTO public.class_sessions(id,studio_id,name,date,start_time,end_time,program_id,status) VALUES('{ids['session2']}','{ids['studio']}','New',CURRENT_DATE,'10:00','11:00','{ids['program']}','completed'); INSERT INTO public.attendance(studio_id,session_id,student_id,status) VALUES('{ids['studio']}','{ids['session2']}','{ids['student']}','present');"
        elif kind == "session_cancel":
            statement = f"UPDATE public.class_sessions SET status='canceled' WHERE id='{ids['session']}';"
        elif kind == "session_delete":
            statement = f"UPDATE public.class_sessions SET status='canceled',deleted_at=clock_timestamp() WHERE id='{ids['session']}';"
        elif kind == "event_reschedule":
            statement = (
                "SELECT public.mutate_belt_test_event_v1("
                + ",".join(
                    map(
                        quote,
                        (
                            ids["studio"],
                            ids["actor"],
                            ids["event"],
                            str(uuid4()),
                            1,
                            {"location": "Changed"},
                        ),
                    )
                )
                + ");"
            )
            return statement
        else:
            raise RuntimeError(f"Unknown owner {kind}")
        return statement + marker

    def assert_approval(value, ids, target=None):
        item = value["payload"]["items"][0]
        require(
            item["student_id"] == ids["student"]
            and item["student_program_membership_id"] == ids["membership"],
            "Approval changed requested context",
        )
        require(
            item["approved_target_rank_id"] == (target or ids["rank1"]),
            "Approval did not capture coherent target",
        )
        require(
            value["payload"]["event_revision"] == 1, "Approval advanced parent event"
        )
        return item

    try:
        local.sql("postgres", f"CREATE DATABASE {database} TEMPLATE postgres;")
        owned = True
        print(f"[belt recipients] owned clone {database}", flush=True)
        install_final_v57(local, database, ROOT)
        for contract in (
            "workflow_management_contract.sql",
            "trial_appointment_contract.sql",
            "belt_test_event_contract.sql",
            "belt_test_recipient_contract.sql",
        ):
            output = sql((ROOT / "supabase/verification" / contract).read_text())
            passed(contract, result=output.strip())

        for rollback in (False, True):
            for same_key in (False, True):
                ids = fixture()
                operation = str(uuid4())
                first = session("approval_first", approve(ids, operation), hold=True)
                original = ready(first)
                second = session(
                    "approval_second", approve(ids, operation if same_key else None)
                )
                wait = blocked(first, second, advisory=same_key)
                release(first, rollback)
                value = finished(second)
                item = assert_approval(value, ids)
                require(
                    item["revision"] == 1 and len(facts(ids)["recipients"]) == 1,
                    "Competing approvals duplicated identity",
                )
                require(
                    value["replayed"] == (same_key and not rollback),
                    "Competing receipt ownership wrong",
                )
                if not rollback:
                    require(
                        value["payload"] == original["payload"],
                        "Competing current approval changed snapshot",
                    )
                passed(
                    f"competing approval same_key={same_key} rollback={rollback}",
                    wait=wait,
                )

        kinds = (
            "rank_insert",
            "rank_reorder",
            "rank_requirement",
            "rank_transition",
            "sync_assigned_delete",
            "membership_remove",
            "program_archive",
            "ladder_detach",
            "attendance_delete",
            "attendance_credit",
            "attendance_upsert",
            "attendance_insert",
            "session_cancel",
            "session_delete",
            "event_reschedule",
        )
        blocking_owners = {
            "rank_transition",
            "sync_assigned_delete",
            "membership_remove",
            "attendance_insert",
            "event_reschedule",
        }
        invalid_after = {
            "rank_requirement",
            "rank_transition",
            "membership_remove",
            "program_archive",
            "ladder_detach",
            "attendance_delete",
            "attendance_credit",
            "attendance_upsert",
            "session_cancel",
            "session_delete",
        }
        for kind in kinds:
            for rollback in (False, True):
                ids = fixture()
                ids["session2"] = str(uuid4())
                statement = source(ids, kind)
                first = session("approval_before_" + kind, approve(ids), hold=True)
                original = ready(first)
                second = session("source_after_" + kind, statement, role="postgres")
                wait = blocked(first, second)
                release(first, rollback)
                finished(second)
                recipients = facts(ids)["recipients"]
                require(
                    len(recipients) == (0 if rollback else 1),
                    "Source race changed approval transaction outcome",
                )
                if not rollback:
                    require(
                        recipients[0]["approved_current_rank_id"] == ids["rank0"]
                        and recipients[0]["approved_target_rank_id"] == ids["rank1"],
                        "Source owner rewrote immutable approval facts",
                    )
                    if kind == "event_reschedule":
                        require(
                            recipients[0]["state"] == "revoked",
                            "Reschedule retained obsolete approval",
                        )
                passed(f"approval before {kind} rollback={rollback}", wait=wait)

                ids = fixture()
                ids["session2"] = str(uuid4())
                statement = source(ids, kind)
                first = session(
                    "source_before_" + kind, statement, hold=True, role="postgres"
                )
                ready(first)
                before = facts(ids)
                second = session("approval_after_" + kind, approve(ids))
                if kind in blocking_owners:
                    wait = blocked(first, second)
                    release(first, rollback)
                    expected = (
                        None
                        if rollback or kind not in invalid_after | {"event_reschedule"}
                        else (
                            "AUTOMATION_REVISION_CONFLICT"
                            if kind == "event_reschedule"
                            else "AUTOMATION_STATE_CONFLICT"
                        )
                    )
                    value = finished(second, expected)
                else:
                    finished(second, "AUTOMATION_STUDIO_BUSY")
                    require(
                        facts(ids) == before,
                        "Busy source rejection persisted approval writes",
                    )
                    release(first, rollback)
                    expected = (
                        "AUTOMATION_STATE_CONFLICT"
                        if not rollback and kind in invalid_after
                        else None
                    )
                    value = finished(
                        session("retry_after_" + kind, approve(ids)), expected
                    )
                if expected:
                    require(
                        facts(ids)["recipients"] == [] and facts(ids)["receipts"] == 0,
                        "Invalid source left recipient/receipt",
                    )
                else:
                    target = ids["rank1"]
                    if not rollback and kind == "rank_insert":
                        target = ids["inserted_rank"]
                    if not rollback and kind in {
                        "rank_reorder",
                        "sync_assigned_delete",
                    }:
                        target = ids["rank2"]
                    assert_approval(value, ids, target)
                passed(f"{kind} before approval rollback={rollback}")

        for rollback in (False, True):
            ids = fixture()
            value = json.loads(sql("SET ROLE service_role;" + approve(ids)))
            ids["recipient"] = value["payload"]["items"][0]["id"]
            seed_run(ids)
            first = session(
                "held_claim",
                f"UPDATE public.automation_workflow_runs SET state='running',revision=revision+1 WHERE id='{ids['run']}'; SELECT '{{\"claim\":true}}'::jsonb;",
                hold=True,
            )
            ready(first)
            second = session("revoke_claim", revoke(ids))
            wait = blocked(first, second)
            release(first, rollback)
            revoked = finished(second)
            require(revoked["payload"]["state"] == "revoked", "Revoke lost to claim")
            require(
                sql(
                    f"SELECT state||':'||(claim_token IS NULL)::text FROM public.automation_workflow_runs WHERE id='{ids['run']}';"
                )
                == "cancelled:true",
                "Held pending claim survived revoke",
            )
            passed(f"revoke versus held claim rollback={rollback}", wait=wait)

        for kind in ("rank_transition", "membership_remove", "event_reschedule"):
            for command_first in (False, True):
                for rollback in (False, True):
                    ids = fixture()
                    companion, companion_membership = str(uuid4()), str(uuid4())
                    sql(f"""INSERT INTO public.students(id,studio_id,legal_first_name,legal_last_name,status,program_id,current_belt_rank_id)
VALUES('{companion}','{ids["studio"]}','Second','Synthetic','active','{ids["program"]}','{ids["rank0"]}');
INSERT INTO public.student_program_memberships(id,studio_id,student_id,program_id,status,current_belt_rank_id)
VALUES('{companion_membership}','{ids["studio"]}','{companion}','{ids["program"]}','active','{ids["rank0"]}');
INSERT INTO public.attendance(studio_id,session_id,student_id,status,checked_in_at)
VALUES('{ids["studio"]}','{ids["session"]}','{companion}','present',clock_timestamp()-interval '1 day');""")
                    selected = [
                        {
                            "student_id": ids["student"],
                            "student_program_membership_id": ids["membership"],
                        },
                        {
                            "student_id": companion,
                            "student_program_membership_id": companion_membership,
                        },
                    ]
                    command = approve(ids, recipients=selected)
                    mutation = source(ids, kind)
                    first = session(
                        "batch_first_" + kind,
                        command if command_first else mutation,
                        hold=True,
                        role="postgres",
                    )
                    ready(first)
                    second = session(
                        "batch_second_" + kind,
                        mutation if command_first else command,
                        role="postgres",
                    )
                    wait = blocked(first, second)
                    release(first, rollback)
                    expected = (
                        None
                        if command_first or rollback
                        else (
                            "AUTOMATION_REVISION_CONFLICT"
                            if kind == "event_reschedule"
                            else "AUTOMATION_STATE_CONFLICT"
                        )
                    )
                    value = finished(second, expected)
                    expected_count = 2 if (command_first != rollback) else 0
                    require(
                        len(facts(ids)["recipients"]) == expected_count,
                        "Concurrent batch partially committed",
                    )
                    if not command_first and rollback:
                        require(
                            {
                                (r["student_id"], r["student_program_membership_id"])
                                for r in value["payload"]["items"]
                            }
                            == {
                                (r["student_id"], r["student_program_membership_id"])
                                for r in selected
                            },
                            "Batch replaced selected pair",
                        )
                    passed(
                        f"batch {kind} command_first={command_first} rollback={rollback}",
                        wait=wait,
                    )

        # The accepted API service parses these real SQL envelopes and exact pairs.
        from types import SimpleNamespace

        sys.path.insert(0, str(ROOT / "backend"))
        from app.schemas.belt_test_recipient import (
            BeltTestRecipientApprove,
            BeltTestRecipientRevoke,
        )
        from app.services.belt_test_recipient_service import BeltTestRecipientService

        class SQLRPC:
            def rpc(self, name, params):
                require(
                    name
                    in {
                        "approve_belt_test_recipients_v1",
                        "revoke_belt_test_recipient_v1",
                        "list_belt_test_recipients_v1",
                    },
                    "Unexpected recipient RPC",
                )
                statement = (
                    "SET ROLE service_role; SELECT public."
                    + name
                    + "("
                    + ",".join(
                        f"{key}=>{quote(value)}" for key, value in params.items()
                    )
                    + ");"
                )
                return SimpleNamespace(
                    execute=lambda: SimpleNamespace(data=json.loads(sql(statement)))
                )

        ids = fixture()
        service = BeltTestRecipientService(SQLRPC())
        request = BeltTestRecipientApprove(
            operation_id=uuid4(),
            expected_event_revision=1,
            recipients=[
                {
                    "student_id": ids["student"],
                    "student_program_membership_id": ids["membership"],
                }
            ],
        )
        original = service.approve_recipients(
            ids["studio"], ids["actor"], ids["event"], request
        )
        ids["recipient"] = str(original.payload.items[0].id)
        require(
            service.list_recipients(ids["studio"], ids["actor"], ids["event"]).items[0]
            == original.payload.items[0],
            "Service list DTO differs",
        )
        sql(
            "SET ROLE service_role; SELECT public.mutate_belt_test_event_v1("
            + ",".join(
                map(
                    quote,
                    (
                        ids["studio"],
                        ids["actor"],
                        ids["event"],
                        str(uuid4()),
                        1,
                        {"name": "Renamed"},
                    ),
                )
            )
            + ");"
        )
        replay = service.approve_recipients(
            ids["studio"], ids["actor"], ids["event"], request
        )
        require(
            replay.replayed and replay.payload == original.payload,
            "Service replay compared current event revision",
        )
        service.revoke_recipient(
            ids["studio"],
            ids["actor"],
            ids["event"],
            ids["recipient"],
            BeltTestRecipientRevoke(operation_id=uuid4(), expected_revision=1),
        )
        passed(
            "real SQL through recipient service approve/list/revoke and original-CAS replay"
        )

        ids = fixture()
        operation = str(uuid4())
        original = json.loads(sql("SET ROLE service_role;" + approve(ids, operation)))
        ids["recipient"] = original["payload"]["items"][0]["id"]
        seed_run(ids)
        sql(f"""INSERT INTO private.automation_workflow_events(studio_id,event_type,source_key,subject_kind,subject_id,occurred_at)
SELECT '{ids["studio"]}','belt_test.approved',v.state,'belt_test','{ids["recipient"]}',clock_timestamp() FROM (VALUES('sending'),('unknown')) v(state);
INSERT INTO public.automation_workflow_runs(studio_id,workflow_id,version_id,event_id,activation_id,epoch,current_node_id,state,next_due_at,claim_token,lease_expires_at)
SELECT r.studio_id,r.workflow_id,r.version_id,e.id,r.activation_id,r.epoch,r.current_node_id,e.source_key,NULL,gen_random_uuid(),clock_timestamp()+interval '1 hour'
FROM public.automation_workflow_runs r JOIN private.automation_workflow_events e ON e.studio_id=r.studio_id
WHERE r.id='{ids["run"]}' AND e.source_key IN ('sending','unknown');""")
        inflight = sql(
            f"SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM public.automation_workflow_runs r WHERE studio_id='{ids['studio']}' AND state IN ('sending','unknown');"
        )
        current = json.loads(sql("SET ROLE service_role;" + approve(ids)))
        require(
            current["payload"] == original["payload"]
            and sql(
                f"SELECT state FROM public.automation_workflow_runs WHERE id='{ids['run']}';"
            )
            == "claimed",
            "Identical new-key approval invalidated current work",
        )
        require(
            sql(
                f"SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM public.automation_workflow_runs r WHERE studio_id='{ids['studio']}' AND state IN ('sending','unknown');"
            )
            == inflight,
            "No-op approval changed inflight metadata",
        )
        sql("SET ROLE service_role;" + source(ids, "rank_transition"))
        sql(f"UPDATE public.belt_ranks SET min_classes=0 WHERE id='{ids['rank2']}';")
        changed = json.loads(sql("SET ROLE service_role;" + approve(ids)))
        item = changed["payload"]["items"][0]
        require(
            item["revision"] == 2
            and item["id"] == ids["recipient"]
            and item["approved_current_rank_id"] == ids["rank1"]
            and item["approved_target_rank_id"] == ids["rank2"],
            "Explicit new-rank revision failed",
        )
        require(
            sql(
                f"SELECT state FROM public.automation_workflow_runs WHERE id='{ids['run']}';"
            )
            == "cancelled",
            "Old approval run survived new revision",
        )
        intended = json.loads(
            sql(
                f"SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM public.automation_workflow_runs r WHERE studio_id='{ids['studio']}' AND state IN ('sending','unknown');"
            )
        )
        for before, after in zip(json.loads(inflight), intended, strict=True):
            delta = {"revision", "cancel_requested_at", "cancel_reason", "updated_at"}
            require(
                {k: v for k, v in before.items() if k not in delta}
                == {k: v for k, v in after.items() if k not in delta},
                "Reapproval rewrote inflight truth",
            )
            require(
                after["revision"] == before["revision"] + 1
                and after["cancel_reason"] == "belt_test_approval_changed"
                and after["cancel_requested_at"] is not None
                and after["updated_at"] == after["cancel_requested_at"],
                "Reapproval lost first approval intent",
            )
        require(
            json.loads(sql("SET ROLE service_role;" + approve(ids, operation)))
            == {**original, "replayed": True},
            "Old receipt lost rank snapshots",
        )
        json.loads(sql("SET ROLE service_role;" + revoke(ids, revision=2)))
        require(
            json.loads(
                sql(
                    f"SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM public.automation_workflow_runs r WHERE studio_id='{ids['studio']}' AND state IN ('sending','unknown');"
                )
            )
            == intended,
            "Revoke rewrote inflight truth",
        )
        passed(
            "explicit reapproval cancels old revision; no-op and sending/unknown preserved"
        )

        ids = fixture()
        value = json.loads(sql("SET ROLE service_role;" + approve(ids)))
        ids["recipient"] = value["payload"]["items"][0]["id"]
        sql("SET ROLE service_role;" + revoke(ids))
        seed_run(ids)
        first = session(
            "expiry_run_owner",
            f"SELECT 1 FROM public.automation_workflow_runs WHERE id='{ids['run']}' FOR UPDATE; SELECT '{{}}'::jsonb;",
            hold=True,
        )
        ready(first)
        sql(
            f"UPDATE public.belt_test_events SET starts_at=clock_timestamp()+interval '1 second',ends_at=clock_timestamp()+interval '1 hour' WHERE id='{ids['event']}';"
        )
        second = session("expiry_approval", approve(ids))
        blocked(first, second)
        time.sleep(1.1)
        release(first)
        finished(second, "AUTOMATION_STATE_CONFLICT")
        require(
            facts(ids)["recipients"][0]["state"] == "revoked",
            "Clock sampled before final run wait",
        )
        passed("event expiry resampled after final run lock; no ghost reapproval")

        for legacy, mutation_kind in (
            (False, "archive"),
            (True, "archive"),
            (True, "delete"),
        ):
            for command_first in (False, True):
                for rollback in (False, True):
                    ids = fixture()
                    if legacy:
                        sql(
                            f"DELETE FROM public.student_program_memberships WHERE id='{ids['membership']}';"
                        )
                    sql(
                        f"UPDATE public.belt_ladders SET program_id=NULL WHERE id='{ids['ladder']}'; UPDATE public.belt_test_events SET program_id=NULL WHERE id='{ids['event']}';"
                    )
                    selected = [
                        {
                            "student_id": ids["student"],
                            "student_program_membership_id": None
                            if legacy
                            else ids["membership"],
                        }
                    ]
                    command = approve(ids, recipients=selected)
                    mutation = (
                        f"DELETE FROM public.programs WHERE id='{ids['program']}';"
                        if mutation_kind == "delete"
                        else f"UPDATE public.programs SET archived_at=clock_timestamp() WHERE id='{ids['program']}';"
                    ) + "SELECT '{}'::jsonb;"
                    first = session(
                        "unscoped_first",
                        command if command_first else mutation,
                        hold=True,
                        role="postgres",
                    )
                    ready(first)
                    second = session(
                        "unscoped_second",
                        mutation if command_first else command,
                        role="postgres",
                    )
                    if command_first or mutation_kind == "delete":
                        blocked(first, second)
                        release(first, rollback)
                        value = finished(second)
                    else:
                        finished(second, "AUTOMATION_STUDIO_BUSY")
                        require(
                            facts(ids)["recipients"] == [],
                            "Unscoped program contention wrote approval",
                        )
                        release(first, rollback)
                        value = finished(
                            session("unscoped_retry", command),
                            None if rollback else "AUTOMATION_STATE_CONFLICT",
                        )
                    rows = facts(ids)["recipients"]
                    if command_first:
                        require(
                            len(rows) == (0 if rollback else 1),
                            "Unscoped owner changed approval transaction outcome",
                        )
                        if rows:
                            require(
                                rows[0]["approved_program_id"] == ids["program"],
                                "Program deletion rewrote internal approval snapshot",
                            )
                    elif value:
                        expected_program = (
                            None
                            if mutation_kind == "delete" and not rollback
                            else ids["program"]
                        )
                        require(
                            len(rows) == 1
                            and rows[0]["approved_program_id"] == expected_program,
                            "Unscoped approval captured wrong current context",
                        )
                        require(
                            "approved_program_id" not in value["payload"]["items"][0],
                            "Internal context leaked into DTO",
                        )
                    else:
                        require(rows == [], "Archived unscoped context approved")
                    passed(
                        f"unscoped legacy={legacy} program_{mutation_kind} command_first={command_first} rollback={rollback}"
                    )

        for command_first in (False, True):
            for rollback in (False, True):
                ids = fixture()
                clear = f"SELECT public.clear_studio_operational_data_atomic('{ids['studio']}',false); SELECT '{{}}'::jsonb;"
                first = session(
                    "clear_first",
                    approve(ids) if command_first else clear,
                    hold=True,
                    role="postgres",
                )
                ready(first)
                second = session(
                    "clear_second",
                    clear if command_first else approve(ids),
                    role="postgres",
                )
                if command_first:
                    blocked(first, second, advisory=True)
                    release(first, rollback)
                    finished(second)
                else:
                    finished(second, "AUTOMATION_STUDIO_BUSY")
                    require(
                        facts(ids)["recipients"] == [], "Clear-busy wrote recipients"
                    )
                    release(first, rollback)
                    if rollback:
                        assert_approval(
                            finished(session("clear_retry", approve(ids))), ids
                        )
                passed(
                    f"actual operational clear command_first={command_first} rollback={rollback}"
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
            print(f"[belt recipients] cleaned {database}", flush=True)
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
