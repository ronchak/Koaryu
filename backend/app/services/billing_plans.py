from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import HTTPException
from postgrest.exceptions import APIError as PostgrestAPIError

from app.schemas.billing import (
    BillingPlanCreate,
    BillingPlanProgramResponse,
    BillingPlanResponse,
    BillingPlanUpdate,
)
from app.services.billing_invoice_projection import _stripe_id
from app.services.stripe_service import StripeService


class BillingPlanManager:
    def __init__(self, billing_service: Any, *, stripe_service_cls: type[StripeService] = StripeService):
        self.billing_service = billing_service
        self.stripe_service_cls = stripe_service_cls

    @property
    def supabase(self):
        return self.billing_service.supabase

    def _connect_accounts(self):
        return self.billing_service._connect_accounts()

    def _ensure_connect_ready(self, studio_id: str) -> dict[str, Any]:
        return self.billing_service._ensure_connect_ready(studio_id)

    def _get_row_or_404(self, *args, **kwargs):
        return self.billing_service._get_row_or_404(*args, **kwargs)

    def _idempotency_key(self, *parts: str) -> str:
        return self.billing_service._idempotency_key(*parts)

    def _audit(self, studio_id: str, actor_id: str, action: str, entity_id: str, metadata: dict[str, Any]) -> None:
        self.billing_service._audit(studio_id, actor_id, action, entity_id, metadata)

    async def list_plans(self, studio_id: str) -> list[BillingPlanResponse]:
        account = self._connect_accounts().ensure_row(studio_id)
        result = (
            self.supabase.table("billing_plans")
            .select("*")
            .eq("studio_id", studio_id)
            .order("created_at")
            .execute()
        )
        return [self._plan_response(row, account) for row in (result.data or [])]

    async def create_plan(self, data: BillingPlanCreate, studio_id: str, actor_id: str) -> BillingPlanResponse:
        self._ensure_programs_in_studio(studio_id, data.program_ids)
        account = self._connect_accounts().ensure_row(studio_id)
        if account.get("stripe_connected_account_id"):
            account = self._connect_accounts().refresh_status(account, strict=True)
        plan_row = data.model_dump(exclude={"program_ids"})
        plan_row["studio_id"] = studio_id
        plan_row["name"] = " ".join(data.name.strip().split())
        plan_row["status"] = "pending"
        if not plan_row["name"]:
            raise HTTPException(status_code=400, detail="Billing plan name is required.")
        try:
            result = self.supabase.table("billing_plans").insert(plan_row).execute()
        except PostgrestAPIError as exc:
            if exc.code == "23505":
                raise HTTPException(status_code=409, detail="A billing plan with this name already exists.") from exc
            raise
        if not result.data:
            raise HTTPException(status_code=500, detail="Failed to create billing plan.")
        plan = result.data[0]
        self._replace_plan_programs(studio_id, plan["id"], data.program_ids)
        if account.get("charges_enabled"):
            plan = self._sync_plan_price(plan, account)
        self._audit(studio_id, actor_id, "billing.plan_created", plan["id"], {"name": plan["name"], "program_ids": data.program_ids})
        return self._plan_response(plan, account)

    async def update_plan(self, plan_id: str, data: BillingPlanUpdate, studio_id: str, actor_id: str) -> BillingPlanResponse:
        current = self._get_row_or_404("billing_plans", plan_id, studio_id, "Billing plan not found.")
        update = data.model_dump(exclude_unset=True, exclude={"program_ids"})
        if "name" in update and update["name"]:
            update["name"] = " ".join(update["name"].strip().split())
        if "currency" in update and update["currency"]:
            update["currency"] = update["currency"].lower()
        account = self._connect_accounts().ensure_row(studio_id)
        if account.get("stripe_connected_account_id"):
            account = self._connect_accounts().refresh_status(account, strict=True)
        should_sync_after_update = account.get("charges_enabled") and (
            not current.get("stripe_price_id")
            or any(key in update for key in ("amount_cents", "currency", "billing_interval", "name", "description"))
        )
        if current.get("status") == "pending" and account.get("charges_enabled") and current.get("stripe_price_id"):
            update.setdefault("status", "active")
        if update:
            try:
                result = (
                    self.supabase.table("billing_plans")
                    .update(update)
                    .eq("id", plan_id)
                    .eq("studio_id", studio_id)
                    .execute()
                )
            except PostgrestAPIError as exc:
                if exc.code == "23505":
                    raise HTTPException(status_code=409, detail="A billing plan with this name already exists.") from exc
                raise
            if not result.data:
                raise HTTPException(status_code=404, detail="Billing plan not found.")
            current = result.data[0]
        if data.program_ids is not None:
            self._ensure_programs_in_studio(studio_id, data.program_ids)
            self._replace_plan_programs(studio_id, plan_id, data.program_ids)
        if should_sync_after_update:
            current = self._sync_plan_price(current, account)
        self._audit(studio_id, actor_id, "billing.plan_updated", plan_id, {"changes": update, "program_ids": data.program_ids})
        return self._plan_response(current, account)

    async def sync_plan(self, plan_id: str, studio_id: str, actor_id: str) -> BillingPlanResponse:
        plan = self._get_row_or_404("billing_plans", plan_id, studio_id, "Billing plan not found.")
        account = self._ensure_connect_ready(studio_id)
        plan = self._sync_plan_price(plan, account, force=True)
        self._audit(studio_id, actor_id, "billing.plan_synced", plan_id, {
            "stripe_account_id": account.get("stripe_connected_account_id"),
            "stripe_price_id": plan.get("stripe_price_id"),
        })
        return self._plan_response(plan, account)

    async def archive_plan(self, plan_id: str, studio_id: str, actor_id: str) -> BillingPlanResponse:
        self._get_row_or_404("billing_plans", plan_id, studio_id, "Billing plan not found.")
        result = (
            self.supabase.table("billing_plans")
            .update({"status": "archived", "archived_at": datetime.now(timezone.utc).isoformat()})
            .eq("id", plan_id)
            .eq("studio_id", studio_id)
            .execute()
        )
        if not result.data:
            raise HTTPException(status_code=404, detail="Billing plan not found.")
        self._audit(studio_id, actor_id, "billing.plan_archived", plan_id, {})
        return self._plan_response(result.data[0], self._connect_accounts().ensure_row(studio_id))

    def _sync_plan_price(self, plan: dict[str, Any], account: dict[str, Any], *, force: bool = False) -> dict[str, Any]:
        account_id = account.get("stripe_connected_account_id")
        if not account_id:
            return plan
        stripe_service = self.stripe_service_cls()
        product_id = plan.get("stripe_product_id")
        product_metadata = {"studio_id": plan["studio_id"], "billing_plan_id": plan["id"], "product": "koaryu_payments"}
        if product_id:
            stripe_service.update_connected_product(
                account_id=account_id,
                product_id=product_id,
                name=plan["name"],
                description=plan.get("description"),
                metadata=product_metadata,
            )
        else:
            product = stripe_service.create_connected_product(
                account_id=account_id,
                name=plan["name"],
                description=plan.get("description"),
                metadata=product_metadata,
                idempotency_key=self._idempotency_key("plan-product", plan["id"]),
            )
            product_id = _stripe_id(product)

        recurring, interval_count = self._stripe_recurring_for_interval(plan.get("billing_interval") or "monthly")
        active_price = self._find_plan_price(
            plan["studio_id"],
            plan["id"],
            account_id,
            int(plan.get("amount_cents") or 0),
            plan.get("currency") or "usd",
            plan.get("billing_interval") or "monthly",
            bool(recurring),
        )
        if active_price:
            stripe_price_id = active_price["stripe_price_id"]
            version = active_price.get("version") or plan.get("stripe_price_version") or 1
        else:
            version = int(plan.get("stripe_price_version") or 1)
            if plan.get("stripe_price_id"):
                version += 1
            lookup_key = f"koaryu_{plan['studio_id']}_{plan['id']}_v{version}"
            price = stripe_service.create_connected_price(
                account_id=account_id,
                product_id=product_id,
                unit_amount=int(plan.get("amount_cents") or 0),
                currency=plan.get("currency") or "usd",
                recurring=recurring,
                lookup_key=lookup_key,
                metadata={**product_metadata, "version": str(version), "billing_interval": plan.get("billing_interval") or "monthly"},
                idempotency_key=self._idempotency_key("plan-price", plan["id"], str(version), str(plan.get("amount_cents") or 0)),
            )
            stripe_price_id = _stripe_id(price)
            self.supabase.table("billing_plan_prices").insert({
                "studio_id": plan["studio_id"],
                "billing_plan_id": plan["id"],
                "stripe_account_id": account_id,
                "stripe_product_id": product_id,
                "stripe_price_id": stripe_price_id,
                "amount_cents": plan.get("amount_cents") or 0,
                "currency": plan.get("currency") or "usd",
                "billing_interval": plan.get("billing_interval") or "monthly",
                "interval_count": interval_count,
                "recurring": bool(recurring),
                "active": True,
                "version": version,
            }).execute()
        update = {
            "stripe_account_id": account_id,
            "stripe_product_id": product_id,
            "stripe_price_id": stripe_price_id,
            "stripe_price_lookup_key": f"koaryu_{plan['studio_id']}_{plan['id']}_v{version}",
            "stripe_price_version": version,
            "status": "active",
        }
        result = (
            self.supabase.table("billing_plans")
            .update(update)
            .eq("id", plan["id"])
            .eq("studio_id", plan["studio_id"])
            .execute()
        )
        return result.data[0] if result.data else {**plan, **update}

    def _find_plan_price(
        self,
        studio_id: str,
        plan_id: str,
        account_id: str,
        amount: int,
        currency: str,
        billing_interval: str,
        recurring: bool,
    ) -> Optional[dict[str, Any]]:
        result = (
            self.supabase.table("billing_plan_prices")
            .select("*")
            .eq("studio_id", studio_id)
            .eq("billing_plan_id", plan_id)
            .eq("stripe_account_id", account_id)
            .eq("amount_cents", amount)
            .eq("currency", currency)
            .eq("billing_interval", billing_interval)
            .eq("recurring", recurring)
            .eq("active", True)
            .order("created_at", desc=True)
            .limit(1)
            .execute()
        )
        return result.data[0] if result.data else None

    def _stripe_recurring_for_interval(self, billing_interval: str) -> tuple[Optional[dict[str, Any]], int]:
        if billing_interval == "paid_in_full":
            return None, 1
        if billing_interval == "annual":
            return {"interval": "year", "interval_count": 1}, 1
        if billing_interval == "weekly":
            return {"interval": "week", "interval_count": 1}, 1
        if billing_interval == "biweekly":
            return {"interval": "week", "interval_count": 2}, 2
        return {"interval": "month", "interval_count": 1}, 1

    def _plan_response(self, row: dict[str, Any], account: dict[str, Any]) -> BillingPlanResponse:
        programs = self._programs_for_plan(row["studio_id"], row["id"])
        can_accept = bool(account.get("charges_enabled")) and row.get("status") == "active" and bool(row.get("stripe_price_id"))
        pending_reason = None
        if not account.get("charges_enabled"):
            pending_reason = "Stripe Connect charges are not enabled yet."
        elif not row.get("stripe_price_id"):
            pending_reason = "Plan needs a Stripe price before hosted payments can start."
        elif row.get("status") == "pending":
            pending_reason = "Plan is waiting for payment setup before it can accept payments."
        return BillingPlanResponse(
            **row,
            programs=programs,
            can_accept_payments=can_accept,
            pending_reason=pending_reason,
        )

    def _programs_for_plan(self, studio_id: str, plan_id: str) -> list[BillingPlanProgramResponse]:
        result = (
            self.supabase.table("billing_plan_programs")
            .select("program_id, programs(name, color_hex)")
            .eq("studio_id", studio_id)
            .eq("billing_plan_id", plan_id)
            .execute()
        )
        programs: list[BillingPlanProgramResponse] = []
        for row in result.data or []:
            program = row.get("programs") or {}
            if isinstance(program, list):
                program = program[0] if program else {}
            programs.append(BillingPlanProgramResponse(
                program_id=row["program_id"],
                program_name=program.get("name"),
                program_color_hex=program.get("color_hex"),
            ))
        return programs

    def _replace_plan_programs(self, studio_id: str, plan_id: str, program_ids: list[str]) -> None:
        self.supabase.table("billing_plan_programs").delete().eq("studio_id", studio_id).eq("billing_plan_id", plan_id).execute()
        rows = [
            {"studio_id": studio_id, "billing_plan_id": plan_id, "program_id": program_id}
            for program_id in dict.fromkeys(program_ids)
        ]
        if rows:
            self.supabase.table("billing_plan_programs").insert(rows).execute()

    def _ensure_programs_in_studio(self, studio_id: str, program_ids: list[str]) -> None:
        unique_ids = list(dict.fromkeys(program_ids))
        if not unique_ids:
            return
        result = self.supabase.table("programs").select("id").eq("studio_id", studio_id).in_("id", unique_ids).execute()
        found = {row["id"] for row in (result.data or [])}
        if found != set(unique_ids):
            raise HTTPException(status_code=404, detail="One or more programs were not found in this studio.")
