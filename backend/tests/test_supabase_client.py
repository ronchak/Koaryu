from unittest.mock import patch

import pytest

from app.core.config import (
    KOARYU_STAGING_SUPABASE_URL,
    Settings,
    SupabaseTargetError,
)
from app.db.supabase import create_supabase_client


@pytest.mark.parametrize("environment", ["dev", "local", "testing", ""])
def test_service_role_client_rejects_unknown_environment_hosted_target(environment):
    settings = Settings(
        ENVIRONMENT=environment,
        SUPABASE_URL="https://hosted-project.supabase.co",
        SUPABASE_ALLOWED_HOSTED_HOST="",
        SUPABASE_SERVICE_ROLE_KEY="fixture-service-role-key",
    )
    environment_label = environment or "<empty>"

    with (
        patch("app.db.supabase.get_settings", return_value=settings),
        patch("app.db.supabase.create_client") as sdk_create_client,
        pytest.raises(
            SupabaseTargetError,
            match=(
                f"ENVIRONMENT={environment_label}.*"
                "hosted-project\\.supabase\\.co.*"
                "SUPABASE_ALLOWED_HOSTED_HOST=hosted-project\\.supabase\\.co"
            ),
        ),
    ):
        create_supabase_client()

    sdk_create_client.assert_not_called()


def test_service_role_client_rejects_placeholder_userinfo_on_hosted_target():
    settings = Settings(
        ENVIRONMENT="development",
        SUPABASE_URL="https://placeholder@mimguepumzsgmcaycdsh.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY="fixture-service-role-key",
        SUPABASE_ALLOWED_HOSTED_HOST="",
    )

    with (
        patch("app.db.supabase.get_settings", return_value=settings),
        patch("app.db.supabase.create_client") as sdk_create_client,
        pytest.raises(SupabaseTargetError, match="embedded credentials"),
    ):
        create_supabase_client()

    sdk_create_client.assert_not_called()


@pytest.mark.parametrize(
    "allowed_host",
    ["", "mimguepumzsgmcaycdsh.supabase.co"],
)
def test_service_role_client_rejects_production_target_under_staging_label(
    allowed_host,
):
    settings = Settings(
        ENVIRONMENT="staging",
        SUPABASE_URL="https://mimguepumzsgmcaycdsh.supabase.co",
        SUPABASE_ALLOWED_HOSTED_HOST=allowed_host,
        SUPABASE_SERVICE_ROLE_KEY="fixture-service-role-key",
    )

    with (
        patch("app.db.supabase.get_settings", return_value=settings),
        patch("app.db.supabase.create_client") as sdk_create_client,
        pytest.raises(
            SupabaseTargetError,
            match="SUPABASE_ALLOWED_HOSTED_HOST cannot override staging identity",
        ),
    ):
        create_supabase_client()

    sdk_create_client.assert_not_called()


def test_service_role_client_allows_pinned_staging_target():
    settings = Settings(
        ENVIRONMENT="staging",
        SUPABASE_URL=KOARYU_STAGING_SUPABASE_URL,
        SUPABASE_ALLOWED_HOSTED_HOST="",
        SUPABASE_SERVICE_ROLE_KEY="fixture-service-role-key",
    )
    expected_client = object()

    with (
        patch("app.db.supabase.get_settings", return_value=settings),
        patch(
            "app.db.supabase.create_client",
            return_value=expected_client,
        ) as sdk_create_client,
    ):
        client = create_supabase_client()

    assert client is expected_client
    sdk_create_client.assert_called_once_with(
        KOARYU_STAGING_SUPABASE_URL,
        "fixture-service-role-key",
    )


def test_service_role_client_rejects_unsafe_production_transport():
    settings = Settings(
        ENVIRONMENT="production",
        SUPABASE_URL="http://api.example.com:8080",
        SUPABASE_ALLOWED_HOSTED_HOST="",
        SUPABASE_SERVICE_ROLE_KEY="fixture-service-role-key",
    )

    with (
        patch("app.db.supabase.get_settings", return_value=settings),
        patch("app.db.supabase.create_client") as sdk_create_client,
        pytest.raises(SupabaseTargetError, match="plaintext"),
    ):
        create_supabase_client()

    sdk_create_client.assert_not_called()


def test_service_role_client_allows_safe_production_hosted_target():
    settings = Settings(
        ENVIRONMENT="production",
        SUPABASE_URL="https://api.example.com",
        SUPABASE_ALLOWED_HOSTED_HOST="",
        SUPABASE_SERVICE_ROLE_KEY="fixture-service-role-key",
    )
    expected_client = object()

    with (
        patch("app.db.supabase.get_settings", return_value=settings),
        patch(
            "app.db.supabase.create_client",
            return_value=expected_client,
        ) as sdk_create_client,
    ):
        client = create_supabase_client()

    assert client is expected_client
    sdk_create_client.assert_called_once()


@pytest.mark.parametrize(
    ("supabase_url", "reason"),
    [
        ("https://127。0。0。1", "non-ASCII"),
        ("https://0.0.0.0", "IP literal"),
        ("https://[::]", "IP literal"),
        ("https://0", "IP literal"),
    ],
)
def test_service_role_client_rejects_non_dns_production_target(
    supabase_url,
    reason,
):
    settings = Settings(
        ENVIRONMENT="production",
        SUPABASE_URL=supabase_url,
        SUPABASE_ALLOWED_HOSTED_HOST="",
        SUPABASE_SERVICE_ROLE_KEY="fixture-service-role-key",
    )

    with (
        patch("app.db.supabase.get_settings", return_value=settings),
        patch("app.db.supabase.create_client") as sdk_create_client,
        pytest.raises(SupabaseTargetError, match=reason),
    ):
        create_supabase_client()

    sdk_create_client.assert_not_called()


@pytest.mark.parametrize(
    "supabase_url",
    [
        "https://api.example.com",
        "https://prod-placeholder.example.net",
    ],
)
def test_service_role_client_rejects_unshipped_placeholder_like_hostnames(
    supabase_url,
):
    settings = Settings(
        ENVIRONMENT="development",
        SUPABASE_URL=supabase_url,
        SUPABASE_ALLOWED_HOSTED_HOST="",
        SUPABASE_SERVICE_ROLE_KEY="fixture-service-role-key",
    )

    with (
        patch("app.db.supabase.get_settings", return_value=settings),
        patch("app.db.supabase.create_client") as sdk_create_client,
        pytest.raises(SupabaseTargetError, match="exact hosted-target pin"),
    ):
        create_supabase_client()

    sdk_create_client.assert_not_called()


@pytest.mark.parametrize(
    "supabase_url",
    [
        "https://placeholder.supabase.co",
        "https://YOUR-PROJECT.SUPABASE.CO.",
    ],
)
def test_service_role_client_allows_shipped_placeholder_hostnames(supabase_url):
    settings = Settings(
        ENVIRONMENT="development",
        SUPABASE_URL=supabase_url,
        SUPABASE_ALLOWED_HOSTED_HOST="",
        SUPABASE_SERVICE_ROLE_KEY="fixture-service-role-key",
    )
    expected_client = object()

    with (
        patch("app.db.supabase.get_settings", return_value=settings),
        patch(
            "app.db.supabase.create_client",
            return_value=expected_client,
        ) as sdk_create_client,
    ):
        client = create_supabase_client()

    assert client is expected_client
    sdk_create_client.assert_called_once()


@pytest.mark.parametrize(
    ("supabase_url", "reason"),
    [
        ("http://hosted-project.supabase.co", "plaintext"),
        ("https://hosted-project.supabase.co:8080", "unexpected port"),
        (
            "https://user:pw@hosted-project.supabase.co",
            "embedded credentials",
        ),
        (
            "https://hosted-project.supabase.co/unexpected/base/path",
            "unexpected path",
        ),
        (
            "https://hosted-project.supabase.co?unexpected=query",
            "unexpected query",
        ),
        (
            "https://hosted-project.supabase.co#unexpected-fragment",
            "unexpected fragment",
        ),
    ],
)
def test_service_role_client_rejects_unsafe_url_despite_correct_pin(
    supabase_url,
    reason,
):
    settings = Settings(
        ENVIRONMENT="development",
        SUPABASE_URL=supabase_url,
        SUPABASE_ALLOWED_HOSTED_HOST="hosted-project.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY="fixture-service-role-key",
    )

    with (
        patch("app.db.supabase.get_settings", return_value=settings),
        patch("app.db.supabase.create_client") as sdk_create_client,
        pytest.raises(SupabaseTargetError, match=reason),
    ):
        create_supabase_client()

    sdk_create_client.assert_not_called()


@pytest.mark.parametrize(
    "supabase_url",
    [
        "https://hosted-project.supabase.co",
        "https://hosted-project.supabase.co/",
    ],
)
def test_service_role_client_allows_exact_host_pin(supabase_url):
    settings = Settings(
        ENVIRONMENT="development",
        SUPABASE_URL=supabase_url,
        SUPABASE_ALLOWED_HOSTED_HOST="hosted-project.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY="fixture-service-role-key",
    )
    expected_client = object()

    with (
        patch("app.db.supabase.get_settings", return_value=settings),
        patch(
            "app.db.supabase.create_client",
            return_value=expected_client,
        ) as sdk_create_client,
    ):
        client = create_supabase_client()

    assert client is expected_client
    sdk_create_client.assert_called_once()


@pytest.mark.parametrize(
    "supabase_url",
    [
        "http://127.0.0.1:54321",
        "http://[::1]:54321",
        "http://127.0.0.2:54321",
        "http://localhost:54321",
        "http://api.localhost:54321",
    ],
)
def test_service_role_client_allows_loopback_http_on_non_default_port(
    supabase_url,
):
    settings = Settings(
        ENVIRONMENT="development",
        SUPABASE_URL=supabase_url,
        SUPABASE_ALLOWED_HOSTED_HOST="",
        SUPABASE_SERVICE_ROLE_KEY="fixture-service-role-key",
    )
    expected_client = object()

    with (
        patch("app.db.supabase.get_settings", return_value=settings),
        patch(
            "app.db.supabase.create_client",
            return_value=expected_client,
        ) as sdk_create_client,
    ):
        client = create_supabase_client()

    assert client is expected_client
    sdk_create_client.assert_called_once()


def test_service_role_client_rejects_pin_for_previous_target():
    settings = Settings(
        ENVIRONMENT="development",
        SUPABASE_URL="https://production-project.supabase.co",
        SUPABASE_ALLOWED_HOSTED_HOST="staging-project.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY="fixture-service-role-key",
    )

    with (
        patch("app.db.supabase.get_settings", return_value=settings),
        patch("app.db.supabase.create_client") as sdk_create_client,
        pytest.raises(SupabaseTargetError),
    ):
        create_supabase_client()

    sdk_create_client.assert_not_called()
