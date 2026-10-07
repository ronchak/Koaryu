#!/usr/bin/env python3
"""One guarded local PG17 clone: graph mail SQL, SDK and synthetic Graph proof."""
import hashlib
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path
from uuid import uuid4
sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from local_postgres_verification import LocalPostgres, require, install_final_v57
ROOT = Path(__file__).resolve().parents[1]
BASE = '35561d6b8f851ea0309723637e0996a064ba4c82'
BASE_HASH = 'cab98ab987acf0c24a383be94f3e0499c6d891b922d7fd1de217e788c2a339b5'
MIGRATION = ROOT / 'supabase/migrations/20261005105341_automation_workflow_graph_v57.sql'
CONTRACT = ROOT / 'supabase/verification/workflow_graph_mail_contract.sql'
MARKER = '\n-- Graph mail uses the common real-attempt owner.'
CHILDREN = []
INVENTORY = """SELECT jsonb_object_agg(p.oid::regprocedure::text,jsonb_build_object(
'definition',pg_get_functiondef(p.oid),'acl',p.proacl::text,'owner',pg_get_userbyid(p.proowner),
'settings',p.proconfig,'volatility',p.provolatile,'security_definer',p.prosecdef))
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname IN ('public','private') AND p.prokind='f';"""
def quote(value):
    if value is None: return 'NULL'
    if isinstance(value,(dict,list)): value=json.dumps(value,separators=(',',':'))
    return "'"+str(value).replace("'","''")+"'"
def main(args):
    require(len(args)==5,'Expected psql socket port unique-owned-clone new-private-evidence-file')
    psql,socket,port,database,output=args
    require(re.fullmatch(r'koaryu_graph_mail_[a-z0-9_]+',database),'Unsafe owned clone name')
    evidence=Path(output)
    require(evidence.is_absolute() and not os.path.lexists(evidence),'Evidence must be a new absolute path')
    local=LocalPostgres(psql,socket,port,str(Path(socket).parent))
    pid_path=Path(socket).parent/'data/postmaster.pid'
    pid=pid_path.read_text().splitlines()[0]
    baseline=local.sql('postgres','SELECT row_to_json(p) FROM public.koaryu_release_schema_preflight_v37() p;')
    b=json.loads(baseline)
    require(b['ready'] and b['migration_count']==151 and b['migration_head']=='20261004220435' and b['manifest_version']=='release-db-attestation-v56','Strict V56 template required')
    require(local.sql('postgres',f'SELECT NOT EXISTS(SELECT 1 FROM pg_database WHERE datname={quote(database)});')=='t','Foreign clone refused')
    src=MIGRATION.read_bytes(); text=src.decode()
    accepted = subprocess.check_output(['git','-C',str(ROOT),'show',BASE+':'+str(MIGRATION.relative_to(ROOT))],env=local.env)
    require(hashlib.sha256(accepted).hexdigest() == BASE_HASH, 'Accepted complete execution SQL pin differs')
    historical={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in MIGRATION.parent.glob('*.sql') if p!=MIGRATION}
    require(len(historical)==151,'Expected151 historical files')
    cases=[]; owned=False; start=time.monotonic(); diagnostics=[]
    def sql(s): return local.sql(database,"SET TIME ZONE 'UTC';\n"+s)
    def value(s): return json.loads(sql(s))
    def passed(name,**details):
        cases.append({'case':name,'outcome':'passed',**details}); print('[graph mail] PASS '+name,flush=True)
    try:
        local.sql('postgres',f'CREATE DATABASE {database} TEMPLATE postgres;'); owned=True
        readiness = install_final_v57(local, database, ROOT)
        installed = value(INVENTORY)
        passed('complete final catalog body security ACL overload and genuine history', readiness=readiness)
        contract=sql(CONTRACT.read_text()); passed('focused SQL contract',output=contract)
        # Reuse the accepted comprehensive fixture bytes, with a private proof schema.
        fixtures=(ROOT/'supabase/verification/workflow_advance_contract.sql').read_text().split('-- fixture owners start.')[1].split('-- fixture owners end.')[0]
        sql('CREATE SCHEMA graph_mail_proof;\n'+'--'+fixtures.replace('pg_temp.','graph_mail_proof.')+'\nGRANT USAGE ON SCHEMA graph_mail_proof TO service_role; GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA graph_mail_proof TO service_role;')
        run_proof(local,sql,value,passed,database,psql)
        sql('DROP SCHEMA graph_mail_proof CASCADE;')
        require(value(INVENTORY)==installed,'Proof failed exact owner restoration')
        passed('temporary owners restored exactly')
    except Exception as exc:
        diagnostics.append({'type':type(exc).__name__,'message':str(exc)}); raise
    finally:
        for child in CHILDREN:
            process=child['process']
            if process.poll() is None:
                process.terminate()
                try:process.wait(timeout=5)
                except subprocess.TimeoutExpired:process.kill();process.wait(timeout=5)
        if owned:
            local.sql('postgres',f'DROP DATABASE {database} WITH (FORCE);'); owned=False
        require(pid_path.read_text().splitlines()[0]==pid,'Template postmaster changed')
        require(local.sql('postgres','SELECT row_to_json(p) FROM public.koaryu_release_schema_preflight_v37() p;')==baseline,'Template state changed')
        require(MIGRATION.read_bytes()==src,'Source changed during proof')
        require(historical=={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in MIGRATION.parent.glob('*.sql') if p!=MIGRATION},'Historical files changed')
        report={'base':BASE,'source_sha256':hashlib.sha256(src).hexdigest(),'contract_sha256':hashlib.sha256(CONTRACT.read_bytes()).hexdigest(),'verifier_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'cases':cases,'diagnostics':diagnostics,'elapsed_seconds':round(time.monotonic()-start,3),'cleanup':{'clone_absent':True,'template_unchanged':True,'postmaster_pid':pid}}
        with evidence.open('x') as out: os.chmod(evidence,0o600); json.dump(report,out,indent=2); out.write('\n')

def run_proof(local,sql,value,passed,database,psql):
    def no_dotenv(event,args):
        if event=='open' and isinstance(args[0],(str,bytes)):
            require(not Path(str(args[0])).name.startswith('.env'),'Dotenv read forbidden')
    sys.addaudithook(no_dotenv)
    sys.path.insert(0,str(ROOT/'backend'))
    import httpx
    from cryptography.fernet import Fernet
    from types import SimpleNamespace
    from datetime import datetime,timezone
    from postgrest import SyncPostgrestClient
    from postgrest.utils import SyncClient
    from importlib.metadata import version
    from app.schemas import workflow_dispatch as dto
    from app.services.workflow_email import render_workflow_email
    from app.services.workflow_simulation_service import _decode_facts
    from app.services.automation_email import delivery_configuration,sender_identity_binding,EmailMessage
    from app.services.automation_email_credentials import CredentialCodec,CredentialState,CredentialRepository
    from app.services.microsoft_graph_email import MicrosoftGraphEmailTransport
    from app.services.workflow_dispatcher import _ClaimConsumer
    from app.services.automation_service import _WorkerBudget,_require_dispatch_schema,_dispatch_rpc
    require(version('postgrest')=='0.17.2','Pinned SDK required')
    sql('''CREATE FUNCTION graph_mail_proof.rpc(statement TEXT) RETURNS JSONB LANGUAGE plpgsql AS $$
    DECLARE got JSONB; code TEXT; message TEXT;
    BEGIN BEGIN EXECUTE statement INTO got; RETURN jsonb_build_object('ok',true,'data',got);
    EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS code=RETURNED_SQLSTATE,message=MESSAGE_TEXT; RETURN jsonb_build_object('ok',false,'error',jsonb_build_object('code',code,'message',message,'details',NULL,'hint',NULL)); END; END $$;
    GRANT EXECUTE ON FUNCTION graph_mail_proof.rpc(TEXT) TO service_role;''')
    requests=[]
    class SQLClient(SyncPostgrestClient):
        def create_session(self,base_url,headers,timeout,verify=True,proxy=None):
            def handler(request):
                name=request.url.path.rsplit('/',1)[-1]
                require(request.method=='POST' and re.fullmatch('[a-z_0-9]+',name),'Unexpected SDK operation')
                params=json.loads(request.content)
                statement='SELECT public.'+name+'('+','.join(k+'=>'+('ARRAY['+','.join(map(quote,v))+']::TEXT[]' if isinstance(v,list) else quote(v)) for k,v in params.items())+');'
                if name=='koaryu_release_schema_preflight_v38':
                    require(params=={},'Readiness takes no parameters')
                    statement='SELECT jsonb_agg(to_jsonb(r)) FROM public.koaryu_release_schema_preflight_v38() r;'
                observed=value('SET ROLE service_role; SELECT graph_mail_proof.rpc('+quote(statement)+');')
                requests.append({'rpc':name,'ok':observed['ok']})
                return httpx.Response(200 if observed['ok'] else 400,json=observed.get('data',observed.get('error')))
            return SyncClient(base_url=base_url,headers=headers,timeout=timeout,trust_env=False,follow_redirects=False,transport=httpx.MockTransport(handler))
    settings=SimpleNamespace(EMAIL_PROVIDER='microsoft_graph',EMAIL_SEND_ENABLED=True,EMAIL_FROM_ADDRESS='sender@example.invalid',EMAIL_FROM_NAME='Koaryu',EMAIL_REPLY_TO='reply@example.invalid',EMAIL_ALLOWED_RECIPIENTS='',EMAIL_GRAPH_CLIENT_ID='b31866c9-dfc5-47a7-9889-bb2c98359911',EMAIL_GRAPH_CLIENT_SECRET='synthetic-only',EMAIL_GRAPH_TENANT='consumers',EMAIL_TOKEN_ENCRYPTION_KEY=Fernet.generate_key().decode(),AUTOMATION_PUBLIC_API_URL='https://mail.example.invalid/api/v1',AUTOMATION_WORKER_ENABLED=True)
    binding=sender_identity_binding(delivery_configuration(settings))
    def fixture(kind='lead.stage_changed',policy=None,graph=None):
        config={'recipient':policy or 'lead_or_guardian','subject_template':'Hi {{recipient_name}}','body_template':'From {{studio_name}}','reply_to_email':''}
        expr=quote(graph) if graph else 'graph_mail_proof.advance_path('+quote(kind)+",'email',"+(quote(config) if policy else 'NULL')+')'
        x=value('SELECT graph_mail_proof.advance_seed(graph_mail_proof.advance_fixture(),'+quote(kind)+','+expr+');')
        x=value('SELECT graph_mail_proof.advance_claim('+quote(x)+');')
        if kind=='lead.created': sql('UPDATE public.leads SET email='+quote('lead.'+x['lead']+'@example.invalid')+' WHERE id='+quote(x['lead'])+';')
        if kind=='student.enrolled': sql('UPDATE public.students SET email='+quote('student.'+x['student']+'@example.invalid')+' WHERE id='+quote(x['student'])+';')
        got=value('SELECT graph_mail_proof.advance_call('+quote(x)+');')['payload']
        require(got['outcome']=='email','Expected actual reached email '+kind)
        return x
    def scope(x): return dict(p_studio_id=x['studio'],p_run_id=x['run'],p_claim_token=x['token'],p_node_id='work',p_allowed_recipients=[],p_default_reply_to=settings.EMAIL_REPLY_TO,p_public_api_url=settings.AUTOMATION_PUBLIC_API_URL)
    def planned(x,token=None):
        token=token or hashlib.sha256(('synthetic-'+x['run']).encode()).hexdigest()
        return _dispatch_rpc(client,'get_workflow_email_plan_v1',dto.PlanRequest(**scope(x),p_candidate_unsubscribe_token=token),dto.Planned)
    def rendered(plan):
        facts=_decode_facts(plan.facts,plan.event_type,frozenset({plan.recipient_policy}))
        content=render_workflow_email(plan.event_type,plan.subject_template,plan.body_template,{**facts.template_facts,**facts.recipients[plan.recipient_policy].template_facts},unsubscribe_url=plan.unsubscribe_url)
        return dto.Rendered(subject=content.subject,text_body=content.text_body,html_body=content.html_body)
    def prep():
        c=_dispatch_rpc(client,'claim_automation_sender_preparation_v1',dto.PreparationClaimRequest(p_provider_key='microsoft_graph:primary',p_preparation_id=uuid4(),p_sender_binding=binding),dto.PreparationClaim)
        require(c.allowed,'Preparation denied')
        p=_dispatch_rpc(client,'settle_automation_sender_preparation_v1',dto.PreparationSettleRequest(p_preparation_id=c.preparation_id,p_preparation_token=c.preparation_token,p_result=dto.PreparationResult(outcome='prepared',credential_revision=1,sender_binding=binding,safe_reason=None,retry_after_seconds=None)),dto.PreparationSettled)
        require(p.outcome=='prepared','Prepare settle refused'); return p
    def begin(x,plan,p=None):
        p=p or prep()
        return _dispatch_rpc(client,'begin_workflow_email_v1',dto.BeginRequest(**scope(x),p_plan_fingerprint=plan.fingerprint,p_unsubscribe_token=plan.unsubscribe_token,p_rendered=rendered(plan),p_preparation_id=p.preparation_id,p_preparation_token=p.preparation_token,p_probe_token=p.probe_token),dto.Begun)
    def delivery(outcome='accepted',error=None,retry=None,scope_name=None,evidence=None):
        return dto.Delivery(outcome=outcome,error_code=error,provider_request_id='synthetic-proof',retry_after_seconds=retry,submission_evidence=evidence or ('accepted' if outcome=='accepted' else 'unknown' if outcome=='unknown' else 'rejected'),failure_scope=scope_name,credential_revision=1)
    def settle(x,a,result):
        params=dto.SettleRequest(p_studio_id=x['studio'],p_attempt_id=a.id,p_claim_token=x['token'],p_result=result)
        raw=client.rpc('settle_workflow_email_v1',params.model_dump(mode='json')).execute().data
        try: return dto.Envelope[dto.Settled].model_validate(raw).payload
        except Exception as exc: raise RuntimeError('Settlement DTO '+str(exc.errors(include_input=False))) from None
    def rows():
        return value("SELECT jsonb_object_agg(n.nspname||'.'||c.relname,jsonb_build_object('inserts',s.n_tup_ins,'updates',s.n_tup_upd,'deletes',s.n_tup_del)) FROM pg_stat_user_tables s JOIN pg_class c ON c.oid=s.relid JOIN pg_namespace n ON n.oid=c.relnamespace;")
    with SQLClient('http://graph-mail-proof.invalid') as client:
        codec=CredentialCodec(settings.EMAIL_TOKEN_ENCRYPTION_KEY,settings.EMAIL_GRAPH_CLIENT_ID,settings.EMAIL_FROM_ADDRESS)
        CredentialRepository(client,codec).save(CredentialState(settings.EMAIL_GRAPH_CLIENT_ID,settings.EMAIL_FROM_ADDRESS,'synthetic-refresh','synthetic-access',time.time()+3600),0)
        for kind in ('lead.created','lead.stage_changed','trial.scheduled','trial.completed','trial.no_show','trial.upcoming','student.enrolled','student.promoted','belt_test.approved','belt_test.upcoming','invoice.payment_failed','invoice.overdue'):
            x=fixture(kind); p=planned(x)
            require(p.outcome=='planned' and p.plan.disposition=='send','Current family plan '+kind)
            rendered(p.plan)
        passed('all12 current source families through installed SDK and real renderer')
        x=fixture(); plan=planned(x).plan; before=rows(); require(planned(x).plan==plan and rows()==before,'Read-only plan wrote state')
        fresh=begin(x,plan); require(fresh.outcome=='begun' and fresh.attempt.attempt_number==1,'Fresh begin failed')
        replay=begin(x,plan); require(replay.outcome=='already_begun' and replay.attempt is None,'Duplicate grant')
        result=delivery(); got=settle(x,fresh.attempt,result); require(got.updated and got.state=='accepted' and got.run.state=='queued','Accepted continuation failed')
        again=settle(x,fresh.attempt,result); require(again.replayed and again.state=='accepted','Terminal replay failed')
        passed('real renderer bytes atomic begin at-most-once and terminal settlement replay')
        x=fixture(); plan=planned(x).plan
        sql('UPDATE public.leads SET email='+quote('changed.'+x['lead']+'@example.invalid')+' WHERE id='+quote(x['lead'])+';')
        require(begin(x,plan).outcome=='stale_plan','Stale contact granted')
        plan=planned(x).plan; preparation=prep(); fresh=begin(x,plan,preparation); got=settle(x,fresh.attempt,delivery('unknown','provider_submission_unknown',scope_name='unclassified'))
        require(got.run.state=='unknown' and got.state=='unknown','Unknown became executable')
        require(begin(x,plan,preparation).outcome=='already_begun','Unknown old-token replay')
        passed('current contact stale plan and unknown retain charge without resend')
        # Reset only disposable common provider mode between independent proof cases.
        sql("UPDATE private.automation_sender_gate SET mode='ready',reason=NULL,next_probe_at=NULL,active_preparation_id=NULL,active_probe_token=NULL,active_attempt_id=NULL,probe_expires_at=NULL;")
        x=fixture(); p=planned(x).plan; b=begin(x,p)
        sql('SELECT private.workflow_cancel_runs_v1('+quote(x['studio'])+',ARRAY['+quote(x['run'])+']::UUID[],clock_timestamp(),\'explicit_cancel\');')
        sql('BEGIN; SELECT pg_advisory_xact_lock(hashtextextended(\'koaryu.local-plan-clear:\'||'+quote(x['studio'])+',0)); DELETE FROM private.workflow_email_attempt_payloads WHERE run_id='+quote(x['run'])+'; DELETE FROM private.workflow_email_unsubscribe_pins WHERE run_id='+quote(x['run'])+'; COMMIT;')
        got=settle(x,b.attempt,delivery()); require(got.updated and got.state=='accepted' and got.run.state=='cancelled','Purged callback failed')
        require(settle(x,b.attempt,delivery()).replayed,'Purged replay failed')
        passed('sending cancellation payload purge accepted callback and replay body-free')
        def reset_gate():
            sql("UPDATE private.automation_sender_gate SET mode='ready',reason=NULL,next_probe_at=NULL,active_preparation_id=NULL,active_probe_token=NULL,active_attempt_id=NULL,probe_expires_at=NULL;")
        # Actual transport setup stop after begin is affirmative no-submission.
        from app.services.automation_service import _delivery_result
        x=fixture(); original_pin=planned(x).plan.unsubscribe_token
        for ordinal in (1,2,3):
            p=planned(x).plan; require(p.unsubscribe_token==original_pin,'Retry repinned token')
            b=begin(x,p); require(b.outcome=='begun' and b.attempt.attempt_number==ordinal,'Actual ordinal differs')
            handle=MicrosoftGraphEmailTransport(settings,client).prepare(deadline=time.monotonic()+20)
            settings.EMAIL_SEND_ENABLED=False
            result=MicrosoftGraphEmailTransport(settings,client).send_prepared(EmailMessage(**b.attempt.message.model_dump(mode='json')),handle,deadline=time.monotonic()+20)
            settings.EMAIL_SEND_ENABLED=True
            require((result.outcome,result.submission_evidence,result.failure_scope)==('permanent_failure','not_submitted','sender_transient'),'Actual setup transport tuple changed')
            got=settle(x,b.attempt,_delivery_result(result,expected_revision=1))
            if ordinal<3:
                require(got.state=='failed' and got.run.state=='waiting','Safe setup failure prematurely stopped run')
                delay=value('SELECT extract(epoch FROM r.next_due_at-a.settled_at)::INTEGER FROM public.automation_workflow_runs r JOIN private.automation_email_attempt_reservations a ON a.scope_id=r.id WHERE a.id='+quote(str(b.attempt.id))+';')
                require(delay==60*(2**(ordinal-1)),'Actual retry delay differs')
                reset_gate(); x=value('SELECT graph_mail_proof.advance_claim('+quote(x)+');'); value('SELECT graph_mail_proof.advance_call('+quote(x)+');')
            else:
                require(got.run.state=='queued' and got.run.current_node_id=='end','Third failure lost internal continuation')
        passed('three actual ordinals original token permanent not-submitted transient transport60/120 retry and exhaustion')
        reset_gate()
        # Begin freezes newly added mail parents. Holders are real PG sessions;
        # reverse schedules fail NOWAIT before any common write.
        import queue,threading
        def session(statement,hold=True,role='postgres'):
            name='graph_mail_'+str(os.getpid())+'_'+str(len(CHILDREN))
            process=subprocess.Popen([psql,*local.connection,'--dbname='+database,'--no-psqlrc','--quiet','--tuples-only','--no-align','--set=ON_ERROR_STOP=1'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,bufsize=1,env=local.env)
            item={'process':process,'name':name,'lines':[],'errors':[],'events':queue.Queue()}; CHILDREN.append(item)
            def drain(stream,target,events=None):
                for line in stream:
                    target.append(line.rstrip())
                    if events is not None: events.put(line.rstrip())
            item['threads']=[threading.Thread(target=drain,args=(process.stdout,item['lines'],item['events']),daemon=True),threading.Thread(target=drain,args=(process.stderr,item['errors']),daemon=True)]
            for t in item['threads']:t.start()
            process.stdin.write('SET application_name='+quote(name)+"; BEGIN; SET LOCAL statement_timeout='20s'; SET LOCAL ROLE "+role+';\n'+statement+'\n')
            if hold:process.stdin.write("SELECT 'RESULT_READY';\n");process.stdin.flush()
            else:process.stdin.write('COMMIT;\n');process.stdin.close()
            return item
        def ready(item):
            end=time.monotonic()+10
            while time.monotonic()<end:
                try:
                    if item['events'].get(timeout=.05)=='RESULT_READY':return
                except queue.Empty:require(item['process'].poll() is None,'Holder failed '+str(item['errors']))
            raise RuntimeError('Holder barrier timeout')
        def finished(item):
            code=item['process'].wait(timeout=25)
            for t in item['threads']:t.join(timeout=2)
            require(code==0,'Session failed '+str(item['errors']))
            results=[json.loads(line) for line in item['lines'] if line.startswith('{')]
            return results[-1] if results else None
        def release(item,rollback=False):
            item['process'].stdin.write('ROLLBACK;\n' if rollback else 'COMMIT;\n');item['process'].stdin.close();return finished(item)
        def blocked(holder,waiter):
            end=time.monotonic()+8
            while time.monotonic()<end:
                require(waiter['process'].poll() is None,'Waiter exited early')
                if sql('SELECT EXISTS(SELECT 1 FROM pg_stat_activity h JOIN pg_stat_activity w ON h.pid=ANY(pg_blocking_pids(w.pid)) WHERE h.application_name='+quote(holder['name'])+' AND w.application_name='+quote(waiter['name'])+');')=='t':return
                time.sleep(.025)
            raise RuntimeError('Missing observed blocking relation')
        def begin_statement(x,p,preparation):
            req=dto.BeginRequest(**scope(x),p_plan_fingerprint=p.fingerprint,p_unsubscribe_token=p.unsubscribe_token,p_rendered=rendered(p),p_preparation_id=preparation.preparation_id,p_preparation_token=preparation.preparation_token,p_probe_token=preparation.probe_token).model_dump(mode='json')
            return 'SELECT public.begin_workflow_email_v1('+','.join(k+'=>'+('ARRAY[]::TEXT[]' if isinstance(v,list) else quote(v)) for k,v in req.items())+');'
        for rollback in (False,True):
            x=fixture(policy='assigned_staff'); p=planned(x).plan; preparation=prep()
            holder=session(begin_statement(x,p,preparation),role='service_role');ready(holder)
            writer=session('UPDATE auth.users SET email='+quote('changed.'+x['staff']+'@example.invalid')+' WHERE id='+quote(x['staff'])+';',False)
            blocked(holder,writer); result=release(holder,rollback);finished(writer)
            if not rollback:
                grant=dto.Envelope[dto.Begun].model_validate(result).payload;settle(x,grant.attempt,delivery())
            else:require(sql('SELECT count(*) FROM private.automation_email_attempt_reservations WHERE scope_id='+quote(x['run'])+';')=='0','Rollback retained begin')
            passed('assigned-staff begin owns Auth email writer '+('rollback' if rollback else 'commit'))
        x=fixture(policy='assigned_staff'); p=planned(x).plan; preparation=prep()
        holder=session('UPDATE auth.users SET email=email WHERE id='+quote(x['staff'])+';');ready(holder)
        reply=value('SET ROLE service_role; SELECT graph_mail_proof.rpc('+quote(begin_statement(x,p,preparation))+');')
        require(not reply['ok'] and reply['error']['message']=='AUTOMATION_STUDIO_BUSY','Reverse Auth race did not fail closed');release(holder)
        require(sql('SELECT count(*) FROM private.automation_email_attempt_reservations WHERE scope_id='+quote(x['run'])+';')=='0','Busy Auth retained attempt')
        passed('Auth-first begin NOWAIT rollback with no gate or attempt mutation')
        # Missing role/profile insertion is excluded by Auth UPDATE against FK KEY SHARE.
        x=fixture(policy='assigned_staff'); sql('DELETE FROM public.staff_profiles WHERE user_id='+quote(x['staff'])+';')
        p=planned(x).plan; preparation=prep(); holder=session(begin_statement(x,p,preparation),role='service_role');ready(holder)
        writer=session('INSERT INTO public.staff_profiles(user_id,legal_first_name,legal_last_name) VALUES('+quote(x['staff'])+",'Fresh','Profile');",False);blocked(holder,writer)
        result=release(holder);finished(writer);settle(x,dto.Envelope[dto.Begun].model_validate(result).payload.attempt,delivery())
        passed('Auth UPDATE excludes absent staff profile insertion')
        x=fixture('student.enrolled'); g=str(uuid4())
        sql('UPDATE public.students SET is_minor=true WHERE id='+quote(x['student'])+'; INSERT INTO public.guardians(id,studio_id,first_name,last_name,email,is_primary_contact) VALUES('+','.join(map(quote,[g,x['studio'],'Guardian','Person','guardian.'+g+'@example.invalid']))+',true); INSERT INTO public.student_guardians(student_id,guardian_id) VALUES('+quote(x['student'])+','+quote(g)+');')
        p=planned(x).plan; require(p.recipient_kind=='guardian','Guardian fixture routing'); preparation=prep()
        holder=session(begin_statement(x,p,preparation),role='service_role');ready(holder)
        writer=session('UPDATE public.guardians SET email='+quote('changed.'+g+'@example.invalid')+' WHERE id='+quote(g)+';',False);blocked(holder,writer)
        result=release(holder);finished(writer);settle(x,dto.Envelope[dto.Begun].model_validate(result).payload.attempt,delivery())
        passed('guardian contact locked through atomic begin')
        # Current contact changes before begin skip the retry rather than repin it.
        reset_gate();x=fixture(); p=planned(x).plan;b=begin(x,p);settle(x,b.attempt,delivery('retryable_failure','provider_unavailable',scope_name='sender_transient'))
        reset_gate();x=value('SELECT graph_mail_proof.advance_claim('+quote(x)+');');value('SELECT graph_mail_proof.advance_call('+quote(x)+');')
        sql('UPDATE public.leads SET email='+quote('retry.changed.'+x['lead']+'@example.invalid')+' WHERE id='+quote(x['lead'])+';')
        p2=planned(x).plan;require(p2.disposition=='skip' and p2.reason=='contact_changed' and p2.unsubscribe_token==p.unsubscribe_token,'Retry retargeted contact/token')
        got=begin(x,p2);require(got.outcome=='skipped' and got.run.state=='queued','Contact-changed skip failed')
        passed('retry uses original mailbox/token and skips changed contact')
        reset_gate();x=fixture();p=planned(x).plan;b=begin(x,p)
        expiry_at=b.attempt.lease_expires_at.timestamp()
        # A real60-second lease expires through the retained claim hook. While it
        # runs, a cancellation lock must refuse the whole expiry/claim transaction.
        holder=session('SELECT 1 FROM public.automation_workflow_runs WHERE id='+quote(x['run'])+' FOR UPDATE;');ready(holder)
        while time.time()<=expiry_at+.05: time.sleep(min(.25,max(.01,expiry_at+.05-time.time())))
        before=value('SELECT row_to_json(a) FROM private.automation_email_attempt_reservations a WHERE id='+quote(str(b.attempt.id))+';')
        reply=value("SET ROLE service_role; SELECT graph_mail_proof.rpc('SELECT public.claim_automation_workflow_runs_v1(1);');")
        require(not reply['ok'] and reply['error']['message']=='AUTOMATION_STUDIO_BUSY','Expiry busy did not refuse whole claim')
        require(value('SELECT row_to_json(a) FROM private.automation_email_attempt_reservations a WHERE id='+quote(str(b.attempt.id))+';')==before,'Busy expiry mutated common truth')
        release(holder)
        got=value('SET ROLE service_role; SELECT public.claim_automation_workflow_runs_v1(1);')
        states=value('SELECT jsonb_build_object(\'common\',a.state,\'frequency\',a.frequency_state,\'run\',r.state,\'step\',s.outcome) FROM private.automation_email_attempt_reservations a JOIN public.automation_workflow_runs r ON r.id=a.scope_id JOIN private.automation_workflow_run_steps s ON s.run_id=r.id AND s.node_id=a.node_id WHERE a.id='+quote(str(b.attempt.id))+';')
        require(states=={'common':'unknown','frequency':'unknown','run':'unknown','step':'unknown'},'Expiry failed atomically '+str(states))
        require(all(c['run_id']!=x['run'] for c in got['payload']['claims']),'Expired sending was reclaimed')
        passed('real60-second expiry before retained cursor whole-call busy rollback and body-free unknown truth')
        reset_gate()

        # The actual dispatcher requires the complete current guard. Its SDK
        # bridge forwards the real preflight rather than fabricating readiness.
        _require_dispatch_schema(client,_WorkerBudget(time.monotonic()+60,time.monotonic))
        graph_requests=[]
        def graph_handler(request):
            graph_requests.append({'method':request.method,'path':request.url.path,'body':json.loads(request.content)})
            require(request.url.host=='graph.microsoft.com' and request.url.path.endswith('/sendMail'),'Unexpected real transport operation')
            return httpx.Response(202,headers={'request-id':'synthetic-graph-accepted'})
        def transport_factory(settings,client): return MicrosoftGraphEmailTransport(settings,client,client_factory=lambda **kwargs:httpx.Client(**kwargs,transport=httpx.MockTransport(graph_handler)))
        x=fixture(); counts={'has_more':False}
        consumer=_ClaimConsumer(settings,client,_WorkerBudget(time.monotonic()+60,time.monotonic),transport_factory,counts)
        got=consumer._email({k:v for k,v in scope(x).items() if k in ('p_studio_id','p_run_id','p_claim_token')},'work')
        require(got=='accepted' and len(graph_requests)==1,'Actual dispatcher/Graph join failed '+str(got))
        actual=value('SELECT p.rendered FROM private.workflow_email_attempt_payloads p WHERE run_id='+quote(x['run'])+';')
        submitted=graph_requests[0]['body']['message']
        require(submitted['subject']==actual['subject'] and submitted['body']['content']==actual['html_body'],'Real Graph request differs from SQL bytes')
        passed('bounded actual dispatcher email seam real SQL SDK codec renderer prepared Graph202, real full guard requires installed final schema',rpc_calls=len(requests),graph_requests=1)

        x=fixture(); p=planned(x).plan; preparation=prep()
        absent_run=str(uuid4()); token=str(uuid4()); attempt_id=str(uuid4())
        common=value('SET ROLE service_role; SELECT private.automation_email_attempt_begin_v1('+','.join(map(quote,[x['studio'],'workflow',absent_run,'work',attempt_id,token,p.recipient_email,str(preparation.preparation_id),str(preparation.preparation_token),str(preparation.probe_token) if preparation.probe_token else None]))+');')
        require(common['outcome']=='begun','Common synthetic fixture admission failed')
        before=value('SELECT row_to_json(a) FROM private.automation_email_attempt_reservations a WHERE id='+quote(attempt_id)+';')
        lost=dict(x,run=absent_run,token=token)
        got=begin(lost,p,preparation)
        require(got.outcome=='lease_lost' and got.attempt is None and got.run is None,'Missing run duplicate returned a malformed grant/position')
        require(value('SELECT row_to_json(a) FROM private.automation_email_attempt_reservations a WHERE id='+quote(attempt_id)+';')==before,'Missing run graph call changed common truth')
        passed('missing run old-token begin refuses with lease_lost null position/grant, common truth unchanged')

if __name__=='__main__': main(sys.argv[1:])
