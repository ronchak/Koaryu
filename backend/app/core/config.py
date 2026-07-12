from pydantic_settings import BaseSettings
from functools import lru_cache
from pathlib import Path
from urllib.parse import urlparse


KOARYU_STAGING_SUPABASE_URL = "https://nxgsektqsgrtyfhawxbc.supabase.co"
KOARYU_STAGING_FRONTEND_URL = (
    "https://koaryu-git-staging-ronakchak2569-8303s-projects.vercel.app"
)
PERMISSIVE_ENVIRONMENTS = {"development", "test"}
STRICT_ENVIRONMENTS = {"production", "staging"}


PLACEHOLDER_MARKERS = (
    "placeholder",
    "your-",
    "your_",
    "_your",
    "example",
    "change-me",
    "changeme",
    "replace-me",
    "todo",
    "<",
    ">",
)

PLACEHOLDER_VALUES = {
    "delete-secret",
    "jwt-secret",
    "long-random-secret",
    "long-random-secret-for-support-ticket-triage",
    "long-random-secret-for-the-deletion-cron",
    "long-random-secret-for-the-deletion-worker",
    "placeholder-key",
    "placeholder-secret",
    "price_core",
    "price_koaryu_core",
    "service-role-key",
    "sk_live_or_test_your_key",
    "support-secret",
    "whsec_connect",
    "whsec_connect_connected_scope",
    "whsec_connect_platform_scope",
    "whsec_platform",
}


def is_placeholder_value(value: str) -> bool:
    normalized = value.strip().lower()
    return (
        not normalized
        or normalized in PLACEHOLDER_VALUES
        or any(marker in normalized for marker in PLACEHOLDER_MARKERS)
    )


def has_minimum_secret_length(value: str, minimum: int = 32) -> bool:
    return len(value.strip()) >= minimum


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""

    SUPABASE_URL: str = "https://placeholder.supabase.co"
    SUPABASE_SERVICE_ROLE_KEY: str = "placeholder-key"
    SUPABASE_JWT_SECRET: str = "placeholder-secret"
    SUPABASE_ALLOW_LEGACY_HS256: bool = False
    FRONTEND_URL: str = "http://localhost:4000"
    ENVIRONMENT: str = "development"
    DEMO_RESET_ENABLED: bool = False
    DEMO_RESET_STUDIO_IDS: str = ""
    STRIPE_SECRET_KEY: str = ""
    STRIPE_RESTRICTED_KEY: str = ""
    STRIPE_PLATFORM_WEBHOOK_SECRET: str = ""
    STRIPE_CONNECT_WEBHOOK_SECRET: str = ""
    STRIPE_KOARYU_CORE_PRICE_ID: str = ""
    BILLING_PLATFORM_FEE_BPS: int = 50
    ACCOUNT_DELETION_WORKER_SECRET: str = ""
    SUPPORT_TRIAGE_SECRET: str = ""

    # API
    API_V1_PREFIX: str = "/api/v1"

    model_config = {
        "env_file": str(Path(__file__).resolve().parents[2] / ".env"),
        "case_sensitive": True,
        "extra": "ignore"
    }

    def validate_runtime_configuration(self) -> None:
        """Fail closed when a hosted environment has incomplete or unsafe config."""
        environment = self.ENVIRONMENT.strip().lower()
        if environment in PERMISSIVE_ENVIRONMENTS:
            return
        if environment not in STRICT_ENVIRONMENTS:
            raise RuntimeError(
                "Runtime configuration is incomplete or unsafe: "
                "ENVIRONMENT must be development, test, staging, or production"
            )

        missing: list[str] = []
        required_values = {
            "SUPABASE_URL": self.SUPABASE_URL,
            "SUPABASE_SERVICE_ROLE_KEY": self.SUPABASE_SERVICE_ROLE_KEY,
            "FRONTEND_URL": self.FRONTEND_URL,
            "STRIPE_SECRET_KEY": self.STRIPE_SECRET_KEY,
            "STRIPE_PLATFORM_WEBHOOK_SECRET": self.STRIPE_PLATFORM_WEBHOOK_SECRET,
            "STRIPE_CONNECT_WEBHOOK_SECRET": self.STRIPE_CONNECT_WEBHOOK_SECRET,
            "STRIPE_KOARYU_CORE_PRICE_ID": self.STRIPE_KOARYU_CORE_PRICE_ID,
            "ACCOUNT_DELETION_WORKER_SECRET": self.ACCOUNT_DELETION_WORKER_SECRET,
            "SUPPORT_TRIAGE_SECRET": self.SUPPORT_TRIAGE_SECRET,
        }
        optional_values = {
            "STRIPE_RESTRICTED_KEY": self.STRIPE_RESTRICTED_KEY,
        }

        for name, value in required_values.items():
            normalized = value.strip() if isinstance(value, str) else value
            if not normalized or is_placeholder_value(normalized):
                missing.append(name)

        for name, value in optional_values.items():
            normalized = value.strip() if isinstance(value, str) else value
            if normalized and is_placeholder_value(normalized):
                missing.append(name)

        if self.DEMO_RESET_ENABLED:
            missing.append(f"DEMO_RESET_ENABLED must be false in {environment}")
        if self.DEMO_RESET_STUDIO_IDS.strip():
            missing.append(f"DEMO_RESET_STUDIO_IDS must be empty in {environment}")
        if self.API_V1_PREFIX != "/api/v1":
            missing.append("API_V1_PREFIX must be /api/v1")

        supabase = urlparse(self.SUPABASE_URL)
        if supabase.scheme != "https" or not supabase.netloc or supabase.hostname in {"localhost", "127.0.0.1"}:
            missing.append("SUPABASE_URL must be a public HTTPS URL")

        frontend = urlparse(self.FRONTEND_URL)
        if frontend.scheme != "https" or not frontend.netloc or frontend.hostname in {"localhost", "127.0.0.1"}:
            missing.append("FRONTEND_URL must be a public HTTPS URL")

        if not has_minimum_secret_length(self.SUPABASE_SERVICE_ROLE_KEY):
            missing.append("SUPABASE_SERVICE_ROLE_KEY must be a real secret value")

        if environment == "staging" and self.SUPABASE_ALLOW_LEGACY_HS256:
            missing.append("SUPABASE_ALLOW_LEGACY_HS256 must be false in staging")
        elif self.SUPABASE_ALLOW_LEGACY_HS256:
            if is_placeholder_value(self.SUPABASE_JWT_SECRET) or not has_minimum_secret_length(
                self.SUPABASE_JWT_SECRET
            ):
                missing.append(
                    "SUPABASE_JWT_SECRET must be a real secret value when "
                    "SUPABASE_ALLOW_LEGACY_HS256 is enabled"
                )

        stripe_secret_prefixes = (
            ("sk_test_",)
            if environment == "staging"
            else ("sk_live_", "sk_test_")
        )
        if not self.STRIPE_SECRET_KEY.startswith(stripe_secret_prefixes) or not has_minimum_secret_length(
            self.STRIPE_SECRET_KEY, 16
        ):
            if environment == "staging":
                missing.append("STRIPE_SECRET_KEY must be a Stripe test secret key in staging")
            else:
                missing.append("STRIPE_SECRET_KEY must be a Stripe secret key")

        restricted_key = self.STRIPE_RESTRICTED_KEY.strip()
        restricted_key_prefixes = (
            ("rk_test_",)
            if environment == "staging"
            else ("rk_live_", "rk_test_")
        )
        if restricted_key and (
            not restricted_key.startswith(restricted_key_prefixes)
            or not has_minimum_secret_length(restricted_key, 16)
        ):
            if environment == "staging":
                missing.append(
                    "STRIPE_RESTRICTED_KEY must be a Stripe test restricted key "
                    "in staging when set"
                )
            else:
                missing.append("STRIPE_RESTRICTED_KEY must be a Stripe restricted key when set")

        platform_webhook_secret = self.STRIPE_PLATFORM_WEBHOOK_SECRET.strip()
        if (
            is_placeholder_value(platform_webhook_secret)
            or not platform_webhook_secret.startswith("whsec_")
            or not has_minimum_secret_length(platform_webhook_secret, 20)
        ):
            missing.append("STRIPE_PLATFORM_WEBHOOK_SECRET must be a Stripe webhook secret")

        connect_webhook_secrets = [
            secret.strip() for secret in self.STRIPE_CONNECT_WEBHOOK_SECRET.split(",") if secret.strip()
        ]
        if not connect_webhook_secrets or any(
            is_placeholder_value(secret)
            or not secret.startswith("whsec_")
            or not has_minimum_secret_length(secret, 20)
            for secret in connect_webhook_secrets
        ):
            missing.append("STRIPE_CONNECT_WEBHOOK_SECRET must contain Stripe webhook secrets")

        if not self.STRIPE_KOARYU_CORE_PRICE_ID.startswith("price_") or not has_minimum_secret_length(
            self.STRIPE_KOARYU_CORE_PRICE_ID, 16
        ):
            missing.append("STRIPE_KOARYU_CORE_PRICE_ID must be a Stripe Price ID")

        if not has_minimum_secret_length(self.ACCOUNT_DELETION_WORKER_SECRET):
            missing.append("ACCOUNT_DELETION_WORKER_SECRET must be a long random secret")

        if not has_minimum_secret_length(self.SUPPORT_TRIAGE_SECRET):
            missing.append("SUPPORT_TRIAGE_SECRET must be a long random secret")

        if environment == "staging":
            if self.SUPABASE_URL != KOARYU_STAGING_SUPABASE_URL:
                missing.append("SUPABASE_URL must match Koaryu's pinned staging project")
            if self.FRONTEND_URL != KOARYU_STAGING_FRONTEND_URL:
                missing.append("FRONTEND_URL must match Koaryu's pinned staging frontend")

        if missing:
            detail = ", ".join(dict.fromkeys(missing))
            label = environment.capitalize()
            raise RuntimeError(f"{label} configuration is incomplete or unsafe: {detail}")

    def validate_production_configuration(self) -> None:
        """Backward-compatible alias for the hosted runtime guard."""
        self.validate_runtime_configuration()


@lru_cache()
def get_settings() -> Settings:
    return Settings()
