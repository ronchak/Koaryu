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
from app.services.billing_plan_sync import BillingPlanSyncWorkflow
from app.services.billing_currency_policy import NEW_TUITION_CURRENCY_DETAIL, is_usd_currency
from app.services.stripe_service import StripeService
from app.services.supabase_rpc import execute_required_rpc, first_rpc_row


class BillingPlanManager:
    def __init__(
        self, billing_service: Any, *, stripe_service_cls: type[StripeService] = StripeService
    ):
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

    def _audit(
        self, studio_id: str, actor_id: str, action: str, entity_id: str, metadata: dict[str, Any]
    ) -> None:
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

    async def create_plan(
        self, data: BillingPlanCreate, studio_id: str, actor_id: str
    ) -> BillingPlanResponse:
        return self._write_plan(data, studio_id, actor_id, plan_id=None)

    async def update_plan(
        self, plan_id: str, data: BillingPlanUpdate, studio_id: str, actor_id: str
    ) -> BillingPlanResponse:
        if not plan_id:
            raise HTTPException(status_code=404, detail="Billing plan not found.")
        return self._write_plan(data, studio_id, actor_id, plan_id=plan_id)

    def _write_plan(
        self,
        data: BillingPlanCreate | BillingPlanUpdate,
        studio_id: str,
        actor_id: str,
        *,
        plan_id: str | None,
    ) -> BillingPlanResponse:
        values = data.model_dump(
            mode="json", exclude_unset=plan_id is not None, exclude={"program_ids"}
        )
        if "name" in values:
            values["name"] = " ".join(values["name"].split())
            if not values["name"]:
                raise HTTPException(status_code=400, detail="Billing plan name is required.")
        account = self._connect_accounts().ensure_row(studio_id)
        try:
            result = execute_required_rpc(
                self.supabase,
                "write_billing_plan_v1",
                {
                    "p_studio_id": studio_id,
                    "p_actor_id": actor_id,
                    "p_plan_id": plan_id,
                    "p_values": values,
                    "p_program_ids": data.program_ids,
                },
            )
        except PostgrestAPIError as exc:
            if exc.code == "23505":
                raise HTTPException(
                    status_code=409, detail="A billing plan with this name already exists."
                ) from exc
            rejection = {
                ("P0002", "billing_plan_not_found"): (404, "Billing plan not found."),
                ("P0002", "billing_plan_program_not_found"): (
                    404,
                    "One or more programs were not found in this studio.",
                ),
                ("22023", "billing_plan_invalid_request"): (400, "Invalid billing plan request."),
                ("22023", "billing_plan_requires_usd"): (
                    400,
                    "New tuition plan definitions must use USD.",
                ),
                ("42501", "billing_plan_actor_not_active"): (
                    403,
                    "Only studio admins can manage billing setup.",
                ),
            }.get((exc.code, exc.message))
            if rejection:
                raise HTTPException(status_code=rejection[0], detail=rejection[1]) from exc
            raise
        saved = first_rpc_row(result)
        if (
            not saved
            or not isinstance(saved.get("plan"), dict)
            or not isinstance(saved.get("programs"), list)
        ):
            raise HTTPException(
                status_code=500, detail="Billing plan save confirmation is unavailable."
            )
        programs = [
            BillingPlanProgramResponse.model_validate(program) for program in saved["programs"]
        ]
        return self._plan_response(saved["plan"], account, programs=programs)

    async def sync_plan(
        self,
        plan_id: str,
        studio_id: str,
        actor_id: str,
        idempotency_key: str | None = None,
    ) -> BillingPlanResponse:
        return await BillingPlanSyncWorkflow(
            self,
            stripe_service_cls=self.stripe_service_cls,
        ).sync_plan(
            plan_id,
            studio_id,
            actor_id,
            idempotency_key,
        )

    async def archive_plan(
        self, plan_id: str, studio_id: str, actor_id: str
    ) -> BillingPlanResponse:
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

    def _stripe_recurring_for_interval(
        self, billing_interval: str
    ) -> tuple[Optional[dict[str, Any]], int]:
        if billing_interval == "paid_in_full":
            return None, 1
        if billing_interval == "annual":
            return {"interval": "year", "interval_count": 1}, 1
        if billing_interval == "weekly":
            return {"interval": "week", "interval_count": 1}, 1
        if billing_interval == "biweekly":
            return {"interval": "week", "interval_count": 2}, 2
        return {"interval": "month", "interval_count": 1}, 1

    def _plan_response(
        self,
        row: dict[str, Any],
        account: dict[str, Any],
        *,
        programs: list[BillingPlanProgramResponse] | None = None,
    ) -> BillingPlanResponse:
        if programs is None:
            programs = self._programs_for_plan(row["studio_id"], row["id"])
        is_usd = is_usd_currency(row.get("currency"))
        can_accept = (
            is_usd
            and bool(account.get("charges_enabled"))
            and row.get("status") == "active"
            and bool(row.get("stripe_price_id"))
        )
        pending_reason = None
        if not is_usd:
            pending_reason = NEW_TUITION_CURRENCY_DETAIL
        elif not account.get("charges_enabled"):
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
            programs.append(
                BillingPlanProgramResponse(
                    program_id=row["program_id"],
                    program_name=program.get("name"),
                    program_color_hex=program.get("color_hex"),
                )
            )
        return programs
