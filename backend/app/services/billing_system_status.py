from __future__ import annotations

from collections.abc import Awaitable, Callable
from datetime import datetime, timedelta, timezone
import logging
from typing import Any, Optional
from uuid import uuid4

from supabase import Client

from app.schemas.billing import (
    BillingSystemCheck,
    BillingSystemStatusResponse,
    BillingWebhookHealthResponse,
    StudioPaymentAccountResponse,
)
from app.services.billing_connect_accounts import BillingConnectAccountStore
from app.services.billing_invoice_projection import _to_text
from app.services.stripe_mutation_policy import (
    StripeMutationPolicy,
    configured_stripe_mode,
    expected_stripe_livemode,
)


BILLING_WEBHOOK_PROCESSING_STALE_AFTER = timedelta(minutes=10)
BILLING_WEBHOOK_RECENT_WITHIN = timedelta(days=35)
BILLING_WEBHOOK_CLOCK_SKEW = timedelta(minutes=5)


logger = logging.getLogger(__name__)


class BillingSystemStatusReporter:
    def __init__(
        self,
        supabase: Client,
        *,
        settings: Any,
        connect_accounts: BillingConnectAccountStore,
        payment_account_loader: Callable[[str], Awaitable[StudioPaymentAccountResponse]],
    ):
        self.supabase = supabase
        self.settings = settings
        self.connect_accounts = connect_accounts
        self.payment_account_loader = payment_account_loader

    async def get_system_status(self, studio_id: str) -> BillingSystemStatusResponse:
        checked_at = datetime.now(timezone.utc).isoformat()
        checks: list[BillingSystemCheck] = []

        def add_check(name: str, passed: bool, detail: str, *, warn: bool = False) -> None:
            checks.append(BillingSystemCheck(
                name=name,
                status="pass" if passed else ("warn" if warn else "fail"),
                detail=detail,
            ))

        self._add_configuration_checks(add_check)

        try:
            account_response = await self.payment_account_loader(studio_id)
            account_failed = False
        except Exception as exc:
            account_failed = True
            error_id = uuid4().hex
            self._log_readiness_exception(
                "Stripe Connect account refresh failed during billing readiness check",
                exc,
                error_id=error_id,
            )
            add_check(
                "Connect account refresh",
                False,
                f"Could not refresh the Stripe Connect account. Reference: {error_id}",
            )
            try:
                account_row = self.connect_accounts.ensure_row(studio_id)
                account_response = self.connect_accounts.response(account_row)
            except Exception as fallback_exc:
                fallback_error_id = uuid4().hex
                self._log_readiness_exception(
                    "Stripe Connect account fallback failed during billing readiness check",
                    fallback_exc,
                    error_id=fallback_error_id,
                )
                account_response = StudioPaymentAccountResponse(studio_id=studio_id)
                add_check(
                    "Connect account fallback",
                    False,
                    f"Could not read the stored Stripe Connect account. Reference: {fallback_error_id}",
                )

        if not account_failed:
            self._add_connect_account_checks(add_check, account_response)

        try:
            self.supabase.table("studio_payment_accounts").select("studio_id").eq("studio_id", studio_id).limit(1).execute()
            add_check("Supabase billing read", True, "Supabase billing tables are reachable.")
        except Exception as exc:
            error_id = uuid4().hex
            self._log_readiness_exception(
                "Supabase billing readiness read failed",
                exc,
                error_id=error_id,
            )
            add_check(
                "Supabase billing read",
                False,
                f"Supabase billing tables are not reachable. Reference: {error_id}",
            )

        platform_webhooks = self.webhook_health(None)
        connect_webhooks = (
            self.webhook_health(account_response.stripe_connected_account_id)
            if account_response.stripe_connected_account_id
            else BillingWebhookHealthResponse()
        )
        self._add_webhook_checks(add_check, platform_webhooks, connect_webhooks)

        stripe_mode = configured_stripe_mode(self.settings)
        ready_for_configured_mode = all(check.status == "pass" for check in checks)
        live_payments_authorized = StripeMutationPolicy(self.settings).live_payments_authorized()
        return BillingSystemStatusResponse(
            studio_id=studio_id,
            configured_stripe_mode=stripe_mode,
            ready_for_configured_mode=ready_for_configured_mode,
            live_payments_authorized=live_payments_authorized,
            ready_for_live_payments=(
                stripe_mode == "live"
                and live_payments_authorized
                and ready_for_configured_mode
            ),
            checked_at=checked_at,
            payment_account=account_response,
            platform_webhooks=platform_webhooks,
            connect_webhooks=connect_webhooks,
            checks=checks,
        )

    def webhook_health(self, account_id: Optional[str]) -> BillingWebhookHealthResponse:
        try:
            latest_processed_query = (
                self.supabase.table("stripe_events")
                .select("type, processed_at")
                .eq("processing_status", "processed")
                .not_.is_("processed_at", "null")
                .order("processed_at", desc=True)
                .limit(1)
            )
            latest_processed_rows = (
                self._scope_webhook_query(latest_processed_query, account_id).execute().data or []
            )
            latest_processed = latest_processed_rows[0] if latest_processed_rows else None
            expected_livemode = self._expected_stripe_livemode()
            pending_count = self._count_webhook_events(
                account_id,
                processing_status="pending",
            )
            processing_count = self._count_webhook_events(
                account_id,
                processing_status="processing",
            )
            failed_count = self._count_webhook_events(
                account_id,
                processing_status="failed",
            )
            stale_processing_count = self._count_webhook_events(
                account_id,
                processing_status="processing",
                processing_started_before=(
                    datetime.now(timezone.utc) - BILLING_WEBHOOK_PROCESSING_STALE_AFTER
                ),
            )
            stale_processing_count += self._count_webhook_events(
                account_id,
                processing_status="processing",
                processing_started_is_null=True,
                created_before=(
                    datetime.now(timezone.utc) - BILLING_WEBHOOK_PROCESSING_STALE_AFTER
                ),
            )
            mode_mismatch_count = (
                self._count_webhook_events(
                    account_id,
                    livemode_not=expected_livemode,
                )
                if expected_livemode is not None
                else 0
            )
        except Exception as exc:
            error_id = uuid4().hex
            self._log_readiness_exception(
                "Stripe webhook readiness query failed",
                exc,
                error_id=error_id,
            )
            return BillingWebhookHealthResponse(
                stripe_account_id=account_id,
                failed_count=1,
                stale_processing_count=0,
                error_reference=error_id,
            )

        return BillingWebhookHealthResponse(
            stripe_account_id=account_id,
            latest_processed_at=_to_text((latest_processed or {}).get("processed_at")),
            latest_event_type=(latest_processed or {}).get("type"),
            pending_count=pending_count,
            processing_count=processing_count,
            failed_count=failed_count,
            stale_processing_count=stale_processing_count,
            mode_mismatch_count=mode_mismatch_count,
        )

    def _count_webhook_events(
        self,
        account_id: Optional[str],
        *,
        processing_status: Optional[str] = None,
        processing_started_before: Optional[datetime] = None,
        processing_started_is_null: bool = False,
        created_before: Optional[datetime] = None,
        livemode_not: Optional[bool] = None,
    ) -> int:
        query = self.supabase.table("stripe_events").select("id", count="exact").limit(1)
        query = self._scope_webhook_query(query, account_id)
        if processing_status is not None:
            query = query.eq("processing_status", processing_status)
        if processing_started_before is not None:
            query = query.lte("processing_started_at", processing_started_before.isoformat())
        if processing_started_is_null:
            query = query.is_("processing_started_at", "null")
        if created_before is not None:
            query = query.lte("created_at", created_before.isoformat())
        if livemode_not is not None:
            query = query.neq("livemode", livemode_not)
        return int(query.execute().count or 0)

    @staticmethod
    def _scope_webhook_query(query: Any, account_id: Optional[str]):
        if account_id:
            return query.eq("stripe_account_id", account_id)
        return query.is_("stripe_account_id", "null")

    def _add_configuration_checks(self, add_check: Callable[..., None]) -> None:
        stripe_mode = configured_stripe_mode(self.settings)
        add_check(
            "Stripe mode and API key",
            stripe_mode is not None,
            "STRIPE_MODE and STRIPE_SECRET_KEY identify the same Stripe mode."
            if stripe_mode is not None
            else "STRIPE_MODE is missing or does not match STRIPE_SECRET_KEY.",
        )
        live_payments_authorized = StripeMutationPolicy(self.settings).live_payments_authorized()
        mutations_authorized = stripe_mode == "test" or (
            stripe_mode == "live" and live_payments_authorized
        )
        add_check(
            "Stripe outbound mutations",
            mutations_authorized,
            "Test-mode Stripe mutations are authorized automatically."
            if stripe_mode == "test"
            else (
                "Durable authorization permits live Stripe mutations."
                if live_payments_authorized
                else "Live Stripe mutations are closed until durable authorization is configured."
            ),
        )
        add_check(
            "Koaryu Core price",
            bool(getattr(self.settings, "STRIPE_KOARYU_CORE_PRICE_ID", "")),
            "Koaryu Core price ID is configured." if getattr(self.settings, "STRIPE_KOARYU_CORE_PRICE_ID", "") else "STRIPE_KOARYU_CORE_PRICE_ID is missing.",
        )
        add_check(
            "Platform webhook secret",
            bool(getattr(self.settings, "STRIPE_PLATFORM_WEBHOOK_SECRET", "")),
            "Platform webhook signature secret is configured." if getattr(self.settings, "STRIPE_PLATFORM_WEBHOOK_SECRET", "") else "STRIPE_PLATFORM_WEBHOOK_SECRET is missing.",
        )
        add_check(
            "Connect webhook secret",
            bool(getattr(self.settings, "STRIPE_CONNECT_WEBHOOK_SECRET", "")),
            "Connect webhook signature secret is configured." if getattr(self.settings, "STRIPE_CONNECT_WEBHOOK_SECRET", "") else "STRIPE_CONNECT_WEBHOOK_SECRET is missing.",
        )

    def _add_connect_account_checks(
        self,
        add_check: Callable[..., None],
        account_response: StudioPaymentAccountResponse,
    ) -> None:
        add_check(
            "Connect account",
            bool(account_response.stripe_connected_account_id),
            "Stripe Connect account exists." if account_response.stripe_connected_account_id else "Studio has not connected Stripe Payments.",
        )
        add_check(
            "Connect charges",
            account_response.charges_enabled,
            "Connected account can accept charges." if account_response.charges_enabled else "Connected account cannot accept charges yet.",
        )
        add_check(
            "Connect payouts",
            account_response.payouts_enabled,
            "Connected account payouts are enabled." if account_response.payouts_enabled else "Connected account payouts are not enabled yet.",
            warn=account_response.charges_enabled,
        )
        add_check(
            "Connect requirements",
            not account_response.requirements_due,
            "No currently due Connect requirements." if not account_response.requirements_due else "Connect has currently due requirements: " + ", ".join(account_response.requirements_due),
        )

    def _add_webhook_checks(
        self,
        add_check: Callable[..., None],
        platform_webhooks: BillingWebhookHealthResponse,
        connect_webhooks: BillingWebhookHealthResponse,
    ) -> None:
        for label, health in (
            ("Platform", platform_webhooks),
            ("Connect", connect_webhooks),
        ):
            add_check(
                f"{label} webhook query",
                health.error_reference is None,
                f"{label} webhook health data is reachable."
                if health.error_reference is None
                else f"{label} webhook health data could not be read. Reference: {health.error_reference}",
            )
            processing_ok = (
                health.pending_count == 0
                and health.failed_count == 0
                and health.stale_processing_count == 0
            )
            add_check(
                f"{label} webhook processing",
                processing_ok,
                f"No pending, failed, or stale {label.lower()} webhook events found."
                if processing_ok
                else f"{label} webhook backlog, failures, or stale processing rows need review.",
            )
            add_check(
                f"{label} webhook mode",
                self._expected_stripe_livemode() is not None and health.mode_mismatch_count == 0,
                f"Observed {label.lower()} webhook events match the configured Stripe mode."
                if self._expected_stripe_livemode() is not None and health.mode_mismatch_count == 0
                else f"{label} webhook event mode does not match STRIPE_MODE.",
            )
            recent = self._is_recent_timestamp(health.latest_processed_at)
            add_check(
                f"Recent {label} webhook",
                recent,
                f"A recent {label.lower()} webhook has processed."
                if recent
                else f"No {label.lower()} webhook has processed within the readiness window.",
            )

    @staticmethod
    def is_stale_webhook_processing(row: dict[str, Any]) -> bool:
        if row.get("processing_status") != "processing":
            return False
        processing_started_at = row.get("processing_started_at") or row.get("created_at")
        if not processing_started_at:
            return False
        if isinstance(processing_started_at, datetime):
            started = processing_started_at
        elif isinstance(processing_started_at, str):
            try:
                started = datetime.fromisoformat(processing_started_at.replace("Z", "+00:00"))
            except ValueError:
                return False
        else:
            return False
        if started.tzinfo is None:
            started = started.replace(tzinfo=timezone.utc)
        return datetime.now(timezone.utc) - started >= BILLING_WEBHOOK_PROCESSING_STALE_AFTER

    @staticmethod
    def _log_readiness_exception(
        message: str,
        exc: Exception,
        *,
        error_id: str,
    ) -> None:
        logger.error(
            message,
            extra={
                "error_id": error_id,
                "exception_type": type(exc).__name__,
            },
        )

    def _expected_stripe_livemode(self) -> Optional[bool]:
        return expected_stripe_livemode(self.settings)

    @staticmethod
    def _is_recent_timestamp(value: Optional[str]) -> bool:
        if not value:
            return False
        try:
            observed_at = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except (TypeError, ValueError):
            return False
        if observed_at.tzinfo is None:
            observed_at = observed_at.replace(tzinfo=timezone.utc)
        age = datetime.now(timezone.utc) - observed_at
        return -BILLING_WEBHOOK_CLOCK_SKEW <= age <= BILLING_WEBHOOK_RECENT_WITHIN
