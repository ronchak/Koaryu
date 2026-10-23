import asyncio
import time
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import patch

import jwt
import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from test_mcp_read_query import STUDENT, A, B, Database, Select

from app.core.config import Settings
from app.core.security import get_user_id_from_token
from app.mcp_read.connections import authorize_read
from app.mcp_read.server import Runtime, Verifier, build_server

USER = "50000000-0000-0000-0000-000000000001"
CLIENT = "60000000-0000-0000-0000-000000000001"
CONNECTION = "70000000-0000-0000-0000-000000000001"
SESSION = "80000000-0000-0000-0000-000000000001"
RESOURCE = "http://testserver/mcp"
SECRET = "synthetic-test-signing-key-only-never-used-for-real-data"


class StateSelect(Select):
    def select(self, columns):
        if columns == "*":
            assert self.table_name == "studio_subscriptions"
            columns = ",".join(self.db.data[self.table_name][0])
        return super().select(columns)

    def maybe_single(self):
        self.single_result = True
        return self

    def update(self, changes):
        assert self.table_name == "mcp_connections", "Business writes are forbidden"
        assert set(changes) <= {"last_used_at", "last_tool", "last_dataset", "last_row_count"}
        self.changes = changes
        return self

    def execute(self):
        if hasattr(self, "changes"):
            self.db.operational_writes += 1
            for row in self.db.data[self.table_name]:
                if all(f(row) for f in self.filters):
                    row.update(self.changes)
            return SimpleNamespace(data=[])
        result = super().execute()
        if getattr(self, "single_result", False):
            return SimpleNamespace(data=result.data[0] if result.data else None)
        return result


class StateDatabase(Database):
    def __init__(self, data):
        super().__init__(data)
        self.operational_writes = 0

    def table(self, name):
        return StateSelect(self, name)


class FixtureRuntime(Runtime):
    def __init__(self, db):
        super().__init__()
        self.db = db

    async def run(self, operation):
        return operation(self.db)


@pytest.fixture
def settings():
    # testserver is an ASGI-test-only hostname; the deployed validator requires
    # HTTPS. Supply localhost for Settings validation and use that Host below.
    return Settings(
        _env_file=None,
        ENVIRONMENT="test",
        MCP_ENABLED=True,
        MCP_PUBLIC_URL="http://localhost:8001/mcp",
        SUPABASE_ALLOW_LEGACY_HS256=True,
        SUPABASE_JWT_SECRET=SECRET,
    )


def token(settings, **overrides):
    claims = {
        "sub": USER,
        "role": "authenticated",
        "aud": settings.MCP_PUBLIC_URL,
        "iss": settings.SUPABASE_URL + "/auth/v1",
        "iat": int(time.time()),
        "exp": int(time.time()) + 300,
        "client_id": CLIENT,
        "session_id": SESSION,
        "koaryu_connection_id": CONNECTION,
    }
    claims.update(overrides)
    return jwt.encode(claims, SECRET, algorithm="HS256"), claims


@pytest.fixture
def db(settings):
    return StateDatabase(
        {
            "mcp_connections": [
                {
                    "id": CONNECTION,
                    "user_id": USER,
                    "studio_id": A,
                    "client_id": CLIENT,
                    "client_name": "Test client",
                    "permissions": ["students", "schedule"],
                    "resource": settings.MCP_PUBLIC_URL,
                    "session_id": SESSION,
                    "expires_at": (datetime.now(UTC) + timedelta(days=1)).isoformat(),
                    "revoked_at": None,
                }
            ],
            "staff_roles": [
                {"user_id": USER, "studio_id": A, "role": "admin", "archived_at": None}
            ],
            "studios": [{"id": A, "name": "Synthetic Dojo", "timezone": "America/Los_Angeles"}],
            "studio_subscriptions": [
                {
                    "studio_id": A,
                    "status": "active",
                    "comped": True,
                    "trial_end": None,
                    "stripe_subscription_id": None,
                    "stripe_customer_id": None,
                    "current_period_start": None,
                    "current_period_end": None,
                }
            ],
            "students": [
                {"id": STUDENT, "studio_id": A, "legal_first_name": "Ari", "status": "active"},
                {"id": "foreign", "studio_id": B, "legal_first_name": "Foreign private record"},
            ],
        }
    )


@pytest.mark.parametrize(
    "mutation",
    ["revoke", "expire", "role", "archive", "session", "client", "connection", "subscription"],
)
def test_current_grant_and_membership_are_required(settings, db, mutation):
    _, claims = token(settings)
    assert authorize_read(db, claims, settings.MCP_PUBLIC_URL)["studio_id"] == A
    if mutation == "revoke":
        db.data["mcp_connections"][0]["revoked_at"] = datetime.now(UTC).isoformat()
    elif mutation == "expire":
        db.data["mcp_connections"][0]["expires_at"] = "2000-01-01T00:00:00Z"
    elif mutation == "role":
        db.data["staff_roles"][0]["role"] = "front_desk"
    elif mutation == "archive":
        db.data["staff_roles"][0]["archived_at"] = "2026-01-01"
    elif mutation in {"session", "client", "connection"}:
        claims[
            {"session": "session_id", "client": "client_id", "connection": "koaryu_connection_id"}[
                mutation
            ]
        ] = B
    else:
        db.data["studio_subscriptions"][0].update(status="canceled", comped=False)
    with pytest.raises(HTTPException):
        authorize_read(db, claims, settings.MCP_PUBLIC_URL)
    assert db.operational_writes == 0


def test_read_access_refuses_repair_instead_of_calling_stripe(settings, db):
    _, claims = token(settings)
    db.data["studio_subscriptions"][0].update(
        comped=False, stripe_customer_id="cus_synthetic", status="active"
    )
    with (
        patch(
            "app.services.platform_billing_service.StripeService",
            side_effect=AssertionError("No Stripe allowed"),
        ),
        pytest.raises(HTTPException),
    ):
        authorize_read(db, claims, settings.MCP_PUBLIC_URL)
    assert db.operational_writes == 0


@pytest.mark.parametrize("audience", ["authenticated", "http://other.example/mcp"])
def test_connector_rejects_other_audiences(settings, db, audience):
    encoded, _ = token(settings, aud=audience)
    assert asyncio.run(Verifier(settings, FixtureRuntime(db)).verify_token(encoded)) is None


@pytest.mark.parametrize("audience", ["authenticated", "http://localhost:8001/mcp"])
def test_normal_app_auth_rejects_oauth_even_through_development_fallback(settings, audience):
    encoded, _ = token(settings, aud=audience)
    with (
        patch("app.core.security.get_settings", return_value=settings),
        patch(
            "app.core.security.get_supabase_client",
            side_effect=AssertionError("OAuth must never reach fallback"),
        ),
        pytest.raises(HTTPException) as exc,
    ):
        get_user_id_from_token(encoded)
    assert exc.value.status_code == 401


@pytest.fixture
def client(settings, db):
    server, application = build_server(settings, FixtureRuntime(db))

    @asynccontextmanager
    async def lifespan(app):
        async with server.session_manager.run():
            yield

    wrapper = FastAPI(lifespan=lifespan)
    wrapper.mount("/", application)
    with TestClient(wrapper, base_url="http://localhost:8001") as client:
        yield client


def rpc(client, settings, method, params=None, **headers):
    encoded, _ = token(settings)
    return client.post(
        "/mcp",
        json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}},
        headers={
            "Authorization": "Bearer " + encoded,
            "Accept": "application/json, text/event-stream",
            "MCP-Protocol-Version": "2025-11-25",
            **headers,
        },
    )


def test_real_mcp_initialize_discover_and_read(client, settings, db):
    response = rpc(
        client,
        settings,
        "initialize",
        {
            "protocolVersion": "2025-11-25",
            "capabilities": {},
            "clientInfo": {"name": "integration-test", "version": "1"},
        },
    )
    assert response.status_code == 200, response.text
    assert response.json()["result"]["serverInfo"]["name"] == "Koaryu"
    tools = rpc(client, settings, "tools/list").json()["result"]["tools"]
    assert {t["name"] for t in tools} == {
        "get_context",
        "describe_data",
        "query_data",
        "get_record",
    }
    assert all(t["annotations"]["readOnlyHint"] is True for t in tools)
    response = rpc(
        client,
        settings,
        "tools/call",
        {
            "name": "query_data",
            "arguments": {"query": {"dataset": "students", "select": ["legal_first_name"]}},
        },
    )
    assert response.status_code == 200, response.text
    result = response.json()["result"]
    assert result.get("isError") is not True, result
    assert result["structuredContent"]["rows"] == [{"legal_first_name": "Ari"}]
    assert db.operational_writes == 1


def test_revoked_connection_cannot_even_list_tools(client, settings, db):
    assert rpc(client, settings, "tools/list").status_code == 200
    db.data["mcp_connections"][0]["revoked_at"] = "2026-10-01T00:00:00Z"
    assert rpc(client, settings, "tools/list").status_code == 401


def test_unknown_tools_and_unpermitted_fields_are_refused(client, settings):
    response = rpc(
        client,
        settings,
        "tools/call",
        {
            "name": "query_data",
            "arguments": {"query": {"dataset": "students", "select": ["email"]}},
        },
    )
    assert response.json()["result"]["isError"] is True
    response = rpc(
        client,
        settings,
        "tools/call",
        {"name": "run_sql", "arguments": {"sql": "delete from students"}},
    )
    assert response.json()["result"]["isError"] is True


def test_discovery_points_to_native_auth_and_exact_resource(client, settings):
    response = client.get("/.well-known/oauth-protected-resource/mcp")
    assert response.status_code == 200, response.text
    assert response.json()["resource"] == settings.MCP_PUBLIC_URL
    assert response.json()["authorization_servers"] == [settings.SUPABASE_URL + "/auth/v1"]
    assert response.headers["cache-control"] == "no-store"


def test_transport_refuses_wrong_origin_and_oversized_body(client, settings):
    assert rpc(client, settings, "tools/list", Origin="https://evil.example").status_code in {
        400,
        403,
        421,
    }
    response = rpc(
        client, settings, "tools/call", {"name": "query_data", "arguments": {"extra": "a" * 70_000}}
    )
    assert response.status_code == 413
