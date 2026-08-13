from __future__ import annotations

import logging
import re
import uuid
from datetime import timedelta
from typing import Any, Optional

from fastapi import HTTPException, status
from postgrest.exceptions import APIError as PostgrestAPIError
from stripe import StripeError
from supabase import Client

from app.core.config import get_settings
from app.schemas.billing import WebhookProcessResponse
from app.services.billing_service import BillingService
from app.services.platform_billing_service import PlatformBillingService
from app.services.stripe_service import StripeService
from app.services.stripe_mutation_policy import StripeMutationBlocked, configured_stripe_mode
from app.services.supabase_rpc import execute_required_rpc, first_rpc_row


WEBHOOK_PROCESSING_STALE_AFTER = timedelta(minutes=10)
WEBHOOK_UNMAPPED_ACCOUNT_RETRY_AFTER_SECONDS = 60
WEBHOOK_FAILURE_STRIPE_ERROR = "stripe_error"
WEBHOOK_FAILURE_DATABASE_ERROR = "database_projection_error"
WEBHOOK_FAILURE_UNEXPECTED_ERROR = "unexpected_processing_error"
WEBHOOK_FAILURE_UNMAPPED_LIVE_CONNECT_ACCOUNT = "unmapped_live_connect_account"
WEBHOOK_FAILURE_MISSING_CONNECT_ACCOUNT_CONTEXT = "missing_connect_account_context"
WEBHOOK_FAILURE_WRONG_ROUTE_PLATFORM_EVENT = "wrong_route_platform_event"
WEBHOOK_FAILURE_WRONG_ROUTE_CONNECT_EVENT = "wrong_route_connect_event"
WEBHOOK_FAILURE_LIVE_MUTATION_BLOCKED = "live_mutation_blocked"
PLATFORM_WEBHOOK_EVENT_TYPES = {
    "checkout.session.completed",
    "customer.subscription.created",
    "customer.subscription.updated",
    "customer.subscription.deleted",
    "invoice.paid",
    "invoice.payment_failed",
}
WEBHOOK_LOG_VALUE_PATTERN = re.compile(r"^[A-Za-z0-9_.:-]{1,128}$")
WEBHOOK_MODE_MISMATCH_DETAIL = "Stripe webhook mode does not match configured STRIPE_MODE."
WEBHOOK_INVALID_LIVEMODE_DETAIL = "Stripe webhook livemode must be a boolean."
WEBHOOK_CONFIGURATION_MISMATCH_DETAIL = (
    "Stripe webhook configuration must have a matching STRIPE_MODE and secret key."
)
logger = logging.getLogger(__name__)


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
        account_id = self._event_get(event, "account")
        return self._store_and_process(event, stripe_account_id=account_id, processor="platform")

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
        raw_livemode = event_dict.get("livemode")
        if not isinstance(raw_livemode, bool):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=WEBHOOK_INVALID_LIVEMODE_DETAIL,
            )
        livemode = raw_livemode
        configured_mode = configured_stripe_mode(self.settings)
        if configured_mode is None:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=WEBHOOK_CONFIGURATION_MISMATCH_DETAIL,
            )
        if livemode != (configured_mode == "live"):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=WEBHOOK_MODE_MISMATCH_DETAIL,
            )
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
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Webhook event is already processing. Retry after the processing lease expires.",
                headers={
                    "Retry-After": str(int(WEBHOOK_PROCESSING_STALE_AFTER.total_seconds())),
                },
            )
        if claim_status != "claimed" or not claimed_event:
            return WebhookProcessResponse(status="ignored")

        row_id = claimed_event.get("id")
        if not row_id:
            return WebhookProcessResponse(status="ignored")

        if processor == "platform" and stripe_account_id:
            self._quarantine_permanent_route_failure(
                row_id=row_id,
                claim_token=claim_token,
                error=WEBHOOK_FAILURE_WRONG_ROUTE_CONNECT_EVENT,
                detail="Connected-account events must be delivered to the Connect webhook route.",
            )

        if processor == "connect" and not stripe_account_id:
            route_failure = (
                WEBHOOK_FAILURE_WRONG_ROUTE_PLATFORM_EVENT
                if event_type in PLATFORM_WEBHOOK_EVENT_TYPES
                else WEBHOOK_FAILURE_MISSING_CONNECT_ACCOUNT_CONTEXT
            )
            detail = (
                "Platform events must be delivered to the platform webhook route."
                if route_failure == WEBHOOK_FAILURE_WRONG_ROUTE_PLATFORM_EVENT
                else "Connect webhook events must include connected-account context."
            )
            self._quarantine_permanent_route_failure(
                row_id=row_id,
                claim_token=claim_token,
                error=route_failure,
                detail=detail,
            )

        if processor == "connect" and livemode and not self._is_mapped_connect_account(stripe_account_id):
            if self._is_excluded_connect_account(stripe_account_id):
                if not self._finish_event_processing(row_id, claim_token, "ignored"):
                    raise RuntimeError(
                        "Webhook processing lease was lost before the excluded account event "
                        "could be ignored."
                    )
                return WebhookProcessResponse(status="ignored")
            if not self._finish_event_processing(
                row_id,
                claim_token,
                "failed",
                error=WEBHOOK_FAILURE_UNMAPPED_LIVE_CONNECT_ACCOUNT,
            ):
                raise RuntimeError(
                    "Webhook processing lease was lost before the event could be quarantined."
                )
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Connect account mapping is not ready. Retry this webhook after the account is mapped.",
                headers={"Retry-After": str(WEBHOOK_UNMAPPED_ACCOUNT_RETRY_AFTER_SECONDS)},
            )

        try:
            if processor == "platform":
                PlatformBillingService(self.supabase).project_subscription_event(event_dict, hydrate_subscription=True)
            else:
                BillingService(self.supabase).project_connect_event(event_dict)
            if not self._finish_event_processing(row_id, claim_token, "processed"):
                raise RuntimeError("Webhook processing lease was lost before the event could be marked processed.")
            return WebhookProcessResponse(status="processed")
        except Exception as exc:
            failure_code = self._failure_code(exc)
            error_reference = uuid.uuid4().hex
            failure_recorded = self._finish_event_processing(
                row_id,
                claim_token,
                "failed",
                error=failure_code,
                error_reference=error_reference,
            )
            logger.error(
                "Stripe webhook processing failed reference=%s event_id=%s event_type=%s "
                "processor=%s error_code=%s exception_type=%s failure_recorded=%s",
                error_reference,
                self._safe_log_value(event_id),
                self._safe_log_value(event_type),
                processor,
                failure_code,
                type(exc).__name__,
                failure_recorded,
            )
            raise

    def _quarantine_permanent_route_failure(
        self,
        *,
        row_id: str,
        claim_token: str,
        error: str,
        detail: str,
    ) -> None:
        if not self._finish_event_processing(row_id, claim_token, "failed", error=error):
            raise RuntimeError(
                "Webhook processing lease was lost before the route failure could be quarantined."
            )
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=detail)

    def _is_mapped_connect_account(self, stripe_account_id: Optional[str]) -> bool:
        if not stripe_account_id:
            return False
        response = (
            self.supabase.table("studio_payment_accounts")
            .select("studio_id")
            .eq("stripe_connected_account_id", stripe_account_id)
            .limit(1)
            .execute()
        )
        return bool(response.data)

    def _is_excluded_connect_account(self, stripe_account_id: Optional[str]) -> bool:
        if not stripe_account_id:
            return False
        response = (
            self.supabase.table("stripe_connect_account_dispositions")
            .select("stripe_connected_account_id")
            .eq("stripe_connected_account_id", stripe_account_id)
            .eq("excluded", True)
            .limit(1)
            .execute()
        )
        return bool(response.data)

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
        error_reference: Optional[str] = None,
    ) -> bool:
        if status == "failed" and error_reference is None:
            error_reference = uuid.uuid4().hex
        elif status != "failed":
            error_reference = None
        result = execute_required_rpc(self.supabase, "finish_stripe_event_processing_v2", {
            "p_event_id": row_id,
            "p_processing_token": processing_token,
            "p_status": status,
            "p_error": error,
            "p_error_reference": error_reference,
        })
        row = first_rpc_row(result) or {}
        return bool(row.get("updated"))

    @staticmethod
    def _safe_log_value(value: Any) -> str:
        normalized = str(value or "")
        return normalized if WEBHOOK_LOG_VALUE_PATTERN.fullmatch(normalized) else "redacted_invalid_identifier"

    @staticmethod
    def _failure_code(exc: Exception) -> str:
        if isinstance(exc, StripeMutationBlocked):
            return WEBHOOK_FAILURE_LIVE_MUTATION_BLOCKED
        if isinstance(exc, StripeError):
            return WEBHOOK_FAILURE_STRIPE_ERROR
        if isinstance(exc, PostgrestAPIError):
            return WEBHOOK_FAILURE_DATABASE_ERROR
        return WEBHOOK_FAILURE_UNEXPECTED_ERROR

    @staticmethod
    def _event_get(event: Any, key: str) -> Any:
        if isinstance(event, dict):
            return event.get(key)
        return getattr(event, key, None)

    def _connect_account_id_for_event(self, event: Any) -> Optional[str]:
        account_id = self._event_get(event, "account")
        return str(account_id) if account_id else None

    @staticmethod
    def _event_to_dict(event: Any) -> dict[str, Any]:
        if isinstance(event, dict):
            return event
        if hasattr(event, "to_dict_recursive"):
            return event.to_dict_recursive()
        if hasattr(event, "to_dict"):
            return event.to_dict()
        return dict(event)
