from __future__ import annotations

from collections.abc import Awaitable, Callable
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from supabase import Client

from app.schemas.billing import (
    BillingSystemCheck,
    BillingSystemStatusResponse,
    BillingWebhookHealthResponse,
    StudioPaymentAccountResponse,
)
from app.services.billing_connect_accounts import BillingConnectAccountStore
from app.services.billing_invoice_projection import _to_text


BILLING_WEBHOOK_PROCESSING_STALE_AFTER = timedelta(minutes=10)


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
            account_row = self.connect_accounts.ensure_row(studio_id)
            account_response = self.connect_accounts.response(account_row)
            add_check("Connect account refresh", False, f"Could not refresh Stripe Connect account: {exc}")

        if not account_failed:
            self._add_connect_account_checks(add_check, account_response)

        try:
            self.supabase.table("studio_payment_accounts").select("studio_id").eq("studio_id", studio_id).limit(1).execute()
            add_check("Supabase billing read", True, "Supabase billing tables are reachable.")
        except Exception as exc:
            add_check("Supabase billing read", False, f"Supabase billing tables are not reachable: {exc}")

        platform_webhooks = self.webhook_health(None)
        connect_webhooks = self.webhook_health(account_response.stripe_connected_account_id)
        self._add_webhook_checks(add_check, platform_webhooks, connect_webhooks)

        ready = all(check.status == "pass" for check in checks if check.name != "Recent Connect webhook")
        return BillingSystemStatusResponse(
            studio_id=studio_id,
            ready_for_live_payments=ready,
            checked_at=checked_at,
            payment_account=account_response,
            platform_webhooks=platform_webhooks,
            connect_webhooks=connect_webhooks,
            checks=checks,
        )

    def webhook_health(self, account_id: Optional[str]) -> BillingWebhookHealthResponse:
        try:
            query = (
                self.supabase.table("stripe_events")
                .select("type, processing_status, processed_at, created_at")
                .order("created_at", desc=True)
                .limit(50)
            )
            query = query.eq("stripe_account_id", account_id) if account_id else query.is_("stripe_account_id", "null")
            rows = query.execute().data or []
        except Exception:
            return BillingWebhookHealthResponse(
                stripe_account_id=account_id,
                failed_count=1,
                stale_processing_count=0,
            )

        latest_processed = next((row for row in rows if row.get("processing_status") == "processed"), None)
        return BillingWebhookHealthResponse(
            stripe_account_id=account_id,
            latest_processed_at=_to_text((latest_processed or {}).get("processed_at")),
            latest_event_type=(latest_processed or {}).get("type"),
            failed_count=sum(1 for row in rows if row.get("processing_status") == "failed"),
            stale_processing_count=sum(1 for row in rows if self.is_stale_webhook_processing(row)),
        )

    def _add_configuration_checks(self, add_check: Callable[..., None]) -> None:
        add_check(
            "Stripe API key",
            bool(getattr(self.settings, "STRIPE_SECRET_KEY", "")),
            "Stripe API key is configured." if getattr(self.settings, "STRIPE_SECRET_KEY", "") else "STRIPE_SECRET_KEY is missing.",
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
        add_check(
            "Platform webhook processing",
            platform_webhooks.failed_count == 0 and platform_webhooks.stale_processing_count == 0,
            "No failed or stale platform webhook events found." if platform_webhooks.failed_count == 0 and platform_webhooks.stale_processing_count == 0 else "Platform webhook failures or stale processing rows need review.",
        )
        add_check(
            "Connect webhook processing",
            connect_webhooks.failed_count == 0 and connect_webhooks.stale_processing_count == 0,
            "No failed or stale Connect webhook events found." if connect_webhooks.failed_count == 0 and connect_webhooks.stale_processing_count == 0 else "Connect webhook failures or stale processing rows need review.",
        )
        add_check(
            "Recent Connect webhook",
            bool(connect_webhooks.latest_processed_at),
            "A Connect webhook has processed for this account." if connect_webhooks.latest_processed_at else "No processed Connect webhook row is visible for this account yet.",
            warn=True,
        )

    @staticmethod
    def is_stale_webhook_processing(row: dict[str, Any]) -> bool:
        if row.get("processing_status") != "processing":
            return False
        created_at = row.get("created_at")
        if not created_at:
            return False
        if isinstance(created_at, datetime):
            created = created_at
        elif isinstance(created_at, str):
            try:
                created = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
            except ValueError:
                return False
        else:
            return False
        if created.tzinfo is None:
            created = created.replace(tzinfo=timezone.utc)
        return datetime.now(timezone.utc) - created >= BILLING_WEBHOOK_PROCESSING_STALE_AFTER
