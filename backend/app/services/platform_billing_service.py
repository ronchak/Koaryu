from __future__ import annotations

import hashlib
import json
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
LIVE_STRIPE_SUBSCRIPTION_STATUSES = {"active", "trialing", "past_due", "unpaid", "paused"}
MISSING = object()


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
        row = self._repair_subscription_periods(row)
        return self._status_response(row, self._email_usage(studio_id))

    async def get_email_usage(self, studio_id: str) -> EmailUsageResponse:
        return self._email_usage(studio_id)

    async def create_checkout_link(
        self,
        studio_id: str,
        actor_id: str,
        success_url: Optional[str] = None,
        cancel_url: Optional[str] = None,
        idempotency_key: Optional[str] = None,
    ) -> BillingLinkResponse:
        row = self._ensure_subscription_row(studio_id)
        if row.get("stripe_subscription_id") and (row.get("status") or "") in LIVE_STRIPE_SUBSCRIPTION_STATUSES:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Koaryu Core billing is already active. Open the billing portal to manage this subscription.",
            )
        studio = self._get_studio(studio_id)
        customer_id = row.get("stripe_customer_id")
        stripe_service = StripeService()

        if not customer_id:
            customer_id = self._create_platform_customer(stripe_service, studio_id, studio)

        frontend_url = self.settings.FRONTEND_URL.rstrip("/")
        checkout_urls = {
            "success_url": success_url or f"{frontend_url}/billing?koaryu_checkout=success",
            "cancel_url": cancel_url or f"{frontend_url}/billing?koaryu_checkout=cancelled",
        }
        checkout_key = self._core_checkout_idempotency_key(
            studio_id,
            customer_id,
            checkout_urls,
            idempotency_key,
        )
        try:
            session = stripe_service.create_core_checkout_session(
                customer_id=customer_id,
                studio_id=studio_id,
                idempotency_key=checkout_key,
                **checkout_urls,
            )
        except Exception as exc:
            if not self._is_missing_stripe_customer_error(exc):
                raise
            customer_id = self._create_platform_customer(stripe_service, studio_id, studio)
            checkout_key = self._core_checkout_idempotency_key(
                studio_id,
                customer_id,
                checkout_urls,
                idempotency_key,
            )
            session = stripe_service.create_core_checkout_session(
                customer_id=customer_id,
                studio_id=studio_id,
                idempotency_key=checkout_key,
                **checkout_urls,
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
        event_created = event.get("created")
        data_object = ((event.get("data") or {}).get("object") or {})

        if event_type == "checkout.session.completed":
            metadata = data_object.get("metadata") or {}
            studio_id = metadata.get("studio_id")
            if not studio_id:
                return
            row = self._ensure_subscription_row(studio_id)
            if self._is_stale_stripe_event(row, event_created):
                return
            subscription_id = self._stripe_id(data_object.get("subscription"))
            update = {
                "stripe_customer_id": self._stripe_id(data_object.get("customer")),
                "stripe_subscription_id": subscription_id,
                "status": "trialing",
                "comped": False,
                "last_payment_status": data_object.get("payment_status"),
            }
            self._mark_event_created(update, event_created)
            self._update_subscription_row(studio_id, {k: v for k, v in update.items() if v is not None})
            if subscription_id:
                try:
                    subscription = StripeService().retrieve_subscription(subscription_id)
                    projection = self._project_subscription(subscription)
                    self._mark_event_created(projection, event_created)
                    self._update_subscription_row(studio_id, projection)
                except Exception:
                    pass
            return

        if event_type.startswith("customer.subscription."):
            metadata = data_object.get("metadata") or {}
            studio_id = metadata.get("studio_id")
            if not studio_id:
                row = self._find_subscription_by_stripe_id(data_object.get("id"), data_object.get("customer"))
                studio_id = row.get("studio_id") if row else None
            if not studio_id:
                return
            row = self._ensure_subscription_row(studio_id)
            if self._is_stale_stripe_event(row, event_created):
                return
            update = self._project_subscription(data_object)
            self._mark_event_created(update, event_created)
            self._update_subscription_row(studio_id, update)
            return

        if event_type in {"invoice.paid", "invoice.payment_failed"}:
            row = self._find_subscription_by_stripe_id(data_object.get("subscription"), data_object.get("customer"))
            if not row:
                return
            if self._is_stale_stripe_event(row, event_created):
                return
            status_value = "paid" if event_type == "invoice.paid" else "failed"
            update = {"last_payment_status": status_value}
            self._mark_event_created(update, event_created)
            self._update_subscription_row(row["studio_id"], update)

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
            .insert({"studio_id": studio_id, "status": "incomplete", "comped": False})
            .execute()
        )
        if not insert_result.data:
            raise HTTPException(status_code=500, detail="Failed to initialize Koaryu Core billing.")
        return insert_result.data[0]

    def _create_platform_customer(self, stripe_service: StripeService, studio_id: str, studio: dict[str, Any]) -> str:
        customer = stripe_service.create_customer(
            name=studio.get("name") or "Koaryu studio",
            metadata={"studio_id": studio_id, "product": "koaryu_core"},
            idempotency_key=self._idempotency_key("core-customer", studio_id),
        )
        customer_id = customer["id"] if isinstance(customer, dict) else customer.id
        self._update_subscription_row(
            studio_id,
            {"stripe_customer_id": customer_id, "comped": False, "status": "incomplete"},
        )
        return customer_id

    def _core_checkout_idempotency_key(
        self,
        studio_id: str,
        customer_id: str,
        checkout_urls: dict[str, str],
        request_key: Optional[str],
    ) -> str:
        normalized = self._normalize_idempotency_key(request_key)
        if normalized:
            return self._idempotency_key("core-checkout", studio_id, normalized)
        request_hash = self._stable_hash({
            "customer_id": customer_id,
            "price_id": self.settings.STRIPE_KOARYU_CORE_PRICE_ID,
            "success_url": checkout_urls["success_url"],
            "cancel_url": checkout_urls["cancel_url"],
        })
        return self._idempotency_key("core-checkout", studio_id, request_hash)

    def _normalize_idempotency_key(self, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        normalized = value.strip()
        if not normalized:
            return None
        if len(normalized) > 255:
            raise HTTPException(status_code=400, detail="Idempotency-Key must be 255 characters or fewer.")
        return normalized

    @staticmethod
    def _stable_hash(payload: dict[str, Any]) -> str:
        canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(canonical.encode("utf-8")).hexdigest()

    def _idempotency_key(self, *parts: str) -> str:
        return "koaryu:" + ":".join(str(part).replace(":", "_") for part in parts if part is not None)

    @staticmethod
    def _is_missing_stripe_customer_error(exc: Exception) -> bool:
        if not exc.__class__.__module__.startswith("stripe"):
            return False
        message = str(exc).lower()
        return "no such customer" in message

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

    @staticmethod
    def _is_stale_stripe_event(row: dict[str, Any], event_created: Optional[int]) -> bool:
        if event_created is None:
            return False
        last_created = row.get("last_stripe_event_created")
        return last_created is not None and int(last_created) > int(event_created)

    @staticmethod
    def _mark_event_created(update: dict[str, Any], event_created: Optional[int]) -> None:
        if event_created is not None:
            update["last_stripe_event_created"] = event_created

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

    def _repair_subscription_periods(self, row: dict[str, Any]) -> dict[str, Any]:
        if not self._should_repair_subscription_periods(row):
            return row
        subscription_id = row.get("stripe_subscription_id")
        try:
            subscription = StripeService().retrieve_subscription(subscription_id)
            return self._update_subscription_row(row["studio_id"], self._project_subscription(subscription))
        except Exception:
            return row

    def _should_repair_subscription_periods(self, row: dict[str, Any]) -> bool:
        if not row.get("stripe_subscription_id"):
            return False
        if (row.get("status") or "") not in LIVE_STRIPE_SUBSCRIPTION_STATUSES:
            return False
        if (row.get("status") or "") == "trialing" and not row.get("trial_end"):
            return True
        current_period_start = row.get("current_period_start")
        current_period_end = row.get("current_period_end")
        if not current_period_start or not current_period_end:
            return True
        start_epoch = self._timestamp_epoch(current_period_start)
        end_epoch = self._timestamp_epoch(current_period_end)
        return start_epoch is not None and end_epoch is not None and start_epoch > end_epoch

    def _project_subscription(self, subscription: Any) -> dict[str, Any]:
        update: dict[str, Any] = {"comped": False}

        if self._object_has(subscription, "customer"):
            update["stripe_customer_id"] = self._stripe_id(self._object_get(subscription, "customer"))
        if self._object_has(subscription, "id"):
            update["stripe_subscription_id"] = self._stripe_id(self._object_get(subscription, "id"))
        if self._object_has(subscription, "status"):
            update["status"] = self._object_get(subscription, "status") or "incomplete"
        if self._object_has(subscription, "trial_start"):
            update["trial_start"] = self._timestamp(self._object_get(subscription, "trial_start"))
        if self._object_has(subscription, "trial_end"):
            update["trial_end"] = self._timestamp(self._object_get(subscription, "trial_end"))
        if self._object_has(subscription, "cancel_at_period_end"):
            update["cancel_at_period_end"] = bool(self._object_get(subscription, "cancel_at_period_end"))

        current_period_start = self._subscription_period(subscription, "current_period_start", min)
        if current_period_start is not MISSING:
            update["current_period_start"] = current_period_start

        current_period_end = self._subscription_period(subscription, "current_period_end", max)
        if current_period_end is not MISSING:
            update["current_period_end"] = current_period_end

        return update

    def _subscription_period(self, subscription: Any, key: str, pick: Any) -> Any:
        if self._object_has(subscription, key):
            return self._timestamp(self._object_get(subscription, key))

        item_values = [
            value
            for item in self._subscription_items(subscription)
            if (value := self._object_get(item, key)) is not None
        ]
        if not item_values:
            return MISSING
        return self._timestamp(pick(item_values, key=self._timestamp_sort_key))

    def _subscription_items(self, subscription: Any) -> list[Any]:
        items = self._object_get(subscription, "items") or {}
        if isinstance(items, list):
            return items
        data = self._object_get(items, "data") or []
        return data if isinstance(data, list) else []

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

    @staticmethod
    def _timestamp_epoch(value: Any) -> Optional[float]:
        if not value:
            return None
        if isinstance(value, datetime):
            timestamp = value if value.tzinfo else value.replace(tzinfo=timezone.utc)
            return timestamp.timestamp()
        if isinstance(value, (int, float)):
            return float(value)
        if isinstance(value, str):
            try:
                timestamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
                if timestamp.tzinfo is None:
                    timestamp = timestamp.replace(tzinfo=timezone.utc)
                return timestamp.timestamp()
            except ValueError:
                return None
        return None

    @classmethod
    def _timestamp_sort_key(cls, value: Any) -> tuple:
        epoch = cls._timestamp_epoch(value)
        if epoch is not None:
            return (0, epoch)
        return (1, str(value))

    @classmethod
    def _stripe_id(cls, value: Any) -> Optional[str]:
        if value is None:
            return None
        if isinstance(value, str):
            return value
        stripe_id = cls._object_get(value, "id")
        return str(stripe_id) if stripe_id else None

    @staticmethod
    def _object_get(value: Any, key: str, default: Any = None) -> Any:
        if value is None:
            return default
        if isinstance(value, dict):
            return value.get(key, default)
        return getattr(value, key, default)

    @staticmethod
    def _object_has(value: Any, key: str) -> bool:
        if value is None:
            return False
        if isinstance(value, dict):
            return key in value
        return hasattr(value, key)

    def _audit(self, studio_id: str, actor_id: str, action: str, entity_id: str, metadata: dict[str, Any]) -> None:
        self.supabase.table("audit_logs").insert({
            "studio_id": studio_id,
            "actor_id": actor_id,
            "action": action,
            "entity_type": "billing",
            "entity_id": entity_id,
            "metadata": metadata,
        }).execute()
