#!/usr/bin/env python3
"""Verify capture-only student/payment owners in one owned local PG17 clone.

The named clone is announced before template copy. No hosted, provider, Docker,
credentials, environment-file, base schema/business writes, or mail operations.
"""

import hashlib
import json
import os
import queue
import re
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from uuid import uuid4

from local_postgres_verification import LocalPostgres, require

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


def psql_file(path):
    # psql17 meta-command arguments: single quotes double inside single quotes;
    # backslashes must also double to suppress C-like substitutions.
    # https://www.postgresql.org/docs/17/app-psql.html#APP-PSQL-META-COMMANDS
    value = str(path.resolve())
    require(not any(c in value for c in "\r\n\x00"), "Unsupported psql file path")
    return "'" + value.replace("\\", "\\\\").replace("'", "''") + "'"


def migration_body(name):
    matches = list(
        re.finditer(
            r"CREATE (?:OR REPLACE )?FUNCTION "
            + re.escape(name)
            + r"\(.*?AS (\$[\w]*\$)(.*?)\1;",
            MIGRATION.read_text(),
            re.DOTALL,
        )
    )
    require(len(matches) == 1, "Expected unique current V57 definition: " + name)
    return matches[0][2]


def call(name, *args):
    return "SELECT public." + name + "(" + ",".join(map(quote, args)) + ");"


def main(arguments):
    skip_retained_profile = (
        len(arguments) == 5 and arguments[-1] == "--skip-retained-profile"
    )
    require(
        len(arguments) == 4 or skip_retained_profile,
        "Expected psql socket port unique-owned-clone-name [--skip-retained-profile]",
    )
    psql, socket, port, database = arguments[:4]
    require(
        re.fullmatch(r"koaryu_student_payment_[a-z0-9_]+", database),
        "Unexpected owned clone name",
    )
    local = LocalPostgres(psql, socket, port, str(Path(socket).parent))
    children, cases = [], []
    migration_hash = hashlib.sha256(MIGRATION.read_bytes()).hexdigest()
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
        print(f"[student payment capture] PASS {name}", flush=True)

    def fixture():
        ids = {
            k: str(uuid4())
            for k in (
                "actor",
                "owner",
                "studio",
                "program",
                "lead",
                "student",
                "new_student",
                "membership",
                "ladder",
                "white",
                "yellow",
                "payer",
                "invoice",
                "payment",
                "operation",
            )
        }
        sql(f"""BEGIN;
INSERT INTO auth.users(id,email,email_confirmed_at) VALUES('{ids["actor"]}','{ids["actor"]}@example.invalid',clock_timestamp()),('{ids["owner"]}','{ids["owner"]}@example.invalid',clock_timestamp());
INSERT INTO public.studios(id,name,slug,owner_id,timezone) VALUES('{ids["studio"]}','Student capture race','{ids["studio"]}','{ids["owner"]}','UTC');
INSERT INTO public.staff_roles(studio_id,user_id,role) VALUES('{ids["studio"]}','{ids["actor"]}','admin'),('{ids["studio"]}','{ids["owner"]}','admin');
INSERT INTO public.studio_subscriptions(studio_id,status,comped) VALUES('{ids["studio"]}','active',false);
INSERT INTO public.programs(id,studio_id,name) VALUES('{ids["program"]}','{ids["studio"]}','Program');
INSERT INTO public.leads(id,studio_id,first_name,last_name,program_id) VALUES('{ids["lead"]}','{ids["studio"]}','Synthetic','Lead','{ids["program"]}');
INSERT INTO public.students(id,studio_id,legal_first_name,legal_last_name,status,program_id) VALUES('{ids["student"]}','{ids["studio"]}','Synthetic','Student','active','{ids["program"]}');
INSERT INTO public.student_program_memberships(id,studio_id,student_id,program_id,status) VALUES('{ids["membership"]}','{ids["studio"]}','{ids["student"]}','{ids["program"]}','active');
INSERT INTO public.belt_ladders(id,studio_id,program_id,name) VALUES('{ids["ladder"]}','{ids["studio"]}','{ids["program"]}','Ladder');
INSERT INTO public.belt_ranks(id,studio_id,ladder_id,name,display_order) VALUES('{ids["white"]}','{ids["studio"]}','{ids["ladder"]}','White',1),('{ids["yellow"]}','{ids["studio"]}','{ids["ladder"]}','Yellow',2);
INSERT INTO public.billing_payers(id,studio_id,display_name) VALUES('{ids["payer"]}','{ids["studio"]}','Payer');
INSERT INTO public.billing_invoices(id,studio_id,payer_id,status,amount_due_cents) VALUES('{ids["invoice"]}','{ids["studio"]}','{ids["payer"]}','open',1000);
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

    def profile(ids):
        return f"SELECT to_jsonb(r) FROM public.write_student_profile_v2_atomic('{ids['new_student']}','{ids['studio']}','{ids['actor']}','{{\"legal_first_name\":\"Created\",\"legal_last_name\":\"Student\"}}',ARRAY['{ids['program']}'::UUID],'[]',true,'student.created') r;"

    def convert(ids):
        return f"SELECT to_jsonb(r) FROM public.convert_lead_to_student_atomic('{ids['studio']}','{ids['actor']}','{ids['lead']}','{ids['new_student']}','{ids['program']}','active',CURRENT_DATE) r;"

    def promote(ids):
        return f"SELECT to_jsonb(r) FROM public.record_student_rank_transition_v3('{ids['studio']}','{ids['student']}','{ids['membership']}','{ids['program']}','{ids['white']}','{ids['actor']}',NULL,'promotion','{ids['operation']}') r;"

    def payment(ids, status="failed", linked=True):
        return f"INSERT INTO public.billing_payments(id,studio_id,payer_id,invoice_id,status,amount_cents) VALUES('{ids['payment']}','{ids['studio']}',{quote(ids['payer'] if linked else None)},{quote(ids['invoice'] if linked else None)},{quote(status)},1000) RETURNING to_jsonb(billing_payments);"

    def clear(ids):
        return call("clear_studio_operational_data_atomic", ids["studio"], False)

    def events(ids):
        return json.loads(
            sql(
                f"SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY event_type,subject_id),'[]') FROM private.automation_workflow_events e WHERE studio_id='{ids['studio']}';"
            )
        )

    def facts(ids):
        expressions = []
        for table in (
            "students",
            "student_program_memberships",
            "promotions",
            "leads",
            "lead_activities",
            "audit_logs",
            "billing_payers",
            "billing_invoices",
            "billing_payments",
        ):
            expressions += [
                quote(table),
                f"(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY id),'[]') FROM public.{table} r WHERE studio_id='{ids['studio']}')",
            ]
        return json.loads(
            sql("SELECT jsonb_build_object(" + ",".join(expressions) + ");")
        )

    def functions():
        return json.loads(
            sql("""SELECT jsonb_object_agg(n.nspname||'.'||p.proname,jsonb_build_object('definition',pg_get_functiondef(p.oid),'body',p.prosrc,'acl',p.proacl::TEXT,
'signature',pg_get_function_identity_arguments(p.oid),'result',pg_get_function_result(p.oid),'security_definer',p.prosecdef,
'config',p.proconfig,'owner',pg_get_userbyid(p.proowner),'language',p.prolang,'volatility',p.provolatile,'strict',p.proisstrict,'parallel',p.proparallel))
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE (n.nspname='private' AND p.proname IN ('write_student_profile_atomic','record_student_rank_transition_v3','validate_billing_payment_identity_change','import_student_row_atomic'))
OR (n.nspname='public' AND p.proname IN ('write_student_profile_atomic','write_student_profile_v2_atomic','convert_lead_to_student_atomic','record_student_rank_transition_v3','validate_billing_payment_refs'));""")
        )

    def session(name, statement, hold=False, role="service_role"):
        name = f"student_payment_{os.getpid()}_{name}_{len(children)}"[:63]
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

    try:
        require(
            local.sql(
                "postgres",
                f"SELECT count(*) FROM pg_database WHERE datname={quote(database)};",
            )
            == "0",
            "Owned name already exists",
        )
        local.sql("postgres", f"CREATE DATABASE {database} TEMPLATE postgres;")
        owned = True
        print(f"[student payment capture] owned clone {database}", flush=True)
        with tempfile.TemporaryDirectory(prefix="koaryu-psql-feed-") as directory:
            specimen = Path(directory) / "quoted path's \\ probe.sql"
            specimen.write_text("SELECT 'quoted_file';\n")
            require(
                sql("\\i " + psql_file(specimen)) == "quoted_file",
                "psql file argument quoting failed",
            )
        old = fixture()
        sql(payment(old, "processing"))
        old_failed = {**old, "payment": str(uuid4())}
        sql(payment(old_failed))
        before_facts, before_functions = facts(old), functions()
        crossing, after_install = fixture(), fixture()
        preceding_writer = session(
            "payment_before_install", payment(crossing, "processing"), hold=True
        )
        ready(preceding_writer)
        installer = session(
            "capture_install", "\\i " + psql_file(MIGRATION), hold=True, role="postgres"
        )
        finished(installer, "55P03")
        require(
            facts(old) == before_facts and functions() == before_functions,
            "Refused install changed retained facts or definitions",
        )
        require(
            sql(
                "SELECT to_regclass('private.workflow_payment_capture_markers') IS NULL AND "
                "to_regclass('private.workflow_invoice_settlement_authority') IS NULL AND "
                "to_regclass('private.workflow_payment_settlement_observations') IS NULL AND "
                "(SELECT count(*)=151 FROM supabase_migrations.schema_migrations);"
            )
            == "t",
            "Refused install left partial capture/authority/history effects",
        )
        release(preceding_writer)
        installer = session(
            "capture_install_fresh",
            "\\i " + psql_file(MIGRATION),
            hold=True,
            role="postgres",
        )
        ready(installer)
        following_writer = session("payment_after_install", payment(after_install))
        blocked(installer, following_writer)
        release(installer)
        finished(following_writer)
        require(
            sql(
                f"SELECT NOT eligible FROM private.workflow_payment_capture_markers WHERE payment_id='{crossing['payment']}';"
            )
            == "t",
            "Pre-install in-flight payment was not excluded",
        )
        require(
            sql(
                f"SELECT eligible AND failure_seen FROM private.workflow_payment_capture_markers WHERE payment_id='{after_install['payment']}';"
            )
            == "t"
            and len(events(after_install)) == 1,
            "Payment admitted after install did not capture",
        )
        passed(
            "NOWAIT installation refuses preceding writer, then fresh install excludes commit and captures following insert",
            migration_sha256=migration_hash,
            psql_file_quoting_verified=True,
        )
        require(facts(old) == before_facts, "Installation rewrote business rows")
        require(
            sql("SELECT count(*) FROM supabase_migrations.schema_migrations;") == "151",
            "Partial V57 registered release history",
        )
        after_functions = functions()
        retained = {
            "private.write_student_profile_atomic",
            "private.record_student_rank_transition_v3",
            "public.convert_lead_to_student_atomic",
            "public.write_student_profile_atomic",
            "private.import_student_row_atomic",
        }
        require(
            hashlib.sha256(MIGRATION.read_bytes()).hexdigest() == migration_hash,
            "Installer migration bytes changed",
        )
        for name, entry in before_functions.items():
            require(
                after_functions[name]["acl"] == entry["acl"],
                f"Retained ACL changed: {name}",
            )
            if name in retained:
                identity = {
                    key: value
                    for key, value in entry.items()
                    if key not in {"definition", "body"}
                }
                require(
                    {
                        key: value
                        for key, value in after_functions[name].items()
                        if key not in {"definition", "body"}
                    }
                    == identity,
                    f"Retained signature/config/security identity changed: {name}",
                )
                require(
                    after_functions[name]["body"] == migration_body(name),
                    f"Installed body differs from exact V57 owner: {name}",
                )
            else:
                require(
                    after_functions[name] == entry,
                    f"Wrapper or financial owner changed: {name}",
                )
        passed(
            "installation preserves business rows, 151-history and untouched wrapper/financial functions",
            function_hashes={
                name: {
                    "before": hashlib.sha256(entry["definition"].encode()).hexdigest(),
                    "after": hashlib.sha256(
                        after_functions[name]["definition"].encode()
                    ).hexdigest(),
                    "installed_body": hashlib.sha256(
                        after_functions[name]["body"].encode()
                    ).hexdigest(),
                    "current_v57_body": hashlib.sha256(
                        migration_body(name).encode()
                    ).hexdigest()
                    if name in retained
                    else None,
                }
                for name, entry in before_functions.items()
            },
        )
        sql(
            f"UPDATE public.billing_payments SET status='failed' WHERE studio_id='{old['studio']}';"
        )
        require(not events(old), "Pre-install payments captured")
        require(
            sql(
                f"SELECT count(*) FROM private.workflow_payment_capture_markers WHERE studio_id='{old['studio']}' AND NOT eligible;"
            )
            == "2",
            "Old exclusion markers absent",
        )
        passed(
            "pre-install failed and nonfailed payment identities are permanently excluded"
        )
        for contract in (
            "workflow_student_payment_capture_contract.sql",
            "record_student_promotion_rpc_contract.sql",
            "student_import_row_atomic_contract.sql",
            "billing_external_payment_overpay_guard.sql",
            "billing_payment_adjustment_convergence.sql",
            "workflow_domain_capture_contract.sql",
        ):
            passed(
                contract,
                result=sql((ROOT / "supabase/verification" / contract).read_text()),
            )

        sources = (
            ("profile", profile, "student.enrolled", 1),
            ("conversion", convert, "student.enrolled", 2),
            ("promotion", promote, "student.promoted", 1),
            ("payment", payment, "invoice.payment_failed", 1),
        )
        # These are actual command entries, so the profile case includes both wrappers.
        for kind, source, event_type, event_count in sources:
            for action in ("publish", "pause"):
                for rollback in (False, True):
                    for source_first in (False, True):
                        ids = fixture()
                        w = workflow(ids, event_type)
                        old_version = sql(
                            f"SELECT published_version_id FROM public.automation_workflows WHERE id='{w}';"
                        )
                        source_stmt = source(ids)
                        original_facts = facts(ids)
                        lifecycle_stmt = lifecycle(ids, w, action, 3)
                        first = session(
                            kind + "_lifecycle_first",
                            source_stmt if source_first else lifecycle_stmt,
                            hold=True,
                        )
                        ready(first)
                        second = session(
                            kind + "_lifecycle_second",
                            lifecycle_stmt if source_first else source_stmt,
                        )
                        blocked(first, second)
                        release(first, rollback)
                        finished(second)
                        seen = events(ids)
                        runs = json.loads(
                            sql(
                                f"SELECT coalesce(jsonb_agg(to_jsonb(r)),'[]') FROM public.automation_workflow_runs r WHERE studio_id='{ids['studio']}';"
                            )
                        )
                        expected_events = (
                            0 if source_first and rollback else event_count
                        )
                        require(
                            len(seen) == expected_events,
                            "Source commit/rollback occurrences differ",
                        )
                        if source_first and rollback:
                            require(
                                facts(ids) == original_facts,
                                "Source rollback changed retained business facts",
                            )
                        expected_runs = (
                            0
                            if not expected_events
                            or (not source_first and action == "pause" and not rollback)
                            else 1
                        )
                        require(
                            len(runs) == expected_runs,
                            "Busy workflow lost or backfilled a target",
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
                                "Source selected stale workflow version",
                            )
                            if source_first and action == "pause":
                                require(
                                    runs[0]["state"] == "cancelled",
                                    "Pause did not cancel committed run",
                                )
                        passed(
                            f"{kind} {action} source_first={source_first} rollback={rollback}"
                        )

        # Clear owns the real existing advisory gate before removing source facts.
        for kind, source, event_type, event_count in sources:
            for rollback in (False, True):
                ids = fixture()
                workflow(ids, event_type)
                holder = session(kind + "_clear_first", clear(ids), hold=True)
                ready(holder)
                before = facts(ids)
                finished(
                    session(
                        kind + "_clear_refused",
                        payment(ids, linked=False)
                        if kind == "payment"
                        else source(ids),
                    ),
                    "LEAD_STUDIO_BUSY"
                    if kind == "conversion"
                    else "AUTOMATION_STUDIO_BUSY",
                )
                require(
                    facts(ids) == before and not events(ids),
                    "Clear contention left partial source/capture state",
                )
                release(holder, rollback)
                if rollback:
                    finished(session(kind + "_clear_retry", source(ids)))
                    require(
                        len(events(ids)) == event_count,
                        "Source retry after rolled back clear failed",
                    )
                passed(f"{kind} clear first rollback={rollback}")
                ids = fixture()
                workflow(ids, event_type)
                holder = session(kind + "_source_first", source(ids), hold=True)
                ready(holder)
                clearer = session(kind + "_clear_waiter", clear(ids))
                blocked(holder, clearer)
                release(holder, rollback)
                finished(clearer)
                require(
                    len(events(ids)) == (0 if rollback else event_count),
                    "Clear changed committed occurrence evidence",
                )
                if kind == "payment":
                    require(
                        sql(
                            f"SELECT count(*) FROM private.workflow_payment_capture_markers WHERE payment_id='{ids['payment']}';"
                        )
                        == ("0" if rollback else "1"),
                        "Clear lost durable payment marker",
                    )
                passed(f"{kind} source before clear rollback={rollback}")

        # Linked INSERT retains its pre-capture FK wait if clear already deleted
        # its payer. The AFTER capture trigger must not replace that financial guard.
        for rollback in (False, True):
            ids = fixture()
            workflow(ids, "invoice.payment_failed")
            holder = session("clear_before_linked_payment", clear(ids), hold=True)
            ready(holder)
            writer = session("linked_payment_fk_wait", payment(ids))
            blocked(holder, writer)
            release(holder, rollback)
            finished(writer, None if rollback else "23503")
            require(
                len(events(ids)) == (1 if rollback else 0),
                "Retained payment FK/clear boundary changed capture",
            )
            require(
                sql(
                    f"SELECT count(*) FROM private.workflow_payment_capture_markers WHERE payment_id='{ids['payment']}';"
                )
                == ("1" if rollback else "0"),
                "Rejected linked INSERT left a marker",
            )
            passed(
                f"linked payment INSERT retains FK wait against clear rollback={rollback}"
            )

        # A first UPDATE failure owns the existing payment row before late admission.
        for rollback in (False, True):
            ids = fixture()
            w = workflow(ids, "invoice.payment_failed")
            sql(payment(ids, "processing"))
            update = f"UPDATE public.billing_payments SET status='failed' WHERE id='{ids['payment']}' RETURNING to_jsonb(billing_payments);"
            holder = session("first_payment_failure", update, hold=True)
            ready(holder)
            retry = session("competing_payment_failure", update)
            blocked(holder, retry)
            release(holder, rollback)
            finished(retry)
            require(
                len(events(ids)) == 1
                and sql(
                    f"SELECT failure_seen FROM private.workflow_payment_capture_markers WHERE payment_id='{ids['payment']}';"
                )
                == "t",
                "Concurrent first failure did not commit once",
            )
            passed(f"competing first payment UPDATE failure rollback={rollback}")
            ids = fixture()
            sql(payment(ids, "processing"))
            update = f"UPDATE public.billing_payments SET status='failed' WHERE id='{ids['payment']}' RETURNING to_jsonb(billing_payments);"
            before = facts(ids)
            holder = session(
                "studio_parent",
                lock_row("public.studios", ids["studio"]),
                hold=True,
                role="postgres",
            )
            ready(holder)
            finished(session("late_payment_studio", update), "AUTOMATION_STUDIO_BUSY")
            require(
                facts(ids) == before
                and not events(ids)
                and sql(
                    f"SELECT failure_seen FROM private.workflow_payment_capture_markers WHERE payment_id='{ids['payment']}';"
                )
                == "f",
                "Late studio refusal changed financial/seen state",
            )
            release(holder, rollback)
            finished(session("late_payment_retry", update))
            require(len(events(ids)) == 1, "Late studio retry failed")
            passed(f"late payment studio NOWAIT whole projection rollback={rollback}")

        # Required parent SHARE NOWAIT refuses without a backward financial wait.
        for table, key in (
            ("billing_invoices", "invoice"),
            ("billing_payers", "payer"),
        ):
            for rollback in (False, True):
                ids = fixture()
                workflow(ids, "invoice.payment_failed")
                sql(payment(ids, "processing"))
                holder = session(
                    "financial_parent",
                    lock_row("public." + table, ids[key]),
                    hold=True,
                    role="postgres",
                )
                ready(holder)
                update = f"UPDATE public.billing_payments SET status='failed' WHERE id='{ids['payment']}' RETURNING to_jsonb(billing_payments);"
                finished(
                    session("failure_without_parent_wait", update),
                    "AUTOMATION_STUDIO_BUSY",
                )
                require(
                    not events(ids)
                    and sql(
                        f"SELECT p.status='processing' AND NOT m.failure_seen FROM public.billing_payments p "
                        f"JOIN private.workflow_payment_capture_markers m ON m.payment_id=p.id WHERE p.id='{ids['payment']}';"
                    )
                    == "t",
                    "Parent NOWAIT refusal changed payment, marker or events",
                )
                release(holder, rollback)
                finished(session("failure_after_parent_release", update))
                require(
                    len(events(ids)) == 1, "Explicit parent retry lost first failure"
                )
                passed(
                    f"payment parent SHARE NOWAIT then explicit retry {table} rollback={rollback}"
                )

        # Freeze both conversion families in one UUID-ordered SHARE pass. A lower
        # workflow must be owned before waiting at the higher one for either source.
        for rollback in (False, True):
            ids = fixture()
            welcome = workflow(ids, "student.enrolled")
            stage = workflow(ids, "lead.stage_changed")
            low, high = sorted((welcome, stage))
            holder = session(
                "union_high", lock_row("public.automation_workflows", high), hold=True
            )
            ready(holder)
            first = session("union_conversion", convert(ids))
            blocked(holder, first)
            low_writer = session(
                "union_low_probe", lock_row("public.automation_workflows", low)
            )
            blocked(first, low_writer)
            second_ids = {**ids, "lead": str(uuid4()), "new_student": str(uuid4())}
            sql(
                f"INSERT INTO public.leads(id,studio_id,first_name,last_name,program_id) VALUES('{second_ids['lead']}','{ids['studio']}','Second','Lead','{ids['program']}');"
            )
            second = session("union_second_conversion", convert(second_ids))
            # Depending on waiter fairness it waits at low or high. Both finish
            # without a SHARE-to-UPDATE upgrade once the high holder releases.
            release(holder, rollback)
            finished(first)
            finished(low_writer)
            finished(second)
            require(
                len(events(ids)) == 4
                and sql(
                    f"SELECT count(*) FROM public.automation_workflow_runs WHERE studio_id='{ids['studio']}';"
                )
                == "4",
                "Two-family conversion union lost or duplicated targets",
            )
            passed(
                f"two conversions two workflows ordered final-mode union rollback={rollback}"
            )

        # Capture waits only after actual new profile parents and audit FK owners
        # are held. Deletion cannot introduce a backward workflow/source cycle.
        for kind, source, event_type in (
            ("profile", profile, "student.enrolled"),
            ("conversion", convert, "student.enrolled"),
            ("promotion", promote, "student.promoted"),
        ):
            ids = fixture()
            w = workflow(ids, event_type)
            holder = session(
                kind + "_workflow",
                lock_row("public.automation_workflows", w),
                hold=True,
            )
            ready(holder)
            writer = session(kind + "_source", source(ids))
            blocked(holder, writer)
            parent = session(
                kind + "_program_delete",
                f"DELETE FROM public.programs WHERE id='{ids['program']}';",
                role="postgres",
            )
            blocked(writer, parent)
            release(holder)
            finished(writer)
            # The retained student tenant guard rejects ON DELETE SET NULL once
            # this source owns a program-scoped starting/promoted rank.
            finished(
                parent,
                "P0001: Student current belt rank belongs to a different program.",
            )
            passed(
                f"{kind} source capture versus program delete no backward parent wait"
            )

        # A management writer already holding workflow UPDATE refuses a busy
        # program parent using the accepted NOWAIT graph validator.
        ids = fixture()
        w = workflow(ids, "student.enrolled", program=ids["program"])
        holder = session(
            "management_program",
            lock_row("public.programs", ids["program"]),
            hold=True,
            role="postgres",
        )
        ready(holder)
        finished(
            session("management_publish", lifecycle(ids, w, "publish", 3)),
            "AUTOMATION_STUDIO_BUSY",
        )
        release(holder)
        finished(session("management_publish_retry", lifecycle(ids, w, "publish", 3)))
        passed(
            "retained workflow reference NOWAIT breaks workflow/program/source cycle"
        )

        # New-workflow/start admission cannot omit an in-flight source capture.
        for kind, source, event_type, event_count in sources:
            ids = fixture()
            w = workflow(ids, event_type, active=False)
            before = facts(ids)
            holder = session(kind + "_start", lifecycle(ids, w, "start", 2), hold=True)
            ready(holder)
            finished(
                session(kind + "_start_refused", source(ids)), "AUTOMATION_STUDIO_BUSY"
            )
            require(
                facts(ids) == before and not events(ids),
                "Admission refusal did not roll back source",
            )
            release(holder)
            finished(session(kind + "_start_retry", source(ids)))
            require(
                len(events(ids)) == event_count,
                "Explicit capture retry after start failed",
            )
            passed(f"{kind} start admission rejects complete source then retries")

        omitted = []
        if skip_retained_profile:
            omitted.append("student_profile_write_atomic_contract.sql")
            print(
                "[student payment capture] OMITTED retained profile contract by explicit --skip-retained-profile; default full proof remains required",
                flush=True,
            )
        else:
            # The unchanged V56 contract takes 333s on this host for its 11,520
            # date-trigger comparisons. Keep this exception local to that exact call.
            profile_contract = (
                ROOT / "supabase/verification/student_profile_write_atomic_contract.sql"
            )
            profile_bytes = profile_contract.read_bytes()
            profile_hash = hashlib.sha256(profile_bytes).hexdigest()
            require(
                profile_hash
                == "65c90e5c1f668ef774a729336361ea5711525df1cb6792062fae52e151d4c3f7",
                "Retained profile contract changed from measured baseline",
            )
            started = time.monotonic()
            print(
                "[student payment capture] running unchanged retained profile contract, 540s server / 600s client bound",
                flush=True,
            )
            result = subprocess.run(
                [
                    psql,
                    *local.connection,
                    f"--dbname={database}",
                    "--no-psqlrc",
                    "--set=ON_ERROR_STOP=1",
                    "--quiet",
                    "--tuples-only",
                    "--no-align",
                ],
                input="SET statement_timeout='540s';\n" + profile_bytes.decode(),
                text=True,
                capture_output=True,
                env=local.env,
                timeout=600,
                check=False,
            )
            require(
                result.returncode == 0,
                "Retained profile contract failed: " + result.stderr[-3000:],
            )
            passed(
                "student_profile_write_atomic_contract.sql",
                elapsed_seconds=time.monotonic() - started,
                sha256=profile_hash,
                notices=result.stderr.strip(),
            )
        print(
            json.dumps(
                {
                    "database": database,
                    "cases": cases,
                    "omitted_retained_proofs": omitted,
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
            # A timed-out psql client can leave its CPU-active backend running.
            # This runner owns this unique database; never touch base sessions.
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
