"""Database-authoritative live Stripe mutation authorization.

Application callers provide only the intended operation and its exact studio /
account context.  The service-role RPC derives grants, checkpoint provenance,
event drift, mapping generation, and current readiness from one locked database
snapshot immediately before the provider call.
"""

from __future__ import annotations

import os
import re
from typing import Any, Literal, Optional

from fastapi import HTTPException, status


LiveBillingScope = Literal[
    "core_subscription",
    "connect_onboarding",
    "connect_payments",
]

LIVE_AUTHORIZATION_UNAVAILABLE_DETAIL = "Live Stripe authorization state is unavailable."
LIVE_SCOPE_REQUIRED_DETAIL = "Live Stripe mutations require an explicit studio or connected-account scope."
LIVE_SCOPE_DENIED_DETAIL = "This studio is not authorized for the requested live Stripe operation."
LIVE_SCOPE_EXPIRED_DETAIL = "This studio's live Stripe authorization has expired."
LIVE_CONNECT_ACCOUNT_NOT_READY_DETAIL = "This Stripe Connect account is not currently ready for live payments."
LIVE_WEBHOOK_NOT_READY_DETAIL = "Live Stripe webhook delivery proof is not current."
COMMIT_SHA_PATTERN = re.compile(r"^[0-9a-f]{40}$")


def expected_deployment_candidate_sha() -> Optional[str]:
    """Return the exact backend deployment SHA or fail closed with ``None``."""
    raw_commit = os.environ.get("RENDER_GIT_COMMIT", "").strip().lower()
    return raw_commit if COMMIT_SHA_PATTERN.fullmatch(raw_commit) else None


class StudioLiveBillingAuthorizationStore:
    """Fail-closed adapter around the atomic database authorization RPC."""

    def __init__(self, supabase: Any, *, expected_candidate_sha: Optional[str] = None):
        self.supabase = supabase
        self.expected_candidate_sha = expected_candidate_sha or expected_deployment_candidate_sha()

    def authorize(
        self,
        *,
        operation: str,
        scope: LiveBillingScope,
        studio_id: Optional[str],
        account_id: Optional[str],
        expected_livemode: bool,
    ) -> str:
        if expected_livemode is not True or not studio_id or self.expected_candidate_sha is None:
            self._blocked(LIVE_SCOPE_DENIED_DETAIL)
        try:
            result = self.supabase.rpc(
                "authorize_studio_live_billing_mutation_atomic",
                {
                    "p_studio_id": studio_id,
                    "p_operation": operation,
                    "p_scope": scope,
                    "p_stripe_connected_account_id": account_id,
                    "p_candidate_sha": self.expected_candidate_sha,
                },
            ).execute()
        except Exception:
            self._blocked(LIVE_AUTHORIZATION_UNAVAILABLE_DETAIL)
        row = result.data[0] if result.data else None
        if not row or row.get("authorized") is not True or row.get("studio_id") != studio_id:
            self._blocked(LIVE_SCOPE_DENIED_DETAIL)
        return studio_id

    def _payment_account(self, *, studio_id: Optional[str], account_id: Optional[str]) -> Optional[dict[str, Any]]:
        """Read-only helper retained for studio-specific capability reporting."""
        if not studio_id and not account_id:
            return None
        try:
            query = self.supabase.table("studio_payment_accounts").select(
                "studio_id, stripe_connected_account_id, status, charges_enabled, payouts_enabled, "
                "details_submitted, requirements_due, metadata"
            )
            query = query.eq("studio_id", studio_id) if studio_id else query.eq("stripe_connected_account_id", account_id)
            result = query.limit(1).execute()
        except Exception:
            self._blocked(LIVE_AUTHORIZATION_UNAVAILABLE_DETAIL)
        return result.data[0] if result.data else None

    @staticmethod
    def _blocked(detail: str) -> None:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=detail)
