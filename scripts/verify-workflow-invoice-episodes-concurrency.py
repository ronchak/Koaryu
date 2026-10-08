#!/usr/bin/env python3
"""Strict local PG17 invoice episode ownership, cancellation and restore proof.

One owned database name is reused sequentially. No hosted target, dotenv, provider
or mail. This observer does not enroll timers or establish V57 release readiness.
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

from local_postgres_verification import LocalPostgres, require, install_final_v57

import v57_retained_function_verification as retention

ROOT = Path(__file__).resolve().parents[1]
BASE = "35561d6b8f851ea0309723637e0996a064ba4c82"
BASE_HASH = "cab98ab987acf0c24a383be94f3e0499c6d891b922d7fd1de217e788c2a339b5"
MIGRATION = (
    ROOT / "supabase/migrations/20261005105341_automation_workflow_graph_v57.sql"
)
CONTRACT = ROOT / "supabase/verification/workflow_invoice_episode_contract.sql"
TRANSITION = "private.workflow_transition_owned_v1(uuid,uuid,uuid,integer,text)"
INVENTORY = """SELECT jsonb_object_agg(p.oid::regprocedure::text,jsonb_build_object(
'body',p.prosrc,'acl',p.proacl::text,'owner',pg_get_userbyid(p.proowner),
'settings',p.proconfig,'volatility',p.provolatile,'security_definer',p.prosecdef))
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname IN ('public','private');"""


def quote(value):
    if value is None:
        return "NULL"
    if isinstance(value, (dict, list)):
        value = json.dumps(value, separators=(",", ":"))
    return "'" + str(value).replace("'", "''") + "'"


def source_functions(source):
    result = {}
    for match in re.finditer(
        r"CREATE(?: OR REPLACE)? FUNCTION\s+([\w.]+)\s*\(", source
    ):
        tail = source[match.start() :]
        marker = re.search(r"\bAS\s+(\$[A-Za-z_0-9]*\$)", tail)
        require(marker is not None, "Function delimiter missing")
        delimiter = marker.group(1)
        end = tail.index(delimiter, marker.end())
        result.setdefault(match.group(1), []).append(tail[marker.end() : end])
    return result


def main(arguments):
    require(len(arguments) == 4, "Expected psql socket port unique-owned-clone-name")
    psql, socket, port, database = arguments
    require(
        re.fullmatch(r"koaryu_invoice_episode_[a-z0-9_]+", database),
        "Invalid owned clone",
    )
    local = LocalPostgres(psql, socket, port, str(Path(socket).parent))
    frozen = MIGRATION.read_bytes()
    source = frozen.decode()
    contract = CONTRACT.read_text()
    historical = {
        p.name: hashlib.sha256(p.read_bytes()).hexdigest()
        for p in sorted(MIGRATION.parent.glob("*.sql"))
        if p != MIGRATION
    }
    require(len(historical) == 151, "Expected151 historical migrations")
    require(
        local.run(["git", "-C", str(ROOT), "rev-parse", "--is-shallow-repository"])
        == "false",
        "Full Git history required",
    )
    local.run(["git", "-C", str(ROOT), "merge-base", "--is-ancestor", BASE, "HEAD"])
    accepted = (
        local.run(
            [
                "git",
                "-C",
                str(ROOT),
                "show",
                BASE + ":" + str(MIGRATION.relative_to(ROOT)),
            ]
        )
        + "\n"
    )
    require(
        hashlib.sha256(accepted.encode()).hexdigest() == BASE_HASH,
        "Accepted V57 baseline differs",
    )
    for name, digest in historical.items():
        original = subprocess.check_output(
            ["git", "-C", str(ROOT), "show", BASE + ":supabase/migrations/" + name],
            env=local.env,
        )
        require(
            hashlib.sha256(original).hexdigest() == digest,
            "Historical migration changed: " + name,
        )
    old_functions, new_functions = source_functions(accepted), source_functions(source)
    for name, bodies in old_functions.items():
        if name not in ("private.workflow_transition_owned_v1", retention.TIMED_FUNCTION):
            require(
                new_functions.get(name) == bodies,
                "Retained source body changed: " + name,
            )
    retention.require_reviewed_timed_sources(old_functions[retention.TIMED_FUNCTION], new_functions[retention.TIMED_FUNCTION])
    require(
        len(new_functions["private.workflow_transition_owned_v1"]) == 1,
        "Ambiguous transition definition",
    )
    baseline = local.sql(
        "postgres",
        "SELECT row_to_json(p) FROM public.koaryu_release_schema_preflight_v37() p;",
    )
    base = json.loads(baseline)
    require(
        base["ready"]
        and base["migration_count"] == 151
        and base["migration_head"] == "20261004220435"
        and base["manifest_version"] == "release-db-attestation-v56",
        "Strict V56 base required",
    )
    pid_file = Path(socket).parent / "data/postmaster.pid"
    pid = pid_file.read_text().splitlines()[0]
    dump = Path(socket).parent / (database + ".dump")
    require(not os.path.lexists(dump), "Dump path already exists")
    owned, dump_owned = False, False
    children, cases, lifetimes = [], [], []

    def sql(statement):
        return local.sql(database, "SET TIME ZONE 'UTC';\n" + statement)

    def value(statement):
        return json.loads(sql(statement))

    def passed(name, **evidence):
        cases.append({"case": name, "outcome": "passed", **evidence})
        print("[invoice episodes] PASS " + name, flush=True)

    def create(template="postgres"):
        nonlocal owned
        require(
            local.sql(
                "postgres",
                f"SELECT NOT EXISTS(SELECT 1 FROM pg_database WHERE datname={quote(database)});",
            )
            == "t",
            "Owned name already exists",
        )
        local.sql("postgres", f"CREATE DATABASE {database} TEMPLATE {template};")
        owned = True
        lifetimes.append(
            {
                "action": "create",
                "name": database,
                "template": template,
                "at": time.time(),
            }
        )

    def drop():
        nonlocal owned
        require(owned, "Database cleanup has no ownership")
        local.sql("postgres", f"DROP DATABASE {database};")
        owned = False
        require(
            local.sql(
                "postgres",
                f"SELECT NOT EXISTS(SELECT 1 FROM pg_database WHERE datname={quote(database)});",
            )
            == "t",
            "Owned database remains",
        )
        lifetimes.append({"action": "drop", "name": database, "at": time.time()})

    def fixture(due="CURRENT_DATE-2", run=False, state="claimed"):
        x = value(f"SELECT episode_proof.episode_fixture({due});")
        if run:
            x = value(
                f"SELECT episode_proof.episode_run({quote(x)},'invoice.overdue',{quote(state)});"
            )
        return x

    def snapshot(x):
        return value(f"SELECT episode_proof.episode_snapshot({quote(x)});")

    def advance(x):
        return f"SELECT public.advance_automation_workflow_run_v1({quote(x['studio'])},{quote(x['run'])},{quote(x['token'])},10);"

    def mutate(x, change="status='paid'"):
        return f"UPDATE public.billing_invoices SET {change} WHERE id={quote(x['invoice'])};"

    def invoke(statement):
        return value(
            "SET ROLE service_role; SELECT episode_proof.episode_rpc("
            + quote(statement)
            + ");"
        )

    def session(label, statement, hold=False, role="service_role"):
        name = f"episode_{os.getpid()}_{label}_{len(children)}"[:63]
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
            "name": name,
            "lines": [],
            "errors": [],
            "events": queue.Queue(),
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
            f"SET application_name={quote(name)}; SET TIME ZONE 'UTC'; BEGIN; SET LOCAL statement_timeout='20s'; SET LOCAL ROLE {role};\n{statement}\n"
        )
        if hold:
            process.stdin.write("SELECT 'RESULT_READY';\n")
            process.stdin.flush()
        else:
            process.stdin.write("COMMIT;\n")
            process.stdin.close()
        return item

    def ready(item):
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            try:
                if item["events"].get(timeout=0.05) == "RESULT_READY":
                    return
            except queue.Empty:
                require(
                    item["process"].poll() is None,
                    "Holder failed: " + "\n".join(item["errors"]),
                )
        raise RuntimeError("Holder barrier timeout")

    def finished(item, success=True):
        code = item["process"].wait(timeout=25)
        for thread in item["threads"]:
            thread.join(timeout=2)
        require(
            (code == 0) == success,
            "Unexpected session exit: " + "\n".join(item["errors"]),
        )
        parsed = [json.loads(line) for line in item["lines"] if line.startswith("{")]
        return parsed[-1] if parsed else None

    def release(item, rollback=False, success=True):
        item["process"].stdin.write("ROLLBACK;\n" if rollback else "COMMIT;\n")
        item["process"].stdin.close()
        return finished(item, success=success)

    def blocked(holder, reader):
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            require(
                reader["process"].poll() is None,
                "Waiter exited: " + "\n".join(reader["errors"]),
            )
            if (
                sql(
                    f"SELECT EXISTS(SELECT 1 FROM pg_stat_activity h JOIN pg_stat_activity r ON h.pid=ANY(pg_blocking_pids(r.pid)) WHERE h.application_name={quote(holder['name'])} AND r.application_name={quote(reader['name'])});"
                )
                == "t"
            ):
                return
            time.sleep(0.025)
        raise RuntimeError("Expected observed blocking relationship")

    def close_children():
        for item in children:
            process = item["process"]
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
            for thread in item["threads"]:
                thread.join(timeout=2)
            for stream in (process.stdin, process.stdout, process.stderr):
                if stream is not None and not stream.closed:
                    stream.close()

    def busy_probe(x, change):
        started = time.monotonic()
        got = invoke(
            mutate(x, change)
            + " SELECT private.workflow_finalize_invoice_episodes_v1();"
        )
        require(
            not got["ok"] and got["code"] in ("55P03", "P0001"),
            "Expected definite NOWAIT refusal: " + json.dumps(got),
        )
        require(time.monotonic() - started < 3, "Late parent waited")
        return got

    def helper_setup():
        start = contract.index("-- fixture owners start.")
        end = contract.index("-- fixture owners end.")
        sql(
            "CREATE SCHEMA episode_proof; GRANT USAGE ON SCHEMA episode_proof TO service_role;\n"
            + contract[start:end].replace("pg_temp.", "episode_proof.")
        )
        sql("GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA episode_proof TO service_role;")

    try:
        require(
            local.sql(
                "postgres",
                "SELECT count(*) FROM pg_stat_activity WHERE datname='postgres' AND pid<>pg_backend_pid();",
            )
            == "0",
            "Base has another session",
        )
        create()
        sql("BEGIN;\n" + accepted + "\nCOMMIT;")
        retained = value(INVENTORY)
        drop()
        create()
        # Real pre-install business rows include past/future, excluded and unknown.
        seed_fixture = contract[
            contract.index("CREATE FUNCTION pg_temp.episode_fixture(") : contract.index(
                "CREATE FUNCTION pg_temp.episode_snapshot("
            )
        ]
        sql(
            "CREATE SCHEMA episode_seed;\n"
            + seed_fixture.replace("pg_temp.", "episode_seed.")
        )
        seeds = []
        for due, metadata in (
            ("CURRENT_DATE+2", '{"connect_account_generation":1}'),
            ("CURRENT_DATE-2", '{"connect_account_generation":1}'),
            ("CURRENT_DATE+2", "{}"),
            ("NULL", '{"connect_account_generation":1}'),
        ):
            seeds.append(
                value(
                    f"SELECT episode_seed.episode_fixture({due},false,{quote(metadata)});"
                )
            )
        saved_business = value(
            "SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM public.billing_invoices i;"
        )
        cutover_before = sql("SELECT clock_timestamp();")
        install_final_v57(local, database, ROOT)
        require(
            value(
                "SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM public.billing_invoices i;"
            )
            == saved_business,
            "Installation rewrote invoices",
        )
        require(
            sql("SELECT count(*) FROM private.workflow_invoice_episode_state;") == "4",
            "Missing seed states",
        )
        require(
            sql("SELECT count(*) FROM private.workflow_invoice_collection_episodes;")
            == "2",
            "Wrong seeded episodes",
        )
        require(
            sql(
                "SELECT count(*) FROM private.workflow_invoice_collection_episodes WHERE threshold_eligible;"
            )
            == "1",
            "Retroactive seeded eligibility",
        )
        require(
            sql(
                "SELECT count(DISTINCT opened_at)=1 AND min(opened_at)>="
                + quote(cutover_before)
                + "::timestamptz FROM private.workflow_invoice_collection_episodes;"
            )
            == "t",
            "Seed observation clock invented",
        )
        require(
            sql(
                "SELECT (SELECT count(*) FROM private.automation_workflow_events)+(SELECT count(*) FROM public.automation_workflow_runs);"
            )
            == "0",
            "Install enrolled events or runs",
        )
        installed = value(INVENTORY)
        require(
            all(retention.retained_function_equal(k, v, installed.get(k)) for k, v in retained.items() if k not in (TRANSITION,"koaryu_release_schema_preflight_v37()")),
            "Retained function body or ACL changed",
        )
        require(
            {k: v for k, v in installed[TRANSITION].items() if k != "body"}
            == {k: v for k, v in retained[TRANSITION].items() if k != "body"},
            "Transition settings changed",
        )
        require(
            installed[TRANSITION]["body"]
            == new_functions["private.workflow_transition_owned_v1"][0],
            "Installed transition differs from unique current source",
        )
        require(
            sql("SELECT count(*) FROM supabase_migrations.schema_migrations;") == "152",
            "Complete V57 migration history differs",
        )
        passed(
            "strict baseline full history exact owners and zero-event installation",
            retained_functions=len(retained),
            seeded_states=4,
            seeded_episodes=2,
        )
        passed("rollback episode contract", assertions=sql(contract))
        for name in (
            "workflow_advance",
            "workflow_financial_authority",
            "workflow_current_facts",
            "workflow_run",
        ):
            passed(
                "retained " + name,
                assertions=sql(
                    (ROOT / f"supabase/verification/{name}_contract.sql").read_text()
                ),
            )
        helper_setup()

        # A transaction holds only the source/clear parents before finalization.
        for rollback in (False, True):
            x = fixture(run=True)
            before = snapshot(x)
            owner = session("marker", mutate(x), hold=True)
            ready(owner)
            probe = session(
                "workflow_probe",
                f"SELECT id FROM public.automation_workflows WHERE id={quote(x['workflow'])} FOR UPDATE NOWAIT; SELECT id FROM public.automation_workflow_runs WHERE id={quote(x['run'])} FOR UPDATE NOWAIT;",
                hold=True,
            )
            ready(probe)
            release(probe)
            require(snapshot(x) == before, "Uncommitted callback leaked authority")
            release(owner, rollback=rollback)
            after = snapshot(x)
            require(
                (after == before) == rollback, "Marker transaction rollback mismatch"
            )
            if not rollback:
                require(
                    after["runs"][0]["state"] == "cancelled", "Commit failed to cancel"
                )
            passed(
                "source-only marker then deferred final boundary "
                + ("rollback" if rollback else "commit")
            )

        # Each late source/reference conflict aborts the complete source mutation.
        for table, key in (
            ("public.studios", "studio"),
            ("public.billing_payers", "payer"),
        ):
            for rollback in (False, True):
                x = fixture(run=True)
                before = snapshot(x)
                mode = "NO KEY UPDATE" if table == "public.studios" else "UPDATE"
                holder = session(
                    "parent_busy",
                    f"SELECT id FROM {table} WHERE id={quote(x[key])} FOR {mode};",
                    hold=True,
                )
                ready(holder)
                got = busy_probe(x, "currency='EUR'")
                require(
                    snapshot(x) == before, "Source conflict retained partial authority"
                )
                require(
                    sql(
                        f"SELECT currency='usd' FROM public.billing_invoices WHERE id={quote(x['invoice'])};"
                    )
                    == "t",
                    "Failed source mutation committed",
                )
                release(holder, rollback=rollback)
                sql(mutate(x, "currency='EUR'"))
                require(
                    snapshot(x)["state"]["episode_number"] == 2,
                    "Source retry did not replace",
                )
                passed(
                    "late parent NOWAIT rollback and retry " + table + str(rollback),
                    code=got["code"],
                )

        # Opposite invoice ownership prevents a deferred multi-invoice cycle.
        for rollback in (False, True):
            a, b = fixture(run=True), fixture(run=True)
            before_a, before_b = snapshot(a), snapshot(b)
            left = session("two_left", mutate(a), hold=True)
            right = session("two_right", mutate(b), hold=True)
            ready(left)
            ready(right)
            # Payer demo marks the second invoice without taking its source lock.
            left["process"].stdin.write(
                f"UPDATE public.billing_payers SET metadata='{{\"demo\":true}}' WHERE id={quote(b['payer'])}; SELECT episode_proof.episode_rpc('SELECT private.workflow_finalize_invoice_episodes_v1();');\nSELECT 'RESULT_READY';\n"
            )
            left["process"].stdin.flush()
            ready(left)
            parsed = [
                json.loads(line) for line in left["lines"] if line.startswith("{")
            ]
            require(
                parsed and not parsed[-1]["ok"] and parsed[-1]["code"] == "55P03",
                "Cross-invoice source union waited",
            )
            release(left, rollback=True)
            release(right, rollback=rollback)
            require(
                snapshot(a) == before_a, "Failed complete union changed first invoice"
            )
            require(
                (snapshot(b) == before_b) == rollback,
                "Other owner commit truth changed",
            )
            sql(mutate(a) + mutate(b))
            require(
                snapshot(a)["state"]["current_episode_id"] is None,
                "Union retry left active invoice",
            )
            passed("two-invoice source union conflict and retry " + str(rollback))

        # Lock the last target, proving earlier union acquisitions do not commit.
        for target in ("workflow", "run"):
            for rollback in (False, True):
                x = fixture(run=True)
                value(
                    f"SELECT episode_proof.episode_run({quote(x)},'invoice.overdue','sending');"
                )
                rows = value(
                    f"SELECT jsonb_agg(jsonb_build_object('run',id,'workflow',workflow_id) ORDER BY {('workflow_id' if target == 'workflow' else 'id')}) FROM public.automation_workflow_runs WHERE studio_id={quote(x['studio'])};"
                )
                chosen = rows[-1][target]
                table = (
                    "public.automation_workflows"
                    if target == "workflow"
                    else "public.automation_workflow_runs"
                )
                before = snapshot(x)
                holder = session(
                    "last_target",
                    f"SELECT id FROM {table} WHERE id={quote(chosen)} FOR UPDATE;",
                    hold=True,
                )
                ready(holder)
                got = busy_probe(x, "status='paid'")
                require(
                    snapshot(x) == before,
                    "Incomplete cancellation union escaped rollback",
                )
                release(holder, rollback=rollback)
                sql(mutate(x))
                after = snapshot(x)
                require(
                    all(
                        r["cancel_reason"] == "invoice_not_open" for r in after["runs"]
                    ),
                    "Retry skipped part of cancellation union",
                )
                require(
                    {r["state"] for r in after["runs"]} == {"cancelled", "sending"},
                    "Truthful sending outcome changed",
                )
                passed(
                    "complete last-target NOWAIT union " + target + str(rollback),
                    code=got["code"],
                )

        # Retained source owners may already hold SHARE; upgrade must not wait.
        x = fixture(run=True)
        before = snapshot(x)
        holder = session(
            "shared_workflow",
            f"SELECT id FROM public.automation_workflows WHERE id={quote(x['workflow'])} FOR SHARE;",
            hold=True,
        )
        ready(holder)
        got = invoke(
            f"SELECT id FROM public.automation_workflows WHERE id={quote(x['workflow'])} FOR SHARE; "
            + mutate(x)
            + " SELECT private.workflow_finalize_invoice_episodes_v1();"
        )
        require(
            not got["ok"] and got["code"] == "55P03" and snapshot(x) == before,
            "Late workflow upgrade waited or committed",
        )
        release(holder)
        sql(mutate(x))
        passed("existing shared workflow ownership upgrade refuses contention")

        # Actual source mutation and advance in both commit/rollback orders.
        for rollback in (False, True):
            x = fixture(run=True)
            before = snapshot(x)
            writer = session(
                "source_first", mutate(x) + mutate(x, "status='open'"), hold=True
            )
            ready(writer)
            got = invoke(advance(x))
            require(
                not got["ok"] and got["message"] == "AUTOMATION_STUDIO_BUSY",
                "Advance crossed source ownership",
            )
            require(snapshot(x) == before, "Busy advance wrote effects")
            release(writer, rollback=rollback)
            if rollback:
                got = invoke(advance(x))
                require(
                    got["ok"] and got["value"]["payload"]["outcome"] == "email",
                    "Rolled-back ABA stopped valid run",
                )
            else:
                require(
                    snapshot(x)["runs"][0]["state"] == "cancelled",
                    "Committed ABA revived old run",
                )
            x = fixture(run=True)
            owner = session("advance_first", advance(x), hold=True)
            ready(owner)
            writer = session("source_after", mutate(x))
            blocked(owner, writer)
            release(owner, rollback=rollback)
            finished(writer)
            require(
                snapshot(x)["runs"][0]["state"] == "cancelled",
                "Later source closure lost cancellation",
            )
            passed("advance/source actual commit rollback ordering " + str(rollback))

        # Recompute is the real retained one-UPDATE financial owner.
        for rollback in (False, True):
            x = fixture(run=True)
            before = snapshot(x)
            payment = str(uuid4())
            statement = f"""INSERT INTO public.billing_payments(id,studio_id,payer_id,invoice_id,status,amount_cents,currency,
stripe_account_id,stripe_customer_id,stripe_invoice_id,connect_account_generation,payment_method_type,idempotency_key,net_collected_amount_cents)
SELECT {quote(payment)},studio_id,payer_id,id,'succeeded',1000,currency,stripe_account_id,stripe_customer_id,stripe_invoice_id,1,'card',{quote(payment)},1000
FROM public.billing_invoices WHERE id={quote(x["invoice"])};
SELECT * FROM public.recompute_billing_invoice_external_payment_totals({quote(x["studio"])},{quote(x["invoice"])});"""
            owner = session("recompute", statement, hold=True)
            ready(owner)
            require(
                snapshot(x) == before, "Retained recompute exposed uncommitted episode"
            )
            release(owner, rollback=rollback)
            after = snapshot(x)
            require(
                (after == before) == rollback, "Retained financial rollback mismatch"
            )
            if not rollback:
                require(
                    after["runs"][0]["cancel_reason"] == "invoice_not_open"
                    and after["state"]["current_episode_id"] is None,
                    "Recompute failed known closure",
                )
            passed("actual retained payment projection and recompute " + str(rollback))

        # Payer demo changes cover the entire exact tenant union without contacts.
        for rollback in (False, True):
            x = fixture(run=True)
            before = snapshot(x)
            owner = session(
                "payer_demo",
                f"UPDATE public.billing_payers SET metadata='{{\"demo\":true}}' WHERE id={quote(x['payer'])};",
                hold=True,
            )
            ready(owner)
            require(snapshot(x) == before, "Payer marker changed authority early")
            got = invoke(advance(x))
            require(
                not got["ok"] and got["message"] == "AUTOMATION_STUDIO_BUSY",
                "Advance ignored payer ownership",
            )
            release(owner, rollback=rollback)
            require((snapshot(x) == before) == rollback, "Payer demo rollback mismatch")
            if not rollback:
                require(
                    snapshot(x)["runs"][0]["cancel_reason"] == "demo_source",
                    "Payer demo did not cancel",
                )
            passed("actual payer demo owner commit rollback " + str(rollback))

        # DELETE SET NULL must close using the retained context after parent loss.
        for rollback in (False, True):
            x = fixture(run=True)
            before = snapshot(x)
            payer = value(
                f"SELECT to_jsonb(y) FROM public.billing_payers y WHERE id={quote(x['payer'])};"
            )
            owner = session(
                "payer_delete",
                f"DELETE FROM public.billing_payers WHERE id={quote(x['payer'])};",
                hold=True,
            )
            ready(owner)
            require(snapshot(x) == before, "Payer delete exposed uncommitted authority")
            release(owner, rollback=rollback)
            after = snapshot(x)
            require(
                (after == before) == rollback, "Payer delete rollback truth changed"
            )
            if not rollback:
                require(
                    after["state"]["current_episode_id"] is None
                    and after["runs"][0]["cancel_reason"] == "invoice_parent_missing",
                    "Missing parent preserved old episode",
                )
                sql(
                    f"INSERT INTO public.billing_payers SELECT (jsonb_populate_record(NULL::public.billing_payers,{quote(payer)})).*;"
                    + mutate(x, "payer_id=" + quote(x["payer"]))
                )
                repaired = snapshot(x)
                require(
                    repaired["state"]["episode_number"] == 2
                    and repaired["episodes"][1]["context"]
                    == before["episodes"][0]["context"],
                    "Same-context parent repair did not reopen",
                )
                require(
                    repaired["runs"] == after["runs"],
                    "Parent repair revived cancelled run",
                )
            passed("payer physical delete and same-context repair " + str(rollback))

        # V51's current closeout owner composes with the deferred invoice observer.
        for rollback in (False, True):
            x = fixture(run=True)
            before = snapshot(x)
            claim = f"SELECT public.claim_billing_invoice_closeout_operation_v1({quote(x['studio'])},{quote(x['actor'])},'invoice.void','invoice_void',{quote(x['invoice'])},{quote(x['payer'])},{quote(str(uuid4()))},repeat('a',64),{quote('acct_' + x['studio'].replace('-', ''))},1,gen_random_uuid(),30);"
            owner = session("closeout", claim + mutate(x, "status='void'"), hold=True)
            ready(owner)
            require(snapshot(x) == before, "Closeout exposed uncommitted episode")
            release(owner, rollback=rollback)
            after = snapshot(x)
            require((after == before) == rollback, "Closeout episode rollback mismatch")
            if not rollback:
                require(
                    after["state"]["current_episode_id"] is None
                    and after["runs"][0]["cancel_reason"] == "invoice_not_open",
                    "Closeout failed permanent closure",
                )
            passed("actual V31 V51 closeout resource owner " + str(rollback))
        x = fixture(run=True)
        before = snapshot(x)
        holder = session(
            "closeout_workflow_busy",
            f"SELECT id FROM public.automation_workflows WHERE id={quote(x['workflow'])} FOR SHARE;",
            hold=True,
        )
        ready(holder)
        claim = f"SELECT public.claim_billing_invoice_closeout_operation_v1({quote(x['studio'])},{quote(x['actor'])},'invoice.void','invoice_void',{quote(x['invoice'])},{quote(x['payer'])},{quote(str(uuid4()))},repeat('b',64),{quote('acct_' + x['studio'].replace('-', ''))},1,gen_random_uuid(),30);"
        got = invoke(
            claim
            + mutate(x, "status='void'")
            + " SELECT private.workflow_finalize_invoice_episodes_v1();"
        )
        require(
            not got["ok"] and got["code"] == "55P03" and snapshot(x) == before,
            "Closeout union failure committed source",
        )
        require(
            sql(
                f"SELECT count(*) FROM public.billing_provider_operations WHERE studio_id={quote(x['studio'])};"
            )
            == "0",
            "Failed closeout retained operation",
        )
        release(holder)
        sql(claim + mutate(x, "status='void'"))
        require(
            snapshot(x)["state"]["current_episode_id"] is None,
            "Closeout retry did not close episode",
        )
        passed(
            "closeout alias resource operation and source rollback on late union refusal"
        )

        # Current management cancellation intent is permanent and is not replaced.
        for action in ("pause", "cancel"):
            x = fixture(run=True)
            if action == "pause":
                command = f"SELECT public.command_automation_workflow_v1({quote(x['studio'])},{quote(x['actor'])},{quote(x['workflow'])},gen_random_uuid(),3,'pause');"
            else:
                command = f"SELECT public.cancel_automation_workflow_run_v1({quote(x['studio'])},{quote(x['actor'])},{quote(x['run'])},gen_random_uuid(),2);"
            sql(command)
            old_run = snapshot(x)["runs"][0]
            sql(mutate(x) + mutate(x, "status='open'"))
            require(
                snapshot(x)["runs"][0] == old_run,
                "Episode replaced prior cancellation intent",
            )
            passed("permanent management intent retained " + action)

        # The actual clear gate serializes physical removal and retained history.
        for rollback in (False, True):
            x = fixture(run=True)
            before = snapshot(x)
            clear = session(
                "clear_first",
                f"SELECT public.clear_studio_operational_data_atomic({quote(x['studio'])},false);",
                hold=True,
                role="postgres",
            )
            ready(clear)
            got = invoke(advance(x))
            require(
                not got["ok"] and got["message"] == "AUTOMATION_STUDIO_BUSY",
                "Clear gate did not refuse reader",
            )
            release(clear, rollback=rollback)
            after = snapshot(x)
            require(
                (after == before) == rollback, "Operational clear rollback mismatch"
            )
            if not rollback:
                require(
                    after["state"]["ever_removed"]
                    and after["state"]["current_episode_id"] is None,
                    "Clear lost logical tombstone",
                )
                require(
                    after["runs"][0]["state"] == "cancelled", "Clear resurrected run"
                )
            passed("actual clear commit rollback and no resurrection " + str(rollback))

        passed("unique final component races complete; assembled V57 restore is separate")
        final = value(INVENTORY)
        require(
            all(final.get(k) == v for k, v in installed.items()),
            "Restore changed installed owner bodies or ACLs",
        )
        require(MIGRATION.read_bytes() == frozen, "Migration changed during proof")
        print(
            json.dumps(
                {
                    "cases": cases,
                    "lifetimes": lifetimes,
                    "source_sha256": hashlib.sha256(frozen).hexdigest(),
                    "contract_sha256": hashlib.sha256(
                        CONTRACT.read_bytes()
                    ).hexdigest(),
                    "runner_sha256": hashlib.sha256(
                        Path(__file__).read_bytes()
                    ).hexdigest(),
                    "historical_count": 151,
                    "baseline": BASE,
                    "limits": "Local episode authority only. No timed enrollment, sending or V57 readiness claim.",
                }
            ),
            flush=True,
        )
    finally:
        close_children()
        try:
            if owned:
                local.sql("postgres", f"DROP DATABASE {database} WITH (FORCE);")
                owned = False
                lifetimes.append(
                    {"action": "drop-final", "name": database, "at": time.time()}
                )
        finally:
            if dump_owned and dump.exists():
                dump.unlink()
        require(
            local.sql(
                "postgres",
                f"SELECT NOT EXISTS(SELECT 1 FROM pg_database WHERE datname={quote(database)});",
            )
            == "t",
            "Owned clone remains",
        )
        require(pid_file.read_text().splitlines()[0] == pid, "PM postmaster changed")
        require(
            local.sql(
                "postgres",
                "SELECT row_to_json(p) FROM public.koaryu_release_schema_preflight_v37() p;",
            )
            == baseline,
            "PM base changed",
        )
        require(
            historical
            == {
                p.name: hashlib.sha256(p.read_bytes()).hexdigest()
                for p in sorted(MIGRATION.parent.glob("*.sql"))
                if p != MIGRATION
            },
            "Historical files changed",
        )
        print(
            json.dumps(
                {
                    "owned_clone_removed": database,
                    "dump_removed": dump_owned and not dump.exists(),
                    "lifetimes": lifetimes,
                    "pm_pid_unchanged": pid,
                    "base_preflight_unchanged": True,
                    "historical_unchanged": 151,
                }
            ),
            flush=True,
        )


if __name__ == "__main__":
    main(sys.argv[1:])
