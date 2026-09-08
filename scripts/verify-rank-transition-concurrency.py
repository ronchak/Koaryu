#!/usr/bin/env python3
"""Prove rank replay ordering with observed locks on the disposable local cluster."""
import hashlib
import json
import os
from pathlib import Path
import queue
import re
import signal
import subprocess
import sys
import threading
import time
from uuid import uuid4

from local_postgres_verification import LocalPostgres, require


def main(arguments):
    require(len(arguments) == 3, "Expected psql socket port from the local contract verifier")
    psql, socket, port = arguments
    local = LocalPostgres(psql, socket, port, str(Path(socket).parent))
    createdb = str(Path(psql).with_name("createdb"))
    local.require_pg17(createdb)
    database = f"koaryu_rank_concurrency_{os.getpid()}"
    owned = False
    children = []
    ids = {key: str(uuid4()) for key in ("actor", "studio", "program", "ladder", "student", "membership", "white", "yellow")}
    results = []

    def sql(statement):
        return local.sql(database, statement)

    def command(operation, *, changed=False, legacy=False):
        notes = "'Changed notes'" if changed else "NULL"
        if legacy:
            return ("SELECT id FROM public.record_student_promotion_v2("
                    f"'{ids['studio']}','{ids['student']}','{ids['membership']}','{ids['program']}',"
                    f"'{ids['white']}','{ids['yellow']}','{ids['actor']}',{notes},'{operation}');")
        return ("SELECT id FROM public.record_student_rank_transition_v3("
                f"'{ids['studio']}','{ids['student']}',NULL,NULL,'{ids['yellow']}',"
                f"'{ids['actor']}',{notes},'promotion','{operation}');")

    def session(name, statement, *, hold=False):
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

        threads = [threading.Thread(target=drain, args=(process.stdout, item["lines"], item["events"]), daemon=True),
                   threading.Thread(target=drain, args=(process.stderr, item["errors"]), daemon=True)]
        item["threads"] = threads
        for thread in threads:
            thread.start()
        process.stdin.write(f"SET application_name='{name}';\nBEGIN;\nSET LOCAL statement_timeout='30s';\n"
                            f"SET LOCAL ROLE service_role;\n{statement}\n")
        if hold:
            process.stdin.write("SELECT 'RESULT_READY';\n")
            process.stdin.flush()
        else:
            process.stdin.write("COMMIT;\n")
            process.stdin.close()
        return item

    def await_result(item):
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            try:
                if item["events"].get(timeout=0.1) == "RESULT_READY":
                    values = [line for line in item["lines"] if re.fullmatch(r"[0-9a-f-]{36}", line)]
                    require(len(values) == 1, "Holding session did not return one rank receipt")
                    return values[0]
            except queue.Empty:
                require(item["process"].poll() is None, "Holding session exited before acquiring its command locks: " + "\n".join(item["errors"]))
        raise RuntimeError("Holding session never reached its result barrier")

    def observed_blocker(first, second, same_operation):
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            require(first["process"].poll() is None and second["process"].poll() is None,
                    "A competing session exited before the lock was observed")
            rows = json.loads(sql("SELECT COALESCE(jsonb_agg(jsonb_build_object('pid',b.pid,'blocker',a.pid,"
                "'wait',b.wait_event,'type',b.wait_event_type)), '[]'::jsonb) "
                "FROM pg_stat_activity a JOIN pg_stat_activity b ON b.datname=a.datname "
                f"WHERE a.datname=current_database() AND a.application_name='{first['name']}' "
                f"AND b.application_name='{second['name']}' AND b.state='active' "
                "AND a.pid=ANY(pg_blocking_pids(b.pid));"))
            if rows:
                require(len(rows) == 1 and rows[0]["type"] == "Lock", "Ambiguous competing lock observation")
                require(not same_operation or rows[0]["wait"] == "advisory", "Same-key request did not wait on the operation lock")
                return rows[0]
            time.sleep(0.025)
        raise RuntimeError("Competing request did not reach the required database lock")

    def finish(item):
        code = item["process"].wait(timeout=15)
        for thread in item["threads"]:
            thread.join(timeout=2)
        require(not any(thread.is_alive() for thread in item["threads"]), "Session output did not finish")
        return code, item["lines"], "\n".join(item["errors"])

    try:
        local.run([createdb, *local.connection, "--owner=postgres", "--template=postgres", database])
        owned = True
        require(sql("SELECT ready FROM public.koaryu_release_schema_preflight_v21();") == "t", "Rank concurrency requires ready V40")
        sql(f"""BEGIN;
INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
VALUES ('{ids['actor']}','authenticated','authenticated','rank-lock@example.invalid','{{}}','{{}}',now(),now());
INSERT INTO public.studios(id,name,slug,owner_id) VALUES ('{ids['studio']}','Rank lock fixture','rank-lock-fixture','{ids['actor']}');
INSERT INTO public.programs(id,studio_id,name) VALUES ('{ids['program']}','{ids['studio']}','Rank lock program');
INSERT INTO public.belt_ladders(id,studio_id,program_id,name) VALUES ('{ids['ladder']}','{ids['studio']}','{ids['program']}','Rank lock ladder');
INSERT INTO public.belt_ranks(id,studio_id,ladder_id,name,display_order) VALUES
 ('{ids['white']}','{ids['studio']}','{ids['ladder']}','White',0),('{ids['yellow']}','{ids['studio']}','{ids['ladder']}','Yellow',1);
INSERT INTO public.students(id,studio_id,legal_first_name,legal_last_name,status,program_id,current_belt_rank_id)
VALUES ('{ids['student']}','{ids['studio']}','Rank','Student','active','{ids['program']}','{ids['white']}');
INSERT INTO public.student_program_memberships(id,studio_id,student_id,program_id,status,current_belt_rank_id)
VALUES ('{ids['membership']}','{ids['studio']}','{ids['student']}','{ids['program']}','active','{ids['white']}');
COMMIT;""")
        for index, case in enumerate(("same", "changed", "rollback", "different_key", "mixed_v2")):
            first_key = str(uuid4())
            second_key = str(uuid4()) if case == "different_key" else first_key
            # Reset this owned fixture only after the preceding sessions finish.
            sql(f"BEGIN; UPDATE public.students SET current_belt_rank_id='{ids['white']}' WHERE id='{ids['student']}'; "
                f"UPDATE public.student_program_memberships SET current_belt_rank_id='{ids['white']}' WHERE id='{ids['membership']}'; COMMIT;")
            first = session(f"rank_a_{os.getpid()}_{index}", command(first_key, legacy=case == "mixed_v2"), hold=True)
            first_id = await_result(first)
            second = session(f"rank_b_{os.getpid()}_{index}", command(second_key, changed=case == "changed"))
            blocking = observed_blocker(first, second, first_key == second_key)
            require(sql(f"SELECT count(*) FROM public.promotions WHERE studio_id='{ids['studio']}' AND operation_id='{first_key}';") == "0",
                    "Outside reader saw the held uncommitted receipt")
            first["process"].stdin.write("ROLLBACK;\n" if case == "rollback" else "COMMIT;\n")
            first["process"].stdin.close()
            require(finish(first)[0] == 0, "Holding session failed to settle")
            code, lines, errors = finish(second)
            if case in ("changed", "different_key"):
                state, marker = ("22023", "rank_transition_conflict") if case == "changed" else ("P0001", "rank_transition_invalid")
                require(code != 0 and f"ERROR:  {state}:" in errors and f"DETAIL:  {marker}" in errors,
                        f"Competing request failed for the wrong reason: {errors}")
                committed_id = first_id
            else:
                returned = [line for line in lines if re.fullmatch(r"[0-9a-f-]{36}", line)]
                require(code == 0 and len(returned) == 1, f"Competing replay failed: {errors}")
                committed_id = returned[0]
                require((committed_id != first_id) if case == "rollback" else (committed_id == first_id),
                        "Commit/rollback did not preserve the correct receipt identity")
            facts = json.loads(sql(f"""SELECT jsonb_build_object(
 'history',(SELECT count(*) FROM public.promotions WHERE studio_id='{ids['studio']}' AND operation_id IN ('{first_key}','{second_key}')),
 'audit',(SELECT jsonb_agg(jsonb_build_array(entity_id,action) ORDER BY id) FROM public.audit_logs WHERE studio_id='{ids['studio']}' AND metadata->>'operation_id' IN ('{first_key}','{second_key}')),
 'id',(SELECT id FROM public.promotions WHERE studio_id='{ids['studio']}' AND operation_id='{first_key}'),
 'student',(SELECT current_belt_rank_id FROM public.students WHERE id='{ids['student']}'),
 'membership',(SELECT current_belt_rank_id FROM public.student_program_memberships WHERE id='{ids['membership']}'));"""))
            require(facts == {"history": 1, "audit": [[committed_id, "student.promoted"]], "id": committed_id, "student": ids["yellow"], "membership": ids["yellow"]},
                    f"Concurrent rank command changed persisted facts incorrectly: {facts}")
            if case == "rollback":
                require(sql(f"SELECT count(*) FROM public.promotions WHERE id='{first_id}';") == "0", "Rolled-back receipt survived")
            results.append({"case": case, "blocking": blocking, "facts": facts, "outcome": "passed"})
            print(f"[rank concurrency] PASS {case}: observed blocker before settlement", flush=True)
        (local.temporary / "rank-transition-concurrency-evidence.json").write_text(json.dumps({"script_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), "local_tools_sha256": hashlib.sha256(Path(__file__).with_name("local_postgres_verification.py").read_bytes()).hexdigest(), "cases": results}, indent=2) + "\n")
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
