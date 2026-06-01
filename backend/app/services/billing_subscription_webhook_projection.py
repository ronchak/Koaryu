from __future__ import annotations

from typing import Any, Optional

from app.services.billing_invoice_projection import _stripe_id, subscription_period_bounds
from app.services.billing_webhook_event_state import (
    SUBSCRIPTION_STATUS_ORDER,
    add_stripe_event_created_guard,
    is_same_second_status_regression,
    is_stale_stripe_event,
    timestamp,
)


class BillingSubscriptionWebhookProjector:
    def __init__(self, billing_service: Any):
        self.billing_service = billing_service

    @property
    def supabase(self):
        return self.billing_service.supabase

    def _resolve_stripe_event_studio_id(
        self,
        account_id: Optional[str],
        *,
        metadata_studio_id: Optional[str] = None,
        local_studio_id: Optional[str] = None,
    ) -> Optional[str]:
        return self.billing_service._resolve_stripe_event_studio_id(
            account_id,
            metadata_studio_id=metadata_studio_id,
            local_studio_id=local_studio_id,
        )

    def _row_matches_stripe_account(self, row: dict[str, Any], account_id: Optional[str]) -> bool:
        return self.billing_service._row_matches_stripe_account(row, account_id)

    def project_subscription(
        self,
        subscription: dict[str, Any],
        account_id: Optional[str],
        event_type: str = "",
        event_created: Optional[int] = None,
    ) -> Optional[dict[str, Any]]:
        metadata = subscription.get("metadata") or {}
        local = self.find_subscription_for_stripe(subscription, account_id)
        studio_id = self._resolve_stripe_event_studio_id(
            account_id,
            metadata_studio_id=metadata.get("studio_id"),
            local_studio_id=(local or {}).get("studio_id"),
        )
        payer_id = metadata.get("payer_id") or (local or {}).get("payer_id")
        if not studio_id or not payer_id:
            return local
        if local and is_stale_stripe_event(local, event_created):
            return local
        status_value = "canceled" if event_type == "customer.subscription.deleted" else subscription.get("status", "active")
        if local and is_same_second_status_regression(
            local.get("last_stripe_event_created"),
            event_created,
            current_status=local.get("status"),
            incoming_status=status_value,
            status_order=SUBSCRIPTION_STATUS_ORDER,
        ):
            return local
        period_start, period_end = subscription_period_bounds(subscription)
        update = {
            "studio_id": studio_id,
            "payer_id": payer_id,
            "stripe_account_id": account_id,
            "stripe_customer_id": _stripe_id(subscription.get("customer")),
            "stripe_subscription_id": _stripe_id(subscription),
            "status": status_value,
            "current_period_start": timestamp(period_start) or (local or {}).get("current_period_start"),
            "current_period_end": timestamp(period_end) or (local or {}).get("current_period_end"),
            "cancel_at_period_end": bool(subscription.get("cancel_at_period_end")),
            "application_fee_percent": subscription.get("application_fee_percent"),
            "last_stripe_event_created": event_created if event_created is not None else (local or {}).get("last_stripe_event_created"),
        }
        if local:
            query = self.supabase.table("billing_subscriptions").update(update).eq("id", local["id"])
            query = add_stripe_event_created_guard(query, event_created)
            result = query.execute()
            if not result.data and event_created is not None:
                return local
            row = result.data[0] if result.data else {**local, **update}
        else:
            update.update({
                "collection_mode": "autopay" if subscription.get("collection_method") == "charge_automatically" else "invoice_link",
                "billing_interval": "monthly",
                "currency": "usd",
            })
            result = self.supabase.table("billing_subscriptions").insert(update).execute()
            row = result.data[0] if result.data else update
        self.project_subscription_items(subscription, row)
        return row

    def find_subscription_for_stripe(
        self,
        subscription: dict[str, Any],
        account_id: Optional[str],
    ) -> Optional[dict[str, Any]]:
        metadata = subscription.get("metadata") or {}
        local_id = metadata.get("billing_subscription_id")
        studio_id = metadata.get("studio_id")
        if local_id and studio_id:
            result = self.supabase.table("billing_subscriptions").select("*").eq("id", local_id).eq("studio_id", studio_id).limit(1).execute()
            if result.data and self._row_matches_stripe_account(result.data[0], account_id):
                return result.data[0]
        stripe_id = _stripe_id(subscription)
        if not stripe_id:
            return None
        query = self.supabase.table("billing_subscriptions").select("*").eq("stripe_subscription_id", stripe_id).limit(1)
        query = query.eq("stripe_account_id", account_id) if account_id else query.is_("stripe_account_id", "null")
        result = query.execute()
        return result.data[0] if result.data else None

    def project_subscription_items(self, subscription: dict[str, Any], group: dict[str, Any]) -> None:
        items = (subscription.get("items") or {}).get("data") or []
        for item in items:
            metadata = item.get("metadata") or {}
            enrollment_id = metadata.get("enrollment_id")
            update = {
                "billing_subscription_id": group.get("id"),
                "stripe_subscription_id": _stripe_id(subscription),
                "stripe_subscription_item_id": _stripe_id(item),
                "billing_status": "current" if subscription.get("status") in {"active", "trialing"} else "past_due",
            }
            if enrollment_id:
                self.supabase.table("student_billing_enrollments").update(update).eq("id", enrollment_id).eq("studio_id", group["studio_id"]).in_("status", ["pending", "active"]).execute()
            self.supabase.table("student_billing_enrollments").update(update).eq("studio_id", group["studio_id"]).eq("billing_subscription_id", group.get("id")).eq("stripe_subscription_item_id", _stripe_id(item)).in_("status", ["pending", "active"]).execute()
