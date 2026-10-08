"""Source-only status protocol proof using synthetic rows and the installed SDK."""

import json
from types import SimpleNamespace

import httpx
import pytest
from postgrest.exceptions import APIError
from test_automation_email import email_settings
from test_automation_email_credentials import credential_state
from test_workflow_capabilities import capability_case, sdk_case

from app.db.supabase import close_supabase_client
from app.schemas.workflow_dispatch import TRANSPORT_CODES
from app.services.automation_email import email_delivery_status
from app.services.automation_email_credentials import PROVIDER_KEY, CredentialCodec
from app.services.automation_sender_status import (
    SENDER_STATUS_RPC,
    SenderStatus,
    observe_email_delivery_status,
    read_sender_status,
)


def row(mode="ready", reason=None):
    return {"payload": {"mode": mode, "reason": reason}}


class StatusClient:
    def __init__(self, value):
        self.value = value
        self.calls = []

    def rpc(self, name, params):
        self.calls.append((name, params))
        assert name == SENDER_STATUS_RPC
        assert params == {"p_provider_key": "microsoft_graph:primary"}

        def execute():
            if isinstance(self.value, Exception):
                raise self.value
            return SimpleNamespace(data=self.value)

        return SimpleNamespace(execute=execute)


@pytest.mark.parametrize("mode", ["cooldown", "auth_blocked"])
@pytest.mark.parametrize("reason", sorted(TRANSPORT_CODES | {"sender_rejection_unclassified"}))
def test_accepts_exact_frozen_safe_reason_vocabulary(mode, reason):
    client = StatusClient(row(mode, reason))
    assert read_sender_status(client) == SenderStatus(mode, reason)
    assert len(client.calls) == 1


MALFORMED = [
    None,
    True,
    [],
    {},
    [row()],
    "ready",
    {"payload": None},
    {"payload": []},
    {"payload": {"mode": "ready"}},
    {"payload": {"reason": None}},
    {**row(), "extra": "private"},
    {"payload": {**row()["payload"], "extra": "private"}},
    row([], None),
    row({}, None),
    row(True, None),
    row("unknown", None),
    row("ready", "authentication_required"),
    row("ready", []),
    row("cooldown", None),
    row("auth_blocked", None),
    row("cooldown", []),
    row("auth_blocked", {}),
    row("auth_blocked", True),
    row("cooldown", "private-provider-error"),
    row("auth_blocked", "sender_unavailable"),
]


@pytest.mark.parametrize("value", MALFORMED)
def test_malformed_or_uncertain_status_never_retries(value):
    client = StatusClient(value)
    assert read_sender_status(client) is None
    assert len(client.calls) == 1


@pytest.mark.parametrize(
    "error",
    [
        RuntimeError("private"),
        httpx.ReadTimeout("private"),
        APIError({"code": "22023", "message": "AUTOMATION_INVALID_REQUEST"}),
        APIError({"code": "P0001", "message": "AUTOMATION_SENDER_UNAVAILABLE"}),
        APIError({"code": "PGRST202", "message": "missing function private"}),
        APIError({"code": [], "message": {"private": "detail"}}),
    ],
)
def test_errors_are_unavailable_without_mapping_or_retry(error):
    client = StatusClient(error)
    assert read_sender_status(client) is None
    assert len(client.calls) == 1


@pytest.mark.parametrize(
    "value",
    [
        row(),
        row("cooldown", "provider_throttled"),
        row("auth_blocked", "sender_rejection_unclassified"),
        *MALFORMED,
    ],
)
def test_installed_sdk_accepts_only_closed_status_payload(value):
    requests = []

    def handler(request):
        requests.append(request)
        assert request.method == "POST"
        assert request.url.path == "/rest/v1/rpc/" + SENDER_STATUS_RPC
        assert json.loads(request.content) == {"p_provider_key": PROVIDER_KEY}
        return httpx.Response(200, json=value)

    client, _ = sdk_case(email_settings(), handler)
    try:
        result = read_sender_status(client)
    finally:
        close_supabase_client(client)
    assert result == (
        SenderStatus(**value["payload"])
        if value
        in [
            row(),
            row("cooldown", "provider_throttled"),
            row("auth_blocked", "sender_rejection_unclassified"),
        ]
        else None
    )
    assert len(requests) == 1


@pytest.mark.parametrize(
    "body",
    [
        {"code": [], "message": "private"},
        {"code": "P0001", "message": {}},
        {"code": "22023", "message": "AUTOMATION_INVALID_REQUEST"},
        {"code": "P0001", "message": "AUTOMATION_SENDER_UNAVAILABLE"},
        {"code": "PGRST202", "message": "private"},
        [],
        "private",
    ],
)
def test_installed_sdk_malformed_errors_never_escape_or_retry(body):
    requests = []

    def handler(request):
        requests.append(request)
        return httpx.Response(503, json=body)

    client, _ = sdk_case(email_settings(), handler)
    try:
        assert read_sender_status(client) is None
    finally:
        close_supabase_client(client)
    assert len(requests) == 1


def test_new_readable_binding_and_revision_preserve_current_hard_block():
    settings, client, rows, _, _ = capability_case()
    rows[SENDER_STATUS_RPC] = row("auth_blocked", "authentication_required")
    for revision, sender in [(1, "koaryu@outlook.com"), (2, "new-sender@example.com")]:
        settings.EMAIL_FROM_ADDRESS = sender
        codec = CredentialCodec(
            settings.EMAIL_TOKEN_ENCRYPTION_KEY, settings.EMAIL_GRAPH_CLIENT_ID, sender
        )
        client.ciphertext = codec.encrypt(credential_state(mailbox=sender))
        client.revision = revision
        observation = observe_email_delivery_status(settings, client)
        assert observation.delivery_status["configured"] is True
        assert observation.delivery_status["can_enable"] is False
        assert observation.delivery_status["reason"] == "authentication_required"
        assert observation.gate == SenderStatus("auth_blocked", "authentication_required")
    assert all(
        name in {SENDER_STATUS_RPC, "get_automation_email_credential_v1"}
        for name, _ in client.calls
    )


@pytest.mark.parametrize(
    "change",
    [
        {"EMAIL_SEND_ENABLED": False},
        {"EMAIL_PROVIDER": "disabled"},
        {"EMAIL_GRAPH_CLIENT_ID": "invalid"},
    ],
)
def test_local_unavailability_retains_existing_status_and_does_not_read_gate(change):
    settings, client, _, _, _ = capability_case(**change)
    local = email_delivery_status(settings, client)
    client.calls.clear()
    observation = observe_email_delivery_status(settings, client)
    assert observation.delivery_status == local
    assert observation.gate is None
    assert all(name != SENDER_STATUS_RPC for name, _ in client.calls)
