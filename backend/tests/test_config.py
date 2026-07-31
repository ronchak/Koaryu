import os
import unittest

from tests import environment as _test_environment  # noqa: F401

from app.core.config import Settings, SupabaseTargetError


def _synthetic_stripe_key(prefix: str, mode: str = "live") -> str:
    return "_".join((prefix, mode, "fixture1234567890abcdef"))


def _synthetic_webhook_secret(scope: str) -> str:
    return "_".join(("whsec", scope, "fixture1234567890abcdef"))


VALID_PRODUCTION_SETTINGS = {
    "SUPABASE_URL": "https://project.supabase.co",
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


class HostedConfigValidationTest(unittest.TestCase):
    def test_test_process_uses_placeholder_supabase_url(self):
        self.assertEqual(
            os.environ["SUPABASE_URL"],
            "https://placeholder.supabase.co",
        )

    def test_development_allows_placeholder_defaults(self):
        Settings(ENVIRONMENT="development").validate_runtime_configuration()

    def test_test_environment_allows_placeholder_defaults(self):
        Settings(ENVIRONMENT="test").validate_runtime_configuration()

    def test_unknown_environment_fails_closed(self):
        with self.assertRaisesRegex(RuntimeError, "ENVIRONMENT must be"):
            Settings(ENVIRONMENT="stagin").validate_runtime_configuration()

    def test_production_rejects_missing_live_settings(self):
        settings = Settings(
            ENVIRONMENT="production",
            SUPABASE_URL="https://placeholder.supabase.co",
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

        with self.assertRaisesRegex(RuntimeError, "SUPABASE_URL must be a public HTTPS URL"):
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

    def test_production_rejects_live_billing_switch_without_durable_authorization(self):
        settings = Settings(
            ENVIRONMENT="production",
            **{
                **VALID_PRODUCTION_SETTINGS,
                "LIVE_BILLING_ENABLED": True,
            },
        )

        with self.assertRaisesRegex(RuntimeError, "durable live mutation authorization"):
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
                with self.assertRaisesRegex(RuntimeError, f"{name} must match Koaryu's pinned staging"):
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


class SupabaseTargetValidationTest(unittest.TestCase):
    def test_runtime_validation_rejects_hosted_target_outside_strict_environment(self):
        settings = Settings(
            ENVIRONMENT="development",
            SUPABASE_URL="https://hosted-project.supabase.co",
            SUPABASE_ALLOWED_HOSTED_HOST="",
        )

        with self.assertRaisesRegex(
            SupabaseTargetError,
            (
                "ENVIRONMENT=development.*hosted-project\\.supabase\\.co.*"
                "SUPABASE_ALLOWED_HOSTED_HOST=hosted-project\\.supabase\\.co"
            ),
        ):
            settings.validate_runtime_configuration()

    def test_exact_host_pin_allows_deliberate_hosted_target(self):
        settings = Settings(
            ENVIRONMENT="test",
            SUPABASE_URL="https://hosted-project.supabase.co",
            SUPABASE_ALLOWED_HOSTED_HOST=" HOSTED-PROJECT.SUPABASE.CO ",
        )

        settings.validate_supabase_target()

    def test_stale_host_pin_does_not_allow_current_target(self):
        settings = Settings(
            ENVIRONMENT="development",
            SUPABASE_URL="https://production-project.supabase.co",
            SUPABASE_ALLOWED_HOSTED_HOST="staging-project.supabase.co",
        )

        with self.assertRaisesRegex(
            SupabaseTargetError,
            "SUPABASE_ALLOWED_HOSTED_HOST=production-project\\.supabase\\.co",
        ):
            settings.validate_supabase_target()

    def test_loopback_and_localhost_targets_are_allowed(self):
        urls = (
            "http://[::1]:54321",
            "http://127.0.0.2:54321",
            "http://localhost:54321",
            "http://127.0.0.1:54321",
            "http://localhost.:54321",
            "http://api.localhost:54321",
        )
        for url in urls:
            with self.subTest(url=url):
                settings = Settings(
                    ENVIRONMENT="development",
                    SUPABASE_URL=url,
                    SUPABASE_ALLOWED_HOSTED_HOST="",
                )

                settings.validate_supabase_target()

    def test_non_loopback_unspecified_address_is_refused(self):
        settings = Settings(
            ENVIRONMENT="test",
            SUPABASE_URL="http://0.0.0.0:54321",
            SUPABASE_ALLOWED_HOSTED_HOST="",
        )

        with self.assertRaises(SupabaseTargetError):
            settings.validate_supabase_target()

    def test_placeholder_hostnames_are_allowed(self):
        urls = (
            "https://your-project.supabase.co",
            "https://placeholder.supabase.co",
        )
        for url in urls:
            with self.subTest(url=url):
                settings = Settings(
                    ENVIRONMENT="development",
                    SUPABASE_URL=url,
                    SUPABASE_ALLOWED_HOSTED_HOST="",
                )

                settings.validate_supabase_target()

    def test_placeholder_userinfo_cannot_exempt_real_hostname(self):
        settings = Settings(
            ENVIRONMENT="development",
            SUPABASE_URL=(
                "https://placeholder@mimguepumzsgmcaycdsh.supabase.co"
            ),
            SUPABASE_ALLOWED_HOSTED_HOST="",
        )

        with self.assertRaisesRegex(
            SupabaseTargetError,
            "mimguepumzsgmcaycdsh\\.supabase\\.co",
        ):
            settings.validate_supabase_target()

    def test_marker_inside_real_project_ref_is_not_a_placeholder(self):
        settings = Settings(
            ENVIRONMENT="development",
            SUPABASE_URL="https://todoabcdefghijklmnop.supabase.co",
            SUPABASE_ALLOWED_HOSTED_HOST="",
        )

        with self.assertRaises(SupabaseTargetError):
            settings.validate_supabase_target()

    def test_url_without_parseable_hostname_is_refused(self):
        settings = Settings(
            ENVIRONMENT="development",
            SUPABASE_URL="not-a-url",
            SUPABASE_ALLOWED_HOSTED_HOST="not-a-url",
        )

        with self.assertRaisesRegex(SupabaseTargetError, "host <missing>"):
            settings.validate_supabase_target()

    def test_strict_environments_are_ignored_by_supabase_target_guard(self):
        for environment in ("production", "staging"):
            with self.subTest(environment=environment):
                settings = Settings(
                    ENVIRONMENT=environment,
                    SUPABASE_URL="https://hosted-project.supabase.co",
                    SUPABASE_ALLOWED_HOSTED_HOST="",
                )

                settings.validate_supabase_target()


if __name__ == "__main__":
    unittest.main()
