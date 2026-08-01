"""Read-only effective authorization checks for live Stripe mutations.

Writes are intentionally confined to the service-role RPC introduced by the
database migration.  Application request paths only consume the resulting
authorization state immediately before a provider mutation.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
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
CHECKPOINT_MAX_AGE = timedelta(hours=24)
COMMIT_SHA_PATTERN = re.compile(r"^[0-9a-f]{40}$")


def expected_deployment_candidate_sha() -> Optional[str]:
    """Return the exact backend deployment SHA or fail closed with ``None``."""
    raw_commit = os.environ.get("RENDER_GIT_COMMIT", "").strip().lower()
    return raw_commit if COMMIT_SHA_PATTERN.fullmatch(raw_commit) else None


class StudioLiveBillingAuthorizationStore:
    """Fail-closed reader for the durable per-studio authorization registry."""

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
        if expected_livemode is not True:
            self._blocked(LIVE_SCOPE_DENIED_DETAIL)
        if not studio_id and not account_id:
            self._blocked(LIVE_SCOPE_REQUIRED_DETAIL)

        account = self._payment_account(studio_id=studio_id, account_id=account_id)
        if account is not None:
            mapped_studio_id = account.get("studio_id")
            mapped_account_id = account.get("stripe_connected_account_id")
            if studio_id and mapped_studio_id and studio_id != mapped_studio_id:
                self._blocked(LIVE_SCOPE_DENIED_DETAIL)
            if account_id and mapped_account_id != account_id:
                self._blocked(LIVE_SCOPE_DENIED_DETAIL)
            studio_id = str(mapped_studio_id or studio_id or "") or None
            account_id = str(mapped_account_id or account_id or "") or None

        if not studio_id:
            self._blocked(LIVE_SCOPE_DENIED_DETAIL)

        authorization = self._authorization(studio_id, scope)
        if not authorization or not authorization.get("enabled"):
            self._blocked(LIVE_SCOPE_DENIED_DETAIL)
        expires_at = self._as_datetime(authorization.get("expires_at"))
        if expires_at is None or expires_at <= datetime.now(timezone.utc):
            self._blocked(LIVE_SCOPE_EXPIRED_DETAIL)
        if not self._reconciliation_checkpoint_ready():
            self._blocked(LIVE_SCOPE_DENIED_DETAIL)

        bound_account_id = authorization.get("stripe_connected_account_id")
        if scope == "core_subscription":
            if bound_account_id:
                self._blocked(LIVE_SCOPE_DENIED_DETAIL)
            return studio_id

        if scope == "connect_onboarding":
            # Account creation is allowed by a studio-scoped grant. Once an
            # account is supplied it must resolve to this studio; a stale or
            # reconnected account may never inherit the old grant.
            if account is None:
                self._blocked(LIVE_SCOPE_DENIED_DETAIL)
            if authorization.get("connect_account_generation") != self._account_generation(account):
                self._blocked(LIVE_SCOPE_DENIED_DETAIL)
            if operation == "connect_account.create":
                if account.get("stripe_connected_account_id") or bound_account_id:
                    self._blocked(LIVE_SCOPE_DENIED_DETAIL)
                return studio_id
            if account_id:
                if account.get("studio_id") != studio_id:
                    self._blocked(LIVE_SCOPE_DENIED_DETAIL)
                if bound_account_id and bound_account_id != account_id:
                    self._blocked(LIVE_SCOPE_DENIED_DETAIL)
            return studio_id

        # connect_payments is intentionally stricter than onboarding: both the
        # persisted grant and the currently mapped account must agree, the
        # account must be ready now. Current provider endpoint delivery is
        # proven by the exact-candidate reconciliation checkpoint above.
        if not account_id or not bound_account_id or bound_account_id != account_id:
            self._blocked(LIVE_SCOPE_DENIED_DETAIL)
        if account is None or account.get("studio_id") != studio_id:
            self._blocked(LIVE_SCOPE_DENIED_DETAIL)
        if authorization.get("connect_account_generation") != self._account_generation(account):
            self._blocked(LIVE_SCOPE_DENIED_DETAIL)
        if not self._connect_account_ready(account):
            self._blocked(LIVE_CONNECT_ACCOUNT_NOT_READY_DETAIL)
        return studio_id

    def _authorization(self, studio_id: str, scope: LiveBillingScope) -> Optional[dict[str, Any]]:
        try:
            result = (
                self.supabase.table("studio_live_billing_authorizations")
                .select(
                    "studio_id, scope, enabled, stripe_connected_account_id, connect_account_generation, "
                    "expires_at, revision"
                )
                .eq("studio_id", studio_id)
                .eq("scope", scope)
                .limit(1)
                .execute()
            )
        except Exception:
            self._blocked(LIVE_AUTHORIZATION_UNAVAILABLE_DETAIL)
        return result.data[0] if result.data else None

    def _payment_account(self, *, studio_id: Optional[str], account_id: Optional[str]) -> Optional[dict[str, Any]]:
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
    def _account_generation(account: dict[str, Any]) -> int:
        metadata = account.get("metadata") or {}
        try:
            return int(metadata.get("connect_account_generation") or 1)
        except (TypeError, ValueError):
            return 1

    @staticmethod
    def _connect_account_ready(account: dict[str, Any]) -> bool:
        return bool(
            account.get("stripe_connected_account_id")
            and account.get("charges_enabled")
            and account.get("payouts_enabled")
            and account.get("details_submitted")
            and not (account.get("requirements_due") or [])
            and account.get("status") != "deauthorized"
        )

    def _reconciliation_checkpoint_ready(self) -> bool:
        """Require a fresh all-clear live reconciliation checkpoint."""
        if self.expected_candidate_sha is None:
            return False
        try:
            result = (
                self.supabase.table("stripe_live_billing_reconciliation_checkpoints")
                .select(
                    "stripe_livemode, candidate_sha, unresolved_account_count, failed_event_count, "
                    "webhook_delivery_verified_at, enabled_platform_endpoint_count, "
                    "enabled_connect_endpoint_count, platform_endpoint_contract_matched, "
                    "connect_endpoint_contract_matched, verified_at, checkpoint_sequence, expires_at"
                )
                .eq("stripe_livemode", True)
                .order("verified_at", desc=True)
                .order("checkpoint_sequence", desc=True)
                .limit(1)
                .execute()
            )
        except Exception:
            return False
        row = result.data[0] if result.data else None
        expires_at = self._as_datetime((row or {}).get("expires_at"))
        delivery_verified_at = self._as_datetime((row or {}).get("webhook_delivery_verified_at"))
        unresolved_count = self._strict_int((row or {}).get("unresolved_account_count"))
        failed_count = self._strict_int((row or {}).get("failed_event_count"))
        now_datetime = datetime.now(timezone.utc)
        return bool(
            row
            and row.get("stripe_livemode") is True
            and row.get("candidate_sha") == self.expected_candidate_sha
            and unresolved_count == 0
            and failed_count == 0
            and self._strict_int(row.get("enabled_platform_endpoint_count")) is not None
            and self._strict_int(row.get("enabled_platform_endpoint_count")) > 0
            and self._strict_int(row.get("enabled_connect_endpoint_count")) is not None
            and self._strict_int(row.get("enabled_connect_endpoint_count")) > 0
            and row.get("platform_endpoint_contract_matched") is True
            and row.get("connect_endpoint_contract_matched") is True
            and delivery_verified_at
            and now_datetime - CHECKPOINT_MAX_AGE <= delivery_verified_at <= now_datetime + timedelta(minutes=5)
            and expires_at
            and expires_at > now_datetime
        )

    @staticmethod
    def _strict_int(value: Any) -> Optional[int]:
        if value is None or isinstance(value, bool):
            return None
        try:
            return int(value)
        except (TypeError, ValueError):
            return None

    @staticmethod
    def _as_datetime(value: Any) -> Optional[datetime]:
        if isinstance(value, datetime):
            parsed = value
        elif isinstance(value, str):
            try:
                parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            except ValueError:
                return None
        else:
            return None
        return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed.astimezone(timezone.utc)

    @staticmethod
    def _blocked(detail: str) -> None:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=detail)
