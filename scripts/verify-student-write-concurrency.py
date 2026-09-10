#!/usr/bin/env python3
"""Prove rank and import writer ordering on the disposable local cluster."""
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
    database = f"koaryu_student_write_concurrency_{os.getpid()}"
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

    def session(name, statement, *, hold=False, role="service_role"):
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
                            f"SET LOCAL ROLE {role};\n{statement}\n")
        if hold:
            process.stdin.write("SELECT 'RESULT_READY';\n")
            process.stdin.flush()
        else:
            process.stdin.write("COMMIT;\n")
            process.stdin.close()
        return item

    def await_result(item, *, receipt=True):
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            try:
                if item["events"].get(timeout=0.1) == "RESULT_READY":
                    if not receipt:
                        return None
                    values = [line for line in item["lines"] if re.fullmatch(r"[0-9a-f-]{36}", line)]
                    require(len(values) == 1, "Holding session did not return one expected row identity")
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
        require(sql("SELECT ready FROM public.koaryu_release_schema_preflight_v26();") == "t", "Student writer concurrency requires ready V45")
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
        def import_fixture():
            values = {key: str(uuid4()) for key in ("owner", "actor", "studio", "program", "new_program", "ladder", "rank", "student")}
            sql(f"""BEGIN;
INSERT INTO auth.users(id,aud,role,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) VALUES
('{values['owner']}','authenticated','authenticated','{values['owner']}@example.invalid',now(),'{{}}','{{}}',now(),now()),
('{values['actor']}','authenticated','authenticated','{values['actor']}@example.invalid',now(),'{{}}','{{}}',now(),now());
INSERT INTO public.studios(id,name,slug,owner_id) VALUES('{values['studio']}','Import lock fixture','{values['studio']}','{values['owner']}');
INSERT INTO public.staff_roles(studio_id,user_id,role) VALUES('{values['studio']}','{values['owner']}','admin'),('{values['studio']}','{values['actor']}','admin');
INSERT INTO public.programs(id,studio_id,name) VALUES('{values['program']}','{values['studio']}','Existing program');
COMMIT;""")
            values['run'] = sql(f"SET ROLE service_role; SELECT run_row->>'id' FROM public.claim_student_import_run_v2('{values['studio']}','{values['actor']}','students_csv_execute','import-key','hash','token',45);")
            return values

        def import_row(values):
            payload = json.dumps({"id": values['student'], "studio_id": values['studio'], "legal_first_name": "Synthetic", "legal_last_name": "Import",
                "_import_outcome": {"row_number": 2, "is_valid": True, "issues": [], "data": {}, "imported_without_belt": False}})
            return f"SELECT student_id FROM public.import_student_row_atomic('{payload}','{values['studio']}','{values['run']}','token',2,NULL,NULL,NULL,NULL,ARRAY['{values['program']}'::UUID]);"

        for clear_first in (False, True):
            f = import_fixture()
            clear = f"SELECT public.clear_studio_operational_data_atomic('{f['studio']}',FALSE);"
            first = session(f"import_clear_a_{int(clear_first)}", clear if clear_first else import_row(f), hold=True)
            await_result(first, receipt=False)
            second = session(f"import_clear_b_{int(clear_first)}", import_row(f) if clear_first else clear)
            blocking = observed_blocker(first, second, True)
            first['process'].stdin.write('COMMIT;\n'); first['process'].stdin.close()
            require(finish(first)[0] == 0, 'Import/clear holder failed')
            code, lines, errors = finish(second)
            require((code != 0 and 'ERROR:  P0001:' in errors and 'claim is no longer active' in errors) if clear_first else code == 0,
                    f'Import/clear settled incorrectly: {errors}')
            require(sql(f"SELECT NOT EXISTS(SELECT 1 FROM public.student_import_runs WHERE id='{f['run']}') AND NOT EXISTS(SELECT 1 FROM public.students WHERE id='{f['student']}') AND NOT EXISTS(SELECT 1 FROM private.student_import_receipts WHERE import_run_id='{f['run']}');") == 't',
                    'Clear left or recreated an import row/receipt')
            results.append({'case': 'clear_before_import' if clear_first else 'import_before_clear', 'blocking': blocking, 'outcome': 'passed'})

        for delete_first in (False, True):
            f = import_fixture()
            delete = f"DELETE FROM auth.users WHERE id='{f['actor']}';"
            first = session(f"import_auth_a_{int(delete_first)}", delete if delete_first else import_row(f), hold=True, role='postgres' if delete_first else 'service_role')
            await_result(first, receipt=False)
            second = session(f"import_auth_b_{int(delete_first)}", import_row(f) if delete_first else delete, role='service_role' if delete_first else 'postgres')
            blocking = observed_blocker(first, second, False)
            first['process'].stdin.write('COMMIT;\n'); first['process'].stdin.close()
            require(finish(first)[0] == 0, 'Import/Auth holder failed')
            code, lines, errors = finish(second)
            require((code != 0 and 'ERROR:  23503:' in errors and 'actor is unavailable' in errors) if delete_first else code == 0,
                    f'Import/Auth settled incorrectly: {errors}')
            expected_count = 0 if delete_first else 1
            require(sql(f"SELECT (SELECT count(*) FROM public.students WHERE id='{f['student']}')={expected_count} AND (SELECT count(*) FROM private.student_import_receipts WHERE import_run_id='{f['run']}')={expected_count} AND (SELECT actor_id IS NULL FROM public.student_import_runs WHERE id='{f['run']}');") == 't',
                    'Auth deletion changed the wrong committed import outcome')
            results.append({'case': 'auth_delete_before_import' if delete_first else 'import_before_auth_delete', 'blocking': blocking, 'outcome': 'passed'})

        f = import_fixture()
        sql(f"""BEGIN;
INSERT INTO public.belt_ladders(id,studio_id,program_id,name) VALUES('{f['ladder']}','{f['studio']}','{f['program']}','Empty ladder');
INSERT INTO public.students(id,studio_id,legal_first_name,legal_last_name,program_id) VALUES('{f['student']}','{f['studio']}','Unranked','Student','{f['program']}');
INSERT INTO public.student_program_memberships(studio_id,student_id,program_id,status)
SELECT '{f['studio']}','{f['student']}','{f['program']}','paused' WHERE NOT EXISTS(SELECT 1 FROM public.student_program_memberships WHERE student_id='{f['student']}');
COMMIT;""")
        # Hold the rank-plan writer's existing first lock, then invoke its real
        # command after import reaches the competing lock. A ladder-first import
        # would deadlock when its first-rank trigger reaches this student.
        first = session('rank_plan_student_owner', f"SELECT id FROM public.students WHERE id='{f['student']}' FOR UPDATE;", hold=True)
        await_result(first)
        imported_rank = json.dumps([{'key': 'white', 'id': f['rank'], 'name': 'White', 'color_hex': '#ffffff'}])
        second = session('import_first_rank', f"SELECT public.prepare_student_import_belts_v1('{f['studio']}','{f['run']}','token','{f['program']}','{f['ladder']}','{imported_rank}',FALSE);")
        blocking = observed_blocker(first, second, False)
        plan = json.dumps([{'name': 'White', 'color_hex': '#ffffff', 'min_classes': 0, 'min_months': 0, 'requires_approval': False, 'is_tip': False}])
        first['process'].stdin.write(f"SELECT id FROM public.sync_belt_ladder_ranks_v2('{f['ladder']}','{f['studio']}','{f['actor']}','{uuid4()}','Stripe','{plan}'); COMMIT;\n")
        first['process'].stdin.close()
        require(finish(first)[0] == 0, 'Actual rank-plan continuation deadlocked or failed')
        code, lines, errors = finish(second)
        require(code == 0, f'First-rank import deadlocked or failed: {errors}')
        require(sql(f"SELECT count(*)=1 FROM public.belt_ranks WHERE ladder_id='{f['ladder']}';") == 't'
                and sql(f"SELECT s.current_belt_rank_id=m.current_belt_rank_id AND m.current_belt_rank_id IS NOT NULL FROM public.students s JOIN public.student_program_memberships m ON m.student_id=s.id WHERE s.id='{f['student']}';") == 't',
                'Concurrent first-rank setup did not converge')
        results.append({'case': 'first_rank_import_vs_rank_plan_student_lock', 'blocking': blocking, 'outcome': 'passed'})

        # A delay inside the actual write makes a start-time-only heartbeat stale.
        sql("""CREATE FUNCTION public.test_import_delay() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN IF current_setting('koaryu.test_import_delay',TRUE)='on' THEN PERFORM pg_sleep(1.3); END IF; RETURN NEW; END; $$;
CREATE TRIGGER test_import_delay BEFORE INSERT ON public.students FOR EACH ROW EXECUTE FUNCTION public.test_import_delay();
CREATE TRIGGER test_import_delay BEFORE INSERT ON public.programs FOR EACH ROW EXECUTE FUNCTION public.test_import_delay();
CREATE TRIGGER test_import_delay BEFORE INSERT ON public.belt_ranks FOR EACH ROW EXECUTE FUNCTION public.test_import_delay();""")
        for kind in ('row', 'program', 'belt'):
            f = import_fixture()
            if kind == 'row':
                statement = import_row(f)
            elif kind == 'program':
                statement = f"SELECT public.prepare_student_import_program_v1('{f['studio']}','{f['run']}','token','new','{f['new_program']}','New program','{f['ladder']}',FALSE);"
            else:
                ranks = json.dumps([{'key': 'white', 'id': f['rank'], 'name': 'White', 'color_hex': '#ffffff'}])
                statement = f"SELECT public.prepare_student_import_belts_v1('{f['studio']}','{f['run']}','token','{f['program']}','{f['ladder']}','{ranks}',TRUE);"
            sql(f"UPDATE public.student_import_runs SET processing_started_at='2000-01-01' WHERE id='{f['run']}';")
            first = session(f'import_progress_a_{kind}', "SET LOCAL koaryu.test_import_delay='on'; " + statement, hold=True)
            await_result(first, receipt=False)
            second = session(f'import_progress_b_{kind}', f"SELECT claim_status FROM public.claim_student_import_run_v2('{f['studio']}','{f['owner']}','students_csv_execute','import-key','hash','late-token',1);")
            blocking = observed_blocker(first, second, True)
            require(sql(f"SELECT processing_started_at < '2001-01-01' FROM public.student_import_runs WHERE id='{f['run']}';") == 't', 'Uncommitted progress became visible')
            first['process'].stdin.write('COMMIT;\n'); first['process'].stdin.close()
            require(finish(first)[0] == 0, 'Long import write failed')
            code, lines, errors = finish(second)
            require(code == 0 and 'already_processing' in lines and 'claimed' not in lines, f'Fresh progress was stolen: {lines} {errors}')
            require(sql(f"SELECT processing_token='token' AND actor_id='{f['actor']}' FROM public.student_import_runs WHERE id='{f['run']}';") == 't', 'Late claimant changed worker ownership')
            results.append({'case': f'{kind}_commit_progress', 'blocking': blocking, 'outcome': 'passed'})
        print('[student writer concurrency] PASS retained rank cases and import clear/Auth/progress ordering', flush=True)
        (local.temporary / "student-write-concurrency-evidence.json").write_text(json.dumps({"script_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), "local_tools_sha256": hashlib.sha256(Path(__file__).with_name("local_postgres_verification.py").read_bytes()).hexdigest(), "cases": results}, indent=2) + "\n")
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
