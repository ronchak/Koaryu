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

LIVE_AUTHORIZATION_UNAVAILABLE_DETAIL = "Live Stripe authorization state is unavailable."
LIVE_SCOPE_REQUIRED_DETAIL = "Live Stripe mutations require an explicit studio or connected-account scope."
LIVE_SCOPE_DENIED_DETAIL = "This studio is not authorized for the requested live Stripe operation."
LIVE_SCOPE_EXPIRED_DETAIL = "This studio's live Stripe authorization has expired."
LIVE_CONNECT_ACCOUNT_NOT_READY_DETAIL = "This Stripe Connect account is not currently ready for live payments."
LIVE_WEBHOOK_NOT_READY_DETAIL = "Live Stripe webhook delivery proof is not current."
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
    token: str
    account_generation: int
    initial_link_context_sha256: str
    account_create_idempotency_key: str
    initial_link_idempotency_key: str


def new_connect_onboarding_bootstrap_context(
    *,
    studio_id: str,
    account_generation: int,
    refresh_url: str,
    return_url: str,
) -> ConnectOnboardingBootstrapContext:
    token = secrets.token_urlsafe(32)
    token_digest = hashlib.sha256(token.encode("utf-8")).hexdigest()
    link_context = connect_initial_link_context_sha256(
        studio_id=studio_id,
        account_generation=account_generation,
        refresh_url=refresh_url,
        return_url=return_url,
    )
    return ConnectOnboardingBootstrapContext(
        token=token,
        account_generation=account_generation,
        initial_link_context_sha256=link_context,
        account_create_idempotency_key=f"koaryu-connect-account-{studio_id}-g{account_generation}",
        initial_link_idempotency_key=(
            f"koaryu-connect-onboarding-{studio_id}-g{account_generation}-{token_digest[:24]}"
        ),
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
            bootstrap_context is None or account_id is not None or not payload_sha256
        ):
            self._blocked(LIVE_SCOPE_DENIED_DETAIL)
        if bootstrap_context is not None and operation not in {
            "connect_account.create",
            "connect_onboarding_link.create",
        }:
            self._blocked(LIVE_SCOPE_DENIED_DETAIL)
        if operation == "connect_onboarding_link.create" and bootstrap_context and (
            not account_id or not payload_sha256
        ):
            self._blocked(LIVE_SCOPE_DENIED_DETAIL)
        try:
            if operation == "connect_account.create" and bootstrap_context:
                rpc_name = "authorize_connect_onboarding_bootstrap_account_create"
                rpc_params = {
                    "p_studio_id": studio_id,
                    "p_candidate_sha": self.expected_candidate_sha,
                    "p_connect_account_generation": bootstrap_context.account_generation,
                    "p_bootstrap_token": bootstrap_context.token,
                    "p_account_create_payload_sha256": payload_sha256,
                    "p_initial_link_context_sha256": bootstrap_context.initial_link_context_sha256,
                    "p_account_create_idempotency_key": bootstrap_context.account_create_idempotency_key,
                    "p_initial_link_idempotency_key": bootstrap_context.initial_link_idempotency_key,
                }
            elif operation == "connect_onboarding_link.create" and bootstrap_context:
                rpc_name = "authorize_connect_onboarding_bootstrap_initial_link"
                rpc_params = {
                    "p_studio_id": studio_id,
                    "p_candidate_sha": self.expected_candidate_sha,
                    "p_connect_account_generation": bootstrap_context.account_generation,
                    "p_bootstrap_token": bootstrap_context.token,
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
                "bind_connect_onboarding_bootstrap_account",
                {
                    "p_studio_id": studio_id,
                    "p_candidate_sha": self.expected_candidate_sha,
                    "p_connect_account_generation": bootstrap_context.account_generation,
                    "p_bootstrap_token": bootstrap_context.token,
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
