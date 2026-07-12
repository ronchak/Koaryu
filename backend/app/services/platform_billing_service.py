from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Optional
from uuid import uuid4

from fastapi import HTTPException, status
from supabase import Client

from app.core.config import get_settings
from app.schemas.billing import (
    BillingLinkResponse,
    EmailUsageResponse,
    PlatformBillingStatusResponse,
)
from app.services.platform_billing_helpers import (
    INVOICE_PAYMENT_EVENT_METADATA_KEY,
    PENDING_CHECKOUT_METADATA_KEY,
    SUBSCRIPTION_EVENT_METADATA_KEY,
    build_core_checkout_idempotency_key,
    build_idempotency_key,
    merge_metadata,
    pending_checkout_metadata_update,
    pending_checkout_url,
    row_metadata,
    safe_redirect_url,
    status_response,
)
from app.services.platform_subscription_projection import PlatformSubscriptionProjector
from app.services.supabase_rpc import execute_required_rpc
from app.services.stripe_service import StripeService


logger = logging.getLogger(__name__)


EMAIL_INCLUDED_PER_MONTH = 500
EMAIL_OVERAGE_RATE_CENTS = 0.2
LIVE_STRIPE_SUBSCRIPTION_STATUSES = {"active", "trialing", "past_due", "unpaid", "paused"}
MISSING_STRIPE_CONFIGURATION_DETAIL = "Stripe is not configured for this environment."


class PlatformBillingService:
    def __init__(self, supabase: Client):
        self.supabase = supabase
        self.settings = get_settings()

    def _subscription_projector(self) -> PlatformSubscriptionProjector:
        return PlatformSubscriptionProjector()

    async def get_status(self, studio_id: str) -> PlatformBillingStatusResponse:
        return self.get_status_sync(studio_id)

    def get_status_sync(self, studio_id: str) -> PlatformBillingStatusResponse:
        row = self.get_access_status_row(studio_id)
        return status_response(row, self._email_usage(studio_id))

    def get_access_status_row(self, studio_id: str, *, strict_repairs: bool = False) -> dict[str, Any]:
        row = self._ensure_subscription_row(studio_id)
        row = self._repair_missing_subscription(row, strict_repairs=strict_repairs)
        row = self._repair_stale_subscription_state(row, strict_repairs=strict_repairs)
        return self._repair_subscription_periods(row, strict_repairs=strict_repairs)

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
        row = self._repair_missing_subscription(row)
        row = self._repair_subscription_periods(row)
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
            "success_url": safe_redirect_url(
                success_url,
                f"{frontend_url}/billing?koaryu_checkout=success",
                self.settings.FRONTEND_URL,
            ),
            "cancel_url": safe_redirect_url(
                cancel_url,
                f"{frontend_url}/billing?koaryu_checkout=cancelled",
                self.settings.FRONTEND_URL,
            ),
        }
        pending_url = pending_checkout_url(row)
        if pending_url:
            self._audit(studio_id, actor_id, "platform_billing.checkout_reused", studio_id, {"customer_id": customer_id})
            return BillingLinkResponse(url=pending_url)
        checkout_key = build_core_checkout_idempotency_key(
            studio_id,
            customer_id,
            checkout_urls,
            idempotency_key,
            self.settings.STRIPE_KOARYU_CORE_PRICE_ID,
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
            checkout_key = build_core_checkout_idempotency_key(
                studio_id,
                customer_id,
                checkout_urls,
                idempotency_key,
                self.settings.STRIPE_KOARYU_CORE_PRICE_ID,
            )
            session = stripe_service.create_core_checkout_session(
                customer_id=customer_id,
                studio_id=studio_id,
                idempotency_key=checkout_key,
                **checkout_urls,
            )
        session_url = session["url"] if isinstance(session, dict) else session.url
        session_id = session.get("id") if isinstance(session, dict) else getattr(session, "id", None)
        expires_at = session.get("expires_at") if isinstance(session, dict) else getattr(session, "expires_at", None)
        pending_update = pending_checkout_metadata_update(
            row,
            session_id=session_id,
            session_url=session_url,
            expires_at=expires_at,
        )
        if pending_update:
            self._update_subscription_row(row["studio_id"], pending_update)
        self._audit(studio_id, actor_id, "platform_billing.checkout_created", studio_id, {"customer_id": customer_id})
        return BillingLinkResponse(url=session_url)

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
        stripe_service = StripeService()
        try:
            session = stripe_service.create_customer_portal_session(
                customer_id=customer_id,
                return_url=safe_redirect_url(return_url, f"{frontend_url}/billing", self.settings.FRONTEND_URL),
            )
        except Exception as exc:
            if not self._is_missing_stripe_customer_error(exc):
                raise
            studio = self._get_studio(studio_id)
            self._create_platform_customer(stripe_service, studio_id, studio)
            self._update_subscription_row(
                studio_id,
                {
                    "stripe_subscription_id": None,
                    "status": "incomplete",
                    "metadata": merge_metadata(row, {PENDING_CHECKOUT_METADATA_KEY: None}),
                },
            )
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Koaryu Core billing customer was repaired. Start checkout again to restore this subscription.",
            ) from exc
        self._audit(studio_id, actor_id, "platform_billing.portal_created", studio_id, {"customer_id": customer_id})
        return BillingLinkResponse(url=session["url"] if isinstance(session, dict) else session.url)

    def project_subscription_event(self, event: dict[str, Any], *, hydrate_subscription: bool = True) -> None:
        event_type = event.get("type") or ""
        event_created = event.get("created")
        data_object = ((event.get("data") or {}).get("object") or {})

        if event_type == "checkout.session.completed":
            metadata = data_object.get("metadata") or {}
            studio_id = metadata.get("studio_id")
            if not studio_id:
                return
            row = self._ensure_subscription_row(studio_id)
            stale_for_subscription_state = self._is_stale_subscription_event(row, event_created)
            stale_for_payment_state = self._is_stale_invoice_payment_event(row, event_created)
            subscription_id = self._stripe_id(data_object.get("subscription"))
            update = {"metadata": merge_metadata(row, {PENDING_CHECKOUT_METADATA_KEY: None})}
            if not stale_for_payment_state:
                update["last_payment_status"] = data_object.get("payment_status")
                self._mark_invoice_payment_event_created(update, row, event_created)
            if not stale_for_subscription_state:
                update["stripe_customer_id"] = self._stripe_id(data_object.get("customer"))
                update["stripe_subscription_id"] = subscription_id
                update["comped"] = False
                if subscription_id and hydrate_subscription:
                    try:
                        subscription = StripeService().retrieve_subscription(subscription_id)
                        update.update(self._project_subscription(subscription))
                    except Exception as exc:
                        logger.error(
                            "Stripe checkout completion subscription hydration failed; "
                            "reference=%s; error_type=%s",
                            uuid4().hex,
                            type(exc).__name__,
                        )
                        update["status"] = "incomplete"
                else:
                    update["status"] = "incomplete"
                self._mark_subscription_event_created(update, row, event_created)
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
            row = self._ensure_subscription_row(studio_id)
            if self._is_stale_subscription_event(row, event_created):
                return
            update = self._project_subscription(data_object)
            self._mark_subscription_event_created(update, row, event_created)
            self._update_subscription_row(studio_id, update)
            return

        if event_type in {"invoice.paid", "invoice.payment_failed"}:
            row = self._find_subscription_by_stripe_id(data_object.get("subscription"), data_object.get("customer"))
            if not row:
                return
            if self._is_stale_invoice_payment_event(row, event_created):
                return
            status_value = "paid" if event_type == "invoice.paid" else "failed"
            update = {"last_payment_status": status_value}
            self._mark_invoice_payment_event_created(update, row, event_created)
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
            idempotency_key=build_idempotency_key("core-customer", studio_id),
        )
        customer_id = customer["id"] if isinstance(customer, dict) else customer.id
        self._update_subscription_row(
            studio_id,
            {"stripe_customer_id": customer_id, "comped": False, "status": "incomplete"},
        )
        return customer_id

    @staticmethod
    def _is_missing_stripe_customer_error(exc: Exception) -> bool:
        if not exc.__class__.__module__.startswith("stripe"):
            return False
        message = str(exc).lower()
        return "no such customer" in message

    @staticmethod
    def is_noncritical_access_repair_error(exc: Exception) -> bool:
        return (
            isinstance(exc, HTTPException)
            and exc.status_code == status.HTTP_409_CONFLICT
            and exc.detail == MISSING_STRIPE_CONFIGURATION_DETAIL
        )

    def _can_degrade_access_repair(self, exc: Exception) -> bool:
        environment = getattr(self.settings, "ENVIRONMENT", "development")
        return self.is_noncritical_access_repair_error(exc) and environment.strip().lower() == "development"

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

    def _is_stale_subscription_event(self, row: dict[str, Any], event_created: Optional[int]) -> bool:
        if event_created is None:
            return False
        last_created = row_metadata(row).get(SUBSCRIPTION_EVENT_METADATA_KEY)
        if last_created is None:
            last_created = row.get("last_stripe_event_created")
        return last_created is not None and int(last_created) > int(event_created)

    def _is_stale_invoice_payment_event(self, row: dict[str, Any], event_created: Optional[int]) -> bool:
        if event_created is None:
            return False
        last_created = row_metadata(row).get(INVOICE_PAYMENT_EVENT_METADATA_KEY)
        return last_created is not None and int(last_created) > int(event_created)

    @staticmethod
    def _merge_update_metadata(update: dict[str, Any], row: dict[str, Any], patch: dict[str, Any]) -> None:
        update["metadata"] = merge_metadata({"metadata": update.get("metadata", row.get("metadata"))}, patch)

    def _mark_subscription_event_created(
        self,
        update: dict[str, Any],
        row: dict[str, Any],
        event_created: Optional[int],
    ) -> None:
        if event_created is None:
            return
        event_created_int = int(event_created)
        previous = row_metadata(row).get(SUBSCRIPTION_EVENT_METADATA_KEY)
        if previous is None:
            previous = row.get("last_stripe_event_created")
        if previous is not None and int(previous) > event_created_int:
            return
        update["last_stripe_event_created"] = event_created_int
        self._merge_update_metadata(update, row, {SUBSCRIPTION_EVENT_METADATA_KEY: event_created_int})

    def _mark_invoice_payment_event_created(
        self,
        update: dict[str, Any],
        row: dict[str, Any],
        event_created: Optional[int],
    ) -> None:
        if event_created is None:
            return
        event_created_int = int(event_created)
        previous = row_metadata(row).get(INVOICE_PAYMENT_EVENT_METADATA_KEY)
        if previous is not None and int(previous) > event_created_int:
            return
        self._merge_update_metadata(update, row, {INVOICE_PAYMENT_EVENT_METADATA_KEY: event_created_int})

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

    def _repair_subscription_periods(self, row: dict[str, Any], *, strict_repairs: bool = False) -> dict[str, Any]:
        if not self._should_repair_subscription_periods(row):
            return row
        subscription_id = row.get("stripe_subscription_id")
        try:
            subscription = StripeService().retrieve_subscription(subscription_id)
            return self._update_subscription_row(row["studio_id"], self._project_subscription(subscription))
        except Exception as exc:
            if strict_repairs and not self._can_degrade_access_repair(exc):
                raise
            return row

    def _repair_stale_subscription_state(self, row: dict[str, Any], *, strict_repairs: bool = False) -> dict[str, Any]:
        if not self._should_repair_subscription_state(row):
            return row
        try:
            subscription = StripeService().retrieve_subscription(row["stripe_subscription_id"])
            return self._update_subscription_row(row["studio_id"], self._project_subscription(subscription))
        except Exception as exc:
            if strict_repairs and not self._can_degrade_access_repair(exc):
                raise
            return row

    def _repair_missing_subscription(self, row: dict[str, Any], *, strict_repairs: bool = False) -> dict[str, Any]:
        if row.get("stripe_subscription_id"):
            return row
        if not row.get("stripe_customer_id") or bool(row.get("comped", True)):
            return row

        try:
            subscriptions = StripeService().list_customer_subscriptions(row["stripe_customer_id"])
        except Exception as exc:
            if strict_repairs and not self._can_degrade_access_repair(exc):
                raise
            return row

        subscription = self._select_core_subscription(subscriptions, row["studio_id"])
        if not subscription:
            return row

        update = self._project_subscription(subscription)
        return self._update_subscription_row(row["studio_id"], update)

    def _select_core_subscription(self, subscriptions: Any, studio_id: str) -> Optional[Any]:
        return self._subscription_projector().select_core_subscription(
            subscriptions,
            studio_id,
            LIVE_STRIPE_SUBSCRIPTION_STATUSES,
        )

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

    def _should_repair_subscription_state(self, row: dict[str, Any]) -> bool:
        if not row.get("stripe_subscription_id") or bool(row.get("comped", False)):
            return False
        status_value = row.get("status") or "incomplete"
        if status_value not in LIVE_STRIPE_SUBSCRIPTION_STATUSES:
            return True
        if status_value == "trialing":
            trial_end = self._timestamp_epoch(row.get("trial_end"))
            return trial_end is not None and trial_end <= datetime.now(timezone.utc).timestamp()
        return False

    def _project_subscription(self, subscription: Any) -> dict[str, Any]:
        return self._subscription_projector().project_subscription(subscription)

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
        result = execute_required_rpc(self.supabase, "sum_email_usage_for_period", {
            "p_studio_id": studio_id,
            "p_period_start": period_start.isoformat(),
            "p_period_end": period_end.isoformat(),
        })
        sent = self._email_usage_rpc_value(getattr(result, "data", 0))
        overage_count = max(0, sent - EMAIL_INCLUDED_PER_MONTH)
        return EmailUsageResponse(
            included=EMAIL_INCLUDED_PER_MONTH,
            sent=sent,
            overage_count=overage_count,
            estimated_overage_cents=int(round(overage_count * EMAIL_OVERAGE_RATE_CENTS)),
            period_start=period_start.isoformat(),
            period_end=period_end.isoformat(),
        )

    @staticmethod
    def _email_usage_rpc_value(value: Any) -> int:
        if isinstance(value, list):
            value = value[0] if value else 0
        if isinstance(value, dict):
            value = next(iter(value.values()), 0)
        return int(value or 0)

    @staticmethod
    def _timestamp_epoch(value: Any) -> Optional[float]:
        return PlatformSubscriptionProjector.timestamp_epoch(value)

    @classmethod
    def _stripe_id(cls, value: Any) -> Optional[str]:
        return PlatformSubscriptionProjector.stripe_id(value)

    def _audit(self, studio_id: str, actor_id: str, action: str, entity_id: str, metadata: dict[str, Any]) -> None:
        self.supabase.table("audit_logs").insert({
            "studio_id": studio_id,
            "actor_id": actor_id,
            "action": action,
            "entity_type": "billing",
            "entity_id": entity_id,
            "metadata": metadata,
        }).execute()
