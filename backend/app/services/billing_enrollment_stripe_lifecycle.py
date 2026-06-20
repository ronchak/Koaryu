from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional
from uuid import uuid4

from fastapi import HTTPException
from postgrest.exceptions import APIError as PostgrestAPIError

from app.schemas.billing import BillingInvoiceCreate
from app.services.billing_invoice_projection import _object_get, _stripe_id
from app.services.billing_invoices import BillingInvoiceManager
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

    def _activate_stripe_enrollment(
        self,
        enrollment: dict[str, Any],
        plan: dict[str, Any],
        studio_id: str,
        actor_id: Optional[str] = None,
    ) -> dict[str, Any]:
        if not enrollment.get("payer_id"):
            raise HTTPException(status_code=409, detail="Assign a payer before activating Stripe billing.")
        account = self._ensure_connect_ready(studio_id)
        plan = self._sync_plan_price(plan, account) if not plan.get("stripe_price_id") else plan
        payer = self._sync_payer_customer(
            self._get_row_or_404("billing_payers", enrollment["payer_id"], studio_id, "Payer not found."),
            account,
        )
        if enrollment.get("collection_mode") == "autopay" and not payer.get("default_payment_method_id"):
            raise HTTPException(status_code=409, detail="Autopay requires a saved payer payment method.")
        if enrollment.get("collection_mode") == "autopay" and not self._payer_autopay_authorized(payer):
            raise HTTPException(status_code=409, detail="Autopay requires accepted autopay terms before enrollment.")

        enrollment = self._mark_enrollment_stripe_attach_pending(enrollment, "activate")
        if plan.get("billing_interval") == "paid_in_full":
            if not actor_id:
                raise HTTPException(status_code=500, detail="Actor is required to create a paid-in-full invoice.")
            self._create_paid_in_full_invoice(enrollment, plan, payer, account, actor_id=actor_id)
            return self._update_enrollment(
                enrollment["id"],
                studio_id,
                self._attached_enrollment_fields(enrollment, {"billing_status": "upcoming"}),
            )

        group = self._find_or_create_billing_subscription(enrollment, plan, payer, account)
        stripe_service = self.stripe_service_cls()
        quantity_lock_token: Optional[str] = None
        quantity_lock_group_id: Optional[str] = group.get("id")
        if quantity_lock_group_id:
            quantity_lock_token = self._claim_subscription_quantity_sync_lock(studio_id, quantity_lock_group_id)
        try:
            if group.get("stripe_subscription_id"):
                existing_item_id = self._subscription_item_id_for_group_plan(studio_id, group["id"], plan["id"])
                if existing_item_id:
                    quantity = self._active_enrollment_count_for_subscription_item(
                        studio_id,
                        group["id"],
                        existing_item_id,
                    ) + 1
                    stripe_service.update_connected_subscription_item(
                        account_id=account["stripe_connected_account_id"],
                        subscription_item_id=existing_item_id,
                        quantity=quantity,
                        proration_behavior="none",
                        idempotency_key=self._idempotency_key(
                            "subscription-item-quantity",
                            existing_item_id,
                            str(quantity),
                        ),
                    )
                    item_id = existing_item_id
                else:
                    item = stripe_service.create_connected_subscription_item(
                        account_id=account["stripe_connected_account_id"],
                        subscription_id=group["stripe_subscription_id"],
                        price_id=plan["stripe_price_id"],
                        metadata={
                            "studio_id": studio_id,
                            "payer_id": payer["id"],
                            "enrollment_id": enrollment["id"],
                            "student_id": enrollment["student_id"],
                            "billing_plan_id": plan["id"],
                            "billing_subscription_id": group["id"],
                            "product": "koaryu_payments",
                        },
                        idempotency_key=self._idempotency_key("subscription-item", enrollment["id"], plan["stripe_price_id"]),
                    )
                    item_id = _stripe_id(item)
            else:
                subscription = stripe_service.create_connected_subscription(
                    account_id=account["stripe_connected_account_id"],
                    customer_id=payer["stripe_customer_id"],
                    price_id=plan["stripe_price_id"],
                    collection_method="charge_automatically" if enrollment.get("collection_mode") == "autopay" else "send_invoice",
                    application_fee_percent=self._application_fee_percent(account),
                    default_payment_method=payer.get("default_payment_method_id") if enrollment.get("collection_mode") == "autopay" else None,
                    trial_days=int(plan.get("trial_days") or 0),
                    days_until_due=7,
                    metadata={
                        "studio_id": studio_id,
                        "payer_id": payer["id"],
                        "billing_subscription_id": group["id"],
                        "product": "koaryu_payments",
                    },
                    item_metadata={
                        "studio_id": studio_id,
                        "payer_id": payer["id"],
                        "enrollment_id": enrollment["id"],
                        "student_id": enrollment["student_id"],
                        "billing_plan_id": plan["id"],
                        "billing_subscription_id": group["id"],
                        "product": "koaryu_payments",
                    },
                    idempotency_key=self._idempotency_key("subscription", group["id"]),
                )
                group = self._project_subscription(subscription, account["stripe_connected_account_id"]) or group
                item_id = self._subscription_item_id_for_enrollment(subscription, enrollment["id"])
            update = {
                "billing_subscription_id": group["id"],
                "stripe_subscription_id": group.get("stripe_subscription_id"),
                "stripe_subscription_item_id": item_id,
                "billing_status": "upcoming" if enrollment.get("collection_mode") != "autopay" else "current",
                "status": "active",
            }
            return self._update_enrollment(enrollment["id"], studio_id, self._attached_enrollment_fields(enrollment, update))
        finally:
            if quantity_lock_token and quantity_lock_group_id:
                self._release_subscription_quantity_sync_lock(studio_id, quantity_lock_group_id, quantity_lock_token)

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

    def _enrollment_has_stripe_link(self, enrollment: dict[str, Any]) -> bool:
        return bool(enrollment.get("stripe_subscription_id") or enrollment.get("stripe_subscription_item_id"))

    def _mark_enrollment_stripe_attach_pending(
        self,
        enrollment: dict[str, Any],
        reason: str,
    ) -> dict[str, Any]:
        metadata = dict(enrollment.get("metadata") or {})
        metadata["stripe_attach_pending"] = {
            "reason": reason,
            "started_at": datetime.now(timezone.utc).isoformat(),
            "billing_plan_id": enrollment.get("billing_plan_id"),
            "payer_id": enrollment.get("payer_id"),
            "collection_mode": enrollment.get("collection_mode"),
        }
        result = (
            self.supabase.table("student_billing_enrollments")
            .update({"metadata": metadata})
            .eq("id", enrollment["id"])
            .eq("studio_id", enrollment["studio_id"])
            .execute()
        )
        if not result.data:
            raise HTTPException(status_code=404, detail="Billing enrollment not found.")
        return result.data[0]

    def _attached_enrollment_fields(self, enrollment: dict[str, Any], update: dict[str, Any]) -> dict[str, Any]:
        metadata = dict(enrollment.get("metadata") or {})
        pending = metadata.pop("stripe_attach_pending", None)
        if pending:
            history = list(metadata.get("stripe_attach_history") or [])
            history.append({
                **pending,
                "completed_at": datetime.now(timezone.utc).isoformat(),
                "billing_subscription_id": update.get("billing_subscription_id"),
                "stripe_subscription_id": update.get("stripe_subscription_id"),
                "stripe_subscription_item_id": update.get("stripe_subscription_item_id"),
            })
            metadata["stripe_attach_history"] = history[-5:]
        metadata.pop("stripe_attach_error", None)
        return {**update, "metadata": metadata}

    def _mark_enrollment_stripe_detach_pending(
        self,
        enrollment: dict[str, Any],
        reason: str,
    ) -> dict[str, Any]:
        metadata = dict(enrollment.get("metadata") or {})
        metadata["stripe_detach_pending"] = {
            "reason": reason,
            "started_at": datetime.now(timezone.utc).isoformat(),
            "billing_subscription_id": enrollment.get("billing_subscription_id"),
            "stripe_subscription_id": enrollment.get("stripe_subscription_id"),
            "stripe_subscription_item_id": enrollment.get("stripe_subscription_item_id"),
        }
        result = (
            self.supabase.table("student_billing_enrollments")
            .update({"metadata": metadata})
            .eq("id", enrollment["id"])
            .eq("studio_id", enrollment["studio_id"])
            .execute()
        )
        if not result.data:
            raise HTTPException(status_code=404, detail="Billing enrollment not found.")
        return result.data[0]

    def _detached_enrollment_fields(self, enrollment: dict[str, Any]) -> dict[str, Any]:
        metadata = dict(enrollment.get("metadata") or {})
        pending = metadata.pop("stripe_detach_pending", None)
        if pending:
            history = list(metadata.get("stripe_detach_history") or [])
            history.append({
                **pending,
                "completed_at": datetime.now(timezone.utc).isoformat(),
            })
            metadata["stripe_detach_history"] = history[-5:]
        metadata.pop("stripe_detach_error", None)
        return {
            "billing_subscription_id": None,
            "stripe_subscription_id": None,
            "stripe_subscription_item_id": None,
            "metadata": metadata,
        }

    def _detach_enrollment_from_subscription(self, enrollment: dict[str, Any]) -> None:
        item_id = enrollment.get("stripe_subscription_item_id")
        subscription_id = enrollment.get("stripe_subscription_id")
        account_id = self._stripe_account_for_enrollment_subscription(enrollment) if subscription_id else None
        group_id = enrollment.get("billing_subscription_id")
        lock_token = self._claim_subscription_quantity_sync_lock(enrollment["studio_id"], group_id) if group_id else None
        try:
            remaining = self._remaining_enrollments_for_subscription(enrollment)
            if not remaining and subscription_id:
                if account_id:
                    self.stripe_service_cls().cancel_connected_subscription(account_id=account_id, subscription_id=subscription_id)
                if group_id:
                    (
                        self.supabase.table("billing_subscriptions")
                        .update({"status": "canceled"})
                        .eq("id", group_id)
                        .eq("studio_id", enrollment["studio_id"])
                        .execute()
                    )
                return
            if item_id and subscription_id and account_id:
                remaining_same_item = self._active_enrollment_count_for_subscription_item(
                    enrollment["studio_id"],
                    group_id,
                    item_id,
                    exclude_enrollment_id=enrollment["id"],
                )
                if remaining_same_item:
                    self.stripe_service_cls().update_connected_subscription_item(
                        account_id=account_id,
                        subscription_item_id=item_id,
                        quantity=remaining_same_item,
                        proration_behavior="none",
                        idempotency_key=self._idempotency_key(
                            "subscription-item-quantity",
                            item_id,
                            str(remaining_same_item),
                        ),
                    )
                else:
                    self.stripe_service_cls().delete_connected_subscription_item(account_id=account_id, subscription_item_id=item_id)
        finally:
            if group_id and lock_token:
                self._release_subscription_quantity_sync_lock(enrollment["studio_id"], group_id, lock_token)

    def _create_paid_in_full_invoice(
        self,
        enrollment: dict[str, Any],
        plan: dict[str, Any],
        payer: dict[str, Any],
        account: dict[str, Any],
        *,
        actor_id: str,
    ) -> None:
        invoice = BillingInvoiceCreate(
            payer_id=payer["id"],
            student_id=enrollment["student_id"],
            enrollment_id=enrollment["id"],
            invoice_type="paid_in_full",
            collection_mode="autopay" if enrollment.get("collection_mode") == "autopay" else "invoice_link",
            currency=plan.get("currency") or "usd",
            description=plan.get("name") or "Paid in full",
            amount_cents=int(plan.get("amount_cents") or 0) + int(plan.get("signup_fee_cents") or 0),
        )
        BillingInvoiceManager(self.billing_service, stripe_service_cls=self.stripe_service_cls).create_invoice_sync(
            invoice,
            enrollment["studio_id"],
            actor_id,
            idempotency_key=self._idempotency_key("paid-in-full", enrollment["id"]),
        )

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

    def _remaining_enrollments_for_subscription(self, enrollment: dict[str, Any]) -> list[dict[str, Any]]:
        group_id = enrollment.get("billing_subscription_id")
        if not group_id:
            return []
        result = (
            self.supabase.table("student_billing_enrollments")
            .select("id, metadata")
            .eq("studio_id", enrollment["studio_id"])
            .eq("billing_subscription_id", group_id)
            .neq("id", enrollment["id"])
            .in_("status", ["pending", "active"])
            .execute()
        )
        return [
            row
            for row in (result.data or [])
            if not (row.get("metadata") or {}).get("stripe_detach_pending")
        ]

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
