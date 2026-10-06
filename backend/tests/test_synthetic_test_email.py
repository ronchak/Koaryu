"""Closed synthetic content and shared Graph delivery, using fictional local fixtures."""

import inspect
import json
from dataclasses import FrozenInstanceError, fields, replace
from html import escape
from unittest.mock import Mock

import httpx
import pytest
from test_automation_email_credentials import credential_state
from test_microsoft_graph_email import REQUEST_ID, refresh_response, transport_case
from test_workflow_email import event_for

from app.services.automation_email import (
    EmailMessage,
    SyntheticTestEmailMessage,
    assemble_plain_text_email,
    assemble_synthetic_test_email,
)
from app.services.microsoft_graph_email import GRAPH_SEND_URL, PreparedEmailSender
from app.services.workflow_email import render_workflow_email

SUBJECT_PREFIX = "[Test] "
BODY_PREFIX = "Synthetic automation test. Sample data only.\n\n"
MESSAGE_TYPES = (EmailMessage, SyntheticTestEmailMessage)


def make_message(message_type=SyntheticTestEmailMessage, subject="Subject", body="Body"):
    assemble = (
        assemble_synthetic_test_email
        if message_type is SyntheticTestEmailMessage
        else assemble_plain_text_email
    )
    content = assemble(subject, body)
    return message_type(
        " KOARYU@OUTLOOK.COM ",
        content.subject,
        content.text_body,
        content.html_body,
        " STUDIO@EXAMPLE.COM ",
        "synthetic-attempt-1",
    )


def assert_not_submitted(result, code):
    assert result.error_code == code
    assert result.submission_evidence == "not_submitted"
    assert result.credential_revision is None
    assert result.provider_request_id is None


def test_labels_cover_complete_plain_and_html_body_without_reinterpreting_rendered_text():
    rendered = render_workflow_email(
        event_for("student_first_name"),
        "Hi {{student_first_name}}",
        "Hello {{student_first_name}}\n\tSample & 'quoted' text",
        {"student_first_name": '<b>Sam</b> {{studio_name}} "name"'},
        unsubscribe_url=None,
    )
    content = assemble_synthetic_test_email(rendered.subject, rendered.text_body)
    assert content.subject == SUBJECT_PREFIX + rendered.subject
    assert content.text_body == BODY_PREFIX + rendered.text_body
    assert (
        content.html_body == assemble_plain_text_email(content.subject, content.text_body).html_body
    )
    assert content.html_body == (
        '<div style="white-space: pre-wrap">' + escape(content.text_body) + "</div>"
    )
    assert "{{studio_name}}" in content.text_body
    assert "&lt;b&gt;Sam&lt;/b&gt;" in content.html_body
    assert "<b>" not in content.html_body
    assert "&quot;name&quot;" in content.html_body and "&#x27;quoted&#x27;" in content.html_body
    assert "Unsubscribe" not in content.text_body + content.html_body
    assert "href=" not in content.html_body


def test_literal_existing_labels_are_preserved_and_fixed_labels_are_added_once():
    subject, body = SUBJECT_PREFIX + "Original", BODY_PREFIX + "Original"
    content = assemble_synthetic_test_email(subject, body)
    assert content.subject == SUBJECT_PREFIX + subject
    assert content.text_body == BODY_PREFIX + body
    assert content.html_body.count(BODY_PREFIX) == 2


def test_explicit_message_type_is_frozen_with_the_same_six_fields_and_no_flags():
    expected = ("to_address", "subject", "text_body", "html_body", "reply_to", "attempt_id")
    assert tuple(field.name for field in fields(SyntheticTestEmailMessage)) == expected
    assert inspect.signature(SyntheticTestEmailMessage) == inspect.signature(EmailMessage)
    assert tuple(inspect.signature(assemble_synthetic_test_email).parameters) == ("subject", "body")
    message = make_message()
    assert isinstance(message, EmailMessage)
    with pytest.raises(FrozenInstanceError):
        message.subject = "Changed"
    for value in (message.subject, message.text_body, message.html_body, message.to_address):
        assert value not in repr(message)
    for keyword in ("unsubscribe_url", "profile", "subject_limit", "max_body", "to_address"):
        with pytest.raises(TypeError):
            assemble_synthetic_test_email("Subject", "Body", **{keyword: "caller choice"})
        with pytest.raises(TypeError):
            SyntheticTestEmailMessage("a", "b", "c", "d", "e", "f", **{keyword: True})


@pytest.mark.parametrize("character", ["x", "💌", '"'])
def test_maximum_original_content_fits_only_the_explicit_synthetic_transport_profile(character):
    subject, body = character * 200, character * 20000
    ordinary = assemble_plain_text_email(subject, body)
    synthetic = assemble_synthetic_test_email(subject, body)
    assert ordinary.subject == subject and ordinary.text_body == body
    assert len(synthetic.subject) == 207 and len(synthetic.text_body) == 20046
    assert len(synthetic.subject.encode("utf-8")) <= 807
    assert len(synthetic.text_body.encode("utf-8")) <= 80046
    assert len(synthetic.html_body) <= 120317
    assert len(synthetic.html_body.encode("utf-8")) <= 120317
    if character == "💌":
        assert len(synthetic.subject.encode("utf-8")) == 807
        assert len(synthetic.text_body.encode("utf-8")) == 80046
    if character == '"':
        assert len(synthetic.html_body) == 120087
    transport, _, _, requests, _ = transport_case(lambda request: httpx.Response(202))
    assert transport.send(make_message(EmailMessage, subject, body)).outcome == "accepted"
    message = make_message(SyntheticTestEmailMessage, subject, body)
    assert transport.send(message).outcome == "accepted"
    ordinary_with_labels = EmailMessage(
        *(getattr(message, field.name) for field in fields(message))
    )
    assert_not_submitted(transport.send(ordinary_with_labels), "invalid_message")
    assert len(requests) == 2


@pytest.mark.parametrize("assemble", [assemble_plain_text_email, assemble_synthetic_test_email])
@pytest.mark.parametrize("subject,body", [("x" * 201, "Body"), ("Subject", "x" * 20001)])
def test_ordinary_input_limits_remain_closed_for_both_assemblers(assemble, subject, body):
    with pytest.raises(ValueError, match="^invalid_email_context$"):
        assemble(subject, body)


@pytest.mark.parametrize("field", ["subject", "body"])
@pytest.mark.parametrize(
    "value",
    [
        None,
        1,
        True,
        [],
        {},
        b"Body",
        "",
        " \n\t",
        pytest.param("\ud800", id="high-surrogate"),
        pytest.param("\udfff", id="low-surrogate"),
    ],
)
def test_synthetic_assembly_rejects_invalid_original_text_without_coercion(field, value):
    inputs = {"subject": "Subject", "body": "Body", field: value}
    with pytest.raises(ValueError, match="^invalid_email_context$"):
        assemble_synthetic_test_email(**inputs)


@pytest.mark.parametrize("control", [chr(code) for code in (*range(32), *range(127, 160))])
def test_synthetic_controls_match_ordinary_subject_and_body_rules(control):
    with pytest.raises(ValueError, match="^invalid_email_context$"):
        assemble_synthetic_test_email("Before" + control + "After", "Body")
    if control in "\n\t":
        content = assemble_synthetic_test_email("Subject", "Before" + control + "After")
        assert content.text_body == BODY_PREFIX + "Before" + control + "After"
    else:
        with pytest.raises(ValueError, match="^invalid_email_context$"):
            assemble_synthetic_test_email("Subject", "Before" + control + "After")


def test_synthetic_utf8_guard_does_not_change_ordinary_unicode_or_url_error_order():
    ordinary = assemble_plain_text_email("Subject\ud800", "Body\udfff")
    assert ordinary.subject == "Subject\ud800" and ordinary.text_body == "Body\udfff"
    with pytest.raises(ValueError, match="^invalid_email_url$"):
        assemble_plain_text_email("Subject\ud800", "Body", "not-a-url")
    with pytest.raises(ValueError, match="^invalid_email_context$"):
        assemble_plain_text_email("x" * 201, "Body", "not-a-url")


@pytest.mark.parametrize("prepared_send", [False, True])
@pytest.mark.parametrize(
    "changes",
    [
        {"subject": "Subject"},
        {"subject": "[TEST] Subject"},
        {"subject": SUBJECT_PREFIX},
        {"subject": SUBJECT_PREFIX + " "},
        {"subject": SUBJECT_PREFIX + "x" * 201},
        {"subject": SUBJECT_PREFIX + "💌" * 201},
        {"subject": SUBJECT_PREFIX + "x\x00"},
        {"subject": SUBJECT_PREFIX + "x\n"},
        {"subject": SUBJECT_PREFIX + "x\ud800"},
        {"text_body": "Body"},
        {"text_body": BODY_PREFIX.replace("Sample", "Real") + "Body"},
        {"text_body": BODY_PREFIX},
        {"text_body": BODY_PREFIX + " \n\t"},
        {"text_body": BODY_PREFIX + "x" * 20001},
        {"text_body": BODY_PREFIX + "💌" * 20001},
        {"text_body": BODY_PREFIX + "x\x00"},
        {"text_body": BODY_PREFIX + "x\r"},
        {"text_body": BODY_PREFIX + "x\udfff"},
        {"html_body": '<div style="white-space: pre-wrap">Body</div>'},
        {"html_body": "<div hidden>" + BODY_PREFIX + "</div><div>Body</div>"},
        {"html_body": "<div>" + BODY_PREFIX + "Body</div>"},
        {"html_body": "x" * 120318},
        {"html_body": "💌" * 30080},
        {"html_body": "\ud800"},
        {"html_body": "\x00"},
        {"html_body": None},
        {"subject": None},
        {"text_body": None},
        {"attempt_id": "bad\n"},
        {"attempt_id": "x" * 129},
    ],
)
def test_typed_synthetic_messages_cannot_bypass_profile_or_hide_html_label(prepared_send, changes):
    transport, database, _, requests, options = transport_case(
        lambda request: pytest.fail("invalid synthetic content must not submit")
    )
    prepared = transport.prepare() if prepared_send else None
    calls = list(database.calls)
    message = replace(make_message(), **changes)
    result = (
        transport.send_prepared(message, prepared) if prepared_send else transport.send(message)
    )
    assert_not_submitted(result, "invalid_message")
    assert result.outcome == "permanent_failure" and result.failure_scope == "message"
    assert database.calls == calls and requests == options == []


def test_synthetic_html_cannot_append_footer_or_use_raw_original_markup():
    message = make_message(body="<b>Body</b>")
    candidates = (
        message.html_body + '<p><a href="https://example.com/unsubscribe">Unsubscribe</a></p>',
        message.html_body.replace("&lt;b&gt;Body&lt;/b&gt;", "<b>Body</b>"),
    )
    transport, _, _, requests, _ = transport_case(lambda request: pytest.fail("must not submit"))
    for html in candidates:
        assert_not_submitted(transport.send(replace(message, html_body=html)), "invalid_message")
    assert requests == []


def test_ordinary_transport_keeps_its_existing_html_and_plain_body_validation():
    message = replace(make_message(EmailMessage), text_body="x" * 20001, html_body="<b>Custom</b>")
    transport, _, _, requests, _ = transport_case(lambda request: httpx.Response(202))
    assert transport.send(message).outcome == "accepted"
    assert len(requests) == 1


@pytest.mark.parametrize("message_type", MESSAGE_TYPES)
def test_both_types_use_the_existing_prepare_send_prepared_and_exact_provider_payload(message_type):
    transport, database, _, requests, options = transport_case(lambda request: httpx.Response(202))
    transport.prepare = Mock(wraps=transport.prepare)
    transport.send_prepared = Mock(wraps=transport.send_prepared)
    message = make_message(message_type, "Subject & facts", "Body <facts>\nSecond line")
    result = transport.send(message)
    transport.prepare.assert_called_once_with(deadline=None)
    args, kwargs = transport.send_prepared.call_args
    assert args[0] is message and isinstance(args[1], PreparedEmailSender)
    assert kwargs == {"deadline": None}
    assert result.outcome == result.submission_evidence == "accepted"
    assert result.credential_revision == 1 and result.provider_request_id is None
    assert [name for name, _ in database.calls] == ["get_automation_email_credential_v1"]
    assert options == [{"timeout": 5.0, "trust_env": False, "follow_redirects": False}]
    assert len(requests) == 1
    request = requests[0]
    assert request.method == "POST" and str(request.url) == GRAPH_SEND_URL
    assert request.headers["Authorization"] == "Bearer synthetic-access-only"
    assert request.headers["client-request-id"] == message.attempt_id
    assert "idempotency-key" not in request.headers
    assert json.loads(request.content) == {
        "message": {
            "subject": message.subject,
            "body": {"contentType": "HTML", "content": message.html_body},
            "from": {"emailAddress": {"address": "koaryu@outlook.com", "name": "Koaryu"}},
            "toRecipients": [{"emailAddress": {"address": "koaryu@outlook.com"}}],
            "replyTo": [{"emailAddress": {"address": "studio@example.com"}}],
        },
        "saveToSentItems": True,
    }


@pytest.mark.parametrize("message_type", MESSAGE_TYPES)
def test_refreshed_exact_handle_revision_is_used_without_reloading_credentials(message_type):
    def handler(request):
        if str(request.url) != GRAPH_SEND_URL:
            return httpx.Response(200, json=refresh_response())
        assert request.headers["Authorization"] == "Bearer synthetic-new-access"
        return httpx.Response(202)

    transport, database, _, requests, _ = transport_case(
        handler, state=credential_state(expires_at=0)
    )
    prepared = transport.prepare()
    assert prepared.envelope.revision == 2
    calls = list(database.calls)
    database.revision, database.ciphertext = 99, "later-unusable-envelope"
    result = transport.send_prepared(make_message(message_type), prepared)
    assert result.credential_revision == 2 and result.submission_evidence == "accepted"
    assert database.calls == calls and len(requests) == 2


@pytest.mark.parametrize("message_type", MESSAGE_TYPES)
@pytest.mark.parametrize("elapsed", [59.999, 60, 60.001, -1])
def test_synthetic_type_does_not_extend_prepared_handle_age(monkeypatch, message_type, elapsed):
    clock = [100.0]
    monkeypatch.setattr("app.services.microsoft_graph_email.time.monotonic", lambda: clock[0])
    transport, database, _, requests, _ = transport_case(lambda request: httpx.Response(202))
    prepared = transport.prepare()
    calls = list(database.calls)
    clock[0] += elapsed
    result = transport.send_prepared(make_message(message_type), prepared)
    if elapsed == 59.999:
        assert result.outcome == "accepted"
    else:
        assert_not_submitted(result, "credential_refresh_conflict")
    assert len(requests) == int(elapsed == 59.999) and database.calls == calls


@pytest.mark.parametrize("message_type", MESSAGE_TYPES)
@pytest.mark.parametrize(
    "setting,value,code",
    [
        ("EMAIL_SEND_ENABLED", False, "sending_disabled"),
        ("EMAIL_FROM_ADDRESS", "other@example.com", "setup_required"),
        ("EMAIL_GRAPH_CLIENT_SECRET", "changed-synthetic-secret", "setup_required"),
        ("EMAIL_ALLOWED_RECIPIENTS", "koaryu@outlook.com", "recipient_not_allowed"),
    ],
)
def test_profile_does_not_bypass_sender_binding_or_current_allowlist(
    message_type, setting, value, code
):
    transport, database, _, requests, options = transport_case(
        lambda request: pytest.fail("changed configuration must not submit")
    )
    transport._settings.EMAIL_ALLOWED_RECIPIENTS = ""
    prepared = transport.prepare()
    calls = list(database.calls)
    setattr(transport._settings, setting, value)
    message = replace(make_message(message_type), to_address="fictional@example.com")
    assert_not_submitted(transport.send_prepared(message, prepared), code)
    assert database.calls == calls and requests == options == []


@pytest.mark.parametrize("message_type", MESSAGE_TYPES)
@pytest.mark.parametrize(
    "status,evidence", [(202, "accepted"), (400, "rejected"), (503, "unknown")]
)
@pytest.mark.parametrize("request_id", [REQUEST_ID, "invalid-private-request-id"])
def test_profile_keeps_acceptance_null_request_id_and_unknown_evidence(
    message_type, status, evidence, request_id
):
    transport, _, _, requests, _ = transport_case(
        lambda request: httpx.Response(status, headers={"request-id": request_id})
    )
    result = transport.send_prepared(make_message(message_type), transport.prepare())
    assert result.submission_evidence == evidence and result.credential_revision == 1
    assert result.provider_request_id == (REQUEST_ID if request_id == REQUEST_ID else None)
    assert len(requests) == 1


@pytest.mark.parametrize("message_type", MESSAGE_TYPES)
def test_expired_deadline_stops_before_provider_io(monkeypatch, message_type):
    monkeypatch.setattr("app.services.microsoft_graph_email.time.monotonic", lambda: 100.0)
    transport, database, _, requests, options = transport_case(
        lambda request: pytest.fail("expired deadline must not submit")
    )
    prepared = transport.prepare()
    calls = list(database.calls)
    assert_not_submitted(
        transport.send_prepared(make_message(message_type), prepared, deadline=100.0),
        "send_budget_exhausted",
    )
    assert database.calls == calls and requests == options == []


@pytest.mark.parametrize("message_type", MESSAGE_TYPES)
def test_timeout_after_submission_stays_unknown_without_retry(message_type):
    def handler(request):
        raise httpx.ReadTimeout("synthetic provider details")

    transport, _, _, requests, _ = transport_case(handler)
    result = transport.send_prepared(make_message(message_type), transport.prepare())
    assert result.outcome == result.submission_evidence == "unknown"
    assert result.failure_scope == "unclassified" and result.credential_revision == 1
    assert len(requests) == 1 and "synthetic provider" not in repr(result)


@pytest.mark.parametrize("message_type", MESSAGE_TYPES)
def test_response_cleanup_error_preserves_observed_acceptance(message_type):
    class UnreadableBody(httpx.SyncByteStream):
        def __iter__(self):
            pytest.fail("send response body must not be read")
            yield b""

        def close(self):
            raise RuntimeError("synthetic cleanup details")

    transport, _, _, requests, _ = transport_case(
        lambda request: httpx.Response(202, stream=UnreadableBody())
    )
    result = transport.send_prepared(make_message(message_type), transport.prepare())
    assert result.outcome == result.submission_evidence == "accepted"
    assert result.credential_revision == 1 and len(requests) == 1
