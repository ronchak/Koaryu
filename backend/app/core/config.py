from pydantic_settings import BaseSettings
from functools import lru_cache
from pathlib import Path
from urllib.parse import urlparse


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""

    SUPABASE_URL: str = "https://placeholder.supabase.co"
    SUPABASE_SERVICE_ROLE_KEY: str = "placeholder-key"
    SUPABASE_JWT_SECRET: str = "placeholder-secret"
    FRONTEND_URL: str = "http://localhost:4000"
    ENVIRONMENT: str = "development"
    DEMO_RESET_ENABLED: bool = False
    DEMO_RESET_STUDIO_IDS: str = ""
    STRIPE_SECRET_KEY: str = ""
    STRIPE_RESTRICTED_KEY: str = ""
    STRIPE_PLATFORM_WEBHOOK_SECRET: str = ""
    STRIPE_CONNECT_WEBHOOK_SECRET: str = ""
    STRIPE_KOARYU_CORE_PRICE_ID: str = ""
    STRIPE_CONNECT_CLIENT_ID: str = ""
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

    def validate_production_configuration(self) -> None:
        """Raise at startup when production is missing live-service config."""
        if self.ENVIRONMENT.lower() != "production":
            return

        missing: list[str] = []
        placeholder_values = {
            "SUPABASE_URL": "https://placeholder.supabase.co",
            "SUPABASE_SERVICE_ROLE_KEY": "placeholder-key",
            "SUPABASE_JWT_SECRET": "placeholder-secret",
        }
        required_values = {
            "SUPABASE_URL": self.SUPABASE_URL,
            "SUPABASE_SERVICE_ROLE_KEY": self.SUPABASE_SERVICE_ROLE_KEY,
            "SUPABASE_JWT_SECRET": self.SUPABASE_JWT_SECRET,
            "FRONTEND_URL": self.FRONTEND_URL,
            "STRIPE_SECRET_KEY": self.STRIPE_SECRET_KEY,
            "STRIPE_PLATFORM_WEBHOOK_SECRET": self.STRIPE_PLATFORM_WEBHOOK_SECRET,
            "STRIPE_CONNECT_WEBHOOK_SECRET": self.STRIPE_CONNECT_WEBHOOK_SECRET,
            "STRIPE_KOARYU_CORE_PRICE_ID": self.STRIPE_KOARYU_CORE_PRICE_ID,
            "ACCOUNT_DELETION_WORKER_SECRET": self.ACCOUNT_DELETION_WORKER_SECRET,
            "SUPPORT_TRIAGE_SECRET": self.SUPPORT_TRIAGE_SECRET,
        }

        for name, value in required_values.items():
            normalized = value.strip() if isinstance(value, str) else value
            if not normalized or placeholder_values.get(name) == normalized:
                missing.append(name)

        if self.DEMO_RESET_ENABLED:
            missing.append("DEMO_RESET_ENABLED must be false in production")

        frontend = urlparse(self.FRONTEND_URL)
        if frontend.scheme != "https" or not frontend.netloc or frontend.hostname in {"localhost", "127.0.0.1"}:
            missing.append("FRONTEND_URL must be a public HTTPS URL")

        if missing:
            detail = ", ".join(dict.fromkeys(missing))
            raise RuntimeError(f"Production configuration is incomplete or unsafe: {detail}")


@lru_cache()
def get_settings() -> Settings:
    return Settings()
