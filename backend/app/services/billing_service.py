from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import HTTPException, status
from postgrest.exceptions import APIError as PostgrestAPIError
from supabase import Client

from app.core.config import get_settings
from app.schemas.billing import (
    BillingLinkResponse,
    BillingPaymentResponse,
    BillingPayerCreate,
    BillingPayerResponse,
    BillingPayerUpdate,
    BillingPlanCreate,
    BillingPlanProgramResponse,
    BillingPlanResponse,
    BillingPlanUpdate,
    BillingInvoiceResponse,
    ExportJobCreate,
    ExportJobResponse,
    ExternalPaymentCreate,
    StudentBillingEnrollmentCreate,
    StudentBillingEnrollmentResponse,
    StudioPaymentAccountResponse,
)
from app.services.stripe_service import StripeService


def _to_text(value: Any) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.isoformat()
    return str(value)


class BillingService:
    def __init__(self, supabase: Client):
        self.supabase = supabase
        self.settings = get_settings()

    async def get_payment_account(self, studio_id: str) -> StudioPaymentAccountResponse:
        return self._payment_account_response(self._ensure_payment_account_row(studio_id))

    async def create_connect_onboarding_link(
        self,
        studio_id: str,
        actor_id: str,
        refresh_url: Optional[str] = None,
        return_url: Optional[str] = None,
    ) -> BillingLinkResponse:
        account = self._ensure_payment_account_row(studio_id)
        studio = self._get_studio(studio_id)
        stripe_account_id = account.get("stripe_connected_account_id")
        stripe_service = StripeService()

        if not stripe_account_id:
            stripe_account = stripe_service.create_connect_account(
                studio_id=studio_id,
                business_name=studio.get("name") or "Koaryu studio",
            )
            stripe_account_id = stripe_account["id"] if isinstance(stripe_account, dict) else stripe_account.id
            account = self._update_payment_account(studio_id, {
                "stripe_connected_account_id": stripe_account_id,
                "status": "onboarding_incomplete",
            })

        frontend_url = self.settings.FRONTEND_URL.rstrip("/")
        link = stripe_service.create_connect_onboarding_link(
            account_id=stripe_account_id,
            refresh_url=refresh_url or f"{frontend_url}/billing?connect=refresh",
            return_url=return_url or f"{frontend_url}/billing?connect=return",
        )
        self._audit(studio_id, actor_id, "billing.connect_onboarding_started", studio_id, {"stripe_account_id": stripe_account_id})
        return BillingLinkResponse(url=link["url"] if isinstance(link, dict) else link.url)

    async def create_connect_dashboard_link(self, studio_id: str, actor_id: str) -> BillingLinkResponse:
        account = self._ensure_payment_account_row(studio_id)
        stripe_account_id = account.get("stripe_connected_account_id")
        if not stripe_account_id:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Connect Stripe before opening the Stripe dashboard.")
        link = StripeService().create_connect_dashboard_link(account_id=stripe_account_id)
        self._audit(studio_id, actor_id, "billing.connect_dashboard_opened", studio_id, {"stripe_account_id": stripe_account_id})
        return BillingLinkResponse(url=link["url"] if isinstance(link, dict) else link.url)

    async def list_plans(self, studio_id: str) -> list[BillingPlanResponse]:
        account = self._ensure_payment_account_row(studio_id)
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
        account = self._ensure_payment_account_row(studio_id)
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
        self._audit(studio_id, actor_id, "billing.plan_created", plan["id"], {"name": plan["name"], "program_ids": data.program_ids})
        return self._plan_response(plan, account)

    async def update_plan(self, plan_id: str, data: BillingPlanUpdate, studio_id: str, actor_id: str) -> BillingPlanResponse:
        current = self._get_row_or_404("billing_plans", plan_id, studio_id, "Billing plan not found.")
        update = data.model_dump(exclude_unset=True, exclude={"program_ids"})
        if "name" in update and update["name"]:
            update["name"] = " ".join(update["name"].strip().split())
        if "currency" in update and update["currency"]:
            update["currency"] = update["currency"].lower()
        account = self._ensure_payment_account_row(studio_id)
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
        self._audit(studio_id, actor_id, "billing.plan_updated", plan_id, {"changes": update, "program_ids": data.program_ids})
        return self._plan_response(current, account)

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
        return self._plan_response(result.data[0], self._ensure_payment_account_row(studio_id))

    async def list_payers(self, studio_id: str) -> list[BillingPayerResponse]:
        result = (
            self.supabase.table("billing_payers")
            .select("*")
            .eq("studio_id", studio_id)
            .order("display_name")
            .execute()
        )
        return [BillingPayerResponse(**row) for row in (result.data or [])]

    async def create_payer(self, data: BillingPayerCreate, studio_id: str, actor_id: str) -> BillingPayerResponse:
        row = data.model_dump()
        row["studio_id"] = studio_id
        if row.get("guardian_id"):
            self._ensure_record_in_studio("guardians", row["guardian_id"], studio_id, "Guardian not found.")
        result = self.supabase.table("billing_payers").insert(row).execute()
        if not result.data:
            raise HTTPException(status_code=500, detail="Failed to create payer.")
        self._audit(studio_id, actor_id, "billing.payer_created", result.data[0]["id"], {"display_name": data.display_name})
        return BillingPayerResponse(**result.data[0])

    async def get_payer(self, payer_id: str, studio_id: str) -> BillingPayerResponse:
        return BillingPayerResponse(**self._get_row_or_404("billing_payers", payer_id, studio_id, "Payer not found."))

    async def update_payer(self, payer_id: str, data: BillingPayerUpdate, studio_id: str, actor_id: str) -> BillingPayerResponse:
        self._get_row_or_404("billing_payers", payer_id, studio_id, "Payer not found.")
        update = data.model_dump(exclude_unset=True)
        if update.get("guardian_id"):
            self._ensure_record_in_studio("guardians", update["guardian_id"], studio_id, "Guardian not found.")
        if not update:
            return await self.get_payer(payer_id, studio_id)
        result = self.supabase.table("billing_payers").update(update).eq("id", payer_id).eq("studio_id", studio_id).execute()
        if not result.data:
            raise HTTPException(status_code=404, detail="Payer not found.")
        self._audit(studio_id, actor_id, "billing.payer_updated", payer_id, {"changes": update})
        return BillingPayerResponse(**result.data[0])

    async def list_invoices(self, studio_id: str) -> list[BillingInvoiceResponse]:
        result = (
            self.supabase.table("billing_invoices")
            .select("*")
            .eq("studio_id", studio_id)
            .order("created_at", desc=True)
            .limit(200)
            .execute()
        )
        return [BillingInvoiceResponse(**row) for row in (result.data or [])]

    async def list_student_billing(self, student_id: str, studio_id: str) -> list[StudentBillingEnrollmentResponse]:
        self._ensure_record_in_studio("students", student_id, studio_id, "Student not found.")
        result = (
            self.supabase.table("student_billing_enrollments")
            .select("*")
            .eq("studio_id", studio_id)
            .eq("student_id", student_id)
            .order("created_at", desc=True)
            .execute()
        )
        return [StudentBillingEnrollmentResponse(**row) for row in (result.data or [])]

    async def add_student_billing_enrollment(
        self,
        data: StudentBillingEnrollmentCreate,
        studio_id: str,
        actor_id: str,
    ) -> StudentBillingEnrollmentResponse:
        if not data.student_id:
            raise HTTPException(status_code=400, detail="Student is required for billing enrollment.")
        self._ensure_record_in_studio("students", data.student_id, studio_id, "Student not found.")
        self._ensure_record_in_studio("billing_plans", data.billing_plan_id, studio_id, "Billing plan not found.")
        if data.payer_id:
            self._ensure_record_in_studio("billing_payers", data.payer_id, studio_id, "Payer not found.")
        row = data.model_dump(exclude_none=True)
        row["studio_id"] = studio_id
        result = self.supabase.table("student_billing_enrollments").insert(row).execute()
        if not result.data:
            raise HTTPException(status_code=500, detail="Failed to add student billing enrollment.")
        self._audit(studio_id, actor_id, "billing.student_enrollment_created", result.data[0]["id"], {
            "student_id": data.student_id,
            "billing_plan_id": data.billing_plan_id,
            "payer_id": data.payer_id,
        })
        return StudentBillingEnrollmentResponse(**result.data[0])

    async def list_payments(self, studio_id: str) -> list[BillingPaymentResponse]:
        result = (
            self.supabase.table("billing_payments")
            .select("*")
            .eq("studio_id", studio_id)
            .order("created_at", desc=True)
            .limit(200)
            .execute()
        )
        return [BillingPaymentResponse(**row) for row in (result.data or [])]

    async def record_external_payment(self, data: ExternalPaymentCreate, studio_id: str, actor_id: str) -> BillingPaymentResponse:
        if data.payer_id:
            self._ensure_record_in_studio("billing_payers", data.payer_id, studio_id, "Payer not found.")
        if data.invoice_id:
            self._ensure_record_in_studio("billing_invoices", data.invoice_id, studio_id, "Invoice not found.")
        row = data.model_dump()
        row.update({
            "studio_id": studio_id,
            "status": "externally_recorded",
            "payment_method_type": "external",
            "processed_at": datetime.now(timezone.utc).isoformat(),
        })
        result = self.supabase.table("billing_payments").insert(row).execute()
        if not result.data:
            raise HTTPException(status_code=500, detail="Failed to record external payment.")
        self._audit(studio_id, actor_id, "billing.external_payment_recorded", result.data[0]["id"], {
            "amount_cents": data.amount_cents,
            "external_method": data.external_method,
        })
        return BillingPaymentResponse(**result.data[0])

    async def create_export_job(self, data: ExportJobCreate, studio_id: str, actor_id: str) -> ExportJobResponse:
        result = self.supabase.table("export_jobs").insert({
            "studio_id": studio_id,
            "export_type": data.export_type,
            "requested_by": actor_id,
            "metadata": {"filters": data.filters, "async_required": True},
        }).execute()
        if not result.data:
            raise HTTPException(status_code=500, detail="Failed to create export job.")
        self._audit(studio_id, actor_id, "billing.export_requested", result.data[0]["id"], {"export_type": data.export_type})
        return ExportJobResponse(**result.data[0])

    async def get_export_job(self, export_id: str, studio_id: str) -> ExportJobResponse:
        return ExportJobResponse(**self._get_row_or_404("export_jobs", export_id, studio_id, "Export job not found."))

    def project_connect_event(self, event: dict[str, Any]) -> None:
        event_type = event.get("type") or ""
        account_id = event.get("account")
        data_object = ((event.get("data") or {}).get("object") or {})
        if event_type == "account.application.deauthorized":
            account_id = account_id or data_object.get("id")
            self._update_payment_account_by_stripe_account(account_id, {
                "status": "deauthorized",
                "charges_enabled": False,
                "payouts_enabled": False,
            })
            return
        if event_type == "account.updated":
            account_id = account_id or data_object.get("id")
            requirements = data_object.get("requirements") or {}
            due = requirements.get("currently_due") or []
            charges_enabled = bool(data_object.get("charges_enabled"))
            details_submitted = bool(data_object.get("details_submitted"))
            status_value = "charges_enabled" if charges_enabled else ("action_required" if due else "onboarding_incomplete")
            self._update_payment_account_by_stripe_account(account_id, {
                "status": status_value,
                "charges_enabled": charges_enabled,
                "payouts_enabled": bool(data_object.get("payouts_enabled")),
                "details_submitted": details_submitted,
                "requirements_due": due,
            })

    def _ensure_payment_account_row(self, studio_id: str) -> dict[str, Any]:
        result = (
            self.supabase.table("studio_payment_accounts")
            .select("*")
            .eq("studio_id", studio_id)
            .limit(1)
            .execute()
        )
        if result.data:
            return result.data[0]
        insert_result = self.supabase.table("studio_payment_accounts").insert({"studio_id": studio_id}).execute()
        if not insert_result.data:
            raise HTTPException(status_code=500, detail="Failed to initialize payment account.")
        return insert_result.data[0]

    def _update_payment_account(self, studio_id: str, update: dict[str, Any]) -> dict[str, Any]:
        result = self.supabase.table("studio_payment_accounts").update(update).eq("studio_id", studio_id).execute()
        if not result.data:
            raise HTTPException(status_code=404, detail="Payment account not found.")
        return result.data[0]

    def _update_payment_account_by_stripe_account(self, account_id: Optional[str], update: dict[str, Any]) -> None:
        if not account_id:
            return
        self.supabase.table("studio_payment_accounts").update(update).eq("stripe_connected_account_id", account_id).execute()

    def _payment_account_response(self, row: dict[str, Any]) -> StudioPaymentAccountResponse:
        return StudioPaymentAccountResponse(
            studio_id=row["studio_id"],
            stripe_connected_account_id=row.get("stripe_connected_account_id"),
            status=row.get("status") or "not_connected",
            charges_enabled=bool(row.get("charges_enabled")),
            payouts_enabled=bool(row.get("payouts_enabled")),
            details_submitted=bool(row.get("details_submitted")),
            requirements_due=row.get("requirements_due") or [],
            platform_fee_bps=row.get("platform_fee_bps") or self.settings.BILLING_PLATFORM_FEE_BPS,
            created_at=_to_text(row.get("created_at")),
            updated_at=_to_text(row.get("updated_at")),
        )

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

    def _ensure_record_in_studio(self, table: str, record_id: str, studio_id: str, detail: str) -> None:
        result = self.supabase.table(table).select("id").eq("id", record_id).eq("studio_id", studio_id).limit(1).execute()
        if not result.data:
            raise HTTPException(status_code=404, detail=detail)

    def _get_row_or_404(self, table: str, record_id: str, studio_id: str, detail: str) -> dict[str, Any]:
        result = self.supabase.table(table).select("*").eq("id", record_id).eq("studio_id", studio_id).maybe_single().execute()
        if not result.data:
            raise HTTPException(status_code=404, detail=detail)
        return result.data

    def _get_studio(self, studio_id: str) -> dict[str, Any]:
        result = self.supabase.table("studios").select("id, name").eq("id", studio_id).single().execute()
        if not result.data:
            raise HTTPException(status_code=404, detail="Studio not found.")
        return result.data

    def _audit(self, studio_id: str, actor_id: str, action: str, entity_id: str, metadata: dict[str, Any]) -> None:
        self.supabase.table("audit_logs").insert({
            "studio_id": studio_id,
            "actor_id": actor_id,
            "action": action,
            "entity_type": "billing",
            "entity_id": entity_id,
            "metadata": metadata,
        }).execute()
