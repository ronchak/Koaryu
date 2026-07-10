import unittest

from app.core.config import Settings


VALID_PRODUCTION_SETTINGS = {
    "SUPABASE_URL": "https://project.supabase.co",
    "SUPABASE_SERVICE_ROLE_KEY": "sb_secret_1234567890abcdefghijklmnopqrstuvwxyz",
    "SUPABASE_JWT_SECRET": "jwt-secret-1234567890abcdefghijklmnopqrstuvwxyz",
    "FRONTEND_URL": "https://koaryu.app",
    "STRIPE_SECRET_KEY": "sk_live_1234567890abcdef",
    "STRIPE_RESTRICTED_KEY": "rk_live_1234567890abcdef",
    "STRIPE_PLATFORM_WEBHOOK_SECRET": "whsec_platform1234567890abcdef",
    "STRIPE_CONNECT_WEBHOOK_SECRET": "whsec_connect1234567890abcdef",
    "STRIPE_KOARYU_CORE_PRICE_ID": "price_1234567890abcdef",
    "STRIPE_CONNECT_CLIENT_ID": "ca_1234567890abcdef",
    "ACCOUNT_DELETION_WORKER_SECRET": "delete-secret-1234567890abcdefghijklmnopqrstuvwxyz",
    "SUPPORT_TRIAGE_SECRET": "support-secret-1234567890abcdefghijklmnopqrstuvwxyz",
}


class ProductionConfigValidationTest(unittest.TestCase):
    def test_development_allows_placeholder_defaults(self):
        Settings(ENVIRONMENT="development").validate_production_configuration()

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

    def test_production_rejects_placeholder_shaped_values(self):
        settings = Settings(
            ENVIRONMENT="production",
            **{
                **VALID_PRODUCTION_SETTINGS,
                "SUPABASE_SERVICE_ROLE_KEY": "your-supabase-service-role-key",
                "STRIPE_SECRET_KEY": "sk_live_or_test_your_key",
                "STRIPE_RESTRICTED_KEY": "rk_live_or_test_your_key",
                "STRIPE_CONNECT_WEBHOOK_SECRET": "whsec_connect_platform_scope,whsec_connect_connected_scope",
                "STRIPE_CONNECT_CLIENT_ID": "ca_your_connect_client_id",
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


if __name__ == "__main__":
    unittest.main()
