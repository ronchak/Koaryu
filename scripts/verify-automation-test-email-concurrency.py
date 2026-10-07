#!/usr/bin/env python3
"""One owned PG17 clone, exact test DTOs and real synthetic Graph components.

This proves internal service/SQL joins. The incomplete V57 release guard must
still refuse, and the final guarded application/clear composition is separate.
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
from uuid import UUID, uuid4

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from local_postgres_verification import LocalPostgres, require

ROOT = Path(__file__).resolve().parents[1]
BASE = '95314dac0d6fb83ea0e3f7d526ed01b50b313c59'
BASE_HASH = '4cc289ff188c5fbd193dc965947da629ed59e52dba1c13223d325fed35e541e2'
MIGRATION = ROOT / 'supabase/migrations/20261005105341_automation_workflow_graph_v57.sql'
CONTRACT = ROOT / 'supabase/verification/automation_test_email_contract.sql'
MARKER = '\n-- Foreground synthetic mail owns one immutable command'
INVENTORY = """SELECT jsonb_object_agg(p.oid::regprocedure::text,jsonb_build_object(
'definition',pg_get_functiondef(p.oid),'acl',p.proacl::text,'owner',pg_get_userbyid(p.proowner),
'settings',p.proconfig,'volatility',p.provolatile,'security_definer',p.prosecdef))
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname IN ('public','private') AND p.prokind='f';"""
CHILDREN = []


def quote(value):
    if value is None:
        return 'NULL'
    if isinstance(value, (dict, list)):
        value = json.dumps(value, separators=(',', ':'))
    return "'" + str(value).replace("'", "''") + "'"


def main(args):
    require(len(args) == 5, 'Expected psql socket port unique-owned-clone new-private-evidence-file')
    psql, socket, port, database, output = args
    require(re.fullmatch(r'koaryu_test_email_[a-z0-9_]+', database), 'Unsafe owned clone name')
    evidence = Path(output)
    require(evidence.is_absolute() and not os.path.lexists(evidence), 'Evidence must be a new absolute path')
    local = LocalPostgres(psql, socket, port, str(Path(socket).parent))
    pid_path = Path(socket).parent / 'data/postmaster.pid'
    pid = pid_path.read_text().splitlines()[0]
    baseline = local.sql('postgres', 'SELECT row_to_json(p) FROM public.koaryu_release_schema_preflight_v37() p;')
    b = json.loads(baseline)
    require(b['ready'] and b['migration_count'] == 151 and b['migration_head'] == '20261004220435'
            and b['manifest_version'] == 'release-db-attestation-v56', 'Strict V56 template required')
    require(local.sql('postgres', f'SELECT NOT EXISTS(SELECT 1 FROM pg_database WHERE datname={quote(database)});') == 't', 'Foreign clone refused')
    src = MIGRATION.read_bytes()
    accepted = local.run(['git', '-C', str(ROOT), 'show', BASE + ':' + str(MIGRATION.relative_to(ROOT))]) + '\n'
    require(hashlib.sha256(accepted.encode()).hexdigest() == BASE_HASH, 'Accepted migration pin differs')
    require(src.decode().split(MARKER)[0] == accepted, 'Synthetic implementation must be an additive suffix')
    historical = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in MIGRATION.parent.glob('*.sql') if p != MIGRATION}
    require(len(historical) == 151, 'Expected 151 historical files')
    owned = False
    start = time.monotonic()
    cases = []
    diagnostics = []
    installed = None

    def sql(statement):
        return local.sql(database, "SET TIME ZONE 'UTC';\n" + statement)

    def value(statement):
        return json.loads(sql(statement))

    def passed(name, **details):
        cases.append({'case': name, 'outcome': 'passed', **details})
        print('[test email] PASS ' + name, flush=True)

    try:
        print('[test email] copy strict V56 template to owned clone ' + database, flush=True)
        local.sql('postgres', f'CREATE DATABASE {database} TEMPLATE postgres;')
        owned = True
        sql('BEGIN;\n' + accepted + '\nCOMMIT;')
        retained = value(INVENTORY)
        sql('BEGIN;\n' + MARKER + src.decode().split(MARKER, 1)[1] + '\nCOMMIT;')
        installed = value(INVENTORY)
        require(all(installed.get(k) == v for k, v in retained.items()), 'Retained function facts changed')
        passed('source pins and all retained definitions ACLs security config', retained=len(retained), added=len(installed) - len(retained))
        passed('focused SQL contract', output=sql(CONTRACT.read_text()))
        fixtures = CONTRACT.read_text().split('-- fixture owners start.')[1].split('-- fixture owners end.')[0]
        sql('CREATE SCHEMA test_email_proof;\n' + fixtures.replace('pg_temp.', 'test_email_proof.')
            + '\nGRANT USAGE ON SCHEMA test_email_proof TO service_role; GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA test_email_proof TO service_role;')
        run_proof(local, sql, value, passed, database, psql)
        sql('DROP SCHEMA test_email_proof CASCADE;')
        require(value(INVENTORY) == installed, 'Proof did not restore exact function owners')
        passed('temporary instrumentation restored exactly')
    except Exception as exc:
        diagnostics.append({'type': type(exc).__name__, 'message': str(exc)})
        raise
    finally:
        for child in CHILDREN:
            process = child['process']
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
        if owned:
            local.sql('postgres', f'DROP DATABASE {database} WITH (FORCE);')
        absent = local.sql('postgres', f'SELECT NOT EXISTS(SELECT 1 FROM pg_database WHERE datname={quote(database)});') == 't'
        require(absent, 'Owned clone remains')
        require(pid_path.read_text().splitlines()[0] == pid, 'Postmaster changed')
        require(local.sql('postgres', 'SELECT row_to_json(p) FROM public.koaryu_release_schema_preflight_v37() p;') == baseline, 'Template state changed')
        require(MIGRATION.read_bytes() == src, 'Source changed during proof')
        require(historical == {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in MIGRATION.parent.glob('*.sql') if p != MIGRATION}, 'Historical source changed')
        report = {'base': BASE, 'source_sha256': hashlib.sha256(src).hexdigest(),
                  'contract_sha256': hashlib.sha256(CONTRACT.read_bytes()).hexdigest(),
                  'verifier_sha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                  'cases': cases, 'diagnostics': diagnostics, 'elapsed_seconds': round(time.monotonic() - start, 3),
                  'boundary': 'internal service/SQL/SDK/render/Graph MockTransport; partial V57 guard refuses',
                  'cleanup': {'clone_absent': absent, 'template_unchanged': True, 'postmaster_pid': pid}}
        with evidence.open('x') as out:
            os.chmod(evidence, 0o600)
            json.dump(report, out, indent=2)
            out.write('\n')
        print('[test email] owned clone absent; strict V56 template and observed postmaster unchanged', flush=True)


def run_proof(local, sql, value, passed, database, psql):
    def no_dotenv(event, args):
        if event == 'open' and isinstance(args[0], (str, bytes)):
            require(not Path(str(args[0])).name.startswith('.env'), 'Dotenv read forbidden')

    sys.addaudithook(no_dotenv)
    sys.path.insert(0, str(ROOT / 'backend'))
    import httpx
    from cryptography.fernet import Fernet
    from types import SimpleNamespace
    from importlib.metadata import version
    from postgrest import SyncPostgrestClient
    from postgrest.utils import SyncClient
    from app.schemas import workflow_dispatch as common
    from app.schemas.workflow_test_email import WorkflowTestEmailRequest
    from app.schemas.workflow_management import TestEmailOperationResponse
    from app.services import workflow_test_email_service as dto
    from app.services.workflow_email import render_workflow_email
    from app.services.workflow_simulation_service import build_synthetic_workflow_facts
    from app.services.automation_email import assemble_synthetic_test_email, delivery_configuration, sender_identity_binding
    from app.services.automation_email_credentials import CredentialCodec, CredentialState, CredentialRepository
    from app.services.microsoft_graph_email import MicrosoftGraphEmailTransport
    from app.services.automation_service import _WorkerBudget, _require_dispatch_schema, _dispatch_rpc, _delivery_result
    require(version('postgrest') == '0.17.2', 'Pinned installed SDK required')
    sql('''CREATE FUNCTION test_email_proof.rpc(statement TEXT) RETURNS JSONB LANGUAGE plpgsql AS $$
    DECLARE got JSONB; code TEXT; message TEXT;
    BEGIN BEGIN EXECUTE statement INTO got; RETURN jsonb_build_object('ok',true,'data',got);
    EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS code=RETURNED_SQLSTATE,message=MESSAGE_TEXT;
        RETURN jsonb_build_object('ok',false,'error',jsonb_build_object('code',code,'message',message,'details',NULL,'hint',NULL)); END; END $$;
    GRANT EXECUTE ON FUNCTION test_email_proof.rpc(TEXT) TO service_role;''')
    requests = []
    lose = set()
    malformed = set()

    def statement(name, params):
        if re.fullmatch(r'koaryu_release_schema_preflight_v[0-9]+', name):
            require(not params, 'Preflight parameters unexpected')
            return "SELECT coalesce(jsonb_agg(to_jsonb(p)),'[]'::JSONB) FROM public." + name + "() p;"
        return 'SELECT public.' + name + '(' + ','.join(k + '=>' + (
            'ARRAY[' + ','.join(map(quote, v)) + ']::TEXT[]' if isinstance(v, list) else
            'true' if v is True else 'false' if v is False else quote(v)) for k, v in params.items()) + ');'

    class SQLClient(SyncPostgrestClient):
        def create_session(self, base_url, headers, timeout, verify=True, proxy=None):
            def handler(request):
                name = request.url.path.rsplit('/', 1)[-1]
                require(request.method == 'POST' and re.fullmatch('[a-z_0-9]+', name), 'Unexpected SDK operation')
                observed = value('SET ROLE service_role; SELECT test_email_proof.rpc(' + quote(statement(name, json.loads(request.content))) + ');')
                requests.append({'rpc': name, 'ok': observed['ok']})
                if not observed['ok']:
                    print('[test email] SQL ' + name + ' ' + observed['error']['code'] + ' ' + observed['error']['message'], flush=True)
                if name in lose:
                    lose.remove(name)
                    raise httpx.ReadError('synthetic lost committed response', request=request)
                if name in malformed:
                    malformed.remove(name)
                    return httpx.Response(200, json={'payload': {}})
                return httpx.Response(200 if observed['ok'] else 400, json=observed.get('data', observed.get('error')))
            return SyncClient(base_url=base_url, headers=headers, timeout=timeout, trust_env=False, follow_redirects=False,
                              transport=httpx.MockTransport(handler))

    settings = SimpleNamespace(EMAIL_PROVIDER='microsoft_graph', EMAIL_SEND_ENABLED=True, EMAIL_FROM_ADDRESS='sender@example.invalid',
        EMAIL_FROM_NAME='Koaryu', EMAIL_REPLY_TO='reply@example.invalid', EMAIL_ALLOWED_RECIPIENTS='',
        EMAIL_GRAPH_CLIENT_ID='b31866c9-dfc5-47a7-9889-bb2c98359911', EMAIL_GRAPH_CLIENT_SECRET='synthetic-only',
        EMAIL_GRAPH_TENANT='consumers', EMAIL_TOKEN_ENCRYPTION_KEY=Fernet.generate_key().decode(),
        AUTOMATION_PUBLIC_API_URL='https://mail.example.invalid/api/v1', AUTOMATION_WORKER_ENABLED=True)
    binding = sender_identity_binding(delivery_configuration(settings))
    runtime = dto.Runtime(sender_binding=binding, default_reply_to=settings.EMAIL_REPLY_TO, allowed_recipients=[])

    def rpc(name, request, response):
        # Keep SQL failures readable while exercising the installed SDK and the
        # exact production request/envelope identity validation.
        try:
            return dto._test_rpc(client, name, request, response)
        except Exception as exc:
            probe = value('SET ROLE service_role; SELECT test_email_proof.rpc(' + quote(statement(name, request.model_dump(mode='json'))) + ');')
            if not probe['ok']:
                raise RuntimeError('SDK RPC ' + name + ': ' + str(probe['error'])) from None
            raise RuntimeError('SDK envelope ' + name + ': ' + str(exc)) from None

    def fixture(kind='lead.created'):
        return value('SELECT test_email_proof.test_email_fixture(' + quote(kind) + ');')

    def reserve(x, operation=None, replay=False, graph=None):
        return rpc(dto.CREATE, dto.ReserveRequest(p_studio_id=x['studio'], p_actor_id=x['actor'], p_workflow_id=x['workflow'],
            p_operation_id=operation or uuid4(), p_graph=graph or x['graph'], p_email_node_id='mail',
            p_runtime=None if replay else runtime, p_replay_only=replay), dto.Reserved)

    def scope(x, reserved):
        return dict(p_studio_id=x['studio'], p_test_delivery_id=reserved.result.test_delivery_id,
                    p_execution_token=reserved.execution.execution_token)

    def current(x, reserved, actor=None):
        return rpc(dto.CURRENT, dto.CurrentRequest(p_studio_id=x['studio'], p_actor_id=actor or x['actor'],
            p_test_delivery_id=reserved.result.test_delivery_id), dto.Current)

    def prepare(x, reserved, preparation_id=None):
        claim = rpc(dto.PREPARE, dto.PreparationRequest(**scope(x, reserved), p_actor_id=x['actor'], p_preparation_id=preparation_id or uuid4(),
            p_sender_binding=binding, p_allowed_recipients=[]), dto.PreparationClaim)
        require(claim.allowed, 'Owned preparation denied')
        prepared = _dispatch_rpc(client, 'settle_automation_sender_preparation_v1', common.PreparationSettleRequest(
            p_preparation_id=claim.preparation_id, p_preparation_token=claim.preparation_token,
            p_result=common.PreparationResult(outcome='prepared', credential_revision=1, sender_binding=binding, safe_reason=None,
                retry_after_seconds=None)), common.PreparationSettled)
        require(prepared.outcome == 'prepared', 'Preparation settlement failed')
        return prepared

    def rendered(reserved):
        e = reserved.execution
        facts = build_synthetic_workflow_facts(e.event_type, e.reference_time, program_id=e.trigger_context.program_id,
            offset_minutes=e.trigger_context.offset_minutes, recipient_ids=frozenset({e.recipient_policy}))
        content = render_workflow_email(e.event_type, e.subject_template, e.body_template,
            {**facts.template_facts, **facts.recipients[e.recipient_policy].template_facts}, unsubscribe_url=None)
        content = assemble_synthetic_test_email(content.subject, content.text_body)
        return dto.Rendered(subject=content.subject, text_body=content.text_body, html_body=content.html_body)

    def begin_request(x, reserved, prepared):
        return dto.BeginRequest(**scope(x, reserved), p_actor_id=x['actor'], p_preparation_id=prepared.preparation_id,
            p_preparation_token=prepared.preparation_token, p_probe_token=prepared.probe_token,
            p_allowed_recipients=[], p_scope_fingerprint=reserved.execution.scope_fingerprint, p_rendered=rendered(reserved))

    def begin(x, reserved, prepared=None):
        return rpc(dto.BEGIN, begin_request(x, reserved, prepared or prepare(x, reserved)), dto.Begun)

    def finish(x, reserved, reason='sender_unavailable'):
        return rpc(dto.FINISH, dto.FinishRequest(**scope(x, reserved), p_reason=reason), dto.Finished)

    def result(outcome='accepted', evidence='accepted', failure=None, error=None, revision=1):
        return common.Delivery(outcome=outcome, error_code=error, provider_request_id='synthetic-test-proof', retry_after_seconds=None,
            submission_evidence=evidence, failure_scope=failure, credential_revision=revision)

    def settle(x, reserved, attempt, delivery=None):
        return rpc(dto.SETTLE, dto.SettleRequest(**scope(x, reserved), p_attempt_id=attempt.id, p_result=delivery or result()), dto.Settled)

    def reset_gate():
        sql("UPDATE private.automation_sender_gate SET generation=generation+1,mode='ready',reason=NULL,next_probe_at=NULL,transient_failures=0,"
            "active_preparation_id=NULL,active_probe_token=NULL,active_attempt_id=NULL,probe_expires_at=NULL,updated_at=clock_timestamp();")

    def error(name, params, message):
        got = value('SET ROLE service_role; SELECT test_email_proof.rpc(' + quote(statement(name, params)) + ');')
        require(not got['ok'] and got['error']['message'] == message, 'Expected ' + message + ', got ' + str(got))

    def count(reserved):
        return sql('SELECT count(*) FROM private.automation_email_attempt_reservations WHERE scope_id=' + quote(reserved.result.test_delivery_id) + ';')

    def session(command, hold=True, role='postgres'):
        name = 'test_email_' + str(os.getpid()) + '_' + str(len(CHILDREN))
        process = subprocess.Popen([psql, *local.connection, '--dbname=' + database, '--no-psqlrc', '--set=ON_ERROR_STOP=1',
            '--quiet', '--tuples-only', '--no-align'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, bufsize=1, env=local.env)
        item = {'process': process, 'name': name, 'lines': [], 'errors': [], 'events': queue.Queue(), 'threads': []}
        def drain(stream, target):
            for line in stream:
                target.append(line.strip())
                if line.strip() == 'RESULT_READY':
                    item['events'].put('RESULT_READY')
        for stream, target in ((process.stdout, item['lines']), (process.stderr, item['errors'])):
            thread = threading.Thread(target=drain, args=(stream, target), daemon=True)
            thread.start()
            item['threads'].append(thread)
        CHILDREN.append(item)
        process.stdin.write('SET application_name=' + quote(name) + '; SET statement_timeout=\'20s\'; BEGIN; SET ROLE ' + role + ';\n'
                            + command + "\nSELECT 'RESULT_READY';\n")
        if not hold:
            process.stdin.write('COMMIT;\n')
            process.stdin.close()
        else:
            process.stdin.flush()
        return item

    def ready(item):
        end = time.monotonic() + 8
        while time.monotonic() < end:
            try:
                if item['events'].get(timeout=.05) == 'RESULT_READY':
                    return
            except queue.Empty:
                require(item['process'].poll() is None, 'Holder failed ' + str(item['errors']))
        raise RuntimeError('Holder barrier timeout')

    def finished(item):
        require(item['process'].wait(timeout=25) == 0, 'Session failed ' + str(item['errors']))
        for thread in item['threads']:
            thread.join(timeout=2)
        rows = [json.loads(line) for line in item['lines'] if line.startswith('{')]
        return rows[-1] if rows else None

    def release(item, rollback=False):
        item['process'].stdin.write('ROLLBACK;\n' if rollback else 'COMMIT;\n')
        item['process'].stdin.close()
        return finished(item)

    def blocked(holder, waiter):
        end = time.monotonic() + 8
        while time.monotonic() < end:
            require(waiter['process'].poll() is None, 'Waiter exited early ' + str(waiter['errors']))
            if sql('SELECT EXISTS(SELECT 1 FROM pg_stat_activity h JOIN pg_stat_activity w ON h.pid=ANY(pg_blocking_pids(w.pid)) '
                'WHERE h.application_name=' + quote(holder['name']) + ' AND w.application_name=' + quote(waiter['name']) + ');') == 't':
                return
            time.sleep(.025)
        raise RuntimeError('Missing observed blocking relation')

    with SQLClient('http://test-email-proof.invalid') as client:
        codec = CredentialCodec(settings.EMAIL_TOKEN_ENCRYPTION_KEY, settings.EMAIL_GRAPH_CLIENT_ID, settings.EMAIL_FROM_ADDRESS)
        CredentialRepository(client, codec).save(CredentialState(settings.EMAIL_GRAPH_CLIENT_ID, settings.EMAIL_FROM_ADDRESS,
            'synthetic-refresh', 'synthetic-access', time.time() + 3600), 0)
        for kind in ('lead.created', 'trial.upcoming', 'student.promoted', 'invoice.overdue', 'belt_test.upcoming'):
            x = fixture(kind)
            graph = json.loads(json.dumps(x['graph']))
            if kind == 'lead.created':
                graph['nodes'][1]['config'].update(subject_template='Selected {{recipient_name}}', body_template="Selected draft & <tag> \"x\" 'y'\nFrom {{studio_name}}", reply_to_email='node@example.invalid')
            r = reserve(x, graph=graph)
            require(r.execution.reply_to == ('node@example.invalid' if kind == 'lead.created' else settings.EMAIL_REPLY_TO), 'Submitted node reply-to replaced by saved draft')
            require(r.execution.subject_template == graph['nodes'][1]['config']['subject_template'], 'Submitted template replaced by saved draft')
            require(r.execution.recipient_email == x['actor'] + '@example.invalid', 'Caller destination substituted')
            rendered(r)
            f = finish(x, r, 'invalid_email_context')
            require(f.updated and not f.replayed and finish(x, r, 'invalid_email_context').replayed, 'Typed no-attempt finish matrix')
        passed('representative trigger contexts actual submitted selection and strict reserve render finish DTOs')

        x = fixture()
        r = reserve(x)
        sql('UPDATE auth.users SET email_confirmed_at=NULL WHERE id=' + quote(x['actor']) + '; DELETE FROM public.programs WHERE id=' + quote(x['program']) + ';')
        replay = reserve(x, r.result.operation_id, True)
        require(replay.replayed and replay.execution is None and replay.result == r.result, 'Replay grant escaped')
        changed = json.loads(json.dumps(x['graph']))
        changed['nodes'][1]['config']['subject_template'] = 'Changed'
        error(dto.CREATE, dto.ReserveRequest(p_studio_id=x['studio'], p_actor_id=x['actor'], p_workflow_id=x['workflow'],
            p_operation_id=r.result.operation_id, p_graph=changed, p_email_node_id='mail', p_runtime=None, p_replay_only=True).model_dump(mode='json'), 'AUTOMATION_OPERATION_CONFLICT')
        require(current(x, r).result.state == 'queued', 'Current became immutable ACK or unwanted expiry')
        require(finish(x, r).updated and reserve(x, r.result.operation_id, True).result.state == 'queued', 'Terminal replay changed receipt')
        operation = client.rpc('get_automation_operation_v1', dict(p_studio_id=x['studio'], p_actor_id=x['actor'], p_operation_id=str(r.result.operation_id))).execute().data
        receipt = TestEmailOperationResponse.model_validate(operation['payload'])
        require(receipt.result.model_dump() == r.result.model_dump() and receipt.entity_id == r.result.test_delivery_id, 'Ordinary operation recovery receipt incompatible')
        passed('immutable replay precedes changed Auth config and missing reference, current truth and ordinary receipt DTO remain distinct')

        x = fixture()
        r = reserve(x)
        sql('UPDATE auth.users SET email_confirmed_at=NULL WHERE id=' + quote(x['actor']) + ';')
        claim = rpc(dto.PREPARE, dto.PreparationRequest(**scope(x, r), p_actor_id=x['actor'], p_preparation_id=uuid4(),
            p_sender_binding=binding, p_allowed_recipients=[]), dto.PreparationClaim)
        require(not claim.allowed and current(x, r).result.state == 'failed' and count(r) == '0', 'Changed verification did not revoke execution')
        passed('verified Auth change stops owned preparation without an attempt')

        # Narrow component seam uses actual service, codec, renderer and prepared transport.
        graph_requests = []
        graph_mode = ['accepted']
        def graph_handler(request):
            require(request.url.host == 'graph.microsoft.com' and request.url.path.endswith('/sendMail'), 'Unexpected Graph operation')
            graph_requests.append(json.loads(request.content))
            if graph_mode[0] == 'unknown':
                raise httpx.ReadTimeout('synthetic submission lost', request=request)
            return httpx.Response(202, headers={'request-id': 'synthetic-test-accepted'})
        def transport_factory(settings, client):
            return MicrosoftGraphEmailTransport(settings, client, client_factory=lambda **kwargs:
                httpx.Client(**kwargs, transport=httpx.MockTransport(graph_handler)))
        def service():
            return dto.WorkflowTestEmailService(client, settings, _WorkerBudget(time.monotonic() + 60, time.monotonic),
                                                transport_factory=transport_factory)
        def request(x, operation=None):
            return WorkflowTestEmailRequest.model_validate(dict(operation_id=str(operation or uuid4()), graph=x['graph'], email_node_id='mail'))
        try:
            _require_dispatch_schema(client, _WorkerBudget(time.monotonic() + 60, time.monotonic))
        except Exception:
            pass
        else:
            raise RuntimeError('Partial V57 advertised ready')
        for mode in ('accepted', 'unknown'):
            reset_gate()
            graph_mode[0] = mode
            x = fixture()
            data = request(x)
            start = len(graph_requests)
            got = service().create(UUID(x['studio']), UUID(x['actor']), UUID(x['workflow']), data)
            require(got.state == mode and len(graph_requests) == start + 1, 'Actual service/Graph result ' + got.state)
            payload = value('SELECT rendered FROM private.automation_test_email_payloads WHERE scope_id=' + quote(got.test_delivery_id) + ';')
            submitted = graph_requests[-1]['message']
            require(submitted['subject'] == payload['subject'] and submitted['body']['content'] == payload['html_body'], 'Graph bytes differ from pinned SQL')
            require('Unsubscribe from these reminders' not in payload['text_body'], 'Synthetic customer footer')
            again = service().create(UUID(x['studio']), UUID(x['actor']), UUID(x['workflow']), data)
            require(again == got and len(graph_requests) == start + 1, 'Replay resent provider operation')
            charge = sql('SELECT frequency_state FROM private.automation_email_attempt_reservations WHERE scope_id=' + quote(got.test_delivery_id) + ';')
            require(charge == mode, 'Actual result reservation released')
        passed('real internal service SDK codec renderer prepared Graph accepted202 and unknown, one send and fixed bytes', graph_calls=len(graph_requests))
        reset_gate()

        x = fixture()
        data = request(x)
        lose.add(dto.CREATE)
        before = len(graph_requests)
        try:
            service().create(UUID(x['studio']), UUID(x['actor']), UUID(x['workflow']), data)
        except Exception as exc:
            require(getattr(exc, 'status_code', None) == 503, 'Lost reserve must be unresolved')
        else:
            raise RuntimeError('Lost reserve unexpectedly returned')
        recovered = service().create(UUID(x['studio']), UUID(x['actor']), UUID(x['workflow']), data)
        require(recovered.state == 'queued' and len(graph_requests) == before, 'Lost reserve replay gained execution')
        operation = client.rpc('get_automation_operation_v1', dict(p_studio_id=x['studio'], p_actor_id=x['actor'], p_operation_id=str(data.operation_id))).execute().data
        require(TestEmailOperationResponse.model_validate(operation['payload']).result.test_delivery_id == recovered.test_delivery_id, 'Lost reserve ordinary operation read mismatch')
        other = fixture()
        error(dto.CURRENT, dict(p_studio_id=other['studio'], p_actor_id=other['actor'], p_test_delivery_id=str(recovered.test_delivery_id)), 'AUTOMATION_NOT_FOUND')
        passed('lost reserve response replay is queued without execution, ordinary operation recovery and cross-tenant refusal')

        # Actual begin grant is irrecoverable after a lost response; GET cannot resend.
        x = fixture()
        r = reserve(x)
        p = prepare(x, r)
        lose.add(dto.BEGIN)
        try:
            dto._test_rpc(client, dto.BEGIN, begin_request(x, r, p), dto.Begun)
        except Exception:
            pass
        else:
            raise RuntimeError('Lost begin unexpectedly returned')
        b = begin(x, r, p)
        require(b.outcome == 'already_begun' and b.attempt is None and count(r) == '1' and current(x, r).result.state == 'sending', 'Lost begin granted resend')
        attempt_id = sql('SELECT attempt_id FROM private.automation_test_email_scopes WHERE id=' + quote(r.result.test_delivery_id) + ';')
        attempt = SimpleNamespace(id=UUID(attempt_id))
        require(settle(x, r, attempt).state == 'accepted' and settle(x, r, attempt).replayed, 'Accepted original settlement/replay')
        require(not settle(x, r, attempt, result('unknown', 'unknown', 'unclassified', 'provider_submission_unknown')).updated, 'Conflicting result overwrote truth')
        passed('lost begin, no second grant, settlement replay and conflicting result refuse')

        # Accounts need no customer row to share recipient suppression/frequency.
        x = fixture()
        r = reserve(x)
        sql('INSERT INTO public.automation_suppressions(studio_id,recipient_email) VALUES(' + quote(x['studio']) + ',' + quote(r.execution.recipient_email) + ');')
        b = begin(x, r)
        require(b.outcome == 'stopped' and b.result.state == 'failed' and count(r) == '0', 'Verified admin bypassed suppression')
        x = fixture()
        r = reserve(x)
        b = begin(x, r)
        settle(x, r, b.attempt)
        r2 = reserve(x)
        require(begin(x, r2).outcome == 'stopped' and count(r2) == '0', 'One-hour common recipient budget bypassed')
        # Retained legacy conservative charges exercise the same three/24h budget,
        # with newest already outside the separate one-hour interval.
        x = fixture()
        r = reserve(x)
        sql("INSERT INTO private.automation_email_attempt_reservations(id,studio_id,provider_key,scope_kind,scope_id,recipient_email,origin,protocol,state,frequency_state,conservative_anchor_at,observed_legacy_ordinal) "
            "SELECT gen_random_uuid()," + quote(x['studio']) + ", 'microsoft_graph:primary','legacy',gen_random_uuid()," + quote(r.execution.recipient_email)
            + ",'cutover_fallback','historical','accepted','accepted',clock_timestamp()-make_interval(hours=>n),1 FROM generate_series(2,4) n;")
        require(begin(x, r).outcome == 'stopped' and count(r) == '0', 'Shared three/24h budget bypassed')
        passed('verified admin without customer rows shares suppression, hour budget and legacy three/24h charges')

        # Recovery uses only a currently owned synthetic scope and explicit accepted evidence.
        for evidence in ('accepted', None):
            reset_gate()
            sql("SELECT private.automation_sender_failure_v1('sender_auth','authentication_required',1,NULL,clock_timestamp());")
            normal = _dispatch_rpc(client, 'claim_automation_sender_preparation_v1', common.PreparationClaimRequest(
                p_provider_key='microsoft_graph:primary', p_preparation_id=uuid4(), p_sender_binding=binding), common.PreparationClaim)
            require(not normal.allowed and normal.mode == 'auth_blocked', 'Normal preparation granted hard-block recovery')
            x = fixture()
            r = reserve(x)
            p = prepare(x, r)
            require(p.probe_token is not None, 'Test recovery lacks probe')
            b = begin(x, r, p)
            require(settle(x, r, b.attempt, result(evidence=evidence)).state == 'accepted', 'Accepted-null compatibility lost')
            require(sql('SELECT mode FROM private.automation_sender_gate;') == ('ready' if evidence else 'auth_blocked'), 'Recovery evidence not exact')
        reset_gate()
        sql("SELECT private.automation_sender_failure_v1('sender_auth','authentication_required',1,NULL,clock_timestamp());")
        x = fixture()
        r = reserve(x)
        b = begin(x, r)
        sql("SELECT private.automation_sender_failure_v1('sender_auth','authentication_required',1,NULL,clock_timestamp());")
        require(settle(x, r, b.attempt).state == 'accepted' and sql('SELECT mode FROM private.automation_sender_gate;') == 'auth_blocked', 'Stale generation reopened gate')
        reset_gate()
        passed('normal hard block refusal, owned synthetic recovery, accepted-null truth and stale-generation recovery fence')

        # Clear seam retains sending truth and original-token settlement after role removal.
        x = fixture()
        r = reserve(x)
        b = begin(x, r)
        queued = reserve(x)
        sql('BEGIN; SELECT pg_advisory_xact_lock(hashtextextended(' + quote('koaryu.local-plan-clear:' + x['studio']) + ',0)); '
            'SELECT private.automation_test_invalidate_queued_v1(' + quote(x['studio']) + '); DELETE FROM private.automation_test_email_payloads WHERE studio_id=' + quote(x['studio']) + '; COMMIT;')
        require(current(x, queued).result.state == 'failed' and current(x, r).result.state == 'sending', 'Clear seam damaged sending truth')
        reader = str(uuid4())
        sql('INSERT INTO auth.users(id,email,last_sign_in_at) VALUES(' + quote(reader) + ',' + quote(reader + '@example.invalid') + ',clock_timestamp()); '
            'INSERT INTO public.staff_roles(studio_id,user_id,role) VALUES(' + quote(x['studio']) + ',' + quote(reader) + ",'admin'); "
            'UPDATE public.studios SET owner_id=' + quote(reader) + ' WHERE id=' + quote(x['studio']) + '; '
            'DELETE FROM public.staff_roles WHERE user_id=' + quote(x['actor']) + ';')
        require(settle(x, r, b.attempt).state == 'accepted', 'Purged payload or actor removal blocked original settlement')
        params = dto.CurrentRequest(p_studio_id=x['studio'], p_actor_id=x['actor'], p_test_delivery_id=r.result.test_delivery_id).model_dump(mode='json')
        error(dto.CURRENT, params, 'AUTOMATION_ADMIN_REQUIRED')
        require(current(x, r, reader).result.state == 'accepted', 'Another current admin cannot read retained truth')
        attempt_params = begin_request(x, r, SimpleNamespace(preparation_id=b.attempt.id, preparation_token=uuid4(), probe_token=None)).model_dump(mode='json')
        attempt_params['p_actor_id'] = reader
        got = value('SET ROLE service_role; SELECT test_email_proof.rpc(' + quote(statement(dto.BEGIN, attempt_params)) + ');')
        require(got['ok'] and got['data']['payload']['outcome'] == 'lease_lost', 'Reader executed original scope')
        require(sql('SELECT count(*) FROM private.automation_test_email_payloads WHERE studio_id=' + quote(x['studio']) + ';') == '0', 'Settlement recreated purged payload')
        passed('exclusive clear invalidates queued only, purge keeps sending truth, original settlement survives removed role, current admin reader distinct')

        # Concrete preparation loss remains fixed 503 and does not finish/read truth.
        x = fixture()
        malformed.add('settle_automation_sender_preparation_v1')
        start = len(requests)
        try:
            service().create(UUID(x['studio']), UUID(x['actor']), UUID(x['workflow']), request(x))
        except Exception as exc:
            require(getattr(exc, 'status_code', None) == 503, 'Unconfirmed preparation did not remain fixed503')
        else:
            raise RuntimeError('Malformed preparation returned success')
        suffix = [r['rpc'] for r in requests[start:]]
        require(dto.FINISH not in suffix and dto.CURRENT not in suffix and dto.BEGIN not in suffix, 'Unconfirmed preparation fabricated finish/current')
        passed('malformed shared preparation reply fixed503 with no finish current or begin')

        # Observe real Auth UPDATE ownership against email and absent FK rows.
        for change, rollback in (('email', False), ('email', True), ('role', False), ('profile', False)):
            x = fixture()
            r = reserve(x)
            p = prepare(x, r)
            params = begin_request(x, r, p).model_dump(mode='json')
            holder = session(statement(dto.BEGIN, params), role='service_role')
            ready(holder)
            if change == 'email':
                writer_sql = 'UPDATE auth.users SET email=' + quote('changed.' + x['actor'] + '@example.invalid') + ' WHERE id=' + quote(x['actor']) + ';'
            elif change == 'role':
                other = fixture()
                writer_sql = 'INSERT INTO public.staff_roles(studio_id,user_id,role) VALUES(' + quote(other['studio']) + ',' + quote(x['actor']) + ",'admin');"
            else:
                writer_sql = 'INSERT INTO public.staff_profiles(user_id,legal_first_name,legal_last_name) VALUES(' + quote(x['actor']) + ",'Fresh','Profile');"
            if change == 'role':
                refused = value('SELECT test_email_proof.rpc(' + quote(writer_sql) + ');')
                require(not refused['ok'] and refused['error']['message'] == 'Koaryu accounts can belong to only one studio.', 'Retained second-studio membership guard changed')
                got = release(holder, rollback)
            else:
                writer = session(writer_sql, False)
                blocked(holder, writer)
                got = release(holder, rollback)
                finished(writer)
            if rollback:
                require(count(r) == '0', 'Rolled-back begin retained attempt')
            else:
                grant = common.Envelope[dto.Begun].model_validate(got).payload
                settle(x, r, grant.attempt)
            if change == 'role':
                passed('retained second-studio insertion guard refuses during owned begin', refusal=refused['error'],
                    retained_guard_sha256=hashlib.sha256(sql("SELECT pg_get_functiondef('private.enforce_single_studio_membership()'::REGPROCEDURE);").encode()).hexdigest())
            else:
                passed('Auth UPDATE blocks ' + change + ' writer through begin ' + ('rollback' if rollback else 'commit'))
        x = fixture()
        r = reserve(x)
        p = prepare(x, r)
        holder = session('UPDATE auth.users SET email=email WHERE id=' + quote(x['actor']) + ';')
        ready(holder)
        error(dto.BEGIN, begin_request(x, r, p).model_dump(mode='json'), 'AUTOMATION_STUDIO_BUSY')
        release(holder)
        require(count(r) == '0', 'Auth NOWAIT retained an attempt')
        passed('reverse Auth ownership NOWAIT refuses atomically')

        # One real sixty-second wait covers both queued and sending expiry.
        x = fixture()
        r = reserve(x)
        b = begin(x, r)
        queued = reserve(x)
        deadline = max(b.attempt.lease_expires_at.timestamp(), queued.execution.lease_expires_at.timestamp())
        print('[test email] waiting for one real fixed60s queued/sending expiry interval', flush=True)
        while time.time() <= deadline + .05:
            time.sleep(min(.25, max(.01, deadline + .05 - time.time())))
        holder = session('SELECT 1 FROM private.automation_test_email_scopes WHERE id=' + quote(r.result.test_delivery_id) + ' FOR UPDATE;')
        ready(holder)
        error(dto.CURRENT, dto.CurrentRequest(p_studio_id=x['studio'], p_actor_id=x['actor'], p_test_delivery_id=r.result.test_delivery_id).model_dump(mode='json'), 'AUTOMATION_STUDIO_BUSY')
        release(holder)
        require(current(x, r).result.state == 'unknown' and current(x, queued).result.state == 'failed', 'Scoped expiry did not reconcile exact queued/sending')
        require(count(queued) == '0' and count(r) == '1', 'Expiry acquired another attempt')
        require(sql('SELECT frequency_state FROM private.automation_email_attempt_reservations WHERE id=' + quote(b.attempt.id) + ';') == 'unknown', 'Expiry released uncertain charge')
        require(not settle(x, r, b.attempt).updated, 'Late acceptance overwrote expired unknown')
        require(reserve(x, r.result.operation_id, True).result.state == 'queued', 'Expiry rewrote immutable receipt')
        reset_gate()
        passed('real60s current scoped expiry busy rollback, queued failed/noattempt, sending unknown/charged, late acceptance refused')

        x = fixture()
        r = reserve(x)
        sql('BEGIN; SELECT pg_advisory_xact_lock(hashtextextended(' + quote('koaryu.local-plan-clear:' + x['studio']) + ',0)); '
            'SELECT private.automation_test_invalidate_queued_v1(' + quote(x['studio']) + '); DELETE FROM private.automation_test_email_payloads WHERE studio_id=' + quote(x['studio']) + '; ROLLBACK;')
        require(current(x, r).result.state == 'queued' and sql('SELECT count(*) FROM private.automation_test_email_payloads WHERE scope_id=' + quote(r.result.test_delivery_id) + ';') == '1', 'Clear rollback altered scope/payload')
        sql('BEGIN; SELECT pg_advisory_xact_lock(hashtextextended(' + quote('koaryu.local-plan-clear:' + x['studio']) + ',0)); '
            'SELECT private.automation_test_invalidate_queued_v1(' + quote(x['studio']) + '); DELETE FROM private.automation_test_email_payloads WHERE studio_id=' + quote(x['studio']) + '; COMMIT;')
        require(finish(x, r).replayed and count(r) == '0', 'Clear old token revived scope')
        fresh = reserve(x)
        require(fresh.execution is not None and fresh.result.test_delivery_id != r.result.test_delivery_id, 'Post-clear explicit operation prevented')
        # A sterile no-staff studio isolates the actual scope/payload cascade from
        # the retained last-admin guard, which rejects deletion of staff owners.
        cascade_studio = str(uuid4())
        cascade_scope = str(uuid4())
        sql('INSERT INTO public.studios(id,name,slug,owner_id) VALUES(' + quote(cascade_studio) + ",'Cascade proof'," + quote(cascade_studio) + ',' + quote(x['actor']) + '); '
            'INSERT INTO private.automation_test_email_scopes SELECT (jsonb_populate_record(NULL::private.automation_test_email_scopes,to_jsonb(s)||'
            + quote(dict(id=cascade_scope, studio_id=cascade_studio, execution_token=str(uuid4()))) + '::JSONB)).* FROM private.automation_test_email_scopes s WHERE id=' + quote(fresh.result.test_delivery_id) + '; '
            'INSERT INTO private.automation_test_email_payloads(scope_id,studio_id,selection) SELECT ' + quote(cascade_scope) + ',' + quote(cascade_studio) + ',selection FROM private.automation_test_email_payloads WHERE scope_id=' + quote(fresh.result.test_delivery_id) + '; '
            'DELETE FROM public.studios WHERE id=' + quote(cascade_studio) + ';')
        require(sql('SELECT count(*) FROM private.automation_test_email_scopes WHERE studio_id=' + quote(cascade_studio) + ';') == '0'
            and sql('SELECT count(*) FROM private.automation_test_email_payloads WHERE studio_id=' + quote(cascade_studio) + ';') == '0', 'Actual studio deletion did not cascade')
        passed('clear rollback, old grant invalidation, explicit post-clear reserve and actual studio deletion distinction')
        reset_gate()
        sql("SELECT private.automation_sender_failure_v1('sender_auth','authentication_required',1,NULL,clock_timestamp());")
        x = fixture()
        r = reserve(x)
        b = begin(x, r)
        CredentialRepository(client, codec).save(CredentialState(settings.EMAIL_GRAPH_CLIENT_ID, settings.EMAIL_FROM_ADDRESS,
            'synthetic-refresh2', 'synthetic-access2', time.time() + 3600), 1)
        require(settle(x, r, b.attempt).state == 'accepted' and sql('SELECT mode FROM private.automation_sender_gate;') == 'auth_blocked', 'Changed credential revision reopened hard block')
        reset_gate()
        x = fixture()
        r = reserve(x)
        claim = rpc(dto.PREPARE, dto.PreparationRequest(**scope(x, r), p_actor_id=x['actor'], p_preparation_id=uuid4(),
            p_sender_binding=binding, p_allowed_recipients=[]), dto.PreparationClaim)
        p = _dispatch_rpc(client, 'settle_automation_sender_preparation_v1', common.PreparationSettleRequest(
            p_preparation_id=claim.preparation_id, p_preparation_token=claim.preparation_token,
            p_result=common.PreparationResult(outcome='prepared', credential_revision=2, sender_binding=binding, safe_reason=None,
                retry_after_seconds=None)), common.PreparationSettled)
        CredentialRepository(client, codec).save(CredentialState(settings.EMAIL_GRAPH_CLIENT_ID, settings.EMAIL_FROM_ADDRESS,
            'synthetic-refresh3', 'synthetic-access3', time.time() + 3600), 2)
        require(begin(x, r, p).outcome == 'stopped' and count(r) == '0', 'Stale prepared credential created an attempt')
        passed('credential CAS changes prevent stale preparation begin and explicit accepted recovery')
        require(all(c['ok'] for c in requests if not c['rpc'].startswith('koaryu_release_schema_preflight_')), 'Unexpected SDK SQL failure')
        passed('all six RPCs and shared preparation settlement through pinned installed SDK', rpc_calls=len(requests))


if __name__ == '__main__':
    main(sys.argv[1:])
