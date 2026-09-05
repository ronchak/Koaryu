from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal, Optional

from fastapi import HTTPException, status

from app.db.supabase import close_supabase_client, create_supabase_client
from app.services.billing_workflow_catalog import CONNECTED_STRIPE_SINKS, stripe_operation_scope
from app.services.studio_live_billing_authorizations import (
    ConnectOnboardingBootstrapContext,
    LIVE_SCOPE_REQUIRED_DETAIL,
    LiveBillingScope,
    StudioLiveBillingAuthorizationStore,
)


StripeMode = Literal["test", "live"]

LIVE_MUTATIONS_DISABLED_DETAIL = "Live Stripe mutations are disabled for this environment."
STRIPE_OPERATION_UNSUPPORTED_DETAIL = "This Stripe mutation is not owned by a supported billing workflow."
STRIPE_MODE_MISMATCH_DETAIL = "Stripe mode does not match the configured Stripe API key."
LIVE_AUTHORIZATION_POSTGREST_TIMEOUT_SECONDS = 10.0
CORE_SELF_CHECKOUT_OPERATIONS = frozenset({
    "customer.create",
    "core_checkout_session.create",
    "core_checkout_session.expire",
    "core_subscription.cancel",
    "customer_portal_session.create",
})


class StripeMutationBlocked(HTTPException):
    """Typed fail-closed response that must not be swallowed by billing workflows."""


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
    authorization_source: Literal[
        "test_mode", "core_self_checkout", "durable_live_scope"
    ] = "test_mode"
    studio_id: Optional[str] = None


class StripeMutationPolicy:
    """Fail-closed authorization for every outbound Stripe mutation.

    Test-mode mutations still require explicit studio/account scope. Live-mode
    mutations additionally require the global kill switch and a fresh, durable,
    per-studio scope check.
    """

    def __init__(self, settings: Any, *, authorization_store: Optional[StudioLiveBillingAuthorizationStore] = None):
        self.settings = settings
        self.authorization_store = authorization_store

    def issue_permit(
        self,
        operation: str,
        *,
        studio_id: Optional[str] = None,
        account_id: Optional[str] = None,
        payload_sha256: Optional[str] = None,
        bootstrap_context: Optional[ConnectOnboardingBootstrapContext] = None,
    ) -> StripeMutationPermit:
        declared_mode = declared_stripe_mode(self.settings)
        key = str(getattr(self.settings, "STRIPE_SECRET_KEY", "") or "").strip()
        key_mode = stripe_key_mode(key)

        if declared_mode is None or key_mode != declared_mode:
            raise StripeMutationBlocked(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=STRIPE_MODE_MISMATCH_DETAIL,
            )

        live_scope = stripe_mutation_scope(operation)
        if live_scope is None or not studio_id:
            raise StripeMutationBlocked(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=LIVE_SCOPE_REQUIRED_DETAIL,
            )
        sink = CONNECTED_STRIPE_SINKS.get(operation)
        if sink is not None and sink.classification == "unsupported":
            raise StripeMutationBlocked(
                status_code=status.HTTP_409_CONFLICT,
                detail=STRIPE_OPERATION_UNSUPPORTED_DETAIL,
            )
        if live_scope == "connect_payments" and not account_id:
            raise StripeMutationBlocked(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=LIVE_SCOPE_REQUIRED_DETAIL,
            )
        if live_scope == "connect_onboarding" and account_id is None and operation not in {
            "connect_account.create",
            "connect_branding_file.create",
        }:
            raise StripeMutationBlocked(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=LIVE_SCOPE_REQUIRED_DETAIL,
            )

        if declared_mode == "test":
            return StripeMutationPermit(operation=operation, mode="test", studio_id=studio_id)

        if (
            live_scope == "core_subscription"
            and operation in CORE_SELF_CHECKOUT_OPERATIONS
            and bool(getattr(self.settings, "CORE_SELF_CHECKOUT_ENABLED", False))
            and str(getattr(self.settings, "ENVIRONMENT", "")).strip().lower() == "production"
        ):
            return StripeMutationPermit(
                operation=operation,
                mode="live",
                authorization_source="core_self_checkout",
                studio_id=studio_id,
            )

        if not bool(getattr(self.settings, "LIVE_BILLING_ENABLED", False)):
            raise StripeMutationBlocked(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=LIVE_MUTATIONS_DISABLED_DETAIL,
            )
        authorization_context = {
            "operation": operation,
            "scope": live_scope,
            "studio_id": studio_id,
            "account_id": account_id,
            "expected_livemode": True,
        }
        if payload_sha256 is not None:
            authorization_context["payload_sha256"] = payload_sha256
        if bootstrap_context is not None:
            authorization_context["bootstrap_context"] = bootstrap_context
        if self.authorization_store is not None:
            authorized_studio_id = self.authorization_store.authorize(
                **authorization_context,
            )
        else:
            authorized_studio_id = self._with_isolated_store(
                lambda store: store.authorize(**authorization_context)
            )
        return StripeMutationPermit(
            operation=operation,
            mode="live",
            authorization_source="durable_live_scope",
            studio_id=authorized_studio_id,
        )

    def live_payments_authorized(self, *, studio_id: Optional[str] = None) -> bool:
        """Whether a studio is eligible for Connect payment mutations now.

        This is deliberately studio-specific. A global enabled flag, or a grant
        for another studio, must never light up a tenant's UI capability.
        """
        if configured_stripe_mode(self.settings) != "live" or not bool(
            getattr(self.settings, "LIVE_BILLING_ENABLED", False)
        ) or not studio_id:
            return False
        try:
            def check(store: StudioLiveBillingAuthorizationStore) -> bool:
                account = store._payment_account(studio_id=studio_id, account_id=None)
                return bool(
                    account
                    and store.authorize(
                        operation="connected_capability.readiness",
                        scope="connect_payments",
                        studio_id=studio_id,
                        account_id=account.get("stripe_connected_account_id"),
                        expected_livemode=True,
                    )
                )

            if self.authorization_store is not None:
                return check(self.authorization_store)
            return self._with_isolated_store(check)
        except Exception:
            return False

    @staticmethod
    def _with_isolated_store(callback):
        # Live authorization is rare and owns a private client for the
        # duration of the calling worker operation.
        client = create_supabase_client(
            postgrest_client_timeout=LIVE_AUTHORIZATION_POSTGREST_TIMEOUT_SECONDS,
        )
        try:
            return callback(StudioLiveBillingAuthorizationStore(client))
        finally:
            close_supabase_client(client)


def stripe_mutation_scope(operation: str) -> Optional[LiveBillingScope]:
    return stripe_operation_scope(operation)
