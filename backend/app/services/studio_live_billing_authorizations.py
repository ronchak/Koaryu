"""Database-authoritative live Stripe mutation authorization.

Application callers provide only the intended operation and its exact studio /
account context.  The service-role RPC derives grants, checkpoint provenance,
event drift, mapping generation, and current readiness from one locked database
snapshot immediately before the provider call.
"""

from __future__ import annotations

import os
import hashlib
import json
import re
import secrets
from dataclasses import dataclass
from typing import Any, Literal, Optional

from fastapi import HTTPException, status


LiveBillingScope = Literal[
    "core_subscription",
    "connect_onboarding",
    "connect_payments",
]
ConnectOnboardingPreflightState = Literal["eligible", "none", "support_required", "denied"]

LIVE_AUTHORIZATION_UNAVAILABLE_DETAIL = "Live Stripe authorization state is unavailable."
LIVE_SCOPE_REQUIRED_DETAIL = "Live Stripe mutations require an explicit studio or connected-account scope."
LIVE_SCOPE_DENIED_DETAIL = "This studio is not authorized for the requested live Stripe operation."
LIVE_SCOPE_EXPIRED_DETAIL = "This studio's live Stripe authorization has expired."
LIVE_CONNECT_ACCOUNT_NOT_READY_DETAIL = "This Stripe Connect account is not currently ready for live payments."
LIVE_WEBHOOK_NOT_READY_DETAIL = "Live Stripe webhook delivery proof is not current."
LIVE_CONNECT_BOOTSTRAP_SUPPORT_DETAIL = (
    "Stripe onboarding recovery requires support before this studio can continue."
)
COMMIT_SHA_PATTERN = re.compile(r"^[0-9a-f]{40}$")


def stripe_payload_sha256(payload: dict[str, Any]) -> str:
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def connect_initial_link_context_sha256(
    *,
    studio_id: str,
    account_generation: int,
    refresh_url: str,
    return_url: str,
) -> str:
    return stripe_payload_sha256({
        "operation": "connect_onboarding_link.create",
        "studio_id": studio_id,
        "connect_account_generation": account_generation,
        "configurations": ["merchant"],
        "collection_options": {"fields": "eventually_due"},
        "refresh_url": refresh_url,
        "return_url": return_url,
    })


@dataclass(frozen=True)
class ConnectOnboardingBootstrapContext:
    account_generation: int
    initial_link_context_sha256: str
    account_create_idempotency_key: str
    initial_link_idempotency_key: str
    bootstrap_id: Optional[str] = None
    recovery_context: Optional[dict[str, Any]] = None
    stripe_connected_account_id: Optional[str] = None
    phase: Optional[str] = None


def new_connect_onboarding_bootstrap_context(
    *,
    studio_id: str,
    account_generation: int,
    refresh_url: str,
    return_url: str,
    recovery_context: Optional[dict[str, Any]] = None,
) -> ConnectOnboardingBootstrapContext:
    idempotency_nonce = secrets.token_hex(12)
    link_context = connect_initial_link_context_sha256(
        studio_id=studio_id,
        account_generation=account_generation,
        refresh_url=refresh_url,
        return_url=return_url,
    )
    return ConnectOnboardingBootstrapContext(
        account_generation=account_generation,
        initial_link_context_sha256=link_context,
        account_create_idempotency_key=f"koaryu-connect-account-{studio_id}-g{account_generation}",
        initial_link_idempotency_key=(
            f"koaryu-connect-onboarding-{studio_id}-g{account_generation}-{idempotency_nonce}"
        ),
        recovery_context=recovery_context,
    )


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
        payload_sha256: Optional[str] = None,
        bootstrap_context: Optional[ConnectOnboardingBootstrapContext] = None,
    ) -> str:
        if expected_livemode is not True or not studio_id or self.expected_candidate_sha is None:
            self._blocked(LIVE_SCOPE_DENIED_DETAIL)
        if operation == "connect_account.create" and (
            bootstrap_context is None
            or not bootstrap_context.bootstrap_id
            or account_id is not None
            or not payload_sha256
        ):
            self._blocked(LIVE_SCOPE_DENIED_DETAIL)
        if bootstrap_context is not None and operation not in {
            "connect_account.create",
            "connect_onboarding_link.create",
        }:
            self._blocked(LIVE_SCOPE_DENIED_DETAIL)
        if operation == "connect_onboarding_link.create" and bootstrap_context and (
            not bootstrap_context.bootstrap_id or not account_id or not payload_sha256
        ):
            self._blocked(LIVE_SCOPE_DENIED_DETAIL)
        try:
            if operation == "connect_account.create" and bootstrap_context:
                rpc_name = "authorize_connect_onboarding_bootstrap_account_create_v2"
                rpc_params = {
                    "p_bootstrap_id": bootstrap_context.bootstrap_id,
                    "p_studio_id": studio_id,
                    "p_candidate_sha": self.expected_candidate_sha,
                    "p_connect_account_generation": bootstrap_context.account_generation,
                    "p_account_create_payload_sha256": payload_sha256,
                    "p_account_create_idempotency_key": bootstrap_context.account_create_idempotency_key,
                }
            elif operation == "connect_onboarding_link.create" and bootstrap_context:
                rpc_name = "authorize_connect_onboarding_bootstrap_initial_link_v2"
                rpc_params = {
                    "p_bootstrap_id": bootstrap_context.bootstrap_id,
                    "p_studio_id": studio_id,
                    "p_candidate_sha": self.expected_candidate_sha,
                    "p_connect_account_generation": bootstrap_context.account_generation,
                    "p_stripe_connected_account_id": account_id,
                    "p_initial_link_context_sha256": bootstrap_context.initial_link_context_sha256,
                    "p_initial_link_payload_sha256": payload_sha256,
                    "p_initial_link_idempotency_key": bootstrap_context.initial_link_idempotency_key,
                }
            else:
                rpc_name = "authorize_studio_live_billing_mutation_atomic"
                rpc_params = {
                    "p_studio_id": studio_id,
                    "p_operation": operation,
                    "p_scope": scope,
                    "p_stripe_connected_account_id": account_id,
                    "p_candidate_sha": self.expected_candidate_sha,
                }
            result = self.supabase.rpc(rpc_name, rpc_params).execute()
        except Exception:
            self._blocked(LIVE_AUTHORIZATION_UNAVAILABLE_DETAIL)
        row = result.data[0] if result.data else None
        if not row or row.get("authorized") is not True or row.get("studio_id") != studio_id:
            self._blocked(LIVE_SCOPE_DENIED_DETAIL)
        return studio_id

    def prepare_connect_onboarding_bootstrap(
        self,
        *,
        studio_id: str,
        recovery_context: dict[str, Any],
        account_create_payload_sha256: str,
        bootstrap_context: ConnectOnboardingBootstrapContext,
    ) -> ConnectOnboardingBootstrapContext:
        if self.expected_candidate_sha is None:
            self._blocked(LIVE_SCOPE_DENIED_DETAIL)
        try:
            result = self.supabase.rpc(
                "prepare_connect_onboarding_bootstrap_atomic",
                {
                    "p_studio_id": studio_id,
                    "p_candidate_sha": self.expected_candidate_sha,
                    "p_connect_account_generation": bootstrap_context.account_generation,
                    "p_recovery_context": recovery_context,
                    "p_account_create_payload_sha256": account_create_payload_sha256,
                    "p_initial_link_context_sha256": bootstrap_context.initial_link_context_sha256,
                    "p_account_create_idempotency_key": bootstrap_context.account_create_idempotency_key,
                    "p_initial_link_idempotency_key": bootstrap_context.initial_link_idempotency_key,
                },
            ).execute()
        except Exception:
            self._blocked(LIVE_AUTHORIZATION_UNAVAILABLE_DETAIL)
        return self._context_from_row(result.data[0] if result.data else None, studio_id=studio_id)

    def load_connect_onboarding_bootstrap_recovery(
        self,
        *,
        studio_id: str,
    ) -> Optional[ConnectOnboardingBootstrapContext]:
        if self.expected_candidate_sha is None:
            self._blocked(LIVE_SCOPE_DENIED_DETAIL)
        preflight = self._connect_onboarding_resume_preflight(studio_id=studio_id)
        if preflight == "support_required":
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=LIVE_CONNECT_BOOTSTRAP_SUPPORT_DETAIL,
            )
        if preflight == "none":
            return None
        if preflight != "eligible":
            self._blocked(LIVE_AUTHORIZATION_UNAVAILABLE_DETAIL)
        try:
            result = self.supabase.rpc(
                "load_connect_onboarding_bootstrap_recovery_context",
                {
                    "p_studio_id": studio_id,
                    "p_candidate_sha": self.expected_candidate_sha,
                },
            ).execute()
        except Exception:
            self._blocked(LIVE_AUTHORIZATION_UNAVAILABLE_DETAIL)
        if not result.data:
            self._blocked(LIVE_SCOPE_DENIED_DETAIL)
        return self._context_from_row(result.data[0], studio_id=studio_id)

    def can_begin_or_resume_connect_onboarding(self, *, studio_id: str) -> bool:
        """Read-only UI hint; provider sinks still reauthorize atomically."""
        return self.connect_onboarding_preflight_state(studio_id=studio_id) == "eligible"

    def connect_onboarding_preflight_state(
        self,
        *,
        studio_id: str,
    ) -> ConnectOnboardingPreflightState:
        if self.expected_candidate_sha is None:
            return "denied"
        begin = self._connect_onboarding_preflight_rpc(
            "preflight_connect_onboarding_bootstrap_begin",
            studio_id=studio_id,
        )
        if begin is None:
            return "denied"
        if begin.get("eligible") is True:
            return "eligible"
        return self._connect_onboarding_resume_preflight(studio_id=studio_id)

    def _connect_onboarding_resume_preflight(
        self,
        *,
        studio_id: str,
    ) -> ConnectOnboardingPreflightState:
        row = self._connect_onboarding_preflight_rpc(
            "preflight_connect_onboarding_bootstrap_resume",
            studio_id=studio_id,
        )
        if row is None:
            return "denied"
        if row.get("eligible") is True:
            return "eligible"
        if row.get("phase") == "none":
            return "none"
        return "support_required" if row.get("phase") == "support_required" else "denied"

    def _connect_onboarding_preflight_rpc(
        self,
        rpc_name: str,
        *,
        studio_id: str,
    ) -> Optional[dict[str, Any]]:
        try:
            result = self.supabase.rpc(
                rpc_name,
                {
                    "p_studio_id": studio_id,
                    "p_candidate_sha": self.expected_candidate_sha,
                },
            ).execute()
        except Exception:
            return None
        row = result.data[0] if result.data else None
        return row if row and row.get("studio_id") == studio_id else None

    def _context_from_row(
        self,
        row: Optional[dict[str, Any]],
        *,
        studio_id: str,
    ) -> ConnectOnboardingBootstrapContext:
        if (
            not row
            or row.get("studio_id") != studio_id
            or not row.get("bootstrap_id")
            or not isinstance(row.get("recovery_context"), dict)
        ):
            self._blocked(LIVE_SCOPE_DENIED_DETAIL)
        recovery_context = dict(row["recovery_context"])
        return ConnectOnboardingBootstrapContext(
            bootstrap_id=str(row["bootstrap_id"]),
            account_generation=int(row["connect_account_generation"]),
            recovery_context=recovery_context,
            initial_link_context_sha256=connect_initial_link_context_sha256(
                studio_id=studio_id,
                account_generation=int(row["connect_account_generation"]),
                refresh_url=str(recovery_context.get("refresh_url") or ""),
                return_url=str(recovery_context.get("return_url") or ""),
            ),
            account_create_idempotency_key=str(row["account_create_idempotency_key"]),
            initial_link_idempotency_key=str(row["initial_link_idempotency_key"]),
            stripe_connected_account_id=row.get("stripe_connected_account_id"),
            phase=row.get("phase"),
        )

    def bind_created_connect_account(
        self,
        *,
        studio_id: str,
        account_id: str,
        business_entity_type: str,
        bootstrap_context: ConnectOnboardingBootstrapContext,
    ) -> dict[str, Any]:
        if self.expected_candidate_sha is None:
            self._blocked(LIVE_SCOPE_DENIED_DETAIL)
        try:
            result = self.supabase.rpc(
                "bind_connect_onboarding_bootstrap_account_v2",
                {
                    "p_bootstrap_id": bootstrap_context.bootstrap_id,
                    "p_studio_id": studio_id,
                    "p_candidate_sha": self.expected_candidate_sha,
                    "p_connect_account_generation": bootstrap_context.account_generation,
                    "p_stripe_connected_account_id": account_id,
                    "p_business_entity_type": business_entity_type,
                },
            ).execute()
        except Exception:
            self._blocked(LIVE_AUTHORIZATION_UNAVAILABLE_DETAIL)
        row = result.data[0] if result.data else None
        if not row or row.get("studio_id") != studio_id or row.get("stripe_connected_account_id") != account_id:
            self._blocked(LIVE_SCOPE_DENIED_DETAIL)
        return row

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
