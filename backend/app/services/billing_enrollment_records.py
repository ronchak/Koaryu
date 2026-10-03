from __future__ import annotations

from typing import Any
from uuid import uuid4

from fastapi import HTTPException
from postgrest.exceptions import APIError as PostgrestAPIError
from supabase import Client

from app.services.billing_fees import application_fee_percent
from app.services.supabase_rpc import execute_required_rpc, first_rpc_row


class BillingEnrollmentRecords:
    def __init__(self, supabase: Client):
        self.supabase = supabase

    def get_row_or_404(
        self, table: str, record_id: str, studio_id: str, detail: str
    ) -> dict[str, Any]:
        result = (
            self.supabase.table(table)
            .select("*")
            .eq("id", record_id)
            .eq("studio_id", studio_id)
            .maybe_single()
            .execute()
        )
        if not result.data:
            raise HTTPException(status_code=404, detail=detail)
        return result.data

    def ensure_record_in_studio(
        self, table: str, record_id: str, studio_id: str, detail: str
    ) -> None:
        result = (
            self.supabase.table(table)
            .select("id")
            .eq("id", record_id)
            .eq("studio_id", studio_id)
            .limit(1)
            .execute()
        )
        if not result.data:
            raise HTTPException(status_code=404, detail=detail)

    def find_or_create_billing_subscription(
        self,
        enrollment: dict[str, Any],
        plan: dict[str, Any],
        payer: dict[str, Any],
        account: dict[str, Any],
        *,
        default_fee_bps: int,
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
        inserted = self.supabase.table("billing_subscriptions").insert(
            {
                "studio_id": enrollment["studio_id"],
                "payer_id": payer["id"],
                "stripe_account_id": account_id,
                "stripe_customer_id": payer.get("stripe_customer_id"),
                "collection_mode": enrollment.get("collection_mode") or "invoice_link",
                "billing_interval": plan.get("billing_interval") or "monthly",
                "currency": plan.get("currency") or "usd",
                "status": "pending",
                "default_payment_method_id": payer.get("default_payment_method_id"),
                "application_fee_percent": application_fee_percent(
                    account.get("platform_fee_bps"), default_fee_bps
                ),
            }
        )
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

    def subscription_item_id_for_group_plan(
        self, studio_id: str, group_id: str, plan_id: str
    ) -> str | None:
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

    def active_enrollment_count_for_subscription_item(
        self,
        studio_id: str,
        group_id: str | None,
        item_id: str | None,
        *,
        exclude_enrollment_id: str | None = None,
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

    def claim_subscription_quantity_sync_lock(self, studio_id: str, group_id: str) -> str:
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

    def release_subscription_quantity_sync_lock(
        self, studio_id: str, group_id: str, token: str
    ) -> None:
        execute_required_rpc(
            self.supabase,
            "finish_billing_subscription_quantity_sync",
            {
                "p_studio_id": studio_id,
                "p_billing_subscription_id": group_id,
                "p_lock_token": token,
            },
        )
