from pydantic_settings import BaseSettings
from functools import lru_cache
from pathlib import Path


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""

    SUPABASE_URL: str = "https://placeholder.supabase.co"
    SUPABASE_SERVICE_ROLE_KEY: str = "placeholder-key"
    SUPABASE_JWT_SECRET: str = "placeholder-secret"
    FRONTEND_URL: str = "http://localhost:4000"
    ENVIRONMENT: str = "development"
    DEMO_RESET_ENABLED: bool = False

    # API
    API_V1_PREFIX: str = "/api/v1"

    model_config = {
        "env_file": str(Path(__file__).resolve().parents[2] / ".env"),
        "case_sensitive": True,
        "extra": "ignore"
    }


@lru_cache()
def get_settings() -> Settings:
    return Settings()
