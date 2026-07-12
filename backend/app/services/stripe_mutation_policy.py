from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal, Optional

from fastapi import HTTPException, status


StripeMode = Literal["test", "live"]

LIVE_MUTATIONS_DISABLED_DETAIL = "Live Stripe mutations are disabled for this environment."
LIVE_MUTATIONS_REQUIRE_DURABLE_AUTHORIZATION_DETAIL = (
    "Live Stripe mutations require durable scope authorization before they can run."
)
STRIPE_MODE_MISMATCH_DETAIL = "Stripe mode does not match the configured Stripe API key."


def stripe_key_mode(value: Any) -> Optional[StripeMode]:
    key = str(value or "").strip()
    if key.startswith("sk_test_"):
        return "test"
    if key.startswith("sk_live_"):
        return "live"
    return None


def declared_stripe_mode(settings: Any) -> Optional[StripeMode]:
    raw_mode = getattr(settings, "STRIPE_MODE", None)
    if raw_mode is not None:
        normalized = str(raw_mode).strip().lower()
        if normalized in {"test", "live"}:
            return normalized  # type: ignore[return-value]
        return None

    # Compatibility for injected test settings. The real Settings model always
    # declares STRIPE_MODE explicitly.
    return stripe_key_mode(getattr(settings, "STRIPE_SECRET_KEY", ""))


def configured_stripe_mode(settings: Any) -> Optional[StripeMode]:
    declared_mode = declared_stripe_mode(settings)
    key_mode = stripe_key_mode(getattr(settings, "STRIPE_SECRET_KEY", ""))
    if declared_mode is None or key_mode is None or declared_mode != key_mode:
        return None
    return declared_mode


def expected_stripe_livemode(settings: Any) -> Optional[bool]:
    mode = configured_stripe_mode(settings)
    if mode == "live":
        return True
    if mode == "test":
        return False
    return None


@dataclass(frozen=True)
class StripeMutationPermit:
    operation: str
    mode: StripeMode
    authorization_source: Literal["test_mode"] = "test_mode"


class StripeMutationPolicy:
    """Fail-closed authorization for every outbound Stripe mutation.

    Test-mode mutations are automatically permitted. Live-mode mutations remain
    universally closed until a durable platform/studio authorization registry is
    implemented in a later gate. LIVE_BILLING_ENABLED is therefore necessary but
    intentionally not sufficient for a live permit.
    """

    def __init__(self, settings: Any):
        self.settings = settings

    def issue_permit(self, operation: str) -> StripeMutationPermit:
        declared_mode = declared_stripe_mode(self.settings)
        key = str(getattr(self.settings, "STRIPE_SECRET_KEY", "") or "").strip()
        key_mode = stripe_key_mode(key)

        if declared_mode is None or key_mode != declared_mode:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=STRIPE_MODE_MISMATCH_DETAIL,
            )

        if declared_mode == "test":
            return StripeMutationPermit(operation=operation, mode="test")

        if not bool(getattr(self.settings, "LIVE_BILLING_ENABLED", False)):
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=LIVE_MUTATIONS_DISABLED_DETAIL,
            )

        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=LIVE_MUTATIONS_REQUIRE_DURABLE_AUTHORIZATION_DETAIL,
        )

    def live_payments_authorized(self) -> bool:
        # No durable platform/studio authorization source exists in this release.
        return False
