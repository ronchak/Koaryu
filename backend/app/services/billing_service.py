from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone
from typing import Any, Optional

from fastapi import HTTPException, status
from postgrest.exceptions import APIError as PostgrestAPIError
from supabase import Client

from app.core.config import get_settings
from app.schemas.billing import (
    BillingDisputeResponse,
    BillingInvoiceCreate,
    BillingLinkResponse,
    BillingPaymentResponse,
    BillingPayerCreate,
    BillingPayerAutopaySetupRequest,
    BillingPayerResponse,
    BillingPayerUpdate,
    BillingPlanCreate,
    BillingPlanProgramResponse,
    BillingPlanResponse,
    BillingPlanUpdate,
    BillingRefundCreate,
    BillingRefundResponse,
    BillingInvoiceResponse,
    BillingSubscriptionResponse,
    ExportJobCreate,
    ExportJobResponse,
    ExternalPaymentCreate,
    StudentBillingEnrollmentCreate,
    StudentBillingEnrollmentResponse,
    StudentBillingEnrollmentUpdate,
    StudioPaymentAccountResponse,
)
from app.services.stripe_service import StripeService


def _to_text(value: Any) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.isoformat()
    return str(value)


def _stripe_id(value: Any) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        return value.get("id")
    return getattr(value, "id", None)


def _object_get(value: Any, key: str, default: Any = None) -> Any:
    if value is None:
        return default
    if isinstance(value, dict):
        return value.get(key, default)
    return getattr(value, key, default)


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
                contact_email=self._get_user_email(actor_id) or self._get_user_email(studio.get("owner_id")),
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
        url = StripeService().create_connect_dashboard_url(account_id=stripe_account_id)
        self._audit(studio_id, actor_id, "billing.connect_dashboard_opened", studio_id, {"stripe_account_id": stripe_account_id})
        return BillingLinkResponse(url=url)

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
        if account.get("charges_enabled"):
            self._validate_connect_account_access(account)
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
        account = self._ensure_payment_account_row(studio_id)
        should_sync_after_update = account.get("charges_enabled") and (
            not current.get("stripe_price_id")
            or any(key in update for key in ("amount_cents", "currency", "billing_interval", "name", "description"))
        )
        if should_sync_after_update:
            self._validate_connect_account_access(account)
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
        account = self._ensure_payment_account_row(studio_id)
        if account.get("charges_enabled"):
            self._validate_connect_account_access(account)
        result = self.supabase.table("billing_payers").insert(row).execute()
        if not result.data:
            raise HTTPException(status_code=500, detail="Failed to create payer.")
        payer = result.data[0]
        if account.get("charges_enabled"):
            payer = self._sync_payer_customer(payer, account)
        self._audit(studio_id, actor_id, "billing.payer_created", payer["id"], {"display_name": data.display_name})
        return BillingPayerResponse(**payer)

    async def get_payer(self, payer_id: str, studio_id: str) -> BillingPayerResponse:
        return BillingPayerResponse(**self._get_row_or_404("billing_payers", payer_id, studio_id, "Payer not found."))

    async def update_payer(self, payer_id: str, data: BillingPayerUpdate, studio_id: str, actor_id: str) -> BillingPayerResponse:
        self._get_row_or_404("billing_payers", payer_id, studio_id, "Payer not found.")
        update = data.model_dump(exclude_unset=True)
        if update.get("guardian_id"):
            self._ensure_record_in_studio("guardians", update["guardian_id"], studio_id, "Guardian not found.")
        if not update:
            return await self.get_payer(payer_id, studio_id)
        account = self._ensure_payment_account_row(studio_id)
        if account.get("charges_enabled"):
            self._validate_connect_account_access(account)
        result = self.supabase.table("billing_payers").update(update).eq("id", payer_id).eq("studio_id", studio_id).execute()
        if not result.data:
            raise HTTPException(status_code=404, detail="Payer not found.")
        payer = result.data[0]
        if account.get("charges_enabled"):
            payer = self._sync_payer_customer(payer, account)
        self._audit(studio_id, actor_id, "billing.payer_updated", payer_id, {"changes": update})
        return BillingPayerResponse(**payer)

    async def sync_payer(self, payer_id: str, studio_id: str, actor_id: str) -> BillingPayerResponse:
        payer = self._get_row_or_404("billing_payers", payer_id, studio_id, "Payer not found.")
        account = self._ensure_connect_ready(studio_id)
        payer = self._sync_payer_customer(payer, account)
        self._audit(studio_id, actor_id, "billing.payer_synced", payer_id, {
            "stripe_account_id": account.get("stripe_connected_account_id"),
            "stripe_customer_id": payer.get("stripe_customer_id"),
        })
        return BillingPayerResponse(**payer)

    async def create_autopay_setup_link(
        self,
        payer_id: str,
        data: BillingPayerAutopaySetupRequest,
        studio_id: str,
        actor_id: str,
    ) -> BillingLinkResponse:
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
        link = StripeService().create_setup_checkout_session(
            account_id=account["stripe_connected_account_id"],
            customer_id=payer["stripe_customer_id"],
            success_url=data.success_url or data.return_url or f"{frontend_url}/billing?autopay=success",
            cancel_url=data.cancel_url or data.return_url or f"{frontend_url}/billing?autopay=cancelled",
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
        self._audit(studio_id, actor_id, "billing.autopay_disabled", payer_id, {})
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

    async def list_subscriptions(self, studio_id: str) -> list[BillingSubscriptionResponse]:
        result = (
            self.supabase.table("billing_subscriptions")
            .select("*")
            .eq("studio_id", studio_id)
            .order("created_at", desc=True)
            .limit(200)
            .execute()
        )
        return [BillingSubscriptionResponse(**row) for row in (result.data or [])]

    async def list_enrollments(self, studio_id: str) -> list[StudentBillingEnrollmentResponse]:
        result = (
            self.supabase.table("student_billing_enrollments")
            .select("*")
            .eq("studio_id", studio_id)
            .order("created_at", desc=True)
            .limit(300)
            .execute()
        )
        return [StudentBillingEnrollmentResponse(**row) for row in (result.data or [])]

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
        plan = self._get_row_or_404("billing_plans", data.billing_plan_id, studio_id, "Billing plan not found.")
        if data.collection_mode != "external" and plan.get("billing_interval") == "fixed_term" and not data.end_date:
            raise HTTPException(status_code=400, detail="Fixed-term billing requires an end date.")
        row = data.model_dump(exclude_none=True)
        row["studio_id"] = studio_id
        row.setdefault("billing_status", "externally_paid" if data.collection_mode == "external" else "no_payment_method")
        result = self.supabase.table("student_billing_enrollments").insert(row).execute()
        if not result.data:
            raise HTTPException(status_code=500, detail="Failed to add student billing enrollment.")
        enrollment = result.data[0]
        if data.collection_mode != "external":
            enrollment = self._activate_stripe_enrollment(enrollment, plan, studio_id)
        else:
            self._recompute_payer_balance(studio_id, data.payer_id)
        self._audit(studio_id, actor_id, "billing.student_enrollment_created", result.data[0]["id"], {
            "student_id": data.student_id,
            "billing_plan_id": data.billing_plan_id,
            "payer_id": data.payer_id,
            "collection_mode": data.collection_mode,
        })
        return StudentBillingEnrollmentResponse(**enrollment)

    async def update_enrollment(
        self,
        enrollment_id: str,
        data: StudentBillingEnrollmentUpdate,
        studio_id: str,
        actor_id: str,
    ) -> StudentBillingEnrollmentResponse:
        current = self._get_row_or_404("student_billing_enrollments", enrollment_id, studio_id, "Billing enrollment not found.")
        update = data.model_dump(exclude_unset=True)
        if update.get("billing_plan_id"):
            self._ensure_record_in_studio("billing_plans", update["billing_plan_id"], studio_id, "Billing plan not found.")
        if update.get("payer_id"):
            self._ensure_record_in_studio("billing_payers", update["payer_id"], studio_id, "Payer not found.")
        stripe_rewire = any(key in update for key in ("billing_plan_id", "payer_id", "collection_mode"))
        if stripe_rewire and current.get("stripe_subscription_item_id"):
            self._detach_enrollment_from_subscription(current)
        if update:
            result = (
                self.supabase.table("student_billing_enrollments")
                .update(update)
                .eq("id", enrollment_id)
                .eq("studio_id", studio_id)
                .execute()
            )
            if not result.data:
                raise HTTPException(status_code=404, detail="Billing enrollment not found.")
            current = result.data[0]
        if stripe_rewire and current.get("collection_mode") != "external" and current.get("status") in {"pending", "active"}:
            plan = self._get_row_or_404("billing_plans", current["billing_plan_id"], studio_id, "Billing plan not found.")
            current = self._activate_stripe_enrollment(current, plan, studio_id)
        self._audit(studio_id, actor_id, "billing.student_enrollment_updated", enrollment_id, {"changes": update})
        return StudentBillingEnrollmentResponse(**current)

    async def set_enrollment_status(
        self,
        enrollment_id: str,
        status_value: str,
        studio_id: str,
        actor_id: str,
    ) -> StudentBillingEnrollmentResponse:
        current = self._get_row_or_404("student_billing_enrollments", enrollment_id, studio_id, "Billing enrollment not found.")
        update: dict[str, Any] = {"status": status_value}
        if status_value in {"paused", "canceled", "ended"}:
            self._detach_enrollment_from_subscription(current)
            update["stripe_subscription_item_id"] = None
            update["billing_status"] = "externally_paid" if current.get("collection_mode") == "external" else "upcoming"
        if status_value == "active" and current.get("collection_mode") != "external" and not current.get("stripe_subscription_item_id"):
            plan = self._get_row_or_404("billing_plans", current["billing_plan_id"], studio_id, "Billing plan not found.")
            current = self._activate_stripe_enrollment({**current, "status": "active"}, plan, studio_id)
        result = (
            self.supabase.table("student_billing_enrollments")
            .update(update)
            .eq("id", enrollment_id)
            .eq("studio_id", studio_id)
            .execute()
        )
        if not result.data:
            raise HTTPException(status_code=404, detail="Billing enrollment not found.")
        self._audit(studio_id, actor_id, f"billing.student_enrollment_{status_value}", enrollment_id, {})
        return StudentBillingEnrollmentResponse(**result.data[0])

    async def create_invoice(self, data: BillingInvoiceCreate, studio_id: str, actor_id: str) -> BillingInvoiceResponse:
        payer = self._get_row_or_404("billing_payers", data.payer_id, studio_id, "Payer not found.")
        if data.student_id:
            self._ensure_record_in_studio("students", data.student_id, studio_id, "Student not found.")
        if data.enrollment_id:
            self._ensure_record_in_studio("student_billing_enrollments", data.enrollment_id, studio_id, "Billing enrollment not found.")
        account = self._ensure_connect_ready(studio_id)
        payer = self._sync_payer_customer(payer, account)
        if data.collection_mode == "autopay" and not payer.get("default_payment_method_id"):
            raise HTTPException(status_code=409, detail="Autopay requires a saved payer payment method.")

        if not data.items and not data.amount_cents:
            raise HTTPException(status_code=400, detail="Invoice needs at least one line item or amount.")
        items = [item.model_dump() for item in data.items] if data.items else [
            {
                "description": data.description or "Tuition invoice",
                "amount_cents": data.amount_cents or 0,
                "quantity": 1,
                "student_id": data.student_id,
                "enrollment_id": data.enrollment_id,
            }
        ]
        amount_due = sum(int(item["amount_cents"]) * int(item.get("quantity") or 1) for item in items)
        application_fee = self._application_fee_amount(amount_due, account)
        invoice_row = {
            "studio_id": studio_id,
            "payer_id": data.payer_id,
            "student_id": data.student_id,
            "enrollment_id": data.enrollment_id,
            "invoice_type": data.invoice_type,
            "status": "draft",
            "amount_due_cents": amount_due,
            "amount_paid_cents": 0,
            "amount_remaining_cents": amount_due,
            "currency": data.currency,
            "due_date": data.due_date,
            "stripe_account_id": account["stripe_connected_account_id"],
            "stripe_customer_id": payer.get("stripe_customer_id"),
            "collection_method": "charge_automatically" if data.collection_mode == "autopay" else "send_invoice",
            "application_fee_amount_cents": application_fee,
            "external": False,
        }
        inserted = self.supabase.table("billing_invoices").insert(invoice_row).execute()
        if not inserted.data:
            raise HTTPException(status_code=500, detail="Failed to create invoice.")
        local_invoice = inserted.data[0]

        stripe_service = StripeService()
        stripe_invoice = stripe_service.create_connected_invoice(
            account_id=account["stripe_connected_account_id"],
            customer_id=payer["stripe_customer_id"],
            collection_method=invoice_row["collection_method"],
            application_fee_amount=application_fee,
            default_payment_method=payer.get("default_payment_method_id") if data.collection_mode == "autopay" else None,
            due_date=self._date_to_epoch(data.due_date) if data.due_date else None,
            days_until_due=7,
            metadata={
                "studio_id": studio_id,
                "payer_id": data.payer_id,
                "invoice_id": local_invoice["id"],
                "product": "koaryu_payments",
            },
            idempotency_key=self._idempotency_key("invoice", local_invoice["id"]),
        )
        stripe_invoice_id = _stripe_id(stripe_invoice)
        for index, item in enumerate(items):
            amount = int(item["amount_cents"]) * int(item.get("quantity") or 1)
            metadata = {
                "studio_id": studio_id,
                "invoice_id": local_invoice["id"],
                "student_id": item.get("student_id") or "",
                "enrollment_id": item.get("enrollment_id") or "",
                "billing_plan_id": item.get("billing_plan_id") or "",
            }
            stripe_item = stripe_service.create_connected_invoice_item(
                account_id=account["stripe_connected_account_id"],
                customer_id=payer["stripe_customer_id"],
                amount=amount,
                currency=data.currency,
                description=item["description"],
                metadata=metadata,
                idempotency_key=self._idempotency_key("invoice-item", local_invoice["id"], str(index)),
                invoice_id=stripe_invoice_id,
            )
            self.supabase.table("billing_invoice_items").insert({
                "studio_id": studio_id,
                "invoice_id": local_invoice["id"],
                "student_id": item.get("student_id"),
                "enrollment_id": item.get("enrollment_id"),
                "billing_plan_id": item.get("billing_plan_id"),
                "description": item["description"],
                "quantity": item.get("quantity") or 1,
                "unit_amount_cents": item["amount_cents"],
                "amount_cents": amount,
                "stripe_invoice_item_id": _stripe_id(stripe_item),
                "metadata": metadata,
            }).execute()

        stripe_invoice = stripe_service.retrieve_connected_invoice(
            account_id=account["stripe_connected_account_id"],
            invoice_id=stripe_invoice_id,
        )
        local_invoice = self._update_invoice_from_stripe(local_invoice["id"], studio_id, stripe_invoice, account["stripe_connected_account_id"])
        if data.send_hosted_invoice:
            local_invoice = (await self.finalize_invoice(local_invoice["id"], studio_id, actor_id)).model_dump()
        self._audit(studio_id, actor_id, "billing.invoice_created", local_invoice["id"], {
            "amount_due_cents": amount_due,
            "stripe_invoice_id": local_invoice.get("stripe_invoice_id"),
        })
        self._recompute_payer_balance(studio_id, data.payer_id)
        return BillingInvoiceResponse(**local_invoice)

    async def finalize_invoice(self, invoice_id: str, studio_id: str, actor_id: str) -> BillingInvoiceResponse:
        invoice = self._get_row_or_404("billing_invoices", invoice_id, studio_id, "Invoice not found.")
        if not invoice.get("stripe_invoice_id") or not invoice.get("stripe_account_id"):
            raise HTTPException(status_code=409, detail="Invoice is not linked to Stripe.")
        stripe_service = StripeService()
        stripe_invoice = stripe_service.finalize_connected_invoice(
            account_id=invoice["stripe_account_id"],
            invoice_id=invoice["stripe_invoice_id"],
        )
        send_error = None
        if _object_get(stripe_invoice, "collection_method") == "send_invoice":
            try:
                stripe_invoice = stripe_service.send_connected_invoice(
                    account_id=invoice["stripe_account_id"],
                    invoice_id=invoice["stripe_invoice_id"],
                )
            except Exception as exc:
                send_error = f"Stripe finalized the hosted invoice but could not send email: {exc}"
        invoice = self._update_invoice_from_stripe(invoice_id, studio_id, stripe_invoice, invoice["stripe_account_id"])
        if send_error:
            result = (
                self.supabase.table("billing_invoices")
                .update({"last_payment_error": send_error})
                .eq("id", invoice_id)
                .eq("studio_id", studio_id)
                .execute()
            )
            if result.data:
                invoice = result.data[0]
        self._audit(studio_id, actor_id, "billing.invoice_finalized", invoice_id, {})
        return BillingInvoiceResponse(**invoice)

    async def retry_invoice_payment(self, invoice_id: str, studio_id: str, actor_id: str) -> BillingInvoiceResponse:
        invoice = self._get_row_or_404("billing_invoices", invoice_id, studio_id, "Invoice not found.")
        if not invoice.get("stripe_invoice_id") or not invoice.get("stripe_account_id"):
            raise HTTPException(status_code=409, detail="Invoice is not linked to Stripe.")
        stripe_invoice = StripeService().pay_connected_invoice(
            account_id=invoice["stripe_account_id"],
            invoice_id=invoice["stripe_invoice_id"],
        )
        invoice = self._update_invoice_from_stripe(invoice_id, studio_id, stripe_invoice, invoice["stripe_account_id"])
        self._audit(studio_id, actor_id, "billing.invoice_retry_requested", invoice_id, {})
        return BillingInvoiceResponse(**invoice)

    async def void_invoice(self, invoice_id: str, studio_id: str, actor_id: str) -> BillingInvoiceResponse:
        invoice = self._get_row_or_404("billing_invoices", invoice_id, studio_id, "Invoice not found.")
        if invoice.get("stripe_invoice_id") and invoice.get("stripe_account_id"):
            stripe_invoice = StripeService().void_connected_invoice(
                account_id=invoice["stripe_account_id"],
                invoice_id=invoice["stripe_invoice_id"],
            )
            invoice = self._update_invoice_from_stripe(invoice_id, studio_id, stripe_invoice, invoice["stripe_account_id"])
        else:
            result = (
                self.supabase.table("billing_invoices")
                .update({"status": "void", "voided_at": datetime.now(timezone.utc).isoformat()})
                .eq("id", invoice_id)
                .eq("studio_id", studio_id)
                .execute()
            )
            invoice = result.data[0]
        self._audit(studio_id, actor_id, "billing.invoice_voided", invoice_id, {})
        self._recompute_payer_balance(studio_id, invoice.get("payer_id"))
        return BillingInvoiceResponse(**invoice)

    async def reconcile_invoice(self, invoice_id: str, studio_id: str, actor_id: str) -> BillingInvoiceResponse:
        invoice = self._get_row_or_404("billing_invoices", invoice_id, studio_id, "Invoice not found.")
        if not invoice.get("stripe_invoice_id") or not invoice.get("stripe_account_id"):
            raise HTTPException(status_code=409, detail="Invoice is not linked to Stripe.")
        stripe_invoice = StripeService().retrieve_connected_invoice(
            account_id=invoice["stripe_account_id"],
            invoice_id=invoice["stripe_invoice_id"],
            expand=["payment_intent"],
        )
        invoice = self._update_invoice_from_stripe(invoice_id, studio_id, stripe_invoice, invoice["stripe_account_id"])
        self._audit(studio_id, actor_id, "billing.invoice_reconciled", invoice_id, {})
        self._recompute_payer_balance(studio_id, invoice.get("payer_id"))
        return BillingInvoiceResponse(**invoice)

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
        if data.invoice_id:
            invoice = self._get_row_or_404("billing_invoices", data.invoice_id, studio_id, "Invoice not found.")
            amount_paid = int(invoice.get("amount_paid_cents") or 0) + data.amount_cents
            amount_due = int(invoice.get("amount_due_cents") or 0)
            invoice_update = {
                "amount_paid_cents": min(amount_paid, amount_due),
                "amount_remaining_cents": max(0, amount_due - amount_paid),
                "status": "paid" if amount_paid >= amount_due else invoice.get("status", "open"),
                "paid_at": datetime.now(timezone.utc).isoformat() if amount_paid >= amount_due else invoice.get("paid_at"),
                "external": True,
            }
            if amount_paid >= amount_due:
                invoice_update["application_fee_amount_cents"] = 0
            if amount_paid >= amount_due and invoice.get("stripe_invoice_id") and invoice.get("stripe_account_id"):
                try:
                    StripeService().pay_connected_invoice(
                        account_id=invoice["stripe_account_id"],
                        invoice_id=invoice["stripe_invoice_id"],
                        paid_out_of_band=True,
                    )
                except Exception:
                    pass
            self.supabase.table("billing_invoices").update(invoice_update).eq("id", data.invoice_id).eq("studio_id", studio_id).execute()
            self._recompute_payer_balance(studio_id, invoice.get("payer_id"))
        elif data.payer_id:
            self._recompute_payer_balance(studio_id, data.payer_id)
        self._audit(studio_id, actor_id, "billing.external_payment_recorded", result.data[0]["id"], {
            "amount_cents": data.amount_cents,
            "external_method": data.external_method,
        })
        return BillingPaymentResponse(**result.data[0])

    async def refund_payment(
        self,
        payment_id: str,
        data: BillingRefundCreate,
        studio_id: str,
        actor_id: str,
    ) -> BillingRefundResponse:
        payment = self._get_row_or_404("billing_payments", payment_id, studio_id, "Payment not found.")
        if not payment.get("stripe_charge_id") or not payment.get("stripe_account_id"):
            raise HTTPException(status_code=409, detail="Only Stripe payments can be refunded through Koaryu.")
        amount = data.amount_cents or max(0, int(payment.get("amount_cents") or 0) - int(payment.get("refunded_amount_cents") or 0))
        refund = StripeService().create_connected_refund(
            account_id=payment["stripe_account_id"],
            charge_id=payment["stripe_charge_id"],
            amount=amount,
            reason=data.reason,
            refund_application_fee=True,
            metadata={"studio_id": studio_id, "payment_id": payment_id, "product": "koaryu_payments"},
            idempotency_key=self._idempotency_key("refund", payment_id, str(amount)),
        )
        row = self._project_refund(refund, payment["stripe_account_id"])
        self._audit(studio_id, actor_id, "billing.payment_refunded", payment_id, {
            "amount_cents": amount,
            "stripe_refund_id": row.get("stripe_refund_id"),
        })
        return BillingRefundResponse(**row)

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
            return
        if event_type == "checkout.session.completed":
            self._project_checkout_session(data_object, account_id)
            return
        if event_type in {
            "invoice.created",
            "invoice.finalized",
            "invoice.paid",
            "invoice.payment_failed",
            "invoice.voided",
            "invoice.marked_uncollectible",
        }:
            self._project_invoice_event(data_object, account_id, event_type)
            return
        if event_type in {
            "payment_intent.processing",
            "payment_intent.succeeded",
            "payment_intent.payment_failed",
        }:
            self._project_payment_intent(data_object, account_id, event_type)
            return
        if event_type == "charge.refunded":
            self._project_charge_refund(data_object, account_id)
            return
        if event_type.startswith("charge.dispute."):
            self._project_dispute(data_object, account_id)
            return
        if event_type.startswith("customer.subscription."):
            self._project_subscription(data_object, account_id, event_type)
            return

    def _ensure_connect_ready(self, studio_id: str) -> dict[str, Any]:
        account = self._ensure_payment_account_row(studio_id)
        if not account.get("stripe_connected_account_id"):
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Connect Stripe before using hosted payments.")
        if not account.get("charges_enabled"):
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Stripe Connect charges are not enabled yet.")
        self._validate_connect_account_access(account)
        return account

    def _validate_connect_account_access(self, account: dict[str, Any]) -> None:
        account_id = account.get("stripe_connected_account_id")
        if account_id:
            StripeService().retrieve_account(account_id=account_id)

    def _sync_plan_price(self, plan: dict[str, Any], account: dict[str, Any], *, force: bool = False) -> dict[str, Any]:
        account_id = account.get("stripe_connected_account_id")
        if not account_id:
            return plan
        stripe_service = StripeService()
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

    def _sync_payer_customer(self, payer: dict[str, Any], account: dict[str, Any]) -> dict[str, Any]:
        account_id = account.get("stripe_connected_account_id")
        if not account_id:
            return payer
        stripe_service = StripeService()
        metadata = {"studio_id": payer["studio_id"], "payer_id": payer["id"], "product": "koaryu_payments"}
        address = {
            "line1": payer.get("address_line1"),
            "city": payer.get("address_city"),
            "state": payer.get("address_state"),
            "postal_code": payer.get("address_zip"),
        }
        customer_id = payer.get("stripe_customer_id")
        if customer_id:
            stripe_service.update_connected_customer(
                account_id=account_id,
                customer_id=customer_id,
                name=payer.get("display_name") or "Koaryu payer",
                email=payer.get("email"),
                phone=payer.get("phone"),
                address=address,
                metadata=metadata,
            )
        else:
            customer = stripe_service.create_connected_customer(
                account_id=account_id,
                name=payer.get("display_name") or "Koaryu payer",
                email=payer.get("email"),
                phone=payer.get("phone"),
                address=address,
                metadata=metadata,
                idempotency_key=self._idempotency_key("payer-customer", payer["id"]),
            )
            customer_id = _stripe_id(customer)
        customer = stripe_service.retrieve_connected_customer(
            account_id=account_id,
            customer_id=customer_id,
            expand=["invoice_settings.default_payment_method"],
        )
        payment_fields = self._payment_method_fields_from_customer(customer)
        update = {
            "stripe_account_id": account_id,
            "stripe_customer_id": customer_id,
            **payment_fields,
        }
        if payment_fields.get("default_payment_method_id") and payer.get("autopay_status") in {"not_configured", "pending"}:
            update["autopay_status"] = "enabled"
            update["autopay_authorized_at"] = datetime.now(timezone.utc).isoformat()
        result = (
            self.supabase.table("billing_payers")
            .update(update)
            .eq("id", payer["id"])
            .eq("studio_id", payer["studio_id"])
            .execute()
        )
        return result.data[0] if result.data else {**payer, **update}

    def _activate_stripe_enrollment(self, enrollment: dict[str, Any], plan: dict[str, Any], studio_id: str) -> dict[str, Any]:
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
        if plan.get("billing_interval") == "paid_in_full":
            self._create_paid_in_full_invoice(enrollment, plan, payer, account)
            return self._update_enrollment(enrollment["id"], studio_id, {"billing_status": "upcoming"})

        group = self._find_or_create_billing_subscription(enrollment, plan, payer, account)
        stripe_service = StripeService()
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
        return self._update_enrollment(enrollment["id"], studio_id, update)

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
        }).execute()
        if not inserted.data:
            raise HTTPException(status_code=500, detail="Failed to create billing subscription.")
        return inserted.data[0]

    def _detach_enrollment_from_subscription(self, enrollment: dict[str, Any]) -> None:
        item_id = enrollment.get("stripe_subscription_item_id")
        subscription_id = enrollment.get("stripe_subscription_id")
        if item_id and subscription_id:
            account_id = self._stripe_account_for_studio(enrollment["studio_id"])
            if account_id:
                remaining_same_item = self._active_enrollment_count_for_subscription_item(
                    enrollment["studio_id"],
                    enrollment.get("billing_subscription_id"),
                    item_id,
                    exclude_enrollment_id=enrollment["id"],
                )
                try:
                    if remaining_same_item:
                        StripeService().update_connected_subscription_item(
                            account_id=account_id,
                            subscription_item_id=item_id,
                            quantity=remaining_same_item,
                            proration_behavior="none",
                        )
                    else:
                        StripeService().delete_connected_subscription_item(account_id=account_id, subscription_item_id=item_id)
                except Exception:
                    pass
        if enrollment.get("billing_subscription_id"):
            remaining = (
                self.supabase.table("student_billing_enrollments")
                .select("id")
                .eq("studio_id", enrollment["studio_id"])
                .eq("billing_subscription_id", enrollment["billing_subscription_id"])
                .neq("id", enrollment["id"])
                .in_("status", ["pending", "active"])
                .execute()
            )
            if not remaining.data and subscription_id:
                account_id = self._stripe_account_for_studio(enrollment["studio_id"])
                if account_id:
                    try:
                        StripeService().cancel_connected_subscription(account_id=account_id, subscription_id=subscription_id)
                    except Exception:
                        pass
                self.supabase.table("billing_subscriptions").update({"status": "canceled"}).eq("id", enrollment["billing_subscription_id"]).execute()

    def _create_paid_in_full_invoice(self, enrollment: dict[str, Any], plan: dict[str, Any], payer: dict[str, Any], account: dict[str, Any]) -> None:
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
        inserted = self.supabase.table("billing_invoices").insert({
            "studio_id": enrollment["studio_id"],
            "payer_id": payer["id"],
            "student_id": enrollment["student_id"],
            "enrollment_id": enrollment["id"],
            "invoice_type": invoice.invoice_type,
            "status": "draft",
            "amount_due_cents": invoice.amount_cents or 0,
            "amount_paid_cents": 0,
            "amount_remaining_cents": invoice.amount_cents or 0,
            "currency": invoice.currency,
            "stripe_account_id": account["stripe_connected_account_id"],
            "stripe_customer_id": payer.get("stripe_customer_id"),
            "collection_method": "charge_automatically" if invoice.collection_mode == "autopay" else "send_invoice",
            "application_fee_amount_cents": self._application_fee_amount(invoice.amount_cents or 0, account),
        }).execute()
        if inserted.data:
            local_invoice = inserted.data[0]
            stripe_service = StripeService()
            stripe_invoice = stripe_service.create_connected_invoice(
                account_id=account["stripe_connected_account_id"],
                customer_id=payer["stripe_customer_id"],
                collection_method="charge_automatically" if invoice.collection_mode == "autopay" else "send_invoice",
                application_fee_amount=self._application_fee_amount(invoice.amount_cents or 0, account),
                default_payment_method=payer.get("default_payment_method_id") if invoice.collection_mode == "autopay" else None,
                days_until_due=7,
                metadata={
                    "studio_id": enrollment["studio_id"],
                    "payer_id": payer["id"],
                    "invoice_id": local_invoice["id"],
                    "enrollment_id": enrollment["id"],
                    "student_id": enrollment["student_id"],
                    "product": "koaryu_payments",
                },
                idempotency_key=self._idempotency_key("paid-in-full-invoice", enrollment["id"]),
            )
            stripe_invoice_id = _stripe_id(stripe_invoice)
            stripe_item = stripe_service.create_connected_invoice_item(
                account_id=account["stripe_connected_account_id"],
                customer_id=payer["stripe_customer_id"],
                amount=invoice.amount_cents or 0,
                currency=invoice.currency,
                description=invoice.description or plan["name"],
                metadata={
                    "studio_id": enrollment["studio_id"],
                    "invoice_id": local_invoice["id"],
                    "enrollment_id": enrollment["id"],
                    "student_id": enrollment["student_id"],
                    "billing_plan_id": plan["id"],
                    "product": "koaryu_payments",
                },
                idempotency_key=self._idempotency_key("paid-in-full-item", enrollment["id"]),
                invoice_id=stripe_invoice_id,
            )
            self.supabase.table("billing_invoice_items").insert({
                "studio_id": enrollment["studio_id"],
                "invoice_id": local_invoice["id"],
                "student_id": enrollment["student_id"],
                "enrollment_id": enrollment["id"],
                "billing_plan_id": plan["id"],
                "description": invoice.description or plan["name"],
                "quantity": 1,
                "unit_amount_cents": invoice.amount_cents or 0,
                "amount_cents": invoice.amount_cents or 0,
                "stripe_invoice_item_id": _stripe_id(stripe_item),
            }).execute()
            stripe_invoice = stripe_service.retrieve_connected_invoice(
                account_id=account["stripe_connected_account_id"],
                invoice_id=stripe_invoice_id,
            )
            self._update_invoice_from_stripe(local_invoice["id"], enrollment["studio_id"], stripe_invoice, account["stripe_connected_account_id"])

    def _project_checkout_session(self, session: dict[str, Any], account_id: Optional[str]) -> None:
        metadata = session.get("metadata") or {}
        if metadata.get("product") != "koaryu_payments_autopay":
            return
        studio_id = metadata.get("studio_id")
        payer_id = metadata.get("payer_id")
        if not studio_id or not payer_id:
            return
        setup_intent_id = _stripe_id(session.get("setup_intent"))
        customer_id = _stripe_id(session.get("customer"))
        payment_fields: dict[str, Any] = {}
        if setup_intent_id and account_id:
            try:
                setup_intent = StripeService().retrieve_connected_setup_intent(
                    account_id=account_id,
                    setup_intent_id=setup_intent_id,
                    expand=["payment_method"],
                )
                payment_method_id = _stripe_id(_object_get(setup_intent, "payment_method"))
                if payment_method_id and customer_id:
                    customer = StripeService().set_connected_customer_default_payment_method(
                        account_id=account_id,
                        customer_id=customer_id,
                        payment_method_id=payment_method_id,
                    )
                    payment_fields = self._payment_method_fields_from_customer(customer)
                else:
                    payment_fields = self._payment_method_fields_from_payment_method(_object_get(setup_intent, "payment_method"))
            except Exception:
                pass
        update = {
            "stripe_account_id": account_id,
            "stripe_customer_id": customer_id,
            "autopay_status": "enabled",
            "autopay_authorized_at": datetime.now(timezone.utc).isoformat(),
            **{k: v for k, v in payment_fields.items() if v is not None},
        }
        self.supabase.table("billing_payers").update(update).eq("id", payer_id).eq("studio_id", studio_id).execute()

    def _project_invoice_event(self, invoice: dict[str, Any], account_id: Optional[str], event_type: str) -> None:
        local = self._find_invoice_for_stripe(invoice, account_id)
        studio_id = (invoice.get("metadata") or {}).get("studio_id") or (local or {}).get("studio_id")
        if not studio_id:
            account = self._payment_account_by_stripe_account(account_id)
            studio_id = account.get("studio_id") if account else None
        if not studio_id:
            return
        if local:
            local = self._update_invoice_from_stripe(local["id"], studio_id, invoice, account_id)
        else:
            local = self._insert_invoice_from_stripe(studio_id, invoice, account_id)
        if event_type == "invoice.paid":
            self._project_payment_from_invoice(invoice, account_id, local)
        if local.get("payer_id"):
            self._recompute_payer_balance(studio_id, local.get("payer_id"))

    def _project_payment_intent(self, intent: dict[str, Any], account_id: Optional[str], event_type: str) -> None:
        metadata = intent.get("metadata") or {}
        invoice_id = _stripe_id(intent.get("invoice")) or metadata.get("invoice_id")
        local_invoice = self._find_invoice_by_payment_intent_or_invoice(
            account_id,
            _stripe_id(intent),
            invoice_id,
        )
        studio_id = metadata.get("studio_id") or (local_invoice or {}).get("studio_id")
        if not studio_id:
            return
        status_value = "processing" if event_type == "payment_intent.processing" else ("succeeded" if event_type == "payment_intent.succeeded" else "failed")
        charge = self._latest_charge(intent)
        charge_id = _stripe_id(charge)
        row = {
            "studio_id": studio_id,
            "payer_id": metadata.get("payer_id") or (local_invoice or {}).get("payer_id"),
            "invoice_id": (local_invoice or {}).get("id"),
            "stripe_customer_id": _stripe_id(intent.get("customer")),
            "stripe_invoice_id": invoice_id,
            "stripe_payment_intent_id": _stripe_id(intent),
            "stripe_charge_id": charge_id,
            "stripe_account_id": account_id,
            "stripe_payment_method_id": _stripe_id(intent.get("payment_method")),
            "status": status_value,
            "amount_cents": int(intent.get("amount_received") or intent.get("amount") or 0),
            "currency": intent.get("currency") or "usd",
            "payment_method_type": self._payment_method_type(intent, charge),
            "receipt_url": _object_get(charge, "receipt_url"),
            "failure_code": _object_get(_object_get(intent, "last_payment_error"), "code"),
            "failure_message": _object_get(_object_get(intent, "last_payment_error"), "message"),
            "application_fee_amount_cents": int((local_invoice or {}).get("application_fee_amount_cents") or 0),
            "processed_at": datetime.now(timezone.utc).isoformat() if status_value == "succeeded" else None,
        }
        existing = (
            self.supabase.table("billing_payments")
            .select("*")
            .eq("studio_id", studio_id)
            .eq("stripe_account_id", account_id)
            .eq("stripe_payment_intent_id", _stripe_id(intent))
            .limit(1)
            .execute()
        )
        if existing.data:
            existing_payment = existing.data[0]
            if status_value == "succeeded" and existing_payment.get("status") in {"disputed", "refunded"}:
                row["status"] = existing_payment["status"]
                row["processed_at"] = existing_payment.get("processed_at") or row.get("processed_at")
            result = self.supabase.table("billing_payments").update(row).eq("id", existing_payment["id"]).execute()
        else:
            result = self.supabase.table("billing_payments").insert(row).execute()
        payment = result.data[0] if result.data else row
        payment = self._link_disputes_to_payment(payment, account_id)
        if local_invoice and status_value in {"succeeded", "failed"}:
            update = {"last_payment_error": row.get("failure_message")}
            if status_value == "succeeded":
                update.update({
                    "status": "paid",
                    "amount_paid_cents": max(int(local_invoice.get("amount_paid_cents") or 0), row["amount_cents"]),
                    "amount_remaining_cents": 0,
                    "paid_at": datetime.now(timezone.utc).isoformat(),
                })
            self.supabase.table("billing_invoices").update(update).eq("id", local_invoice["id"]).execute()
        if payment.get("payer_id"):
            self._recompute_payer_balance(studio_id, payment.get("payer_id"))

    def _link_disputes_to_payment(self, payment: dict[str, Any], account_id: Optional[str]) -> dict[str, Any]:
        charge_id = payment.get("stripe_charge_id")
        payment_id = payment.get("id")
        studio_id = payment.get("studio_id")
        if not charge_id or not payment_id or not studio_id:
            return payment
        query = (
            self.supabase.table("billing_disputes")
            .select("id, status")
            .eq("studio_id", studio_id)
            .eq("stripe_charge_id", charge_id)
        )
        query = query.eq("stripe_account_id", account_id) if account_id else query.is_("stripe_account_id", "null")
        disputes = query.execute()
        if not disputes.data:
            return payment

        dispute_ids = [row["id"] for row in disputes.data if row.get("id")]
        dispute_update = {"payment_id": payment_id}
        if payment.get("stripe_payment_intent_id"):
            dispute_update["stripe_payment_intent_id"] = payment["stripe_payment_intent_id"]
        if dispute_ids:
            self.supabase.table("billing_disputes").update(dispute_update).in_("id", dispute_ids).execute()

        if payment.get("status") == "disputed":
            return payment
        result = self.supabase.table("billing_payments").update({"status": "disputed"}).eq("id", payment_id).execute()
        return result.data[0] if result.data else {**payment, "status": "disputed"}

    def _project_charge_refund(self, charge: dict[str, Any], account_id: Optional[str]) -> None:
        refunds = ((charge.get("refunds") or {}).get("data") or [])
        for refund in refunds:
            self._project_refund(refund, account_id, charge=charge)

    def _project_refund(self, refund: Any, account_id: Optional[str], *, charge: Optional[dict[str, Any]] = None) -> dict[str, Any]:
        refund_dict = refund if isinstance(refund, dict) else refund.to_dict_recursive() if hasattr(refund, "to_dict_recursive") else dict(refund)
        charge_id = _stripe_id(refund_dict.get("charge")) or _stripe_id(charge)
        payment = self._find_payment_by_charge(account_id, charge_id)
        studio_id = (payment or {}).get("studio_id") or (refund_dict.get("metadata") or {}).get("studio_id")
        if not studio_id:
            return {}
        row = {
            "studio_id": studio_id,
            "payment_id": (payment or {}).get("id"),
            "stripe_refund_id": _stripe_id(refund_dict),
            "stripe_charge_id": charge_id,
            "stripe_payment_intent_id": _stripe_id(refund_dict.get("payment_intent")) or (payment or {}).get("stripe_payment_intent_id"),
            "stripe_account_id": account_id,
            "amount_cents": int(refund_dict.get("amount") or 0),
            "status": refund_dict.get("status") or "succeeded",
            "reason": refund_dict.get("reason"),
            "metadata": refund_dict.get("metadata") or {},
        }
        existing = (
            self.supabase.table("billing_refunds")
            .select("*")
            .eq("studio_id", studio_id)
            .eq("stripe_account_id", account_id)
            .eq("stripe_refund_id", row["stripe_refund_id"])
            .limit(1)
            .execute()
        )
        if existing.data:
            delta = row["amount_cents"] - int(existing.data[0].get("amount_cents") or 0)
            result = self.supabase.table("billing_refunds").update(row).eq("id", existing.data[0]["id"]).execute()
        else:
            delta = row["amount_cents"]
            result = self.supabase.table("billing_refunds").insert(row).execute()
        if payment and delta:
            refunded = max(0, int(payment.get("refunded_amount_cents") or 0) + delta)
            self.supabase.table("billing_payments").update({
                "status": "refunded" if refunded >= int(payment.get("amount_cents") or 0) else payment.get("status"),
                "refunded_amount_cents": refunded,
            }).eq("id", payment["id"]).execute()
        return result.data[0] if result.data else row

    def _project_dispute(self, dispute: dict[str, Any], account_id: Optional[str]) -> None:
        charge_id = _stripe_id(dispute.get("charge"))
        payment = self._find_payment_by_charge(account_id, charge_id)
        studio_id = (payment or {}).get("studio_id") or (dispute.get("metadata") or {}).get("studio_id")
        if not studio_id:
            account = self._payment_account_by_stripe_account(account_id)
            studio_id = account.get("studio_id") if account else None
        if not studio_id:
            return
        row = {
            "studio_id": studio_id,
            "payment_id": (payment or {}).get("id"),
            "stripe_dispute_id": _stripe_id(dispute),
            "stripe_charge_id": charge_id,
            "stripe_payment_intent_id": (payment or {}).get("stripe_payment_intent_id"),
            "stripe_account_id": account_id,
            "amount_cents": int(dispute.get("amount") or 0),
            "status": dispute.get("status") or "needs_response",
            "reason": dispute.get("reason"),
            "liability_owner": "studio",
            "metadata": dispute.get("metadata") or {},
        }
        existing = (
            self.supabase.table("billing_disputes")
            .select("*")
            .eq("studio_id", studio_id)
            .eq("stripe_account_id", account_id)
            .eq("stripe_dispute_id", row["stripe_dispute_id"])
            .limit(1)
            .execute()
        )
        if existing.data:
            self.supabase.table("billing_disputes").update(row).eq("id", existing.data[0]["id"]).execute()
        else:
            self.supabase.table("billing_disputes").insert(row).execute()
        if payment:
            self.supabase.table("billing_payments").update({"status": "disputed"}).eq("id", payment["id"]).execute()

    def _project_subscription(self, subscription: dict[str, Any], account_id: Optional[str], event_type: str = "") -> Optional[dict[str, Any]]:
        metadata = subscription.get("metadata") or {}
        local = self._find_subscription_for_stripe(subscription, account_id)
        studio_id = metadata.get("studio_id") or (local or {}).get("studio_id")
        payer_id = metadata.get("payer_id") or (local or {}).get("payer_id")
        if not studio_id or not payer_id:
            return local
        status_value = "canceled" if event_type == "customer.subscription.deleted" else subscription.get("status", "active")
        update = {
            "studio_id": studio_id,
            "payer_id": payer_id,
            "stripe_account_id": account_id,
            "stripe_customer_id": _stripe_id(subscription.get("customer")),
            "stripe_subscription_id": _stripe_id(subscription),
            "status": status_value,
            "current_period_start": self._timestamp(subscription.get("current_period_start")),
            "current_period_end": self._timestamp(subscription.get("current_period_end")),
            "cancel_at_period_end": bool(subscription.get("cancel_at_period_end")),
            "application_fee_percent": subscription.get("application_fee_percent"),
        }
        if local:
            result = self.supabase.table("billing_subscriptions").update(update).eq("id", local["id"]).execute()
            row = result.data[0] if result.data else {**local, **update}
        else:
            update.update({
                "collection_mode": "autopay" if subscription.get("collection_method") == "charge_automatically" else "invoice_link",
                "billing_interval": "monthly",
                "currency": "usd",
            })
            result = self.supabase.table("billing_subscriptions").insert(update).execute()
            row = result.data[0] if result.data else update
        self._project_subscription_items(subscription, row)
        return row

    def _update_invoice_from_stripe(
        self,
        invoice_id: str,
        studio_id: str,
        invoice: Any,
        account_id: Optional[str],
    ) -> dict[str, Any]:
        update = self._invoice_projection(invoice, account_id)
        result = (
            self.supabase.table("billing_invoices")
            .update(update)
            .eq("id", invoice_id)
            .eq("studio_id", studio_id)
            .execute()
        )
        return result.data[0] if result.data else update

    def _insert_invoice_from_stripe(self, studio_id: str, invoice: dict[str, Any], account_id: Optional[str]) -> dict[str, Any]:
        metadata = invoice.get("metadata") or {}
        row = {
            "studio_id": studio_id,
            "payer_id": metadata.get("payer_id") or self._payer_id_for_customer(studio_id, account_id, _stripe_id(invoice.get("customer"))),
            "student_id": metadata.get("student_id") or None,
            "enrollment_id": metadata.get("enrollment_id") or None,
            "invoice_type": metadata.get("invoice_type") or ("tuition" if invoice.get("subscription") else "manual"),
            "external": False,
            **self._invoice_projection(invoice, account_id),
        }
        result = self.supabase.table("billing_invoices").insert(row).execute()
        return result.data[0] if result.data else row

    def _invoice_projection(self, invoice: Any, account_id: Optional[str]) -> dict[str, Any]:
        invoice_id = _stripe_id(invoice)
        status_value = _object_get(invoice, "status") or "draft"
        if status_value == "void":
            status_value = "void"
        payment_intent = _object_get(invoice, "payment_intent")
        last_error = _object_get(_object_get(payment_intent, "last_payment_error"), "message")
        amount_due = int(_object_get(invoice, "amount_due") or 0)
        amount_paid = int(_object_get(invoice, "amount_paid") or 0)
        amount_remaining = int(_object_get(invoice, "amount_remaining") or 0)
        application_fee_amount = int(_object_get(invoice, "application_fee_amount") or 0)
        if _object_get(invoice, "paid_out_of_band"):
            amount_paid = amount_due
            amount_remaining = 0
            application_fee_amount = 0
        return {
            "stripe_invoice_id": invoice_id,
            "stripe_account_id": account_id,
            "stripe_customer_id": _stripe_id(_object_get(invoice, "customer")),
            "stripe_subscription_id": _stripe_id(_object_get(invoice, "subscription")),
            "stripe_payment_intent_id": _stripe_id(payment_intent),
            "invoice_number": _object_get(invoice, "number"),
            "status": self._local_invoice_status(status_value),
            "amount_due_cents": amount_due,
            "amount_paid_cents": amount_paid,
            "amount_remaining_cents": amount_remaining,
            "currency": _object_get(invoice, "currency") or "usd",
            "hosted_invoice_url": _object_get(invoice, "hosted_invoice_url"),
            "invoice_pdf": _object_get(invoice, "invoice_pdf"),
            "due_date": self._date_from_epoch(_object_get(invoice, "due_date")),
            "paid_at": self._timestamp(_object_get(_object_get(invoice, "status_transitions") or {}, "paid_at")),
            "finalized_at": self._timestamp(_object_get(_object_get(invoice, "status_transitions") or {}, "finalized_at")),
            "voided_at": self._timestamp(_object_get(_object_get(invoice, "status_transitions") or {}, "voided_at")),
            "collection_method": _object_get(invoice, "collection_method"),
            "last_payment_error": last_error,
            "application_fee_amount_cents": application_fee_amount,
        }

    def _project_payment_from_invoice(self, invoice: dict[str, Any], account_id: Optional[str], local_invoice: dict[str, Any]) -> None:
        payment_intent_id = _stripe_id(invoice.get("payment_intent"))
        if not payment_intent_id:
            return
        try:
            intent = StripeService().retrieve_connected_payment_intent(
                account_id=account_id or local_invoice["stripe_account_id"],
                payment_intent_id=payment_intent_id,
                expand=["latest_charge", "payment_method"],
            )
        except Exception:
            intent = {
                "id": payment_intent_id,
                "amount_received": invoice.get("amount_paid"),
                "currency": invoice.get("currency"),
                "customer": invoice.get("customer"),
                "invoice": invoice.get("id"),
                "status": "succeeded",
                "metadata": invoice.get("metadata") or {},
            }
        self._project_payment_intent(intent if isinstance(intent, dict) else intent.to_dict_recursive(), account_id, "payment_intent.succeeded")

    def _find_invoice_for_stripe(self, invoice: dict[str, Any], account_id: Optional[str]) -> Optional[dict[str, Any]]:
        metadata = invoice.get("metadata") or {}
        local_id = metadata.get("invoice_id")
        studio_id = metadata.get("studio_id")
        if local_id and studio_id:
            result = self.supabase.table("billing_invoices").select("*").eq("id", local_id).eq("studio_id", studio_id).limit(1).execute()
            if result.data:
                return result.data[0]
        stripe_invoice_id = _stripe_id(invoice)
        if not stripe_invoice_id:
            return None
        query = self.supabase.table("billing_invoices").select("*").eq("stripe_invoice_id", stripe_invoice_id).limit(1)
        query = query.eq("stripe_account_id", account_id) if account_id else query.is_("stripe_account_id", "null")
        result = query.execute()
        return result.data[0] if result.data else None

    def _find_invoice_by_payment_intent_or_invoice(
        self,
        account_id: Optional[str],
        payment_intent_id: Optional[str],
        stripe_invoice_id: Optional[str],
    ) -> Optional[dict[str, Any]]:
        if payment_intent_id:
            query = self.supabase.table("billing_invoices").select("*").eq("stripe_payment_intent_id", payment_intent_id).limit(1)
            query = query.eq("stripe_account_id", account_id) if account_id else query.is_("stripe_account_id", "null")
            result = query.execute()
            if result.data:
                return result.data[0]
        if stripe_invoice_id:
            query = self.supabase.table("billing_invoices").select("*").eq("stripe_invoice_id", stripe_invoice_id).limit(1)
            query = query.eq("stripe_account_id", account_id) if account_id else query.is_("stripe_account_id", "null")
            result = query.execute()
            if result.data:
                return result.data[0]
        return None

    def _find_payment_by_charge(self, account_id: Optional[str], charge_id: Optional[str]) -> Optional[dict[str, Any]]:
        if not charge_id:
            return None
        query = self.supabase.table("billing_payments").select("*").eq("stripe_charge_id", charge_id).limit(1)
        query = query.eq("stripe_account_id", account_id) if account_id else query.is_("stripe_account_id", "null")
        result = query.execute()
        return result.data[0] if result.data else None

    def _find_subscription_for_stripe(self, subscription: dict[str, Any], account_id: Optional[str]) -> Optional[dict[str, Any]]:
        metadata = subscription.get("metadata") or {}
        local_id = metadata.get("billing_subscription_id")
        studio_id = metadata.get("studio_id")
        if local_id and studio_id:
            result = self.supabase.table("billing_subscriptions").select("*").eq("id", local_id).eq("studio_id", studio_id).limit(1).execute()
            if result.data:
                return result.data[0]
        stripe_id = _stripe_id(subscription)
        if not stripe_id:
            return None
        query = self.supabase.table("billing_subscriptions").select("*").eq("stripe_subscription_id", stripe_id).limit(1)
        query = query.eq("stripe_account_id", account_id) if account_id else query.is_("stripe_account_id", "null")
        result = query.execute()
        return result.data[0] if result.data else None

    def _project_subscription_items(self, subscription: dict[str, Any], group: dict[str, Any]) -> None:
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
                self.supabase.table("student_billing_enrollments").update(update).eq("id", enrollment_id).eq("studio_id", group["studio_id"]).execute()
            self.supabase.table("student_billing_enrollments").update(update).eq("studio_id", group["studio_id"]).eq("billing_subscription_id", group.get("id")).eq("stripe_subscription_item_id", _stripe_id(item)).execute()

    def _subscription_item_id_for_group_plan(self, studio_id: str, group_id: str, plan_id: str) -> Optional[str]:
        result = (
            self.supabase.table("student_billing_enrollments")
            .select("stripe_subscription_item_id")
            .eq("studio_id", studio_id)
            .eq("billing_subscription_id", group_id)
            .eq("billing_plan_id", plan_id)
            .in_("status", ["pending", "active"])
            .execute()
        )
        for row in result.data or []:
            if row.get("stripe_subscription_item_id"):
                return row["stripe_subscription_item_id"]
        return None

    def _active_enrollment_count_for_subscription_item(
        self,
        studio_id: str,
        group_id: Optional[str],
        item_id: str,
        *,
        exclude_enrollment_id: Optional[str] = None,
    ) -> int:
        if not group_id or not item_id:
            return 0
        result = (
            self.supabase.table("student_billing_enrollments")
            .select("id")
            .eq("studio_id", studio_id)
            .eq("billing_subscription_id", group_id)
            .eq("stripe_subscription_item_id", item_id)
            .in_("status", ["pending", "active"])
            .execute()
        )
        rows = result.data or []
        if exclude_enrollment_id:
            rows = [row for row in rows if row.get("id") != exclude_enrollment_id]
        return len(rows)

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

    def _payer_id_for_customer(self, studio_id: str, account_id: Optional[str], customer_id: Optional[str]) -> Optional[str]:
        if not customer_id:
            return None
        query = (
            self.supabase.table("billing_payers")
            .select("id")
            .eq("studio_id", studio_id)
            .eq("stripe_customer_id", customer_id)
            .limit(1)
        )
        query = query.eq("stripe_account_id", account_id) if account_id else query.is_("stripe_account_id", "null")
        result = query.execute()
        return result.data[0]["id"] if result.data else None

    def _payment_account_by_stripe_account(self, account_id: Optional[str]) -> Optional[dict[str, Any]]:
        if not account_id:
            return None
        result = (
            self.supabase.table("studio_payment_accounts")
            .select("*")
            .eq("stripe_connected_account_id", account_id)
            .limit(1)
            .execute()
        )
        return result.data[0] if result.data else None

    def _stripe_account_for_studio(self, studio_id: str) -> Optional[str]:
        account = self._ensure_payment_account_row(studio_id)
        return account.get("stripe_connected_account_id")

    def _payment_method_fields_from_customer(self, customer: Any) -> dict[str, Any]:
        invoice_settings = _object_get(customer, "invoice_settings") or {}
        payment_method = _object_get(invoice_settings, "default_payment_method")
        return self._payment_method_fields_from_payment_method(payment_method)

    def _payment_method_fields_from_payment_method(self, payment_method: Any) -> dict[str, Any]:
        if not payment_method:
            return {
                "default_payment_method_id": None,
                "default_payment_method_brand": None,
                "default_payment_method_last4": None,
                "default_payment_method_exp_month": None,
                "default_payment_method_exp_year": None,
            }
        method_type = _object_get(payment_method, "type")
        card = _object_get(payment_method, "card") or {}
        return {
            "default_payment_method_id": _stripe_id(payment_method),
            "default_payment_method_brand": _object_get(card, "brand") or method_type,
            "default_payment_method_last4": _object_get(card, "last4"),
            "default_payment_method_exp_month": _object_get(card, "exp_month"),
            "default_payment_method_exp_year": _object_get(card, "exp_year"),
        }

    def _subscription_item_id_for_enrollment(self, subscription: Any, enrollment_id: str) -> Optional[str]:
        items = (_object_get(_object_get(subscription, "items") or {}, "data") or [])
        for item in items:
            if (_object_get(item, "metadata") or {}).get("enrollment_id") == enrollment_id:
                return _stripe_id(item)
        return _stripe_id(items[0]) if items else None

    def _latest_charge(self, intent: dict[str, Any]) -> Any:
        latest = intent.get("latest_charge")
        if latest:
            return latest
        charges = (intent.get("charges") or {}).get("data") or []
        return charges[0] if charges else None

    def _payment_method_type(self, intent: dict[str, Any], charge: Any) -> Optional[str]:
        payment_method_types = intent.get("payment_method_types") or []
        if payment_method_types:
            return payment_method_types[0]
        payment_method_details = _object_get(charge, "payment_method_details") or {}
        return _object_get(payment_method_details, "type")

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

    def _application_fee_percent(self, account: dict[str, Any]) -> float:
        return round((account.get("platform_fee_bps") or self.settings.BILLING_PLATFORM_FEE_BPS) / 100, 3)

    def _application_fee_amount(self, amount_cents: int, account: dict[str, Any]) -> int:
        bps = account.get("platform_fee_bps") or self.settings.BILLING_PLATFORM_FEE_BPS
        return int(round(amount_cents * bps / 10000))

    def _idempotency_key(self, *parts: str) -> str:
        return "koaryu:" + ":".join(str(part).replace(":", "_") for part in parts if part is not None)

    def _timestamp(self, value: Any) -> Optional[str]:
        if not value:
            return None
        if isinstance(value, (int, float)):
            return datetime.fromtimestamp(value, tz=timezone.utc).isoformat()
        if isinstance(value, datetime):
            return value.isoformat()
        return str(value)

    def _date_from_epoch(self, value: Any) -> Optional[str]:
        if not value:
            return None
        if isinstance(value, (int, float)):
            return datetime.fromtimestamp(value, tz=timezone.utc).date().isoformat()
        return str(value)

    def _date_to_epoch(self, value: str) -> int:
        parsed = date.fromisoformat(value)
        return int(datetime.combine(parsed, time.min, tzinfo=timezone.utc).timestamp())

    def _local_invoice_status(self, stripe_status: str) -> str:
        if stripe_status == "void":
            return "void"
        if stripe_status == "uncollectible":
            return "uncollectible"
        if stripe_status in {"draft", "open", "paid"}:
            return stripe_status
        return "open"

    def _recompute_payer_balance(self, studio_id: str, payer_id: Optional[str]) -> None:
        if not payer_id:
            return
        result = (
            self.supabase.table("billing_invoices")
            .select("amount_due_cents, amount_paid_cents, amount_remaining_cents, status, external")
            .eq("studio_id", studio_id)
            .eq("payer_id", payer_id)
            .in_("status", ["draft", "open", "uncollectible"])
            .execute()
        )
        balance = 0
        for row in result.data or []:
            remaining = row.get("amount_remaining_cents")
            if remaining is None:
                remaining = max(0, int(row.get("amount_due_cents") or 0) - int(row.get("amount_paid_cents") or 0))
            balance += max(0, int(remaining or 0))
        billing_status = "current" if balance == 0 else "past_due"
        self.supabase.table("billing_payers").update({
            "balance_cents": balance,
            "billing_status": billing_status,
        }).eq("id", payer_id).eq("studio_id", studio_id).execute()


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
        result = self.supabase.table("studios").select("id, name, owner_id").eq("id", studio_id).single().execute()
        if not result.data:
            raise HTTPException(status_code=404, detail="Studio not found.")
        return result.data

    def _get_user_email(self, user_id: Optional[str]) -> Optional[str]:
        if not user_id:
            return None
        try:
            result = self.supabase.auth.admin.get_user_by_id(user_id)
        except Exception:
            return None
        user = getattr(result, "user", None)
        return getattr(user, "email", None)

    def _audit(self, studio_id: str, actor_id: str, action: str, entity_id: str, metadata: dict[str, Any]) -> None:
        self.supabase.table("audit_logs").insert({
            "studio_id": studio_id,
            "actor_id": actor_id,
            "action": action,
            "entity_type": "billing",
            "entity_id": entity_id,
            "metadata": metadata,
        }).execute()
