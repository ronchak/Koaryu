#!/usr/bin/env python3
"""Prove payer balance snapshot/lock ordering on the disposable local cluster."""
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

from local_postgres_verification import LocalPostgres, require
from uuid import uuid4

class ProofFailure(RuntimeError):
    def __init__(self,reason,facts):
        self.reason,self.facts=reason,facts
        super().__init__(f'{reason}: {facts}')

def run_cases(local,database):
    children=[];results=[]
    ids={key:str(uuid4()) for key in ['actor','studio','payer','other','invoice','other_invoice']}
    def sql(statement):return local.sql(database,statement)
    def command(payer):return f"SELECT public.recompute_billing_payer_balance_v1('{ids['studio']}','{ids[payer]}');"
    def start(label,statement,hold=True):
        name='balance_'+label+'_'+uuid4().hex[:12]
        process=subprocess.Popen([local.psql,*local.connection,'--dbname='+database,'--no-psqlrc','--quiet','--tuples-only','--no-align','--set=ON_ERROR_STOP=1','--set=VERBOSITY=verbose'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,bufsize=1,env=local.env)
        item={'process':process,'name':name,'lines':[],'errors':[],'events':queue.Queue()};children.append(item)
        def drain(stream,target,events=None):
            for line in stream:
                target.append(line.rstrip())
                if events is not None:events.put(line.rstrip())
        item['threads']=[threading.Thread(target=drain,args=(process.stdout,item['lines'],item['events']),daemon=True),threading.Thread(target=drain,args=(process.stderr,item['errors']),daemon=True)]
        for thread in item['threads']:thread.start()
        process.stdin.write(f"SET application_name='{name}'; BEGIN ISOLATION LEVEL READ COMMITTED; SET LOCAL statement_timeout='20s'; SET LOCAL ROLE service_role; SELECT current_setting('transaction_isolation');\n{statement}\nSELECT 'RESULT_READY';\n")
        if hold:process.stdin.flush()
        else:
            process.stdin.write('COMMIT;\n');process.stdin.close()
        return item
    def blocker(first,second):
        return json.loads(sql("SELECT COALESCE(jsonb_agg(jsonb_build_object('holder',a.pid,'waiter',b.pid,'type',b.wait_event_type,'event',b.wait_event)),'[]'::jsonb) FROM pg_stat_activity a JOIN pg_stat_activity b ON b.datname=a.datname "
            f"WHERE a.datname=current_database() AND a.application_name='{first['name']}' AND b.application_name='{second['name']}' AND b.state='active' AND a.pid=ANY(pg_blocking_pids(b.pid));"))
    def ready(item,forbidden_holder=None):
        deadline=time.monotonic()+15
        while time.monotonic()<deadline:
            try:
                if item['events'].get(timeout=.05)=='RESULT_READY':
                    assert 'read committed' in item['lines']
                    return
            except queue.Empty:
                if forbidden_holder:
                    blocked=blocker(forbidden_holder,item)
                    if blocked:raise ProofFailure('unexpected_invoice_lock',blocked)
                code = item['process'].poll()
                if code is not None:
                    for thread in item['threads']:
                        thread.join(timeout=2)
                    if any(thread.is_alive() for thread in item['threads']):
                        raise ProofFailure('session_output_not_drained', item['errors'])
                    if code == 0 and 'RESULT_READY' in item['lines']:
                        assert 'read committed' in item['lines']
                        return
                    raise ProofFailure('session_failed_before_barrier', item['errors'])
        raise ProofFailure('missing_result_barrier',item['errors'])
    def wait_blocked(first,second):
        deadline=time.monotonic()+15
        while time.monotonic()<deadline:
            rows=blocker(first,second)
            if rows:
                assert len(rows)==1 and rows[0]['type']=='Lock',rows
                return rows[0]
            if first['process'].poll() is not None or second['process'].poll() is not None:
                raise ProofFailure('session_finished_before_required_lock',second['errors'])
            time.sleep(.025)
        raise ProofFailure('required_lock_not_observed',second['errors'])
    def finish(item):
        code=item['process'].wait(timeout=15)
        for thread in item['threads']:thread.join(timeout=2)
        assert not any(t.is_alive() for t in item['threads'])
        if code:raise ProofFailure('session_failed',item['errors'])
    def release(item,commit=True):
        item['process'].stdin.write('COMMIT;\n' if commit else 'ROLLBACK;\n');item['process'].stdin.close();finish(item)
    def facts():
        return json.loads(sql(f"SELECT jsonb_build_object('invoice',(SELECT jsonb_build_array(status,amount_remaining_cents) FROM public.billing_invoices WHERE id='{ids['invoice']}'),'payer',(SELECT jsonb_build_array(balance_cents,billing_status) FROM public.billing_payers WHERE id='{ids['payer']}'),'other',(SELECT balance_cents FROM public.billing_payers WHERE id='{ids['other']}'));"))
    try:
        sql(f"""BEGIN;
INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
VALUES('{ids['actor']}','authenticated','authenticated','{ids['actor']}@example.invalid','{{}}','{{}}',now(),now());
INSERT INTO public.studios(id,name,slug,owner_id) VALUES('{ids['studio']}','Balance lock fixture','balance-{ids['studio']}','{ids['actor']}');
INSERT INTO public.billing_payers(id,studio_id,display_name,balance_cents) VALUES
('{ids['payer']}','{ids['studio']}','Primary',100),('{ids['other']}','{ids['studio']}','Independent',0);
INSERT INTO public.billing_invoices(id,studio_id,payer_id,status,amount_due_cents,amount_remaining_cents,external)VALUES
('{ids['invoice']}','{ids['studio']}','{ids['payer']}','open',100,100,true),
('{ids['other_invoice']}','{ids['studio']}','{ids['other']}','open',200,200,true);
COMMIT;""")
        for commit in [True,False]:
            sql(f"BEGIN; UPDATE public.billing_invoices SET status='open',amount_paid_cents=0,amount_remaining_cents=100 WHERE id='{ids['invoice']}'; UPDATE public.billing_payers SET balance_cents=100,billing_status='past_due' WHERE id='{ids['payer']}'; COMMIT;")
            holder=start('holder',f"SELECT id FROM public.billing_payers WHERE id='{ids['payer']}' FOR UPDATE; UPDATE public.billing_invoices SET status='paid',amount_paid_cents=100,amount_remaining_cents=0 WHERE id='{ids['invoice']}'; UPDATE public.billing_payers SET balance_cents=0,billing_status='current' WHERE id='{ids['payer']}';")
            ready(holder)
            waiter=start('waiter',command('payer'),hold=False)
            lock=wait_blocked(holder,waiter)
            independent=start('independent',command('other'),hold=False);ready(independent);finish(independent)
            assert facts()['invoice']==['open',100]
            release(holder,commit);ready(waiter);finish(waiter)
            observed=facts()
            expected={'invoice':['paid',0] if commit else ['open',100],'payer':[0,'current'] if commit else [100,'past_due'],'other':200}
            if observed!=expected:raise ProofFailure('stale_snapshot',{'lock':lock,'actual':observed,'expected':expected})
            results.append({'case':'post_lock_snapshot_commit' if commit else 'post_lock_snapshot_rollback','lock':lock,'facts':observed})
        sql(f"BEGIN; UPDATE public.billing_invoices SET status='open',amount_paid_cents=0,amount_remaining_cents=100 WHERE id='{ids['invoice']}'; COMMIT;")
        invoice_owner=start('invoice_owner',f"SELECT id FROM public.billing_invoices WHERE id='{ids['invoice']}' FOR UPDATE;")
        ready(invoice_owner)
        balance_owner=start('balance_owner',command('payer'))
        ready(balance_owner,forbidden_holder=invoice_owner)
        invoice_owner['process'].stdin.write(f"SELECT id FROM public.billing_payers WHERE id='{ids['payer']}' FOR UPDATE; UPDATE public.billing_invoices SET status='paid',amount_paid_cents=100,amount_remaining_cents=0 WHERE id='{ids['invoice']}'; {command('payer')} COMMIT;\n")
        invoice_owner['process'].stdin.close()
        lock=wait_blocked(balance_owner,invoice_owner)
        release(balance_owner);finish(invoice_owner)
        observed=facts();expected={'invoice':['paid',0],'payer':[0,'current'],'other':200}
        if observed!=expected:raise ProofFailure('invoice_owner_completion',observed)
        results.append({'case':'invoice_then_payer_without_inverse_lock','lock':lock,'facts':observed})
        return results
    finally:
        for child in children:
            process=child['process']
            if process.poll() is None:
                process.terminate()
                try:process.wait(timeout=3)
                except subprocess.TimeoutExpired:process.kill();process.wait(timeout=3)


def main(arguments):
    require(len(arguments) == 3, "Expected psql socket port from the local contract verifier")
    psql, socket, port = arguments
    local = LocalPostgres(psql, socket, port, str(Path(socket).parent))
    createdb = str(Path(psql).with_name("createdb"))
    local.require_pg17(createdb)
    source_hash = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    shared_path = Path(__file__).with_name("local_postgres_verification.py")
    shared_hash = hashlib.sha256(shared_path.read_bytes()).hexdigest()
    readiness = json.loads(local.sql("postgres", "SELECT to_jsonb(r) FROM public.koaryu_release_schema_preflight_v22() r;"))
    require(readiness.get("ready") is True and readiness.get("migration_count") == 136
            and readiness.get("migration_head") == "20260908183744"
            and readiness.get("manifest_version") == "release-db-attestation-v41"
            and readiness.get("security_failures") == [], "Payer concurrency requires exact ready V41")
    database = f"koaryu_payer_balance_concurrency_{os.getpid()}"
    owned = False
    try:
        local.run([createdb, *local.connection, "--owner=postgres", "--template=postgres", database])
        owned = True
        cases = run_cases(local, database)
        require(hashlib.sha256(Path(__file__).read_bytes()).hexdigest() == source_hash
                and hashlib.sha256(shared_path.read_bytes()).hexdigest() == shared_hash,
                "Payer concurrency inputs changed during verification")
        (local.temporary / "payer-balance-concurrency-evidence.json").write_text(json.dumps({
            "script_sha256": source_hash, "local_tools_sha256": shared_hash,
            "readiness": readiness, "cases": cases,
        }, indent=2) + "\n")
        for case in cases:
            print("[payer concurrency] PASS " + case["case"] + ": observed locks and persisted outcome", flush=True)
    finally:
        if owned:
            local.sql("postgres", f"DROP DATABASE {database} WITH (FORCE);")


if __name__ == "__main__":
    def interrupted(signum, _frame):
        raise SystemExit(128 + signum)
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    main(sys.argv[1:])
