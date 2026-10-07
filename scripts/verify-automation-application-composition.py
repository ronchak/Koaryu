#!/usr/bin/env python3
"""Bounded actual SQL/API composition; Graph and bearer identity are synthetic.

Requires an explicitly supplied final V57 template in the existing PG17 verifier
cluster. Never installs migrations. Only the uniquely named clone is modified.
Source wiring alone is not positive SQL or served UI evidence.
"""

import argparse
import hashlib
import json
import os
import re
import signal
import subprocess
import sys
import time
from contextlib import ExitStack, contextmanager
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from urllib.parse import urlsplit
from uuid import uuid4

from local_postgres_verification import ACL_SQL, CONSTRAINT_SQL, LocalPostgres, require

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))


def configure_test_environment():
    os.environ["ENVIRONMENT"] = "test"
    os.environ["SUPABASE_URL"] = "https://placeholder.supabase.co"
    os.environ["SUPABASE_DEVELOPMENT_PROJECT_REF"] = ""
    from app.core.config import AMBIENT_TRANSPORT_ENVIRONMENT_KEYS, Settings

    Settings.model_config["env_file"] = None
    for key in AMBIENT_TRANSPORT_ENVIRONMENT_KEYS:
        os.environ.pop(key, None)


def quote(value):
    if value is None:
        return "NULL"
    if isinstance(value, (dict, list, bool)):
        value = json.dumps(value, allow_nan=False, separators=(",", ":"))
    require("\x00" not in str(value), "NUL is not a PostgreSQL value")
    return "'" + str(value).replace("'", "''") + "'"


def rpc_value(key, value):
    # These fixed owner DTOs declare only this named argument as TEXT[].
    if key == "p_allowed_recipients":
        require(
            type(value) is list and all(type(item) is str for item in value),
            "Invalid recipient array",
        )
        return "ARRAY[" + ",".join(map(quote, value)) + "]::TEXT[]"
    return quote(value)


def require_final_declarations():
    from app.services import generated_release_readiness as generated

    require(
        generated.EXPECTED_RELEASE_MANIFEST_VERSION == "release-db-attestation-v57"
        and generated.RELEASE_PREFLIGHT_RPC == "koaryu_release_schema_preflight_v38",
        "Final generated V57 readiness must land before composition execution",
    )
    return generated.RELEASE_PREFLIGHT_RPC


def require_final_database(local, database):
    from app.services.release_schema_readiness import validate_release_schema_preflight

    rpc = require_final_declarations()
    row = json.loads(
        local.sql(database, f"SELECT row_to_json(p) FROM public.{rpc}() p;")
    )
    validate_release_schema_preflight(row)


def snapshot(local, database):
    """Fingerprint schema contracts and all fixture-bearing rows without logging them."""
    tables = json.loads(
        local.sql(
            database,
            """SELECT coalesce(json_agg(quote_ident(n.nspname)||'.'||quote_ident(c.relname) ORDER BY n.nspname,c.relname),'[]')
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname IN ('public','private','auth','supabase_migrations') AND c.relkind='r';""",
        )
    )
    digest = hashlib.sha256()
    functions = """SELECT coalesce(json_agg(pg_get_functiondef(p.oid) ORDER BY n.nspname,p.proname,pg_get_function_identity_arguments(p.oid)),'[]') FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('public','private','auth') AND p.prokind='f';"""
    for statement in (ACL_SQL, CONSTRAINT_SQL, functions):
        digest.update(local.sql(database, statement).encode())
    for table in tables:
        digest.update(table.encode())
        digest.update(
            local.sql(
                database,
                f"SELECT md5(coalesce(string_agg(row_to_json(t)::text,'|' ORDER BY row_to_json(t)::text),'')) FROM {table} t;",
            ).encode()
        )
    return digest.hexdigest()


@contextmanager
def owned_clone(local, template):
    require(
        re.fullmatch(r"koaryu_[a-z0-9_]*v57[a-z0-9_]*", template) is not None
        and len(template) <= 63,
        "Expected an explicit owned koaryu_*v57* template",
    )
    require_final_declarations()
    require_final_database(local, template)
    base_before, template_before = (
        snapshot(local, "postgres"),
        snapshot(local, template),
    )
    database = f"koaryu_application_{os.getpid()}_{uuid4().hex[:12]}"
    require(
        local.sql(
            "postgres",
            f"SELECT NOT EXISTS(SELECT 1 FROM pg_database WHERE datname={quote(database)});",
        )
        == "t",
        "Clone already exists",
    )
    owned = False
    try:
        local.sql("postgres", f"CREATE DATABASE {database} TEMPLATE {template};")
        owned = True
        require_final_database(local, database)
        yield database
    finally:
        if owned:
            local.sql("postgres", f"DROP DATABASE {database};")
            require(
                local.sql(
                    "postgres",
                    f"SELECT NOT EXISTS(SELECT 1 FROM pg_database WHERE datname={quote(database)});",
                )
                == "t",
                "Clone cleanup failed",
            )
        require(snapshot(local, "postgres") == base_before, "Base database changed")
        require(snapshot(local, template) == template_before, "Final template changed")


def rpc_contracts():
    """Only named application calls, with each accepted owner's argument contract."""
    from app.schemas import workflow_dispatch as dispatch
    from app.services import workflow_test_email_service as test
    from app.services.generated_release_readiness import RELEASE_PREFLIGHT_RPC

    scope = {"p_studio_id", "p_actor_id"}
    contracts = {
        RELEASE_PREFLIGHT_RPC: set(),
        "koaryu_release_schema_preflight_v38": set(),
        "get_automation_email_credential_v1": {"p_provider_key"},
        "save_automation_email_credential_v1": {
            "p_provider_key",
            "p_expected_revision",
            "p_encrypted_credentials",
        },
        "get_automation_sender_status_v1": {"p_provider_key"},
        "create_automation_workflow_v1": scope
        | {"p_operation_id", "p_name", "p_description", "p_graph", "p_layout"},
        "save_automation_workflow_v1": scope
        | {
            "p_workflow_id",
            "p_operation_id",
            "p_expected_revision",
            "p_name",
            "p_description",
            "p_graph",
            "p_layout",
        },
        "command_automation_workflow_v1": scope
        | {
            "p_workflow_id",
            "p_operation_id",
            "p_expected_revision",
            "p_action",
            "p_cancel_pending",
            "p_start_replay_only",
        },
        "get_automation_workflow_v1": scope | {"p_workflow_id"},
        "list_automation_workflows_v1": scope | {"p_limit", "p_cursor"},
        "get_automation_operation_v1": scope | {"p_operation_id"},
        "validate_automation_workflow_v1": scope | {"p_graph", "p_layout"},
        "get_automation_workflow_simulation_facts_v1": scope
        | {"p_workflow_id", "p_graph", "p_context"},
        "list_automation_workflow_runs_v1": scope
        | {"p_workflow_id", "p_limit", "p_cursor"},
        "get_automation_workflow_run_v1": scope | {"p_run_id"},
        "create_lead_atomic_v1": scope | {"p_operation_id", "p_request"},
        "mutate_lead_trial_appointment_v1": scope
        | {
            "p_lead_id",
            "p_appointment_id",
            "p_operation_id",
            "p_expected_revision",
            "p_request",
        },
        "get_lead_trial_appointment_v1": scope | {"p_lead_id", "p_appointment_id"},
        "mutate_belt_test_event_v1": scope
        | {"p_event_id", "p_operation_id", "p_expected_revision", "p_request"},
        "get_belt_test_event_v1": scope | {"p_event_id"},
        "approve_belt_test_recipients_v1": scope
        | {"p_event_id", "p_operation_id", "p_expected_event_revision", "p_recipients"},
        "get_belt_test_recipient_v1": scope | {"p_event_id", "p_recipient_id"},
        "process_automation_workflow_occurrences_v1": {"p_limit"},
        "enqueue_missed_class_automations_v1": {"p_limit", "p_allowed_recipients"},
        "claim_missed_class_automations_v1": {"p_limit", "p_allowed_recipients"},
        "clear_studio_operational_data_v2": {"p_studio_id", "p_include_platform_rows"},
    }
    for name, model in {
        "claim_automation_workflow_runs_v1": dispatch.ClaimRequest,
        "advance_automation_workflow_run_v1": dispatch.AdvanceRequest,
        "defer_automation_workflow_run_v1": dispatch.DeferRequest,
        "get_workflow_email_plan_v1": dispatch.PlanRequest,
        "resolve_workflow_email_without_attempt_v1": dispatch.ResolveRequest,
        "begin_workflow_email_v1": dispatch.BeginRequest,
        "settle_workflow_email_v1": dispatch.SettleRequest,
        "claim_automation_sender_preparation_v1": dispatch.PreparationClaimRequest,
        "settle_automation_sender_preparation_v1": dispatch.PreparationSettleRequest,
        test.CREATE: test.ReserveRequest,
        test.PREPARE: test.PreparationRequest,
        test.FINISH: test.FinishRequest,
        test.BEGIN: test.BeginRequest,
        test.SETTLE: test.SettleRequest,
        test.CURRENT: test.CurrentRequest,
    }.items():
        contracts[name] = set(model.model_fields)
    return contracts


class SqlBridge:
    """Installed SDK HTTP I/O boundary, not a REST table-write emulator."""

    def __init__(self, sql, ids):
        self.sql, self.ids = sql, ids
        self.contracts = rpc_contracts()
        self.calls = []
        self.lose_reply = None
        self.sql("""CREATE SCHEMA application_composition_proof;
GRANT USAGE ON SCHEMA application_composition_proof TO service_role;
CREATE FUNCTION application_composition_proof.rpc(statement text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE payload jsonb; code text; message text;
BEGIN
 EXECUTE statement INTO payload;
 RETURN jsonb_build_object('ok',true,'data',payload);
EXCEPTION WHEN OTHERS THEN
 GET STACKED DIAGNOSTICS code=RETURNED_SQLSTATE,message=MESSAGE_TEXT;
 RETURN jsonb_build_object('ok',false,'code',code,'message',message);
END $$;
GRANT EXECUTE ON FUNCTION application_composition_proof.rpc(text) TO service_role;""")

    def __call__(self, request):
        import httpx
        from app.services.studio_scope import STAFF_ROLE_MEMBERSHIP_COLUMNS

        require(
            request.url.host == "composition.example.invalid", "Unexpected SDK host"
        )
        path = request.url.path
        if path.startswith("/rest/v1/rpc/"):
            name = path.removeprefix("/rest/v1/rpc/")
            params = json.loads(request.content)
            require(
                request.method == "POST"
                and not request.url.query
                and name in self.contracts
                and type(params) is dict
                and set(params) == self.contracts[name],
                "Unexpected RPC request contract",
            )
            args = ",".join(
                key + "=>" + rpc_value(key, value) for key, value in params.items()
            )
            statement = f"SELECT public.{name}({args})"
            if name.startswith("koaryu_release_schema_preflight_"):
                statement = f"SELECT row_to_json(p) FROM public.{name}() p"
            result = json.loads(
                self.sql(
                    "SET ROLE service_role;SELECT application_composition_proof.rpc("
                    + quote(statement)
                    + ");"
                )
            )
            self.calls.append(name)
            if result["ok"]:
                if self.lose_reply == name:
                    self.lose_reply = None
                    raise httpx.ReadTimeout(
                        "Synthetic reply lost after SQL commit", request=request
                    )
                return httpx.Response(200, json=result["data"])
            return httpx.Response(
                400,
                json={
                    "code": result["code"],
                    "message": result["message"],
                    "details": None,
                    "hint": None,
                },
            )
        require(request.method == "GET", "Only exact read requests supported")
        params = dict(request.url.params)
        require(
            len(params) == len(request.url.params.multi_items()),
            "Repeated filters refused",
        )
        actor, studio = self.ids["actor"], self.ids["studio"]
        if path == f"/auth/v1/admin/users/{actor}":
            require(not params, "Unexpected Auth query")
            data = json.loads(
                self.sql(
                    f"SELECT json_build_object('id',id,'email',email,'email_confirmed_at',email_confirmed_at,'aud','authenticated','role','authenticated','created_at',created_at,'app_metadata',raw_app_meta_data,'user_metadata',raw_user_meta_data) FROM auth.users WHERE id={quote(actor)};"
                )
            )
            return httpx.Response(200, json=data)
        table = path.removeprefix("/rest/v1/")
        if table == "staff_roles":
            require(
                params
                == {
                    "select": STAFF_ROLE_MEMBERSHIP_COLUMNS,
                    "user_id": "eq." + actor,
                    "order": "created_at.desc",
                },
                "Unexpected membership query",
            )
            query = f"SELECT studio_id,role,created_at,archived_at FROM public.staff_roles WHERE user_id={quote(actor)} ORDER BY created_at DESC"
        elif table == "studio_subscriptions":
            require(
                params == {"select": "*", "studio_id": "eq." + studio},
                "Unexpected entitlement query",
            )
            query = f"SELECT * FROM public.studio_subscriptions WHERE studio_id={quote(studio)}"
        elif table == "studios":
            require(
                params == {"select": "name", "id": "eq." + studio},
                "Unexpected studio query",
            )
            query = f"SELECT name FROM public.studios WHERE id={quote(studio)}"
        else:
            require(
                table
                in {"students", "leads", "belt_ranks", "class_sessions", "attendance"}
                and params == {"select": "id", "studio_id": "eq." + studio},
                "Unexpected table read",
            )
            query = f"SELECT id FROM public.{table} WHERE studio_id={quote(studio)}"
        rows = json.loads(
            self.sql(
                f"SET ROLE service_role;SELECT coalesce(json_agg(r),'[]') FROM ({query}) r;"
            )
        )
        self.calls.append(table)
        if "application/vnd.pgrst.object+json" in request.headers.get("accept", ""):
            if len(rows) != 1:
                return httpx.Response(
                    406,
                    json={
                        "code": "PGRST116",
                        "message": "Single row required",
                        "details": None,
                        "hint": None,
                    },
                )
            rows = rows[0]
        return httpx.Response(200, json=rows)

    def client(self, *, postgrest_client_timeout=5.0):
        import httpx
        from supabase.lib.client_options import ClientOptions

        from supabase import create_client

        client = create_client(
            "https://composition.example.invalid",
            "header.payload.signature",
            options=ClientOptions(postgrest_client_timeout=postgrest_client_timeout),
        )
        for session in (client.postgrest.session, client.auth.admin._http_client):
            session._transport = httpx.MockTransport(self)
            session._mounts = {}
            session.follow_redirects = False
        return client


def seed_base(sql):
    ids = {key: str(uuid4()) for key in ("actor", "studio", "program")}
    actor, studio, program = (ids[key] for key in ("actor", "studio", "program"))
    # Complete synthetic subscription, deliberately satisfying real access checks.
    sql(f"""BEGIN;
INSERT INTO auth.users(id,email,email_confirmed_at,created_at,raw_app_meta_data,raw_user_meta_data)
 VALUES('{actor}','actor@example.invalid',clock_timestamp(),clock_timestamp(),'{{}}','{{}}');
INSERT INTO public.studios(id,name,slug,owner_id,timezone) VALUES('{studio}','Composition fixture','{studio}','{actor}','UTC');
INSERT INTO public.staff_roles(studio_id,user_id,role) VALUES('{studio}','{actor}','admin');
INSERT INTO public.studio_subscriptions(studio_id,status,comped,stripe_customer_id,stripe_subscription_id,current_period_start,current_period_end)
 VALUES('{studio}','active',false,'cus_composition_fixture','sub_composition_fixture',clock_timestamp()-interval '1 day',clock_timestamp()+interval '30 days');
INSERT INTO public.programs(id,studio_id,name) VALUES('{program}','{studio}','Composition program');
COMMIT;""")
    return ids


def future_window():
    start = (datetime.now(timezone.utc) + timedelta(days=7)).replace(microsecond=0)
    return {
        "starts_at": start.isoformat(),
        "ends_at": (start + timedelta(hours=1)).isoformat(),
        "timezone": "UTC",
    }


def display_instant(value):
    return (
        datetime.fromisoformat(value.replace("Z", "+00:00")).isoformat(sep=" ")
        + " [UTC]"
    )


def seed_representative_prerequisites(sql, ids):
    """Trusted source prerequisites only; deferred owners establish their context."""
    sources = {
        key: str(uuid4()) for key in ("ladder", "rank", "student", "payer", "invoice")
    }
    studio, program = ids["studio"], ids["program"]
    ladder, rank, student, payer, invoice = (
        sources[key] for key in ("ladder", "rank", "student", "payer", "invoice")
    )
    account, customer = "acct_" + studio.replace("-", ""), "cus_" + payer
    sql(f"""BEGIN;
INSERT INTO public.belt_ladders(id,studio_id,name,program_id) VALUES('{ladder}','{studio}','Composition ladder',NULL);
INSERT INTO public.belt_ranks(id,studio_id,ladder_id,name,display_order,min_classes,min_months)
 VALUES('{rank}','{studio}','{ladder}','White',0,0,0);
INSERT INTO public.students(id,studio_id,legal_first_name,legal_last_name,status,email,program_id,current_belt_rank_id,membership_start_date,is_minor,date_of_birth)
 VALUES('{student}','{studio}','Student','Person','active','student@example.invalid','{program}',NULL,CURRENT_DATE-120,false,'1990-01-01');
INSERT INTO public.studio_payment_accounts(studio_id,stripe_connected_account_id,metadata)
 VALUES('{studio}','{account}','{{"connect_account_generation":1}}');
INSERT INTO public.billing_payers(id,studio_id,display_name,email,stripe_account_id,stripe_customer_id,connect_account_generation)
 VALUES('{payer}','{studio}','Composition payer','payer@example.invalid','{account}','{customer}',1);
INSERT INTO public.billing_invoices(id,studio_id,payer_id,status,currency,amount_due_cents,amount_paid_cents,amount_remaining_cents,due_date,
 invoice_number,collection_method,stripe_account_id,stripe_customer_id,stripe_invoice_id,metadata)
 VALUES('{invoice}','{studio}','{payer}','open','usd',1234,0,1234,CURRENT_DATE+7,
 'COMPOSITION-1','send_invoice','{account}','{customer}','in_{invoice}','{{"connect_account_generation":1}}');
COMMIT;""")
    return sources


def settings_for(ids):
    from cryptography.fernet import Fernet

    return SimpleNamespace(
        ENVIRONMENT="production",
        AUTOMATION_WORKER_ENABLED=True,
        EMAIL_PROVIDER="microsoft_graph",
        EMAIL_SEND_ENABLED=True,
        EMAIL_FROM_ADDRESS="sender@example.invalid",
        EMAIL_FROM_NAME="Composition",
        EMAIL_REPLY_TO="sender@example.invalid",
        EMAIL_ALLOWED_RECIPIENTS="",
        EMAIL_GRAPH_CLIENT_ID="b31866c9-dfc5-47a7-9889-bb2c98359911",
        EMAIL_GRAPH_CLIENT_SECRET="synthetic-only",
        EMAIL_GRAPH_TENANT="consumers",
        EMAIL_TOKEN_ENCRYPTION_KEY=Fernet.generate_key().decode(),
        AUTOMATION_PUBLIC_API_URL="https://api.example.invalid/api/v1",
        DEMO_RESET_ENABLED=True,
        DEMO_RESET_STUDIO_IDS=ids["studio"],
    )


def graph(event="lead.created"):
    recipient, subject, body = {
        "lead.created": (
            "lead_or_guardian",
            "Hello {{recipient_name}}",
            "A message from {{studio_name}}.",
        ),
        "trial.scheduled": (
            "lead_or_guardian",
            "Trial {{trial_start}}",
            "Location: {{trial_location}}",
        ),
        "belt_test.approved": (
            "student_or_guardian",
            "Invitation to {{event_name}}",
            "At {{event_start}} in {{event_location}}",
        ),
        "invoice.payment_failed": (
            "invoice_payer",
            "Invoice {{invoice_number}}",
            "Balance: {{invoice_balance}}",
        ),
    }[event]
    return {
        "schema_version": 1,
        "nodes": [
            {
                "id": "trigger",
                "type": "trigger",
                "config": {"event_type": event},
            },
            {
                "id": "email",
                "type": "email",
                "config": {
                    "recipient": recipient,
                    "subject_template": subject,
                    "body_template": body,
                    "reply_to_email": "",
                },
            },
            {"id": "end", "type": "end", "config": {}},
        ],
        "edges": [
            {"id": "a", "source": "trigger", "target": "email", "port": "next"},
            {"id": "b", "source": "email", "target": "end", "port": "next"},
        ],
    }


@contextmanager
def application(bridge, settings, transport_factory):
    from app.api.v1.endpoints import (
        belt_test_recipients,
        belt_tests,
        demo,
        leads,
        trial_appointments,
        workflow_management,
        workflow_runs,
        workflow_simulation,
        workflow_test_email,
    )
    from app.core.deps import get_current_user_id, get_supabase
    from app.core.error_handlers import register_error_handlers
    from app.db.supabase import close_supabase_client
    from app.services import (
        platform_billing_service,
        studio_scope,
        workflow_test_email_service,
    )
    from fastapi import FastAPI, Header, HTTPException
    from fastapi.testclient import TestClient

    app = FastAPI()
    for module in (
        demo,
        trial_appointments,
        belt_tests,
        belt_test_recipients,
        leads,
        workflow_management,
        workflow_runs,
        workflow_simulation,
        workflow_test_email,
    ):
        app.include_router(module.router, prefix="/api/v1")
    app.include_router(trial_appointments.detail_router, prefix="/api/v1")
    app.include_router(belt_test_recipients.detail_router, prefix="/api/v1")
    register_error_handlers(app)

    def synthetic_identity(authorization: str = Header()):
        if authorization != "Bearer composition-synthetic-token":
            raise HTTPException(401, "Synthetic identity required")
        return bridge.ids["actor"]

    def create_test(*args, **kwargs):
        return workflow_test_email_service.create_workflow_test_email(
            *args,
            **kwargs,
            client_factory=bridge.client,
            transport_factory=transport_factory,
        )

    def read_test(*args, **kwargs):
        return workflow_test_email_service.get_workflow_test_email(
            *args, **kwargs, client_factory=bridge.client
        )

    client = bridge.client()
    try:
        app.dependency_overrides[get_current_user_id] = synthetic_identity
        app.dependency_overrides[get_supabase] = lambda: client
        with ExitStack() as stack:
            for module in (
                demo,
                workflow_management,
                workflow_test_email,
                platform_billing_service,
                studio_scope,
            ):
                stack.enter_context(
                    patch.object(module, "get_settings", lambda: settings)
                )
            stack.enter_context(
                patch.object(
                    workflow_test_email, "create_workflow_test_email", create_test
                )
            )
            stack.enter_context(
                patch.object(workflow_test_email, "get_workflow_test_email", read_test)
            )
            with TestClient(app) as http:
                http.headers.update(
                    {
                        "Authorization": "Bearer composition-synthetic-token",
                        "X-Studio-Id": bridge.ids["studio"],
                    }
                )
                yield http
    finally:
        close_supabase_client(client)


def journey(sql, *, serve=None):
    import httpx
    from app.db.supabase import close_supabase_client
    from app.services.automation_coordinator import process_automation_batch
    from app.services.automation_email_credentials import (
        CredentialCodec,
        CredentialRepository,
        CredentialState,
    )
    from app.services.automation_service import WORK_BUDGET_SECONDS
    from app.services.microsoft_graph_email import (
        GRAPH_SEND_URL,
        MicrosoftGraphEmailTransport,
    )

    ids = seed_base(sql)
    settings = settings_for(ids)
    bridge = SqlBridge(sql, ids)
    credential_client = bridge.client()
    try:
        CredentialRepository(
            credential_client,
            CredentialCodec(
                settings.EMAIL_TOKEN_ENCRYPTION_KEY,
                settings.EMAIL_GRAPH_CLIENT_ID,
                settings.EMAIL_FROM_ADDRESS,
            ),
        ).save(
            CredentialState(
                settings.EMAIL_GRAPH_CLIENT_ID,
                settings.EMAIL_FROM_ADDRESS,
                "synthetic-refresh-only",
                "synthetic-access-only",
                time.time() + 3600,
            ),
            expected_revision=0,
        )
    finally:
        close_supabase_client(credential_client)
    submissions = []
    ambiguous = False
    expected_recipient = "lead@example.invalid"

    def graph_io(request):
        require(
            str(request.url) == GRAPH_SEND_URL and request.method == "POST",
            "Unexpected Graph request",
        )
        message = json.loads(request.content)["message"]
        require(
            message["toRecipients"]
            == [{"emailAddress": {"address": expected_recipient}}],
            "Unexpected recipient",
        )
        submissions.append(message)
        if ambiguous:
            raise httpx.ReadTimeout("Synthetic ambiguous submission", request=request)
        return httpx.Response(202, headers={"request-id": str(uuid4())})

    def transport(settings, client):
        return MicrosoftGraphEmailTransport(
            settings,
            client,
            client_factory=lambda **kwargs: httpx.Client(
                transport=httpx.MockTransport(graph_io), **kwargs
            ),
        )

    with application(bridge, settings, transport) as http:
        if serve is not None:
            expected_recipient = "actor@example.invalid"
            return serve_application(http, ids, serve)

        def request(method, path, expected=200, **kwargs):
            reply = http.request(method, "/api/v1" + path, **kwargs)
            require(
                reply.status_code == expected,
                f"Composition HTTP {method} {path.split('/')[1]} returned {reply.status_code}, expected {expected}",
            )
            return reply.json()

        catalog = request("GET", "/automations/catalog")
        require(
            catalog["capabilities"]["can_start"]
            and catalog["capabilities"]["can_test_email"],
            "Actual capability gate unavailable",
        )
        # Created before lead.created activation, so this fixture cannot enroll
        # in the welcome workflow or consume its later trial spacing reservation.
        trial_lead = request(
            "POST",
            "/leads",
            expected=201,
            json={
                "operation_id": str(uuid4()),
                "first_name": "Trial",
                "last_name": "Lead",
                "email": "trial@example.invalid",
                "program_id": ids["program"],
            },
        )
        operation = str(uuid4())
        body = {
            "operation_id": operation,
            "name": "Composition welcome",
            "description": "",
            "graph": graph(),
            "layout": {},
        }
        bridge.lose_reply = "create_automation_workflow_v1"
        request("POST", "/automations/workflows", expected=503, json=body)
        receipt = request("GET", "/automations/operations/" + operation)
        require(
            receipt["state"] == "committed",
            "Lost create did not recover committed receipt",
        )
        workflow = request("GET", "/automations/workflows/" + receipt["entity_id"])
        route = "/automations/workflows/" + workflow["id"]
        replay = request("POST", "/automations/workflows", expected=201, json=body)
        require(replay["id"] == workflow["id"], "Create replay duplicated workflow")
        for action in ("publish", "start"):
            workflow = request(
                "POST",
                route + "/" + action,
                json={
                    "operation_id": str(uuid4()),
                    "expected_revision": workflow["revision"],
                },
            )
        lead = request(
            "POST",
            "/leads",
            expected=201,
            json={
                "operation_id": str(uuid4()),
                "first_name": "Synthetic",
                "last_name": "Lead",
                "email": "lead@example.invalid",
                "program_id": ids["program"],
            },
        )
        require(bool(lead["id"]), "Lead command returned no identity")
        processed = process_automation_batch(
            settings,
            first_engine="attendance",
            deadline_monotonic=time.monotonic() + WORK_BUDGET_SECONDS,
            client_factory=bridge.client,
            transport_factory=transport,
        )
        require(
            processed.workflows is not None
            and processed.workflows.accepted == 1
            and processed.attendance is not None
            and processed.attendance.processed == 0
            and len(submissions) == 1,
            "Lead email was not accepted once",
        )
        runs = request("GET", route + "/runs")
        require(len(runs["items"]) == 1, "Expected one captured lead run")
        history = request("GET", "/automations/runs/" + runs["items"][0]["id"])
        require(
            len(history["attempts"]) == 1
            and history["attempts"][0]["state"] == "accepted",
            "Actual run history did not record acceptance",
        )

        def activate(event):
            value = request(
                "POST",
                "/automations/workflows",
                expected=201,
                json={
                    "operation_id": str(uuid4()),
                    "name": "Composition " + event,
                    "description": "",
                    "graph": graph(event),
                    "layout": {},
                },
            )
            event_route = "/automations/workflows/" + value["id"]
            for action in ("publish", "start"):
                value = request(
                    "POST",
                    event_route + "/" + action,
                    json={
                        "operation_id": str(uuid4()),
                        "expected_revision": value["revision"],
                    },
                )
            return event_route

        def accepted(event_route, recipient, fragments, event_type, subject_id):
            nonlocal expected_recipient
            expected_recipient = recipient
            before_send = len(submissions)
            result = process_automation_batch(
                settings,
                first_engine="attendance",
                deadline_monotonic=time.monotonic() + WORK_BUDGET_SECONDS,
                client_factory=bridge.client,
                transport_factory=transport,
            )
            require(
                result.workflows is not None
                and result.workflows.accepted == 1
                and len(submissions) == before_send + 1,
                "Representative delivery not accepted once",
            )
            message = submissions[-1]
            rendered = message["subject"] + "\n" + message["body"]["content"]
            require(
                all(fragment in rendered for fragment in fragments),
                "Saved source rendering differs",
            )
            captured = request("GET", event_route + "/runs")["items"]
            require(
                len(captured) == 1
                and captured[0]["event_type"] == event_type
                and captured[0]["subject_id"] == subject_id,
                "Expected one captured run for the exact source event",
            )
            detail = request("GET", "/automations/runs/" + captured[0]["id"])
            require(
                len(detail["attempts"]) == 1
                and detail["attempts"][0]["state"] == "accepted",
                "Representative attempt history missing",
            )

        window = future_window()
        trial_route = activate("trial.scheduled")
        appointment = request(
            "POST",
            "/leads/" + trial_lead["id"] + "/trial-appointments",
            expected=201,
            json={
                "operation_id": str(uuid4()),
                **window,
                "location": "Trial room",
                "program_id": ids["program"],
            },
        )
        require(
            request(
                "GET",
                "/leads/"
                + trial_lead["id"]
                + "/trial-appointments/"
                + appointment["id"],
            )
            == appointment
            and appointment["revision"] == 1
            and appointment["lead_id"] == trial_lead["id"],
            "Exact trial identity/revision differs",
        )
        accepted(
            trial_route,
            "trial@example.invalid",
            [display_instant(appointment["starts_at"]), "Trial room"],
            "trial.scheduled",
            appointment["id"],
        )

        sources = seed_representative_prerequisites(sql, ids)
        belt_route = activate("belt_test.approved")
        event = request(
            "POST",
            "/belt-tests",
            expected=201,
            json={
                "operation_id": str(uuid4()),
                "name": "Composition belt test",
                "ladder_id": sources["ladder"],
                **window,
                "location": "Belt room",
                "status": "scheduled",
            },
        )
        event_path = "/belt-tests/" + event["id"]
        approval = request(
            "POST",
            event_path + "/recipients/approve",
            json={
                "operation_id": str(uuid4()),
                "expected_event_revision": event["revision"],
                "recipients": [
                    {
                        "student_id": sources["student"],
                        "student_program_membership_id": None,
                    }
                ],
            },
        )
        recipient = approval["items"][0]
        require(
            request("GET", event_path) == event
            and approval["event_revision"] == event["revision"]
            and recipient["revision"] == 1
            and recipient["state"] == "approved"
            and request("GET", event_path + "/recipients/" + recipient["id"])
            == recipient,
            "Belt approval changed event revision or exact recipient differs",
        )
        accepted(
            belt_route,
            "student@example.invalid",
            [event["name"], display_instant(event["starts_at"])],
            "belt_test.approved",
            recipient["id"],
        )
        require(
            sql(
                f"SELECT current_belt_rank_id IS NULL FROM public.students WHERE id={quote(sources['student'])};"
            )
            == "t",
            "Belt approval changed current rank",
        )

        payment_route = activate("invoice.payment_failed")
        # A fresh real billing row invokes the capture trigger. No private event,
        # invoice episode or overdue history is manufactured by this runner.
        payment = str(uuid4())
        sql(f"""INSERT INTO public.billing_payments(
 id,studio_id,payer_id,invoice_id,status,amount_cents,currency,stripe_account_id,
 stripe_customer_id,stripe_invoice_id,connect_account_generation,payment_method_type,idempotency_key)
 SELECT '{payment}',studio_id,payer_id,id,'failed',1234,'usd',stripe_account_id,
 stripe_customer_id,stripe_invoice_id,1,'card','{payment}' FROM public.billing_invoices
 WHERE id={quote(sources["invoice"])};""")
        accepted(
            payment_route,
            "payer@example.invalid",
            ["COMPOSITION-1", "USD 12.34"],
            "invoice.payment_failed",
            payment,
        )
        require(
            sql(
                f"SELECT count(*) FROM public.billing_payments WHERE id='{payment}' AND invoice_id={quote(sources['invoice'])};"
            )
            == "1",
            "Payment is not linked to the fixture invoice",
        )

        test_body = {
            "operation_id": str(uuid4()),
            "email_node_id": "email",
            "graph": graph(),
        }
        expected_recipient = "actor@example.invalid"
        tested = request("POST", route + "/test-email", json=test_body)
        require(
            tested["state"] == "accepted"
            and submissions[-1]["subject"].startswith("[Test] "),
            "Synthetic test label/result missing",
        )
        queued = request("GET", "/automations/operations/" + test_body["operation_id"])
        require(
            queued["result"]["state"] == "queued",
            "Test receipt must preserve original queued acknowledgment",
        )
        current = request(
            "GET", "/automations/test-deliveries/" + tested["test_delivery_id"]
        )
        require(current == tested, "Current test result differs")
        # Real Auth source change gives this new operation a distinct recipient;
        # existing SQL attempts and spacing reservations are never rewritten.
        sql(
            f"UPDATE auth.users SET email='unknown@example.invalid',email_confirmed_at=clock_timestamp() WHERE id={quote(ids['actor'])};"
        )
        expected_recipient = "unknown@example.invalid"
        ambiguous = True
        test_body["operation_id"] = str(uuid4())
        unknown = request("POST", route + "/test-email", json=test_body)
        require(unknown["state"] == "unknown", "Ambiguous submission was not unknown")
        before = len(submissions)
        require(
            request("POST", route + "/test-email", json=test_body) == unknown,
            "Unknown replay changed truth",
        )
        require(
            request(
                "GET", "/automations/test-deliveries/" + unknown["test_delivery_id"]
            )
            == unknown
            and len(submissions) == before,
            "Unknown submission resent",
        )
        cleared = request(
            "DELETE",
            "/demo/data",
            headers={"X-Koaryu-Destructive-Action": "clear-studio-data"},
        )
        require(
            cleared["counts"]["leads"] == 2
            and cleared["counts"]["students"] == 1
            and cleared["counts"]["belt_ranks"] == 1
            and cleared["automation"]["workflows_paused"] == 4,
            "Clear effects missing actual lead/workflow",
        )
        require(
            sql(
                f"SELECT count(*) FROM public.leads WHERE studio_id={quote(ids['studio'])};"
            )
            == "0",
            "Clear retained lead",
        )
        require(
            request("GET", route)["status"] == "paused", "Clear left workflow active"
        )
        require(
            request("GET", "/automations/test-deliveries/" + tested["test_delivery_id"])
            == tested,
            "Clear changed accepted test truth",
        )
        require(
            request(
                "GET", "/automations/test-deliveries/" + unknown["test_delivery_id"]
            )
            == unknown,
            "Clear changed unknown test truth",
        )
        require(
            request("GET", "/automations/operations/" + queued["operation_id"])
            == queued,
            "Clear rewrote original queued receipt",
        )
        retained = request("GET", "/automations/runs/" + runs["items"][0]["id"])
        require(
            retained["attempts"] == history["attempts"],
            "Clear changed retained attempt history",
        )
        require(len(submissions) == before, "Clear or history lookup resent mail")

    return {
        "journeys": [
            "lost committed create receipt/current",
            "lead capture/render/Graph acceptance/history",
            "trial scheduled HTTP/capture/render/Graph acceptance",
            "belt approval HTTP/capture/render/Graph acceptance",
            "fresh payment failure trigger/render/Graph acceptance",
            "test queued receipt/current",
            "unknown submission replay without resend",
            "clear actual effects",
        ],
        "synthetic_boundaries": [
            "external bearer identity",
            "Graph MockTransport",
            "base records and encrypted credentials",
        ],
        "unproven_remaining_joins": ["served UI"],
    }


MAX_REQUEST_BYTES = 1024 * 1024
UUID_PATH = (
    r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
)
SERVED_ROUTES = {
    "GET": [
        r"/automations/catalog",
        r"/automations/workflows",
        rf"/automations/workflows/{UUID_PATH}(?:/runs)?",
        rf"/automations/(?:runs|operations|test-deliveries)/{UUID_PATH}",
    ],
    "POST": [
        r"/automations/workflows",
        r"/automations/workflows/validate",
        rf"/automations/workflows/{UUID_PATH}/(?:publish|start|pause|archive|simulate|test-email)",
    ],
    "PUT": [rf"/automations/workflows/{UUID_PATH}"],
}


def forward_served_request(http, method, target, headers, body):
    """Forward the bounded fixture API unchanged, including errors and unknowns."""
    parsed = urlsplit(target)
    require(
        not parsed.scheme
        and not parsed.netloc
        and not parsed.fragment
        and parsed.path.startswith("/api/v1/"),
        "Unexpected served destination",
    )
    path = parsed.path.removeprefix("/api/v1")
    require(
        any(re.fullmatch(route, path) for route in SERVED_ROUTES.get(method, [])),
        "Unexpected served method/path",
    )
    require(len(body) <= MAX_REQUEST_BYTES, "Served request exceeds 1 MiB")
    supported = {"authorization", "x-studio-id", "content-type", "accept", "cookie"}
    forwarded = {
        key: value for key, value in headers.items() if key.lower() in supported
    }
    # TestClient's journey defaults must never fill a browser's missing identity.
    require(
        not http.headers.get("Authorization") and not http.headers.get("X-Studio-Id"),
        "Served client must not inject owner headers",
    )
    response = http.request(
        method, target, headers=forwarded, content=body, follow_redirects=False
    )
    require(not 300 <= response.status_code < 400, "Served redirect refused")
    return response


def serve_application(http, ids, options):
    """Fresh clone, same actual application, finite loopback fixture lifetime."""
    http.headers.clear()
    observations = []
    html = b""
    handled = 0

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def handle_one_request(self):
            nonlocal handled
            handled += 1
            self.connection.settimeout(5)
            super().handle_one_request()

        def dispatch(self):
            self.close_connection = True
            if (
                self.headers.get("Host") != address
                or self.headers.get("Origin", origin) != origin
            ):
                self.send_error(403)
                return
            length = self.headers.get("Content-Length", "0")
            if self.headers.get("Transfer-Encoding") or not length.isdecimal():
                self.send_error(400)
                return
            if int(length) > MAX_REQUEST_BYTES:
                self.send_error(413)
                return
            body = self.rfile.read(int(length))
            if len(body) != int(length):
                self.send_error(400)
                return
            if self.command == "GET" and self.path == "/" and not body:
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                payload = html
            else:
                try:
                    response = forward_served_request(
                        http, self.command, self.path, self.headers, body
                    )
                except RuntimeError:
                    self.send_error(400)
                    return
                observations.append(
                    {
                        "method": self.command,
                        "path": urlsplit(self.path).path,
                        "status": response.status_code,
                        "matching_studio_header": self.headers.get("X-Studio-Id")
                        == ids["studio"],
                    }
                )
                self.send_response(response.status_code)
                for key, value in response.headers.multi_items():
                    if key.lower() not in {
                        "content-length",
                        "transfer-encoding",
                        "connection",
                    }:
                        self.send_header(key, value)
                payload = response.content
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(payload)

        do_GET = do_POST = do_PUT = do_DELETE = do_PATCH = do_OPTIONS = dispatch

    # Loopback and an ephemeral port are fixed, not caller-controlled bind targets.
    with HTTPServer(("127.0.0.1", 0), Handler) as server:
        server.timeout = 0.5
        address = f"127.0.0.1:{server.server_port}"
        origin = "http://" + address
        result = subprocess.run(
            [
                options.node,
                str(ROOT / "frontend/tests/helpers/workflow-composition-mounted.mjs"),
                "--proof-html",
            ],
            input=json.dumps(
                {
                    "apiUrl": origin + "/api/v1",
                    "actorId": ids["actor"],
                    "studioId": ids["studio"],
                    "token": "composition-synthetic-token",
                }
            ),
            capture_output=True,
            text=True,
            timeout=60,
            check=True,
        )
        html = result.stdout.encode()
        require(html.startswith(b"<!doctype html>"), "Fixture HTML was not produced")
        print(
            json.dumps(
                {
                    "fixture_url": origin,
                    "synthetic_boundaries": [
                        "Auth",
                        "Graph MockTransport",
                        "picker collections",
                    ],
                    "expires_in_seconds": options.seconds,
                }
            ),
            flush=True,
        )
        deadline = time.monotonic() + options.seconds
        stopping = False

        def stop(_signum, _frame):
            nonlocal stopping
            stopping = True

        previous = {
            sig: signal.signal(sig, stop) for sig in (signal.SIGINT, signal.SIGTERM)
        }
        try:
            while handled < options.max_requests:
                if stopping or time.monotonic() >= deadline:
                    break
                server.handle_request()
        finally:
            for sig, handler in previous.items():
                signal.signal(sig, handler)
    return {
        "mode": "served",
        "requests": observations,
        "unproven_remaining_joins": [
            "UI assertions require the separate browser proof"
        ],
    }


def main(arguments=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--psql", required=True)
    parser.add_argument("--socket", required=True)
    parser.add_argument("--port", required=True, choices=["5432"])
    parser.add_argument("--final-v57-template", required=True)
    parser.add_argument(
        "--serve",
        action="store_true",
        help="Serve a fresh fixture instead of running the automated journey",
    )
    parser.add_argument(
        "--node", default="node", help="Node 22+ executable used only by --serve"
    )
    parser.add_argument(
        "--serve-seconds",
        type=int,
        default=900,
        choices=range(1, 3601),
        metavar="1..3600",
    )
    parser.add_argument(
        "--serve-max-requests",
        type=int,
        default=4000,
        choices=range(1, 10001),
        metavar="1..10000",
    )
    args = parser.parse_args(arguments)
    configure_test_environment()
    require_final_declarations()
    local = LocalPostgres(
        args.psql, args.socket, args.port, str(Path(args.socket).parent)
    )
    with owned_clone(local, args.final_v57_template) as database:

        def sql(statement):
            try:
                return local.sql(
                    database,
                    "SET TIME ZONE 'UTC';SET standard_conforming_strings=on;"
                    + statement,
                )
            except Exception:  # noqa: BLE001 - Never print private SQL/provider diagnostics.
                raise RuntimeError(
                    "Composition SQL execution failed; private diagnostics withheld"
                ) from None

        serve = (
            SimpleNamespace(
                node=args.node,
                seconds=args.serve_seconds,
                max_requests=args.serve_max_requests,
            )
            if args.serve
            else None
        )
        evidence = journey(sql, serve=serve)
    print(
        json.dumps(
            {
                "outcome": "served_session_closed" if args.serve else "passed",
                "owned_clone_removed": True,
                "base_and_template_unchanged": True,
                **evidence,
            }
        )
    )


if __name__ == "__main__":
    try:
        main()
    except Exception:  # noqa: BLE001 - Never print private SQL/provider diagnostics.
        print(
            "Composition proof failed; no positive proof claimed. Private diagnostics withheld.",
            file=sys.stderr,
        )
        sys.exit(1)
