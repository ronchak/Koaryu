"""Native OAuth consent boundaries, with no hosted requests or credentials."""

import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock
from uuid import UUID

import httpx
import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from test_mcp_read_auth_transport import CLIENT, CONNECTION, USER

from app.api.v1.endpoints import mcp_connections as routes
from app.mcp_read import connections

AUTHORIZATION = UUID("10000000-0000-4000-8000-000000000001")
RESOURCE = "https://backend.example.invalid/mcp"
DETAILS = {
    "authorization_id": str(AUTHORIZATION),
    "user": {"id": USER},
    "client": {"id": CLIENT, "name": "Synthetic assistant"},
    "redirect_uri": "https://assistant.example.invalid/callback",
    "scope": "offline_access",
}


@pytest.fixture
def consent_client(monkeypatch):
    settings = SimpleNamespace(MCP_ENABLED=True, validated_mcp_url=lambda: RESOURCE)
    monkeypatch.setattr(routes, "get_settings", lambda: settings)
    app = FastAPI()
    app.include_router(routes.router)
    app.dependency_overrides[routes.get_current_user_id] = lambda: USER
    app.dependency_overrides[routes.get_supabase] = lambda: object()

    async def run(provider, fn):
        return fn(provider)

    monkeypatch.setattr(routes, "run_supabase_operation", run)
    with TestClient(app, headers={"Authorization": "Bearer synthetic-owner-token"}) as client:
        yield client


def test_authorization_requires_current_admin_before_native_details(consent_client, monkeypatch):
    native = AsyncMock(return_value=DETAILS)
    monkeypatch.setattr(routes, "oauth_request", native)
    monkeypatch.setattr(routes, "owner", Mock(side_effect=HTTPException(403, "Admin required")))
    assert consent_client.get(f"/mcp/authorizations/{AUTHORIZATION}").status_code == 403
    native.assert_not_called()


def test_authorization_refuses_identity_substitution(consent_client, monkeypatch):
    monkeypatch.setattr(routes, "owner", Mock())
    monkeypatch.setattr(
        routes, "oauth_request", AsyncMock(return_value={**DETAILS, "user": {"id": CLIENT}})
    )
    assert consent_client.get(f"/mcp/authorizations/{AUTHORIZATION}").status_code == 400


def test_approve_persists_access_before_native_consent(consent_client, monkeypatch):
    calls = []

    async def native(settings, token, authorization, *, decision=None):
        calls.append(decision or "details")
        return (
            DETAILS
            if decision is None
            else {"redirect_url": "https://assistant.example.invalid/callback?code=synthetic"}
        )

    def save(client, user, details, authorization, permissions, days, resource):
        calls.append("save")
        assert (user, details, authorization, permissions, days, resource) == (
            USER,
            DETAILS,
            AUTHORIZATION,
            ["students"],
            7,
            RESOURCE,
        )

    monkeypatch.setattr(routes, "oauth_request", native)
    monkeypatch.setattr(routes, "save_consent", save)
    response = consent_client.post(
        f"/mcp/authorizations/{AUTHORIZATION}/approve",
        json={"permissions": ["students"], "expires_days": 7},
    )
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert calls == ["details", "save", "approve"]


def test_replayed_native_approval_cannot_change_local_permissions(consent_client, monkeypatch):
    native = AsyncMock(return_value={"redirect_url": "https://assistant.example.invalid/callback"})
    save = Mock(side_effect=AssertionError("Already approved requests cannot change grants"))
    monkeypatch.setattr(routes, "oauth_request", native)
    monkeypatch.setattr(routes, "save_consent", save)
    result = consent_client.post(
        f"/mcp/authorizations/{AUTHORIZATION}/approve",
        json={"permissions": ["notes"], "expires_days": 90},
    )
    assert result.status_code == 200
    save.assert_not_called()
    assert native.await_count == 1


def test_failed_grant_save_never_approves_native_consent(consent_client, monkeypatch):
    native = AsyncMock(return_value=DETAILS)
    monkeypatch.setattr(routes, "oauth_request", native)
    monkeypatch.setattr(routes, "save_consent", Mock(side_effect=HTTPException(403, "No access")))
    assert (
        consent_client.post(
            f"/mcp/authorizations/{AUTHORIZATION}/approve", json={"permissions": ["students"]}
        ).status_code
        == 403
    )
    assert native.await_count == 1


def test_disconnect_keeps_local_revocation_when_native_cleanup_fails(consent_client, monkeypatch):
    calls = []

    def revoke(*args):
        calls.append("local")
        return {"id": CONNECTION, "client_id": CLIENT, "revoked_at": "2026-10-22T00:00:00Z"}

    async def native(*args):
        calls.append("native")
        return False

    monkeypatch.setattr(routes, "revoke_connection", revoke)
    monkeypatch.setattr(routes, "revoke_native_grant", native)
    result = consent_client.delete(f"/mcp/connections/{CONNECTION}")
    assert result.status_code == 200 and result.json()["revoked_at"]
    assert result.json()["native_consent_removed"] is False
    assert calls == ["local", "native"]


@pytest.mark.parametrize(
    "url",
    [
        "javascript:alert(1)",
        "//evil.example",
        "http://evil.example",
        "https://user:pass@evil.example",
        "https://example.invalid/\ncode",
    ],
)
def test_native_callback_refuses_unsafe_urls(url):
    with pytest.raises(HTTPException):
        routes.safe_redirect({"redirect_url": url})


def test_native_requests_are_pinned_without_redirects_or_environment_proxy(monkeypatch):
    requests = []
    actual_client = httpx.AsyncClient

    def response(request):
        requests.append(request)
        return httpx.Response(
            200, json={"redirect_url": "https://assistant.example.invalid/callback"}
        )

    def factory(**kwargs):
        assert kwargs == {"timeout": 10.0, "trust_env": False, "follow_redirects": False}
        return actual_client(**kwargs, transport=httpx.MockTransport(response))

    monkeypatch.setattr(connections.httpx, "AsyncClient", factory)
    settings = SimpleNamespace(
        SUPABASE_URL="https://project.example.invalid",
        SUPABASE_SERVICE_ROLE_KEY="synthetic-apikey",
        validate_supabase_service_role_configuration=Mock(),
    )

    async def run():
        await connections.oauth_request(settings, "owner-session", AUTHORIZATION)
        await connections.oauth_request(
            settings, "owner-session", AUTHORIZATION, decision="approve"
        )
        assert await connections.revoke_native_grant(settings, "owner-session", CLIENT)

    asyncio.run(run())
    assert [(r.method, r.url.path) for r in requests] == [
        ("GET", f"/auth/v1/oauth/authorizations/{AUTHORIZATION}"),
        ("POST", f"/auth/v1/oauth/authorizations/{AUTHORIZATION}/consent"),
        ("DELETE", "/auth/v1/user/oauth/grants"),
    ]
    assert json.loads(requests[1].content) == {"action": "approve"}
    assert requests[2].url.params["client_id"] == CLIENT
    assert all(
        r.url.host == "project.example.invalid"
        and r.headers["authorization"] == "Bearer owner-session"
        for r in requests
    )


def test_native_error_does_not_expose_provider_body(monkeypatch):
    actual_client = httpx.AsyncClient
    monkeypatch.setattr(
        connections.httpx,
        "AsyncClient",
        lambda **kw: actual_client(
            **kw,
            transport=httpx.MockTransport(
                lambda req: httpx.Response(400, text="private provider diagnostic")
            ),
        ),
    )
    settings = SimpleNamespace(
        SUPABASE_URL="https://project.example.invalid",
        SUPABASE_SERVICE_ROLE_KEY="synthetic",
        validate_supabase_service_role_configuration=Mock(),
    )
    with pytest.raises(HTTPException) as error:
        asyncio.run(connections.oauth_request(settings, "synthetic-owner", AUTHORIZATION))
    assert "private provider" not in error.value.detail


def test_identity_scopes_cannot_enable_native_id_tokens(consent_client, monkeypatch):
    monkeypatch.setattr(routes, "owner", Mock())
    monkeypatch.setattr(
        routes,
        "oauth_request",
        AsyncMock(return_value={**DETAILS, "scope": "openid offline_access"}),
    )
    assert consent_client.get(f"/mcp/authorizations/{AUTHORIZATION}").status_code == 400
    with pytest.raises(HTTPException):
        connections.require_connector_scope({**DETAILS, "scope": "openid"})
