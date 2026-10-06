#!/usr/bin/env python3
"""Prove financial authority on one named, guarded, disposable PG17 clone.

Only synthetic local data. No credentials, environment files, network or mail.
Logical restore reuses the owned database name after dropping its canonical copy.
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
CONTRACT = ROOT / "supabase/verification/workflow_financial_authority_contract.sql"


def quote(value):
    if value is None:
        return "NULL"
    if isinstance(value, (dict, list)):
        value = json.dumps(value, separators=(",", ":"))
    return "'" + str(value).replace("'", "''") + "'"


def include(path):
    value = str(path.resolve())
    require(not any(c in value for c in "\r\n\x00"), "Unsupported psql file path")
    return "\\i '" + value.replace("\\", "\\\\").replace("'", "''") + "'"


def main(arguments):
    require(len(arguments) == 4, "Expected psql socket port unique-owned-clone-name")
    psql, socket, port, database = arguments
    require(
        re.fullmatch(r"koaryu_financial_authority_[a-z0-9_]+", database),
        "Unexpected clone name",
    )
    local = LocalPostgres(psql, socket, port, str(Path(socket).parent))
    historical = {
        p.name: hashlib.sha256(p.read_bytes()).hexdigest()
        for p in MIGRATION.parent.glob("*.sql")
        if p != MIGRATION
    }
    require(len(historical) == 151, "Expected 151 historical migrations")
    migration_hash = hashlib.sha256(MIGRATION.read_bytes()).hexdigest()
    children, cases = [], []
    owned = False

    def sql(statement):
        return local.sql(database, statement)

    def value(statement):
        return json.loads(sql(statement))

    def passed(name, **evidence):
        cases.append({"case": name, "outcome": "passed", **evidence})
        print("[financial authority] PASS " + name, flush=True)

    def session(name, statement, hold=False, role="service_role"):
        name = f"financial_{os.getpid()}_{name}_{len(children)}"[:63]
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
            f"SET application_name={quote(name)};\nBEGIN;\nSET LOCAL statement_timeout='20s';\nSET LOCAL ROLE {role};\n{statement}\n"
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
        raise RuntimeError("Session did not reach barrier")

    def finished(item, error=None):
        code = item["process"].wait(timeout=25)
        for thread in item["threads"]:
            thread.join(timeout=2)
        errors = "\n".join(item["errors"])
        for stream in (
            item["process"].stdin,
            item["process"].stdout,
            item["process"].stderr,
        ):
            if not stream.closed:
                stream.close()
        if error:
            require(
                code != 0
                and error in errors
                and "deadlock detected" not in errors
                and "statement timeout" not in errors,
                f"Expected immediate {error}: {errors}",
            )
        else:
            require(code == 0, "Session failed: " + errors)
        return errors

    def release(item, rollback=False):
        item["process"].stdin.write("ROLLBACK;\n" if rollback else "COMMIT;\n")
        item["process"].stdin.close()
        finished(item)

    def continue_session(item, statement):
        item["process"].stdin.write(statement + "\nCOMMIT;\n")
        item["process"].stdin.close()

    def blocked(holder, waiter):
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            require(
                waiter["process"].poll() is None,
                "Waiter exited: " + "\n".join(waiter["errors"]),
            )
            if (
                sql(
                    "SELECT count(*) FROM pg_stat_activity h JOIN pg_stat_activity w ON h.datname=w.datname "
                    f"WHERE h.application_name={quote(holder['name'])} AND w.application_name={quote(waiter['name'])} "
                    "AND h.pid=ANY(pg_blocking_pids(w.pid)) AND w.wait_event_type='Lock';"
                )
                == "1"
            ):
                return
            time.sleep(0.025)
        raise RuntimeError("Expected lock wait was not observed")

    def fixture():
        return value("SELECT financial_proof.financial_fixture();")

    def payment(x, status="succeeded", changes=None, identity=None):
        return f"SELECT financial_proof.financial_payment({quote(x)},{quote(status)},{quote(changes or {})},{quote(identity or str(uuid4()))});"

    def state(x):
        return value(f"SELECT financial_proof.financial_state({quote(x['studio'])});")

    def prepare(x, payment_id=None):
        return f"SELECT private.workflow_prepare_financial_context_v1({quote(x['studio'])},{quote(x['invoice'])},{quote(payment_id)});"

    def generation(x):
        return int(
            sql(
                f"SELECT generation FROM private.workflow_invoice_settlement_authority WHERE invoice_id={quote(x['invoice'])};"
            )
        )

    def functions():
        result = value("""SELECT jsonb_object_agg(p.oid::regprocedure::text,jsonb_build_object('definition',pg_get_functiondef(p.oid),
            'acl',p.proacl,'config',p.proconfig,'security',p.prosecdef,'owner',p.proowner)) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
            WHERE n.nspname IN ('private','public') AND p.proname IN ('validate_billing_payment_refs','validate_billing_payment_identity_change',
            'enforce_billing_payment_refundable_amount_v31','recompute_billing_payment_adjustment_totals','validate_billing_adjustment_payment_identity',
            'enforce_billing_payer_connect_identity_v1','claim_payment_payer_operation_resource_v31','claim_billing_invoice_closeout_operation_v1',
            'record_external_payment_v1','clear_studio_operational_data_atomic','recompute_billing_invoice_external_payment_totals');""")
        require(len(result) == 11, "Incomplete current financial owner inventory")
        return result

    def retained_rows():
        entries = [
            f"SELECT {quote(table)} AS name,(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]') FROM {table} t) AS rows"
            for table in retained_tables
        ]
        return value(
            "SELECT jsonb_object_agg(name,rows) FROM ("
            + " UNION ALL ".join(entries)
            + ") retained;"
        )

    def absent_install():
        return (
            sql(
                "SELECT to_regclass('private.workflow_payment_capture_markers') IS NULL AND "
                "to_regclass('private.workflow_invoice_settlement_authority') IS NULL AND to_regclass('private.workflow_payment_settlement_observations') IS NULL "
                "AND to_regclass('public.automation_workflows') IS NULL AND (SELECT count(*)=151 FROM supabase_migrations.schema_migrations);"
            )
            == "t"
        )

    with tempfile.TemporaryDirectory(prefix="koaryu-financial-proof-") as directory:
        directory = Path(directory)
        frozen = directory / "frozen V57's \\ migration.sql"
        frozen.write_bytes(MIGRATION.read_bytes())
        fixture_sql = (
            CONTRACT.read_text()
            .split("-- fixture owners start:", 1)[1]
            .split("\n", 1)[1]
            .split("-- fixture owners end.", 1)[0]
            .replace("pg_temp.", "financial_proof.")
        )
        initial_fixture_sql = fixture_sql.split(
            "CREATE FUNCTION financial_proof.financial_state", 1
        )[0]
        try:
            base = json.loads(
                local.sql(
                    "postgres",
                    "SELECT row_to_json(x) FROM public.koaryu_release_schema_preflight_v37() x;",
                )
            )
            require(
                base["ready"] is True
                and base["migration_count"] == 151
                and base["manifest_version"] == "release-db-attestation-v56",
                "Base is not strict V56",
            )
            require(
                local.sql(
                    "postgres",
                    "SELECT count(*) FROM pg_stat_activity WHERE datname='postgres' AND pid<>pg_backend_pid();",
                )
                == "0",
                "Template has other sessions",
            )
            require(
                local.sql(
                    "postgres",
                    f"SELECT count(*) FROM pg_database WHERE datname={quote(database)};",
                )
                == "0",
                "Clone exists",
            )
            print(
                "[financial authority] announced template copy " + database, flush=True
            )
            local.sql("postgres", f"CREATE DATABASE {database} TEMPLATE postgres;")
            owned = True
            print(
                "[financial authority] template copy complete " + database, flush=True
            )
            retained_tables = value(
                "SELECT jsonb_agg(format('%I.%I',n.nspname,c.relname) ORDER BY n.nspname,c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='r' AND n.nspname IN ('public','private','auth');"
            )
            sql(
                "CREATE SCHEMA financial_proof; GRANT USAGE ON SCHEMA financial_proof TO service_role;\n"
                + initial_fixture_sql
                + "\nGRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA financial_proof TO service_role;"
            )
            # All four actual financial DML owners refuse installation immediately.
            for table in (
                "studio_payment_accounts",
                "billing_payers",
                "billing_invoices",
                "billing_payments",
            ):
                for rollback in (False, True):
                    x = fixture()
                    pid = str(uuid4())
                    sql(payment(x, identity=pid))
                    before, definitions = retained_rows(), functions()
                    column, identity = (
                        ("studio_id", x["studio"])
                        if table == "studio_payment_accounts"
                        else (
                            "id",
                            x[
                                {
                                    "billing_payers": "payer",
                                    "billing_invoices": "invoice",
                                }.get(table, "invoice")
                            ],
                        )
                    )
                    if table == "billing_payments":
                        identity = pid
                    holder = session(
                        "old_dml_" + table,
                        f"UPDATE public.{table} SET metadata=metadata WHERE {column}={quote(identity)};",
                        hold=True,
                    )
                    ready(holder)
                    finished(
                        session("refused_install", include(frozen), role="postgres"),
                        "55P03",
                    )
                    require(
                        absent_install()
                        and retained_rows() == before
                        and functions() == definitions,
                        "Refused installer left partial effects",
                    )
                    release(holder, rollback)
                    passed(
                        f"complete NOWAIT installer rollback for {table}, old owner rollback={rollback}"
                    )
            # A real cached external-payment BEFORE function is executing while install refuses.
            x = fixture()
            holder = session(
                "invoice_blocks_cached_refs",
                f"UPDATE public.billing_invoices SET metadata=metadata WHERE id={quote(x['invoice'])};",
                hold=True,
            )
            ready(holder)
            writer = session("cached_external_refs", payment(x, "externally_recorded"))
            blocked(holder, writer)
            definitions = functions()
            finished(
                session("cached_refused_install", include(frozen), role="postgres"),
                "55P03",
            )
            require(
                absent_install() and functions() == definitions,
                "Cached-writer refusal changed installed functions",
            )
            release(holder)
            finished(writer)
            passed("actual cached payment refs body crosses refused installation")
            baseline = fixture()
            ids = {
                name: str(uuid4())
                for name in (
                    "valid",
                    "invalid",
                    "zero",
                    "orphan",
                    "refunded",
                    "disputed",
                    "failed",
                )
            }
            for name, status, changes in [
                ("valid", "succeeded", {}),
                ("invalid", "succeeded", {"currency": "bad"}),
                ("zero", "succeeded", {"amount_cents": 0}),
                ("orphan", "succeeded", {"invoice_id": None}),
                ("refunded", "refunded", {}),
                ("disputed", "disputed", {}),
                ("failed", "failed", {}),
            ]:
                sql(payment(baseline, status, changes, ids[name]))
            before, definitions = retained_rows(), functions()
            sql("BEGIN;\n" + include(frozen) + "\nCOMMIT;")
            require(
                retained_rows() == before and functions() == definitions,
                "Installation changed financial owners/business rows",
            )
            require(
                sql("SELECT count(*)=0 FROM private.automation_workflow_events;")
                == "t",
                "Installer emitted events",
            )
            require(
                sql(
                    f"SELECT baseline AND accepted_generation=1 AND NOT uncertain FROM private.workflow_payment_settlement_observations WHERE payment_id={quote(ids['valid'])};"
                )
                == "t",
                "Valid baseline classification",
            )
            require(
                sql(
                    f"SELECT count(*)=3 AND bool_and(uncertain AND NOT baseline AND accepted_generation IS NULL) FROM private.workflow_payment_settlement_observations WHERE payment_id=ANY(ARRAY[{','.join(quote(ids[k]) for k in ('invalid', 'zero', 'orphan'))}]::uuid[]);"
                )
                == "t",
                "Invalid/zero/orphan baseline classification",
            )
            require(
                sql(
                    f"SELECT count(*)=0 FROM private.workflow_payment_settlement_observations WHERE payment_id=ANY(ARRAY[{quote(ids['refunded'])},{quote(ids['disputed'])}]::uuid[]);"
                )
                == "t",
                "Refund/dispute inferred baseline success",
            )
            require(
                sql(
                    f"SELECT bool_and(NOT eligible) FROM private.workflow_payment_capture_markers WHERE studio_id={quote(baseline['studio'])};"
                )
                == "t",
                "Baseline payment exclusions changed",
            )
            passed(
                "fresh exact install retains financial rows/functions and classifies baseline without occurrences",
                migration_sha256=migration_hash,
                retained_table_count=len(retained_tables),
                financial_owner_hashes={
                    name: hashlib.sha256(entry["definition"].encode()).hexdigest()
                    for name, entry in definitions.items()
                },
            )
            sql(
                "CREATE FUNCTION financial_proof.financial_state"
                + fixture_sql.split(
                    "CREATE FUNCTION financial_proof.financial_state", 1
                )[1]
            )
            for file in (
                CONTRACT,
                ROOT
                / "supabase/verification/workflow_student_payment_capture_contract.sql",
                ROOT / "supabase/verification/workflow_domain_capture_contract.sql",
            ):
                output = sql(include(file))
                passed("rollback contract " + file.name, output=output)
            # Exact current parent locks refuse, then explicit source retry succeeds.
            for table, field in [
                ("billing_invoices", "invoice"),
                ("billing_payers", "payer"),
                ("studio_payment_accounts", "studio"),
            ]:
                for rollback in (False, True):
                    x = fixture()
                    pid = str(uuid4())
                    sql(payment(x, "processing", identity=pid))
                    before = state(x)
                    column = "studio_id" if field == "studio" else "id"
                    holder = session(
                        "source_parent",
                        f"SELECT 1 FROM public.{table} WHERE {column}={quote(x[field])} FOR UPDATE;",
                        hold=True,
                    )
                    ready(holder)
                    update = f"UPDATE public.billing_payments SET status='succeeded',net_collected_amount_cents=amount_cents WHERE id={quote(pid)};"
                    finished(session("source_tail", update), "AUTOMATION_STUDIO_BUSY")
                    require(
                        state(x) == before,
                        "Busy source tail changed financial/private truth",
                    )
                    release(holder, rollback)
                    finished(session("explicit_source_retry", update))
                    require(generation(x) == 2, "Retry did not accept exactly once")
                    passed(
                        f"parent SHARE NOWAIT atomic refusal/retry {table} rollback={rollback}"
                    )
                    # Reverse: preparation retains its sources while the ordinary owner waits.
                    holder = session("effect_sources", prepare(x, pid), hold=True)
                    ready(holder)
                    writer = session(
                        "ordinary_parent_update",
                        f"UPDATE public.{table} SET metadata=metadata WHERE {column}={quote(x[field])};",
                    )
                    blocked(holder, writer)
                    release(holder, rollback)
                    finished(writer)
                    passed(
                        f"effect ownership before ordinary {table} writer rollback={rollback}"
                    )
            # Pause candidate SELECT after admission: a new contributor cannot commit in that gap.
            for rollback in (False, True):
                x = fixture()
                pid, added = str(uuid4()), str(uuid4())
                sql(payment(x, identity=pid))
                # Compile the row-typed observer before the artificial table-DDL barrier.
                contender = session(
                    "compiled_contributor",
                    f"SELECT private.workflow_observe_payment_settlement_v1({quote(x['studio'])},{quote(str(uuid4()))});",
                    hold=True,
                )
                ready(contender)
                contender["process"].stdin.write(
                    "COMMIT; BEGIN; SET LOCAL statement_timeout='20s'; SET LOCAL ROLE service_role; SELECT 'RESULT_READY';\n"
                )
                contender["process"].stdin.flush()
                ready(contender)
                barrier = session(
                    "candidate_read_barrier",
                    "LOCK TABLE private.workflow_payment_settlement_observations IN ACCESS EXCLUSIVE MODE;",
                    hold=True,
                    role="postgres",
                )
                ready(barrier)
                effect = session("admission_before_candidates", prepare(x), hold=True)
                blocked(barrier, effect)
                continue_session(contender, payment(x, identity=added))
                finished(contender, "AUTOMATION_STUDIO_BUSY")
                require(
                    sql(
                        f"SELECT count(*) FROM public.billing_payments WHERE id={quote(added)};"
                    )
                    == "0",
                    "Contributor committed before candidate freeze",
                )
                release(barrier)
                ready(effect)
                deletion = session(
                    "contributor_delete_after_prepare",
                    f"DELETE FROM public.billing_payments WHERE id={quote(pid)};",
                )
                blocked(effect, deletion)
                release(effect, rollback)
                finished(deletion)
                require(
                    generation(x) == 2, "Contributor race changed accepted generation"
                )
                passed(
                    f"admission precedes candidate snapshot and protects contributors rollback={rollback}"
                )
            # Distinct transaction start time and UUID order never define settlement order.
            for rollback in (False, True):
                x = fixture()
                sql(f"SELECT financial_proof.financial_workflow({quote(x)});")
                older = session("older_transaction", "SELECT 1;", hold=True)
                ready(older)
                settled = session(
                    "newer_settlement",
                    payment(x, identity="ffffffff-ffff-4fff-8fff-" + uuid4().hex[:12]),
                    hold=True,
                )
                ready(settled)
                competing = payment(
                    x, "failed", identity="00000000-0000-4000-8000-" + uuid4().hex[:12]
                )
                finished(
                    session("invoice_admission_conflict", competing),
                    "AUTOMATION_STUDIO_BUSY",
                )
                release(settled, rollback)
                continue_session(older, competing)
                finished(older)
                expected = 1 if rollback else 2
                require(
                    sql(
                        f"SELECT context->>'invoice_settlement_generation' FROM private.automation_workflow_events WHERE studio_id={quote(x['studio'])};"
                    )
                    == str(expected),
                    "Failure used transaction time/UUID order",
                )
                passed(
                    f"invoice commit authority overrides transaction start and UUID order rollback={rollback}"
                )
            # Workflow wait occurs only after all repaired payment sources are owned.
            for rollback in (False, True):
                x = fixture()
                wid = sql(f"SELECT financial_proof.financial_workflow({quote(x)});")
                sql(payment(x, "failed"))
                sql(
                    f"UPDATE public.billing_payers SET stripe_account_id=NULL,stripe_customer_id=NULL,connect_account_generation=NULL WHERE id={quote(x['payer'])};"
                )
                candidates = [str(uuid4()), str(uuid4())]
                for pid in candidates:
                    sql(payment(x, identity=pid))
                sql(
                    f"UPDATE public.billing_payers SET stripe_account_id='acct_'||replace(studio_id::text,'-',''),stripe_customer_id='cus_'||id,connect_account_generation=1 WHERE id={quote(x['payer'])};"
                )
                holder = session(
                    "workflow_barrier",
                    f"SELECT 1 FROM public.automation_workflows WHERE id={quote(wid)} FOR UPDATE;",
                    hold=True,
                )
                ready(holder)
                worker = session("bounded_repair", prepare(x))
                blocked(holder, worker)
                for pid in candidates:
                    finished(
                        session(
                            "all_repair_sources_owned",
                            f"SELECT 1 FROM public.billing_payments WHERE id={quote(pid)} FOR UPDATE NOWAIT;",
                        ),
                        "55P03",
                    )
                release(holder, rollback)
                finished(worker)
                require(
                    generation(x) == 3
                    and sql(
                        f"SELECT bool_and(cancel_reason='payment_settled') FROM public.automation_workflow_runs WHERE studio_id={quote(x['studio'])};"
                    )
                    == "t",
                    "Union cancellation failed",
                )
                passed(
                    f"all bounded sources owned before single workflow/run cancellation union rollback={rollback}"
                )
            # Actual payer->account, payment->invoice and V47/V51 owners, no copied bodies.
            for owner in (
                "payer_account",
                "external_invoice",
                "resource_v47",
                "closeout_v51",
                "adjustment",
            ):
                for rollback in (False, True):
                    x = fixture()
                    pid = str(uuid4())
                    sql(
                        payment(
                            x, identity=pid, changes={"stripe_charge_id": "ch_" + pid}
                        )
                    )
                    if owner == "payer_account":
                        lock = f"SELECT 1 FROM public.studio_payment_accounts WHERE studio_id={quote(x['studio'])} FOR UPDATE;"
                        action = f"UPDATE public.billing_payers SET stripe_customer_id='cus_changed' WHERE id={quote(x['payer'])};"
                    elif owner == "external_invoice":
                        lock = f"SELECT 1 FROM public.billing_invoices WHERE id={quote(x['invoice'])} FOR UPDATE;"
                        action = payment(x, "externally_recorded")
                    elif owner in ("resource_v47", "closeout_v51"):
                        lock = f"SELECT 1 FROM public.billing_payers WHERE id={quote(x['payer'])} FOR UPDATE;"
                        name = (
                            "public.claim_billing_provider_operation_resource_v1"
                            if owner == "resource_v47"
                            else "public.claim_billing_invoice_closeout_operation_v1"
                        )
                        op, kind, resource = (
                            ("payment.refund", "payment", pid)
                            if owner == "resource_v47"
                            else ("invoice.void", "invoice_void", x["invoice"])
                        )
                        action = (
                            f"SELECT {name}("
                            + ",".join(
                                quote(v)
                                for v in (
                                    x["studio"],
                                    x["actor"],
                                    op,
                                    kind,
                                    resource,
                                    x["payer"],
                                    str(uuid4()),
                                    "a" * 64,
                                    "acct_" + x["studio"].replace("-", ""),
                                    1,
                                    str(uuid4()),
                                    30,
                                )
                            )
                            + ");"
                        )
                    else:
                        lock = f"SELECT 1 FROM public.billing_invoices WHERE id={quote(x['invoice'])} FOR UPDATE;"
                        action = f"SELECT private.recompute_billing_payment_adjustment_totals({quote(pid)});"
                    holder = session("retained_owner_parent", lock, hold=True)
                    ready(holder)
                    writer = session(owner, action)
                    if owner == "adjustment":
                        finished(writer, "AUTOMATION_STUDIO_BUSY")
                    else:
                        blocked(holder, writer)
                        finished(
                            session("effect_during_owner", prepare(x, pid)),
                            "AUTOMATION_STUDIO_BUSY",
                        )
                    release(holder, rollback)
                    if owner == "adjustment":
                        finished(session("explicit_adjustment_retry", action))
                    else:
                        finished(writer)
                    require(
                        generation(x) in (2, 3), "Retained owner duplicated settlement"
                    )
                    passed(f"actual retained {owner} lock ordering rollback={rollback}")
            # Shared clear gate preserves evidence and makes effect ownership explicit.
            for rollback in (False, True):
                x = fixture()
                sql(payment(x))
                before = state(x)
                holder = session("prepare_before_clear", prepare(x), hold=True)
                ready(holder)
                clearer = session(
                    "real_clear",
                    f"SELECT public.clear_studio_operational_data_atomic({quote(x['studio'])},false);",
                )
                blocked(holder, clearer)
                release(holder, rollback)
                finished(clearer)
                require(
                    generation(x) == 2
                    and state(x)["observations"] == before["observations"],
                    "Clear erased financial authority",
                )
                passed(
                    f"actual clear waits for source ownership and retains logical evidence rollback={rollback}"
                )
            # Studio deletion waits on a payment; its late callback must refuse the studio NOWAIT.
            for rollback in (False, True):
                x = value("SELECT financial_proof.financial_fixture(false);")
                pid = str(uuid4())
                sql(payment(x, identity=pid))
                holder = session(
                    "owned_payment",
                    f"SELECT 1 FROM public.billing_payments WHERE id={quote(pid)} FOR UPDATE;",
                    hold=True,
                )
                ready(holder)
                deleter = session(
                    "studio_delete",
                    f"DELETE FROM public.studios WHERE id={quote(x['studio'])};",
                    hold=True,
                    role="postgres",
                )
                blocked(holder, deleter)
                continue_session(
                    holder,
                    f"UPDATE public.billing_payments SET metadata=metadata WHERE id={quote(pid)};",
                )
                finished(holder, "AUTOMATION_STUDIO_BUSY")
                ready(deleter)
                release(deleter, rollback)
                require(
                    sql(
                        f"SELECT count(*) FROM private.workflow_invoice_settlement_authority WHERE studio_id={quote(x['studio'])};"
                    )
                    == ("1" if rollback else "0"),
                    "Studio cascade/rollback differs",
                )
                passed(
                    f"studio deletion versus already-owned payment tail rollback={rollback}"
                )
            # Restore exact new schema/evidence using the same name, one clone at a time.
            x = fixture()
            pid = str(uuid4())
            orphan = str(uuid4())
            sql(payment(x, identity=pid))
            sql(payment(x, changes={"invoice_id": None}, identity=orphan))
            saved, saved_baseline = state(x), state(baseline)
            schema_sql = """SELECT jsonb_object_agg(c.relname,jsonb_build_object('owner',pg_get_userbyid(c.relowner),'acl',c.relacl,'logged',c.relpersistence,
                'rls',c.relrowsecurity,'constraints',(SELECT jsonb_agg(pg_get_constraintdef(k.oid) ORDER BY k.conname) FROM pg_constraint k WHERE k.conrelid=c.oid),
                'columns',(SELECT jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,a.attgenerated,a.attidentity,pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum) FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
                'indexes',(SELECT jsonb_agg(pg_get_indexdef(x.indexrelid) ORDER BY x.indexrelid::regclass::text) FROM pg_index x WHERE x.indrelid=c.oid),
                'triggers',(SELECT jsonb_agg(jsonb_build_array(t.tgname,pg_get_triggerdef(t.oid),t.tgenabled) ORDER BY t.tgname) FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal),
                'policies',(SELECT jsonb_agg(jsonb_build_array(p.polname,p.polpermissive,p.polcmd,p.polroles,pg_get_expr(p.polqual,p.polrelid),pg_get_expr(p.polwithcheck,p.polrelid)) ORDER BY p.polname) FROM pg_policy p WHERE p.polrelid=c.oid)))
                FROM pg_class c WHERE c.oid IN ('private.workflow_invoice_settlement_authority'::regclass,'private.workflow_payment_settlement_observations'::regclass);"""
            schema = value(schema_sql)
            dump = directory / "synthetic.dump"
            pg_dump = str(Path(psql).with_name("pg_dump"))
            pg_restore = str(Path(psql).with_name("pg_restore"))
            local.require_pg17(pg_dump, pg_restore)
            local.run(
                [
                    pg_dump,
                    *local.connection,
                    f"--dbname={database}",
                    "--format=custom",
                    f"--file={dump}",
                ]
            )
            sql(
                f"UPDATE public.billing_payments SET metadata=metadata WHERE id={quote(pid)}; UPDATE public.billing_payments SET invoice_id={quote(x['invoice'])} WHERE id={quote(orphan)};"
            )
            canonical = state(x)
            local.sql("postgres", f"DROP DATABASE {database};")
            owned = False
            require(
                local.sql(
                    "postgres",
                    f"SELECT count(*) FROM pg_database WHERE datname={quote(database)};",
                )
                == "0",
                "Canonical clone remains before restore",
            )
            local.sql("postgres", f"CREATE DATABASE {database} TEMPLATE template0;")
            owned = True
            local.run(
                [
                    pg_restore,
                    *local.connection,
                    f"--dbname={database}",
                    "--exit-on-error",
                    str(dump),
                ]
            )
            require(
                state(x) == saved
                and state(baseline) == saved_baseline
                and value(schema_sql) == schema,
                "Logical restore changed schema/evidence",
            )
            sql(
                f"UPDATE public.billing_payments SET metadata=metadata WHERE id={quote(pid)}; UPDATE public.billing_payments SET invoice_id={quote(x['invoice'])} WHERE id={quote(orphan)};"
            )
            restored = state(x)
            # Source UPDATE timestamps differ by execution; immutable authority/evidence must match exactly.
            for key in ("authority", "observations", "markers", "events", "runs"):
                require(
                    restored[key] == canonical[key],
                    "Restored continuation differs: " + key,
                )
            require(
                generation(x) == 3, "Restore duplicate/late-link advanced incorrectly"
            )
            passed(
                "exact private schema/evidence logical restore and duplicate/late-link continuation"
            )
            print(
                json.dumps(
                    {
                        "migration_sha256": migration_hash,
                        "cases": cases,
                        "historical_migrations_unchanged": 151,
                    }
                ),
                flush=True,
            )
        finally:
            for item in children:
                process = item["process"]
                if process.poll() is None:
                    if not process.stdin.closed:
                        process.stdin.close()
                    try:
                        process.wait(timeout=2)
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
                "Historical migrations changed",
            )
            require(
                hashlib.sha256(MIGRATION.read_bytes()).hexdigest() == migration_hash,
                "Migration changed during proof",
            )
            print(
                json.dumps(
                    {
                        "owned_clone_removed": database,
                        "historical_migrations_unchanged": 151,
                    }
                ),
                flush=True,
            )


if __name__ == "__main__":
    main(sys.argv[1:])
