from unittest.mock import patch

import pytest

from app.core.config import Settings
from app.db.supabase import create_supabase_client


def test_service_role_client_rejects_permissive_hosted_target():
    settings = Settings(
        ENVIRONMENT="development",
        SUPABASE_URL="https://hosted-project.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY="fixture-service-role-key",
    )

    with (
        patch("app.db.supabase.get_settings", return_value=settings),
        patch("app.db.supabase.create_client") as sdk_create_client,
        pytest.raises(
            RuntimeError,
            match=(
                "ENVIRONMENT=development.*hosted-project\\.supabase\\.co.*"
                "SUPABASE_ALLOW_HOSTED_IN_PERMISSIVE_ENVIRONMENT=true"
            ),
        ),
    ):
        create_supabase_client()

    sdk_create_client.assert_not_called()


def test_service_role_client_allows_deliberate_permissive_hosted_target():
    settings = Settings(
        ENVIRONMENT="development",
        SUPABASE_URL="https://hosted-project.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY="fixture-service-role-key",
        SUPABASE_ALLOW_HOSTED_IN_PERMISSIVE_ENVIRONMENT=True,
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
