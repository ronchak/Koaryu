import unittest

from app.core.config import Settings


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

    def test_production_accepts_required_live_settings(self):
        settings = Settings(
            ENVIRONMENT="production",
            SUPABASE_URL="https://project.supabase.co",
            SUPABASE_SERVICE_ROLE_KEY="service-role-key",
            SUPABASE_JWT_SECRET="jwt-secret",
            FRONTEND_URL="https://koaryu.app",
            STRIPE_SECRET_KEY="sk_live_123",
            STRIPE_PLATFORM_WEBHOOK_SECRET="whsec_platform",
            STRIPE_CONNECT_WEBHOOK_SECRET="whsec_connect",
            STRIPE_KOARYU_CORE_PRICE_ID="price_core",
            ACCOUNT_DELETION_WORKER_SECRET="delete-secret",
            SUPPORT_TRIAGE_SECRET="support-secret",
        )

        settings.validate_production_configuration()


if __name__ == "__main__":
    unittest.main()
