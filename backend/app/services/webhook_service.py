from __future__ import annotations

import uuid
from datetime import timedelta
from typing import Any, Optional

from supabase import Client

from app.core.config import get_settings
from app.schemas.billing import WebhookProcessResponse
from app.services.billing_service import BillingService
from app.services.platform_billing_service import PlatformBillingService
from app.services.stripe_service import StripeService
from app.services.supabase_rpc import execute_required_rpc, first_rpc_row


WEBHOOK_PROCESSING_STALE_AFTER = timedelta(minutes=10)


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
        account_id = self._connect_account_id_for_event(event)
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

        claim_token = uuid.uuid4().hex
        claim_status, claimed_event = self._claim_event_for_processing(
            event_id=event_id,
            stripe_account_id=stripe_account_id,
            livemode=livemode,
            event_type=event_type,
            payload=event_dict,
            claim_token=claim_token,
        )
        if claim_status == "already_processed":
            return WebhookProcessResponse(status="already_processed")
        if claim_status == "already_processing":
            return WebhookProcessResponse(status="already_processing")
        if claim_status != "claimed" or not claimed_event:
            return WebhookProcessResponse(status="ignored")

        row_id = claimed_event.get("id")
        if not row_id:
            return WebhookProcessResponse(status="ignored")

        try:
            if processor == "platform":
                PlatformBillingService(self.supabase).project_subscription_event(event_dict, hydrate_subscription=False)
            else:
                BillingService(self.supabase).project_connect_event(event_dict)
            if not self._finish_event_processing(row_id, claim_token, "processed"):
                raise RuntimeError("Webhook processing lease was lost before the event could be marked processed.")
            return WebhookProcessResponse(status="processed")
        except Exception as exc:
            self._finish_event_processing(row_id, claim_token, "failed", error=str(exc))
            raise

    def _claim_event_for_processing(
        self,
        *,
        event_id: str,
        stripe_account_id: Optional[str],
        livemode: bool,
        event_type: str,
        payload: dict[str, Any],
        claim_token: str,
    ) -> tuple[str, Optional[dict[str, Any]]]:
        result = execute_required_rpc(self.supabase, "claim_stripe_event_for_processing", {
            "p_stripe_event_id": event_id,
            "p_stripe_account_id": stripe_account_id,
            "p_livemode": livemode,
            "p_type": event_type,
            "p_payload": payload,
            "p_processing_token": claim_token,
            "p_stale_after_seconds": int(WEBHOOK_PROCESSING_STALE_AFTER.total_seconds()),
        })
        row = first_rpc_row(result) or {}
        return str(row.get("claim_status") or "ignored"), row.get("event_row")

    def _finish_event_processing(
        self,
        row_id: str,
        processing_token: str,
        status: str,
        *,
        error: Optional[str] = None,
    ) -> bool:
        result = execute_required_rpc(self.supabase, "finish_stripe_event_processing", {
            "p_event_id": row_id,
            "p_processing_token": processing_token,
            "p_status": status,
            "p_error": error,
        })
        row = first_rpc_row(result) or {}
        return bool(row.get("updated"))

    @staticmethod
    def _event_get(event: Any, key: str) -> Any:
        if isinstance(event, dict):
            return event.get(key)
        return getattr(event, key, None)

    def _connect_account_id_for_event(self, event: Any) -> Optional[str]:
        account_id = self._event_get(event, "account")
        if account_id:
            return account_id
        event_dict = self._event_to_dict(event)
        event_type = event_dict.get("type") or ""
        if event_type not in {"account.updated", "account.application.deauthorized"}:
            return None
        data_object = ((event_dict.get("data") or {}).get("object") or {})
        return data_object.get("id")

    @staticmethod
    def _event_to_dict(event: Any) -> dict[str, Any]:
        if isinstance(event, dict):
            return event
        if hasattr(event, "to_dict_recursive"):
            return event.to_dict_recursive()
        if hasattr(event, "to_dict"):
            return event.to_dict()
        return dict(event)
