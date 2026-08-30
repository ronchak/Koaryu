from __future__ import annotations

from typing import Any

from app.core.config import get_settings
from app.services.stripe_mutation_policy import configured_stripe_mode


def allows_provider_enrollment_preparation(settings: Any | None = None) -> bool:
    """Allow local provider-backed enrollment preparation only in Stripe test staging."""
    runtime_settings = settings or get_settings()
    return (
        getattr(runtime_settings, "ENVIRONMENT", None) == "staging"
        and configured_stripe_mode(runtime_settings) == "test"
    )
