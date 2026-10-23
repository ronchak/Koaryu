#!/usr/bin/env python3
"""Exercise V61 identity locking with real sessions on an owned local clone."""
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
from uuid import uuid4

from local_postgres_verification import LocalPostgres, require


def main(arguments):
    require(len(arguments) == 3, "Expected psql socket port from the local verifier")
    psql, socket, port = arguments
    local = LocalPostgres(psql, socket, port, str(Path(socket).parent))
    createdb = str(Path(psql).with_name("createdb"))
    local.require_pg17(createdb)
    database = f"koaryu_import_identity_{os.getpid()}"
    children = []
    owned = False
    cases = []

    def sql(statement):
        return local.sql(database, statement)

    def session(name, statement, hold=False):
        process = subprocess.Popen([psql, *local.connection, f"--dbname={database}", "--no-psqlrc",
            "--quiet", "--tuples-only", "--no-align", "--set=ON_ERROR_STOP=1", "--set=VERBOSITY=verbose"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, bufsize=1, env=local.env)
        item = {"process": process, "lines": [], "errors": [], "events": queue.Queue(), "name": name}
        children.append(item)

        def drain(stream, target, events=None):
            for line in stream:
                target.append(line.rstrip())
                if events is not None:
                    events.put(line.rstrip())

        item["threads"] = [threading.Thread(target=drain, args=(process.stdout, item["lines"], item["events"]), daemon=True),
                           threading.Thread(target=drain, args=(process.stderr, item["errors"]), daemon=True)]
        for thread in item["threads"]:
            thread.start()
        process.stdin.write(f"SET application_name='{name}';\nBEGIN;\nSET LOCAL statement_timeout='30s';\nSET LOCAL ROLE service_role;\n{statement}\n")
        if hold:
            process.stdin.write("SELECT 'RESULT_READY';\n")
            process.stdin.flush()
        else:
            process.stdin.write("COMMIT;\n")
            process.stdin.close()
        return item

    def result_barrier(item):
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            try:
                if item["events"].get(timeout=0.1) == "RESULT_READY":
                    return
            except queue.Empty:
                require(item["process"].poll() is None, "Holding import exited: " + "\n".join(item["errors"]))
        raise RuntimeError("Holding import never reached its result barrier")

    def observed_blocker(first, second):
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            require(first["process"].poll() is None and second["process"].poll() is None,
                    "An import exited before its competing identity lock was observed")
            rows = json.loads(sql("SELECT COALESCE(jsonb_agg(jsonb_build_object('blocker',a.pid,'blocked',b.pid,"
                "'blockers',pg_blocking_pids(b.pid),'wait',b.wait_event,'type',b.wait_event_type,"
                "'identity_namespace',EXISTS(SELECT 1 FROM pg_locks l WHERE l.pid=b.pid AND l.locktype='advisory' "
                "AND NOT l.granted AND l.objsubid=2 AND l.classid=hashtext('koaryu.student-import-identity.v61')::oid))), '[]'::jsonb) "
                "FROM pg_stat_activity a JOIN pg_stat_activity b ON b.datname=a.datname "
                f"WHERE a.datname=current_database() AND a.application_name='{first['name']}' "
                f"AND b.application_name='{second['name']}';"))
            if rows and rows[0]["type"] == "Lock" and rows[0]["wait"] == "advisory":
                row = rows[0]
                require(row["blockers"] == [row["blocker"]] and row["identity_namespace"],
                        "Competing import waited on a different lock: " + json.dumps(row))
                return row
            time.sleep(0.025)
        raise RuntimeError("Competing import never waited on the V61 identity lock")

    def finish(item):
        code = item["process"].wait(timeout=15)
        for thread in item["threads"]:
            thread.join(timeout=2)
        require(not any(thread.is_alive() for thread in item["threads"]), "Session output did not finish")
        return code, "\n".join(item["lines"]), "\n".join(item["errors"])

    try:
        local.run([createdb, *local.connection, "--owner=postgres", "--template=postgres", database])
        owned = True
        require(sql("SELECT ready FROM public.koaryu_release_schema_preflight_v42();") == "t",
                "Import identity race requires ready V61")
        for rollback in (False, True):
            ids = {key: str(uuid4()) for key in ("actor", "studio", "program", "run_a", "run_b", "student_a", "student_b")}
            sql(f"""BEGIN;
INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
VALUES('{ids['actor']}','authenticated','authenticated','identity-{ids['actor']}@example.invalid','{{}}','{{}}',now(),now());
INSERT INTO public.studios(id,name,slug,owner_id) VALUES('{ids['studio']}','Identity race','race-{ids['studio']}','{ids['actor']}');
INSERT INTO public.programs(id,studio_id,name) VALUES('{ids['program']}','{ids['studio']}','Identity program');
INSERT INTO public.student_import_runs(id,studio_id,actor_id,operation,idempotency_key,request_hash,status,receipts_enabled,processing_token,processing_started_at)
VALUES('{ids['run_a']}','{ids['studio']}','{ids['actor']}','students_csv_execute','race-a','hash','processing',true,'token',now()),
('{ids['run_b']}','{ids['studio']}','{ids['actor']}','students_csv_execute','race-b','hash','processing',true,'token',now());
COMMIT;""")

            def import_row(which):
                payload = {"id": ids[f"student_{which}"], "studio_id": ids["studio"],
                           "legal_first_name": "Ava" if which == "a" else " AVA ", "legal_last_name": "Nguyen",
                           "date_of_birth": "2014-06-03", "_import_outcome": {"row_number": 2,
                           "is_valid": True, "issues": [], "data": {}, "imported_without_belt": False}}
                return (f"SELECT student_id FROM public.import_student_row_atomic('{json.dumps(payload)}'::jsonb,"
                        f"'{ids['studio']}','{ids[f'run_{which}']}','token',2,'Jordan Smith',NULL,NULL,NULL,"
                        f"ARRAY['{ids['program']}'::uuid],ARRAY[]::uuid[]);")

            first = session(f"identity_a_{int(rollback)}", import_row("a"), hold=True)
            result_barrier(first)
            second = session(f"identity_b_{int(rollback)}", import_row("b"))
            blocking = observed_blocker(first, second)
            require(sql(f"SELECT count(*) FROM public.students WHERE studio_id='{ids['studio']}';") == "0",
                    "Uncommitted import became visible")
            first["process"].stdin.write("ROLLBACK;\n" if rollback else "COMMIT;\n")
            first["process"].stdin.close()
            require(finish(first)[0] == 0, "Holding import failed")
            code, lines, errors = finish(second)
            if rollback:
                require(code == 0 and ids["student_b"] in lines, "Import did not continue after rollback: " + errors)
            else:
                require(code != 0 and "P0409" in errors and "student_import_duplicate_review_required" in errors,
                        "Competing import did not observe the duplicate refusal: " + errors)
            winner = ids["student_b"] if rollback else ids["student_a"]
            require(sql(f"SELECT count(*)=1 AND bool_and(id='{winner}') FROM public.students WHERE studio_id='{ids['studio']}';") == "t",
                    "Concurrent imports did not leave exactly one student")
            require(sql(f"SELECT count(*) FROM private.student_import_receipts WHERE import_run_id IN ('{ids['run_a']}','{ids['run_b']}');") == "1",
                    "Refused or rolled-back import left a receipt")
            require(sql(f"SELECT count(*) FROM public.guardians WHERE studio_id='{ids['studio']}';") == "1",
                    "Refused or rolled-back import left a guardian")
            require(sql(f"SELECT count(*) FROM public.student_guardians l JOIN public.students s ON s.id=l.student_id WHERE s.studio_id='{ids['studio']}';") == "1",
                    "Refused import left a guardian link")
            cases.append({"rollback": rollback, "blocking": blocking, "outcome": "passed"})
            print(f"[import identity concurrency] PASS same spelling rollback={rollback}: exactly one student and receipt", flush=True)
        (local.temporary / "student-import-identity-concurrency-evidence.json").write_text(json.dumps({
            "script_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), "cases": cases}, indent=2) + "\n")
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
