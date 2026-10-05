"""Synthetic sender handles, exact revisions and conservative submission evidence."""

import hashlib
import json
import math
import time
from dataclasses import FrozenInstanceError, replace

import httpx
import pytest
from postgrest import SyncPostgrestClient
from postgrest.utils import SyncClient
from test_automation_email import email_settings
from test_automation_email_credentials import CLIENT_ID, credential_state
from test_microsoft_graph_email import message, refresh_response, transport_case

from app.services.automation_email import (
    DeliveryResult,
    build_email_transport,
    delivery_configuration,
    email_delivery_status,
    sender_identity_binding,
)
from app.services.automation_email_credentials import PROVIDER_KEY, CredentialCodec
from app.services.microsoft_graph_email import (
    GRAPH_SEND_URL,
    MicrosoftGraphEmailTransport,
    PreparedEmailSender,
)


@pytest.mark.parametrize(
    "outcome", ["accepted", "retryable_failure", "permanent_failure", "unknown"]
)
def test_four_positional_result_fields_remain_unchanged_without_metadata(outcome):
    result = DeliveryResult(outcome, "legacy_code", "legacy_request", 17)
    assert (
        result.outcome,
        result.error_code,
        result.provider_request_id,
        result.retry_after_seconds,
    ) == (outcome, "legacy_code", "legacy_request", 17)
    assert (result.submission_evidence, result.failure_scope, result.credential_revision) == (
        None,
        None,
        None,
    )


@pytest.mark.parametrize("revision", [False, True, 0, -1, 1.0, "1", math.nan, [], {}])
def test_revision_requires_a_strict_positive_integer(revision):
    with pytest.raises(ValueError, match="^invalid_credential_revision$"):
        DeliveryResult("accepted", credential_revision=revision)


@pytest.mark.parametrize("field", ["submission_evidence", "failure_scope"])
@pytest.mark.parametrize("value", ["invalid", True, 1, [], {}])
def test_invalid_evidence_metadata_uses_safe_validation_errors(field, value):
    with pytest.raises(ValueError, match="^invalid_"):
        DeliveryResult("retryable_failure", **{field: value})


@pytest.mark.parametrize(
    "outcome,evidence,scope",
    [
        ("unknown", "not_submitted", None),
        ("unknown", "rejected", "sender_transient"),
        ("unknown", "accepted", None),
        ("unknown", "unknown", "message"),
        ("accepted", "unknown", None),
        ("retryable_failure", "unknown", None),
        ("permanent_failure", "unknown", None),
        ("retryable_failure", "accepted", None),
        ("accepted", "not_submitted", None),
        ("accepted", "rejected", None),
        ("accepted", "accepted", "sender_auth"),
        ("retryable_failure", "not_submitted", "sender_auth"),
    ],
)
def test_contradictory_metadata_cannot_downgrade_unknown_or_invent_acceptance(
    outcome, evidence, scope
):
    with pytest.raises(ValueError, match="^inconsistent_delivery_evidence$"):
        DeliveryResult(outcome, submission_evidence=evidence, failure_scope=scope)


def test_binding_is_canonical_and_excludes_secrets_and_message_policy():
    tenant = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
    settings = email_settings(EMAIL_GRAPH_TENANT=tenant)
    binding = sender_identity_binding(delivery_configuration(settings))
    expected_json = '["microsoft_graph:primary","b31866c9-dfc5-47a7-9889-bb2c98359911","koaryu@outlook.com","aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"]'
    assert binding == hashlib.sha256(expected_json.encode("utf-8")).hexdigest()
    assert len(binding) == 64 and binding == binding.lower()
    settings.EMAIL_GRAPH_CLIENT_ID = CLIENT_ID.upper()
    settings.EMAIL_GRAPH_TENANT = tenant.upper()
    settings.EMAIL_FROM_ADDRESS = " KOARYU@OUTLOOK.COM "
    settings.EMAIL_REPLY_TO = "another@example.com"
    settings.EMAIL_ALLOWED_RECIPIENTS = ""
    settings.EMAIL_GRAPH_CLIENT_SECRET = "different-synthetic-secret"
    settings.EMAIL_TOKEN_ENCRYPTION_KEY = "different-synthetic-key"
    assert sender_identity_binding(delivery_configuration(settings)) == binding


@pytest.mark.parametrize(
    "changes",
    [
        {"EMAIL_FROM_ADDRESS": "other@example.com"},
        {"EMAIL_GRAPH_CLIENT_ID": "10000000-0000-0000-0000-000000000001"},
        {"EMAIL_GRAPH_TENANT": "organizations"},
        {"EMAIL_GRAPH_TENANT": "common"},
    ],
)
def test_binding_changes_with_each_sender_identity_field(changes):
    before = sender_identity_binding(delivery_configuration(email_settings()))
    assert sender_identity_binding(delivery_configuration(email_settings(**changes))) != before


def assert_no_submission(result, code, *, outcome="retryable_failure", scope="sender_transient"):
    assert isinstance(result, DeliveryResult)
    assert (
        result.outcome,
        result.error_code,
        result.submission_evidence,
        result.failure_scope,
    ) == (outcome, code, "not_submitted", scope)
    assert result.credential_revision is None


def test_prepare_is_frozen_private_and_does_not_create_a_send_client():
    transport, database, codec, requests, options = transport_case(
        lambda request: pytest.fail("no HTTP")
    )
    prepared = transport.prepare()
    assert isinstance(prepared, PreparedEmailSender)
    assert prepared.envelope.revision == 1
    assert prepared.envelope.state == codec.decrypt(database.ciphertext)
    assert repr(prepared) == f"PreparedEmailSender(sender_binding='{prepared.sender_binding}')"
    with pytest.raises(FrozenInstanceError):
        prepared.sender_binding = "changed"
    with pytest.raises(FrozenInstanceError):
        prepared.envelope.revision = 99
    assert [name for name, _ in database.calls] == ["get_automation_email_credential_v1"]
    assert requests == options == []


def test_prepare_refreshes_and_commits_exact_revision_before_send_without_later_reload():
    def handler(request):
        if str(request.url) != GRAPH_SEND_URL:
            return httpx.Response(200, json=refresh_response())
        assert database.revision == 2
        assert request.headers["Authorization"] == "Bearer synthetic-new-access"
        database.revision = 99
        database.ciphertext = "unusable-later-ciphertext"
        return httpx.Response(202)

    transport, database, codec, requests, _ = transport_case(
        handler, state=credential_state(expires_at=0)
    )
    prepared = transport.prepare()
    assert prepared.envelope.revision == database.revision == 2
    assert prepared.envelope.state == codec.decrypt(database.ciphertext)
    assert len(requests) == 1 and str(requests[0].url) != GRAPH_SEND_URL
    calls = list(database.calls)
    result = transport.send_prepared(message(), prepared)
    assert (
        result.outcome,
        result.submission_evidence,
        result.failure_scope,
        result.credential_revision,
    ) == ("accepted", "accepted", None, 2)
    assert database.calls == calls
    assert len(requests) == 2


def test_prepare_uses_exact_cas_winner_revision_and_token():
    def handler(request):
        if str(request.url) == GRAPH_SEND_URL:
            assert request.headers["Authorization"] == "Bearer synthetic-winner-access"
            return httpx.Response(202)
        return httpx.Response(200, json=refresh_response())

    transport, database, codec, requests, _ = transport_case(
        handler, state=credential_state(expires_at=0)
    )

    class Conflict(Exception):
        code = "P0001"
        message = "AUTOMATION_EMAIL_CREDENTIAL_CONFLICT"

    def conflict(name, params):
        if name.startswith("save_"):
            database.revision = 9
            database.ciphertext = codec.encrypt(
                credential_state(
                    access_token="synthetic-winner-access", expires_at=time.time() + 3600
                )
            )
            raise Conflict()

    database.on_execute = conflict
    prepared = transport.prepare()
    assert prepared.envelope.revision == 9
    assert len(requests) == 1
    calls = list(database.calls)
    result = transport.send_prepared(message(), prepared)
    assert result.credential_revision == 9 and result.outcome == "accepted"
    assert database.calls == calls
    assert [name for name, _ in calls] == [
        "get_automation_email_credential_v1",
        "save_automation_email_credential_v1",
        "get_automation_email_credential_v1",
    ]


@pytest.mark.parametrize(
    "elapsed,accepted",
    [
        (59.999, True),
        (60, False),
        (60.001, False),
        (-0.001, False),
        (math.nan, False),
        (math.inf, False),
        (-math.inf, False),
    ],
)
def test_prepared_lifetime_is_strictly_less_than_sixty_seconds(monkeypatch, elapsed, accepted):
    clock = [100.0]
    monkeypatch.setattr("app.services.microsoft_graph_email.time.monotonic", lambda: clock[0])
    transport, database, _, requests, options = transport_case(lambda request: httpx.Response(202))
    prepared = transport.prepare()
    calls = list(database.calls)
    clock[0] = 100 + elapsed
    result = transport.send_prepared(message(), prepared)
    if accepted:
        assert result.outcome == "accepted" and result.credential_revision == 1
    else:
        assert_no_submission(result, "credential_refresh_conflict")
        assert options == []
    assert len(requests) == int(accepted)
    assert database.calls == calls


@pytest.mark.parametrize(
    "invalid_clock", [math.nan, math.inf, -math.inf, True, None, "100", 10**400]
)
def test_prepare_rejects_invalid_clock_without_io(monkeypatch, invalid_clock):
    monkeypatch.setattr("app.services.microsoft_graph_email.time.monotonic", lambda: invalid_clock)
    transport, database, _, requests, options = transport_case(
        lambda request: pytest.fail("no HTTP")
    )
    assert_no_submission(transport.prepare(), "credential_refresh_conflict")
    assert database.calls == requests == options == []


@pytest.mark.parametrize(
    "invalid_clock", [math.nan, math.inf, -math.inf, True, None, "100", 10**400]
)
@pytest.mark.parametrize("target", ["creation", "current"])
def test_prepared_send_rejects_invalid_handle_and_current_clock(monkeypatch, invalid_clock, target):
    clock = [100.0]
    monkeypatch.setattr("app.services.microsoft_graph_email.time.monotonic", lambda: clock[0])
    transport, database, _, requests, options = transport_case(
        lambda request: pytest.fail("no HTTP")
    )
    prepared = transport.prepare()
    calls = list(database.calls)
    if target == "creation":
        prepared = replace(prepared, _prepared_at=invalid_clock)
    else:
        clock[0] = invalid_clock
    assert_no_submission(
        transport.send_prepared(message(), prepared), "credential_refresh_conflict"
    )
    assert database.calls == calls and requests == options == []


@pytest.mark.parametrize("phase", ["load", "client_factory"])
def test_expiry_during_preparation_or_client_creation_cannot_submit(monkeypatch, phase):
    clock = [100.0]
    monkeypatch.setattr("app.services.microsoft_graph_email.time.monotonic", lambda: clock[0])
    transport, database, _, requests, _ = transport_case(lambda request: pytest.fail("no HTTP"))
    if phase == "load":
        database.on_execute = lambda name, params: clock.__setitem__(0, 160)
        result = transport.prepare()
    else:
        prepared = transport.prepare()
        old_factory = transport._client_factory

        def factory(**kwargs):
            clock[0] = 160
            return old_factory(**kwargs)

        transport._client_factory = factory
        result = transport.send_prepared(message(), prepared)
    assert_no_submission(result, "credential_refresh_conflict")
    assert requests == []


def test_expired_token_cannot_refresh_or_load_a_replacement(monkeypatch):
    clock = [2000000000.0]
    monkeypatch.setattr("app.services.microsoft_graph_email.time.time", lambda: clock[0])
    transport, database, _, requests, options = transport_case(
        lambda request: pytest.fail("no HTTP"), state=credential_state(expires_at=clock[0] + 70)
    )
    prepared = transport.prepare()
    calls = list(database.calls)
    clock[0] += 10
    assert_no_submission(
        transport.send_prepared(message(), prepared), "credential_refresh_conflict"
    )
    assert database.calls == calls and requests == options == []


@pytest.mark.parametrize(
    "deadline", [99, 100, math.nan, math.inf, -math.inf, True, "invalid", 10**400]
)
def test_prepared_send_rejects_bad_deadlines_without_io(monkeypatch, deadline):
    monkeypatch.setattr("app.services.microsoft_graph_email.time.monotonic", lambda: 100)
    transport, database, _, requests, options = transport_case(
        lambda request: pytest.fail("no HTTP")
    )
    prepared = transport.prepare()
    calls = list(database.calls)
    assert_no_submission(
        transport.send_prepared(message(), prepared, deadline=deadline), "send_budget_exhausted"
    )
    assert database.calls == calls and requests == options == []


@pytest.mark.parametrize(
    "changes,code",
    [
        ({"EMAIL_SEND_ENABLED": False}, "sending_disabled"),
        ({"EMAIL_PROVIDER": "disabled"}, "sending_disabled"),
        ({"EMAIL_FROM_ADDRESS": "other@example.com"}, "setup_required"),
        ({"EMAIL_GRAPH_CLIENT_ID": "10000000-0000-0000-0000-000000000001"}, "setup_required"),
        ({"EMAIL_GRAPH_TENANT": "organizations"}, "setup_required"),
        ({"EMAIL_GRAPH_CLIENT_SECRET": "changed-synthetic-secret"}, "setup_required"),
        ({"EMAIL_TOKEN_ENCRYPTION_KEY": "changed-synthetic-key"}, "setup_required"),
        ({"EMAIL_REPLY_TO": "bad\naddress"}, "setup_required"),
    ],
)
def test_prepared_send_rechecks_current_flags_and_configuration(changes, code):
    transport, database, _, requests, options = transport_case(
        lambda request: pytest.fail("no HTTP")
    )
    prepared = transport.prepare()
    calls = list(database.calls)
    for key, value in changes.items():
        setattr(transport._settings, key, value)
    assert_no_submission(
        transport.send_prepared(message(), prepared), code, outcome="permanent_failure"
    )
    assert database.calls == calls and requests == options == []


def test_fresh_allowlist_denies_recipient_without_changing_binding():
    transport, database, _, requests, options = transport_case(
        lambda request: pytest.fail("no HTTP"), settings=email_settings(EMAIL_ALLOWED_RECIPIENTS="")
    )
    prepared = transport.prepare()
    calls = list(database.calls)
    transport._settings.EMAIL_ALLOWED_RECIPIENTS = "koaryu@outlook.com"
    assert (
        sender_identity_binding(delivery_configuration(transport._settings))
        == prepared.sender_binding
    )
    result = transport.send_prepared(message(to_address="customer@example.com"), prepared)
    assert_no_submission(
        result, "recipient_not_allowed", outcome="permanent_failure", scope="message"
    )
    assert database.calls == calls and requests == options == []


def test_valid_reply_to_and_allowlist_changes_use_current_configuration():
    transport, _, _, requests, _ = transport_case(lambda request: httpx.Response(202))
    prepared = transport.prepare()
    transport._settings.EMAIL_ALLOWED_RECIPIENTS = ""
    transport._settings.EMAIL_REPLY_TO = "changed@example.com"
    transport._settings.EMAIL_FROM_NAME = "Updated sender"
    transport._settings.EMAIL_GRAPH_CLIENT_ID = CLIENT_ID.upper()
    result = transport.send_prepared(
        message(to_address="customer@example.com", reply_to="changed@example.com"), prepared
    )
    assert result.outcome == "accepted"
    payload = json.loads(requests[0].content)["message"]
    assert payload["from"]["emailAddress"]["name"] == "Updated sender"
    assert payload["replyTo"][0]["emailAddress"]["address"] == "changed@example.com"


@pytest.mark.parametrize("prepared_send", [False, True])
@pytest.mark.parametrize(
    "changes",
    [
        {"subject": ""},
        {"to_address": "bad"},
        {"reply_to": "bad"},
        {"html_body": ""},
        {"attempt_id": "\n"},
        {"text_body": ""},
    ],
)
def test_bad_message_stops_before_credentials_or_provider(prepared_send, changes):
    transport, database, _, requests, options = transport_case(
        lambda request: pytest.fail("no HTTP")
    )
    prepared = transport.prepare() if prepared_send else None
    calls = list(database.calls)
    result = (
        transport.send_prepared(message(**changes), prepared)
        if prepared_send
        else transport.send(message(**changes))
    )
    assert_no_submission(result, "invalid_message", outcome="permanent_failure", scope="message")
    assert database.calls == calls and requests == options == []


@pytest.mark.parametrize(
    "status,evidence,scope",
    [
        (202, "accepted", None),
        (401, "rejected", "sender_auth"),
        (403, "rejected", "sender_auth"),
        (400, "rejected", "unclassified"),
        (404, "rejected", "unclassified"),
        (422, "rejected", "unclassified"),
        (429, "rejected", "sender_transient"),
        (408, "unknown", "unclassified"),
        (500, "unknown", "unclassified"),
        (503, "unknown", "unclassified"),
        (302, "unknown", "unclassified"),
    ],
)
def test_submission_evidence_matrix_retains_exact_revision(status, evidence, scope):
    transport, _, _, requests, _ = transport_case(lambda request: httpx.Response(status))
    result = transport.send_prepared(message(), transport.prepare())
    assert (result.submission_evidence, result.failure_scope, result.credential_revision) == (
        evidence,
        scope,
        1,
    )
    assert len(requests) == 1


@pytest.mark.parametrize(
    "exception,evidence,scope",
    [
        (httpx.ConnectError, "not_submitted", "sender_transient"),
        (httpx.ConnectTimeout, "not_submitted", "sender_transient"),
        (httpx.PoolTimeout, "not_submitted", "sender_transient"),
        (httpx.ReadError, "unknown", "unclassified"),
        (httpx.ReadTimeout, "unknown", "unclassified"),
        (httpx.WriteError, "unknown", "unclassified"),
        (RuntimeError, "unknown", "unclassified"),
    ],
)
def test_network_evidence_distinguishes_proven_no_submission(exception, evidence, scope):
    def handler(request):
        raise exception("synthetic-sensitive-error")

    transport, _, _, requests, _ = transport_case(handler)
    result = transport.send_prepared(message(), transport.prepare())
    assert (result.submission_evidence, result.failure_scope, result.credential_revision) == (
        evidence,
        scope,
        1,
    )
    assert len(requests) == 1 and "synthetic" not in repr(result)


@pytest.mark.parametrize(
    "status,error,scope",
    [
        (400, "invalid_grant", "sender_auth"),
        (400, "consent_required", "sender_auth"),
        (401, None, "sender_auth"),
        (403, None, "sender_auth"),
        (400, "unknown_error", "unclassified"),
        (429, None, "sender_transient"),
        (500, None, "sender_transient"),
    ],
)
def test_prepare_error_scope_does_not_blame_recipient(status, error, scope):
    transport, _, _, requests, _ = transport_case(
        lambda request: httpx.Response(status, json={"error": error}),
        state=credential_state(expires_at=0),
    )
    result = transport.prepare()
    assert result.submission_evidence == "not_submitted" and result.failure_scope == scope
    assert result.credential_revision is None
    assert len(requests) == 1 and str(requests[0].url) != GRAPH_SEND_URL


@pytest.mark.parametrize(
    "fault,code,scope,outcome",
    [
        ("missing", "setup_required", "sender_transient", "permanent_failure"),
        ("corrupt", "authentication_required", "sender_auth", "permanent_failure"),
        ("store", "credential_store_unavailable", "sender_transient", "retryable_failure"),
    ],
)
def test_prepare_local_failure_evidence(fault, code, scope, outcome):
    transport, database, _, requests, options = transport_case(
        lambda request: pytest.fail("no HTTP")
    )
    if fault == "missing":
        database.ciphertext, database.revision = None, 0
    elif fault == "corrupt":
        database.ciphertext = "synthetic-corrupt"
    else:

        def fail(name, params):
            raise RuntimeError("synthetic-private-error")

        database.on_execute = fail
    assert_no_submission(transport.prepare(), code, outcome=outcome, scope=scope)
    assert requests == options == []


def test_disabled_factory_has_sender_condition_evidence():
    result = build_email_transport(email_settings(EMAIL_SEND_ENABLED=False), object()).send(
        message()
    )
    assert_no_submission(result, "sending_disabled", outcome="permanent_failure")


def test_status_read_never_calls_prepare(monkeypatch):
    def forbidden(*args, **kwargs):
        pytest.fail("status cannot prepare sender")

    monkeypatch.setattr(MicrosoftGraphEmailTransport, "prepare", forbidden)
    transport, database, _, requests, options = transport_case(
        forbidden, state=credential_state(expires_at=0)
    )
    assert email_delivery_status(transport._settings, database)["can_enable"] is True
    assert requests == options == []


def test_observed_acceptance_survives_response_and_client_cleanup_errors():
    class Body(httpx.SyncByteStream):
        def __iter__(self):
            pytest.fail("send response body cannot be read")
            yield b""

        def close(self):
            raise httpx.ReadError("synthetic-sensitive-response-cleanup")

    transport, _, _, requests, _ = transport_case(
        lambda request: httpx.Response(202, stream=Body())
    )
    original_factory = transport._client_factory

    def factory(**kwargs):
        client = original_factory(**kwargs)
        close = client.close

        def bad_close():
            close()
            raise RuntimeError("synthetic-sensitive-client-cleanup")

        client.close = bad_close
        return client

    transport._client_factory = factory
    result = transport.send(message())
    assert (result.outcome, result.submission_evidence, result.credential_revision) == (
        "accepted",
        "accepted",
        1,
    )
    assert len(requests) == 1


class SyntheticCredentialSDK(SyncPostgrestClient):
    def __init__(self, handler):
        self.handler = handler
        super().__init__("https://synthetic.invalid/rest/v1", timeout=1)

    def create_session(self, base_url, headers, timeout, verify=True, proxy=None):
        return SyncClient(
            base_url=base_url,
            headers=headers,
            timeout=timeout,
            transport=httpx.MockTransport(self.handler),
            trust_env=False,
        )


@pytest.mark.parametrize("cas_conflict", [False, True])
def test_real_sdk_refresh_envelope_preserves_saved_and_winning_revision(cas_conflict):
    settings = email_settings()
    codec = CredentialCodec(
        settings.EMAIL_TOKEN_ENCRYPTION_KEY, CLIENT_ID, settings.EMAIL_FROM_ADDRESS
    )
    stored = {
        "provider_key": PROVIDER_KEY,
        "revision": 1,
        "encrypted_credentials": codec.encrypt(credential_state(expires_at=0)),
    }
    rpc_names = []
    mail_requests = []

    def database_http(request):
        rpc_names.append(request.url.path.rsplit("/", 1)[-1])
        params = json.loads(request.content)
        assert params["p_provider_key"] == PROVIDER_KEY
        if rpc_names[-1] == "save_automation_email_credential_v1":
            assert params["p_expected_revision"] == 1
            if cas_conflict:
                stored.update(
                    revision=7,
                    encrypted_credentials=codec.encrypt(
                        credential_state(
                            access_token="synthetic-sdk-winner", expires_at=time.time() + 3600
                        )
                    ),
                )
                return httpx.Response(
                    409,
                    json={
                        "code": "P0001",
                        "message": "AUTOMATION_EMAIL_CREDENTIAL_CONFLICT",
                        "details": None,
                        "hint": None,
                    },
                )
            stored.update(revision=2, encrypted_credentials=params["p_encrypted_credentials"])
        else:
            assert rpc_names[-1] == "get_automation_email_credential_v1"
        return httpx.Response(200, json=stored)

    def provider_http(request):
        mail_requests.append(request)
        if str(request.url) != GRAPH_SEND_URL:
            return httpx.Response(200, json=refresh_response())
        assert (
            request.headers["Authorization"]
            == "Bearer " + codec.decrypt(stored["encrypted_credentials"]).access_token
        )
        return httpx.Response(202)

    with SyntheticCredentialSDK(database_http) as database:
        transport = MicrosoftGraphEmailTransport(
            settings,
            database,
            client_factory=lambda **kwargs: httpx.Client(
                transport=httpx.MockTransport(provider_http), **kwargs
            ),
        )
        prepared = transport.prepare()
        assert isinstance(prepared, PreparedEmailSender)
        assert len(mail_requests) == 1 and str(mail_requests[0].url) != GRAPH_SEND_URL
        prepared_calls = list(rpc_names)
        result = transport.send_prepared(message(), prepared)
        assert result.credential_revision == (7 if cas_conflict else 2)
        assert result.outcome == "accepted" and rpc_names == prepared_calls
        assert rpc_names == [
            "get_automation_email_credential_v1",
            "save_automation_email_credential_v1",
        ] + (["get_automation_email_credential_v1"] if cas_conflict else [])
