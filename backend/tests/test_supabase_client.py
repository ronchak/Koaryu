from unittest.mock import patch

import pytest

from app.core.config import (
    AMBIENT_TRANSPORT_ENVIRONMENT_KEYS,
    CA_BUNDLE_ENVIRONMENT_KEYS,
    KOARYU_PRODUCTION_FRONTEND_URL,
    KOARYU_PRODUCTION_SUPABASE_URL,
    KOARYU_STAGING_SUPABASE_URL,
    LOCAL_SUPABASE_URL,
    PROXY_ENVIRONMENT_KEYS,
    Settings,
    SupabaseSafetyError,
)
from app.db.supabase import (
    DeadlineBoundSupabaseClient,
    create_operational_alert_supabase_client,
    create_supabase_client,
)


def _clear_proxy_environment(monkeypatch):
    for key in AMBIENT_TRANSPORT_ENVIRONMENT_KEYS + ("NO_PROXY", "no_proxy"):
        monkeypatch.delenv(key, raising=False)


@pytest.mark.parametrize("control", ["\t", "\r", "\n"])
def test_runtime_rejects_raw_url_controls_before_readiness(control):
    settings = Settings(
        ENVIRONMENT="production",
        FRONTEND_URL=KOARYU_PRODUCTION_FRONTEND_URL,
        SUPABASE_URL=f"https://mimguepumzsgmcaycdsh{control}.supabase.co",
    )

    with pytest.raises(SupabaseSafetyError, match="ASCII control character"):
        settings.validate_runtime_configuration()


@pytest.mark.parametrize("control", ["\t", "\r", "\n"])
def test_factory_rejects_raw_url_controls_before_sdk_construction(control):
    settings = Settings(
        ENVIRONMENT="production",
        FRONTEND_URL=KOARYU_PRODUCTION_FRONTEND_URL,
        SUPABASE_URL=f"https://mimguepumzsgmcaycdsh{control}.supabase.co",
    )

    with (
        patch("app.db.supabase.get_settings", return_value=settings),
        patch("app.db.supabase.create_client") as sdk_constructor,
        pytest.raises(SupabaseSafetyError, match="ASCII control character"),
    ):
        create_supabase_client()

    sdk_constructor.assert_not_called()


@pytest.mark.parametrize(
    "service_role_key",
    [
        " leading-whitespace",
        "trailing-whitespace ",
        "embedded\tcontrol",
        "embedded\rcontrol",
        "embedded\ncontrol",
    ],
)
def test_factory_rejects_malformed_service_role_key_before_sdk_construction(
    service_role_key,
):
    settings = Settings(
        ENVIRONMENT="development",
        SUPABASE_SERVICE_ROLE_KEY=service_role_key,
    )

    with (
        patch("app.db.supabase.get_settings", return_value=settings),
        patch("app.db.supabase.create_client") as sdk_constructor,
        pytest.raises(RuntimeError, match="SUPABASE_SERVICE_ROLE_KEY") as error,
    ):
        create_supabase_client()

    assert service_role_key not in str(error.value)
    sdk_constructor.assert_not_called()


def test_operational_alert_client_uses_bounded_postgrest_timeout():
    settings = Settings(
        ENVIRONMENT="development",
        SUPABASE_URL=LOCAL_SUPABASE_URL,
        SUPABASE_SERVICE_ROLE_KEY="header.payload.signature",
    )

    with (
        patch("app.core.config.getproxies", return_value={}),
        patch("app.db.supabase.get_settings", return_value=settings),
        patch("app.db.supabase.create_client") as sync_sdk_constructor,
    ):
        bounded_client = create_operational_alert_supabase_client(
            postgrest_client_timeout=1.5,
        )

    assert isinstance(bounded_client, DeadlineBoundSupabaseClient)
    assert bounded_client._postgrest_client_timeout == 1.5
    sync_sdk_constructor.assert_not_called()


@pytest.mark.parametrize(
    ("environment", "url", "development_ref"),
    [
        ("production", KOARYU_PRODUCTION_SUPABASE_URL, ""),
        ("staging", KOARYU_STAGING_SUPABASE_URL, ""),
        ("development", LOCAL_SUPABASE_URL, ""),
        ("test", LOCAL_SUPABASE_URL, ""),
        ("development", "https://placeholder.supabase.co", ""),
        ("test", "https://your-project.supabase.co", ""),
        ("development", "https://dedicated-dev.supabase.co", "dedicated-dev"),
    ],
)
def test_exact_environment_target_matrix_allows_only_named_safe_pairs(
    environment, url, development_ref
):
    Settings(
        ENVIRONMENT=environment,
        SUPABASE_URL=url,
        SUPABASE_DEVELOPMENT_PROJECT_REF=development_ref,
    ).validate_supabase_target()


@pytest.mark.parametrize(
    ("environment", "url", "development_ref", "reason"),
    [
        (
            "development",
            KOARYU_PRODUCTION_SUPABASE_URL,
            "mimguepumzsgmcaycdsh",
            "production or staging",
        ),
        (
            "development",
            KOARYU_STAGING_SUPABASE_URL,
            "nxgsektqsgrtyfhawxbc",
            "production or staging",
        ),
        ("test", "https://dedicated-test.supabase.co", "", "cannot use a real hosted"),
        ("production", KOARYU_STAGING_SUPABASE_URL, "", "pinned production"),
        ("staging", KOARYU_PRODUCTION_SUPABASE_URL, "", "pinned staging"),
        ("development", "http://localhost:54321", "", "canonical"),
        ("development", f"{LOCAL_SUPABASE_URL}/", "", "canonical"),
        ("development", "https://dedicated-dev.supabase.co", "another-dev", "exactly match"),
        ("development", "https://dedicated-dev.supabase.co", " dedicated-dev ", "exactly match"),
        ("dev", "https://placeholder.supabase.co", "", "ENVIRONMENT must be"),
    ],
)
def test_exact_environment_target_matrix_rejects_other_pairs(
    environment, url, development_ref, reason
):
    settings = Settings(
        ENVIRONMENT=environment,
        SUPABASE_URL=url,
        SUPABASE_DEVELOPMENT_PROJECT_REF=development_ref,
    )

    with pytest.raises(SupabaseSafetyError, match=reason):
        settings.validate_supabase_target()


@pytest.mark.parametrize("proxy_key", PROXY_ENVIRONMENT_KEYS)
def test_factory_rejects_uppercase_and_lowercase_proxy_variants(
    monkeypatch, proxy_key
):
    _clear_proxy_environment(monkeypatch)
    monkeypatch.setenv(proxy_key, "http://proxy.invalid:8080")
    monkeypatch.setenv("NO_PROXY", "localhost,127.0.0.1")
    settings = Settings(
        ENVIRONMENT="development",
        SUPABASE_URL=LOCAL_SUPABASE_URL,
    )

    with (
        patch("app.core.config.getproxies", return_value={"http": "configured"}),
        patch("app.db.supabase.get_settings", return_value=settings),
        patch("app.db.supabase.create_client") as sdk_constructor,
        pytest.raises(SupabaseSafetyError, match="ambient proxy"),
    ):
        create_supabase_client()

    sdk_constructor.assert_not_called()


def test_readiness_rejects_host_specific_no_proxy(monkeypatch):
    _clear_proxy_environment(monkeypatch)
    monkeypatch.setenv("HTTP_PROXY", "http://proxy.invalid:8080")
    monkeypatch.setenv("NO_PROXY", "localhost,127.0.0.1")

    with (
        patch("app.core.config.getproxies", return_value={"http": "configured"}),
        pytest.raises(SupabaseSafetyError, match="NO_PROXY is not accepted"),
    ):
        Settings(
            ENVIRONMENT="development",
            SUPABASE_URL=LOCAL_SUPABASE_URL,
        ).validate_runtime_configuration()


def test_no_proxy_wildcard_does_not_bypass_proxy_refusal(monkeypatch):
    _clear_proxy_environment(monkeypatch)
    monkeypatch.setenv("HTTPS_PROXY", "http://proxy.invalid:8080")
    monkeypatch.setenv("NO_PROXY", " * ")

    with (
        patch("app.core.config.getproxies", return_value={"https": "configured"}),
        pytest.raises(SupabaseSafetyError, match="NO_PROXY is not accepted"),
    ):
        Settings(
            ENVIRONMENT="development",
            SUPABASE_URL=LOCAL_SUPABASE_URL,
        ).validate_runtime_configuration()


@pytest.mark.parametrize("bundle_key", CA_BUNDLE_ENVIRONMENT_KEYS)
def test_factory_rejects_ca_bundle_and_certificate_overrides(
    monkeypatch, bundle_key
):
    _clear_proxy_environment(monkeypatch)
    monkeypatch.setenv(bundle_key, "/tmp/untrusted-ca-bundle")
    settings = Settings(
        ENVIRONMENT="development",
        SUPABASE_URL=LOCAL_SUPABASE_URL,
    )

    with (
        patch("app.core.config.getproxies", return_value={}),
        patch("app.db.supabase.get_settings", return_value=settings),
        patch("app.db.supabase.create_client") as sdk_constructor,
        pytest.raises(SupabaseSafetyError, match=bundle_key.upper()),
    ):
        create_supabase_client()

    sdk_constructor.assert_not_called()


def test_operating_system_proxy_is_rejected_without_logging_value(monkeypatch):
    _clear_proxy_environment(monkeypatch)
    proxy_value = "http://sensitive-proxy.invalid:8080"

    with (
        patch("app.core.config.getproxies", return_value={"https": proxy_value}),
        pytest.raises(SupabaseSafetyError) as error,
    ):
        Settings(
            ENVIRONMENT="development",
            SUPABASE_URL=LOCAL_SUPABASE_URL,
        ).validate_runtime_configuration()

    assert proxy_value not in str(error.value)
