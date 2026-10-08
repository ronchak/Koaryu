#!/usr/bin/env python3
"""Prove rank authority on one guarded, explicitly owned PostgreSQL 17 clone.

Only the disposable Unix socket verifier cluster is accepted. No provider,
credentials, env files, Docker, base schema writes, history registration or mail.
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
from pathlib import Path
from uuid import uuid4

from local_postgres_verification import LocalPostgres, require

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = (
    ROOT / "supabase/migrations/20261005105341_automation_workflow_graph_v57.sql"
)
CONTRACT = ROOT / "supabase/verification/workflow_rank_context_contract.sql"


def quote(value):
    if value is None:
        return "NULL"
    if isinstance(value, (dict, list)):
        value = json.dumps(value, separators=(",", ":"))
    return "'" + str(value).replace("'", "''") + "'"


def definition(path, name):
    source = path.read_text()
    pattern = re.compile(
        r"CREATE (?:OR REPLACE )?FUNCTION "
        + re.escape(name)
        + r"\(.*?AS (\$[\w]*\$).*?\1;",
        re.DOTALL,
    )
    matches = list(pattern.finditer(source))
    require(len(matches) == 1, f"Expected exact retained definition {name}")
    return re.sub(
        r"^CREATE (?:OR REPLACE )?FUNCTION", "CREATE OR REPLACE FUNCTION", matches[0][0]
    )


def main(arguments):
    require(len(arguments) == 4, "Expected psql socket port unique-owned-clone-name")
    psql, socket, port, database = arguments
    require(
        re.fullmatch(r"koaryu_rank_context_[a-z0-9_]+", database),
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
    require(len(historical) == 151, "Expected 151 immutable migrations")

    def sql(statement):
        return local.sql(database, statement)

    def passed(name, **evidence):
        cases.append({"case": name, "outcome": "passed", **evidence})
        print("[rank context] PASS " + name, flush=True)

    def fixture():
        return json.loads(sql("SELECT rank_proof.rank_fixture();"))

    def gen(x, membership=None):
        member = x["membership"] if membership is None else membership
        return int(
            sql(
                f"SELECT private.workflow_rank_context_generation_v1({quote(x['studio'])},{quote(x['student'])},{quote(member)});"
            )
        )

    def profile(x, rank="rank1"):
        return f"SELECT to_jsonb(r) FROM public.mutate_student_program_membership_atomic({quote(x['student'])},{quote(x['studio'])},{quote(x['actor'])},'update',{quote(x['membership'])},{quote({'current_belt_rank_id': x[rank]})}) r;"

    def approve(x):
        return f"SELECT rank_proof.rank_approve({quote(x)});"

    def admission(x):
        return f"SELECT 1 FROM public.students WHERE id={quote(x['student'])} FOR UPDATE;SELECT jsonb_build_object('generation',private.workflow_rank_context_generation_v1({quote(x['studio'])},{quote(x['student'])},{quote(x['membership'])}));"

    def workflow(x, kind="student.promoted"):
        return sql(
            f"SET ROLE service_role;SELECT rank_proof.rank_workflow({quote(x)},{quote(kind)});"
        )

    def lock_row(table, identity):
        return f"SELECT 1 FROM {table} WHERE id={quote(identity)} FOR UPDATE;SELECT '{{}}'::JSONB;"

    def session(name, statement, hold=False, role="service_role"):
        name = f"rank_context_{os.getpid()}_{name}_{len(children)}"[:63]
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

    def preinstall_fixture(with_admin=True):
        x = {
            k: str(uuid4())
            for k in (
                "studio",
                "actor",
                "program",
                "program2",
                "ladder",
                "ladder2",
                "rank0",
                "other1",
                "student",
                "membership",
                "membership2",
            )
        }
        staff_insert = (
            f"INSERT INTO public.staff_roles(studio_id,user_id,role) VALUES('{x['studio']}','{x['actor']}','admin');"
            if with_admin
            else ""
        )
        sql(f"""BEGIN;
INSERT INTO auth.users(id,email,email_confirmed_at) VALUES('{x["actor"]}','{x["actor"]}@example.invalid',clock_timestamp());
INSERT INTO public.studios(id,name,slug,owner_id) VALUES('{x["studio"]}','Cached rank proof','{x["studio"]}','{x["actor"]}');
{staff_insert}
INSERT INTO public.programs(id,studio_id,name) VALUES('{x["program"]}','{x["studio"]}','First'),('{x["program2"]}','{x["studio"]}','Second');
INSERT INTO public.belt_ladders(id,studio_id,name,program_id) VALUES('{x["ladder"]}','{x["studio"]}','First','{x["program"]}'),('{x["ladder2"]}','{x["studio"]}','Second','{x["program2"]}');
INSERT INTO public.belt_ranks(id,studio_id,ladder_id,name,display_order) VALUES('{x["rank0"]}','{x["studio"]}','{x["ladder"]}','First',0),('{x["other1"]}','{x["studio"]}','{x["ladder2"]}','Other',0);
INSERT INTO public.students(id,studio_id,legal_first_name,legal_last_name,status,program_id,current_belt_rank_id) VALUES('{x["student"]}','{x["studio"]}','Cached','Student','active','{x["program"]}','{x["rank0"]}');
INSERT INTO public.student_program_memberships(id,studio_id,student_id,program_id,status,current_belt_rank_id) VALUES('{x["membership"]}','{x["studio"]}','{x["student"]}','{x["program"]}','active','{x["rank0"]}'),('{x["membership2"]}','{x["studio"]}','{x["student"]}','{x["program2"]}','paused','{x["other1"]}');
COMMIT;""")
        return x

    try:
        require(
            local.sql(
                "postgres",
                f"SELECT count(*) FROM pg_database WHERE datname={quote(database)};",
            )
            == "0",
            "Owned name exists",
        )
        print("[rank context] announced owned clone " + database, flush=True)
        local.sql("postgres", f"CREATE DATABASE {database} TEMPLATE postgres;")
        owned = True

        def preserved_functions():
            return sql("""SELECT jsonb_object_agg(n.nspname||'.'||p.proname,jsonb_build_object('definition',pg_get_functiondef(p.oid),'acl',p.proacl::TEXT))
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE
(n.nspname='public' AND p.proname IN ('write_student_profile_v2_atomic','import_student_row_atomic','record_student_rank_transition_v3',
'sync_belt_ladder_ranks_internal','sync_belt_ladder_ranks_v2','validate_student_program_membership','backfill_starting_belt_for_program','backfill_starting_belt_after_rank_delete'))
OR (n.nspname='private' AND p.proname='record_student_rank_transition_v2');""")

        retained_before = preserved_functions()
        old = preinstall_fixture()
        before = sql(
            f"SELECT jsonb_agg(to_jsonb(m) ORDER BY id) FROM public.student_program_memberships m WHERE studio_id={quote(old['studio'])};"
        )

        def malformed_profile_results():
            cases_sql = []
            for owner in ("public", "private"):
                for student, studio, payload, action in (
                    (None, old["studio"], {}, "student.updated"),
                    (old["student"], None, {}, "student.updated"),
                    (old["student"], old["studio"], [], "student.updated"),
                    (
                        "00000000-0000-0000-0000-000000000009",
                        old["studio"],
                        {},
                        "student.created",
                    ),
                ):
                    cases_sql.append(
                        f"SELECT {owner}.write_student_profile_atomic({quote(student)},{quote(studio)},{quote(old['actor'])},{quote(payload)},NULL,'[]',false,{quote(action)});"
                    )
            return sql(
                """CREATE FUNCTION pg_temp.profile_error(statement TEXT) RETURNS JSONB LANGUAGE plpgsql AS $error$
DECLARE code TEXT; message TEXT;
BEGIN
    BEGIN EXECUTE statement; EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS code=RETURNED_SQLSTATE,message=MESSAGE_TEXT;END;
    RETURN jsonb_build_object('code',code,'message',message);
END $error$;
GRANT EXECUTE ON FUNCTION pg_temp.profile_error(TEXT) TO service_role;
SET ROLE service_role;
SELECT jsonb_agg(pg_temp.profile_error(statement) ORDER BY position) FROM unnest(ARRAY["""
                + ",".join(quote(item) for item in cases_sql)
                + "]::TEXT[]) WITH ORDINALITY requests(statement,position);"
            )

        errors_before = malformed_profile_results()
        private_call = f"SELECT to_jsonb(r) FROM private.write_student_profile_atomic('{old['student']}','{old['studio']}','{old['actor']}','{{\"phone\":\"cached private\"}}',NULL,'[]',false,'student.updated') r;"
        public_call = f"SELECT to_jsonb(r) FROM public.write_student_profile_v2_atomic('{old['student']}','{old['studio']}','{old['actor']}','{{\"phone\":\"cached public\"}}',ARRAY['{old['program2']}'::UUID,'{old['program']}'::UUID],'[]',true,'student.updated') r;"
        cached_private = session(
            "cached_private",
            private_call + "COMMIT;BEGIN;SET LOCAL ROLE service_role;",
            hold=True,
        )
        ready(cached_private)
        warm_public = public_call.replace(
            old["program2"] + "'::UUID,'" + old["program"],
            old["program"] + "'::UUID,'" + old["program2"],
        )
        cached_public = session(
            "cached_public",
            warm_public + "COMMIT;BEGIN;SET LOCAL ROLE service_role;",
            hold=True,
        )
        ready(cached_public)
        source_snapshot = (
            "SELECT jsonb_build_object('retained',jsonb_build_object("
            + ",".join(
                quote(table)
                + f",(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY id),'[]') FROM public.{table} r WHERE studio_id='{old['studio']}')"
                for table in (
                    "students",
                    "student_program_memberships",
                    "belt_ranks",
                    "promotions",
                    "audit_logs",
                )
            )
            + "));"
        )
        preceding = session(
            "preceding_source", private_call + source_snapshot, hold=True
        )
        before_install = ready(preceding)
        installer = session(
            "installer",
            "LOCK TABLE public.students IN ACCESS EXCLUSIVE MODE;",
            hold=True,
            role="postgres",
        )
        blocked(preceding, installer)
        release(preceding)
        ready(installer)
        for caller, statement in (
            (cached_private, private_call),
            (cached_public, public_call),
        ):
            caller["process"].stdin.write(statement + "COMMIT;\n")
            caller["process"].stdin.close()
        blocked(installer, cached_private)
        blocked(installer, cached_public)
        for caller in (cached_private, cached_public):
            require(
                sql(
                    f"SELECT count(*) FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE a.application_name='{caller['name']}' AND l.relation='public.students'::REGCLASS AND l.mode='RowShareLock' AND NOT l.granted;"
                )
                == "1",
                "Old owner was not executing its source lock statement",
            )
        installer["process"].stdin.write(
            MIGRATION.read_text()
            + "\nINSERT INTO supabase_migrations.schema_migrations(version,name) VALUES('20261005105341','automation_workflow_graph_v57');\n"
            + source_snapshot
            + "\nSELECT 'RESULT_READY';\n"
        )
        installer["process"].stdin.flush()
        require(
            ready(installer) == before_install,
            "Installation rewrote retained source rows",
        )
        release(installer)
        finished(cached_private)
        finished(cached_public)
        require(
            malformed_profile_results() == errors_before,
            "Malformed profile errors changed",
        )
        passed("retained public and private profile invalid-input errors")
        passed(
            "initial DML boundary waits for preceding source commit and seeds without business-row rewrite"
        )
        require(
            preserved_functions() == retained_before,
            "Preserved wrapper/callback/delegate definitions or ACLs changed",
        )
        passed("exact unchanged wrapper normalizer backfill delegate bodies and ACLs")
        require(
            gen(old) == 1 and gen(old, old["membership2"]) == 1,
            "Cached source body invalidated restored membership rank",
        )
        require(
            sql(
                f"SELECT count(*) FROM private.automation_workflow_events WHERE studio_id={quote(old['studio'])};"
            )
            == "0",
            "Installation generated historical occurrences",
        )
        require(
            sql("SELECT count(*) FROM supabase_migrations.schema_migrations;") == "152",
            "Partial install registered history",
        )
        passed(
            "actual executing cached public and private bodies cross installation under observed RowShareLock waits",
            before_memberships_sha256=hashlib.sha256(before.encode()).hexdigest(),
        )

        setup = CONTRACT.read_text().split("\nDO $$", 1)[0]
        setup = setup.replace("BEGIN;\n", "", 1).replace(
            "SET LOCAL statement_timeout='60s';", ""
        )
        setup = (
            setup.replace(
                "CREATE TEMP TABLE rank_checks", "CREATE TABLE rank_proof.rank_checks"
            )
            .replace("pg_temp.", "rank_proof.")
            .replace("SCHEMA pg_temp", "SCHEMA rank_proof")
        )
        sql(
            "CREATE SCHEMA rank_proof;\n"
            + setup
            + "\nGRANT USAGE ON SCHEMA rank_proof TO service_role;"
        )

        for name in (
            "workflow_rank_context_contract.sql",
            "workflow_domain_capture_contract.sql",
            "workflow_student_payment_capture_contract.sql",
            "belt_test_recipient_contract.sql",
            "record_student_promotion_rpc_contract.sql",
            "student_import_row_atomic_contract.sql",
            "belt_ladder_sync_smoke.sql",
        ):
            path = ROOT / "supabase/verification" / name
            output = sql(path.read_text())
            passed(
                name,
                sha256=hashlib.sha256(path.read_bytes()).hexdigest(),
                output=output,
            )

        frozen = definition(
            ROOT
            / "supabase/migrations/20260814170000_preserve_retained_student_membership_ranks.sql",
            "public.write_student_profile_atomic",
        )
        for outer, use_frozen in (
            ("write_student_profile_atomic", False),
            ("write_student_profile_atomic", True),
            ("write_student_profile_v2_atomic", True),
        ):
            x = fixture()
            sql(f"SET ROLE service_role;SELECT rank_proof.rank_approve({quote(x)});")
            raw = f"SELECT to_jsonb(r) FROM public.{outer}('{x['student']}','{x['studio']}','{x['actor']}','{{\"phone\":\"frozen\"}}',ARRAY['{x['program2']}'::UUID,'{x['program']}'::UUID],'[]',true,'student.updated') r;"
            trace_sql = """CREATE TABLE rank_proof.rank_writes(membership UUID,old_rank UUID,new_rank UUID);
GRANT INSERT,SELECT ON rank_proof.rank_writes TO service_role;
CREATE FUNCTION rank_proof.trace_rank_write() RETURNS TRIGGER LANGUAGE plpgsql AS $trace$
BEGIN INSERT INTO rank_proof.rank_writes VALUES(NEW.id,OLD.current_belt_rank_id,NEW.current_belt_rank_id);RETURN NEW;END $trace$;
CREATE TRIGGER rank_write_proof AFTER UPDATE OF current_belt_rank_id ON public.student_program_memberships
FOR EACH ROW WHEN (OLD.current_belt_rank_id IS DISTINCT FROM NEW.current_belt_rank_id) EXECUTE FUNCTION rank_proof.trace_rank_write();
"""
            output = sql(
                "BEGIN;\n"
                + (frozen if use_frozen else "")
                + "\n"
                + trace_sql
                + "\nSET ROLE service_role;\n"
                + raw
                + f"\nSET CONSTRAINTS private.workflow_rank_deferred IMMEDIATE;SELECT jsonb_build_object('generation',rank_proof.rank_generation({quote(x)}),'other',rank_proof.rank_generation({quote(x)},'membership2'),'rank',(SELECT current_belt_rank_id FROM public.students WHERE id='{x['student']}'),'approval',(SELECT approved_rank_context_generation FROM public.belt_test_recipients WHERE studio_id='{x['studio']}'),'temporary_nulls',(SELECT count(*) FROM rank_proof.rank_writes WHERE old_rank IS NOT NULL AND new_rank IS NULL));ROLLBACK;"
            )
            facts = json.loads(output.splitlines()[-1])
            require(
                facts
                == {
                    "generation": 1,
                    "other": 1,
                    "rank": x["other1"],
                    "approval": 1,
                    "temporary_nulls": 2,
                },
                "Frozen outer restoration changed authority",
            )
            passed(
                ("frozen" if use_frozen else "current")
                + " body restoration through "
                + outer,
                frozen_sha256=hashlib.sha256(frozen.encode()).hexdigest(),
            )

        for rollback in (False, True):
            x = fixture()
            workflow(x, "belt_test.approved")
            holder = session("source_first", profile(x), hold=True)
            ready(holder)
            waiter = session("approval_waits_source", approve(x))
            blocked(holder, waiter)
            require(gen(x) == 1, "Another transaction observed uncommitted authority")
            release(holder, rollback)
            response = finished(waiter)
            recipient = response["payload"]["items"][0]["id"]
            expected = 1 if rollback else 2
            require(
                sql(
                    f"SELECT approved_rank_context_generation FROM public.belt_test_recipients WHERE id='{recipient}';"
                )
                == str(expected),
                "Approval captured stale authority",
            )
            passed(
                "source first then approval " + ("rollback" if rollback else "commit")
            )

            x = fixture()
            workflow(x, "belt_test.approved")
            holder = session("approval_first", approve(x), hold=True)
            ready(holder)
            waiter = session("source_waits_approval", profile(x))
            blocked(holder, waiter)
            release(holder, rollback)
            finished(waiter)
            require(gen(x) == 2, "Source did not advance after approval released")
            require(
                sql(
                    f"SELECT count(*) FROM public.automation_workflow_runs WHERE studio_id='{x['studio']}' AND state<>'cancelled';"
                )
                == "0",
                "Prior approval work stayed pending",
            )
            passed(
                "approval first then source " + ("rollback" if rollback else "commit")
            )

            x = fixture()
            holder = session("source_admission", profile(x), hold=True)
            ready(holder)
            waiter = session("begin_waits_source", admission(x))
            blocked(holder, waiter)
            release(holder, rollback)
            response = finished(waiter)
            require(
                response["generation"] == (1 if rollback else 2),
                "Begin-style reader saw mixed source/generation",
            )
            passed(
                "source first then begin-style admission "
                + ("rollback" if rollback else "commit")
            )

            x = fixture()
            holder = session("begin_first", admission(x), hold=True)
            require(
                ready(holder)["generation"] == 1,
                "Initial begin-style observation wrong",
            )
            waiter = session("source_waits_begin", profile(x))
            blocked(holder, waiter)
            release(holder, rollback)
            finished(waiter)
            require(gen(x) == 2, "Source lost change after admission released")
            passed(
                "begin-style admission first then source "
                + ("rollback" if rollback else "commit")
            )

        x = fixture()
        holder = session(
            "belt_event_independent",
            lock_row("public.belt_test_events", x["event"]),
            hold=True,
        )
        ready(holder)
        finished(session("source_no_event_lock", profile(x)))
        release(holder)
        passed("rank invalidation never takes a student-to-belt-event lock")

        x = fixture()
        before = sql(f"SELECT rank_proof.rank_facts('{x['studio']}');")
        holder = session(
            "studio_parent",
            lock_row("public.studios", x["studio"]),
            hold=True,
            role="postgres",
        )
        ready(holder)
        finished(session("late_studio_refusal", profile(x)), "AUTOMATION_STUDIO_BUSY")
        require(
            sql(f"SELECT rank_proof.rank_facts('{x['studio']}');") == before,
            "Late studio refusal committed source changes",
        )
        release(holder)
        passed(
            "late private state FK uses studio KEY SHARE NOWAIT and rolls source back"
        )

        for rollback in (False, True):
            x = fixture()
            holder = session("source_before_delete", profile(x), hold=True)
            ready(holder)
            waiter = session(
                "studio_delete",
                f"DELETE FROM public.studios WHERE id='{x['studio']}';",
                role="postgres",
            )
            blocked(holder, waiter)
            release(holder, rollback)
            finished(
                waiter,
                "At least one active admin not scheduled for deletion must remain in the studio.",
            )
            require(
                gen(x) == (1 if rollback else 2),
                "Refused studio cascade changed authority",
            )
            passed(
                "source studio ownership precedes retained parent deletion refusal "
                + ("rollback" if rollback else "commit")
            )

            x = fixture()
            holder = session(
                "student_delete_first",
                f"DELETE FROM public.students WHERE id='{x['student']}';",
                hold=True,
                role="postgres",
            )
            ready(holder)
            waiter = session("source_after_delete", profile(x))
            blocked(holder, waiter)
            release(holder, rollback)
            finished(waiter, None if rollback else "Student not found.")
            require(
                sql(
                    f"SELECT generation FROM private.workflow_rank_contexts WHERE studio_id='{x['studio']}' AND student_program_membership_id='{x['membership']}';"
                )
                == "2",
                "Deletion or source failed to preserve generation",
            )
            passed(
                "student deletion first then source "
                + ("rollback" if rollback else "commit")
            )

        for rollback in (False, True):
            x = fixture()
            unmarked = f"SELECT to_jsonb(r) FROM private.write_student_profile_atomic('{x['student']}','{x['studio']}','{x['actor']}',{quote({'current_belt_rank_id': x['rank1']})},ARRAY['{x['program']}'::UUID,'{x['program2']}'::UUID],'[]',true,'student.updated') r;"
            holder = session("deferred_source", unmarked, hold=True)
            ready(holder)
            waiter = session("begin_waits_deferred", admission(x))
            blocked(holder, waiter)
            require(gen(x) == 1, "Deferred source exposed uncommitted authority")
            release(holder, rollback)
            require(
                finished(waiter)["generation"] == (1 if rollback else 2),
                "Deferred reconciliation was not atomic with source commit",
            )
            passed(
                "unknown private boundary then begin-style admission "
                + ("rollback" if rollback else "commit")
            )

            x = fixture()
            holder = session("source_then_student_delete", profile(x), hold=True)
            ready(holder)
            waiter = session(
                "delete_after_source",
                f"DELETE FROM public.students WHERE id='{x['student']}';",
                role="postgres",
            )
            blocked(holder, waiter)
            release(holder, rollback)
            finished(waiter)
            require(
                sql(
                    f"SELECT tombstoned AND generation={2 if rollback else 3} FROM private.workflow_rank_contexts WHERE studio_id='{x['studio']}' AND student_program_membership_id='{x['membership']}';"
                )
                == "t",
                "Delete lost the completed source generation",
            )
            passed(
                "source first then student deletion "
                + ("rollback" if rollback else "commit")
            )

        # Record the actual preparation calls in this rollback-only transaction.
        # The retained-ID welcome and stale sending run must share approval's
        # complete UPDATE union, including its paused historical workflow.
        x = fixture()
        old_workflow = workflow(x)
        sql(
            f"SET ROLE service_role;SELECT rank_proof.rank_transition({quote(x)},'rank1');UPDATE public.automation_workflow_runs SET state='sending',next_due_at=NULL,reason='truthful_sending',claim_token=gen_random_uuid(),lease_expires_at=clock_timestamp()+INTERVAL '5 minutes' WHERE studio_id='{x['studio']}';SELECT public.command_automation_workflow_v1('{x['studio']}','{x['actor']}','{old_workflow}',gen_random_uuid(),3,'pause');"
        )
        welcome = workflow(x, "student.enrolled")
        trace = sql(f"""BEGIN;
CREATE TABLE rank_proof.capture_calls(for_update BOOLEAN,packet JSONB);
GRANT INSERT,SELECT ON rank_proof.capture_calls TO service_role;
ALTER FUNCTION private.workflow_prepare_capture_v1(UUID,UUID[],BOOLEAN) RENAME TO workflow_prepare_capture_original_proof;
CREATE FUNCTION private.workflow_prepare_capture_v1(p_studio_id UUID,p_update_workflow_ids UUID[] DEFAULT '{{}}',p_for_update BOOLEAN DEFAULT false)
RETURNS JSONB LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $trace$
DECLARE packet JSONB;
BEGIN
    packet:=private.workflow_prepare_capture_original_proof(p_studio_id,p_update_workflow_ids,p_for_update);
    INSERT INTO rank_proof.capture_calls VALUES(p_for_update,packet);
    RETURN packet;
END $trace$;
REVOKE ALL ON FUNCTION private.workflow_prepare_capture_v1(UUID,UUID[],BOOLEAN) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION private.workflow_prepare_capture_v1(UUID,UUID[],BOOLEAN) TO service_role;
DELETE FROM public.students WHERE id='{x["student"]}';
SET ROLE service_role;
SELECT to_jsonb(r) FROM private.write_student_profile_atomic('{x["student"]}','{x["studio"]}','{x["actor"]}',
    '{{"legal_first_name":"Retained","legal_last_name":"Identity","current_belt_rank_id":"{x["rank0"]}"}}',ARRAY['{x["program"]}'::UUID],'[]',true,'student.created') r;
SELECT jsonb_build_object('before_welcome',(SELECT count(*) FROM private.automation_workflow_events WHERE studio_id='{x["studio"]}' AND event_type='student.enrolled'));
SELECT rank_proof.rank_approve({quote(x)}::JSONB||jsonb_build_object('membership',(SELECT id FROM public.student_program_memberships WHERE student_id='{x["student"]}' AND program_id='{x["program"]}')));
SELECT jsonb_build_object('calls',(SELECT count(*) FROM rank_proof.capture_calls),'update_only',(SELECT bool_and(for_update) FROM rank_proof.capture_calls),
    'complete_union',(SELECT bool_and(packet->'locked_workflow_ids' @> jsonb_build_array('{old_workflow}'::UUID,'{welcome}'::UUID)) FROM rank_proof.capture_calls),
    'welcome',(SELECT count(*) FROM private.automation_workflow_events WHERE studio_id='{x["studio"]}' AND event_type='student.enrolled'),
    'sending',(SELECT bool_and(state='sending' AND reason='truthful_sending' AND claim_token IS NOT NULL AND cancel_reason='workflow_paused' AND revision=2 AND next_due_at IS NULL) FROM public.automation_workflow_runs WHERE workflow_id='{old_workflow}'),
    'pending',(SELECT count(*) FROM private.workflow_rank_scopes WHERE studio_id='{x["studio"]}'));
ROLLBACK;
""")
        rows = [json.loads(line) for line in trace.splitlines() if line.startswith("{")]
        require(
            any(row == {"before_welcome": 0} for row in rows),
            "Private welcome escaped before final boundary",
        )
        require(
            rows[-1]
            == {
                "calls": 1,
                "update_only": True,
                "complete_union": True,
                "welcome": 1,
                "sending": True,
                "pending": 0,
            },
            "Approval rank/welcome union was incomplete or acquired twice",
        )
        passed(
            "same transaction retained-ID welcome approval and stale sending authority use one complete UPDATE union"
        )

        x = fixture()
        first_workflow, second_workflow = sorted((workflow(x), workflow(x)))
        sql(
            f"SET ROLE service_role;SELECT rank_proof.rank_transition({quote(x)},'rank1');"
        )
        run_id = sql(
            f"SELECT id FROM public.automation_workflow_runs WHERE workflow_id='{first_workflow}';"
        )
        holder = session(
            "higher_workflow",
            lock_row("public.automation_workflows", second_workflow),
            hold=True,
        )
        ready(holder)
        waiter = session(
            "sorted_union",
            f"SELECT to_jsonb(r) FROM rank_proof.rank_transition({quote(x)},'rank0','demotion') r;",
        )
        blocked(holder, waiter)
        finished(
            session(
                "lower_already_owned",
                f"SELECT 1 FROM public.automation_workflows WHERE id='{first_workflow}' FOR UPDATE NOWAIT;",
            ),
            "could not obtain lock",
        )
        finished(
            session(
                "run_not_locked_early",
                f"SELECT 1 FROM public.automation_workflow_runs WHERE id='{run_id}' FOR UPDATE NOWAIT;",
            )
        )
        release(holder)
        finished(waiter)
        require(
            sql(
                f"SELECT count(*) FROM public.automation_workflow_runs WHERE studio_id='{x['studio']}' AND cancel_requested_at IS NOT NULL;"
            )
            == "2",
            "Sorted union did not cancel both workflows",
        )
        passed("sorted final UPDATE workflow union precedes every run lock")

        for rollback in (False, True):
            x = json.loads(sql("SELECT rank_proof.rank_fixture(true);"))
            workflow(x, "belt_test.approved")
            holder = session(
                "rank_delete_first",
                f"DELETE FROM public.belt_ranks WHERE id='{x['rank0']}';",
                hold=True,
                role="postgres",
            )
            ready(holder)
            waiter = session("approval_after_rank_delete", approve(x))
            blocked(holder, waiter)
            release(holder, rollback)
            response = finished(waiter)
            recipient = response["payload"]["items"][0]["id"]
            require(
                sql(
                    f"SELECT approved_rank_context_generation FROM public.belt_test_recipients WHERE id='{recipient}';"
                )
                == ("1" if rollback else "2"),
                "Rank deletion and approval generation separated",
            )
            passed(
                "physical rank delete before approval "
                + ("rollback" if rollback else "commit")
            )

            x = json.loads(sql("SELECT rank_proof.rank_fixture(true);"))
            workflow(x, "belt_test.approved")
            holder = session("approval_before_rank_delete", approve(x), hold=True)
            ready(holder)
            waiter = session(
                "rank_delete_after_approval",
                f"DELETE FROM public.belt_ranks WHERE id='{x['rank0']}';",
                role="postgres",
            )
            blocked(holder, waiter)
            release(holder, rollback)
            finished(waiter)
            require(
                gen(x) == 2, "Physical rank deletion failed to supersede after approval"
            )
            require(
                sql(
                    f"SELECT count(*) FROM public.automation_workflow_runs WHERE studio_id='{x['studio']}' AND state<>'cancelled';"
                )
                == "0",
                "Approval work escaped physical rank supersession",
            )
            passed(
                "approval before physical rank delete "
                + ("rollback" if rollback else "commit")
            )

        x = fixture()
        before = sql(f"SELECT rank_proof.rank_facts('{x['studio']}');")
        holder = session(
            "late_callback_parent",
            lock_row("public.studios", x["studio"]),
            hold=True,
            role="postgres",
        )
        ready(holder)
        finished(
            session(
                "late_callback_fk",
                f"UPDATE public.students SET current_belt_rank_id='{x['rank1']}' WHERE id='{x['student']}';",
            ),
            "AUTOMATION_STUDIO_BUSY",
        )
        require(
            sql(f"SELECT rank_proof.rank_facts('{x['studio']}');") == before,
            "Late callback parent refusal did not roll back its source write",
        )
        release(holder)
        passed("dirty callback refuses a new blocking studio FK after its source write")

        x = fixture()
        before = sql(f"SELECT rank_proof.rank_facts('{x['studio']}');")
        holder = session(
            "clear_first",
            f"SELECT pg_advisory_xact_lock(hashtextextended('koaryu.local-plan-clear:{x['studio']}',0));",
            hold=True,
            role="postgres",
        )
        ready(holder)
        finished(
            session(
                "late_callback_clear",
                f"UPDATE public.students SET current_belt_rank_id='{x['rank1']}' WHERE id='{x['student']}';",
            ),
            "AUTOMATION_STUDIO_BUSY",
        )
        require(
            sql(f"SELECT rank_proof.rank_facts('{x['studio']}');") == before,
            "Late callback clear refusal did not roll back its source write",
        )
        release(holder)
        passed("dirty callback uses shared clear TRY after source ownership")

        for rollback in (False, True):
            x = preinstall_fixture(with_admin=False)
            holder = session(
                "source_before_real_studio_cascade",
                f"UPDATE public.students SET phone='cascade source' WHERE id='{x['student']}';",
                hold=True,
            )
            ready(holder)
            waiter = session(
                "successful_studio_cascade",
                f"DELETE FROM public.studios WHERE id='{x['studio']}';",
                role="postgres",
            )
            blocked(holder, waiter)
            release(holder, rollback)
            finished(waiter)
            require(
                sql(
                    f"SELECT count(*) FROM private.workflow_rank_contexts WHERE studio_id='{x['studio']}';"
                )
                == "0",
                "Successful studio cascade retained context evidence",
            )
            require(
                sql(
                    f"SELECT count(*) FROM private.workflow_rank_scopes WHERE studio_id='{x['studio']}';"
                )
                == "0",
                "Studio deletion reinserted pending callback work",
            )
            passed(
                "source before successful schema-valid no-staff studio cascade "
                + ("rollback" if rollback else "commit")
            )

            x = preinstall_fixture(with_admin=False)
            holder = session(
                "real_studio_cascade_first",
                f"DELETE FROM public.studios WHERE id='{x['studio']}';",
                hold=True,
                role="postgres",
            )
            ready(holder)
            waiter = session(
                "source_after_real_cascade",
                f"UPDATE public.students SET phone='after cascade' WHERE id='{x['student']}';",
            )
            blocked(holder, waiter)
            release(holder, rollback)
            finished(waiter)
            require(
                sql(
                    f"SELECT count(*) FROM private.workflow_rank_contexts WHERE studio_id='{x['studio']}';"
                )
                == ("3" if rollback else "0"),
                "Studio cascade source ordering changed authority retention",
            )
            passed(
                "successful schema-valid no-staff studio cascade before source "
                + ("rollback" if rollback else "commit")
            )

        def replace_approved_target(x):
            return f"DELETE FROM public.belt_ranks WHERE id='{x['rank1']}';INSERT INTO public.belt_ranks(id,studio_id,ladder_id,name,display_order,min_classes,min_months) VALUES('{x['rank1']}','{x['studio']}','{x['ladder']}','Recreated approved target',1,0,0);"

        for legacy in (False, True):
            for rollback in (False, True):
                x = json.loads(
                    sql(f"SELECT rank_proof.rank_fixture({str(legacy).lower()});")
                )
                workflow(x, "belt_test.approved")
                sql("SET ROLE service_role;" + approve(x))
                holder = session(
                    "approved_target_delete_first",
                    replace_approved_target(x),
                    hold=True,
                    role="postgres",
                )
                ready(holder)
                waiter = session("reapprove_after_target_restore", approve(x))
                blocked(holder, waiter)
                release(holder, rollback)
                response = finished(waiter)
                expected = 1 if rollback else 2
                require(
                    gen(x) == expected
                    and response["payload"]["items"][0]["revision"] == expected,
                    "Restored target reapproval did not observe final generation",
                )
                require(
                    sql(
                        f"SELECT count(*) FROM public.automation_workflow_runs WHERE studio_id='{x['studio']}' AND cancel_reason='rank_context_superseded';"
                    )
                    == ("0" if rollback else "1"),
                    "Target deletion cancellation did not follow source commit",
                )
                passed(
                    f"approved target delete restore before reapproval legacy={legacy} rollback={rollback}"
                )

                x = json.loads(
                    sql(f"SELECT rank_proof.rank_fixture({str(legacy).lower()});")
                )
                workflow(x, "belt_test.approved")
                holder = session("approval_before_target_delete", approve(x), hold=True)
                ready(holder)
                waiter = session(
                    "target_delete_after_approval",
                    replace_approved_target(x),
                    role="postgres",
                )
                blocked(holder, waiter)
                release(holder, rollback)
                finished(waiter)
                require(
                    gen(x) == (1 if rollback else 2),
                    "Target deletion used an uncommitted or missed committed approval",
                )
                require(
                    sql(
                        f"SELECT count(*) FROM public.automation_workflow_runs WHERE studio_id='{x['studio']}' AND state='queued';"
                    )
                    == "0",
                    "Current target deletion left old approval queued",
                )
                passed(
                    f"approval before approved target delete restore legacy={legacy} rollback={rollback}"
                )

            x = json.loads(
                sql(f"SELECT rank_proof.rank_fixture({str(legacy).lower()});")
            )
            workflow(x, "belt_test.approved")
            sql("SET ROLE service_role;" + approve(x))
            holder = session(
                "target_event_lock",
                lock_row("public.belt_test_events", x["event"]),
                hold=True,
            )
            ready(holder)
            finished(
                session(
                    "target_delete_without_event_lock",
                    replace_approved_target(x),
                    role="postgres",
                )
            )
            require(
                gen(x) == 2,
                "Approved target observer failed while an independent event lock was held",
            )
            release(holder)
            passed(f"approved target observer acquires no event lock legacy={legacy}")

            # Inject a test-only barrier at the exact cursor-to-source-lock seam.
            # All predicates and the NOWAIT recheck remain the installed body.
            x = json.loads(
                sql(f"SELECT rank_proof.rank_fixture({str(legacy).lower()});")
            )
            workflow(x, "belt_test.approved")
            sql("SET ROLE service_role;" + approve(x))
            observer = sql(
                "SELECT pg_get_functiondef('public.reassign_memberships_before_belt_rank_delete()'::REGPROCEDURE);"
            )
            seam = "    LOOP\n        IF NOT v_context.current_rank_reference THEN"
            require(observer.count(seam) == 1, "Target observer proof seam drifted")
            key = "rank_context_target_cursor:" + x["student"]
            instrumented = observer.replace(
                seam,
                "    LOOP\n        IF v_context.student_id='"
                + x["student"]
                + "'::UUID AND NOT v_context.current_rank_reference THEN\n            PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('"
                + key
                + "',0));\n        END IF;\n        IF NOT v_context.current_rank_reference THEN",
                1,
            )
            barrier = session(
                "target_cursor_barrier",
                f"SELECT pg_advisory_xact_lock(hashtextextended('{key}',0));",
                hold=True,
                role="postgres",
            )
            ready(barrier)
            deleter = session(
                "target_cursor_old_generation",
                instrumented
                + f";\nDELETE FROM public.belt_ranks WHERE id='{x['rank1']}';SET CONSTRAINTS private.workflow_rank_deferred IMMEDIATE;SELECT jsonb_build_object('generation',rank_proof.rank_generation({quote(x)}),'target_deleted',NOT EXISTS(SELECT 1 FROM public.belt_ranks WHERE id='{x['rank1']}'));",
                hold=True,
                role="postgres",
            )
            blocked(barrier, deleter)
            if legacy:
                change = f"SELECT to_jsonb(r) FROM private.write_student_profile_atomic('{x['student']}','{x['studio']}','{x['actor']}',{quote({'current_belt_rank_id': x['rank2']})},NULL,'[]',false,'student.updated') r;"
            else:
                change = profile(x, "rank2")
            finished(session("new_generation_after_cursor", change))
            require(
                gen(x) == 2,
                "Competing source did not commit its new generation before observer recheck",
            )
            before_delete = sql(f"SELECT rank_proof.rank_facts('{x['studio']}');")
            release(barrier)
            observed = ready(deleter)
            require(
                observed == {"generation": 2, "target_deleted": True},
                "Instrumented observer advanced a stale cursor generation",
            )
            release(deleter, rollback=True)
            require(
                gen(x) == 2
                and sql(f"SELECT rank_proof.rank_facts('{x['studio']}');")
                == before_delete,
                "Stale cursor approval invalidated a newer generation",
            )
            require(
                sql(f"SELECT count(*) FROM public.belt_ranks WHERE id='{x['rank1']}';")
                == "1",
                "Rollback-only cursor proof did not restore the deleted target",
            )
            require(
                sql(
                    "SELECT pg_get_functiondef('public.reassign_memberships_before_belt_rank_delete()'::REGPROCEDURE);"
                )
                == observer,
                "Proof observer was not restored",
            )
            passed(
                f"instrumented rollback-only target cursor rechecks committed generation under student ownership legacy={legacy}",
                observer_sha256=hashlib.sha256(observer.encode()).hexdigest(),
            )

        require(
            sql("SELECT count(*) FROM private.workflow_rank_scopes;") == "0",
            "Committed pending scopes remain",
        )
        require(
            sql("SELECT count(*) FROM private.workflow_rank_pending_contexts;") == "0",
            "Committed pending contexts remain",
        )
        require(
            sql("SELECT count(*) FROM private.workflow_rank_pending_events;") == "0",
            "Committed pending events remain",
        )
        print(
            json.dumps(
                {
                    "database": database,
                    "cases": cases,
                    "omitted_unchanged_profile_contract": "65c90e5c1f668ef774a729336361ea5711525df1cb6792062fae52e151d4c3f7",
                },
                indent=2,
            ),
            flush=True,
        )
    finally:
        for item in children:
            process = item["process"]
            if process.poll() is None:
                if not process.stdin.closed:
                    try:
                        process.stdin.write("ROLLBACK;\n")
                        process.stdin.close()
                    except (BrokenPipeError, OSError):
                        pass
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    process.terminate()
                    process.wait(timeout=3)
            for thread in item["threads"]:
                thread.join(timeout=2)
            for stream in (process.stdin, process.stdout, process.stderr):
                if not stream.closed:
                    stream.close()
        if owned:
            local.sql(
                "postgres",
                f"SELECT pg_terminate_backend(pid,5000) FROM pg_stat_activity WHERE datname={quote(database)} AND backend_type='client backend';",
            )
            local.sql("postgres", f"DROP DATABASE {database};")
            require(
                local.sql(
                    "postgres",
                    f"SELECT count(*) FROM pg_database WHERE datname={quote(database)};",
                )
                == "0",
                "Owned clone remains",
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
