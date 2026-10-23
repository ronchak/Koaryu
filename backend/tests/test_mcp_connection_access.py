"""Owner consent edits preserve expiry and use an atomic version/revocation guard."""

import json
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from uuid import UUID

import httpx
import pytest
from fastapi import HTTPException
from postgrest import SyncPostgrestClient
from postgrest.utils import SyncClient
from test_mcp_read_auth_transport import CLIENT, CONNECTION, SESSION, USER
from test_mcp_read_query import A

from app.mcp_read import connections

NOW = datetime(2026, 10, 23, 12, tzinfo=UTC)
AUTHORIZED = NOW - timedelta(days=1)
EXPIRES = NOW + timedelta(days=3)


class Clock(datetime):
    @classmethod
    def now(cls, _tz=None):
        return NOW


@pytest.fixture
def grant():
    return {
        "id": CONNECTION,
        "user_id": USER,
        "studio_id": A,
        "client_id": CLIENT,
        "client_name": "Synthetic assistant",
        "session_id": SESSION,
        "permissions": ["students", "schedule"],
        "authorized_at": AUTHORIZED.isoformat(),
        "expires_at": EXPIRES.isoformat(),
        "revoked_at": None,
    }


def client_for(grant, requests, *, reject_update=False):
    expected_version = grant["authorized_at"] if grant is not None else AUTHORIZED.isoformat()

    class Client(SyncPostgrestClient):
        def create_session(self, base_url, headers, timeout, verify=True, proxy=None):
            def handler(request):
                requests.append(request)
                assert request.url.path == "/mcp_connections"
                assert request.url.params["id"] == "eq." + CONNECTION
                assert request.url.params["user_id"] == "eq." + USER
                assert request.url.params["studio_id"] == "eq." + A
                if request.method == "GET":
                    return httpx.Response(200, json=[] if grant is None else [grant])
                assert request.method == "PATCH"
                assert request.url.params["authorized_at"] == "eq." + expected_version
                assert request.url.params["revoked_at"] == "is.null"
                changes = json.loads(request.content)
                assert set(changes) == {"permissions", "authorized_at", "expires_at"}
                return httpx.Response(200, json=[] if reject_update else [{**grant, **changes}])

            return SyncClient(
                base_url=base_url,
                headers=headers,
                timeout=timeout,
                transport=httpx.MockTransport(handler),
                trust_env=False,
                follow_redirects=False,
            )

    client = Client("https://synthetic.invalid")
    return client, SimpleNamespace(table=client.from_)


@pytest.fixture(autouse=True)
def owner_and_clock(monkeypatch):
    monkeypatch.setattr(connections, "owner", lambda *_: {"studio_id": A})
    monkeypatch.setattr(connections, "datetime", Clock)


def test_permission_edit_does_not_extend_current_expiry(grant):
    requests = []
    transport, client = client_for(grant, requests)
    with transport:
        result = connections.change_access(
            client, USER, UUID(CONNECTION), ["students", "contacts", "students"], AUTHORIZED, None
        )
    assert result["permissions"] == ["contacts", "students"]
    assert result["expires_at"] == EXPIRES.isoformat()
    assert result["authorized_at"] == NOW.isoformat()
    assert result["session_ready"] is True
    assert "session_id" not in result and "user_id" not in result
    assert [request.method for request in requests] == ["GET", "PATCH"]


def test_expired_connection_requires_explicit_renewal(grant):
    grant["expires_at"] = (NOW - timedelta(seconds=1)).isoformat()
    requests = []
    transport, client = client_for(grant, requests)
    with transport, pytest.raises(HTTPException) as error:
        connections.change_access(client, USER, UUID(CONNECTION), ["students"], AUTHORIZED, None)
    assert error.value.status_code == 409 and len(requests) == 1
    requests.clear()
    transport, client = client_for(grant, requests)
    with transport:
        result = connections.change_access(
            client, USER, UUID(CONNECTION), ["students"], AUTHORIZED, 7
        )
    assert result["expires_at"] == (NOW + timedelta(days=7)).isoformat()


def test_consent_version_advances_even_when_clock_has_not_moved(grant):
    grant["authorized_at"] = NOW.isoformat()
    requests = []
    transport, client = client_for(grant, requests)
    with transport:
        result = connections.change_access(client, USER, UUID(CONNECTION), ["students"], NOW, None)
    assert datetime.fromisoformat(result["authorized_at"]) > NOW
    assert result["expires_at"] == EXPIRES.isoformat()


@pytest.mark.parametrize("change", ["revoked", "pending", "stale", "missing"])
def test_invalid_current_state_never_updates_consent(grant, change):
    if change == "revoked":
        grant["revoked_at"] = NOW.isoformat()
    elif change == "pending":
        grant["session_id"] = None
    elif change == "stale":
        grant["authorized_at"] = NOW.isoformat()
    else:
        grant = None
    requests = []
    transport, client = client_for(grant, requests)
    with transport, pytest.raises(HTTPException) as error:
        connections.change_access(client, USER, UUID(CONNECTION), ["students"], AUTHORIZED, 7)
    assert error.value.status_code == (404 if change == "missing" else 409)
    assert [request.method for request in requests] == ["GET"]


def test_concurrent_revoke_or_edit_wins_at_the_atomic_update(grant):
    requests = []
    transport, client = client_for(grant, requests, reject_update=True)
    with transport, pytest.raises(HTTPException) as error:
        connections.change_access(client, USER, UUID(CONNECTION), ["students"], AUTHORIZED, 7)
    assert error.value.status_code == 409
    assert [request.method for request in requests] == ["GET", "PATCH"]


@pytest.mark.parametrize(
    "permissions,days",
    [([], None), (["unknown"], 7), (["students"], True), (["students"], 0), (["students"], 91)],
)
def test_unsupported_consent_never_reaches_update(grant, permissions, days):
    requests = []
    transport, client = client_for(grant, requests)
    with transport, pytest.raises(HTTPException) as error:
        connections.change_access(client, USER, UUID(CONNECTION), permissions, AUTHORIZED, days)
    assert error.value.status_code == 422
    assert not any(request.method == "PATCH" for request in requests)
