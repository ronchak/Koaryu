import json
import time
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from email.utils import format_datetime
from urllib.parse import parse_qs

import httpx
import pytest
from test_automation_email import email_settings
from test_automation_email_credentials import CLIENT_ID, FakeCredentialDatabase, credential_state

from app.services.automation_email import EmailMessage, build_email_transport
from app.services.automation_email_credentials import (
    CredentialCodec,
)
from app.services.microsoft_graph_email import GRAPH_SEND_URL, MicrosoftGraphEmailTransport

REQUEST_ID = "a7c4a137-258a-4999-ac33-6c8c6cbe9160"


def message(**changes):
    return replace(
        EmailMessage(
            to_address="koaryu@outlook.com",
            subject="Synthetic check-in",
            text_body="Synthetic text",
            html_body="<div>Synthetic &lt;body&gt;</div>",
            reply_to="studio@example.com",
            attempt_id="synthetic-attempt-1",
        ),
        **changes,
    )


def transport_case(handler, *, state=None, settings=None):
    settings = settings or email_settings()
    codec = CredentialCodec(
        settings.EMAIL_TOKEN_ENCRYPTION_KEY, CLIENT_ID, settings.EMAIL_FROM_ADDRESS
    )
    state = state or credential_state(expires_at=time.time() + 3600)
    database = FakeCredentialDatabase(codec.encrypt(state), 1)
    requests = []
    options = []

    def record(request):
        requests.append(request)
        return handler(request)

    def factory(**kwargs):
        options.append(kwargs)
        return httpx.Client(transport=httpx.MockTransport(record), **kwargs)

    transport = MicrosoftGraphEmailTransport(settings, database, client_factory=factory)
    return transport, database, codec, requests, options


def refresh_response(**changes):
    value = {
        "access_token": "synthetic-new-access",
        "refresh_token": "synthetic-new-refresh",
        "expires_in": 3600,
        "token_type": "Bearer",
    }
    value.update(changes)
    return value


@pytest.mark.parametrize(
    "status, outcome, code",
    [
        (202, "accepted", None),
        (429, "retryable_failure", "provider_throttled"),
        (400, "permanent_failure", "provider_rejected"),
        (401, "permanent_failure", "authentication_required"),
        (403, "permanent_failure", "provider_rejected"),
        (404, "permanent_failure", "provider_rejected"),
        (408, "unknown", "provider_submission_unknown"),
        (500, "unknown", "provider_submission_unknown"),
        (502, "unknown", "provider_submission_unknown"),
        (503, "unknown", "provider_submission_unknown"),
        (200, "unknown", "provider_submission_unknown"),
        (302, "unknown", "provider_submission_unknown"),
    ],
)
def test_one_submission_and_conservative_response_mapping(status, outcome, code):
    transport, database, _, requests, options = transport_case(
        lambda request: httpx.Response(
            status,
            headers={
                "request-id": REQUEST_ID,
                "Retry-After": "9999999",
                "Location": "https://other.example.com",
            },
            content=b"synthetic-access-only private provider response body",
        )
    )
    result = transport.send(message())
    assert (result.outcome, result.error_code) == (outcome, code)
    assert result.provider_request_id == REQUEST_ID
    assert result.retry_after_seconds == (3600 if status == 429 else None)
    assert len(requests) == 1
    assert str(requests[0].url) == GRAPH_SEND_URL
    assert options == [{"timeout": 5.0, "trust_env": False, "follow_redirects": False}]
    assert "synthetic" not in repr(result)
    assert [name for name, _ in database.calls] == ["get_automation_email_credential_v1"]


def test_graph_payload_uses_separate_sender_reply_and_recipient():
    transport, _, _, requests, _ = transport_case(lambda request: httpx.Response(202))
    assert transport.send(message(to_address=" KOARYU@OUTLOOK.COM ")).outcome == "accepted"
    request = requests[0]
    payload = json.loads(request.content)
    assert payload["message"]["from"]["emailAddress"] == {
        "address": "koaryu@outlook.com",
        "name": "Koaryu",
    }
    assert payload["message"]["toRecipients"] == [
        {"emailAddress": {"address": "koaryu@outlook.com"}}
    ]
    assert payload["message"]["replyTo"] == [{"emailAddress": {"address": "studio@example.com"}}]
    assert payload["message"]["body"]["content"] == message().html_body
    assert payload["saveToSentItems"] is True
    assert request.headers["client-request-id"] == "synthetic-attempt-1"
    assert "idempotency-key" not in request.headers


@pytest.mark.parametrize(
    "exception_type, outcome",
    [
        (httpx.ConnectError, "retryable_failure"),
        (httpx.ConnectTimeout, "retryable_failure"),
        (httpx.PoolTimeout, "retryable_failure"),
        (httpx.ReadTimeout, "unknown"),
        (httpx.WriteTimeout, "unknown"),
        (httpx.WriteError, "unknown"),
        (httpx.ReadError, "unknown"),
        (httpx.RemoteProtocolError, "unknown"),
        (RuntimeError, "unknown"),
    ],
)
def test_transport_exceptions_never_resend_or_expose_errors(exception_type, outcome):
    def handler(request):
        raise exception_type("synthetic secret koaryu@outlook.com provider body")

    transport, _, _, requests, _ = transport_case(handler)
    result = transport.send(message())
    assert result.outcome == outcome
    assert len(requests) == 1
    assert "synthetic" not in repr(result)
    assert "koaryu" not in repr(result)


@pytest.mark.parametrize(
    "changes, recipient, code",
    [
        ({"EMAIL_SEND_ENABLED": False}, "koaryu@outlook.com", "sending_disabled"),
        ({"EMAIL_PROVIDER": "disabled"}, "koaryu@outlook.com", "sending_disabled"),
        ({}, "customer@example.com", "recipient_not_allowed"),
        (
            {"EMAIL_ALLOWED_RECIPIENTS": "koaryu@outlook.com,customer@example.com"},
            "customer@example.com",
            "setup_required",
        ),
        (
            {"EMAIL_ALLOWED_RECIPIENTS": "customer@example.com"},
            "customer@example.com",
            "setup_required",
        ),
        ({"EMAIL_ALLOWED_RECIPIENTS": " , "}, "customer@example.com", "setup_required"),
        ({"EMAIL_GRAPH_TENANT": "consumers/../../hostile"}, "koaryu@outlook.com", "setup_required"),
        ({"EMAIL_GRAPH_CLIENT_ID": "wrong"}, "koaryu@outlook.com", "setup_required"),
        ({"EMAIL_FROM_NAME": "Name\nInjected"}, "koaryu@outlook.com", "setup_required"),
    ],
)
def test_interlocks_do_not_load_credentials_or_create_http_client(changes, recipient, code):
    class NoDatabase:
        def rpc(self, *args):
            raise AssertionError("credentials must not be loaded")

    def no_client(**kwargs):
        pytest.fail("HTTP client must not be created")

    transport = MicrosoftGraphEmailTransport(
        email_settings(**changes), NoDatabase(), client_factory=no_client
    )
    assert transport.send(message(to_address=recipient)).error_code == code


def test_explicit_empty_allowlist_allows_live_actual_address():
    transport, _, _, requests, _ = transport_case(
        lambda request: httpx.Response(202), settings=email_settings(EMAIL_ALLOWED_RECIPIENTS="")
    )
    assert transport.send(message(to_address="customer@example.com")).outcome == "accepted"
    assert (
        json.loads(requests[0].content)["message"]["toRecipients"][0]["emailAddress"]["address"]
        == "customer@example.com"
    )


def test_factory_enabled_constructs_transport_without_database_io():
    assert isinstance(
        build_email_transport(email_settings(), object()), MicrosoftGraphEmailTransport
    )


def test_successful_refresh_persists_complete_replacement_before_send():
    def handler(request):
        if str(request.url) != GRAPH_SEND_URL:
            assert (
                str(request.url) == "https://login.microsoftonline.com/consumers/oauth2/v2.0/token"
            )
            form = parse_qs(request.content.decode())
            assert form["refresh_token"] == ["synthetic-refresh-only"]
            assert form["client_secret"] == ["synthetic-client-secret"]
            return httpx.Response(200, json=refresh_response())
        assert database.revision == 2
        assert codec.decrypt(database.ciphertext).refresh_token == "synthetic-new-refresh"
        assert request.headers["Authorization"] == "Bearer synthetic-new-access"
        return httpx.Response(202)

    transport, database, codec, requests, _ = transport_case(
        handler, state=credential_state(expires_at=0)
    )
    assert transport.send(message()).outcome == "accepted"
    assert len(requests) == 2
    assert len([request for request in requests if str(request.url) == GRAPH_SEND_URL]) == 1
    assert "synthetic-new" not in repr(database.calls)


def test_refresh_keeps_previous_refresh_token_when_provider_omits_it():
    token = refresh_response()
    del token["refresh_token"]
    transport, database, codec, _, _ = transport_case(
        lambda request: (
            httpx.Response(202)
            if str(request.url) == GRAPH_SEND_URL
            else httpx.Response(200, json=token)
        ),
        state=credential_state(expires_at=0),
    )
    assert transport.send(message()).outcome == "accepted"
    assert codec.decrypt(database.ciphertext).refresh_token == "synthetic-refresh-only"


@pytest.mark.parametrize(
    "response, outcome, code",
    [
        (
            httpx.Response(
                400, json={"error": "invalid_grant", "error_description": "synthetic secret"}
            ),
            "permanent_failure",
            "authentication_required",
        ),
        (
            httpx.Response(400, json={"error": "consent_required"}),
            "permanent_failure",
            "authentication_required",
        ),
        (httpx.Response(403), "permanent_failure", "authentication_required"),
        (httpx.Response(400, json={"error": []}), "permanent_failure", "token_refresh_rejected"),
        (httpx.Response(500), "retryable_failure", "token_refresh_unavailable"),
        (
            httpx.Response(429, headers={"Retry-After": "60"}),
            "retryable_failure",
            "token_refresh_throttled",
        ),
        (httpx.Response(200, json=[]), "retryable_failure", "token_refresh_invalid"),
        (
            httpx.Response(200, json=refresh_response(token_type=None)),
            "retryable_failure",
            "token_refresh_invalid",
        ),
        (
            httpx.Response(200, json=refresh_response(token_type=[])),
            "retryable_failure",
            "token_refresh_invalid",
        ),
        (
            httpx.Response(200, json=refresh_response(expires_in=True)),
            "retryable_failure",
            "token_refresh_invalid",
        ),
        (
            httpx.Response(200, json=refresh_response(expires_in="3600")),
            "retryable_failure",
            "token_refresh_invalid",
        ),
        (
            httpx.Response(200, json=refresh_response(access_token=None)),
            "retryable_failure",
            "token_refresh_invalid",
        ),
    ],
)
def test_refresh_failure_sends_nothing_and_uses_safe_results(response, outcome, code):
    transport, database, _, requests, _ = transport_case(
        lambda request: response, state=credential_state(expires_at=0)
    )
    result = transport.send(message())
    assert (result.outcome, result.error_code) == (outcome, code)
    assert len(requests) == 1
    assert str(requests[0].url) != GRAPH_SEND_URL
    assert database.revision == 1
    assert "synthetic" not in repr(result)


def test_refresh_network_failure_sends_nothing():
    def handler(request):
        raise httpx.ReadTimeout("synthetic refresh response unknown")

    transport, _, _, requests, _ = transport_case(handler, state=credential_state(expires_at=0))
    assert transport.send(message()).outcome == "retryable_failure"
    assert len(requests) == 1
    assert str(requests[0].url) != GRAPH_SEND_URL


def test_failed_persistence_never_sends_losing_token():
    transport, database, _, requests, _ = transport_case(
        lambda request: httpx.Response(200, json=refresh_response()),
        state=credential_state(expires_at=0),
    )

    def fail_save(name, params):
        if name == "save_automation_email_credential_v1":
            raise RuntimeError("synthetic sensitive database failure")

    database.on_execute = fail_save
    result = transport.send(message())
    assert result.error_code == "credential_store_unavailable"
    assert len(requests) == 1
    assert str(requests[0].url) != GRAPH_SEND_URL


@pytest.mark.parametrize("winner_valid", [True, False])
def test_cas_conflict_reloads_once_and_uses_only_persisted_winner(winner_valid):
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
        if name == "save_automation_email_credential_v1":
            database.revision = 2
            database.ciphertext = codec.encrypt(
                credential_state(
                    access_token="synthetic-winner-access",
                    refresh_token="synthetic-winner-refresh",
                    expires_at=time.time() + 3600 if winner_valid else 0,
                )
            )
            raise Conflict("synthetic raw database details")

    database.on_execute = conflict
    result = transport.send(message())
    assert result.outcome == ("accepted" if winner_valid else "retryable_failure")
    assert len(requests) == (2 if winner_valid else 1)
    assert [name for name, _ in database.calls] == [
        "get_automation_email_credential_v1",
        "save_automation_email_credential_v1",
        "get_automation_email_credential_v1",
    ]
    assert codec.decrypt(database.ciphertext).refresh_token == "synthetic-winner-refresh"


def test_wrong_mailbox_or_missing_credentials_sends_nothing():
    transport, database, _, requests, _ = transport_case(
        lambda request: pytest.fail("network forbidden")
    )
    wrong = CredentialCodec(
        transport._settings.EMAIL_TOKEN_ENCRYPTION_KEY, CLIENT_ID, "other@example.com"
    )
    database.ciphertext = wrong.encrypt(credential_state(mailbox="other@example.com"))
    assert transport.send(message()).error_code == "authentication_required"
    database.ciphertext = None
    database.revision = 0
    assert transport.send(message()).error_code == "setup_required"
    assert requests == []


def test_deadline_exhaustion_before_database(monkeypatch):
    monkeypatch.setattr("app.services.microsoft_graph_email.time.monotonic", lambda: 100)
    transport, database, _, requests, _ = transport_case(
        lambda request: pytest.fail("network forbidden")
    )
    assert transport.send(message(), deadline=104).error_code == "send_budget_exhausted"
    assert database.calls == []
    assert requests == []


@pytest.mark.parametrize("expire_during", ["load", "refresh", "save"])
def test_deadline_after_refresh_or_credential_io_prevents_graph_submission(
    monkeypatch, expire_during
):
    clock = [100.0]
    monkeypatch.setattr("app.services.microsoft_graph_email.time.monotonic", lambda: clock[0])

    def handler(request):
        assert str(request.url) != GRAPH_SEND_URL
        if expire_during == "refresh":
            clock[0] = 125
        return httpx.Response(200, json=refresh_response())

    transport, database, _, requests, _ = transport_case(
        handler, state=credential_state(expires_at=0)
    )

    def consume_budget(name, params):
        if (expire_during == "load" and name.startswith("get_")) or (
            expire_during == "save" and name.startswith("save_")
        ):
            clock[0] = 125

    database.on_execute = consume_budget
    assert transport.send(message(), deadline=125).error_code == "send_budget_exhausted"
    assert not any(str(request.url) == GRAPH_SEND_URL for request in requests)


def test_send_does_not_read_response_body_and_close_error_preserves_acceptance():
    class UnreadableBody(httpx.SyncByteStream):
        def __iter__(self):
            pytest.fail("sendMail response body must not be read")
            yield b""

        def close(self):
            raise RuntimeError("synthetic sensitive cleanup details")

    transport, _, _, requests, _ = transport_case(
        lambda request: httpx.Response(202, stream=UnreadableBody())
    )
    assert transport.send(message()).outcome == "accepted"
    assert len(requests) == 1


def test_refresh_limits_streamed_response_before_persist_or_send():
    class LargeBody(httpx.SyncByteStream):
        def __iter__(self):
            yield b"x" * 131072
            yield b"x"
            pytest.fail("refresh body read past cap")

    transport, database, _, requests, _ = transport_case(
        lambda request: httpx.Response(200, stream=LargeBody()),
        state=credential_state(expires_at=0),
    )
    assert transport.send(message()).error_code == "token_refresh_invalid"
    assert database.revision == 1
    assert len(requests) == 1


def test_deeply_nested_refresh_json_does_not_escape_as_raw_exception():
    transport, database, _, requests, _ = transport_case(
        lambda request: httpx.Response(200, content=b"[" * 2000 + b"]" * 2000),
        state=credential_state(expires_at=0),
    )
    assert transport.send(message()).error_code == "token_refresh_invalid"
    assert database.revision == 1
    assert len(requests) == 1


@pytest.mark.parametrize(
    "header, expected", [("invalid", 60), ("0", 1), ("25", 25), ("9999999", 3600)]
)
def test_bounded_retry_after(header, expected):
    transport, _, _, _, _ = transport_case(
        lambda request: httpx.Response(429, headers={"Retry-After": header})
    )
    assert transport.send(message()).retry_after_seconds == expected


def test_http_date_retry_after_and_request_id_privacy():
    header = format_datetime(datetime.now(UTC) + timedelta(seconds=180))
    transport, _, _, _, _ = transport_case(
        lambda request: httpx.Response(
            429, headers={"Retry-After": header, "request-id": "private@example.com"}
        )
    )
    result = transport.send(message())
    assert 178 <= result.retry_after_seconds <= 181
    assert result.provider_request_id is None
