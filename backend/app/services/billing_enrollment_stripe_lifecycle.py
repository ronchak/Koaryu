from __future__ import annotations

from typing import Any, Optional
from uuid import uuid4

from fastapi import HTTPException
from postgrest.exceptions import APIError as PostgrestAPIError

from app.services.billing_invoice_projection import _object_get, _stripe_id
from app.services.supabase_rpc import execute_required_rpc, first_rpc_row


class BillingEnrollmentStripeLifecycle:
    def __init__(self, enrollment_manager: Any):
        self.enrollment_manager = enrollment_manager

    @property
    def supabase(self):
        return self.enrollment_manager.supabase

    @property
    def stripe_service_cls(self):
        return self.enrollment_manager.stripe_service_cls

    def __getattr__(self, name: str) -> Any:
        return getattr(self.enrollment_manager, name)

    def _find_or_create_billing_subscription(
        self,
        enrollment: dict[str, Any],
        plan: dict[str, Any],
        payer: dict[str, Any],
        account: dict[str, Any],
    ) -> dict[str, Any]:
        account_id = account["stripe_connected_account_id"]
        result = (
            self.supabase.table("billing_subscriptions")
            .select("*")
            .eq("studio_id", enrollment["studio_id"])
            .eq("payer_id", payer["id"])
            .eq("collection_mode", enrollment.get("collection_mode") or "invoice_link")
            .eq("billing_interval", plan.get("billing_interval") or "monthly")
            .eq("currency", plan.get("currency") or "usd")
            .in_("status", ["pending", "trialing", "active", "incomplete", "past_due"])
            .limit(1)
            .execute()
        )
        if result.data:
            return result.data[0]
        inserted = self.supabase.table("billing_subscriptions").insert({
            "studio_id": enrollment["studio_id"],
            "payer_id": payer["id"],
            "stripe_account_id": account_id,
            "stripe_customer_id": payer.get("stripe_customer_id"),
            "collection_mode": enrollment.get("collection_mode") or "invoice_link",
            "billing_interval": plan.get("billing_interval") or "monthly",
            "currency": plan.get("currency") or "usd",
            "status": "pending",
            "default_payment_method_id": payer.get("default_payment_method_id"),
            "application_fee_percent": self._application_fee_percent(account),
        })
        try:
            inserted = inserted.execute()
        except PostgrestAPIError as exc:
            if exc.code != "23505":
                raise
            retry = (
                self.supabase.table("billing_subscriptions")
                .select("*")
                .eq("studio_id", enrollment["studio_id"])
                .eq("payer_id", payer["id"])
                .eq("collection_mode", enrollment.get("collection_mode") or "invoice_link")
                .eq("billing_interval", plan.get("billing_interval") or "monthly")
                .eq("currency", plan.get("currency") or "usd")
                .in_("status", ["pending", "trialing", "active", "incomplete", "past_due"])
                .limit(1)
                .execute()
            )
            if retry.data:
                return retry.data[0]
            raise
        if not inserted.data:
            raise HTTPException(status_code=500, detail="Failed to create billing subscription.")
        return inserted.data[0]

    def _subscription_item_id_for_group_plan(self, studio_id: str, group_id: str, plan_id: str) -> Optional[str]:
        result = (
            self.supabase.table("student_billing_enrollments")
            .select("stripe_subscription_item_id")
            .eq("studio_id", studio_id)
            .eq("billing_subscription_id", group_id)
            .eq("billing_plan_id", plan_id)
            .not_.is_("stripe_subscription_item_id", "null")
            .in_("status", ["pending", "active"])
            .limit(1)
            .execute()
        )
        return result.data[0]["stripe_subscription_item_id"] if result.data else None

    def _active_enrollment_count_for_subscription_item(
        self,
        studio_id: str,
        group_id: Optional[str],
        item_id: Optional[str],
        *,
        exclude_enrollment_id: Optional[str] = None,
    ) -> int:
        if not group_id or not item_id:
            return 0
        result = (
            self.supabase.table("student_billing_enrollments")
            .select("id, metadata")
            .eq("studio_id", studio_id)
            .eq("billing_subscription_id", group_id)
            .eq("stripe_subscription_item_id", item_id)
            .in_("status", ["pending", "active"])
            .execute()
        )
        rows = [
            row
            for row in (result.data or [])
            if not (row.get("metadata") or {}).get("stripe_detach_pending")
        ]
        if exclude_enrollment_id:
            rows = [row for row in rows if row.get("id") != exclude_enrollment_id]
        return len(rows)

    def _claim_subscription_quantity_sync_lock(self, studio_id: str, group_id: str) -> str:
        token = str(uuid4())
        result = execute_required_rpc(
            self.supabase,
            "claim_billing_subscription_quantity_sync",
            {
                "p_studio_id": studio_id,
                "p_billing_subscription_id": group_id,
                "p_lock_token": token,
                "p_stale_after_seconds": 120,
            },
        )
        row = first_rpc_row(result) or {}
        if not row.get("claimed"):
            raise HTTPException(
                status_code=409,
                detail="Billing subscription quantity sync is already in progress. Retry in a moment.",
            )
        return token

    def _release_subscription_quantity_sync_lock(self, studio_id: str, group_id: str, token: str) -> None:
        execute_required_rpc(
            self.supabase,
            "finish_billing_subscription_quantity_sync",
            {
                "p_studio_id": studio_id,
                "p_billing_subscription_id": group_id,
                "p_lock_token": token,
            },
        )

    def _update_enrollment(self, enrollment_id: str, studio_id: str, update: dict[str, Any]) -> dict[str, Any]:
        result = (
            self.supabase.table("student_billing_enrollments")
            .update(update)
            .eq("id", enrollment_id)
            .eq("studio_id", studio_id)
            .execute()
        )
        if not result.data:
            raise HTTPException(status_code=404, detail="Billing enrollment not found.")
        return result.data[0]

    def _subscription_item_id_for_enrollment(self, subscription: Any, enrollment_id: str) -> Optional[str]:
        items = (_object_get(_object_get(subscription, "items") or {}, "data") or [])
        for item in items:
            if (_object_get(item, "metadata") or {}).get("enrollment_id") == enrollment_id:
                return _stripe_id(item)
        return _stripe_id(items[0]) if items else None
