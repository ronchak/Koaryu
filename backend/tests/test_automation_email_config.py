"""Mail configuration checks use synthetic values and never load enrollment files."""

import traceback
from unittest.mock import patch

import pytest
from cryptography.fernet import Fernet
from pydantic import ValidationError
from test_config import VALID_PRODUCTION_SETTINGS, VALID_STAGING_SETTINGS

from app.core.config import Settings
from app.services.automation_email import delivery_configuration


@pytest.fixture
def enabled_mail():
    return {
        "EMAIL_PROVIDER": "microsoft_graph",
        "EMAIL_SEND_ENABLED": True,
        "EMAIL_GRAPH_CLIENT_ID": "00000000-0000-4000-8000-000000000001",
        "EMAIL_GRAPH_CLIENT_SECRET": "synthetic-client-credential-for-tests",
        "EMAIL_TOKEN_ENCRYPTION_KEY": Fernet.generate_key().decode("ascii"),
        "AUTOMATION_PUBLIC_API_URL": "https://automation.example.com/api/v1",
    }


@pytest.mark.parametrize(
    "environment,baseline",
    [
        ("development", {}),
        ("test", {}),
        ("production", VALID_PRODUCTION_SETTINGS),
        ("staging", VALID_STAGING_SETTINGS),
    ],
)
def test_disabled_defaults_preserve_runtime_startup_without_credentials(environment, baseline):
    settings = Settings(_env_file=None, ENVIRONMENT=environment, **baseline)
    with (
        patch("httpx.Client", side_effect=AssertionError("no network client at startup")),
        patch(
            "app.services.automation_email_credentials.CredentialRepository.load",
            side_effect=AssertionError("no credential read at startup"),
        ),
    ):
        settings.validate_runtime_configuration()
    assert settings.EMAIL_PROVIDER == "disabled"
    assert settings.EMAIL_SEND_ENABLED is False
    assert settings.AUTOMATION_WORKER_ENABLED is False
    assert settings.EMAIL_ALLOWED_RECIPIENTS == "koaryu@outlook.com"
    assert settings.EMAIL_GRAPH_CLIENT_SECRET == settings.EMAIL_TOKEN_ENCRYPTION_KEY == ""


def test_enabled_configuration_requires_no_network_or_token_store_at_startup(enabled_mail):
    with (
        patch("httpx.Client", side_effect=AssertionError("no network client at startup")),
        patch(
            "app.services.automation_email_credentials.CredentialRepository.load",
            side_effect=AssertionError("no credential read at startup"),
        ),
    ):
        Settings(_env_file=None, **enabled_mail).validate_runtime_configuration()


@pytest.mark.parametrize("allowed", ["koaryu@outlook.com", " KOARYU@OUTLOOK.COM ", ""])
def test_actual_recipient_allowlist_and_explicit_live_mode(enabled_mail, allowed):
    settings = Settings(_env_file=None, **{**enabled_mail, "EMAIL_ALLOWED_RECIPIENTS": allowed})
    settings.validate_automation_email_configuration()
    assert delivery_configuration(settings).allowed_recipients == (
        frozenset({"koaryu@outlook.com"}) if allowed else frozenset()
    )


def test_blank_reply_to_uses_sender(enabled_mail):
    settings = Settings(_env_file=None, EMAIL_REPLY_TO="", **enabled_mail)
    settings.validate_automation_email_configuration()
    assert delivery_configuration(settings).reply_to == "koaryu@outlook.com"


@pytest.mark.parametrize(
    "tenant", ["consumers", "common", "organizations", "00000000-0000-4000-8000-000000000002"]
)
def test_valid_tenant_forms(enabled_mail, tenant):
    Settings(
        _env_file=None, EMAIL_GRAPH_TENANT=tenant, **enabled_mail
    ).validate_automation_email_configuration()


@pytest.mark.parametrize(
    "field,value",
    [
        ("EMAIL_FROM_ADDRESS", "sender@outlook.com\r\nBcc: victim@example.com"),
        ("EMAIL_REPLY_TO", "display name <recipient@example.com>"),
        ("EMAIL_FROM_ADDRESS", "nonascii\N{LATIN SMALL LETTER E WITH ACUTE}@example.com"),
        ("EMAIL_FROM_NAME", "Koaryu\nBcc: victim@example.com"),
        ("EMAIL_FROM_NAME", "\x85name"),
        ("EMAIL_FROM_NAME", ""),
        ("EMAIL_ALLOWED_RECIPIENTS", "victim@example.com"),
        ("EMAIL_ALLOWED_RECIPIENTS", "koaryu@outlook.com,victim@example.com"),
        ("EMAIL_ALLOWED_RECIPIENTS", " "),
        ("EMAIL_ALLOWED_RECIPIENTS", "koaryu@outlook.com,"),
        ("EMAIL_GRAPH_TENANT", "consumers/../../evil"),
        ("EMAIL_GRAPH_TENANT", "https://evil.example.com"),
        ("EMAIL_GRAPH_CLIENT_SECRET", "synthetic\ncredential"),
        ("EMAIL_TOKEN_ENCRYPTION_KEY", "synthetic\x00credential"),
        ("AUTOMATION_WORKER_SECRET", "synthetic\ncredential"),
    ],
)
def test_unsafe_values_fail_without_echo_even_while_disabled(field, value):
    settings = Settings(_env_file=None, **{field: value})
    with pytest.raises(RuntimeError, match=field) as error:
        settings.validate_automation_email_configuration()
    if value.strip():
        assert value not in "".join(traceback.format_exception(error.value))


@pytest.mark.parametrize(
    "field,value",
    [
        ("EMAIL_PROVIDER", "disabled"),
        ("EMAIL_GRAPH_CLIENT_ID", "your-mail-app"),
        ("EMAIL_GRAPH_CLIENT_SECRET", ""),
        ("EMAIL_GRAPH_CLIENT_SECRET", "your-mail-secret"),
        ("EMAIL_TOKEN_ENCRYPTION_KEY", "not-a-fernet-key"),
        ("EMAIL_TOKEN_ENCRYPTION_KEY", ""),
        ("AUTOMATION_PUBLIC_API_URL", ""),
    ],
)
def test_sending_requires_complete_mail_configuration(enabled_mail, field, value):
    settings = Settings(_env_file=None, **{**enabled_mail, field: value})
    with pytest.raises(RuntimeError, match=field) as error:
        settings.validate_automation_email_configuration()
    if value:
        assert value not in "".join(traceback.format_exception(error.value))


@pytest.mark.parametrize(
    "url",
    [
        "http://localhost:8001/api/v1",
        "https://localhost/api/v1",
        "https://127.0.0.1/api/v1",
        "https://127.1/api/v1",
        "https://10.0.0.1/api/v1",
        "https://[::1]/api/v1",
        "https://service.local/api/v1",
        "https://-bad.example.com/api/v1",
        "https://service..example.com/api/v1",
        "https://automation.example.com/api/v1/",
        "https://automation.example.com:443/api/v1",
        "https://user@automation.example.com/api/v1",
        "https://automation.example.com@evil.example.com/api/v1?next=secret",
        "https://automation.example.com/api/v1?",
        "https://automation.example.com/api/v1#",
        "https://automation.example.com/api/v1#secret",
        " https://automation.example.com/api/v1",
        "https://automation.example.com/other",
        "https://automation.example.com\\@127.0.0.1/api/v1",
    ],
)
def test_public_unsubscribe_base_is_safe_even_in_test(enabled_mail, url):
    settings = Settings(_env_file=None, **{**enabled_mail, "AUTOMATION_PUBLIC_API_URL": url})
    with pytest.raises(RuntimeError, match="AUTOMATION_PUBLIC_API_URL") as error:
        settings.validate_automation_email_configuration()
    assert url not in "".join(traceback.format_exception(error.value))


@pytest.mark.parametrize(
    "environment,host", [("production", "koaryu"), ("staging", "koaryu-staging")]
)
def test_hosted_backend_base_is_exactly_pinned(enabled_mail, environment, host):
    settings = Settings(
        _env_file=None,
        ENVIRONMENT=environment,
        **{
            **enabled_mail,
            "AUTOMATION_PUBLIC_API_URL": f"https://{host}.onrender.com/api/v1",
        },
    )
    settings.validate_automation_email_configuration()
    settings.AUTOMATION_PUBLIC_API_URL = "https://automation.example.com/api/v1"
    with pytest.raises(RuntimeError, match="pinned backend"):
        settings.validate_automation_email_configuration()


@pytest.mark.parametrize(
    "secret",
    [
        "",
        "short",
        "long-random-secret-for-missed-class-worker",
        "a" * 31,
        "a" * 32 + " space",
        "\N{LATIN SMALL LETTER E WITH ACUTE}" * 40,
    ],
)
def test_enabled_worker_requires_safe_nonplaceholder_secret(secret):
    with pytest.raises(RuntimeError, match="AUTOMATION_WORKER_SECRET"):
        Settings(
            _env_file=None, AUTOMATION_WORKER_ENABLED=True, AUTOMATION_WORKER_SECRET=secret
        ).validate_automation_email_configuration()


def test_worker_secret_is_dedicated_and_hidden(enabled_mail):
    secret = "synthetic-automation-worker-credential-12345"
    settings = Settings(
        _env_file=None,
        AUTOMATION_WORKER_ENABLED=True,
        AUTOMATION_WORKER_SECRET=secret,
        **enabled_mail,
    )
    settings.validate_automation_email_configuration()
    for value in (
        secret,
        enabled_mail["EMAIL_GRAPH_CLIENT_SECRET"],
        enabled_mail["EMAIL_TOKEN_ENCRYPTION_KEY"],
    ):
        assert value not in repr(settings)
    settings.ACCOUNT_DELETION_WORKER_SECRET = secret
    with pytest.raises(RuntimeError, match="dedicated"):
        settings.validate_automation_email_configuration()


def test_settings_type_error_does_not_print_secret_input():
    secret = "synthetic-confidential-token-value"
    with pytest.raises(ValidationError) as error:
        Settings(_env_file=None, EMAIL_GRAPH_CLIENT_SECRET={"token": secret})
    assert secret not in str(error.value)
