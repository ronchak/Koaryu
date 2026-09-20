#!/usr/bin/env python3
"""Prove local billing command ordering and plan/reset coordination."""
import hashlib
import json
import os
from pathlib import Path
import queue
import runpy
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
    ids={key:str(uuid4()) for key in ['actor','retry_actor','studio','payer','other','invoice','other_invoice']}
    def sql(statement):return local.sql(database,statement)
    def command(payer):return f"SELECT public.recompute_billing_payer_balance_v1('{ids['studio']}','{ids[payer]}');"
    def start(label,statement,hold=True):
        name='billing_'+label+'_'+uuid4().hex[:12]
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
            f"WHERE a.datname=current_database() AND a.application_name='{first['name']}' AND b.application_name='{second['name']}' AND b.state='active' AND b.wait_event_type='Lock' AND a.pid=ANY(pg_blocking_pids(b.pid));"))
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
                    if blocked:raise ProofFailure('unexpected_blocking_lock',blocked)
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
VALUES('{ids['actor']}','authenticated','authenticated','{ids['actor']}@example.invalid','{{}}','{{}}',now(),now()),
('{ids['retry_actor']}','authenticated','authenticated','{ids['retry_actor']}@example.invalid','{{}}','{{}}',now(),now());
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
        def external(actor):
            return f"SELECT public.record_external_payment_v1('{ids['studio']}','{ids[actor]}','{ids['payer']}',500,'usd','cash','Original note','external-concurrent',repeat('a',64));"
        holder=start('external_owner',external('actor'));ready(holder)
        waiter=start('external_replay',external('retry_actor'),hold=False)
        lock=wait_blocked(holder,waiter)
        assert sql(f"SELECT count(*) FROM public.billing_payments WHERE studio_id='{ids['studio']}' AND idempotency_key='external-concurrent';")=='0'
        release(holder);ready(waiter);finish(waiter)
        payment=json.loads(next(line for line in holder['lines'] if line.startswith('{')))
        replay=json.loads(next(line for line in waiter['lines'] if line.startswith('{')))
        assert payment==replay
        audits=json.loads(sql(f"SELECT jsonb_agg(jsonb_build_object('actor_id',actor_id,'entity_id',entity_id,'metadata',metadata)) FROM public.audit_logs WHERE studio_id='{ids['studio']}' AND action='billing.external_payment_recorded';"))
        assert audits==[{'actor_id':ids['actor'],'entity_id':payment['id'],'metadata':{'amount_cents':500,'external_method':'cash'}}],audits
        assert sql(f"SELECT count(*) FROM public.billing_payments WHERE studio_id='{ids['studio']}' AND idempotency_key='external-concurrent';")=='1'
        results.append({'case':'external_payment_and_original_actor_audit_once','lock':lock,'payment_id':payment['id'],'audit_count':len(audits)})
        def plan_fixture(label):
            f={key:str(uuid4()) for key in ['actor','studio','plan','independent','program','replacement','student']}
            sql(f"""BEGIN;
INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
VALUES('{f['actor']}','authenticated','authenticated','{f['actor']}@example.invalid','{{}}','{{}}',now(),now());
INSERT INTO public.studios(id,name,slug,owner_id)
VALUES('{f['studio']}','Plan concurrency {label}','plan-{f['studio']}','{f['actor']}');
INSERT INTO public.staff_roles(studio_id,user_id,role) VALUES('{f['studio']}','{f['actor']}','admin');
INSERT INTO public.programs(id,studio_id,name,color_hex) VALUES
('{f['program']}','{f['studio']}','Original program','#112233'),
('{f['replacement']}','{f['studio']}','Replacement program','#445566');
INSERT INTO public.billing_plans(id,studio_id,name,amount_cents,status) VALUES
('{f['plan']}','{f['studio']}','Primary',1000,'active'),
('{f['independent']}','{f['studio']}','Independent',1000,'active');
INSERT INTO public.billing_plan_programs(studio_id,billing_plan_id,program_id) VALUES
('{f['studio']}','{f['plan']}','{f['program']}'),
('{f['studio']}','{f['independent']}','{f['program']}');
COMMIT;""")
            return f
        def plan_call(f,patch,programs=None,key='plan'):
            values=json.dumps(patch).replace("'","''")
            associations='NULL::uuid[]' if programs is None else "ARRAY["+','.join("'"+value+"'" for value in programs)+"]::uuid[]"
            return f"public.write_billing_plan_v1('{f['studio']}','{f['actor']}','{f[key]}','{values}'::jsonb,{associations})"
        def plan_state(f):
            return json.loads(sql(f"""SELECT jsonb_build_object(
'plan',(SELECT jsonb_build_array(amount_cents,description,cancellation_policy,status,archived_at IS NOT NULL,stripe_price_id) FROM public.billing_plans WHERE id='{f['plan']}'),
'links',(SELECT COALESCE(jsonb_agg(program_id ORDER BY program_id),'[]'::jsonb) FROM public.billing_plan_programs WHERE billing_plan_id='{f['plan']}'),
'audits',(SELECT count(*) FROM public.audit_logs WHERE entity_id='{f['plan']}' AND action='billing.plan_updated'));"""))
        def plan_result(item):
            return json.loads(next(line for line in item['lines'] if line.startswith('{')))
        def plan_missing(call,message):
            # Fail outside the expected-error handler if the command unexpectedly succeeds.
            return f"""DO $expected$ DECLARE rejected boolean:=false; BEGIN
BEGIN PERFORM {call}; EXCEPTION WHEN SQLSTATE 'P0002' THEN
IF SQLERRM IS DISTINCT FROM '{message}' THEN RAISE; END IF; rejected:=true; END;
IF NOT rejected THEN RAISE EXCEPTION 'expected plan command rejection'; END IF;
END $expected$; SELECT 'EXPECTED_PLAN_REJECTION';"""
        def clear_call(f):
            return f"SELECT public.clear_studio_operational_data_atomic('{f['studio']}',false);"

        f=plan_fixture('disjoint')
        first=start('plan_disjoint_owner','SELECT '+plan_call(f,{'description':'First edit'})+';');ready(first)
        second=start('plan_disjoint_waiter','SELECT '+plan_call(f,{'cancellation_policy':'Second edit'})+';',hold=False)
        lock=wait_blocked(first,second)
        independent=start('plan_disjoint_independent','SELECT '+plan_call(f,{'description':'Independent edit'},key='independent')+';',hold=False)
        ready(independent,forbidden_holder=first);finish(independent)
        assert plan_result(independent)['plan']['description']=='Independent edit'
        release(first);ready(second);finish(second)
        observed=plan_state(f)
        assert observed=={'plan':[1000,'First edit','Second edit','pending',False,None],'links':[f['program']],'audits':2},observed
        assert plan_result(second)['plan']['description']=='First edit'
        results.append({'case':'plan_disjoint_patches_and_shared_program_independence','lock':lock,'facts':observed})

        # Archive uses the exact single UPDATE boundary of BillingPlanManager.archive_plan.
        # Its later independent audit request is outside this plan-row serialization proof.
        for archive_first in [True,False]:
            f=plan_fixture('archive')
            archive=f"UPDATE public.billing_plans SET status='archived',archived_at='2026-09-10T00:00:00Z' WHERE id='{f['plan']}' AND studio_id='{f['studio']}';"
            edit='SELECT '+plan_call(f,{'amount_cents':1200})+';'
            first=start('plan_archive_owner',archive if archive_first else edit);ready(first)
            second=start('plan_archive_waiter',edit if archive_first else archive,hold=False)
            lock=wait_blocked(first,second)
            release(first);ready(second);finish(second)
            observed=plan_state(f)
            assert observed=={'plan':[1200,None,None,'archived',True,None],'links':[f['program']],'audits':1},observed
            results.append({'case':'plan_archive_before_edit' if archive_first else 'plan_edit_before_archive','lock':lock,'facts':observed})

        # Minimal SQL CAS behavior only: these predicates also occur in the existing
        # provider projection, but its full payload, snapshot and recovery remain
        # covered by the retained backend tests. No provider workflow runs here.
        for scalar_edit in [True,False]:
            f=plan_fixture('cas')
            call=plan_call(f,{'amount_cents':1300}) if scalar_edit else plan_call(f,{},[f['replacement']])
            first=start('plan_cas_owner','SELECT '+call+';');ready(first)
            second=start('plan_cas_projection',f"""WITH projected AS (
UPDATE public.billing_plans AS plan SET status='active',stripe_price_id='price_concurrency'
WHERE plan.id='{f['plan']}' AND plan.studio_id='{f['studio']}'
AND plan.amount_cents=1000 AND plan.status='active' AND plan.archived_at IS NULL RETURNING id)
SELECT jsonb_build_object('projected',count(*)) FROM projected;""",hold=False)
            lock=wait_blocked(first,second)
            release(first);ready(second);finish(second)
            assert plan_result(second)=={'projected':0 if scalar_edit else 1}
            observed=plan_state(f)
            expected={'plan':[1300,None,None,'pending',False,None] if scalar_edit else [1000,None,None,'active',False,'price_concurrency'],
                'links':[f['program'] if scalar_edit else f['replacement']],'audits':1}
            assert observed==expected,observed
            results.append({'case':'plan_real_edit_rejects_stale_sql_cas' if scalar_edit else 'plan_program_edit_preserves_sql_cas','lock':lock,'facts':observed})

        f=plan_fixture('local-before-clear')
        first=start('plan_before_clear','SELECT '+plan_call(f,{'description':'Committed before clear'},[f['replacement']])+';');ready(first)
        second=start('clear_after_plan',clear_call(f),hold=False)
        lock=wait_blocked(first,second);assert lock['event']=='advisory',lock
        # Existing committed links remain untouched while clear waits for the advisory lock.
        assert plan_state(f)['links']==[f['program']]
        release(first);ready(second);finish(second)
        observed=plan_state(f)
        assert observed=={'plan':None,'links':[],'audits':1},observed
        assert [p['program_id'] for p in plan_result(first)['programs']]==[f['replacement']]
        results.append({'case':'plan_commit_before_real_clear','lock':lock,'facts':observed})

        f=plan_fixture('clear-before-local')
        first=start('clear_before_plan',clear_call(f));ready(first)
        second=start('plan_after_clear',plan_missing(plan_call(f,{'description':'Must not persist'}),'billing_plan_not_found'),hold=False)
        lock=wait_blocked(first,second);assert lock['event']=='advisory',lock
        release(first);ready(second);finish(second)
        assert 'EXPECTED_PLAN_REJECTION' in second['lines']
        observed=plan_state(f)
        assert observed=={'plan':None,'links':[],'audits':0},observed
        results.append({'case':'real_clear_before_plan_rejects_without_audit','lock':lock,'facts':observed})

        f=plan_fixture('profile-clear')
        sql(f"INSERT INTO public.students(id,studio_id,legal_first_name,legal_last_name,status) VALUES('{f['student']}','{f['studio']}','Profile','Continuation','active');")
        first=start('profile_child_owner',f"SELECT id FROM public.students WHERE id='{f['student']}' FOR UPDATE;");ready(first)
        second=start('clear_waits_profile',clear_call(f),hold=False)
        lock=wait_blocked(first,second)
        assert sql(f"SELECT count(*) FROM pg_locks l JOIN pg_stat_activity a USING(pid) WHERE a.application_name='{second['name']}' AND l.locktype='advisory' AND l.mode='ExclusiveLock' AND l.granted;")=='1'
        # Resume the real public profile RPC in the student-owning transaction.
        # If clear adds studio FOR UPDATE, its late audit FK forms a deadlock here.
        first['process'].stdin.write(f"""SELECT (public.write_student_profile_atomic(
'{f['student']}','{f['studio']}','{f['actor']}',
'{{"notes":"Profile audit completed while clear waited"}}'::jsonb,
NULL::uuid[],'[]'::jsonb,false,'student.updated')).id;
SELECT 'RESULT_READY'; COMMIT;
""")
        first['process'].stdin.close();ready(first);finish(first);ready(second);finish(second)
        observed=json.loads(sql(f"SELECT jsonb_build_object('students',(SELECT count(*) FROM public.students WHERE id='{f['student']}'),'audits',(SELECT count(*) FROM public.audit_logs WHERE entity_id='{f['student']}' AND action='student.updated' AND actor_id='{f['actor']}' AND metadata->>'notes'='Profile audit completed while clear waited'));"))
        assert observed=={'students':0,'audits':1},observed
        results.append({'case':'real_profile_late_audit_completes_with_clear_advisory','lock':lock,'facts':observed})

        f=plan_fixture('program-delete-first')
        first=start('program_delete_owner',f"DELETE FROM public.programs WHERE id='{f['program']}';");ready(first)
        second=start('plan_deleted_program',plan_missing(plan_call(f,{'amount_cents':1400},[f['program']]),'billing_plan_program_not_found'),hold=False)
        lock=wait_blocked(first,second)
        release(first);ready(second);finish(second)
        assert 'EXPECTED_PLAN_REJECTION' in second['lines']
        observed=plan_state(f)
        assert observed=={'plan':[1000,None,None,'active',False,None],'links':[],'audits':0},observed
        results.append({'case':'program_delete_before_plan_rolls_back_command','lock':lock,'facts':observed})

        f=plan_fixture('plan-before-program-delete')
        first=start('plan_program_owner','SELECT '+plan_call(f,{'description':'Before program deletion'},[f['replacement']])+';');ready(first)
        second=start('program_delete_waiter',f"DELETE FROM public.programs WHERE id='{f['replacement']}';",hold=False)
        lock=wait_blocked(first,second)
        release(first);ready(second);finish(second)
        observed=plan_state(f)
        assert observed=={'plan':[1000,'Before program deletion',None,'pending',False,None],'links':[],'audits':1},observed
        assert plan_result(first)['programs']==[{'program_id':f['replacement'],'program_name':'Replacement program','program_color_hex':'#445566'}]
        results.append({'case':'plan_snapshot_before_program_delete','lock':lock,'facts':observed})

        # Lock-level parent-order proof. The lock matches DELETE's studio row mode,
        # but no actual studio deletion is claimed: staff orphan triggers are separate.
        f=plan_fixture('parent-order')
        first=start('studio_parent_owner',f"SELECT id FROM public.studios WHERE id='{f['studio']}' FOR UPDATE;");ready(first)
        second=start('plan_waits_parent','SELECT '+plan_call(f,{'description':'After parent release'})+';',hold=False)
        lock=wait_blocked(first,second)
        probe=start('parent_order_plan_probe',f"SELECT id FROM public.billing_plans WHERE id='{f['plan']}' FOR UPDATE NOWAIT;")
        ready(probe);release(probe)
        release(first,commit=False);ready(second);finish(second)
        observed=plan_state(f)
        assert observed=={'plan':[1000,'After parent release',None,'pending',False,None],'links':[f['program']],'audits':1},observed
        results.append({'case':'plan_waits_parent_before_locking_plan','lock':lock,'facts':observed})
        for mode in [
            "own_commit",
            "own_rollback",
            "unrelated_commit",
            "unrelated_rollback",
            "completion",
            "completion_next_key",
            "completion_next_actor",
            "lease",
        ]:
            fixture = {
                key: str(uuid4())
                for key in ["actor", "studio", "payer", "payment", "lease", "rival", "next_actor"]
            }
            account = "acct_" + uuid4().hex
            seed = f"""BEGIN;
        INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
        VALUES('{fixture["actor"]}','authenticated','authenticated','{fixture["actor"]}@example.invalid','{{}}','{{}}',now(),now());
        INSERT INTO public.studios(id,name,slug,owner_id) VALUES('{fixture["studio"]}','Refund concurrency','{fixture["studio"]}','{fixture["actor"]}');
        INSERT INTO public.staff_roles(studio_id,user_id,role) VALUES('{fixture["studio"]}','{fixture["actor"]}','admin');
        INSERT INTO public.studio_payment_accounts(studio_id,stripe_connected_account_id,charges_enabled,payouts_enabled,metadata)
        VALUES('{fixture["studio"]}','{account}',true,true,'{{"connect_account_generation":1}}');
        INSERT INTO public.billing_payers(id,studio_id,display_name,stripe_account_id,stripe_customer_id,connect_account_generation)
        VALUES('{fixture["payer"]}','{fixture["studio"]}','Refund payer','{account}','cus_proof',1);
        INSERT INTO public.billing_payments(id,studio_id,payer_id,stripe_customer_id,stripe_payment_intent_id,stripe_charge_id,
         stripe_account_id,connect_account_generation,status,amount_cents,currency,net_collected_amount_cents,refundable_amount_cents,processed_at)
        VALUES('{fixture["payment"]}','{fixture["studio"]}','{fixture["payer"]}','cus_proof','pi_proof','ch_proof','{account}',1,'succeeded',1000,'usd',1000,1000,now());
        COMMIT;"""
            sql(seed)
            if mode == "completion_next_actor":
                sql(f"""INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
                    VALUES('{fixture['next_actor']}','authenticated','authenticated',
                    '{fixture['next_actor']}@example.invalid','{{}}','{{}}',now(),now());
                    INSERT INTO public.staff_roles(studio_id,user_id,role)
                    VALUES('{fixture['studio']}','{fixture['next_actor']}','admin');""")

            def refund_claim(lease, key="refund-concurrent", actor=fixture["actor"]):
                return f"""SELECT public.claim_billing_provider_operation_resource_v1(
                    '{fixture['studio']}','{actor}','payment.refund','payment',
                    '{fixture['payment']}','{fixture['payer']}','{key}',repeat('a',64),
                    '{account}',1,'{lease}',30);"""

            claim = json.loads(sql(refund_claim(fixture["lease"])))
            operation = claim["operation"]
            resource_version = sql(
                f"SELECT resource_version_sha256 FROM public.billing_provider_operation_resources WHERE id='{claim['resource']['id']}';"
            )

            def transition(state):
                provider_id = "NULL" if state == "provider_request_in_flight" else "'re_proof'"
                result_code = {
                    "provider_request_in_flight": "payment_refund_started",
                    "provider_succeeded": "payment_refund_status_succeeded",
                    "projected": "payment_refund_projected",
                }[state]
                return f"""SELECT public.transition_billing_provider_operation_v1(
                    '{operation['id']}','{fixture['studio']}','{fixture['actor']}','payment.refund',
                    'refund-concurrent',repeat('a',64),'{account}',1,'{fixture['lease']}',
                    {operation['revision']},'{state}',p_provider_object_id=>{provider_id},
                    p_result_code=>'{result_code}',p_result_summary=>'amount_cents:500');"""

            for state in ["provider_request_in_flight", "provider_succeeded"]:
                operation = json.loads(sql(transition(state)))["operation"]

            def project(refund_id, amount):
                return f"""INSERT INTO public.billing_refunds(studio_id,payment_id,stripe_refund_id,
                    stripe_charge_id,stripe_payment_intent_id,stripe_account_id,
                    connect_account_generation,amount_cents,status)
                    VALUES('{fixture['studio']}','{fixture['payment']}','{refund_id}',
                    'ch_proof','pi_proof','{account}',1,{amount},'succeeded');"""

            if mode.startswith(("unrelated", "completion")) or mode == "lease":
                sql(project("re_proof", 500))
                operation = json.loads(sql(transition("projected")))["operation"]

            def complete(lease, revision):
                return f"""SELECT public.complete_billing_provider_operation_v1(
                    '{operation['id']}','{fixture['studio']}','{fixture['actor']}','payment.refund',
                    'refund-concurrent',repeat('a',64),'{account}',1,'{lease}',{revision},
                    'payment_refund_completed');"""

            if mode.startswith("completion"):
                holder = start(
                    "refund_complete", complete(fixture["lease"], operation["revision"])
                )
            elif mode == "lease":
                sql(
                    f"UPDATE public.billing_provider_operations SET lease_acquired_at=clock_timestamp()-interval '60 seconds',lease_expires_at=clock_timestamp()-interval '30 seconds',revision=revision+1,updated_at=clock_timestamp() WHERE id='{operation['id']}';"
                )
                holder = start("refund_reclaim", refund_claim(fixture["lease"]))
            else:
                holder = start(
                    "refund_projection",
                    project("re_other", 100)
                    if mode.startswith("unrelated")
                    else project("re_proof", 500),
                )
            ready(holder)
            next_refund = mode.startswith("completion_next")
            next_actor = fixture["next_actor"] if mode == "completion_next_actor" else fixture["actor"]
            waiter = start("refund_retry", refund_claim(
                fixture["rival"], key="next-refund" if next_refund else "refund-concurrent", actor=next_actor,
            ), hold=False)
            lock = wait_blocked(holder, waiter)
            released_after = sql("SELECT clock_timestamp();") if next_refund else None
            release(holder, commit=not mode.endswith("rollback"))
            if mode == "unrelated_commit":
                code = waiter["process"].wait(timeout=15)
                for thread in waiter["threads"]:
                    thread.join(timeout=2)
                assert code != 0 and any(
                    line.split() == ["ERROR:", "23505:", "billing_provider_operation_resource_version_conflict"]
                    for line in waiter["errors"]
                ), waiter["errors"]
            else:
                ready(waiter)
                finish(waiter)
                recovered = json.loads(
                    next(line for line in waiter["lines"] if line.startswith("{"))
                )["operation"]
                if next_refund:
                    assert recovered["id"] != operation["id"] and recovered["state"] == "started", recovered
                    assert recovered["actor_id"] == next_actor and recovered["lease_owner"] == fixture["rival"], recovered
                    assert recovered["provider_request_attempt_count"] == 0, recovered
                    assert sql(f"""SELECT lease_acquired_at >= '{released_after}'::timestamptz
                        AND lease_expires_at = lease_acquired_at + interval '30 seconds'
                        FROM public.billing_provider_operations WHERE id='{recovered['id']}';""") == 't', recovered
                    original = json.loads(sql(refund_claim(fixture["lease"])))['operation']
                    assert original['id'] == operation['id'] and original['state'] == 'completed', original
                    assert original['provider_request_attempt_count'] == 1, original
                elif mode == "completion":
                    assert recovered["id"] == operation["id"] and recovered["state"] == "completed", recovered
                    assert recovered["provider_request_attempt_count"] == 1, recovered
                else:
                    assert recovered["id"] == operation["id"] and recovered["provider_request_attempt_count"] == 1, recovered
                    assert recovered["lease_owner"] == fixture["lease"], recovered
                    denied = start(
                        "refund_wrong_lease",
                        complete(fixture["rival"], recovered["revision"]),
                        hold=False,
                    )
                    code = denied["process"].wait(timeout=15)
                    for thread in denied["threads"]:
                        thread.join(timeout=2)
                    # Provider-succeeded receipts cannot complete before projection; projected receipts retain their lease.
                    error = (
                        "billing_provider_operation_invalid_transition"
                        if mode.startswith("own")
                        else "billing_provider_operation_lease_owner_mismatch"
                    )
                    error_state = "23514:" if mode.startswith("own") else "42501:"
                    assert code != 0 and any(
                        line.split() == ["ERROR:", error_state, error]
                        for line in denied["errors"]
                    ), denied["errors"]
            observed_version = sql(
                f"SELECT resource_version_sha256 FROM public.billing_provider_operation_resources WHERE id='{claim['resource']['id']}';"
            )
            if next_refund:
                assert observed_version != resource_version
            else:
                assert observed_version == resource_version
            total = int(
                sql(
                    f"SELECT refunded_amount_cents FROM public.billing_payments WHERE id='{fixture['payment']}';"
                )
            )
            assert total == ({"own_rollback": 0, "unrelated_commit": 600}.get(mode, 500)), (
                mode,
                total,
            )
            results.append(
                {
                    "case": "refund_" + mode,
                    "lock": lock,
                    "refunded_amount_cents": total,
                    "original_resource_version": resource_version,
                }
            )
        def activation_fixture(legacy=False):
            f={name:str(uuid4()) for name in ['actor','studio','payer','plan','group','student','enrollment','existing_student','existing','later_student','later','lease']}
            f['account']='acct_Activation48'+uuid4().hex[:8]
            intent={'version':1 if legacy else 2,'operation_type':'enrollment.activate.invoice',
                'studio_id':f['studio'],'enrollment_id':f['enrollment'],'student_id':f['student'],
                'payer_id':f['payer'],'plan_id':f['plan'],'account_id':f['account'],'generation':1,
                'customer_id':'cus_activation48','product_id':'prod_activation48','price_id':'price_activation48','group_id':f['group']}
            if legacy:
                intent.update(branch='update_quantity',expected_subscription_id='sub_activation48',expected_item_id='si_activation48',expected_quantity=99)
            f['hash']=hashlib.sha256(json.dumps(intent,sort_keys=True,separators=(',',':')).encode()).hexdigest()
            intent['desired_sha256']=f['hash']
            sql(f"""INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
VALUES('{f['actor']}','authenticated','authenticated','activation48-{f['actor']}@example.invalid','{{}}','{{}}',now(),now());
INSERT INTO public.studios(id,name,slug,owner_id)VALUES('{f['studio']}','Activation proof','activation-{f['studio']}','{f['actor']}');
INSERT INTO public.staff_roles(studio_id,user_id,role)VALUES('{f['studio']}','{f['actor']}','admin');
INSERT INTO public.studio_payment_accounts(studio_id,stripe_connected_account_id,status,charges_enabled,payouts_enabled,details_submitted,metadata)
VALUES('{f['studio']}','{f['account']}','charges_enabled',true,true,true,'{{"connect_account_generation":1}}');
INSERT INTO public.billing_payers(id,studio_id,display_name,stripe_account_id,stripe_customer_id,connect_account_generation)
VALUES('{f['payer']}','{f['studio']}','Activation payer','{f['account']}','cus_activation48',1);
INSERT INTO public.billing_plans(id,studio_id,name,amount_cents,currency,billing_interval,status,stripe_account_id,stripe_product_id,stripe_price_id)
VALUES('{f['plan']}','{f['studio']}','Activation plan',5000,'usd','monthly','active','{f['account']}','prod_activation48','price_activation48');
INSERT INTO public.billing_subscriptions(id,studio_id,payer_id,stripe_account_id,stripe_customer_id,stripe_subscription_id,collection_mode,billing_interval,currency,status,metadata)
VALUES('{f['group']}','{f['studio']}','{f['payer']}','{f['account']}','cus_activation48','sub_activation48','invoice_link','monthly','usd','active','{{"connect_account_generation":1}}');
INSERT INTO public.students(id,studio_id,legal_first_name,legal_last_name)VALUES
('{f['student']}','{f['studio']}','Pending','Seat'),('{f['existing_student']}','{f['studio']}','Existing','Seat'),('{f['later_student']}','{f['studio']}','Later','Seat');
INSERT INTO public.student_billing_enrollments(id,studio_id,student_id,payer_id,billing_plan_id,collection_mode,status,metadata)VALUES
('{f['enrollment']}','{f['studio']}','{f['student']}','{f['payer']}','{f['plan']}','invoice_link','pending','{json.dumps({'provider_activation_intent':intent})}'),
('{f['later']}','{f['studio']}','{f['later_student']}','{f['payer']}','{f['plan']}','invoice_link','pending','{{}}');
INSERT INTO public.student_billing_enrollments(id,studio_id,student_id,payer_id,billing_plan_id,collection_mode,status,billing_subscription_id,stripe_subscription_id,stripe_subscription_item_id)
VALUES('{f['existing']}','{f['studio']}','{f['existing_student']}','{f['payer']}','{f['plan']}','invoice_link','active','{f['group']}','sub_activation48','si_activation48');
SELECT public.claim_billing_subscription_quantity_sync('{f['studio']}','{f['group']}','{f['lease']}',120);""")
            claimed=json.loads(sql(f"SELECT public.claim_billing_provider_operation_resource_v1('{f['studio']}','{f['actor']}','enrollment.activate.invoice','enrollment','{f['enrollment']}','{f['payer']}','activation-proof','{f['hash']}','{f['account']}',1,'{f['lease']}',300);"))
            f['operation']=claimed['operation']
            return f
        def begin_activation(f,revision=None,token=None):
            return f"SELECT public.begin_billing_enrollment_activation_v1('{f['operation']['id']}','{f['studio']}','{f['actor']}','enrollment.activate.invoice','activation-proof','{f['hash']}','{f['account']}',1,'{f['lease']}',{revision if revision is not None else f['operation']['revision']},'{f['enrollment']}','{token or f['lease']}','sub_activation48');"
        def activation_facts(f):
            return json.loads(sql(f"SELECT jsonb_build_object('intent',e.metadata->'provider_activation_intent','state',o.state,'attempts',o.provider_request_attempt_count,'revision',o.revision) FROM public.student_billing_enrollments e JOIN public.billing_provider_operations o ON o.id='{f['operation']['id']}' WHERE e.id='{f['enrollment']}';"))
        def activation_denied(statement,error):
            denied=start('activation_denied',statement,hold=False)
            code=denied['process'].wait(timeout=15)
            for thread in denied['threads']:thread.join(timeout=2)
            assert code!=0 and any(error in line for line in denied['errors']),denied['errors']
        for commit in [True,False]:
            f=activation_fixture()
            holder=start('activation_count_owner',f"SELECT id FROM public.billing_subscriptions WHERE id='{f['group']}' FOR UPDATE; UPDATE public.student_billing_enrollments SET status='active',billing_subscription_id='{f['group']}',stripe_subscription_id='sub_activation48',stripe_subscription_item_id='si_activation48' WHERE id='{f['later']}';")
            ready(holder)
            waiter=start('activation_begin',begin_activation(f),hold=False)
            lock=wait_blocked(holder,waiter)
            before=activation_facts(f)
            assert before['attempts']==0 and 'executions' not in before['intent'],before
            release(holder,commit);ready(waiter);finish(waiter)
            result=json.loads(next(line for line in waiter['lines'] if line.startswith('{')))
            expected=3 if commit else 2
            assert result['execution']=={'version':1,'branch':'update_quantity','expected_subscription_id':'sub_activation48','expected_item_id':'si_activation48','expected_quantity':expected},result
            observed=activation_facts(f)
            assert observed['attempts']==1 and observed['state']=='provider_request_in_flight'
            assert observed['intent']['executions'][f['operation']['id']]==result['execution']
            results.append({'case':'activation_count_after_'+('commit' if commit else 'rollback'),'lock':lock,'quantity':expected,'attempts':1})
        f=activation_fixture(legacy=True)
        sql(f"UPDATE public.billing_plans SET currency='USD' WHERE id='{f['plan']}'; UPDATE public.billing_subscriptions SET currency='USD' WHERE id='{f['group']}';")
        before=activation_facts(f)
        activation_denied(begin_activation(f).replace(f['actor'],str(uuid4())),'billing_enrollment_activation_actor_invalid')
        assert activation_facts(f)==before
        activation_denied(begin_activation(f,revision=999),'billing_provider_operation_stale_revision')
        assert activation_facts(f)==before
        activation_denied(begin_activation(f,token=str(uuid4())),'billing_enrollment_activation_attempt_not_owned')
        assert activation_facts(f)==before
        sql(f"UPDATE public.billing_subscriptions SET cancel_at_period_end=true WHERE id='{f['group']}';")
        activation_denied(begin_activation(f),'billing_enrollment_activation_subscription_closed')
        assert activation_facts(f)==before
        sql(f"UPDATE public.billing_subscriptions SET cancel_at_period_end=false WHERE id='{f['group']}';")
        first=start('activation_first_attempt',begin_activation(f));ready(first)
        second=start('activation_second_attempt',begin_activation(f),hold=False)
        lock=wait_blocked(first,second)
        release(first)
        code=second['process'].wait(timeout=15)
        for thread in second['threads']:thread.join(timeout=2)
        assert code!=0 and any('billing_enrollment_activation_attempt_not_owned' in line for line in second['errors']),second['errors']
        observed=activation_facts(f)
        assert observed['intent']['desired_sha256']==before['intent']['desired_sha256']
        assert observed['intent']['expected_quantity']==99 and observed['attempts']==1
        assert observed['intent']['executions'][f['operation']['id']]['expected_quantity']==2
        results.append({'case':'activation_first_attempt_atomic_and_legacy_identity_retained','lock':lock,'attempts':1})
        # An expired group token cannot release an unresolved financial attempt.
        later=dict(f,enrollment=f['later'],student=f['later_student'],lease=str(uuid4()))
        intent=dict(before['intent'],version=2,enrollment_id=later['enrollment'],student_id=later['student'])
        for key in ['branch','expected_subscription_id','expected_item_id','expected_quantity','desired_sha256']:intent.pop(key,None)
        later['hash']=hashlib.sha256(json.dumps(intent,sort_keys=True,separators=(',',':')).encode()).hexdigest()
        intent['desired_sha256']=later['hash']
        sql(f"UPDATE public.student_billing_enrollments SET metadata=jsonb_build_object('provider_activation_intent','{json.dumps(intent)}'::jsonb) WHERE id='{later['enrollment']}'; SELECT public.finish_billing_subscription_quantity_sync('{f['studio']}','{f['group']}','{f['lease']}'); SELECT public.claim_billing_subscription_quantity_sync('{f['studio']}','{f['group']}','{later['lease']}',120);")
        later['operation']=json.loads(sql(f"SELECT public.claim_billing_provider_operation_resource_v1('{later['studio']}','{later['actor']}','enrollment.activate.invoice','enrollment','{later['enrollment']}','{later['payer']}','activation-later','{later['hash']}','{later['account']}',1,'{later['lease']}',300);"))['operation']
        prior=activation_facts(later)
        activation_denied(begin_activation(later).replace("'activation-proof'","'activation-later'"),'billing_enrollment_activation_prior_attempt_unresolved')
        assert activation_facts(later)==prior and activation_facts(f)==observed
        results.append({'case':'activation_unresolved_attempt_blocks_new_quantity','attempts':0})
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
    metadata_path = Path(__file__).resolve().parents[1] / "backend/app/services/generated_release_readiness.py"
    metadata_hash = hashlib.sha256(metadata_path.read_bytes()).hexdigest()
    metadata = runpy.run_path(str(metadata_path))
    rpc = metadata["RELEASE_PREFLIGHT_RPC"]
    require(rpc.startswith("koaryu_release_schema_preflight_v") and rpc.removeprefix("koaryu_release_schema_preflight_v").isdigit(),
            "Invalid generated readiness RPC")
    readiness = json.loads(local.sql("postgres", f"SELECT to_jsonb(r) FROM public.{rpc}() r;"))
    expected = {"ready": True, "migration_count": metadata["EXPECTED_RELEASE_MIGRATION_COUNT"],
                "migration_head": metadata["EXPECTED_RELEASE_MIGRATION_HEAD"],
                "manifest_version": metadata["EXPECTED_RELEASE_MANIFEST_VERSION"],
                "pending_versions": metadata["EXPECTED_RELEASE_PENDING_VERSIONS"], "security_failures": []}
    require(readiness == expected, "Payment concurrency requires the exact current candidate readiness")
    database = f"koaryu_billing_command_concurrency_{os.getpid()}"
    owned = False
    try:
        local.run([createdb, *local.connection, "--owner=postgres", "--template=postgres", database])
        owned = True
        cases = run_cases(local, database)
        require(hashlib.sha256(Path(__file__).read_bytes()).hexdigest() == source_hash
                and hashlib.sha256(shared_path.read_bytes()).hexdigest() == shared_hash
                and hashlib.sha256(metadata_path.read_bytes()).hexdigest() == metadata_hash,
                "Billing concurrency inputs changed during verification")
        (local.temporary / "billing-command-concurrency-evidence.json").write_text(json.dumps({
            "script_sha256": source_hash, "local_tools_sha256": shared_hash, "readiness_metadata_sha256": metadata_hash,
            "readiness": readiness, "cases": cases,
        }, indent=2) + "\n")
        for case in cases:
            print("[billing concurrency] PASS " + case["case"] + ": observed locks and persisted outcome", flush=True)
    finally:
        if owned:
            local.sql("postgres", f"DROP DATABASE {database} WITH (FORCE);")


if __name__ == "__main__":
    def interrupted(signum, _frame):
        raise SystemExit(128 + signum)
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    main(sys.argv[1:])
