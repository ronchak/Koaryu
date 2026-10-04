#!/usr/bin/env python3
"""Prove automation ownership with independent disposable PostgreSQL 17 sessions."""

import hashlib
import json
import os
import queue
import re
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path
from uuid import uuid4

from local_postgres_verification import LocalPostgres, require


def main(arguments):
    require(
        len(arguments) in (3, 4),
        "Expected psql socket port and optional disposable template",
    )
    psql, socket, port = arguments[:3]
    template = arguments[3] if len(arguments) == 4 else "postgres"
    require(
        re.fullmatch(r"[a-z_][a-z0-9_]*", template) is not None,
        "Invalid local template",
    )
    local = LocalPostgres(psql, socket, port, str(Path(socket).parent))
    database = f"koaryu_automation_concurrency_{os.getpid()}"
    children = []
    cases = []
    owned = False

    def sql(statement):
        return local.sql(database, statement)

    def fixture():
        ids = {key: str(uuid4()) for key in ("actor", "studio", "student", "session")}
        ids["email"] = ids["student"] + "@example.invalid"
        sql(f"""BEGIN;
INSERT INTO auth.users(id,email) VALUES('{ids["actor"]}','{ids["actor"]}@example.invalid');
INSERT INTO public.studios(id,name,slug,owner_id,timezone)
VALUES('{ids["studio"]}','Automation concurrency','{ids["studio"]}','{ids["actor"]}','UTC');
INSERT INTO public.staff_roles(studio_id,user_id,role) VALUES('{ids["studio"]}','{ids["actor"]}','admin');
INSERT INTO public.studio_subscriptions(studio_id,status,comped) VALUES('{ids["studio"]}','active',false);
INSERT INTO public.students(id,studio_id,legal_first_name,legal_last_name,email)
VALUES('{ids["student"]}','{ids["studio"]}','Synthetic','Student','{ids["email"]}');
INSERT INTO public.class_sessions(id,studio_id,name,date,start_time,end_time)
VALUES('{ids["session"]}','{ids["studio"]}','Synthetic class',current_date-20,'00:00','01:00');
INSERT INTO public.attendance(studio_id,session_id,student_id,checked_in_at)
VALUES('{ids["studio"]}','{ids["session"]}','{ids["student"]}',now()-INTERVAL '20 days');
SELECT public.save_missed_class_automation_rule_v1('{ids["studio"]}','{ids["actor"]}',0,true,14,'Subject','Body','reply@example.invalid');
COMMIT;""")
        return ids

    def enqueue(ids):
        return f"SELECT public.enqueue_missed_class_automations_v1(1,ARRAY['{ids['email']}']);"

    def claim(ids):
        return f"SELECT public.claim_missed_class_automations_v1(1,ARRAY['{ids['email']}']);"

    def prepare(ids):
        require(
            json.loads(sql(enqueue(ids)))["enqueued"] == 1, "Fixture did not enqueue"
        )
        row = json.loads(sql(claim(ids)))["items"][0]
        ids.update(delivery=row["id"], token=row["claim_token"])

    def begin(ids):
        return f"SELECT public.begin_missed_class_automation_v1('{ids['delivery']}','{ids['token']}');"

    def settle(ids, outcome="accepted"):
        return f"SELECT public.settle_missed_class_automation_v1('{ids['delivery']}','{ids['token']}','{outcome}');"

    def suppress(ids):
        return f"SELECT public.suppress_missed_class_automation_v1('{ids['optout']}');"

    def session(name, statement, hold=False, role="service_role"):
        name = f"automation_{os.getpid()}_{name}"[:63]
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
        print(f"[automation concurrency] PASS {name}", flush=True)

    def suppressible():
        ids = fixture()
        prepare(ids)
        ids["optout"] = json.loads(sql(begin(ids)))["message"]["unsubscribe_token"]
        sql(settle(ids))
        student = str(uuid4())
        sql(f"""INSERT INTO public.students(id,studio_id,legal_first_name,legal_last_name,email)
VALUES('{student}','{ids["studio"]}','Second','Student','{ids["email"]}');
INSERT INTO public.attendance(studio_id,session_id,student_id,checked_in_at)
VALUES('{ids["studio"]}','{ids["session"]}','{student}',now()-INTERVAL '20 days');""")
        prepare(ids)
        return ids

    try:
        local.sql("postgres", f"CREATE DATABASE {database} TEMPLATE {template};")
        owned = True
        require(
            sql(
                "SELECT to_regprocedure('public.claim_missed_class_automations_v1(integer,text[])') IS NOT NULL;"
            )
            == "t",
            "Automation migration must be present in disposable template",
        )
        ids = fixture()
        first = session("enqueue_owner", enqueue(ids), hold=True)
        require(ready(first)["enqueued"] == 1, "First enqueue did not own one row")
        second = session("enqueue_competitor", enqueue(ids))
        require(finished(second)["enqueued"] == 0, "Competing enqueue duplicated work")
        release(first)
        passed("enqueue ownership and duplicate prevention")

        first = session("claim_owner", claim(ids), hold=True)
        claimed = ready(first)["items"][0]
        second = session("claim_competitor", claim(ids))
        require(finished(second)["items"] == [], "Two claimers owned one row")
        release(first)
        ids.update(delivery=claimed["id"], token=claimed["claim_token"])
        passed("claim skip locked ownership")

        first = session("begin_owner", begin(ids), hold=True)
        require(ready(first)["ready"], "First begin not ready")
        second = session("begin_competitor", begin(ids))
        observation = blocked(first, second)
        release(first)
        require(not finished(second)["ready"], "Second begin duplicated dispatch")
        passed("one sending transition per claim", lock=observation)
        sql(settle(ids))

        for rollback in (False, True):
            ids = fixture()
            prepare(ids)
            sql(begin(ids))
            first = session(f"settle_owner_{rollback}", settle(ids), hold=True)
            require(ready(first)["updated"], "First settle not owned")
            second = session(f"settle_competitor_{rollback}", settle(ids, "unknown"))
            observation = blocked(first, second)
            release(first, rollback=rollback)
            result2 = finished(second)
            require(
                result2["updated"] is rollback
                and result2["state"] == ("unknown" if rollback else "accepted"),
                "Competing settle result incorrect",
            )
            passed(
                f"settle {'rollback' if rollback else 'commit'} ownership",
                lock=observation,
            )

        for begin_first in (False, True):
            for rollback in (False, True):
                ids = suppressible()
                first_sql, second_sql = (
                    (begin(ids), suppress(ids))
                    if begin_first
                    else (suppress(ids), begin(ids))
                )
                first = session(
                    f"optout_owner_{begin_first}_{rollback}", first_sql, hold=True
                )
                ready(first)
                second = session(f"optout_waiter_{begin_first}_{rollback}", second_sql)
                observation = blocked(first, second, advisory=True)
                release(first, rollback=rollback)
                returned = finished(second)
                if begin_first:
                    require(returned["success"], "Suppression did not persist")
                    if rollback:
                        require(
                            not json.loads(sql(begin(ids)))["ready"],
                            "Suppression failed after rolled-back begin",
                        )
                else:
                    require(
                        returned["ready"] is rollback,
                        "Suppression and begin ordering violated",
                    )
                passed(
                    f"{'begin' if begin_first else 'optout'} first {'rollback' if rollback else 'commit'}",
                    lock=observation,
                )

        for initial in (True, False):
            provider = "synthetic:" + uuid4().hex
            expected = 0 if initial else 1
            if not initial:
                sql(
                    f"SELECT public.save_automation_email_credential_v1('{provider}',0,'synthetic-initial');"
                )
            first = session(
                f"credential_owner_{initial}",
                f"SELECT public.save_automation_email_credential_v1('{provider}',{expected},'synthetic-new');",
                hold=True,
            )
            ready(first)
            second = session(
                f"credential_competitor_{initial}",
                f"SELECT public.save_automation_email_credential_v1('{provider}',{expected},'synthetic-stale');",
            )
            observation = blocked(first, second)
            release(first)
            finished(second, expected_error="AUTOMATION_EMAIL_CREDENTIAL_CONFLICT")
            current = json.loads(
                sql(f"SELECT public.get_automation_email_credential_v1('{provider}');")
            )
            require(
                current["encrypted_credentials"] == "synthetic-new"
                and current["revision"] == expected + 1,
                "CAS overwrote fresh credential",
            )
            passed(
                f"credential {'insert' if initial else 'rotation'} CAS",
                lock=observation,
            )

        for rollback in (False, True):
            ids = fixture()
            prepare(ids)
            first = session(
                f"contact_owner_{rollback}",
                f"UPDATE public.students SET email='new@example.invalid' WHERE id='{ids['student']}'; SELECT '{{\"changed\":true}}'::jsonb;",
                hold=True,
            )
            ready(first)
            second = session(f"contact_waiter_{rollback}", begin(ids))
            observation = blocked(first, second)
            release(first, rollback=rollback)
            answer = finished(second)
            require(
                answer["ready"]
                and answer["message"]["recipient_email"]
                == (ids["email"] if rollback else "new@example.invalid"),
                "Begin used stale contact",
            )
            passed(
                f"contact {'rollback' if rollback else 'commit'} revalidation",
                lock=observation,
            )

        for rollback in (False, True):
            ids = fixture()
            prepare(ids)
            first = session(
                f"entitlement_owner_{rollback}",
                f"UPDATE public.studio_subscriptions SET status='canceled' WHERE studio_id='{ids['studio']}'; SELECT '{{\"changed\":true}}'::jsonb;",
                hold=True,
            )
            ready(first)
            second = session(f"entitlement_waiter_{rollback}", begin(ids))
            observation = blocked(first, second)
            release(first, rollback=rollback)
            answer = finished(second)
            require(answer["ready"] is rollback, "Begin used stale entitlement")
            passed(
                f"entitlement {'rollback' if rollback else 'commit'} revalidation",
                lock=observation,
            )

        for rollback in (False, True):
            ids = fixture()
            second_admin = str(uuid4())
            sql(
                f"INSERT INTO auth.users(id,email,email_confirmed_at) VALUES('{second_admin}','{second_admin}@example.invalid',now()); "
                f"INSERT INTO public.staff_roles(studio_id,user_id,role) VALUES('{ids['studio']}','{second_admin}','admin'); "
                f"UPDATE public.studios SET owner_id='{second_admin}' WHERE id='{ids['studio']}';"
            )
            first = session(
                f"admin_owner_{rollback}",
                f"UPDATE public.staff_roles SET role='instructor' WHERE studio_id='{ids['studio']}' AND user_id='{ids['actor']}'; SELECT '{{\"changed\":true}}'::jsonb;",
                hold=True,
            )
            ready(first)
            second = session(
                f"admin_waiter_{rollback}",
                f"SELECT public.save_missed_class_automation_rule_v1('{ids['studio']}','{ids['actor']}',1,false,14,'Changed','Changed','reply@example.invalid');",
            )
            observation = blocked(first, second)
            release(first, rollback=rollback)
            if rollback:
                require(
                    finished(second)["rule"]["revision"] == 2,
                    "Admin rollback did not allow save",
                )
            else:
                finished(second, expected_error="Automation admin permission required")
            passed(
                f"admin demotion {'rollback' if rollback else 'commit'} revalidation",
                lock=observation,
            )

        for begin_first in (False, True):
            for rollback in (False, True):
                ids = fixture()
                prepare(ids)
                new_session = str(uuid4())
                sql(
                    f"INSERT INTO public.class_sessions(id,studio_id,name,date,start_time,end_time) VALUES('{new_session}','{ids['studio']}','Recent class',current_date-1,'00:00','01:00');"
                )
                attendance = f"INSERT INTO public.attendance(studio_id,session_id,student_id,checked_in_at) VALUES('{ids['studio']}','{new_session}','{ids['student']}',now()-INTERVAL '1 day'); SELECT '{{\"inserted\":true}}'::jsonb;"
                first_sql, second_sql = (
                    (begin(ids), attendance)
                    if begin_first
                    else (attendance, begin(ids))
                )
                first = session(
                    f"attendance_owner_{begin_first}_{rollback}", first_sql, hold=True
                )
                ready(first)
                second = session(
                    f"attendance_waiter_{begin_first}_{rollback}", second_sql
                )
                observation = blocked(first, second)
                release(first, rollback=rollback)
                answer = finished(second)
                if begin_first:
                    require(
                        answer["inserted"], "Attendance insert failed after boundary"
                    )
                    if rollback:
                        require(
                            not json.loads(sql(begin(ids)))["ready"],
                            "Rolled-back begin missed newly committed attendance",
                        )
                else:
                    require(
                        answer["ready"] is rollback,
                        "Begin ignored newly committed attendance",
                    )
                passed(
                    f"{'begin' if begin_first else 'new attendance'} first {'rollback' if rollback else 'commit'}",
                    lock=observation,
                )

        ids = fixture()
        prepare(ids)
        sql(
            f"UPDATE public.studio_subscriptions SET status='trialing',trial_end=clock_timestamp()+INTERVAL '2 seconds' WHERE studio_id='{ids['studio']}';"
        )
        first = session(
            "trial_expiry_holder",
            f"SELECT id FROM public.students WHERE id='{ids['student']}' FOR UPDATE; SELECT '{{\"locked\":true}}'::jsonb;",
            hold=True,
        )
        ready(first)
        second = session("trial_expiry_waiter", begin(ids))
        observation = blocked(first, second)
        sql("SELECT pg_sleep(2.1);")
        release(first)
        answer = finished(second)
        require(
            not answer["ready"] and answer["reason"] == "subscription_required",
            "Begin used transaction-start time after trial expired",
        )
        passed("trial expires while begin waits", lock=observation)

        sql("UPDATE public.automation_rules SET enabled=false;")
        busy = [fixture() for _ in range(11)]
        busy_ids = ",".join("'" + item["studio"] + "'" for item in busy[:10])
        sql(
            f"UPDATE public.automation_rules SET last_evaluated_at='2000-01-01' WHERE studio_id IN ({busy_ids}); "
            f"UPDATE public.automation_rules SET last_evaluated_at='2001-01-01' WHERE studio_id='{busy[-1]['studio']}';"
        )
        first = session(
            "busy_studio_parents",
            f"SELECT id FROM public.studios WHERE id IN ({busy_ids}) ORDER BY id FOR UPDATE; SELECT '{{\"locked\":true}}'::jsonb;",
            hold=True,
        )
        ready(first)
        second = session("busy_studio_first_scan", enqueue(busy[-1]))
        answer = finished(second)
        require(
            answer["enqueued"] == 0 and answer["has_more"],
            "Busy studio scan should rotate without insert",
        )
        third = session("busy_studio_next_scan", enqueue(busy[-1]))
        require(
            finished(third)["enqueued"] == 1,
            "Ten busy studios starved an eligible eleventh studio",
        )
        release(first)
        passed("busy studios rotate without starving eligible studio")

        ids = fixture()
        for _ in range(2):
            student = str(uuid4())
            sql(
                f"INSERT INTO public.students(id,studio_id,legal_first_name,legal_last_name,email) VALUES('{student}','{ids['studio']}','Expired','Claim','{ids['email']}'); "
                f"INSERT INTO public.attendance(studio_id,session_id,student_id,checked_in_at) VALUES('{ids['studio']}','{ids['session']}','{student}',now()-INTERVAL '20 days');"
            )
        answer = json.loads(
            sql(
                f"SELECT public.enqueue_missed_class_automations_v1(10,ARRAY['{ids['email']}']);"
            )
        )
        require(answer["enqueued"] == 3, "Expected three reclaim fixtures")
        answer = json.loads(
            sql(
                f"SELECT public.claim_missed_class_automations_v1(10,ARRAY['{ids['email']}']);"
            )
        )
        require(len(answer["items"]) == 3, "Expected three initial claims")
        sql(
            f"UPDATE public.automation_deliveries SET lease_expires_at=now()-INTERVAL '1 second' WHERE studio_id='{ids['studio']}';"
        )
        answer = json.loads(sql(claim(ids)))
        require(
            len(answer["items"]) == 1 and answer["has_more"],
            "Expired claims missing from has_more",
        )
        passed("expired claimed rows remain actionable in has_more")

        # Keep the production helper's OID, signature and ACL while instrumenting
        # only this owned disposable database. Raw caller reference timestamps,
        # not call order, determine the synthetic side of midnight.
        helper_signature = "private.missed_class_automation_candidates(uuid,integer,uuid,uuid,timestamptz)"
        helper_definition = sql(
            f"SELECT pg_get_functiondef('{helper_signature}'::regprocedure);"
        )
        helper_acl = sql(
            f"SELECT proacl::text FROM pg_proc WHERE oid='{helper_signature}'::regprocedure;"
        )
        source_definition = helper_definition.replace(
            "FUNCTION private.missed_class_automation_candidates(",
            "FUNCTION private.automation_candidates_clock_test_source(",
            1,
        )
        require(
            source_definition != helper_definition,
            "Clock source copy did not rename the helper",
        )
        wrapper_header = helper_definition.split(" LANGUAGE sql", 1)[0]
        require(
            wrapper_header != helper_definition,
            "Unexpected eligibility helper language",
        )
        sql(
            source_definition
            + ";\n"
            + """
REVOKE ALL ON FUNCTION private.automation_candidates_clock_test_source(uuid,integer,uuid,uuid,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION private.automation_candidates_clock_test_source(uuid,integer,uuid,uuid,timestamptz) TO service_role;
CREATE TABLE private.automation_clock_test_control(studio_id uuid PRIMARY KEY,cutoff timestamptz);
CREATE TABLE private.automation_clock_test_observations(studio_id uuid,provided_at timestamptz,observed_at timestamptz,mapped_at timestamptz);
REVOKE ALL ON private.automation_clock_test_control,private.automation_clock_test_observations FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON private.automation_clock_test_control TO service_role;
GRANT INSERT ON private.automation_clock_test_observations TO service_role;
"""
        )
        sql(
            wrapper_header
            + """ LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $clock_test$
DECLARE v_cutoff timestamptz; v_mapped timestamptz;
BEGIN
    SELECT cutoff INTO v_cutoff FROM private.automation_clock_test_control WHERE studio_id=p_studio_id;
    IF FOUND THEN
        v_mapped:=CASE WHEN v_cutoff IS NOT NULL AND p_reference_at>=v_cutoff
            THEN '2020-01-15 08:00:01+00'::timestamptz ELSE '2020-01-15 07:59:59+00'::timestamptz END;
        INSERT INTO private.automation_clock_test_observations VALUES(p_studio_id,p_reference_at,clock_timestamp(),v_mapped);
    ELSE v_mapped:=p_reference_at;
    END IF;
    RETURN QUERY SELECT * FROM private.automation_candidates_clock_test_source(
        p_studio_id,p_inactivity_days,p_student_id,p_delivery_id,v_mapped);
END $clock_test$;"""
        )
        try:
            for rollover in ("hold", "birthday", "gap"):
                ids = fixture()
                guardian_email = "guardian-" + ids["student"] + "@example.invalid"
                sql(
                    f"UPDATE public.studios SET timezone='America/Los_Angeles' WHERE id='{ids['studio']}'; "
                    f"UPDATE public.class_sessions SET date='2019-12-31' WHERE id='{ids['session']}'; "
                    f"UPDATE public.attendance SET checked_in_at='2019-12-31 08:00:00+00' WHERE student_id='{ids['student']}';"
                )
                if rollover == "birthday":
                    guardian = str(uuid4())
                    sql(
                        f"UPDATE public.students SET date_of_birth='2002-01-15' WHERE id='{ids['student']}'; "
                        f"INSERT INTO public.guardians(id,studio_id,first_name,last_name,email,is_primary_contact) VALUES('{guardian}','{ids['studio']}','Synthetic','Guardian','{guardian_email}',true); "
                        f"INSERT INTO public.student_guardians(student_id,guardian_id) VALUES('{ids['student']}','{guardian}');"
                    )
                prepare(ids)
                if rollover == "hold":
                    sql(
                        f"UPDATE public.students SET hold_start_date='2020-01-15' WHERE id='{ids['student']}';"
                    )
                sql(
                    f"INSERT INTO private.automation_clock_test_control VALUES('{ids['studio']}',NULL);"
                )
                before_email = (
                    guardian_email if rollover == "birthday" else ids["email"]
                )
                lock_statement = (
                    f"SELECT pg_advisory_xact_lock(hashtextextended('{ids['studio']}:{before_email}',0)); "
                    "SELECT '{\"locked\":true}'::jsonb;"
                )
                first = session(f"rollover_{rollover}_lock", lock_statement, hold=True)
                ready(first)
                other_lock = None
                if rollover == "birthday":
                    other_lock = session(
                        "rollover_new_recipient_lock",
                        f"SELECT pg_advisory_xact_lock(hashtextextended('{ids['studio']}:{ids['email']}',0)); SELECT '{{\"locked\":true}}'::jsonb;",
                        hold=True,
                    )
                    ready(other_lock)
                second = session(f"rollover_{rollover}_begin", begin(ids))
                observation = blocked(first, second, advisory=True)
                sql(
                    f"UPDATE private.automation_clock_test_control SET cutoff=clock_timestamp() WHERE studio_id='{ids['studio']}';"
                )
                release(first)
                answer = finished(second)
                clocks = json.loads(
                    sql(
                        f"SELECT jsonb_build_object('count',count(*),'before',count(*) FILTER(WHERE o.provided_at<c.cutoff),"
                        "'after',count(*) FILTER(WHERE o.provided_at>=c.cutoff),'supplied_before_observed',bool_and(o.provided_at<=o.observed_at),"
                        "'dates',jsonb_agg((o.mapped_at AT TIME ZONE 'America/Los_Angeles')::date ORDER BY o.observed_at)) "
                        "FROM private.automation_clock_test_observations o JOIN private.automation_clock_test_control c USING(studio_id) "
                        f"WHERE o.studio_id='{ids['studio']}';"
                    )
                )
                require(
                    clocks
                    == {
                        "count": 2,
                        "before": 1,
                        "after": 1,
                        "supplied_before_observed": True,
                        "dates": ["2020-01-14", "2020-01-15"],
                    },
                    f"Begin did not capture a fresh clock after its observed advisory wait: {clocks}",
                )
                state = json.loads(
                    sql(
                        f"SELECT jsonb_build_object('state',state,'attempts',attempts,'attempted',attempted_at IS NOT NULL,'token',unsubscribe_token IS NOT NULL) FROM public.automation_deliveries WHERE id='{ids['delivery']}';"
                    )
                )
                if rollover == "gap":
                    require(
                        answer["ready"] and answer["message"]["days_absent"] == 15,
                        "Dispatch used previous-day attendance gap",
                    )
                else:
                    require(
                        not answer["ready"]
                        and answer["reason"]
                        == ("on_hold" if rollover == "hold" else "contact_changed")
                        and state
                        == {
                            "state": "queued",
                            "attempts": 0,
                            "attempted": False,
                            "token": False,
                        },
                        "Rollover must defer without spending an episode",
                    )
                if other_lock:
                    # Begin returned while the new key is still held. It did not
                    # dispatch under the old key or acquire a second key.
                    require(
                        other_lock["process"].poll() is None,
                        "Second recipient lock was not retained",
                    )
                    release(other_lock)
                    sql(
                        f"UPDATE public.automation_deliveries SET next_attempt_at=now() WHERE id='{ids['delivery']}';"
                    )
                    new_claim = json.loads(sql(claim(ids)))["items"][0]
                    require(
                        new_claim["id"] == ids["delivery"],
                        "Birthday deferral lost its stable unsent identity",
                    )
                    ids["token"] = new_claim["claim_token"]
                    resumed = json.loads(sql(begin(ids)))
                    require(
                        resumed["ready"]
                        and resumed["message"]["recipient_email"] == ids["email"],
                        "Deferred birthday route did not recover on a later claim",
                    )
                passed(
                    f"{rollover} rollover after observed advisory wait",
                    lock=observation,
                    clock=clocks,
                )
        finally:
            sql(helper_definition)
            require(
                sql(f"SELECT pg_get_functiondef('{helper_signature}'::regprocedure);")
                == helper_definition,
                "Clock instrumentation did not restore the exact helper definition",
            )
            require(
                sql(
                    f"SELECT proacl::text FROM pg_proc WHERE oid='{helper_signature}'::regprocedure;"
                )
                == helper_acl,
                "Clock instrumentation changed helper privileges",
            )
            sql(
                "DROP FUNCTION private.automation_candidates_clock_test_source(uuid,integer,uuid,uuid,timestamptz); "
                "DROP TABLE private.automation_clock_test_observations,private.automation_clock_test_control;"
            )

        for expiry in ("trial", "claim"):
            ids = fixture()
            prepare(ids)
            if expiry == "trial":
                sql(
                    f"UPDATE public.studio_subscriptions SET status='trialing',trial_end=clock_timestamp()+INTERVAL '2 seconds' WHERE studio_id='{ids['studio']}';"
                )
            else:
                sql(
                    f"UPDATE public.automation_deliveries SET lease_expires_at=clock_timestamp()+INTERVAL '2 seconds' WHERE id='{ids['delivery']}';"
                )
            first = session(
                f"advisory_{expiry}_holder",
                f"SELECT pg_advisory_xact_lock(hashtextextended('{ids['studio']}:{ids['email']}',0)); SELECT '{{\"locked\":true}}'::jsonb;",
                hold=True,
            )
            ready(first)
            second = session(f"advisory_{expiry}_waiter", begin(ids))
            observation = blocked(first, second, advisory=True)
            sql("SELECT pg_sleep(2.1);")
            release(first)
            answer = finished(second)
            require(
                not answer["ready"]
                and (expiry == "claim" or answer["reason"] == "subscription_required"),
                "Expired eligibility survived the final advisory wait",
            )
            require(
                sql(
                    f"SELECT attempts=0 AND attempted_at IS NULL AND unsubscribe_token IS NULL FROM public.automation_deliveries WHERE id='{ids['delivery']}';"
                )
                == "t",
                "Expiry after advisory wait spent an episode",
            )
            passed(f"{expiry} expires during recipient advisory wait", lock=observation)

        require(len(cases) == 29, "Expected 29 concurrency cases")
        evidence = {
            "script_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            "cases": cases,
        }
        (local.temporary / "automation-concurrency-evidence.json").write_text(
            json.dumps(evidence, indent=2) + "\n"
        )
        print("[automation concurrency] PASS 29 PostgreSQL session cases", flush=True)
    finally:
        for item in children:
            process = item["process"]
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
