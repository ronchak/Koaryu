#!/usr/bin/env python3
"""Verify lead command ordering using independent disposable PostgreSQL sessions."""
import hashlib
import json
import os
from pathlib import Path
import queue
import signal
import subprocess
import sys
import threading
import time
from uuid import UUID, uuid4, uuid5

from local_postgres_verification import LocalPostgres, require


def main(arguments):
    require(len(arguments) == 3, "Expected psql socket port from the local contract verifier")
    psql, socket, port = arguments
    local = LocalPostgres(psql, socket, port, str(Path(socket).parent))
    createdb = str(Path(psql).with_name("createdb"))
    local.require_pg17(createdb)
    database = f"koaryu_lead_command_concurrency_{os.getpid()}"
    owned = False
    children = []
    results = []

    def sql(statement):
        return local.sql(database, statement)

    def fixture():
        ids = {key: str(uuid4()) for key in ("studio", "actor", "actor2", "lead", "lead2", "program")}
        sql(f"""BEGIN;
INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
VALUES ('{ids['actor']}','authenticated','authenticated','{ids['actor']}@example.invalid','{{}}','{{}}',now(),now()),
 ('{ids['actor2']}','authenticated','authenticated','{ids['actor2']}@example.invalid','{{}}','{{}}',now(),now());
INSERT INTO public.studios(id,name,slug,owner_id)
VALUES ('{ids['studio']}','Lead concurrency fixture','{ids['studio']}','{ids['actor']}');
INSERT INTO public.staff_roles(studio_id,user_id,role)
VALUES ('{ids['studio']}','{ids['actor']}','admin'),('{ids['studio']}','{ids['actor2']}','front_desk');
INSERT INTO public.programs(id,studio_id,name) VALUES ('{ids['program']}','{ids['studio']}','Lead program');
INSERT INTO public.leads(id,studio_id,first_name,last_name,stage,program_id,follow_up_date,is_minor,guardian_name)
VALUES ('{ids['lead']}','{ids['studio']}','Synthetic','Lead','inquiry','{ids['program']}','2030-01-01',true,'Synthetic Guardian'),
 ('{ids['lead2']}','{ids['studio']}','Other','Lead','inquiry','{ids['program']}','2030-01-01',false,NULL);
COMMIT;""")
        return ids

    def patch(ids, stage, *, lead="lead"):
        payload = json.dumps({"stage": stage})
        return (f"SELECT to_jsonb(r) FROM public.update_lead_atomic('{ids['studio']}',"
                f"'{ids['actor']}','{ids[lead]}','{payload}'::jsonb) r;")

    def follow(ids, operation, target, *, lead="lead", actor="actor"):
        payload = json.dumps({"next_stage": target})
        return (f"SELECT to_jsonb(r) FROM public.follow_up_lead_atomic('{ids['studio']}',"
                f"'{ids[actor]}','{ids[lead]}','{operation}','{payload}'::jsonb) r;")

    def session(name, statement, *, hold=False):
        name = f"lead_{os.getpid()}_{name}"
        process = subprocess.Popen(
            [psql, *local.connection, f"--dbname={database}", "--no-psqlrc", "--quiet",
             "--tuples-only", "--no-align", "--set=ON_ERROR_STOP=1", "--set=VERBOSITY=verbose"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, bufsize=1, env=local.env)
        item = {"process": process, "lines": [], "errors": [], "events": queue.Queue(), "name": name}
        children.append(item)

        def drain(stream, target, events=None):
            for line in stream:
                target.append(line.rstrip())
                if events is not None:
                    events.put(line.rstrip())

        item["threads"] = [
            threading.Thread(target=drain, args=(process.stdout, item["lines"], item["events"]), daemon=True),
            threading.Thread(target=drain, args=(process.stderr, item["errors"]), daemon=True)]
        for thread in item["threads"]:
            thread.start()
        process.stdin.write(f"SET application_name='{name}';\nBEGIN;\n"
                            "SET LOCAL statement_timeout='30s';\nSET LOCAL ROLE service_role;\n"
                            f"{statement}\n")
        if hold:
            process.stdin.write("SELECT 'RESULT_READY';\n")
            process.stdin.flush()
        else:
            process.stdin.write("COMMIT;\n")
            process.stdin.close()
        return item

    def returned(item):
        rows = [json.loads(line) for line in item["lines"] if line.startswith("{")]
        require(len(rows) == 1, f"Expected one returned lead: {item['lines']}")
        return rows[0]

    def await_result(item):
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            try:
                if item["events"].get(timeout=0.1) == "RESULT_READY":
                    return returned(item)
            except queue.Empty:
                require(item["process"].poll() is None,
                        "Holding session failed before its barrier: " + "\n".join(item["errors"]))
        raise RuntimeError("Holding command never reached its result barrier")

    def observed_blocker(first, second, *, operation=False):
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            require(first["process"].poll() is None and second["process"].poll() is None,
                    "A competing command exited before its lock was observed: " + "\n".join(second["errors"]))
            rows = json.loads(sql("SELECT COALESCE(jsonb_agg(jsonb_build_object('pid',b.pid,'blocker',a.pid,"
                "'wait',b.wait_event,'type',b.wait_event_type)), '[]'::jsonb) "
                "FROM pg_stat_activity a JOIN pg_stat_activity b ON b.datname=a.datname "
                f"WHERE a.datname=current_database() AND a.application_name='{first['name']}' "
                f"AND b.application_name='{second['name']}' AND b.state='active' "
                "AND a.pid=ANY(pg_blocking_pids(b.pid));"))
            if rows:
                require(len(rows) == 1 and rows[0]["type"] == "Lock", "Ambiguous lock observation")
                require(not operation or rows[0]["wait"] == "advisory", "Same operation did not wait on its advisory lock")
                return rows[0]
            time.sleep(0.025)
        raise RuntimeError("Competing command did not reach the required lock")

    def finish(item, *, error=False):
        code = item["process"].wait(timeout=15)
        for thread in item["threads"]:
            thread.join(timeout=2)
        require(not any(thread.is_alive() for thread in item["threads"]), "Session output did not finish")
        errors = "\n".join(item["errors"])
        if error:
            require(code != 0 and "ERROR:  23505:" in errors and "Follow-up operation identity conflict" in errors,
                    f"Mismatched operation failed for the wrong reason: {errors}")
            return None
        require(code == 0, f"Command failed: {errors}")
        return returned(item)

    def settle(item, *, rollback=False):
        item["process"].stdin.write("ROLLBACK;\n" if rollback else "COMMIT;\n")
        item["process"].stdin.close()
        return finish(item)

    def facts(ids, lead="lead"):
        return json.loads(sql(f"""SELECT jsonb_build_object(
 'lead',(SELECT to_jsonb(l) FROM public.leads l WHERE id='{ids[lead]}'),
 'activities',(SELECT COALESCE(jsonb_agg(jsonb_build_array(activity_type,description) ORDER BY activity_type,description),'[]'::jsonb)
   FROM public.lead_activities WHERE lead_id='{ids[lead]}'),
 'receipts',(SELECT count(*) FROM public.lead_follow_up_operations WHERE lead_id='{ids[lead]}'),
 'students',(SELECT count(*) FROM public.students WHERE studio_id='{ids['studio']}'),
 'memberships',(SELECT count(*) FROM public.student_program_memberships WHERE studio_id='{ids['studio']}'),
 'guardians',(SELECT count(*) FROM public.guardians WHERE studio_id='{ids['studio']}'),
 'links',(SELECT count(*) FROM public.student_guardians g JOIN public.students s ON s.id=g.student_id WHERE s.studio_id='{ids['studio']}'),
 'audits',(SELECT count(*) FROM public.audit_logs WHERE studio_id='{ids['studio']}' AND action='lead.converted'));
"""))

    def passed(case, **evidence):
        results.append({"case": case, "outcome": "passed", **evidence})
        print(f"[lead command concurrency] PASS {case}", flush=True)

    try:
        local.run([createdb, *local.connection, "--owner=postgres", "--template=postgres", database])
        owned = True
        require(sql("SELECT to_regprocedure('public.update_lead_atomic(uuid,uuid,uuid,jsonb)') IS NOT NULL "
                    "AND to_regprocedure('public.follow_up_lead_atomic(uuid,uuid,uuid,uuid,jsonb)') IS NOT NULL;") == "t",
                "Lead command concurrency requires update_lead_atomic and follow_up_lead_atomic")
        for rollback in (False, True):
            ids = fixture()
            first = session(f"stage_a_{rollback}", patch(ids, "trial_scheduled"), hold=True)
            await_result(first)
            second = session(f"stage_b_{rollback}", patch(ids, "offer_sent"))
            blocking = observed_blocker(first, second)
            require(facts(ids)["lead"]["stage"] == "inquiry", "Uncommitted transition became visible")
            settle(first, rollback=rollback)
            require(finish(second)["stage"] == "offer_sent", "Second stage command returned wrong result")
            expected = [["stage_change", "Stage changed from inquiry to offer_sent"]] if rollback else [
                ["stage_change", "Stage changed from inquiry to trial_scheduled"],
                ["stage_change", "Stage changed from trial_scheduled to offer_sent"]]
            state = facts(ids)
            require(state["activities"] == expected and state["lead"]["stage"] == "offer_sent",
                    f"History did not use the committed prior stage: {state}")
            sql("SET ROLE service_role; " + patch(ids, "offer_sent"))
            require(facts(ids)["activities"] == state["activities"], "Same-stage PATCH created history")
            passed("stage_rollback" if rollback else "stage_commit", blocking=blocking, history=expected)

        for case in ("commit", "rollback", "contact_commit", "contact_rollback", "changed_target",
                     "changed_lead", "changed_actor", "changed_studio", "enroll_commit", "enroll_rollback"):
            ids = fixture()
            operation = str(uuid4())
            target = "enrolled" if case.startswith("enroll") else None if case.startswith("contact") else "trial_scheduled"
            other_ids = fixture() if case == "changed_studio" else ids
            other_before = facts(other_ids) if case == "changed_studio" else None
            first = session(f"follow_a_{case}", follow(ids, operation, target), hold=True)
            original = await_result(first)
            second = session(f"follow_b_{case}", follow(other_ids, operation,
                "offer_sent" if case == "changed_target" else target,
                lead="lead2" if case == "changed_lead" else "lead",
                actor="actor2" if case == "changed_actor" else "actor"))
            blocking = observed_blocker(first, second, operation=True)
            before = facts(ids)
            require(before["lead"]["stage"] == "inquiry" and before["activities"] == [] and before["receipts"] == 0
                    and before["students"] == 0 and before["audits"] == 0, "Uncommitted follow-up effects became visible")
            rollback = case.endswith("rollback")
            settle(first, rollback=rollback)
            conflict = case.startswith("changed_")
            replay = finish(second, error=conflict)
            state = facts(ids)
            require(state["lead"]["stage"] == (target or "inquiry") and state["lead"]["follow_up_date"] is None
                    and state["receipts"] == 1, f"Follow-up committed wrong lead or receipt count: {state}")
            require(len(state["activities"]) == (2 if target else 1)
                    and sum(row[0] == "follow_up" for row in state["activities"]) == 1
                    and sum(row[0] == "stage_change" for row in state["activities"]) == (1 if target else 0),
                    f"Follow-up repeated or lost a contact/transition: {state}")
            require(all(state[key] == (1 if target == "enrolled" else 0)
                        for key in ("students", "memberships", "guardians", "links", "audits")),
                    f"Nested conversion cardinalities are wrong: {state}")
            if target == "enrolled":
                namespace = UUID("27c8322f-a4e4-46d7-bfae-018f6b638858")
                student = str(uuid5(namespace, f"{ids['studio']}:{ids['lead']}:student"))
                guardian = str(uuid5(namespace, f"{ids['studio']}:{ids['lead']}:guardian"))
                link = str(uuid5(namespace, f"{student}:{guardian}:link"))
                require(state["lead"]["converted_student_id"] == student
                        and sql(f"SELECT EXISTS(SELECT 1 FROM public.guardians WHERE id='{guardian}') "
                                f"AND EXISTS(SELECT 1 FROM public.student_guardians WHERE id='{link}' "
                                f"AND student_id='{student}' AND guardian_id='{guardian}');") == "t",
                        "SQL conversion IDs differ from the existing Python UUIDv5 contract")
            if not conflict:
                require(replay == state["lead"] and (rollback or replay == original),
                        "Replay did not preserve the committed result")
            require(facts(ids, "lead2")["lead"]["stage"] == "inquiry" and facts(ids, "lead2")["activities"] == [],
                    "Mismatched replay mutated the other lead")
            if other_before is not None:
                require(facts(other_ids) == other_before, "Mismatched replay mutated the other tenant")
            # A later ordinary edit must not replace the original receipt result.
            saved = state["lead"]
            sql("SET ROLE service_role; " + patch(ids, "closed_lost"))
            after_edit = facts(ids)
            retried = json.loads(sql("SET ROLE service_role; " + follow(ids, operation, target)))
            require(retried == saved and facts(ids) == after_edit, "Lost-response retry changed effects or returned a newer result")
            passed(case, blocking=blocking, activities=state["activities"], receipts=state["receipts"])

        ids = fixture()
        first = session("different_leads_a", follow(ids, str(uuid4()), "trial_scheduled"), hold=True)
        await_result(first)
        second = session("different_leads_b", follow(ids, str(uuid4()), "trial_completed", lead="lead2"), hold=True)
        await_result(second)
        require(first["process"].poll() is None, "First lead session exited before cross-lead concurrency proof")
        settle(second)
        require(facts(ids, "lead2")["lead"]["stage"] == "trial_completed" and facts(ids)["lead"]["stage"] == "inquiry",
                "Different lead did not commit independently while first lead remained held")
        settle(first)
        passed("different_leads_complete_independently")
        evidence = {"script_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                    "local_tools_sha256": hashlib.sha256(Path(__file__).with_name("local_postgres_verification.py").read_bytes()).hexdigest(),
                    "cases": results}
        (local.temporary / "lead-command-concurrency-evidence.json").write_text(json.dumps(evidence, indent=2) + "\n")
    finally:
        for child in children:
            process = child["process"]
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=3)
        if owned:
            local.sql("postgres", f"DROP DATABASE {database} WITH (FORCE);")


if __name__ == "__main__":
    def interrupted(signum, _frame):
        raise SystemExit(128 + signum)
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    main(sys.argv[1:])
