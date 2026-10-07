#!/usr/bin/env python3
"""Legacy sender adoption proof on one owned disposable PostgreSQL 17 clone."""

import hashlib
import json
import os
import queue
import re
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from importlib.metadata import version
from pathlib import Path
from uuid import uuid4

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from local_postgres_verification import LocalPostgres, require

ROOT = Path(__file__).resolve().parents[1]
BASE = "220152c534f27653ee43ae9819570a95cc6daa76"
MIGRATION = (
    ROOT / "supabase/migrations/20261005105341_automation_workflow_graph_v57.sql"
)
PREFIX_HASH = "aead68d014870e2bcf29fa3385f894eb8e947ca55e29d889d966279ff6bce67d"
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


def main(args):
    require(
        len(args) == 5, "Expected psql socket port unique-owned-clone new-evidence-file"
    )
    psql, socket, port, database, output = args
    require(
        re.fullmatch(r"koaryu_legacy_cutover_[a-z0-9_]+", database),
        "Unsafe owned clone name",
    )
    evidence = Path(output)
    require(
        evidence.is_absolute() and not os.path.lexists(evidence),
        "Evidence must be a new absolute path",
    )
    local = LocalPostgres(psql, socket, port, str(Path(socket).parent))
    require(
        local.sql(
            "postgres",
            f"SELECT NOT EXISTS(SELECT 1 FROM pg_database WHERE datname={quote(database)});",
        )
        == "t",
        "Foreign clone refused",
    )
    baseline = json.loads(
        local.sql(
            "postgres",
            "SELECT row_to_json(p) FROM public.koaryu_release_schema_preflight_v37() p;",
        )
    )
    require(
        baseline["ready"]
        and baseline["migration_count"] == 151
        and baseline["migration_head"] == "20261004220435",
        "Strict V56 template required",
    )
    require(
        local.run(["git", "-C", str(ROOT), "rev-parse", "--is-shallow-repository"])
        == "false",
        "Full history required",
    )
    local.run(["git", "-C", str(ROOT), "merge-base", "--is-ancestor", BASE, "HEAD"])
    prefix = subprocess.check_output(
        ["git", "-C", str(ROOT), "show", BASE + ":" + str(MIGRATION.relative_to(ROOT))],
        env=local.env,
    )
    source = MIGRATION.read_bytes()
    require(
        hashlib.sha256(prefix).hexdigest() == PREFIX_HASH and source.startswith(prefix),
        "Accepted prefix changed",
    )
    historical = {
        str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest()
        for p in sorted(MIGRATION.parent.glob("*.sql"))
        if p != MIGRATION
    }
    require(len(historical) == 151, "151 historical files required")
    for path, checksum in historical.items():
        frozen = subprocess.check_output(
            ["git", "-C", str(ROOT), "show", BASE + ":" + path], env=local.env
        )
        require(
            hashlib.sha256(frozen).hexdigest() == checksum,
            "Historical bytes changed: " + path,
        )
    report = {
        "source_sha256": hashlib.sha256(source).hexdigest(),
        "runner_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "baseline": BASE,
        "historical": historical,
        "cases": [],
        "lifetimes": [],
    }
    report["files"] = {
        str(path.relative_to(ROOT)): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in (
            MIGRATION,
            Path(__file__),
            ROOT / "supabase/verification/automation_legacy_cutover_contract.sql",
            ROOT / "supabase/verification/missed_class_automation_contract.sql",
            ROOT / "scripts/verify-automation-concurrency.py",
        )
    }
    report["historical_manifest_sha256"] = hashlib.sha256(
        "".join(
            checksum + "  " + path + "\n" for path, checksum in historical.items()
        ).encode()
    ).hexdigest()
    report["dependencies"] = {}
    for path in (
        "backend/app/schemas/workflow_dispatch.py",
        "backend/app/services/automation_service.py",
        "backend/app/services/automation_sender_status.py",
    ):
        accepted = subprocess.check_output(
            ["git", "-C", str(ROOT), "show", BASE + ":" + path], env=local.env
        )
        require(
            (ROOT / path).read_bytes() == accepted, "Accepted consumer changed: " + path
        )
        report["dependencies"][path] = hashlib.sha256(accepted).hexdigest()
    report["postmaster_pid"] = (
        (Path(socket).parent / "data/postmaster.pid").read_text().splitlines()[0]
    )
    owned = False
    children = []
    dump_owned = False
    dump = None
    dump_identity = None

    def sql(statement, role=False):
        return local.sql(
            database,
            "SET TIME ZONE 'UTC';\n"
            + ("SET ROLE service_role;\n" if role else "")
            + statement,
        )

    def val(statement, role=False):
        return json.loads(sql(statement, role))

    def call(name, *values):
        return val("SELECT " + name + "(" + ",".join(map(quote, values)) + ");", True)

    def passed(name, **facts):
        report["cases"].append({"case": name, **facts})
        print("[legacy cutover] PASS " + name, flush=True)

    def fixture(staff=True):
        f = {key: str(uuid4()) for key in ("actor", "studio", "student", "session")}
        f["email"] = f["student"] + "@example.invalid"
        staff_sql = (
            f"INSERT INTO public.staff_roles(studio_id,user_id,role) VALUES({quote(f['studio'])},{quote(f['actor'])},'admin');"
            if staff
            else ""
        )
        rule_sql = (
            f"SELECT public.save_missed_class_automation_rule_v1({quote(f['studio'])},{quote(f['actor'])},0,true,14,'Subject','Body','reply@example.invalid');"
            if staff
            else f"INSERT INTO public.automation_rules(studio_id,enabled,inactivity_days,subject_template,body_template,reply_to_email,revision) VALUES({quote(f['studio'])},true,14,'Subject','Body','reply@example.invalid',1);"
        )
        sql(f"""BEGIN;
INSERT INTO auth.users(id,email) VALUES({quote(f["actor"])},{quote(f["actor"] + "@example.invalid")});
INSERT INTO public.studios(id,name,slug,owner_id,timezone) VALUES({quote(f["studio"])},'Legacy proof',{quote(f["studio"])},{quote(f["actor"])},'UTC');
{staff_sql}
INSERT INTO public.studio_subscriptions(studio_id,status,comped) VALUES({quote(f["studio"])},'active',false);
INSERT INTO public.students(id,studio_id,legal_first_name,legal_last_name,email) VALUES({quote(f["student"])},{quote(f["studio"])},'Synthetic','Student',{quote(f["email"])});
INSERT INTO public.class_sessions(id,studio_id,name,date,start_time,end_time) VALUES({quote(f["session"])},{quote(f["studio"])},'Synthetic class',current_date-20,'00:00','01:00');
INSERT INTO public.attendance(studio_id,session_id,student_id,checked_in_at) VALUES({quote(f["studio"])},{quote(f["session"])},{quote(f["student"])},now()-INTERVAL '20 days');
{rule_sql}
COMMIT;""")
        enqueue = val(
            f"SELECT public.enqueue_missed_class_automations_v1(1,ARRAY[{quote(f['email'])}]);",
            True,
        )
        require(enqueue["enqueued"] == 1, "Fixture did not enqueue")
        c = val(
            f"SELECT public.claim_missed_class_automations_v1(1,ARRAY[{quote(f['email'])}]);",
            True,
        )["items"][0]
        f.update(delivery=c["id"], token=c["claim_token"])
        return f

    def session(label, statement, hold=False, role="service_role"):
        name = f"legacy_{os.getpid()}_{label}_{len(children)}"[:63]
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
            f"SET application_name='{name}'; BEGIN; SET LOCAL statement_timeout='90s'; SET LOCAL ROLE {role};\n{statement}\n"
        )
        if hold:
            process.stdin.write("SELECT 'READY';\n")
            process.stdin.flush()
        else:
            process.stdin.write("COMMIT;\n")
            process.stdin.close()
        return item

    def ready(item):
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            try:
                if item["events"].get(timeout=0.05) == "READY":
                    return
            except queue.Empty:
                require(
                    item["process"].poll() is None,
                    "Holder failed: " + str(item["errors"]),
                )
        raise RuntimeError("Holder did not reach barrier")

    def finish(item, commit=None, error=None):
        if commit is not None:
            item["process"].stdin.write("COMMIT;\n" if commit else "ROLLBACK;\n")
            item["process"].stdin.close()
        code = item["process"].wait(timeout=95)
        for thread in item["threads"]:
            thread.join(timeout=2)
        errors = "\n".join(item["errors"])
        require("deadlock detected" not in errors, "Deadlock: " + errors)
        if error:
            require(code != 0 and error in errors, "Expected " + error + ": " + errors)
            return None
        require(code == 0, "Session failed: " + errors)
        rows = [json.loads(line) for line in item["lines"] if line.startswith("{")]
        return rows[-1] if rows else None

    def blocked(owner, waiter):
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            require(
                waiter["process"].poll() is None,
                "Waiter exited: " + str(waiter["errors"]),
            )
            paths = val(
                "WITH RECURSIVE waits(pid,path) AS ("
                f"SELECT pid,ARRAY[pid] FROM pg_stat_activity WHERE application_name={quote(waiter['name'])} "
                "UNION ALL SELECT blocker,w.path||blocker FROM waits w CROSS JOIN LATERAL unnest(pg_blocking_pids(w.pid)) blocker WHERE NOT blocker=ANY(w.path)) "
                "SELECT coalesce(jsonb_agg(jsonb_build_object('path',w.path,'sessions',(SELECT jsonb_agg(jsonb_build_object('pid',a.pid,'application',a.application_name,'wait',a.wait_event,'type',a.wait_event_type)) FROM pg_stat_activity a WHERE a.pid=ANY(w.path)))),'[]') FROM waits w "
                f"WHERE w.pid=(SELECT pid FROM pg_stat_activity WHERE application_name={quote(owner['name'])});"
            )
            if paths:
                owned_names = {child["name"] for child in children}
                require(
                    all(
                        node["application"] in owned_names
                        for path in paths
                        for node in path["sessions"]
                    ),
                    "Unowned blocker in proof path",
                )
                report.setdefault("lock_observations", []).append(
                    {
                        "owner": owner["name"],
                        "waiter": waiter["name"],
                        "paths": paths,
                        "at": time.time(),
                    }
                )
                return
            time.sleep(0.03)
        raise RuntimeError("No observed lock wait")

    def recovery(studio):
        text = (
            ROOT / "supabase/verification/automation_legacy_cutover_contract.sql"
        ).read_text()
        text = (
            "BEGIN;"
            + text[text.index("CREATE FUNCTION pg_temp.assert_legacy") :].split(
                "DO $catalog$", 1
            )[0]
        )
        sql(text + f"SELECT pg_temp.recover_legacy_sender({quote(studio)}); COMMIT;")

    def prepare():
        if (
            sql(
                "SELECT EXISTS(SELECT 1 FROM private.automation_email_credentials WHERE provider_key='microsoft_graph:primary');"
            )
            == "f"
        ):
            call(
                "public.save_automation_email_credential_v1",
                "microsoft_graph:primary",
                0,
                "synthetic-local-only",
            )
        revision = val(
            "SELECT revision FROM private.automation_email_credentials WHERE provider_key='microsoft_graph:primary';"
        )
        prep = call(
            "public.claim_automation_sender_preparation_v1",
            "microsoft_graph:primary",
            str(uuid4()),
            "a" * 64,
        )["payload"]
        require(prep["allowed"], "Preparation denied")
        result = call(
            "public.settle_automation_sender_preparation_v1",
            prep["preparation_id"],
            prep["preparation_token"],
            {
                "outcome": "prepared",
                "credential_revision": revision,
                "sender_binding": "a" * 64,
                "safe_reason": None,
                "retry_after_seconds": None,
            },
        )["payload"]
        require(result["outcome"] == "prepared", "Preparation not prepared")
        return prep, revision

    def delivery_result(revision, outcome="accepted", scope=None, evidence="accepted"):
        return {
            "outcome": outcome,
            "error_code": None if outcome == "accepted" else "provider_rejected",
            "provider_request_id": "synthetic-id",
            "retry_after_seconds": None,
            "submission_evidence": evidence,
            "failure_scope": scope,
            "credential_revision": revision,
        }

    def begin_v2(f):
        prep, revision = prepare()
        result = call(
            "public.begin_missed_class_automation_v2",
            f["delivery"],
            f["token"],
            prep["preparation_id"],
            prep["preparation_token"],
            None,
            prep["probe_token"],
        )["payload"]
        require(result["ready"], "V2 did not begin")
        f.update(
            attempt=result["attempt_id"],
            revision=revision,
            lease=result["lease_expires_at"],
            optout=result["message"]["unsubscribe_token"],
        )
        return result

    def frozen(name):
        text = (
            ROOT / "supabase/migrations/20261004220435_missed_class_automation_v56.sql"
        ).read_text()
        start = text.index("CREATE FUNCTION public." + name + "(")
        return text[start : text.index("END $$;", start) + 7]

    def load_frozen(name, statement, current, label):
        # Entry-only barrier instrumentation lets the exact retained executable
        # statements be loaded before replacement without a delivery relation
        # lock preventing the required ACCESS EXCLUSIVE installation snapshot.
        old = frozen(name)
        barrier = 73008001 + len(children)
        definition = old.replace(
            "CREATE FUNCTION", "CREATE OR REPLACE FUNCTION", 1
        ).replace(
            "BEGIN\n", f"BEGIN\n    PERFORM pg_advisory_xact_lock({barrier});\n", 1
        )
        sql(definition)
        owner = session(
            label + "_barrier", f"SELECT pg_advisory_xact_lock({barrier});", True
        )
        ready(owner)
        waiter = session(label, statement)
        blocked(owner, waiter)
        sql(current)
        finish(owner, True)
        return waiter

    try:
        local.sql("postgres", f"CREATE DATABASE {database} TEMPLATE postgres;")
        owned = True
        report["lifetimes"].append({"action": "create", "at": time.time()})
        historical_fixtures = []
        historical_updates = []
        for kind, state, attempted, settled, updated, lease, count in (
            (
                "recent_retry",
                "accepted",
                "now()-INTERVAL '20 days'",
                "now()-INTERVAL '1 minute'",
                "now()",
                "NULL",
                3,
            ),
            (
                "aged_accepted",
                "accepted",
                "now()-INTERVAL '20 days'",
                "now()-INTERVAL '19 days'",
                "now()",
                "NULL",
                1,
            ),
            (
                "aged_unknown",
                "unknown",
                "now()-INTERVAL '3 days'",
                "now()-INTERVAL '2 days'",
                "now()",
                "NULL",
                1,
            ),
            (
                "missing",
                "accepted",
                "now()-INTERVAL '2 days'",
                "NULL",
                "now()",
                "NULL",
                1,
            ),
            (
                "infinite",
                "accepted",
                "'-infinity'::TIMESTAMPTZ",
                "'infinity'::TIMESTAMPTZ",
                "now()",
                "NULL",
                1,
            ),
            (
                "reversed",
                "accepted",
                "now()-INTERVAL '1 day'",
                "now()-INTERVAL '2 days'",
                "now()",
                "NULL",
                1,
            ),
            (
                "future",
                "unknown",
                "now()-INTERVAL '1 day'",
                "now()+INTERVAL '1 day'",
                "now()",
                "NULL",
                1,
            ),
            (
                "range",
                "accepted",
                "'10000-01-01'::TIMESTAMPTZ",
                "'10000-01-02'::TIMESTAMPTZ",
                "now()",
                "NULL",
                1,
            ),
            (
                "sending_live",
                "sending",
                "now()-INTERVAL '1 day'",
                "NULL",
                "now()-INTERVAL '2 seconds'",
                "now()+INTERVAL '50 seconds'",
                2,
            ),
            (
                "sending_expired",
                "sending",
                "now()-INTERVAL '1 day'",
                "NULL",
                "now()-INTERVAL '2 minutes'",
                "now()-INTERVAL '1 minute'",
                2,
            ),
            (
                "sending_missing_lease",
                "sending",
                "now()-INTERVAL '1 day'",
                "NULL",
                "now()",
                "NULL",
                1,
            ),
            (
                "safe_retry",
                "retry_wait",
                "now()-INTERVAL '1 day'",
                "now()-INTERVAL '1 hour'",
                "now()",
                "NULL",
                2,
            ),
        ):
            f = fixture()
            f.update(kind=kind, state=state)
            historical_updates.append(
                f"UPDATE public.automation_deliveries SET state={quote(state)},attempts={count},attempted_at={attempted},settled_at={settled},updated_at={updated},lease_expires_at={lease},unsubscribe_token=repeat('a',32)||replace(id::TEXT,'-',''),original_recipient_email=recipient_email WHERE id={quote(f['delivery'])};"
            )
            historical_fixtures.append(f)
        crossing = fixture()
        sql("BEGIN;" + "".join(historical_updates) + "COMMIT;")
        retained = val(
            "SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM public.automation_deliveries d WHERE id<>"
            + quote(crossing["delivery"])
            + ";"
        )
        sql("BEGIN;\n" + prefix.decode() + "\nCOMMIT;")
        before = val(INVENTORY)
        frozen_begin = frozen("begin_missed_class_automation_v1")
        barrier = 73008000
        sql(
            frozen_begin.replace(
                "CREATE FUNCTION", "CREATE OR REPLACE FUNCTION", 1
            ).replace(
                "BEGIN\n", f"BEGIN\n    PERFORM pg_advisory_xact_lock({barrier});\n", 1
            )
        )
        holder = session(
            "install_entry_barrier", f"SELECT pg_advisory_xact_lock({barrier});", True
        )
        ready(holder)
        old = session(
            "loaded_v56_begin",
            f"SELECT public.begin_missed_class_automation_v1({quote(crossing['delivery'])},{quote(crossing['token'])});",
        )
        blocked(holder, old)
        sql("BEGIN;\n" + source[len(prefix) :].decode() + "\nCOMMIT;")
        finish(holder, True)
        require(finish(old)["ready"], "Loaded V56 begin failed after install")
        call(
            "public.settle_missed_class_automation_v1",
            crossing["delivery"],
            crossing["token"],
            "accepted",
        )
        passed(
            "loaded frozen V56 begin crosses full legacy installation",
            body_sha256=hashlib.sha256(frozen_begin.encode()).hexdigest(),
            barrier="entry-only advisory instrumentation",
        )
        now_retained = val(
            "SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM public.automation_deliveries d WHERE id<>"
            + quote(crossing["delivery"])
            + ";"
        )
        require(now_retained == retained, "Installation changed retained delivery rows")
        anchors = []
        for f in historical_fixtures:
            a = val(
                f"SELECT coalesce(jsonb_agg(to_jsonb(a)),'[]') FROM private.automation_email_attempt_reservations a WHERE scope_id={quote(f['delivery'])};"
            )
            require(
                len(a) == (0 if f["kind"] == "safe_retry" else 1),
                "Historical reservation cardinality",
            )
            if a:
                a = a[0]
                expected = (
                    "legacy_settlement_upper_bound"
                    if f["kind"] in ("recent_retry", "aged_accepted", "aged_unknown")
                    else "legacy_sending_upper_bound"
                    if f["kind"] in ("sending_live", "sending_expired")
                    else "cutover_fallback"
                )
                require(
                    a["origin"] == expected
                    and a["protocol"] == "historical"
                    and a["actual_began_at"] is None
                    and a["attempt_number"] is None,
                    "Historical origin truth",
                )
                anchors.append(
                    {
                        "kind": f["kind"],
                        "origin": a["origin"],
                        "anchor": a["conservative_anchor_at"],
                    }
                )
        passed(
            "real V56 retained history seed preserves rows and conservative anchors",
            anchors=anchors,
        )
        for kind in ("sending_live", "sending_expired"):
            retained_fixture = next(
                item for item in historical_fixtures if item["kind"] == kind
            )
            old_truth = val(
                f"SELECT to_jsonb(a) FROM private.automation_email_attempt_reservations a WHERE scope_id={quote(retained_fixture['delivery'])};"
            )
            answer = call(
                "public.settle_missed_class_automation_v1",
                retained_fixture["delivery"],
                retained_fixture["token"],
                "accepted",
            )
            require(
                answer
                == {
                    "updated": True,
                    "state": "accepted" if kind == "sending_live" else "unknown",
                },
                "Historical original lease adapter",
            )
            new_truth = val(
                f"SELECT to_jsonb(a) FROM private.automation_email_attempt_reservations a WHERE scope_id={quote(retained_fixture['delivery'])};"
            )
            require(
                new_truth["origin"] == old_truth["origin"]
                and new_truth["conservative_anchor_at"]
                == old_truth["conservative_anchor_at"]
                and new_truth["actual_began_at"] is None,
                "Historical settlement reanchored or fabricated begin",
            )
        passed(
            "historical original live and expired lease settlement preserves original anchor"
        )
        for f in historical_fixtures + [crossing]:
            sql(
                f"DELETE FROM public.students WHERE studio_id={quote(f['studio'])}; UPDATE public.automation_rules SET enabled=false WHERE studio_id={quote(f['studio'])};"
            )
        after = val(INVENTORY)
        changed = [name for name in before if before[name] != after.get(name)]
        require(
            set(changed)
            == {
                "begin_missed_class_automation_v1(uuid,uuid,text[])",
                "settle_missed_class_automation_v1(uuid,uuid,text,text,text,integer)",
                "suppress_missed_class_automation_v1(text)",
                "claim_missed_class_automations_v1(integer,text[])",
            },
            "Unexpected owner delta: " + str(changed),
        )
        for name in changed:
            require(
                {
                    key: value
                    for key, value in before[name].items()
                    if key != "definition"
                }
                == {
                    key: value
                    for key, value in after[name].items()
                    if key != "definition"
                },
                "Retained owner security/config drift: " + name,
            )
        report["before_inventory"] = before
        report["after_inventory"] = after
        passed("installation preserves every unnamed accepted owner", changed=changed)
        f = fixture()
        begun = call(
            "public.begin_missed_class_automation_v1", f["delivery"], f["token"]
        )
        require(
            begun["ready"] and set(begun) == {"ready", "state", "reason", "message"},
            "V1 begin shape/grant",
        )
        a = val(
            f"SELECT to_jsonb(a) FROM private.automation_email_attempt_reservations a WHERE scope_id={quote(f['delivery'])};"
        )
        require(
            a["origin"] == "actual"
            and a["attempt_number"] == 1
            and a["owner_token"] == f["token"],
            "Real common attempt missing",
        )
        require(
            not call(
                "public.begin_missed_class_automation_v1", f["delivery"], f["token"]
            )["ready"],
            "Repeated send grant",
        )
        settled = call(
            "public.settle_missed_class_automation_v1",
            f["delivery"],
            f["token"],
            "accepted",
        )
        require(
            settled == {"updated": True, "state": "accepted"}, "V1 settlement shape"
        )
        require(
            call(
                "public.settle_missed_class_automation_v1",
                f["delivery"],
                f["token"],
                "accepted",
            )
            == {"updated": False, "state": "accepted"},
            "V1 retained terminal behavior",
        )
        sql(f"DELETE FROM public.students WHERE id={quote(f['student'])};")
        require(
            call(
                "public.suppress_missed_class_automation_v1",
                begun["message"]["unsubscribe_token"],
            )
            == {"success": True},
            "Opaque suppression response",
        )
        require(
            sql(
                f"SELECT EXISTS(SELECT 1 FROM public.automation_suppressions WHERE studio_id={quote(f['studio'])} AND recipient_email={quote(f['email'])});"
            )
            == "t",
            "Token lost in student cascade",
        )
        require(
            call(
                "public.settle_missed_class_automation_v1",
                f["delivery"],
                f["token"],
                "accepted",
            )
            == {"updated": False, "state": "accepted"},
            "V1 deleted replay must not report fresh update",
        )
        passed("actual v1 begin and settlement plus token survival")

        # The SDK consumes real SQL replies; MockTransport makes network access
        # impossible and the audit hook rejects dotenv reads during imports.
        def no_dotenv(event, args):
            if event == "open" and isinstance(args[0], (str, bytes)):
                require(
                    not Path(str(args[0])).name.startswith(".env"),
                    "Dotenv read forbidden",
                )

        sys.addaudithook(no_dotenv)
        sys.path.insert(0, str(ROOT / "backend"))
        import httpx
        from app.schemas import workflow_dispatch as dto
        from postgrest import SyncPostgrestClient
        from postgrest.utils import SyncClient
        from pydantic import ValidationError

        require(version("postgrest") == "0.17.2", "Pinned SDK required")

        class SQLClient(SyncPostgrestClient):
            def create_session(
                self, base_url, headers, timeout, verify=True, proxy=None
            ):
                def handler(request):
                    name = request.url.path.rsplit("/", 1)[-1]
                    require(
                        name
                        in (
                            "begin_missed_class_automation_v2",
                            "settle_missed_class_automation_v2",
                        ),
                        "Unexpected RPC",
                    )
                    params = json.loads(request.content)
                    model = (
                        dto.LegacyBeginRequest
                        if name.startswith("begin")
                        else dto.LegacySettleRequest
                    )
                    parsed = model.model_validate(params).model_dump(mode="json")
                    statement = (
                        "SELECT public."
                        + name
                        + "("
                        + ",".join(
                            key
                            + "=>"
                            + (
                                "ARRAY[" + ",".join(map(quote, value)) + "]::TEXT[]"
                                if isinstance(value, list)
                                else quote(value)
                            )
                            for key, value in parsed.items()
                        )
                        + ");"
                    )
                    return httpx.Response(200, json=val(statement, True))

                return SyncClient(
                    base_url=base_url,
                    headers=headers,
                    timeout=timeout,
                    follow_redirects=False,
                    trust_env=False,
                    transport=httpx.MockTransport(handler),
                )

        with SQLClient("http://legacy-proof.invalid") as client:
            sdk = []
            f = fixture()
            prep, revision = prepare()
            params = {
                "p_delivery_id": f["delivery"],
                "p_claim_token": f["token"],
                "p_preparation_id": prep["preparation_id"],
                "p_preparation_token": prep["preparation_token"],
                "p_allowed_recipients": [f["email"]],
                "p_probe_token": prep["probe_token"],
            }
            for index in range(2):
                raw = (
                    client.rpc("begin_missed_class_automation_v2", params)
                    .execute()
                    .data
                )
                parsed = dto.Envelope[dto.LegacyBegun].model_validate(raw).payload
                require(parsed.ready is (index == 0), "SDK repeated grant")
                if index == 0:
                    attempt = str(parsed.attempt_id)
                sdk.append(raw)
            settle_params = {
                "p_delivery_id": f["delivery"],
                "p_claim_token": f["token"],
                "p_attempt_id": attempt,
                "p_result": delivery_result(revision),
            }
            for index in range(3):
                if index == 2:
                    settle_params["p_claim_token"] = str(uuid4())
                raw = (
                    client.rpc("settle_missed_class_automation_v2", settle_params)
                    .execute()
                    .data
                )
                parsed = dto.Envelope[dto.LegacySettled].model_validate(raw).payload
                require(
                    parsed.updated is (index < 2) and parsed.replayed is (index == 1),
                    "SDK settlement branch",
                )
                sdk.append(raw)
            malformed = 0
            for raw in sdk:
                model = (
                    dto.LegacyBegun if "ready" in raw["payload"] else dto.LegacySettled
                )
                for key in raw["payload"]:
                    broken = {"payload": dict(raw["payload"])}
                    broken["payload"].pop(key)
                    try:
                        dto.Envelope[model].model_validate(broken)
                    except ValidationError:
                        malformed += 1
                    else:
                        raise RuntimeError("DTO accepted missing required key")
                broken = {"payload": dict(raw["payload"], extra=True)}
                try:
                    dto.Envelope[model].model_validate(broken)
                except ValidationError:
                    malformed += 1
                else:
                    raise RuntimeError("DTO accepted extra key")
            passed(
                "installed SDK and accepted DTOs parse all grant/refusal/replay envelopes",
                responses=len(sdk),
                rejected_malformed=malformed,
            )

        current_begin = after["begin_missed_class_automation_v1(uuid,uuid,text[])"][
            "definition"
        ]
        current_settle = after[
            "settle_missed_class_automation_v1(uuid,uuid,text,text,text,integer)"
        ]["definition"]
        for mode in (
            "bound_ready",
            "cooldown",
            "auth_blocked",
            "missing",
            "frequency",
            "clear",
            "scope",
        ):
            f = fixture()
            recovery(f["studio"])
            lock = None
            saved_gate = None
            if mode in ("cooldown", "auth_blocked"):
                sql(
                    "SELECT private.automation_sender_failure_v1("
                    + quote(
                        "sender_auth" if mode == "auth_blocked" else "sender_transient"
                    )
                    + ",'provider_unavailable',NULL,NULL,clock_timestamp());"
                )
            elif mode == "missing":
                saved_gate = val(
                    "SELECT to_jsonb(g) FROM private.automation_sender_gate g;"
                )
                sql("DELETE FROM private.automation_sender_gate;")
            elif mode == "frequency":
                sql(
                    f"INSERT INTO private.automation_email_attempt_reservations(id,studio_id,provider_key,scope_kind,scope_id,recipient_email,origin,protocol,state,frequency_state,conservative_anchor_at,observed_legacy_ordinal,legacy_projection) VALUES(gen_random_uuid(),{quote(f['studio'])},'microsoft_graph:primary','legacy',gen_random_uuid(),{quote(f['email'])},'cutover_fallback','historical','accepted','accepted',clock_timestamp(),1,'{{\"state\":\"accepted\",\"reason\":null}}');"
                )
            elif mode in ("clear", "scope"):
                key = (
                    "'koaryu.local-plan-clear:'||" + quote(f["studio"])
                    if mode == "clear"
                    else "'koaryu.automation-email-scope:'||jsonb_build_array("
                    + quote(f["studio"])
                    + "::TEXT,'legacy',"
                    + quote(f["delivery"])
                    + "::TEXT,NULL)::TEXT"
                )
                lock = session(
                    "old_begin_" + mode,
                    "SELECT pg_advisory_xact_lock(hashtextextended(" + key + ",0));",
                    True,
                )
                ready(lock)
            waiter = load_frozen(
                "begin_missed_class_automation_v1",
                f"SELECT public.begin_missed_class_automation_v1({quote(f['delivery'])},{quote(f['token'])});",
                current_begin,
                "frozen_" + mode,
            )
            if mode == "bound_ready":
                require(finish(waiter)["ready"], "Bound ready frozen begin")
                call(
                    "public.settle_missed_class_automation_v1",
                    f["delivery"],
                    f["token"],
                    "accepted",
                )
            else:
                finish(
                    waiter,
                    error="AUTOMATION_STUDIO_BUSY"
                    if mode in ("clear", "scope")
                    else "AUTOMATION_SENDER_UNAVAILABLE",
                )
                require(
                    sql(
                        f"SELECT state='claimed' AND attempts=0 FROM public.automation_deliveries WHERE id={quote(f['delivery'])};"
                    )
                    == "t",
                    "Frozen refusal did not roll back source",
                )
                require(
                    sql(
                        f"SELECT count(*)=0 FROM private.automation_email_attempt_reservations WHERE scope_id={quote(f['delivery'])};"
                    )
                    == "t",
                    "Frozen refusal left attempt",
                )
            if lock:
                finish(lock, False)
            if saved_gate:
                sql(
                    "INSERT INTO private.automation_sender_gate SELECT * FROM jsonb_populate_record(NULL::private.automation_sender_gate,"
                    + quote(saved_gate)
                    + ");"
                )
            recovery(f["studio"])
            passed("loaded frozen begin atomic " + mode)

        for delete_first in (False, True):
            for commit in (False, True):
                f = fixture()
                begin_v2(f)
                delete = f"DELETE FROM public.students WHERE id={quote(f['student'])};"
                settle = (
                    "SELECT public.settle_missed_class_automation_v2("
                    + ",".join(
                        map(
                            quote,
                            [
                                f["delivery"],
                                f["token"],
                                f["attempt"],
                                delivery_result(f["revision"]),
                            ],
                        )
                    )
                    + ");"
                )
                first = session(
                    "delete_settle_owner",
                    delete if delete_first else settle,
                    True,
                    "postgres",
                )
                ready(first)
                second = session(
                    "delete_settle_waiter",
                    settle if delete_first else delete,
                    False,
                    "postgres",
                )
                blocked(first, second)
                finish(first, commit)
                result = finish(second)
                if delete_first:
                    require(
                        result["payload"]["state"] == "accepted",
                        "Live callback after cascade refused",
                    )
                else:
                    # Rollback of a held settle leaves an actual sending row;
                    # deletion cannot pretend it was accepted or not submitted.
                    require(
                        sql(
                            f"SELECT state={quote('accepted' if commit else 'sending')} FROM private.automation_email_attempt_reservations WHERE id={quote(f['attempt'])};"
                        )
                        == "t",
                        "Delete changed actual truth",
                    )
                    if not commit:
                        require(
                            call(
                                "public.settle_missed_class_automation_v2",
                                f["delivery"],
                                f["token"],
                                f["attempt"],
                                delivery_result(f["revision"]),
                            )["payload"]["state"]
                            == "accepted",
                            "Deleted live original callback",
                        )
                require(
                    call("public.suppress_missed_class_automation_v1", f["optout"])
                    == {"success": True},
                    "Deleted original unsubscribe",
                )
                passed(
                    "delete and settlement ownership",
                    delete_first=delete_first,
                    commit=commit,
                )

        f = fixture()
        begin_v2(f)
        sql(
            f"SELECT public.clear_studio_operational_data_atomic({quote(f['studio'])},false);"
        )
        require(
            sql(
                f"SELECT NOT EXISTS(SELECT 1 FROM public.automation_deliveries WHERE id={quote(f['delivery'])});"
            )
            == "t",
            "Operational clear retained payload",
        )
        require(
            call(
                "public.settle_missed_class_automation_v2",
                f["delivery"],
                f["token"],
                f["attempt"],
                delivery_result(f["revision"]),
            )["payload"]["state"]
            == "accepted",
            "Original live callback after actual clear",
        )
        call("public.suppress_missed_class_automation_v1", f["optout"])
        require(
            sql(
                f"SELECT EXISTS(SELECT 1 FROM public.automation_suppressions WHERE studio_id={quote(f['studio'])} AND recipient_email={quote(f['email'])});"
            )
            == "t",
            "Actual clear lost original optout",
        )
        passed(
            "actual operational clear removes payload and preserves original live callback and optout"
        )
        for commit in (False, True):
            # No staff membership is needed for this synthetic studio-cascade
            # fixture; existing admin-removal policy is outside the mail proof.
            f = fixture(staff=False)
            begin_v2(f)
            holder = session(
                "studio_cascade",
                f"DELETE FROM public.studios WHERE id={quote(f['studio'])};",
                True,
                "postgres",
            )
            ready(holder)
            waiter = session(
                "studio_cascade_settle",
                "SELECT public.settle_missed_class_automation_v2("
                + ",".join(
                    map(
                        quote,
                        [
                            f["delivery"],
                            f["token"],
                            f["attempt"],
                            delivery_result(f["revision"]),
                        ],
                    )
                )
                + ");",
            )
            blocked(holder, waiter)
            finish(holder, commit)
            answer = finish(waiter)["payload"]
            require(
                answer["updated"] is (not commit), "Studio cascade settlement ownership"
            )
            require(
                sql(
                    f"SELECT count(*)={0 if commit else 1} FROM private.automation_email_attempt_reservations WHERE id={quote(f['attempt'])};"
                )
                == "t",
                "Studio-only common FK guard",
            )
            require(
                call("public.suppress_missed_class_automation_v1", f["optout"])
                == {"success": True},
                "Opaque studio-deleted token",
            )
            passed(
                "actual studio cascade respects common FK and callback ownership",
                commit=commit,
            )

        # First new actual ordinal derives the locked legacy count, even with no
        # fictional preceding common attempts. Message-specific safe failures
        # leave the shared provider available for the next real attempt.
        for prior in (1, 2):
            f = fixture()
            sql(
                f"UPDATE public.automation_deliveries SET attempts={prior},attempted_at=clock_timestamp()-INTERVAL '2 days',unsubscribe_token=repeat('b',32)||replace(id::TEXT,'-',''),original_recipient_email=recipient_email WHERE id={quote(f['delivery'])};"
            )
            begin_v2(f)
            require(
                sql(
                    f"SELECT attempt_number={prior + 1} FROM private.automation_email_attempt_reservations WHERE id={quote(f['attempt'])};"
                )
                == "t",
                "Legacy ordinal floor",
            )
            answer = call(
                "public.settle_missed_class_automation_v2",
                f["delivery"],
                f["token"],
                f["attempt"],
                delivery_result(
                    f["revision"], "retryable_failure", "message", "not_submitted"
                ),
            )["payload"]
            require(
                answer["state"] == ("retry_wait" if prior == 1 else "failed"),
                "Absolute three attempt budget",
            )
            passed("actual ordinal uses observed legacy count", prior=prior)

        # Arrange sources before starting the original actual60second clocks.
        cached, same_state, credential, orphan = [fixture() for _ in range(4)]
        pending_ids = ",".join(
            quote(item["delivery"]) for item in (cached, same_state, credential, orphan)
        )
        sql(
            f"UPDATE public.automation_deliveries SET lease_expires_at=clock_timestamp()+INTERVAL '60 seconds' WHERE id IN ({pending_ids}) AND state='claimed' AND attempts=0;"
        )
        for item in (cached, same_state):
            require(
                call(
                    "public.begin_missed_class_automation_v1",
                    item["delivery"],
                    item["token"],
                )["ready"],
                "Expiry fixture actual begin refused",
            )
        cached["lease"] = val(
            f"SELECT to_jsonb(lease_expires_at) FROM public.automation_deliveries WHERE id={quote(cached['delivery'])};"
        )
        begin_v2(credential)
        begin_v2(orphan)
        sql(f"DELETE FROM public.students WHERE id={quote(orphan['student'])};")
        report["original_expiry_leases"] = val(
            f"SELECT jsonb_agg(jsonb_build_object('id',id,'lease',lease_expires_at,'now',clock_timestamp(),'live',lease_expires_at>clock_timestamp())) FROM public.automation_deliveries WHERE id IN ({quote(cached['delivery'])},{quote(same_state['delivery'])});"
        )
        require(
            all(row["live"] for row in report["original_expiry_leases"]),
            "Original leases must be live before gate wait",
        )
        gate_holder = session(
            "cached_expiry_gate",
            "SELECT 1 FROM private.automation_sender_gate FOR UPDATE;",
            True,
        )
        ready(gate_holder)
        waiter = load_frozen(
            "settle_missed_class_automation_v1",
            f"SELECT public.settle_missed_class_automation_v1({quote(cached['delivery'])},{quote(cached['token'])},'accepted');",
            current_settle,
            "cached_settle_expiry",
        )
        blocked(gate_holder, waiter)
        unknown_waiter = load_frozen(
            "settle_missed_class_automation_v1",
            f"SELECT public.settle_missed_class_automation_v1({quote(same_state['delivery'])},{quote(same_state['token'])},'unknown');",
            current_settle,
            "cached_unknown_projection",
        )
        blocked(gate_holder, unknown_waiter)
        target = max(
            datetime.fromisoformat(cached["lease"]),
            datetime.fromisoformat(orphan["lease"]),
        )
        print("[legacy cutover] waiting for original actual send leases", flush=True)
        while datetime.now(timezone.utc) <= target:
            time.sleep(
                min(1, max(0.01, (target - datetime.now(timezone.utc)).total_seconds()))
            )
        finish(gate_holder, True)
        finish(waiter, error="AUTOMATION_SENDER_UNAVAILABLE")
        finish(unknown_waiter, error="AUTOMATION_SENDER_UNAVAILABLE")
        require(
            sql(
                f"SELECT state='sending' FROM public.automation_deliveries WHERE id={quote(cached['delivery'])};"
            )
            == "t",
            "Frozen local v_state escaped expiry rollback",
        )

        def ownership_snapshot():
            return val(
                "SELECT jsonb_build_object('parents',(SELECT coalesce(jsonb_agg(to_jsonb(d) ORDER BY id),'[]') FROM public.automation_deliveries d),"
                "'common',(SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY id),'[]') FROM private.automation_email_attempt_reservations a),"
                "'gate',(SELECT to_jsonb(g) FROM private.automation_sender_gate g));"
            )

        before_busy = ownership_snapshot()
        cred = session(
            "expiry_credential_owner",
            "SELECT 1 FROM private.automation_email_credentials WHERE provider_key='microsoft_graph:primary' FOR UPDATE;",
            True,
        )
        ready(cred)
        current_claim = after["claim_missed_class_automations_v1(integer,text[])"][
            "definition"
        ]
        old_claim = load_frozen(
            "claim_missed_class_automations_v1",
            "SELECT public.claim_missed_class_automations_v1(1);",
            current_claim,
            "cached_multirow_expiry",
        )
        finish(old_claim, error="AUTOMATION_STUDIO_BUSY")
        require(
            not any(line.startswith("{") for line in old_claim["lines"]),
            "Busy claim returned a grant",
        )
        require(
            ownership_snapshot() == before_busy,
            "Busy cached claim changed parent/common/projection/gate truth",
        )
        finish(cred, False)
        passed(
            "frozen multirow expiry credential NOWAIT refuses atomically with no grant",
            snapshot_sha256=hashlib.sha256(
                json.dumps(before_busy, sort_keys=True).encode()
            ).hexdigest(),
        )
        generation = val("SELECT generation FROM private.automation_sender_gate;")
        answer = call("public.claim_missed_class_automations_v1", 1)
        require(
            sql(
                f'SELECT state=\'unknown\' AND legacy_projection=\'{{"state":"unknown","reason":"lease_expired"}}\'::JSONB FROM private.automation_email_attempt_reservations WHERE id={quote(orphan["attempt"])};'
            )
            == "t",
            "Current claim did not expire deleted actual",
        )
        require(
            val("SELECT generation FROM private.automation_sender_gate;")
            == generation + 4,
            "Actual expiry provider effects must occur once each",
        )
        call("public.claim_missed_class_automations_v1", 1)
        require(
            val("SELECT generation FROM private.automation_sender_gate;")
            == generation + 4,
            "Repeated expiry changed generation",
        )
        passed(
            "loaded frozen settle rejects local accepted return after original expiry and current claim expires orphan once"
        )
        recovery(cached["studio"])

        f = fixture()
        template = val(
            f"SELECT to_jsonb(d) FROM public.automation_deliveries d WHERE id={quote(f['delivery'])};"
        )
        sql(
            f"DELETE FROM public.automation_deliveries WHERE id={quote(f['delivery'])};"
        )
        sql(
            """DO $$ DECLARE source public.automation_deliveries; d public.automation_deliveries; i INTEGER; student UUID;
BEGIN
source:=jsonb_populate_record(NULL::public.automation_deliveries,"""
            + quote(template)
            + """);
FOR i IN 1..101 LOOP
student:=gen_random_uuid();
INSERT INTO public.students(id,studio_id,legal_first_name,legal_last_name,email)
VALUES(student,source.studio_id,'Backlog','Fixture',student::TEXT||'@example.invalid');
d:=source; d.id:=gen_random_uuid(); d.student_id:=student; d.state:='sending'; d.attempts:=1;
d.attempted_at:=clock_timestamp()-INTERVAL '5 minutes'; d.updated_at:=clock_timestamp()-INTERVAL '4 minutes';
d.claim_token:=gen_random_uuid(); d.lease_expires_at:=date_trunc('second',clock_timestamp())-INTERVAL '3 minutes'+i*INTERVAL '1 millisecond';
d.recipient_email:=student::TEXT||'@example.invalid'; d.original_recipient_email:=d.recipient_email;
d.unsubscribe_token:=replace(d.id::TEXT,'-','')||replace(d.id::TEXT,'-','');
INSERT INTO public.automation_deliveries SELECT d.*;
INSERT INTO private.automation_email_attempt_reservations(id,studio_id,provider_key,scope_kind,scope_id,recipient_email,
origin,protocol,state,frequency_state,conservative_anchor_at,observed_legacy_ordinal,owner_token,lease_expires_at)
VALUES(gen_random_uuid(),d.studio_id,'microsoft_graph:primary','legacy',d.id,d.recipient_email,
'legacy_sending_upper_bound','historical','sending','sending',d.updated_at,1,d.claim_token,d.lease_expires_at);
PERFORM private.automation_bind_unsubscribe_token_v1(d.studio_id,d.unsubscribe_token,d.recipient_email);
IF i=101 THEN DELETE FROM public.students WHERE id=student; END IF;
END LOOP;
END $$;"""
        )
        rows = val(
            f"SELECT jsonb_agg(to_jsonb(a) ORDER BY lease_expires_at,id) FROM private.automation_email_attempt_reservations a WHERE studio_id={quote(f['studio'])};"
        )
        require(len(rows) == 101, "Backlog cardinality")
        require(
            call("private.automation_expire_orphaned_legacy_attempts_v1", 100) == 0,
            "Orphan filter ran before raw limit",
        )
        for commit in (False, True):
            before_busy = ownership_snapshot()
            recipient = session(
                "expiry_recipient_owner",
                "SELECT pg_advisory_xact_lock(hashtextextended("
                + quote(f["studio"] + ":" + rows[1]["recipient_email"])
                + ",0));",
                True,
            )
            ready(recipient)
            claim = session(
                "multirow_expiry", "SELECT public.claim_missed_class_automations_v1(1);"
            )
            finish(claim, error="AUTOMATION_STUDIO_BUSY")
            require(
                not any(line.startswith("{") for line in claim["lines"]),
                "Busy claim returned a grant",
            )
            require(
                ownership_snapshot() == before_busy,
                "Busy claim changed parent/common/projection/gate truth",
            )
            finish(recipient, commit)
            passed(
                "multirow expiry recipient TRY refuses whole claim atomically",
                other_commits=commit,
                snapshot_sha256=hashlib.sha256(
                    json.dumps(before_busy, sort_keys=True).encode()
                ).hexdigest(),
            )
        call("public.claim_missed_class_automations_v1", 1)
        require(
            sql(
                f"SELECT count(*)=100 FROM private.automation_email_attempt_reservations WHERE studio_id={quote(f['studio'])} AND state='unknown';"
            )
            == "t",
            "Attached bounded page did not progress",
        )
        require(
            call("private.automation_expire_orphaned_legacy_attempts_v1", 100) == 1,
            "Later orphan not reached on retry",
        )
        require(
            sql(
                f'SELECT count(*)=101 FROM private.automation_email_attempt_reservations WHERE studio_id={quote(f["studio"])} AND state=\'unknown\' AND frequency_state=\'unknown\' AND legacy_projection=\'{{"state":"unknown","reason":"lease_expired"}}\';'
            )
            == "t",
            "Expiry lost charge or original projection",
        )
        passed(
            "raw100 page before parent filter composes with attached100 expiry and later orphan"
        )

        sql(
            (
                ROOT / "supabase/verification/automation_legacy_cutover_contract.sql"
            ).read_text()
        )
        passed("focused legacy contract")
        # Logical restore uses the same owned name only after the canonical
        # clone is gone. The dump is exclusively created outside the repository.
        tables = (
            "automation_sender_gate",
            "automation_sender_preparations",
            "automation_email_attempt_reservations",
            "automation_unsubscribe_token_bindings",
        )

        def retained_truth():
            return {
                table: val(
                    "SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::TEXT),'[]') FROM private."
                    + table
                    + " t;"
                )
                for table in tables
            }

        truth = retained_truth()
        definitions = val(INVENTORY)
        require(definitions == after, "Temporary proof definitions not fully restored")
        dump = Path(socket).parent / (database + ".dump")
        require(not os.path.lexists(dump), "Foreign dump path refused")
        fd = os.open(dump, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        dump_identity = os.fstat(fd)
        os.close(fd)
        dump_owned = True
        pg_dump = str(Path(psql).with_name("pg_dump"))
        pg_restore = str(Path(psql).with_name("pg_restore"))
        local.require_pg17(pg_dump, pg_restore)
        local.run(
            [
                pg_dump,
                *local.connection,
                f"--dbname={database}",
                "--format=custom",
                "--file",
                str(dump),
            ]
        )
        dump_hash = hashlib.sha256(dump.read_bytes()).hexdigest()
        local.sql("postgres", f"DROP DATABASE {database};")
        owned = False
        require(
            local.sql(
                "postgres",
                f"SELECT NOT EXISTS(SELECT 1 FROM pg_database WHERE datname={quote(database)});",
            )
            == "t",
            "Canonical clone remains",
        )
        report["lifetimes"].append(
            {"action": "canonical_drop_verified", "at": time.time()}
        )
        local.sql("postgres", f"CREATE DATABASE {database} TEMPLATE template0;")
        owned = True
        report["lifetimes"].append({"action": "restore_create", "at": time.time()})
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
            retained_truth() == truth and val(INVENTORY) == definitions,
            "Logical restore lost common history/security",
        )
        require(
            call("public.suppress_missed_class_automation_v1", orphan["optout"])
            == {"success": True},
            "Restored orphan token lost",
        )
        answer = call(
            "public.settle_missed_class_automation_v2",
            orphan["delivery"],
            orphan["token"],
            orphan["attempt"],
            delivery_result(orphan["revision"]),
        )["payload"]
        require(
            not answer["updated"], "Restored expired attempt accepted late response"
        )
        require(
            sql(
                "SELECT array_agg(column_name::TEXT ORDER BY ordinal_position)=ARRAY['token_hash','studio_id','recipient_email','created_at'] FROM information_schema.columns WHERE table_schema='private' AND table_name='automation_unsubscribe_token_bindings';"
            )
            == "t",
            "Mapping retained payload columns",
        )
        passed(
            "one-clone logical restore preserves origins clocks ownership projections token hashes and function security",
            dump_sha256=dump_hash,
        )

        report["success"] = True
    except BaseException as exc:
        report["success"] = False
        report["failure"] = str(exc)
        raise
    finally:
        for item in children:
            process = item["process"]
            if process.poll() is None:
                process.kill()
                process.wait(timeout=5)
        if owned:
            local.sql("postgres", f"DROP DATABASE {database};")
            require(
                local.sql(
                    "postgres",
                    f"SELECT NOT EXISTS(SELECT 1 FROM pg_database WHERE datname={quote(database)});",
                )
                == "t",
                "Owned cleanup failed",
            )
            report["lifetimes"].append({"action": "drop_verified", "at": time.time()})
        if dump_owned:
            stat = dump.lstat()
            require(
                not dump.is_symlink()
                and (stat.st_dev, stat.st_ino)
                == (dump_identity.st_dev, dump_identity.st_ino),
                "Dump ownership changed",
            )
            dump.unlink()
            require(not os.path.lexists(dump), "Owned dump remains")
            report["lifetimes"].append(
                {"action": "dump_removed_verified", "at": time.time()}
            )
        require(
            (Path(socket).parent / "data/postmaster.pid").read_text().splitlines()[0]
            == report["postmaster_pid"],
            "Template cluster PID changed",
        )
        report["template_after"] = json.loads(
            local.sql(
                "postgres",
                "SELECT row_to_json(p) FROM public.koaryu_release_schema_preflight_v37() p;",
            )
        )
        require(report["template_after"] == baseline, "Template release state changed")
        with evidence.open("x") as handle:
            json.dump(report, handle, indent=2)
            handle.write("\n")


if __name__ == "__main__":
    main(sys.argv[1:])
