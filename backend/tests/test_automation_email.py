from types import SimpleNamespace

import pytest
from cryptography.fernet import Fernet
from test_automation_email_credentials import CLIENT_ID, FakeCredentialDatabase, credential_state

from app.services.automation_email import (
    DEFAULT_MISSED_CLASS_BODY,
    DEFAULT_MISSED_CLASS_SUBJECT,
    EmailMessage,
    build_email_transport,
    email_delivery_status,
    normalize_email_address,
    render_missed_class_email,
    validate_missed_class_templates,
    validate_public_api_url,
)
from app.services.automation_email_credentials import CredentialCodec


def email_settings(**changes):
    values = {
        "EMAIL_PROVIDER": "microsoft_graph",
        "EMAIL_SEND_ENABLED": True,
        "EMAIL_FROM_ADDRESS": "koaryu@outlook.com",
        "EMAIL_FROM_NAME": "Koaryu",
        "EMAIL_REPLY_TO": "reply@example.com",
        "EMAIL_ALLOWED_RECIPIENTS": "koaryu@outlook.com",
        "EMAIL_GRAPH_CLIENT_ID": CLIENT_ID,
        "EMAIL_GRAPH_CLIENT_SECRET": "synthetic-client-secret",
        "EMAIL_GRAPH_TENANT": "consumers",
        "EMAIL_TOKEN_ENCRYPTION_KEY": Fernet.generate_key().decode(),
        "AUTOMATION_PUBLIC_API_URL": "https://api.example.com/api/v1",
    }
    values.update(changes)
    return SimpleNamespace(**values)


def test_renderer_escapes_content_and_does_not_reinterpret_replacements():
    context = {
        "student_first_name": "<script>&{{studio_name}}",
        "studio_name": 'A "B" & C',
        "days_absent": 14,
    }
    content = render_missed_class_email(
        "Hi {{student_first_name}}",
        "{{student_first_name}}\n{{studio_name}} {{days_absent}}",
        context,
    )
    assert content.subject == "Hi <script>&{{studio_name}}"
    assert "<script>" not in content.html_body
    assert "&lt;script&gt;&amp;{{studio_name}}" in content.html_body
    assert "A &quot;B&quot; &amp; C" in content.html_body
    assert "14" in content.text_body
    assert "Unsubscribe" not in content.text_body


def test_renderer_defaults_and_safe_footer():
    content = render_missed_class_email(
        DEFAULT_MISSED_CLASS_SUBJECT,
        DEFAULT_MISSED_CLASS_BODY,
        {"student_first_name": "Sam", "studio_name": "Example studio"},
        "https://api.example.com/api/v1/automations/unsubscribe/opaque?x=1&y=2",
    )
    assert content.subject == "We miss seeing Sam at Example studio"
    assert "Unsubscribe from these reminders: https://" in content.text_body
    assert "?x=1&amp;y=2" in content.html_body
    assert "Sam" not in repr(content)


@pytest.mark.parametrize(
    "template",
    [
        "",
        " ",
        "{{unknown}}",
        "{{ student_first_name }}",
        "{student_first_name}",
        "{{student_first_name}",
        "{{{student_first_name}}}",
        "Hi\r\nBcc: other@example.com",
        "a\x00b",
        "a" * 201,
    ],
)
def test_template_validation_rejects_bad_subject(template):
    with pytest.raises(ValueError, match="^invalid_email_template$"):
        validate_missed_class_templates(template, "Body")


@pytest.mark.parametrize("body", ["", " ", "{{unknown}}", "a" * 5001, "x\x00y", "x\ry"])
def test_template_validation_rejects_bad_body(body):
    with pytest.raises(ValueError, match="^invalid_email_template$"):
        validate_missed_class_templates("Subject", body)


@pytest.mark.parametrize(
    "context",
    [
        {},
        {"student_first_name": "Sam\nBcc: p@example.com"},
        {"student_first_name": None},
        {"student_first_name": []},
    ],
)
def test_renderer_rejects_unsafe_context(context):
    with pytest.raises(ValueError, match="^invalid_email_context$"):
        render_missed_class_email("Hi {{student_first_name}}", "Body", context)


@pytest.mark.parametrize(
    "url",
    [
        "javascript:alert(1)",
        "//example.com",
        "http://example.com",
        "https://user:pass@example.com",
        "https://example.com/#fragment",
        "https://localhost/api/v1",
        "https://127.0.0.1/api/v1",
        "https://example.com/\n",
        "https://example.com:1234/api/v1",
    ],
)
def test_renderer_rejects_unsafe_unsubscribe_urls(url):
    with pytest.raises(ValueError, match="^invalid_email_url$"):
        render_missed_class_email("Subject", "Body", {}, url)


def test_public_api_base_validation():
    assert (
        validate_public_api_url("https://api.example.com/api/v1")
        == "https://api.example.com/api/v1"
    )
    for url in (
        "https://api.example.com",
        "https://api.example.com/api/v1?x=1",
        "https://api.example.com/api/v1/",
    ):
        with pytest.raises(ValueError):
            validate_public_api_url(url)


def test_unsubscribe_fragment_is_retained_but_cannot_be_part_of_base_url():
    token = "synthetic_opaque_token_" + "a" * 24
    url = "https://api.example.com/api/v1/automations/unsubscribe#" + token
    content = render_missed_class_email("Subject", "Body", {}, url)
    assert url in content.text_body
    assert 'href="' + url + '"' in content.html_body
    with pytest.raises(ValueError, match="^invalid_email_url$"):
        validate_public_api_url("https://api.example.com/api/v1#" + token)


@pytest.mark.parametrize(
    "input_address, expected",
    [
        ("Person+tag@EXAMPLE.COM", "person+tag@example.com"),
        ("  person@example.com  ", "person@example.com"),
        ("a!#$%&'*+/=?^_`{|}~-@example.com", "a!#$%&'*+/=?^_`{|}~-@example.com"),
        ("a@b.c", "a@b.c"),
        ("a@sub-domain.example.com", "a@sub-domain.example.com"),
        ("a@xn--bcher-kva.example", "a@xn--bcher-kva.example"),
        ("a" * 64 + "@example.com", "a" * 64 + "@example.com"),
        (
            "a" * 64 + "@" + "b" * 63 + "." + "c" * 63 + "." + "d" * 61,
            "a" * 64 + "@" + "b" * 63 + "." + "c" * 63 + "." + "d" * 61,
        ),
    ],
)
def test_email_parity_accepted(input_address, expected):
    assert normalize_email_address(input_address) == expected


@pytest.mark.parametrize(
    "address",
    [
        "",
        "person",
        "p@@example.com",
        ".p@example.com",
        "p.@example.com",
        "p..q@example.com",
        "p@example",
        "p@example.com.",
        "p@-example.com",
        "p@example-.com",
        "p@ex_ample.com",
        "p@example..com",
        "p q@example.com",
        '"p"@example.com',
        "p\t@example.com",
        "\tp@example.com",
        "p@example.com\n",
        "p\r\n@example.com",
        "p\x7f@example.com",
        "pérson@example.com",
        "p@bücher.example",
        "\u00a0p@example.com",
        "a" * 65 + "@example.com",
        "p@" + "b" * 64 + ".com",
        "a" * 64 + "@" + "b" * 63 + "." + "c" * 63 + "." + "d" * 62,
    ],
)
def test_email_parity_rejected(address):
    with pytest.raises(ValueError, match="^invalid_email_address$"):
        normalize_email_address(address)


def test_disabled_factory_never_reads_settings_credentials_or_database():
    class Closed:
        EMAIL_SEND_ENABLED = False

        def __getattr__(self, name):
            raise AssertionError("closed transport read configuration")

    class NoDatabase:
        def __getattr__(self, name):
            raise AssertionError("closed transport touched database")

    result = build_email_transport(Closed(), NoDatabase()).send(
        EmailMessage("", "", "", "", "", "attempt")
    )
    assert result.outcome == "permanent_failure"
    assert result.error_code == "sending_disabled"


def test_status_requires_decryptable_bound_stored_state_and_never_refreshes():
    settings = email_settings()
    codec = CredentialCodec(
        settings.EMAIL_TOKEN_ENCRYPTION_KEY, CLIENT_ID, settings.EMAIL_FROM_ADDRESS
    )
    database = FakeCredentialDatabase()
    assert email_delivery_status(settings, database)["reason"] == "setup_required"
    database.ciphertext = codec.encrypt(credential_state(access_token=None, expires_at=0))
    database.revision = 1
    assert email_delivery_status(settings, database) == {
        "mode": "test",
        "configured": True,
        "can_enable": True,
        "sender": "koaryu@outlook.com",
        "test_recipient": "koaryu@outlook.com",
        "reason": None,
    }
    assert all(name == "get_automation_email_credential_v1" for name, _ in database.calls)
    settings.EMAIL_SEND_ENABLED = False
    assert email_delivery_status(settings, database)["reason"] == "sending_disabled"
    assert email_delivery_status(settings, database)["configured"] is True
    assert email_delivery_status(settings, database)["can_enable"] is False
    settings.EMAIL_SEND_ENABLED = True
    settings.EMAIL_ALLOWED_RECIPIENTS = ""
    assert email_delivery_status(settings, database)["mode"] == "live"
    assert email_delivery_status(settings, database)["test_recipient"] is None
    settings.EMAIL_FROM_ADDRESS = "other@example.com"
    assert email_delivery_status(settings, database)["configured"] is False


def test_status_safe_store_failure_and_bad_configuration():
    settings = email_settings()
    database = FakeCredentialDatabase()

    def fail(name, params):
        raise RuntimeError("synthetic secret")

    database.on_execute = fail
    status = email_delivery_status(settings, database)
    assert status["reason"] == "unavailable"
    assert "synthetic" not in repr(status)
    settings.EMAIL_REPLY_TO = "bad\r\naddress"
    assert email_delivery_status(settings, database)["reason"] == "setup_required"
    settings = email_settings(EMAIL_TOKEN_ENCRYPTION_KEY="invalid-key")
    assert email_delivery_status(settings, database)["reason"] == "setup_required"
