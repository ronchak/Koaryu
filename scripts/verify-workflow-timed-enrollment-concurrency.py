#!/usr/bin/env python3
"""Guarded local PG17 timed enrollment, real locks, bounded scans and restore.

Exactly one exclusively owned clone at a time. No hosted target, dotenv, mail,
provider or release-readiness declaration. Real sources use accepted commands.
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
from importlib.metadata import version
from pathlib import Path

from local_postgres_verification import (
    LocalPostgres,
    require,
    install_final_v57,
    require_final_v57,
)

ROOT = Path(__file__).resolve().parents[1]
BASE = "35561d6b8f851ea0309723637e0996a064ba4c82"
BASE_HASH = "cab98ab987acf0c24a383be94f3e0499c6d891b922d7fd1de217e788c2a339b5"
TYPED_CANDIDATE = "private.workflow_timed_candidates_v1"
TYPED_CANDIDATE_BODY_HASHES = (
    "38ac23048c419ef2a64455aca124d0b8a5c46a122aaf6653e9170e5530685ca1",
    "07e98ac269cc740feac349b98223d486bec3ad4670e4c6f81521173fd4074493",
)
MIGRATION = (
    ROOT / "supabase/migrations/20261005105341_automation_workflow_graph_v57.sql"
)
CONTRACT = ROOT / "supabase/verification/workflow_timed_enrollment_contract.sql"
INVENTORY = """SELECT jsonb_object_agg(p.oid::regprocedure::text,jsonb_build_object(
'definition',pg_get_functiondef(p.oid),'acl',p.proacl::text,'owner',pg_get_userbyid(p.proowner),
'settings',p.proconfig,'volatility',p.provolatile,'security_definer',p.prosecdef))
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname IN ('public','private') AND p.prokind='f';"""


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
        re.fullmatch(r"koaryu_workflow_timed_[a-z0-9_]+", database),
        "Invalid owned clone",
    )
    local = LocalPostgres(psql, socket, port, str(Path(socket).parent))
    frozen = MIGRATION.read_bytes()
    source = frozen.decode()
    contract = CONTRACT.read_text()
    runner_bytes = Path(__file__).read_bytes()
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
    require(
        all(
            new_functions.get(name) == bodies
            for name, bodies in old_functions.items()
            if name != TYPED_CANDIDATE
        ),
        "Unaffected retained source body changed",
    )
    require(
        len(old_functions[TYPED_CANDIDATE]) == len(new_functions[TYPED_CANDIDATE]) == 1
        and tuple(
            hashlib.sha256(functions[TYPED_CANDIDATE][0].encode()).hexdigest()
            for functions in (old_functions, new_functions)
        )
        == TYPED_CANDIDATE_BODY_HASHES,
        "Timed candidate destination repair differs from the reviewed old/new bodies",
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
        print("[timed enrollment] PASS " + name, flush=True)

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

    def helpers(baseline_only=False):
        block = contract[
            contract.index("-- fixture owners start.") : contract.index(
                "-- fixture owners end."
            )
        ]
        if baseline_only:
            block = block[: block.index("CREATE FUNCTION pg_temp.timed_resume")]
        sql(
            "CREATE SCHEMA timed_proof; GRANT USAGE ON SCHEMA timed_proof TO service_role;"
            + block.replace("pg_temp.", "timed_proof.")
        )
        sql("GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA timed_proof TO service_role;")

    def fixture(
        kind="trial.upcoming", start="clock_timestamp()+INTERVAL '2 days'", offset=-1440
    ):
        return value(
            f"SELECT timed_proof.timed_workflow(timed_proof.timed_fixture({quote(kind)},{start}),{quote(kind)},{offset});"
        )

    def at(x):
        return sql(f"SELECT timed_proof.timed_at({quote(x)});")

    def snapshot():
        return value("SELECT timed_proof.timed_snapshot();")

    def scan(x, limit=100):
        return value(f"SELECT timed_proof.timed_scan({quote(at(x))},{limit});")

    def rpc(statement):
        return value(
            "SET ROLE service_role; SELECT timed_proof.timed_rpc("
            + quote(statement)
            + ");"
        )

    def scan_command(x, limit=100):
        return f"SELECT timed_proof.timed_scan({quote(at(x))},{limit});"

    def busy(statement):
        started = time.monotonic()
        got = rpc(statement)
        require(
            got.get("code") == "P0001"
            and got.get("message") == "AUTOMATION_STUDIO_BUSY",
            "Expected busy: " + json.dumps(got),
        )
        require(time.monotonic() - started < 3, "Busy call blocked")
        return got

    def isolate(x):
        sql(
            "UPDATE public.automation_workflow_activations SET retired_at=coalesce(retired_at,clock_timestamp()),cancelled_at=clock_timestamp() "
            f"WHERE cancelled_at IS NULL AND workflow_id<>{quote(x['workflow'])};"
        )

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
        sql("BEGIN;" + accepted + "COMMIT;")
        retained = value(INVENTORY)
        helpers(True)
        seeded = fixture()
        old_activation = value(
            f"SELECT to_jsonb(a) FROM public.automation_workflow_activations a WHERE id={quote(seeded['activation'])};"
        )
        candidate_start = source.index("CREATE FUNCTION " + TYPED_CANDIDATE + "(")
        candidate_tail = source[candidate_start:]
        marker = re.search(r"\bAS\s+(\$[A-Za-z_0-9]*\$)", candidate_tail)
        require(marker is not None, "Typed candidate delimiter missing")
        candidate_end = candidate_tail.index(marker.group(1), marker.end()) + len(
            marker.group(1)
        )
        candidate_end = candidate_tail.index(";", candidate_end) + 1
        candidate_statement = candidate_tail[:candidate_end].replace(
            "CREATE FUNCTION", "CREATE OR REPLACE FUNCTION", 1
        )
        sql(candidate_statement)
        closure = source.split(
            "-- Complete V57 installed-state attestation. Historical pins remain unchanged.\n",
            1,
        )[1]
        sql(
            "BEGIN;"
            + closure
            + "\nINSERT INTO supabase_migrations.schema_migrations(version,name) VALUES('20261005105341','automation_workflow_graph_v57');\nCOMMIT;"
        )
        require_final_v57(local, database, ROOT)
        require(
            sql(
                f"SELECT count(*) FROM private.workflow_timer_activations WHERE activation_id={quote(seeded['activation'])};"
            )
            == "1"
            and value(
                f"SELECT to_jsonb(a) FROM public.automation_workflow_activations a WHERE id={quote(seeded['activation'])};"
            )
            == old_activation,
            "Seed invented or changed an activation interval",
        )
        passed(
            "earlier accepted activation seeded from immutable version without interval rewrite"
        )
        drop()
        create()
        install_final_v57(local, database, ROOT)
        installed = value(INVENTORY)
        candidate_signature = (
            "private.workflow_timed_candidates_v1(integer,timestamp with time zone)"
        )
        require(
            all(
                installed.get(k) == v
                for k, v in retained.items()
                if k
                not in ("koaryu_release_schema_preflight_v37()", candidate_signature)
            ),
            "Unaffected retained definition/ACL/config changed",
        )
        require(
            {
                key: value
                for key, value in installed[candidate_signature].items()
                if key != "definition"
            }
            == {
                key: value
                for key, value in retained[candidate_signature].items()
                if key != "definition"
            },
            "Typed candidate repair changed ACL, ownership or settings",
        )
        passed(
            "unaffected retained definitions and complete function ACL ownership and settings identical",
            functions=len(retained),
        )
        contract_output = sql(contract)
        passed("complete timed SQL contract", output=contract_output)
        helpers()
        require(version("postgrest") == "0.17.2", "Pinned PostgREST client required")
        import httpx
        from postgrest import SyncPostgrestClient
        from postgrest.utils import SyncClient

        raw = value(
            "SET ROLE service_role; SELECT public.process_automation_workflow_occurrences_v1();"
        )
        with SyncPostgrestClient("http://timed-proof.invalid") as client:
            client.session.aclose()
            client.session = SyncClient(
                base_url="http://timed-proof.invalid",
                transport=httpx.MockTransport(
                    lambda req: httpx.Response(200, json=raw)
                ),
            )
            parsed = (
                client.rpc(
                    "process_automation_workflow_occurrences_v1", {"p_limit": 100}
                )
                .execute()
                .data
            )
            require(parsed == raw, "Installed SDK changed the RPC envelope")
        require(
            set(raw) == {"payload"}
            and set(raw["payload"])
            == {"created_event_count", "enqueued_run_count", "has_more"},
            "Aggregate leaked keys",
        )
        require(
            all(
                type(raw["payload"][k]) is int and 0 <= raw["payload"][k] <= 100
                for k in ("created_event_count", "enqueued_run_count")
            )
            and type(raw["payload"]["has_more"]) is bool,
            "Strict aggregate types",
        )
        passed(
            "installed PostgREST 0.17.2 parses actual closed aggregate", envelope=raw
        )
        for family, target_count, source_count in (
            ("invoice.overdue", 2, 10),
            ("belt_test.upcoming", 5, 1),
        ):
            start = (
                "clock_timestamp()"
                if family == "invoice.overdue"
                else "clock_timestamp()+INTERVAL '1 day 12 seconds'"
            )
            x = value(f"SELECT timed_proof.timed_fixture({quote(family)},{start});")
            if family == "invoice.overdue":
                sql(
                    f"INSERT INTO public.billing_invoices SELECT (jsonb_populate_record(NULL::public.billing_invoices,to_jsonb(i) "
                    f"||jsonb_build_object('id',gen_random_uuid(),'stripe_invoice_id','in_'||gen_random_uuid()))).* "
                    f"FROM public.billing_invoices i CROSS JOIN generate_series(1,9) WHERE i.id={quote(x['source'])};"
                )
            else:
                sql(
                    f"INSERT INTO public.belt_test_events SELECT (jsonb_populate_record(NULL::public.belt_test_events,to_jsonb(e) "
                    f"||jsonb_build_object('id',gen_random_uuid(),'starts_at',e.starts_at-INTERVAL '1 second','ends_at',e.ends_at-INTERVAL '1 second'))).* "
                    f"FROM public.belt_test_events e CROSS JOIN generate_series(1,25) WHERE e.id={quote(x['parent'])};"
                )
            for index in range(target_count):
                workflow = value(
                    f"SELECT timed_proof.timed_workflow({quote(x)},{quote(family)});"
                )
                if index == 0:
                    isolate(workflow)
            if family == "invoice.overdue":
                # Historical clocks are fixture-only. Restore both guards before
                # every actual public call; do not claim real historical creation.
                sql(
                    "BEGIN; ALTER TABLE private.workflow_invoice_collection_episodes DISABLE TRIGGER workflow_invoice_episode_identity_v1; "
                    f"UPDATE private.workflow_invoice_collection_episodes SET opened_at=threshold_at-INTERVAL '1 day',threshold_eligible=true WHERE studio_id={quote(x['studio'])}; "
                    "ALTER TABLE private.workflow_invoice_collection_episodes ENABLE TRIGGER workflow_invoice_episode_identity_v1; "
                    "ALTER TABLE public.automation_workflow_activations DISABLE TRIGGER automation_workflow_activations_immutable; "
                    f"UPDATE public.automation_workflow_activations SET active_from=(SELECT min(threshold_at)-INTERVAL '1 hour' FROM private.workflow_invoice_collection_episodes "
                    f"WHERE studio_id={quote(x['studio'])}) WHERE studio_id={quote(x['studio'])}; "
                    "ALTER TABLE public.automation_workflow_activations ENABLE TRIGGER automation_workflow_activations_immutable; COMMIT;"
                )
            else:
                require(
                    sql(
                        f"SELECT bool_and(active_from<=(SELECT max(starts_at)-INTERVAL '1 day' FROM public.belt_test_events WHERE studio_id={quote(x['studio'])})) "
                        f"FROM public.automation_workflow_activations WHERE studio_id={quote(x['studio'])};"
                    )
                    == "t",
                    "Belt activation missed real threshold",
                )
                sql(
                    f"SELECT pg_sleep(greatest(0,extract(epoch FROM ((SELECT max(starts_at)-INTERVAL '1 day' FROM public.belt_test_events "
                    f"WHERE studio_id={quote(x['studio'])})-clock_timestamp())))+0.05);"
                )
            sql(
                "UPDATE private.workflow_timer_dispatch_cursor SET last_studio_id=NULL,last_activation_id=NULL;"
            )
            parent_ids = value(
                f"SELECT coalesce(jsonb_agg(id ORDER BY starts_at,id),'[]') FROM public.belt_test_events WHERE studio_id={quote(x['studio'])};"
            )
            positions = {
                identity: index + 1 for index, identity in enumerate(parent_ids)
            }
            state_query = f"""SELECT jsonb_build_object('rows',(
                SELECT jsonb_agg(jsonb_build_object('activation',t.activation_id,'updated_at',t.updated_at,'parent',t.last_event_id,
                    'runs',(SELECT count(*) FROM public.automation_workflow_runs r WHERE r.workflow_id=t.workflow_id)) ORDER BY t.activation_id)
                FROM private.workflow_timer_activations t WHERE t.studio_id={quote(x["studio"])}),
                'events',(SELECT count(*) FROM private.automation_workflow_events WHERE studio_id={quote(x["studio"])} AND event_type={quote(family)}),
                'runs',(SELECT count(*) FROM public.automation_workflow_runs WHERE studio_id={quote(x["studio"])}),
                'cursor',(SELECT last_activation_id FROM private.workflow_timer_dispatch_cursor));"""
            before = value(state_query)
            progress = []
            for iteration in range(8):
                outcome = value(
                    "SET ROLE service_role; SELECT public.process_automation_workflow_occurrences_v1(100);"
                )["payload"]
                after = value(state_query)
                changed = [
                    row
                    for row, prior in zip(after["rows"], before["rows"], strict=True)
                    if row["updated_at"] != prior["updated_at"]
                ]
                require(
                    outcome["has_more"]
                    and all(
                        type(outcome[key]) is int and 0 <= outcome[key] <= 100
                        for key in ("created_event_count", "enqueued_run_count")
                    ),
                    "Public cap response exceeded bounds",
                )
                require(
                    outcome["created_event_count"] == after["events"] - before["events"]
                    and outcome["enqueued_run_count"] == after["runs"] - before["runs"],
                    "Public counts are not actual inserts",
                )
                require(
                    after["cursor"] in {row["activation"] for row in changed},
                    "Cursor advanced past last processed activation",
                )
                if family == "invoice.overdue":
                    require(
                        len(changed) == 1 and outcome["enqueued_run_count"] <= 10,
                        "Invoice cap processed another activation",
                    )
                    raw_parents = 0
                else:
                    visits = [
                        (
                            positions.get(row["parent"], 0)
                            - positions.get(prior["parent"], 0)
                        )
                        % len(parent_ids)
                        for row, prior in zip(
                            after["rows"], before["rows"], strict=True
                        )
                    ]
                    raw_parents = sum(visits)
                    require(
                        len(changed) == 4
                        and all(0 <= count <= 25 for count in visits)
                        and raw_parents == 100,
                        "Actual parent progress exceeded 25/100 caps",
                    )
                counts = [row["runs"] for row in after["rows"]]
                if iteration >= 3:
                    require(
                        counts == [source_count] * target_count
                        and after["events"] == source_count,
                        "Public cap continuation starved a workflow or duplicated an occurrence",
                    )
                progress.append(
                    {
                        "call": iteration + 1,
                        "result": outcome,
                        "runs": counts,
                        "processed_activations": len(changed),
                        "raw_parents": raw_parents,
                    }
                )
                before = after
            passed(
                "actual public global-cap continuation " + family,
                calls=progress,
                clocks="historical fixture clocks with restored guards"
                if family == "invoice.overdue"
                else "actual approval and activation before real threshold wait",
            )
        x = fixture(start="clock_timestamp()+INTERVAL '63 seconds'", offset=-1)
        isolate(x)
        require(
            value("SELECT public.process_automation_workflow_occurrences_v1();")[
                "payload"
            ]["enqueued_run_count"]
            == 0,
            "Public scanner crossed early",
        )
        delay = float(
            sql(
                f"SELECT greatest(0,extract(epoch FROM timed_proof.timed_at({quote(x)})-clock_timestamp()));"
            )
        )
        require(delay < 5, "Unexpected public crossing wait")
        time.sleep(delay + 0.03)
        got = value(
            "SET ROLE service_role; SELECT public.process_automation_workflow_occurrences_v1();"
        )["payload"]
        require(
            got["created_event_count"] == 1 and got["enqueued_run_count"] == 1,
            "Actual public crossing did not enroll",
        )
        require(
            value("SELECT public.process_automation_workflow_occurrences_v1();")[
                "payload"
            ]["enqueued_run_count"]
            == 0,
            "Public overlap duplicated",
        )
        passed(
            "actual public clock crossing and replay through service role", result=got
        )
        for family in ("trial.upcoming", "belt_test.upcoming", "invoice.overdue"):
            x = fixture(family)
            isolate(x)
            locks = [
                (
                    "studio",
                    f"SELECT 1 FROM public.studios WHERE id={quote(x['studio'])} FOR UPDATE;",
                ),
                (
                    "subscription",
                    f"SELECT 1 FROM public.studio_subscriptions WHERE studio_id={quote(x['studio'])} FOR UPDATE;",
                ),
                (
                    "workflow",
                    f"SELECT 1 FROM public.automation_workflows WHERE id={quote(x['workflow'])} FOR UPDATE;",
                ),
                (
                    "clear",
                    f"SELECT pg_advisory_xact_lock(hashtextextended('koaryu.local-plan-clear:'||{quote(x['studio'])},0));",
                ),
            ]
            if family == "trial.upcoming":
                value(
                    f"SELECT timed_proof.timed_workflow({quote(x)},'trial.upcoming',-1440,{quote(x['program2'])});"
                )
                locks.append(
                    (
                        "other_filter",
                        f"SELECT 1 FROM public.programs WHERE id={quote(x['program2'])} FOR UPDATE;",
                    )
                )
                locks += [
                    (
                        "lead",
                        f"SELECT 1 FROM public.leads WHERE id={quote(x['lead'])} FOR UPDATE;",
                    ),
                    (
                        "appointment",
                        f"SELECT 1 FROM public.lead_trial_appointments WHERE id={quote(x['source'])} FOR UPDATE;",
                    ),
                    (
                        "program",
                        f"SELECT 1 FROM public.programs WHERE id={quote(x['program'])} FOR UPDATE;",
                    ),
                ]
            elif family == "belt_test.upcoming":
                locks += [
                    (
                        "event",
                        f"SELECT 1 FROM public.belt_test_events WHERE id={quote(x['parent'])} FOR UPDATE;",
                    ),
                    (
                        "recipient",
                        f"SELECT 1 FROM public.belt_test_recipients WHERE id={quote(x['source'])} FOR UPDATE;",
                    ),
                    (
                        "student",
                        f"SELECT 1 FROM public.students WHERE id={quote(x['student'])} FOR UPDATE;",
                    ),
                    (
                        "rank",
                        f"SELECT 1 FROM public.belt_ranks WHERE id={quote(x['rank'])} FOR UPDATE;",
                    ),
                    (
                        "ladder",
                        f"SELECT 1 FROM public.belt_ladders WHERE id={quote(x['ladder'])} FOR UPDATE;",
                    ),
                ]
            else:
                locks += [
                    (
                        "invoice",
                        f"SELECT 1 FROM public.billing_invoices WHERE id={quote(x['source'])} FOR UPDATE;",
                    ),
                    (
                        "payer",
                        f"SELECT 1 FROM public.billing_payers WHERE id={quote(x['payer'])} FOR UPDATE;",
                    ),
                    (
                        "account",
                        f"SELECT 1 FROM public.studio_payment_accounts WHERE studio_id={quote(x['studio'])} FOR UPDATE;",
                    ),
                    (
                        "settlement",
                        f"SELECT pg_advisory_xact_lock(hashtextextended('koaryu.workflow-invoice-settlement:'||{quote(x['studio'])}||':'||{quote(x['source'])},0));",
                    ),
                ]
            for label, statement in locks:
                holder = session(label, statement, hold=True)
                ready(holder)
                before = snapshot()
                busy(scan_command(x))
                require(
                    snapshot() == before, "Busy call partially changed durable state"
                )
                release(holder, rollback=True)
            passed(
                "source clear lifecycle lock refusal rolls back entire call " + family,
                owners=[label for label, _ in locks],
            )
        x = fixture()
        isolate(x)
        before = snapshot()
        holder = session(
            "scanner",
            f"SELECT private.workflow_timed_candidates_v1(100,{quote(at(x))});",
            hold=True,
        )
        ready(holder)
        busy("SELECT public.process_automation_workflow_occurrences_v1();")
        release(holder, rollback=True)
        require(snapshot() == before, "Overlapping scanner changed state")
        passed("overlapping scanner exact busy and cursor rollback")
        # Hold a completed discovery while actual source/lifecycle commands commit.
        for edit in ("reschedule", "pause", "archive", "delete", "program_archive"):
            x = fixture()
            isolate(x)
            observed = at(x)
            holder = session(
                "discover_" + edit,
                f"CREATE TEMP TABLE chosen AS SELECT private.workflow_timed_candidates_v1(100,{quote(observed)}) packet;",
                hold=True,
            )
            ready(holder)
            if edit == "reschedule":
                require(
                    rpc(
                        f"SELECT public.mutate_lead_trial_appointment_v1({quote(x['studio'])},{quote(x['actor'])},{quote(x['lead'])},{quote(x['source'])},gen_random_uuid(),1,"
                        "jsonb_build_object('starts_at',private.automation_utc_text_v1(clock_timestamp()+INTERVAL '3 days'),'ends_at',private.automation_utc_text_v1(clock_timestamp()+INTERVAL '3 days 1 hour')));"
                    )["ok"],
                    "Reschedule failed",
                )
            elif edit in ("pause", "archive"):
                require(
                    rpc(f"SELECT timed_proof.timed_command({quote(x)},{quote(edit)});")[
                        "ok"
                    ],
                    "Lifecycle failed",
                )
            elif edit == "delete":
                sql(f"DELETE FROM public.leads WHERE id={quote(x['lead'])};")
            else:
                sql(
                    f"UPDATE public.programs SET archived_at=clock_timestamp() WHERE id={quote(x['program'])};"
                )
            holder["process"].stdin.write(
                "SELECT private.workflow_lock_timed_sources_v1(packet->'pairs') FROM chosen;\n"
                + "SELECT private.workflow_enroll_timed_occurrence_v1((x->>'activation_id')::uuid,(x->>'subject_id')::uuid,(x->>'source_record_id')::uuid,"
                + f"(x->>'source_starts_at')::timestamptz,(x->>'threshold_at')::timestamptz,{quote(observed)}) FROM chosen,jsonb_array_elements(packet->'pairs') x;\n"
            )
            outcome = release(holder)
            require(
                outcome["enqueued_run"] is False, "Changed source/lifecycle admitted"
            )
            passed(
                "source command between discovery and admission " + edit,
                decision=outcome["decision"],
            )
        # Scanner-first ordering: source and lifecycle updates must wait or fail.
        for edit in ("pause", "publish", "program_archive"):
            x = fixture()
            isolate(x)
            holder = session("owned_" + edit, scan_command(x), hold=True)
            ready(holder)
            if edit == "program_archive":
                writer = session(
                    "program_writer",
                    f"UPDATE public.programs SET archived_at=clock_timestamp() WHERE id={quote(x['program'])};",
                )
            else:
                writer = session(
                    "lifecycle_writer",
                    f"SELECT timed_proof.timed_command({quote(x)},{quote(edit)});",
                )
            blocked(holder, writer)
            release(holder, rollback=True)
            finished(writer)
            require(
                sql(
                    f"SELECT count(*) FROM public.automation_workflow_runs WHERE workflow_id={quote(x['workflow'])};"
                )
                == "0",
                "Rolled-back scanner retained run",
            )
            passed("scanner source ownership precedes actual writer " + edit)
        for family, table, key, column in (
            ("trial.upcoming", "programs", "program", "id"),
            ("belt_test.upcoming", "belt_ranks", "rank", "id"),
            ("invoice.overdue", "studio_payment_accounts", "studio", "studio_id"),
        ):
            x = fixture(family)
            isolate(x)
            original = value(
                f"SELECT to_jsonb(t) FROM public.{table} t WHERE {column}={quote(x[key])};"
            )
            sql(f"DELETE FROM public.{table} WHERE {column}={quote(x[key])};")
            holder = session(
                "missing_" + key,
                f"CREATE TEMP TABLE chosen AS SELECT private.workflow_timed_candidates_v1(100,{quote(at(x))}) packet; "
                "CREATE TEMP TABLE held AS SELECT private.workflow_lock_timed_sources_v1(packet->'pairs') ownership FROM chosen; SELECT ownership FROM held;",
                hold=True,
            )
            ready(holder)
            held = json.loads(
                [line for line in holder["lines"] if line.startswith("{")][-1]
            )
            require(held == {"owned_pairs": []}, "Missing parent was certified owned")
            restore = f"INSERT INTO public.{table} SELECT (jsonb_populate_record(NULL::public.{table},{quote(original)})).*; SELECT '{{}}'::jsonb;"
            restored = rpc(restore)
            holder["process"].stdin.write(
                f"SELECT jsonb_build_object('decisions',timed_proof.timed_resume(packet,ownership,{quote(at(x))})) FROM chosen,held;\n"
            )
            require(
                release(holder)["decisions"] == [],
                "Later parent appeared in owned subset",
            )
            if not restored["ok"]:
                require(
                    restored["code"] == "P0001" and "BUSY" in restored["message"],
                    "Unexpected supported parent insertion refusal",
                )
                sql(restore)
            if family == "belt_test.upcoming":
                require(
                    rpc(
                        f"SELECT public.approve_belt_test_recipients_v1({quote(x['studio'])},{quote(x['actor'])},{quote(x['parent'])},gen_random_uuid(),1,"
                        f"jsonb_build_array(jsonb_build_object('student_id',{quote(x['student'])}::uuid,'student_program_membership_id',NULL)));"
                    )["ok"],
                    "Fresh approval failed",
                )
            require(
                scan(x)["enqueued"] == 1,
                "Fresh owned retry did not admit restored parent",
            )
            passed(
                "only actual owned parents admit " + table,
                insertion_committed=restored["ok"],
            )
        x = value("SELECT timed_proof.timed_repair_fixture();")
        isolate(x)
        y = value("SELECT timed_proof.timed_repair_fixture();")
        before = snapshot()
        holder = session(
            "failed_run",
            f"SELECT 1 FROM public.automation_workflow_runs WHERE id={quote(y['failed_run'])} FOR UPDATE;",
            hold=True,
        )
        ready(holder)
        busy(scan_command(x))
        require(
            snapshot() == before,
            "Later failed-run contention left earlier financial repair",
        )
        release(holder, rollback=True)
        holder = session("financial_union", scan_command(x), hold=True)
        ready(holder)
        busy(f"SELECT timed_proof.timed_payment({quote(x)},'failed');")
        release(holder, rollback=True)
        require(
            snapshot() == before,
            "Multi-invoice rollback left cancellation generation or event",
        )
        passed(
            "multi invoice preowned union blocks late capture and atomically rolls back repair"
        )
        unlinked = sql(f"SELECT timed_proof.timed_payment({quote(x)},'failed',false);")
        pending = sql(f"SELECT timed_proof.timed_payment({quote(x)},'pending',false);")
        holder = session("nullable_association", scan_command(x), hold=True)
        ready(holder)
        for payment in (unlinked, pending):
            busy(
                f"UPDATE public.billing_payments SET invoice_id={quote(x['source'])},stripe_invoice_id='in_'||{quote(x['source'])},status='failed' WHERE id={quote(payment)}; SELECT '{{}}'::jsonb;"
            )
        release(holder, rollback=True)
        sql(
            f"UPDATE public.billing_payments SET invoice_id={quote(x['source'])},stripe_invoice_id='in_'||{quote(x['source'])} WHERE id={quote(unlinked)};"
        )
        require(
            value(
                f"SELECT context FROM private.automation_workflow_events WHERE event_type='invoice.payment_failed' AND subject_id={quote(unlinked)};"
            )["invoice_id"]
            is None,
            "Nullable original failure context was rewritten",
        )
        got = scan(x)
        require(
            got["enqueued"] == 2
            and sql(
                f"SELECT bool_and(cancel_reason='payment_settled') FROM public.automation_workflow_runs WHERE id IN ({quote(x['failed_run'])},{quote(y['failed_run'])});"
            )
            == "t",
            "Complete financial union did not repair/cancel/enroll both",
        )
        passed(
            "new payment and nullable invoice association cannot grow cancellation targets behind settlement gate",
            enqueued=got["enqueued"],
        )
        # Invoke the actual retained blocking owner with reversed workflow ownership.
        x = value("SELECT timed_proof.timed_repair_fixture();")
        y = value("SELECT timed_proof.timed_repair_fixture();")
        for z in (x, y):
            sql(
                f"SELECT private.workflow_observe_payment_settlement_v1({quote(z['studio'])},{quote(z['success'])});"
            )
        holder = session(
            "retained_blocking",
            f"SELECT 1 FROM public.automation_workflows WHERE id={quote(x['failed_workflow'])} FOR UPDATE;",
            hold=True,
        )
        ready(holder)
        writer = session(
            "retained_other",
            f"SELECT 1 FROM public.automation_workflows WHERE id={quote(y['failed_workflow'])} FOR UPDATE; "
            f"SELECT private.workflow_cancel_settled_invoice_runs_v1({quote(x['studio'])},ARRAY[{quote(x['source'])}::uuid]);",
        )
        blocked(holder, writer)
        release(holder, rollback=True)
        finished(writer)
        passed(
            "actual retained cancellation owner blocks after reversed invoice workflow ownership"
        )
        x = fixture(start="clock_timestamp()+INTERVAL '62 seconds'", offset=-1)
        isolate(x)
        delay = float(
            sql(
                f"SELECT greatest(0,extract(epoch FROM timed_proof.timed_at({quote(x)})-clock_timestamp()));"
            )
        )
        time.sleep(delay + 0.03)
        rpc(f"SELECT timed_proof.timed_command({quote(x)},'publish');")
        got = value("SELECT public.process_automation_workflow_occurrences_v1();")
        require(
            got["payload"]["enqueued_run_count"] == 1
            and sql(
                f"SELECT version_id FROM public.automation_workflow_runs WHERE workflow_id={quote(x['workflow'])};"
            )
            == x["version"],
            "Late old interval catchup used latest version",
        )
        passed("actual publish after crossing retains old uncancelled version interval")
        x = fixture(start="clock_timestamp()+INTERVAL '62 seconds'", offset=-1)
        isolate(x)
        rpc(f"SELECT timed_proof.timed_command({quote(x)},'pause');")
        delay = float(
            sql(
                f"SELECT greatest(0,extract(epoch FROM timed_proof.timed_at({quote(x)})-clock_timestamp()));"
            )
        )
        time.sleep(delay + 0.03)
        rpc(f"SELECT timed_proof.timed_command({quote(x)},'start');")
        require(
            value("SELECT public.process_automation_workflow_occurrences_v1();")[
                "payload"
            ]["enqueued_run_count"]
            == 0,
            "Resume backfilled paused crossing",
        )
        passed("actual paused crossing remains excluded after resume")
        # Only this new owner receives a test delay after its final lock. Its
        # exact definition is restored before inventory and logical restore.
        x = fixture(start="clock_timestamp()+INTERVAL '61 seconds'", offset=-1)
        isolate(x)
        original = sql(
            "SELECT pg_get_functiondef('private.workflow_lock_timed_sources_v1(jsonb)'::regprocedure);"
        )
        needle = "    RETURN jsonb_build_object('owned_pairs',owned_pairs);"
        require(original.count(needle) == 1, "Ambiguous post-lock injection")
        try:
            sql(original.replace(needle, "    PERFORM pg_sleep(61);\n" + needle))
            delay = float(
                sql(
                    f"SELECT greatest(0,extract(epoch FROM timed_proof.timed_at({quote(x)})-clock_timestamp()));"
                )
            )
            time.sleep(delay + 0.03)
            got = value("SELECT public.process_automation_workflow_occurrences_v1();")[
                "payload"
            ]
            require(
                got["enqueued_run_count"] == 0
                and got["created_event_count"] == 0
                and sql(
                    f"SELECT last_source_id FROM private.workflow_timer_activations WHERE activation_id={quote(x['activation'])};"
                )
                == x["source"],
                "Post-lock clock expiry admitted upcoming event",
            )
        finally:
            sql(original)
        passed(
            "fresh public clock after final ownership refuses newly expired source",
            injected_seconds=61,
        )
        passed(
            "unique final component cases complete; assembled V57 upgrade and post-install restore is separate"
        )
        require(
            MIGRATION.read_bytes() == frozen
            and CONTRACT.read_text() == contract
            and Path(__file__).read_bytes() == runner_bytes,
            "Owned source/proof changed during run",
        )
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
                    "limits": "Local timed enrollment only; no send, hosted or V57 readiness claim.",
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
        if lifetimes:
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
