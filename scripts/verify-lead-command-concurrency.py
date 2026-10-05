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

    def session(name, statement, *, hold=False, role="service_role", rollback=False):
        name = f"lead_{os.getpid()}_{name}"
        if len(name) > 63:
            name = name[:50] + "_" + hashlib.sha256(name.encode()).hexdigest()[:12]
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
                            f"SET LOCAL statement_timeout='30s';\nSET LOCAL ROLE {role};\n"
                            f"{statement}\n")
        if hold:
            process.stdin.write("SELECT 'RESULT_READY';\n")
            process.stdin.flush()
        else:
            process.stdin.write("ROLLBACK;\n" if rollback else "COMMIT;\n")
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
                require(len(rows) == 1, f"Ambiguous lock observation: {rows}")
                # pg_stat_activity can sample the waiter immediately before
                # pg_blocking_pids observes its lock. Wait for both to agree.
                if rows[0]["type"] == "Lock":
                    require(not operation or rows[0]["wait"] == "advisory", "Same operation did not wait on its advisory lock")
                    return rows[0]
            time.sleep(0.025)
        raise RuntimeError("Competing command did not reach the required lock")

    def finish(item, *, error=False, expected_error=None):
        code = item["process"].wait(timeout=15)
        for thread in item["threads"]:
            thread.join(timeout=2)
        require(not any(thread.is_alive() for thread in item["threads"]), "Session output did not finish")
        errors = "\n".join(item["errors"])
        require("ERROR:  40P01:" not in errors, f"Command deadlocked: {errors}")
        if expected_error is not None:
            state, message = expected_error
            require(code != 0 and f"ERROR:  {state}:" in errors and message in errors,
                    f"Command failed for the wrong reason: {errors}")
            return None
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

        # Restoration changes only the lead stage. Competing direct conversions and
        # new/replayed follow-up intents must not repeat the student write chain.
        for kind in ("same_key", "new_key", "direct", "mixed"):
            for rollback in (False, True):
                ids = fixture()
                sql("SET ROLE service_role; " + follow(ids, str(uuid4()), "enrolled"))
                sql("SET ROLE service_role; " + patch(ids, "offer_sent"))
                sql(f"UPDATE public.programs SET archived_at=now() WHERE id='{ids['program']}';")
                before = facts(ids)
                require(sql(f"SELECT is_minor AND date_of_birth IS NULL FROM public.students "
                            f"WHERE id='{before['lead']['converted_student_id']}';") == "t",
                        "Restoration fixture lost V54 explicit minor knowledge without a DOB")
                conversion_facts = f"""SELECT jsonb_build_array(
 (SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM public.students s WHERE studio_id='{ids['studio']}'),
 (SELECT jsonb_agg(to_jsonb(m) ORDER BY id) FROM public.student_program_memberships m WHERE studio_id='{ids['studio']}'),
 (SELECT jsonb_agg(to_jsonb(g) ORDER BY id) FROM public.guardians g WHERE studio_id='{ids['studio']}'),
 (SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM public.student_guardians l WHERE student_id='{before['lead']['converted_student_id']}'),
 (SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM public.audit_logs a WHERE studio_id='{ids['studio']}'));"""
                retained = sql(conversion_facts)
                operation = str(uuid4())
                direct = (f"SELECT to_jsonb(r) FROM public.convert_lead_to_student_atomic("
                          f"'{ids['studio']}','{ids['actor']}','{ids['lead']}',"
                          "NULL,NULL,NULL,NULL,NULL,NULL) r;")
                first_command = direct if kind in ("direct", "mixed") else follow(ids, operation, "enrolled")
                second_command = direct if kind == "direct" else follow(
                    ids, operation if kind == "same_key" else str(uuid4()), "enrolled")
                case = f"restore_{kind}_{'rollback' if rollback else 'commit'}"
                first = session(case + "_first", first_command, hold=True)
                await_result(first)
                second = session(case + "_second", second_command)
                blocking = observed_blocker(first, second, operation=kind == "same_key")
                require(facts(ids) == before and sql(conversion_facts) == retained,
                        "Uncommitted restoration changed visible lead or conversion facts")
                settle(first, rollback=rollback)
                result = finish(second)
                state = facts(ids)
                contacts = 0 if kind == "direct" else 2 if kind == "new_key" and not rollback else 1
                require(result == state["lead"] and state["lead"]["stage"] == "enrolled"
                        and state["lead"]["follow_up_date"] is None
                        and state["lead"]["converted_student_id"] == before["lead"]["converted_student_id"],
                        f"Concurrent restoration lost the original enrollment identity: {state}")
                require(state["receipts"] == before["receipts"] + contacts
                        and len(state["activities"]) == len(before["activities"]) + contacts + 1
                        and state["activities"].count(["stage_change", "Stage changed from offer_sent to enrolled"]) == 1,
                        f"Concurrent restoration duplicated history or operation receipts: {state}")
                require(all(state[key] == before[key] for key in
                            ("students", "memberships", "guardians", "links", "audits"))
                        and sql(conversion_facts) == retained,
                        "Concurrent restoration changed existing student or enrollment records")
                passed(case, blocking=blocking, receipts=state["receipts"], activities=state["activities"])

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

        # Account cleanup deletes staff memberships before clearing authored
        # activities and assignments. Lock referenced Auth rows first so those
        # cascades cannot hold Auth while waiting on this command's staff row.
        def auth_command(ids, kind):
            if kind == "actor_follow_up":
                return follow(ids, ids["operation"], "trial_scheduled", actor="actor2")
            actor = ids["actor2"] if kind == "actor_patch" else ids["actor"]
            payload = {"stage": "trial_scheduled"}
            if kind == "assignee_patch":
                payload["assigned_staff_id"] = ids["actor2"]
            return (f"SELECT to_jsonb(r) FROM public.update_lead_atomic('{ids['studio']}',"
                    f"'{actor}','{ids['lead']}','{json.dumps(payload)}'::jsonb) r;")

        def auth_fixture():
            ids = fixture()
            ids["operation"] = str(uuid4())
            return ids

        def cleanup_command(ids):
            # actor2 is a non-owner front-desk user. Both leads start unassigned.
            return f"DELETE FROM auth.users WHERE id='{ids['actor2']}'; SELECT '{{}}'::jsonb;"

        def check_auth_outcome(ids, kind, *, deleted, changed):
            state = facts(ids)
            require(sql(f"SELECT EXISTS(SELECT 1 FROM auth.users WHERE id='{ids['actor2']}') "
                        f"AND EXISTS(SELECT 1 FROM public.staff_roles WHERE user_id='{ids['actor2']}' "
                        f"AND studio_id='{ids['studio']}');") == ("f" if deleted else "t"),
                    "Account cleanup committed or rolled back incorrectly")
            if deleted:
                require(sql(f"SELECT NOT EXISTS(SELECT 1 FROM auth.users WHERE id='{ids['actor2']}') "
                            f"AND NOT EXISTS(SELECT 1 FROM public.staff_roles WHERE user_id='{ids['actor2']}');") == "t",
                        "Account cleanup left a user or membership")
            expected_activities = [["stage_change", "Stage changed from inquiry to trial_scheduled"]] if changed else []
            is_follow = kind == "actor_follow_up"
            if is_follow and changed:
                expected_activities.insert(0, ["follow_up", "Contacted lead and moved to trial_scheduled"])
            require(state["activities"] == expected_activities
                    and state["lead"]["stage"] == ("trial_scheduled" if changed else "inquiry")
                    and state["lead"]["follow_up_date"] == (None if changed and is_follow else "2030-01-01")
                    and state["receipts"] == (1 if is_follow and changed and not deleted else 0)
                    and state["lead"]["assigned_staff_id"] == (
                        ids["actor2"] if changed and kind == "assignee_patch" and not deleted else None),
                    f"Account cleanup or command changed the wrong persisted facts: {state}")
            expected_author = ids["actor"] if kind == "assignee_patch" else None if deleted else ids["actor2"]
            require(sql(f"SELECT count(*) FROM public.lead_activities WHERE lead_id='{ids['lead']}' "
                        + ("AND created_by IS NOT NULL;" if expected_author is None else
                           f"AND created_by IS DISTINCT FROM '{expected_author}'::uuid;")) == "0",
                    "Account cleanup changed the wrong activity author")
            return state

        for kind in ("actor_patch", "actor_follow_up", "assignee_patch"):
            for rollback in (False, True):
                ids = auth_fixture()
                case = f"{kind}_before_auth_cleanup_{'rollback' if rollback else 'commit'}"
                if kind == "assignee_patch":
                    # Pause after the requested assignee's membership was checked
                    # but before UPDATE performs its new assigned_staff_id FK check.
                    # The trigger exists only in this script's disposable clone.
                    sql("""CREATE FUNCTION public.koaryu_test_lead_assignment_barrier()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF current_setting('koaryu.test_lead_assignment_barrier', true) = 'on' THEN
        PERFORM pg_advisory_xact_lock(835910224);
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER koaryu_test_lead_assignment_barrier BEFORE UPDATE ON public.leads
FOR EACH ROW EXECUTE FUNCTION public.koaryu_test_lead_assignment_barrier();""")
                    barrier = "SELECT pg_advisory_xact_lock(835910224); SELECT '{}'::jsonb;"
                    command = "SET LOCAL koaryu.test_lead_assignment_barrier='on'; " + auth_command(ids, kind)
                else:
                    barrier = f"SELECT to_jsonb(l) FROM public.leads l WHERE id='{ids['lead']}' FOR UPDATE;"
                    command = auth_command(ids, kind)
                holder = session(case + "_holder", barrier, hold=True, role="postgres")
                await_result(holder)
                writer = session(case + "_writer", command)
                writer_wait = observed_blocker(holder, writer, operation=kind == "assignee_patch")
                cleanup = session(case + "_cleanup", cleanup_command(ids), role="postgres", rollback=rollback)
                cleanup_wait = observed_blocker(writer, cleanup)
                settle(holder)
                require(finish(writer)["stage"] == "trial_scheduled", "Authorized command did not finish")
                finish(cleanup)
                state = check_auth_outcome(ids, kind, deleted=not rollback, changed=True)
                if kind == "assignee_patch":
                    sql("DROP TRIGGER koaryu_test_lead_assignment_barrier ON public.leads; "
                        "DROP FUNCTION public.koaryu_test_lead_assignment_barrier();")
                passed(case, writer_wait=writer_wait, cleanup_wait=cleanup_wait, activities=state["activities"])

            for rollback in (False, True):
                ids = auth_fixture()
                case = f"auth_cleanup_before_{kind}_{'rollback' if rollback else 'commit'}"
                cleanup = session(case + "_cleanup", cleanup_command(ids), hold=True, role="postgres")
                await_result(cleanup)
                writer = session(case + "_writer", auth_command(ids, kind))
                blocking = observed_blocker(cleanup, writer)
                settle(cleanup, rollback=rollback)
                if rollback:
                    require(finish(writer)["stage"] == "trial_scheduled", "Cleanup rollback did not release the command")
                else:
                    expected = ("P0002", "Assigned staff not found for studio") if kind == "assignee_patch" else (
                        "42501", "Lead management permission required")
                    finish(writer, expected_error=expected)
                state = check_auth_outcome(ids, kind, deleted=not rollback, changed=rollback)
                passed(case, blocking=blocking, activities=state["activities"])

            # A lock taken immediately before INSERT/UPDATE would still be too
            # late. Auth must already be protected while either dependent row
            # acquisition is blocked. NOWAIT makes this ordering deterministic.
            for dependency in ("membership", "lead"):
                ids = auth_fixture()
                case = f"{kind}_locks_auth_before_{dependency}"
                barrier = (
                    f"SELECT to_jsonb(s) FROM public.staff_roles s WHERE user_id='{ids['actor2']}' "
                    f"AND studio_id='{ids['studio']}' FOR UPDATE;"
                ) if dependency == "membership" else (
                    f"SELECT to_jsonb(l) FROM public.leads l WHERE id='{ids['lead']}' FOR UPDATE;"
                )
                holder = session(case + "_holder", barrier, hold=True, role="postgres")
                await_result(holder)
                writer = session(case + "_writer", auth_command(ids, kind))
                blocking = observed_blocker(holder, writer)
                probe = session(case + "_probe",
                    f"SELECT to_jsonb(u) FROM auth.users u WHERE id='{ids['actor2']}' FOR UPDATE NOWAIT;",
                    role="postgres")
                finish(probe, expected_error=("55P03", 'could not obtain lock on row in relation "users"'))
                settle(holder)
                finish(writer)
                check_auth_outcome(ids, kind, deleted=False, changed=True)
                passed(case, blocking=blocking, probe_sqlstate="55P03")

        def admin_fixture():
            ids = auth_fixture()
            # The real orphan guard requires another confirmed active admin.
            sql(f"UPDATE auth.users SET email_confirmed_at=now() WHERE id='{ids['actor']}'; "
                f"UPDATE public.staff_roles SET role='admin' WHERE user_id='{ids['actor2']}';")
            return ids

        def hold_staff(ids, name):
            holder = session(name,
                f"SELECT to_jsonb(s) FROM public.staff_roles s WHERE user_id='{ids['actor2']}' "
                f"AND studio_id='{ids['studio']}' FOR UPDATE;", hold=True, role="postgres")
            await_result(holder)
            return holder

        for kind in ("actor_patch", "actor_follow_up", "assignee_patch"):
            for change in ("archive", "demotion"):
                for command_first in (False, True):
                    for rollback in (False, True):
                        ids = admin_fixture()
                        case = (f"{kind}_{change}_{'command_first' if command_first else 'admin_first'}_"
                                f"{'rollback' if rollback else 'commit'}")
                        change_sql = ("archived_at=now()" if change == "archive" else "role='instructor'")
                        change_sql = (f"UPDATE public.staff_roles SET {change_sql} "
                                      f"WHERE user_id='{ids['actor2']}' AND studio_id='{ids['studio']}';")
                        if command_first:
                            writer = session(case + "_writer", auth_command(ids, kind), hold=True)
                            await_result(writer)
                            admin = session(case + "_admin", change_sql + " SELECT '{}'::jsonb;", role="postgres")
                            blocking = observed_blocker(writer, admin)
                            settle(writer, rollback=rollback)
                            finish(admin)
                            changed = not rollback
                            staff_changed = True
                        else:
                            # The holder owns the staff row before calling the
                            # actual archive/demotion trigger. A lead command
                            # that holds studio while waiting here deadlocks.
                            admin = hold_staff(ids, case + "_admin")
                            writer = session(case + "_writer", auth_command(ids, kind))
                            blocking = observed_blocker(admin, writer)
                            admin["process"].stdin.write(change_sql + "\n")
                            settle(admin, rollback=rollback)
                            # Active instructors remain valid assignees.
                            changed = rollback or (kind == "assignee_patch" and change == "demotion")
                            if changed:
                                finish(writer)
                            else:
                                expected = ("P0002", "Assigned staff not found for studio") if kind == "assignee_patch" else (
                                    "42501", "Lead management permission required")
                                finish(writer, expected_error=expected)
                            staff_changed = not rollback
                        state = check_auth_outcome(ids, kind, deleted=False, changed=changed)
                        actual_staff = json.loads(sql(
                            f"SELECT jsonb_build_object('role',role,'archived',archived_at IS NOT NULL) "
                            f"FROM public.staff_roles WHERE user_id='{ids['actor2']}' AND studio_id='{ids['studio']}';"))
                        require(actual_staff == {
                            "role": "instructor" if change == "demotion" and staff_changed else "admin",
                            "archived": change == "archive" and staff_changed,
                        }, f"Staff writer did not settle as intended: {actual_staff}")
                        passed(case, blocking=blocking, activities=state["activities"], staff=actual_staff)

        # A demotion to front desk still permits both lead commands.
        for kind in ("actor_patch", "actor_follow_up"):
            ids = admin_fixture()
            case = f"{kind}_admin_to_front_desk_remains_authorized"
            admin = hold_staff(ids, case + "_admin")
            writer = session(case + "_writer", auth_command(ids, kind))
            blocking = observed_blocker(admin, writer)
            admin["process"].stdin.write(
                f"UPDATE public.staff_roles SET role='front_desk' WHERE user_id='{ids['actor2']}';\n")
            settle(admin)
            finish(writer)
            check_auth_outcome(ids, kind, deleted=False, changed=True)
            passed(case, blocking=blocking)

        for kind in ("actor_patch", "actor_follow_up", "assignee_patch"):
            for rollback in (False, True):
                ids = auth_fixture()
                case = f"{kind}_studio_busy_{'rollback' if rollback else 'commit'}"
                before = facts(ids)
                holder = session(case + "_holder",
                    f"SELECT to_jsonb(s) FROM public.studios s WHERE id='{ids['studio']}' FOR UPDATE;",
                    hold=True, role="postgres")
                await_result(holder)
                writer = session(case + "_writer", auth_command(ids, kind))
                finish(writer, expected_error=("P0001", "LEAD_STUDIO_BUSY"))
                require("ERROR:  P0001: LEAD_STUDIO_BUSY" in writer["errors"],
                        "Studio contention did not return the exact domain error")
                require(holder["process"].poll() is None and facts(ids) == before,
                        "Studio contention waited for settlement or committed partial effects")
                settle(holder, rollback=rollback)
                # Reuse the exact follow-up operation key and requested target.
                retried = session(case + "_retry", auth_command(ids, kind))
                finish(retried)
                state = check_auth_outcome(ids, kind, deleted=False, changed=True)
                passed(case, error="LEAD_STUDIO_BUSY", activities=state["activities"])

        def cleared_facts(ids):
            tables = ("leads", "lead_activities", "lead_follow_up_operations", "students",
                      "student_program_memberships", "guardians", "programs")
            counts = ",".join(f"'{table}',(SELECT count(*) FROM public.{table} WHERE studio_id='{ids['studio']}')"
                              for table in tables)
            # Membership/link identities are deterministic for this synthetic
            # conversion, so this also detects an orphan link after student deletion.
            namespace = UUID("27c8322f-a4e4-46d7-bfae-018f6b638858")
            student = str(uuid5(namespace, f"{ids['studio']}:{ids['lead']}:student"))
            return json.loads(sql(f"SELECT jsonb_build_object({counts},'student_guardians',"
                                  f"(SELECT count(*) FROM public.student_guardians WHERE student_id='{student}'));"))

        capture_owner = sql("SELECT to_regprocedure('private.workflow_prepare_capture_v1(uuid,uuid[],boolean)') IS NOT NULL;") == "t"
        for command_first in (False, True):
            for rollback in (False, True):
                ids = auth_fixture()
                case = f"enrolled_clear_{'command_first' if command_first else 'clear_first'}_{'rollback' if rollback else 'commit'}"
                command = follow(ids, ids["operation"], "enrolled", actor="actor2")
                clear = f"SELECT public.clear_studio_operational_data_atomic('{ids['studio']}',false); SELECT '{{}}'::jsonb;"
                before = facts(ids)
                first = session(case + "_first", command if command_first else clear, hold=True)
                await_result(first)
                second = session(case + "_second", clear if command_first else command)
                if capture_owner and not command_first:
                    finish(second, expected_error=("P0001", "LEAD_STUDIO_BUSY"))
                    require("ERROR:  P0001: LEAD_STUDIO_BUSY" in second["errors"]
                            and first["process"].poll() is None and facts(ids) == before,
                            "Clear contention waited or committed partial lead effects")
                    blocking = {"kind": "shared_clear_try", "error": "LEAD_STUDIO_BUSY"}
                    settle(first, rollback=rollback)
                    if rollback:
                        # Definite refusal wrote no receipt. Explicit retry keeps
                        # the original operation identity and exact request.
                        retried = session(case + "_retry", command)
                        finish(retried)
                else:
                    blocking = observed_blocker(first, second)
                    settle(first, rollback=rollback)
                    if not command_first and not rollback:
                        finish(second, expected_error=("P0002", "Lead not found for studio"))
                    else:
                        finish(second)
                if not command_first and rollback:
                    state = facts(ids)
                    require(state["lead"]["stage"] == "enrolled" and state["receipts"] == 1
                            and len(state["activities"]) == 2
                            and all(state[key] == 1 for key in ("students", "memberships", "guardians", "links", "audits")),
                            f"Clear rollback did not permit one complete conversion: {state}")
                else:
                    state = cleared_facts(ids)
                    require(all(count == 0 for count in state.values()), f"Operational clear left command effects: {state}")
                passed(case, blocking=blocking, facts=state)

        require(len(results) == 75 and len({row["case"] for row in results}) == 75,
                "Expected all 75 distinct lead command concurrency cases")
        print("[lead command concurrency] PASS 75 cases", flush=True)
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
