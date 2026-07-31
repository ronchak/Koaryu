from unittest.mock import patch

import pytest

from app.core.config import Settings, SupabaseTargetError
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
        pytest.raises(SupabaseTargetError),
    ):
        create_supabase_client()

    sdk_create_client.assert_not_called()


@pytest.mark.parametrize("environment", ["production", "staging"])
def test_service_role_client_exempts_strict_environment_hosted_target(environment):
    settings = Settings(
        ENVIRONMENT=environment,
        SUPABASE_URL="https://hosted-project.supabase.co",
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
        "https://hosted-project.supabase.co",
        "fixture-service-role-key",
    )


def test_service_role_client_allows_exact_host_pin():
    settings = Settings(
        ENVIRONMENT="development",
        SUPABASE_URL="https://hosted-project.supabase.co",
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
