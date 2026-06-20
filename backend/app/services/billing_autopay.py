from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import HTTPException, status

from app.schemas.billing import (
    BillingLinkResponse,
    BillingPayerAutopaySetupRequest,
    BillingPayerResponse,
)
from app.services.stripe_service import StripeService


ACTIVE_AUTOPAY_SUBSCRIPTION_STATUSES = ["pending", "trialing", "active", "incomplete", "past_due"]


class BillingAutopayManager:
    def __init__(self, billing_service: Any, *, stripe_service_cls: type[StripeService] = StripeService):
        self.billing_service = billing_service
        self.stripe_service_cls = stripe_service_cls

    @property
    def supabase(self):
        return self.billing_service.supabase

    @property
    def settings(self):
        return self.billing_service.settings

    def _get_row_or_404(self, *args, **kwargs):
        return self.billing_service._get_row_or_404(*args, **kwargs)

    def _ensure_connect_ready(self, studio_id: str) -> dict[str, Any]:
        return self.billing_service._ensure_connect_ready(studio_id)

    def _sync_payer_customer(self, payer: dict[str, Any], account: dict[str, Any]) -> dict[str, Any]:
        return self.billing_service._sync_payer_customer(payer, account)

    def _safe_redirect_url(self, value: Optional[str], default: str) -> str:
        return self.billing_service._safe_redirect_url(value, default)

    def _idempotency_key(self, *parts: str) -> str:
        return self.billing_service._idempotency_key(*parts)

    def _audit(self, studio_id: str, actor_id: str, action: str, entity_id: str, metadata: dict[str, Any]) -> None:
        self.billing_service._audit(studio_id, actor_id, action, entity_id, metadata)

    async def create_autopay_setup_link(
        self,
        payer_id: str,
        data: BillingPayerAutopaySetupRequest,
        studio_id: str,
        actor_id: str,
    ) -> BillingLinkResponse:
        if not data.terms_accepted:
            raise HTTPException(status_code=400, detail="Autopay setup requires accepted autopay terms.")
        payer = self._get_row_or_404("billing_payers", payer_id, studio_id, "Payer not found.")
        account = self._ensure_connect_ready(studio_id)
        payer = self._sync_payer_customer(payer, account)
        if not payer.get("stripe_customer_id"):
            raise HTTPException(status_code=409, detail="Stripe customer could not be created for this payer.")
        frontend_url = self.settings.FRONTEND_URL.rstrip("/")
        now = datetime.now(timezone.utc).isoformat()
        self.supabase.table("billing_payers").update({
            "autopay_status": "pending",
            "autopay_terms_accepted_at": now if data.terms_accepted else None,
        }).eq("id", payer_id).eq("studio_id", studio_id).execute()
        return_url = self._safe_redirect_url(data.return_url, f"{frontend_url}/billing?autopay=success")
        if payer.get("default_payment_method_id"):
            self.supabase.table("billing_payers").update({
                "autopay_status": "enabled",
                "autopay_authorized_at": now,
                "autopay_terms_accepted_at": now,
                "billing_status": "current",
            }).eq("id", payer_id).eq("studio_id", studio_id).execute()
            self._audit(studio_id, actor_id, "billing.autopay_authorized_existing_payment_method", payer_id, {
                "stripe_customer_id": payer.get("stripe_customer_id"),
                "default_payment_method_id": payer.get("default_payment_method_id"),
            })
            return BillingLinkResponse(url=return_url)
        link = self.stripe_service_cls().create_setup_checkout_session(
            account_id=account["stripe_connected_account_id"],
            customer_id=payer["stripe_customer_id"],
            success_url=self._safe_redirect_url(data.success_url or data.return_url, f"{frontend_url}/billing?autopay=success"),
            cancel_url=self._safe_redirect_url(data.cancel_url or data.return_url, f"{frontend_url}/billing?autopay=cancelled"),
            metadata={
                "studio_id": studio_id,
                "payer_id": payer_id,
                "product": "koaryu_payments_autopay",
            },
            idempotency_key=self._idempotency_key("payer-autopay-setup", payer_id, now),
        )
        self._audit(studio_id, actor_id, "billing.autopay_setup_started", payer_id, {
            "stripe_customer_id": payer.get("stripe_customer_id"),
        })
        return BillingLinkResponse(url=link["url"] if isinstance(link, dict) else link.url)

    async def disable_autopay(self, payer_id: str, studio_id: str, actor_id: str) -> BillingPayerResponse:
        self._get_row_or_404("billing_payers", payer_id, studio_id, "Payer not found.")
        rewired_subscription_ids = self._disable_payer_autopay_subscriptions(payer_id, studio_id)
        result = (
            self.supabase.table("billing_payers")
            .update({
                "autopay_status": "disabled",
                "autopay_disabled_at": datetime.now(timezone.utc).isoformat(),
            })
            .eq("id", payer_id)
            .eq("studio_id", studio_id)
            .execute()
        )
        if not result.data:
            raise HTTPException(status_code=404, detail="Payer not found.")
        self._audit(studio_id, actor_id, "billing.autopay_disabled", payer_id, {
            "rewired_subscription_ids": rewired_subscription_ids,
        })
        return BillingPayerResponse(**result.data[0])

    def _disable_payer_autopay_subscriptions(self, payer_id: str, studio_id: str) -> list[str]:
        result = (
            self.supabase.table("billing_subscriptions")
            .select("*")
            .eq("studio_id", studio_id)
            .eq("payer_id", payer_id)
            .eq("collection_mode", "autopay")
            .in_("status", ACTIVE_AUTOPAY_SUBSCRIPTION_STATUSES)
            .execute()
        )
        subscriptions = result.data or []
        if not subscriptions:
            return []

        stripe_service = self.stripe_service_cls()
        rewired_ids: list[str] = []
        for subscription in subscriptions:
            subscription = self._mark_subscription_autopay_disable_pending(subscription)
            subscription_id = subscription.get("stripe_subscription_id")
            account_id = subscription.get("stripe_account_id") or self._connected_account_id_for_studio(studio_id)
            if subscription_id:
                if not account_id:
                    raise HTTPException(
                        status_code=status.HTTP_409_CONFLICT,
                        detail="Cannot disable autopay while an active Stripe subscription is missing its connected account.",
                    )
                stripe_service.update_connected_subscription(
                    account_id=account_id,
                    subscription_id=subscription_id,
                    collection_method="send_invoice",
                    days_until_due=7,
                    default_payment_method="",
                )

            rewired_ids.append(subscription["id"])
            update_result = (
                self.supabase.table("billing_subscriptions")
                .update(self._disabled_autopay_subscription_fields(subscription))
                .eq("id", subscription["id"])
                .eq("studio_id", studio_id)
                .execute()
            )
            if not update_result.data:
                raise HTTPException(status_code=404, detail="Billing subscription not found.")
            self.supabase.table("student_billing_enrollments").update({
                "collection_mode": "invoice_link",
            }).eq("studio_id", studio_id).eq("billing_subscription_id", subscription["id"]).in_("status", ["pending", "active"]).execute()

        return rewired_ids

    def _mark_subscription_autopay_disable_pending(self, subscription: dict[str, Any]) -> dict[str, Any]:
        metadata = dict(subscription.get("metadata") or {})
        metadata["autopay_disable_pending"] = {
            "reason": "payer_disabled_autopay",
            "started_at": datetime.now(timezone.utc).isoformat(),
            "collection_mode": subscription.get("collection_mode"),
            "stripe_subscription_id": subscription.get("stripe_subscription_id"),
            "default_payment_method_id": subscription.get("default_payment_method_id"),
        }
        result = (
            self.supabase.table("billing_subscriptions")
            .update({"metadata": metadata})
            .eq("id", subscription["id"])
            .eq("studio_id", subscription["studio_id"])
            .execute()
        )
        if not result.data:
            raise HTTPException(status_code=404, detail="Billing subscription not found.")
        return result.data[0]

    def _disabled_autopay_subscription_fields(self, subscription: dict[str, Any]) -> dict[str, Any]:
        metadata = dict(subscription.get("metadata") or {})
        pending = metadata.pop("autopay_disable_pending", None)
        if pending:
            history = list(metadata.get("autopay_disable_history") or [])
            history.append({
                **pending,
                "completed_at": datetime.now(timezone.utc).isoformat(),
            })
            metadata["autopay_disable_history"] = history[-5:]
        return {
            "collection_mode": "invoice_link",
            "default_payment_method_id": None,
            "metadata": metadata,
        }

    def _connected_account_id_for_studio(self, studio_id: str) -> Optional[str]:
        result = (
            self.supabase.table("studio_payment_accounts")
            .select("stripe_connected_account_id")
            .eq("studio_id", studio_id)
            .limit(1)
            .execute()
        )
        if not result.data:
            return None
        return result.data[0].get("stripe_connected_account_id")
