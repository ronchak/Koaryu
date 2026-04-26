from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional

from postgrest.exceptions import APIError as PostgrestAPIError
from supabase import Client

from app.core.config import get_settings
from app.schemas.billing import WebhookProcessResponse
from app.services.billing_service import BillingService
from app.services.platform_billing_service import PlatformBillingService
from app.services.stripe_service import StripeService


class StripeWebhookService:
    def __init__(self, supabase: Client):
        self.supabase = supabase
        self.settings = get_settings()

    async def handle_platform_webhook(self, payload: bytes, signature: Optional[str]) -> WebhookProcessResponse:
        event = StripeService().construct_webhook_event(
            payload=payload,
            signature=signature,
            secret=self.settings.STRIPE_PLATFORM_WEBHOOK_SECRET,
        )
        return self._store_and_process(event, stripe_account_id=None, processor="platform")

    async def handle_connect_webhook(self, payload: bytes, signature: Optional[str]) -> WebhookProcessResponse:
        event = StripeService().construct_webhook_event(
            payload=payload,
            signature=signature,
            secret=self.settings.STRIPE_CONNECT_WEBHOOK_SECRET,
        )
        account_id = self._event_get(event, "account")
        return self._store_and_process(event, stripe_account_id=account_id, processor="connect")

    def _store_and_process(
        self,
        event: Any,
        *,
        stripe_account_id: Optional[str],
        processor: str,
    ) -> WebhookProcessResponse:
        event_dict = self._event_to_dict(event)
        event_id = event_dict.get("id")
        event_type = event_dict.get("type") or "unknown"
        livemode = bool(event_dict.get("livemode"))
        if not event_id:
            return WebhookProcessResponse(status="ignored")

        existing_query = (
            self.supabase.table("stripe_events")
            .select("id, processing_status")
            .eq("stripe_event_id", event_id)
            .limit(1)
        )
        existing_query = (
            existing_query.eq("stripe_account_id", stripe_account_id)
            if stripe_account_id
            else existing_query.is_("stripe_account_id", "null")
        )
        existing = existing_query.execute()
        if existing.data and existing.data[0].get("processing_status") == "processed":
            return WebhookProcessResponse(status="already_processed")
        if existing.data and existing.data[0].get("processing_status") == "processing":
            return WebhookProcessResponse(status="already_processing")

        row_id = existing.data[0]["id"] if existing.data else None
        inserted_new_event = False
        if not row_id:
            try:
                result = self.supabase.table("stripe_events").insert({
                    "stripe_event_id": event_id,
                    "stripe_account_id": stripe_account_id,
                    "livemode": livemode,
                    "type": event_type,
                    "payload": event_dict,
                    "processing_status": "processing",
                }).execute()
            except PostgrestAPIError as exc:
                if exc.code != "23505":
                    raise
                duplicate_query = (
                    self.supabase.table("stripe_events")
                    .select("id, processing_status")
                    .eq("stripe_event_id", event_id)
                    .limit(1)
                )
                duplicate_query = (
                    duplicate_query.eq("stripe_account_id", stripe_account_id)
                    if stripe_account_id
                    else duplicate_query.is_("stripe_account_id", "null")
                )
                duplicate = duplicate_query.execute()
                if duplicate.data and duplicate.data[0].get("processing_status") == "processed":
                    return WebhookProcessResponse(status="already_processed")
                if duplicate.data and duplicate.data[0].get("processing_status") == "processing":
                    return WebhookProcessResponse(status="already_processing")
                row_id = duplicate.data[0]["id"] if duplicate.data else None
            else:
                row_id = result.data[0]["id"] if result.data else None
                inserted_new_event = True

        if row_id and not inserted_new_event:
            claim = (
                self.supabase.table("stripe_events")
                .update({"processing_status": "processing", "error": None})
                .eq("id", row_id)
                .in_("processing_status", ["pending", "failed"])
                .execute()
            )
            if not claim.data:
                return WebhookProcessResponse(status="already_processing")
        if not row_id:
            return WebhookProcessResponse(status="ignored")

        try:
            if processor == "platform":
                PlatformBillingService(self.supabase).project_subscription_event(event_dict)
            else:
                BillingService(self.supabase).project_connect_event(event_dict)
            self._update_event(row_id, {"processing_status": "processed", "processed_at": datetime.now(timezone.utc).isoformat()})
            return WebhookProcessResponse(status="processed")
        except Exception as exc:
            self._update_event(row_id, {"processing_status": "failed", "error": str(exc)})
            raise

    def _update_event(self, row_id: Optional[str], update: dict[str, Any]) -> None:
        if not row_id:
            return
        self.supabase.table("stripe_events").update(update).eq("id", row_id).execute()

    @staticmethod
    def _event_get(event: Any, key: str) -> Any:
        if isinstance(event, dict):
            return event.get(key)
        return getattr(event, key, None)

    @staticmethod
    def _event_to_dict(event: Any) -> dict[str, Any]:
        if isinstance(event, dict):
            return event
        if hasattr(event, "to_dict_recursive"):
            return event.to_dict_recursive()
        if hasattr(event, "to_dict"):
            return event.to_dict()
        return dict(event)
