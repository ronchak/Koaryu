from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import HTTPException, status
from supabase import Client

from app.core.config import get_settings
from app.schemas.billing import (
    BillingLinkResponse,
    EmailUsageResponse,
    PlatformBillingStatusResponse,
)
from app.services.stripe_service import StripeService


EMAIL_INCLUDED_PER_MONTH = 500
EMAIL_OVERAGE_RATE_CENTS = 0.2


def _to_text(value: Any) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.isoformat()
    return str(value)


class PlatformBillingService:
    def __init__(self, supabase: Client):
        self.supabase = supabase
        self.settings = get_settings()

    async def get_status(self, studio_id: str) -> PlatformBillingStatusResponse:
        row = self._ensure_subscription_row(studio_id)
        return self._status_response(row, self._email_usage(studio_id))

    async def get_email_usage(self, studio_id: str) -> EmailUsageResponse:
        return self._email_usage(studio_id)

    async def create_checkout_link(
        self,
        studio_id: str,
        actor_id: str,
        success_url: Optional[str] = None,
        cancel_url: Optional[str] = None,
    ) -> BillingLinkResponse:
        row = self._ensure_subscription_row(studio_id)
        studio = self._get_studio(studio_id)
        customer_id = row.get("stripe_customer_id")
        stripe_service = StripeService()

        if not customer_id:
            customer = stripe_service.create_customer(
                name=studio.get("name") or "Koaryu studio",
                metadata={"studio_id": studio_id, "product": "koaryu_core"},
            )
            customer_id = customer["id"] if isinstance(customer, dict) else customer.id
            row = self._update_subscription_row(
                studio_id,
                {"stripe_customer_id": customer_id, "comped": False, "status": "trialing"},
            )

        frontend_url = self.settings.FRONTEND_URL.rstrip("/")
        session = stripe_service.create_core_checkout_session(
            customer_id=customer_id,
            studio_id=studio_id,
            success_url=success_url or f"{frontend_url}/billing?koaryu_checkout=success",
            cancel_url=cancel_url or f"{frontend_url}/billing?koaryu_checkout=cancelled",
        )
        self._audit(studio_id, actor_id, "platform_billing.checkout_created", studio_id, {"customer_id": customer_id})
        return BillingLinkResponse(url=session["url"] if isinstance(session, dict) else session.url)

    async def create_portal_link(
        self,
        studio_id: str,
        actor_id: str,
        return_url: Optional[str] = None,
    ) -> BillingLinkResponse:
        row = self._ensure_subscription_row(studio_id)
        customer_id = row.get("stripe_customer_id")
        if not customer_id:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Add a Koaryu Core payment method before opening the billing portal.",
            )
        frontend_url = self.settings.FRONTEND_URL.rstrip("/")
        session = StripeService().create_customer_portal_session(
            customer_id=customer_id,
            return_url=return_url or f"{frontend_url}/billing",
        )
        self._audit(studio_id, actor_id, "platform_billing.portal_created", studio_id, {"customer_id": customer_id})
        return BillingLinkResponse(url=session["url"] if isinstance(session, dict) else session.url)

    def project_subscription_event(self, event: dict[str, Any]) -> None:
        event_type = event.get("type") or ""
        data_object = ((event.get("data") or {}).get("object") or {})

        if event_type == "checkout.session.completed":
            metadata = data_object.get("metadata") or {}
            studio_id = metadata.get("studio_id")
            if not studio_id:
                return
            update = {
                "stripe_customer_id": data_object.get("customer"),
                "stripe_subscription_id": data_object.get("subscription"),
                "status": "trialing",
                "comped": False,
                "last_payment_status": data_object.get("payment_status"),
            }
            self._update_subscription_row(studio_id, {k: v for k, v in update.items() if v is not None})
            return

        if event_type.startswith("customer.subscription."):
            metadata = data_object.get("metadata") or {}
            studio_id = metadata.get("studio_id")
            if not studio_id:
                row = self._find_subscription_by_stripe_id(data_object.get("id"), data_object.get("customer"))
                studio_id = row.get("studio_id") if row else None
            if not studio_id:
                return
            update = {
                "stripe_customer_id": data_object.get("customer"),
                "stripe_subscription_id": data_object.get("id"),
                "status": data_object.get("status") or "incomplete",
                "trial_start": self._timestamp(data_object.get("trial_start")),
                "trial_end": self._timestamp(data_object.get("trial_end")),
                "current_period_start": self._timestamp(data_object.get("current_period_start")),
                "current_period_end": self._timestamp(data_object.get("current_period_end")),
                "cancel_at_period_end": bool(data_object.get("cancel_at_period_end")),
                "comped": False,
            }
            self._update_subscription_row(studio_id, {k: v for k, v in update.items() if v is not None})
            return

        if event_type in {"invoice.paid", "invoice.payment_failed"}:
            row = self._find_subscription_by_stripe_id(data_object.get("subscription"), data_object.get("customer"))
            if not row:
                return
            status_value = "paid" if event_type == "invoice.paid" else "failed"
            self._update_subscription_row(row["studio_id"], {"last_payment_status": status_value})

    def _ensure_subscription_row(self, studio_id: str) -> dict[str, Any]:
        result = (
            self.supabase.table("studio_subscriptions")
            .select("*")
            .eq("studio_id", studio_id)
            .maybe_single()
            .execute()
        )
        if result.data:
            return result.data
        insert_result = (
            self.supabase.table("studio_subscriptions")
            .insert({"studio_id": studio_id, "status": "comped", "comped": True})
            .execute()
        )
        if not insert_result.data:
            raise HTTPException(status_code=500, detail="Failed to initialize Koaryu Core billing.")
        return insert_result.data[0]

    def _update_subscription_row(self, studio_id: str, update: dict[str, Any]) -> dict[str, Any]:
        result = (
            self.supabase.table("studio_subscriptions")
            .update(update)
            .eq("studio_id", studio_id)
            .execute()
        )
        if not result.data:
            raise HTTPException(status_code=404, detail="Koaryu Core billing record not found.")
        return result.data[0]

    def _find_subscription_by_stripe_id(self, subscription_id: Optional[str], customer_id: Optional[str]) -> Optional[dict[str, Any]]:
        query = self.supabase.table("studio_subscriptions").select("*")
        if subscription_id:
            result = query.eq("stripe_subscription_id", subscription_id).limit(1).execute()
            if result.data:
                return result.data[0]
        if customer_id:
            result = self.supabase.table("studio_subscriptions").select("*").eq("stripe_customer_id", customer_id).limit(1).execute()
            if result.data:
                return result.data[0]
        return None

    def _get_studio(self, studio_id: str) -> dict[str, Any]:
        result = self.supabase.table("studios").select("id, name").eq("id", studio_id).single().execute()
        if not result.data:
            raise HTTPException(status_code=404, detail="Studio not found.")
        return result.data

    def _email_usage(self, studio_id: str) -> EmailUsageResponse:
        now = datetime.now(timezone.utc)
        period_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        if period_start.month == 12:
            period_end = period_start.replace(year=period_start.year + 1, month=1)
        else:
            period_end = period_start.replace(month=period_start.month + 1)
        result = (
            self.supabase.table("email_usage_events")
            .select("quantity")
            .eq("studio_id", studio_id)
            .gte("sent_at", period_start.isoformat())
            .lt("sent_at", period_end.isoformat())
            .execute()
        )
        sent = sum(int(row.get("quantity") or 0) for row in (result.data or []))
        overage_count = max(0, sent - EMAIL_INCLUDED_PER_MONTH)
        return EmailUsageResponse(
            included=EMAIL_INCLUDED_PER_MONTH,
            sent=sent,
            overage_count=overage_count,
            estimated_overage_cents=int(round(overage_count * EMAIL_OVERAGE_RATE_CENTS)),
            period_start=period_start.isoformat(),
            period_end=period_end.isoformat(),
        )

    def _status_response(self, row: dict[str, Any], email_usage: EmailUsageResponse) -> PlatformBillingStatusResponse:
        return PlatformBillingStatusResponse(
            studio_id=row["studio_id"],
            plan_name=row.get("plan_name") or "Koaryu Core",
            monthly_price_cents=row.get("monthly_price_cents") or 2700,
            currency=row.get("currency") or "usd",
            status=row.get("status") or "comped",
            comped=bool(row.get("comped", True)),
            trial_start=_to_text(row.get("trial_start")),
            trial_end=_to_text(row.get("trial_end")),
            current_period_start=_to_text(row.get("current_period_start")),
            current_period_end=_to_text(row.get("current_period_end")),
            cancel_at_period_end=bool(row.get("cancel_at_period_end")),
            last_payment_status=row.get("last_payment_status"),
            stripe_customer_id=row.get("stripe_customer_id"),
            stripe_subscription_id=row.get("stripe_subscription_id"),
            email_usage=email_usage,
        )

    @staticmethod
    def _timestamp(value: Any) -> Optional[str]:
        if not value:
            return None
        if isinstance(value, (int, float)):
            return datetime.fromtimestamp(value, tz=timezone.utc).isoformat()
        return str(value)

    def _audit(self, studio_id: str, actor_id: str, action: str, entity_id: str, metadata: dict[str, Any]) -> None:
        self.supabase.table("audit_logs").insert({
            "studio_id": studio_id,
            "actor_id": actor_id,
            "action": action,
            "entity_type": "billing",
            "entity_id": entity_id,
            "metadata": metadata,
        }).execute()
