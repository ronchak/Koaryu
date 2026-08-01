import hashlib
import unittest
from unittest.mock import patch

from app.core.config import Settings


def _synthetic_stripe_key(prefix: str, mode: str = "live") -> str:
    return "_".join((prefix, mode, "fixture1234567890abcdef"))


def _synthetic_webhook_secret(scope: str) -> str:
    return "_".join(("whsec", scope, "fixture1234567890abcdef"))


VALID_PRODUCTION_SETTINGS = {
    "SUPABASE_URL": "https://mimguepumzsgmcaycdsh.supabase.co",
    "SUPABASE_SERVICE_ROLE_KEY": "sb_secret_1234567890abcdefghijklmnopqrstuvwxyz",
    "SUPABASE_JWT_SECRET": "jwt-secret-1234567890abcdefghijklmnopqrstuvwxyz",
    "FRONTEND_URL": "https://koaryu.app",
    "STRIPE_MODE": "live",
    "LIVE_BILLING_ENABLED": False,
    "STRIPE_SECRET_KEY": _synthetic_stripe_key("sk"),
    "STRIPE_RESTRICTED_KEY": _synthetic_stripe_key("rk"),
    "STRIPE_PLATFORM_WEBHOOK_SECRET": _synthetic_webhook_secret("platform"),
    "STRIPE_CONNECT_WEBHOOK_SECRET": _synthetic_webhook_secret("connect"),
    "STRIPE_KOARYU_CORE_PRICE_ID": "price_1234567890abcdef",
    "ACCOUNT_DELETION_WORKER_SECRET": "delete-secret-1234567890abcdefghijklmnopqrstuvwxyz",
    "SUPPORT_TRIAGE_SECRET": "support-secret-1234567890abcdefghijklmnopqrstuvwxyz",
}

VALID_STAGING_SETTINGS = {
    **VALID_PRODUCTION_SETTINGS,
    "SUPABASE_URL": "https://nxgsektqsgrtyfhawxbc.supabase.co",
    "FRONTEND_URL": (
        "https://koaryu-git-staging-ronakchak2569-8303s-projects.vercel.app"
    ),
    "STRIPE_MODE": "test",
    "STRIPE_SECRET_KEY": _synthetic_stripe_key("sk", "test"),
    "STRIPE_RESTRICTED_KEY": _synthetic_stripe_key("rk", "test"),
}


class CandidateSettings(Settings):
    """Include the candidate-only alert credential without copying its feature."""

    OPERATIONAL_ALERT_WORKER_SECRET: str = ""


def _alert_activation_settings():
    primary = "https://alerts.example.com/primary"
    backup = "https://alerts.example.com/backup"
    return {
        "OPERATIONAL_ALERTS_ENABLED": True,
        "OPERATIONAL_ALERT_WORKER_SECRET": "w" * 40,
        "OPERATIONAL_ALERT_PRIMARY_URL": primary,
        "OPERATIONAL_ALERT_PRIMARY_HOST": "alerts.example.com",
        "OPERATIONAL_ALERT_PRIMARY_URL_SHA256": hashlib.sha256(primary.encode()).hexdigest(),
        "OPERATIONAL_ALERT_PRIMARY_BEARER_SECRET": "p" * 40,
        "OPERATIONAL_ALERT_PRIMARY_ACK_SECRET": "a" * 40,
        "OPERATIONAL_ALERT_BACKUP_URL": backup,
        "OPERATIONAL_ALERT_BACKUP_HOST": "alerts.example.com",
        "OPERATIONAL_ALERT_BACKUP_URL_SHA256": hashlib.sha256(backup.encode()).hexdigest(),
        "OPERATIONAL_ALERT_BACKUP_BEARER_SECRET": "b" * 40,
        "OPERATIONAL_ALERT_BACKUP_ACK_SECRET": "c" * 40,
    }


class HostedConfigValidationTest(unittest.TestCase):
    def test_development_allows_placeholder_defaults(self):
        Settings(ENVIRONMENT="development").validate_runtime_configuration()

    def test_test_environment_allows_placeholder_defaults(self):
        Settings(ENVIRONMENT="test").validate_runtime_configuration()

    def test_readiness_rejects_malformed_header_bound_credentials(self):
        header_bound_fields = (
            "SUPABASE_SERVICE_ROLE_KEY",
            "STRIPE_SECRET_KEY",
            "STRIPE_RESTRICTED_KEY",
            "ACCOUNT_DELETION_WORKER_SECRET",
            "OPERATIONAL_ALERT_WORKER_SECRET",
            "SUPPORT_TRIAGE_SECRET",
        )
        malformed_values = (
            " leading-whitespace",
            "trailing-whitespace ",
            "embedded\tcontrol",
            "embedded\rcontrol",
            "embedded\ncontrol",
        )

        for name in header_bound_fields:
            for value in malformed_values:
                with self.subTest(name=name, value_kind=repr(value)):
                    with patch.dict("os.environ", {}, clear=True):
                        settings = CandidateSettings(
                            ENVIRONMENT="development",
                            **{name: value},
                        )
                        with self.assertRaisesRegex(RuntimeError, name) as error:
                            settings.validate_runtime_configuration()

                    self.assertNotIn(value, str(error.exception))

    def test_unknown_environment_fails_closed(self):
        with self.assertRaisesRegex(RuntimeError, "ENVIRONMENT must be"):
            Settings(ENVIRONMENT="stagin").validate_runtime_configuration()

    def test_production_rejects_missing_live_settings(self):
        settings = Settings(
            ENVIRONMENT="production",
            SUPABASE_URL="https://mimguepumzsgmcaycdsh.supabase.co",
            SUPABASE_SERVICE_ROLE_KEY="placeholder-key",
            SUPABASE_JWT_SECRET="placeholder-secret",
            FRONTEND_URL="https://koaryu.app",
            STRIPE_SECRET_KEY="",
            STRIPE_PLATFORM_WEBHOOK_SECRET="",
            STRIPE_CONNECT_WEBHOOK_SECRET="",
            STRIPE_KOARYU_CORE_PRICE_ID="",
            ACCOUNT_DELETION_WORKER_SECRET="",
            SUPPORT_TRIAGE_SECRET="",
        )

        with self.assertRaisesRegex(RuntimeError, "Production configuration is incomplete"):
            settings.validate_production_configuration()

    def test_production_rejects_demo_reset_enabled(self):
        settings = Settings(
            ENVIRONMENT="production",
            DEMO_RESET_ENABLED=True,
            **VALID_PRODUCTION_SETTINGS,
        )

        with self.assertRaisesRegex(RuntimeError, "DEMO_RESET_ENABLED must be false in production"):
            settings.validate_production_configuration()

    def test_production_rejects_demo_reset_studio_ids(self):
        settings = Settings(
            ENVIRONMENT="production",
            DEMO_RESET_STUDIO_IDS="studio_fixture",
            **VALID_PRODUCTION_SETTINGS,
        )

        with self.assertRaisesRegex(RuntimeError, "DEMO_RESET_STUDIO_IDS must be empty in production"):
            settings.validate_runtime_configuration()

    def test_production_rejects_placeholder_shaped_values(self):
        settings = Settings(
            ENVIRONMENT="production",
            **{
                **VALID_PRODUCTION_SETTINGS,
                "SUPABASE_SERVICE_ROLE_KEY": "your-supabase-service-role-key",
                "STRIPE_SECRET_KEY": "sk_live_or_test_your_key",
                "STRIPE_RESTRICTED_KEY": "rk_live_or_test_your_key",
                "STRIPE_CONNECT_WEBHOOK_SECRET": ",".join((
                    _synthetic_webhook_secret("connect_platform_scope"),
                    _synthetic_webhook_secret("connect_connected_scope"),
                )),
            },
        )

        with self.assertRaisesRegex(RuntimeError, "SUPABASE_SERVICE_ROLE_KEY"):
            settings.validate_production_configuration()

    def test_production_rejects_local_supabase_url(self):
        settings = Settings(
            ENVIRONMENT="production",
            **{
                **VALID_PRODUCTION_SETTINGS,
                "SUPABASE_URL": "http://127.0.0.1:54321",
            },
        )

        with self.assertRaisesRegex(RuntimeError, "cannot use the local Supabase project"):
            settings.validate_production_configuration()

    def test_production_rejects_short_internal_secrets(self):
        settings = Settings(
            ENVIRONMENT="production",
            **{
                **VALID_PRODUCTION_SETTINGS,
                "ACCOUNT_DELETION_WORKER_SECRET": "delete-secret",
                "SUPPORT_TRIAGE_SECRET": "support-secret",
            },
        )

        with self.assertRaisesRegex(RuntimeError, "long random secret"):
            settings.validate_production_configuration()

    def test_production_rejects_documented_deletion_worker_placeholder(self):
        settings = Settings(
            ENVIRONMENT="production",
            **{
                **VALID_PRODUCTION_SETTINGS,
                "ACCOUNT_DELETION_WORKER_SECRET": "long-random-secret-for-the-deletion-worker",
            },
        )

        with self.assertRaisesRegex(RuntimeError, "ACCOUNT_DELETION_WORKER_SECRET"):
            settings.validate_production_configuration()

    def test_production_accepts_required_live_settings(self):
        settings = Settings(
            ENVIRONMENT="production",
            **VALID_PRODUCTION_SETTINGS,
        )

        settings.validate_production_configuration()

    def test_production_rejects_stripe_key_that_does_not_match_declared_mode(self):
        settings = Settings(
            ENVIRONMENT="production",
            **{
                **VALID_PRODUCTION_SETTINGS,
                "STRIPE_MODE": "test",
            },
        )

        with self.assertRaisesRegex(RuntimeError, "STRIPE_SECRET_KEY must match STRIPE_MODE"):
            settings.validate_production_configuration()

    def test_production_rejects_matching_test_mode_and_test_keys(self):
        settings = Settings(
            ENVIRONMENT="production",
            **{
                **VALID_PRODUCTION_SETTINGS,
                "STRIPE_MODE": "test",
                "STRIPE_SECRET_KEY": _synthetic_stripe_key("sk", "test"),
                "STRIPE_RESTRICTED_KEY": _synthetic_stripe_key("rk", "test"),
            },
        )

        with self.assertRaisesRegex(RuntimeError, "Stripe live secret key in production"):
            settings.validate_production_configuration()

    def test_production_rejects_restricted_key_that_does_not_match_declared_mode(self):
        settings = Settings(
            ENVIRONMENT="production",
            **{
                **VALID_PRODUCTION_SETTINGS,
                "STRIPE_RESTRICTED_KEY": "rk_" + "test_fixture1234567890abcdef",
            },
        )

        with self.assertRaisesRegex(RuntimeError, "Stripe live restricted key in production"):
            settings.validate_production_configuration()

    def test_production_live_billing_requires_exact_deployment_sha(self):
        settings = Settings(
            ENVIRONMENT="production",
            **{
                **VALID_PRODUCTION_SETTINGS,
                "LIVE_BILLING_ENABLED": True,
            },
        )

        with patch.dict("os.environ", {}, clear=True), self.assertRaisesRegex(RuntimeError, "RENDER_GIT_COMMIT"):
            settings.validate_production_configuration()

        with patch.dict("os.environ", {"RENDER_GIT_COMMIT": "a" * 40}, clear=True):
            settings.validate_production_configuration()

    def test_production_requires_jwt_secret_only_when_legacy_hs256_is_enabled(self):
        asymmetric_settings = Settings(
            ENVIRONMENT="production",
            **{
                **VALID_PRODUCTION_SETTINGS,
                "SUPABASE_JWT_SECRET": "placeholder-secret",
            },
        )
        asymmetric_settings.validate_production_configuration()

        legacy_settings = Settings(
            ENVIRONMENT="production",
            **{
                **VALID_PRODUCTION_SETTINGS,
                "SUPABASE_JWT_SECRET": "placeholder-secret",
                "SUPABASE_ALLOW_LEGACY_HS256": True,
            },
        )
        with self.assertRaisesRegex(RuntimeError, "SUPABASE_JWT_SECRET"):
            legacy_settings.validate_production_configuration()

    def test_staging_accepts_complete_test_only_configuration(self):
        settings = Settings(
            ENVIRONMENT="staging",
            **VALID_STAGING_SETTINGS,
        )

        settings.validate_runtime_configuration()

    def test_staging_accepts_exact_operational_alert_activation(self):
        settings = Settings(
            ENVIRONMENT="staging",
            **{
                **VALID_STAGING_SETTINGS,
                **_alert_activation_settings(),
            },
        )

        settings.validate_runtime_configuration()

    def test_staging_rejects_alerts_without_dedicated_secret(self):
        settings = Settings(
            ENVIRONMENT="staging",
            **{
                **VALID_STAGING_SETTINGS,
                **_alert_activation_settings(),
                "OPERATIONAL_ALERT_WORKER_SECRET": "short",
            },
        )

        with self.assertRaisesRegex(RuntimeError, "OPERATIONAL_ALERT_WORKER_SECRET"):
            settings.validate_runtime_configuration()

    def test_staging_rejects_documented_alert_secret_placeholder(self):
        settings = Settings(
            ENVIRONMENT="staging",
            **{
                **VALID_STAGING_SETTINGS,
                **_alert_activation_settings(),
                "OPERATIONAL_ALERT_WORKER_SECRET": (
                    "long-random-secret-for-operational-alert-evaluation"
                ),
            },
        )

        with self.assertRaisesRegex(RuntimeError, "OPERATIONAL_ALERT_WORKER_SECRET"):
            settings.validate_runtime_configuration()

    def test_production_accepts_complete_fail_closed_alert_activation(self):
        settings = Settings(
            ENVIRONMENT="production",
            **{
                **VALID_PRODUCTION_SETTINGS,
                **_alert_activation_settings(),
            },
        )

        settings.validate_runtime_configuration()

    def test_production_rejects_alert_activation_with_fingerprint_drift(self):
        settings = Settings(
            ENVIRONMENT="production",
            **{
                **VALID_PRODUCTION_SETTINGS,
                **_alert_activation_settings(),
                "OPERATIONAL_ALERT_PRIMARY_URL_SHA256": "0" * 64,
            },
        )

        with self.assertRaisesRegex(RuntimeError, "PRIMARY_URL, host allowlist, and fingerprint"):
            settings.validate_runtime_configuration()

    def test_production_rejects_alert_destination_outside_exact_host_allowlist(self):
        settings = Settings(
            ENVIRONMENT="production",
            **{
                **VALID_PRODUCTION_SETTINGS,
                **_alert_activation_settings(),
                "OPERATIONAL_ALERT_PRIMARY_HOST": "other.example.com",
            },
        )

        with self.assertRaisesRegex(RuntimeError, "PRIMARY_URL, host allowlist"):
            settings.validate_runtime_configuration()

    def test_staging_rejects_production_destinations(self):
        for name, value in (
            ("SUPABASE_URL", "https://mimguepumzsgmcaycdsh.supabase.co"),
            ("FRONTEND_URL", "https://koaryu.app"),
        ):
            with self.subTest(name=name):
                settings = Settings(
                    ENVIRONMENT="staging",
                    **{
                        **VALID_STAGING_SETTINGS,
                        name: value,
                    },
                )
                expected = (
                    "pinned staging Supabase project"
                    if name == "SUPABASE_URL"
                    else "FRONTEND_URL must match Koaryu's pinned staging"
                )
                with self.assertRaisesRegex(RuntimeError, expected):
                    settings.validate_runtime_configuration()

    def test_staging_rejects_live_stripe_keys(self):
        settings = Settings(
            ENVIRONMENT="staging",
            **{
                **VALID_STAGING_SETTINGS,
                "STRIPE_SECRET_KEY": _synthetic_stripe_key("sk", "live"),
                "STRIPE_RESTRICTED_KEY": _synthetic_stripe_key("rk", "live"),
            },
        )

        with self.assertRaisesRegex(RuntimeError, "Stripe test"):
            settings.validate_runtime_configuration()

    def test_staging_rejects_live_stripe_mode(self):
        settings = Settings(
            ENVIRONMENT="staging",
            **{
                **VALID_STAGING_SETTINGS,
                "STRIPE_MODE": "live",
            },
        )

        with self.assertRaisesRegex(RuntimeError, "STRIPE_SECRET_KEY must match STRIPE_MODE"):
            settings.validate_runtime_configuration()

    def test_staging_rejects_legacy_auth_and_demo_shortcuts(self):
        settings = Settings(
            ENVIRONMENT="staging",
            SUPABASE_ALLOW_LEGACY_HS256=True,
            DEMO_RESET_ENABLED=True,
            DEMO_RESET_STUDIO_IDS="studio_fixture",
            **VALID_STAGING_SETTINGS,
        )

        with self.assertRaisesRegex(RuntimeError, "SUPABASE_ALLOW_LEGACY_HS256 must be false in staging"):
            settings.validate_runtime_configuration()


if __name__ == "__main__":
    unittest.main()
