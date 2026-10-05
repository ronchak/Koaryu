"""Capability observations use synthetic readiness, credentials and Auth only."""

import json
import math
from copy import deepcopy
from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import patch

import httpx
import pytest
from supabase import create_client
from supabase.lib.client_options import ClientOptions
from test_automation_email import email_settings
from test_automation_email_credentials import CLIENT_ID, FakeCredentialDatabase, credential_state

from app.db.supabase import close_supabase_client
from app.services import release_schema_readiness as readiness
from app.services import workflow_capabilities as capabilities
from app.services.automation_email import email_delivery_status
from app.services.automation_email_credentials import PROVIDER_KEY, CredentialCodec

ACTOR = "10000000-0000-0000-0000-000000000001"
OTHER_ACTOR = "10000000-0000-0000-0000-000000000002"
V38 = "koaryu_release_schema_preflight_v38"
V57_MANIFEST = "release-db-attestation-v57"
V57_HEAD = "20261005105341"


def exact_preflight_row():
    return {
        "ready": True,
        "migration_count": readiness.EXPECTED_RELEASE_MIGRATION_COUNT,
        "migration_head": readiness.EXPECTED_RELEASE_MIGRATION_HEAD,
        "pending_versions": readiness.EXPECTED_RELEASE_PENDING_VERSIONS,
        "security_failures": [],
        "manifest_version": readiness.EXPECTED_RELEASE_MANIFEST_VERSION,
    }


def guarded_preflight():
    # This fixture stands in for the guarded function, never a SQL install. Keep
    # its V57 identity when the generated current release reaches or passes V57.
    current = exact_preflight_row()
    pending = current["pending_versions"]
    guarded_pending = (
        pending[: pending.index(V57_HEAD) + 1] if V57_HEAD in pending else [*pending, V57_HEAD]
    )
    return {
        **current,
        "migration_count": current["migration_count"] + len(guarded_pending) - len(pending),
        "migration_head": V57_HEAD,
        "pending_versions": guarded_pending,
        "manifest_version": V57_MANIFEST,
    }


@pytest.fixture(params=["generated_current", "generated_v57"], autouse=True)
def generated_release_context(request):
    """Exercise every capability case before and after task14's metadata update."""
    if request.param == "generated_current":
        yield
        return
    guarded = guarded_preflight()
    with (
        patch.object(capabilities, "RELEASE_PREFLIGHT_RPC", V38),
        patch.multiple(
            readiness,
            EXPECTED_RELEASE_MANIFEST_VERSION=guarded["manifest_version"],
            EXPECTED_RELEASE_MIGRATION_COUNT=guarded["migration_count"],
            EXPECTED_RELEASE_MIGRATION_HEAD=guarded["migration_head"],
            EXPECTED_RELEASE_PENDING_VERSIONS=guarded["pending_versions"],
        ),
    ):
        yield


def auth_user(**changes):
    return SimpleNamespace(
        **{
            "id": ACTOR,
            "email": "koaryu@outlook.com",
            "email_confirmed_at": datetime(2026, 1, 1, tzinfo=UTC),
            "user_metadata": {},
            **changes,
        }
    )


def capability_case(**settings_changes):
    settings = email_settings(AUTOMATION_WORKER_ENABLED=True, **settings_changes)
    codec = CredentialCodec(
        settings.EMAIL_TOKEN_ENCRYPTION_KEY, CLIENT_ID, settings.EMAIL_FROM_ADDRESS
    )
    client = FakeCredentialDatabase(codec.encrypt(credential_state()), 1)
    rows = {
        capabilities.RELEASE_PREFLIGHT_RPC: exact_preflight_row(),
        V38: guarded_preflight(),
    }
    user = auth_user()
    auth_calls = []

    def get_user(actor):
        auth_calls.append(actor)
        return SimpleNamespace(user=user)

    client.auth = SimpleNamespace(admin=SimpleNamespace(get_user_by_id=get_user))

    def execute(name, params):
        if name == "get_automation_email_credential_v1":
            return None
        value = rows[name]
        if isinstance(value, Exception):
            raise value
        return SimpleNamespace(data=value)

    client.on_execute = execute
    return settings, client, rows, user, auth_calls


@pytest.mark.parametrize("worker", [False, True])
@pytest.mark.parametrize("verified", [False, True])
def test_action_formula_and_private_recipient_not_returned(worker, verified):
    settings, client, _, user, calls = capability_case(EMAIL_ALLOWED_RECIPIENTS="")
    settings.AUTOMATION_WORKER_ENABLED = worker
    user.email = "private-actor@example.com"
    user.email_confirmed_at = user.email_confirmed_at if verified else None
    result = capabilities.resolve_workflow_capabilities(client, settings, ACTOR)
    assert set(result) == {"delivery_status", "capabilities", "scheduler"}
    assert result["delivery_status"] == email_delivery_status(settings, client)
    assert result["capabilities"]["can_start"] is worker
    assert result["capabilities"]["can_test_email"] is verified
    assert (result["capabilities"]["disabled_reason"] is None) is (worker and verified)
    assert result["scheduler"] == {"enabled": worker, "interval_seconds": 60}
    assert calls == [ACTOR]
    assert user.email not in json.dumps(result)
    assert all(
        name.startswith(("get_", "koaryu_release_schema_preflight_")) for name, _ in client.calls
    )


@pytest.mark.parametrize(
    "bad",
    [
        None,
        [],
        {},
        True,
        "ready",
        [guarded_preflight(), guarded_preflight()],
        [None, guarded_preflight()],
        {**guarded_preflight(), "ready": False},
        {**guarded_preflight(), "ready": "true"},
        {**guarded_preflight(), "manifest_version": "release-db-attestation-v56"},
        {**guarded_preflight(), "manifest_version": "release-db-attestation-v99"},
        {**guarded_preflight(), "security_failures": ["synthetic-private-detail"]},
        {**guarded_preflight(), "migration_count": 151.0},
        {**guarded_preflight(), "pending_versions": [{}]},
        {**guarded_preflight(), "migration_count": -1},
        {**guarded_preflight(), "migration_count": 0},
        {**guarded_preflight(), "migration_count": True},
        {**guarded_preflight(), "migration_count": 1},
        {**guarded_preflight(), "migration_head": ""},
        {**guarded_preflight(), "pending_versions": []},
        {**guarded_preflight(), "pending_versions": ["unknown"]},
        {**guarded_preflight(), "pending_versions": ["20261004220435", "20261004220435"]},
        {
            **guarded_preflight(),
            "pending_versions": list(reversed(exact_preflight_row()["pending_versions"])),
        },
        {**guarded_preflight(), "extra": "unknown"},
        RuntimeError("missing V38 synthetic-private-detail"),
    ],
)
def test_old_missing_malformed_or_unready_workflow_preflight_fails_closed(bad):
    settings, client, rows, _, calls = capability_case()
    rows[V38] = bad
    result = capabilities.resolve_workflow_capabilities(client, settings, ACTOR)
    assert result["capabilities"] == {
        "can_start": False,
        "can_test_email": False,
        "disabled_reason": "Workflow setup is unavailable.",
    }
    assert calls == []
    assert "synthetic-private-detail" not in json.dumps(result)


@pytest.mark.parametrize(
    "changes",
    [
        {"ready": False},
        {"migration_count": 1},
        {"migration_count": 151.0},
        {"migration_head": "unknown"},
        {"pending_versions": [{}]},
        {"manifest_version": "release-db-attestation-unknown"},
        {"security_failures": ["private"]},
    ],
)
def test_generated_current_release_must_match_before_guarded_workflow_check(changes):
    settings, client, rows, _, calls = capability_case()
    rows[capabilities.RELEASE_PREFLIGHT_RPC].update(changes)
    result = capabilities.resolve_workflow_capabilities(client, settings, ACTOR)
    assert not result["capabilities"]["can_start"]
    assert not result["capabilities"]["can_test_email"]
    assert [
        name for name, _ in client.calls if name.startswith("koaryu_release_schema_preflight_")
    ] == [capabilities.RELEASE_PREFLIGHT_RPC]
    assert calls == []


def test_current_release_uses_workflow_guard_once():
    settings, client, _, _, _ = capability_case()
    result = capabilities.resolve_workflow_capabilities(client, settings, ACTOR)
    assert result["capabilities"]["can_start"]
    assert result["capabilities"]["can_test_email"]
    expected = (
        [V38]
        if capabilities.RELEASE_PREFLIGHT_RPC == V38
        else [capabilities.RELEASE_PREFLIGHT_RPC, V38]
    )
    assert [
        name for name, _ in client.calls if name.startswith("koaryu_release_schema_preflight_")
    ] == expected


@pytest.mark.parametrize(
    "changes",
    [
        {"id": OTHER_ACTOR},
        {"id": "bad"},
        {"email_confirmed_at": None},
        {"email_confirmed_at": True},
        {"email_confirmed_at": "not-a-date"},
        {"email_confirmed_at": datetime(2026, 1, 1)},  # noqa: DTZ001 - Malformed provider fixture.
        {"email_confirmed_at": None, "user_metadata": {"email_verified": True}},
        {"email": "invalid"},
        {"email": "Name <koaryu@outlook.com>"},
        {"email": "private-other@example.com"},
        {"email": None},
    ],
)
def test_auth_identity_confirmation_mailbox_and_allowlist_fail_closed(changes):
    settings, client, _, user, calls = capability_case()
    user.__dict__.update(changes)
    result = capabilities.resolve_workflow_capabilities(client, settings, ACTOR)
    assert result["capabilities"]["can_start"] is True
    assert result["capabilities"]["can_test_email"] is False
    assert calls == [ACTOR]
    assert "private-other" not in json.dumps(result)


def test_normalized_verified_allowlisted_email_is_available():
    settings, client, _, user, _ = capability_case()
    user.email = " KOARYU@OUTLOOK.COM "
    user.email_confirmed_at = "2026-01-01T00:00:00Z"
    assert capabilities.resolve_workflow_capabilities(client, settings, ACTOR)["capabilities"] == {
        "can_start": True,
        "can_test_email": True,
        "disabled_reason": None,
    }


@pytest.mark.parametrize("response", [None, {}, SimpleNamespace(user=None)])
def test_malformed_auth_response_is_unavailable(response):
    settings, client, _, _, _ = capability_case()
    client.auth.admin.get_user_by_id = lambda _: response
    result = capabilities.resolve_workflow_capabilities(client, settings, ACTOR)
    assert result["capabilities"]["can_test_email"] is False


@pytest.mark.parametrize("fault", ["auth", "credential", "preflight"])
def test_transient_provider_failures_are_fixed_private_and_do_not_send(fault):
    settings, client, rows, _, _ = capability_case()

    def fail(*_):
        raise httpx.ReadTimeout("synthetic-private-detail")

    if fault == "auth":
        client.auth.admin.get_user_by_id = fail
    elif fault == "credential":
        previous = client.on_execute
        client.on_execute = lambda name, params: (
            fail() if name == "get_automation_email_credential_v1" else previous(name, params)
        )
    else:
        rows[capabilities.RELEASE_PREFLIGHT_RPC] = httpx.ReadTimeout("synthetic-private-detail")
    result = capabilities.resolve_workflow_capabilities(client, settings, ACTOR)
    assert not result["capabilities"]["can_test_email"]
    assert result["capabilities"]["can_start"] is (fault == "auth")
    assert "synthetic-private-detail" not in json.dumps(result)


@pytest.mark.parametrize("fault", ["disabled", "provider", "missing", "corrupt", "config"])
def test_sender_unavailability_blocks_both_actions(fault):
    settings, client, _, _, calls = capability_case()
    if fault == "disabled":
        settings.EMAIL_SEND_ENABLED = False
    elif fault == "provider":
        settings.EMAIL_PROVIDER = "disabled"
    elif fault == "missing":
        client.ciphertext, client.revision = None, 0
    elif fault == "corrupt":
        client.ciphertext = "invalid-ciphertext"
    else:
        settings.EMAIL_GRAPH_CLIENT_ID = "invalid"
    result = capabilities.resolve_workflow_capabilities(client, settings, ACTOR)
    assert result["capabilities"] == {
        "can_start": False,
        "can_test_email": False,
        "disabled_reason": "Email sending is unavailable.",
    }
    assert calls == []


def sdk_case(settings, handler):
    client = create_client(
        "https://capability.example.invalid",
        "header.payload.signature",
        options=ClientOptions(postgrest_client_timeout=1),
    )
    # Keep the actual SDK parsers and finite timeout policy; replace HTTP I/O only.
    client.postgrest.session._transport = httpx.MockTransport(handler)
    client.auth.admin._http_client._transport = httpx.MockTransport(handler)
    client.postgrest.session._mounts = {}
    client.auth.admin._http_client._mounts = {}
    codec = CredentialCodec(
        settings.EMAIL_TOKEN_ENCRYPTION_KEY, CLIENT_ID, settings.EMAIL_FROM_ADDRESS
    )
    credential = {
        "provider_key": PROVIDER_KEY,
        "revision": 1,
        "encrypted_credentials": codec.encrypt(credential_state()),
    }
    return client, credential


@pytest.mark.parametrize(
    "fault",
    [
        None,
        "auth_shape",
        "auth_mismatch",
        "auth_metadata",
        "auth_timestamp",
        "auth_error",
        "preflight_shape",
        "preflight_multiple",
        "guard_missing",
        "guard_error_shape",
        "guard_error_code",
        "credential_shape",
    ],
)
def test_pinned_sdk_parses_responses_and_rejects_malformed_provider_data(fault):
    settings = email_settings(AUTOMATION_WORKER_ENABLED=True)
    requests = []
    user = {
        "id": ACTOR,
        "email": "koaryu@outlook.com",
        "aud": "authenticated",
        "app_metadata": {},
        "user_metadata": {},
        "created_at": "2026-01-01T00:00:00Z",
        "email_confirmed_at": "2026-01-01T00:00:00Z",
    }

    def handler(request):
        requests.append(request)
        assert request.url.host == "capability.example.invalid"
        if request.url.path.startswith("/auth/"):
            assert request.method == "GET"
            assert request.url.path == f"/auth/v1/admin/users/{ACTOR}"
            assert all(
                math.isfinite(value) and value > 0
                for value in request.extensions["timeout"].values()
            )
            if fault == "auth_error":
                return httpx.Response(503, json={"message": "synthetic-private-detail"})
            payload = deepcopy(user)
            if fault == "auth_shape":
                payload = {"email": "private@example.com", "email_confirmed_at": True}
            elif fault == "auth_mismatch":
                payload["id"] = OTHER_ACTOR
            elif fault == "auth_timestamp":
                payload["email_confirmed_at"] = True
            elif fault == "auth_metadata":
                payload["email_confirmed_at"] = None
                payload["user_metadata"] = {"email_verified": True}
            return httpx.Response(200, json=payload)
        name = request.url.path.rsplit("/", 1)[-1]
        assert request.method == "POST"
        if name == "get_automation_email_credential_v1":
            return httpx.Response(200, json={} if fault == "credential_shape" else credential)
        if name == capabilities.RELEASE_PREFLIGHT_RPC:
            if fault == "preflight_shape":
                return httpx.Response(200, json="bad")
            if fault == "preflight_multiple":
                return httpx.Response(200, json=[exact_preflight_row(), exact_preflight_row()])
        if name == V38:
            if fault == "guard_error_shape":
                return httpx.Response(
                    503, json={"code": "PGRST202", "message": {"private": "detail"}}
                )
            if fault == "guard_error_code":
                return httpx.Response(503, json={"code": ["PGRST202"], "message": "private"})
            if fault == "guard_missing":
                return httpx.Response(404, json={"code": "PGRST202", "message": "missing function"})
            return httpx.Response(200, json=guarded_preflight())
        assert name == capabilities.RELEASE_PREFLIGHT_RPC
        return httpx.Response(200, json=[exact_preflight_row()])

    client, credential = sdk_case(settings, handler)
    try:
        result = capabilities.resolve_workflow_capabilities(client, settings, ACTOR)
    finally:
        close_supabase_client(client)
    assert result["capabilities"]["can_test_email"] is (fault is None)
    assert result["capabilities"]["can_start"] is (fault is None or fault.startswith("auth_"))
    assert "synthetic-private-detail" not in json.dumps(result)
    assert not any(
        "send" in request.url.path or "token" in request.url.path for request in requests
    )
