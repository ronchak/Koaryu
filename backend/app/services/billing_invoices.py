from __future__ import annotations

import hashlib
import json
from datetime import date, datetime, time, timezone
from typing import Any, Callable, Optional

from fastapi import HTTPException
from postgrest.exceptions import APIError as PostgrestAPIError

from app.schemas.billing import BillingInvoiceCreate, BillingInvoiceResponse
from app.services.billing_invoice_operations import BillingInvoiceOperationWorkflow
from app.services.stripe_service import StripeService

class BillingInvoiceManager:
    def __init__(
        self,
        billing_service: Any,
        *,
        stripe_service_cls: type[StripeService] = StripeService,
        utc_today: Callable[[], date] | None = None,
    ):
        self.billing_service = billing_service
        self.stripe_service_cls = stripe_service_cls
        self._utc_today = utc_today or (lambda: datetime.now(timezone.utc).date())

    @property
    def supabase(self):
        return self.billing_service.supabase

    def _get_row_or_404(self, *args, **kwargs):
        return self.billing_service._get_row_or_404(*args, **kwargs)

    def _ensure_record_in_studio(self, *args, **kwargs) -> None:
        self.billing_service._ensure_record_in_studio(*args, **kwargs)

    def _connect_accounts(self):
        return self.billing_service._connect_accounts()

    def _payer_autopay_authorized(self, payer: dict[str, Any]) -> bool:
        return self.billing_service._payer_autopay_authorized(payer)

    def _application_fee_amount(self, amount_cents: int, account: dict[str, Any]) -> int:
        return self.billing_service._application_fee_amount(amount_cents, account)

    def _idempotency_key(self, *parts: str) -> str:
        return self.billing_service._idempotency_key(*parts)

    def _update_invoice_from_stripe(
        self,
        invoice_id: str,
        studio_id: str,
        stripe_invoice: Any,
        account_id: str,
    ) -> dict[str, Any]:
        return self.billing_service._update_invoice_from_stripe(invoice_id, studio_id, stripe_invoice, account_id)

    def _audit(self, studio_id: str, actor_id: str, action: str, entity_id: str, metadata: dict[str, Any]) -> None:
        self.billing_service._audit(studio_id, actor_id, action, entity_id, metadata)

    def _recompute_payer_balance(self, studio_id: str, payer_id: Optional[str]) -> None:
        self.billing_service._recompute_payer_balance(studio_id, payer_id)

    def _invoice_today_utc(self) -> date:
        return self._utc_today()

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

    async def create_invoice(
        self,
        data: BillingInvoiceCreate,
        studio_id: str,
        actor_id: str,
        idempotency_key: Optional[str] = None,
    ) -> BillingInvoiceResponse:
        return BillingInvoiceOperationWorkflow(
            self,
            stripe_service_cls=self.stripe_service_cls,
        ).create_invoice(data, studio_id, actor_id, idempotency_key)

    def create_invoice_sync(
        self,
        data: BillingInvoiceCreate,
        studio_id: str,
        actor_id: str,
        idempotency_key: Optional[str] = None,
    ) -> BillingInvoiceResponse:
        return BillingInvoiceOperationWorkflow(
            self,
            stripe_service_cls=self.stripe_service_cls,
        ).create_invoice(data, studio_id, actor_id, idempotency_key)

    async def finalize_invoice(
        self,
        invoice_id: str,
        studio_id: str,
        actor_id: str,
        idempotency_key: Optional[str] = None,
    ) -> BillingInvoiceResponse:
        return await BillingInvoiceOperationWorkflow(
            self,
            stripe_service_cls=self.stripe_service_cls,
        ).finalize_invoice(invoice_id, studio_id, actor_id, idempotency_key)

    async def retry_invoice_payment(
        self,
        invoice_id: str,
        studio_id: str,
        actor_id: str,
        idempotency_key: Optional[str] = None,
    ) -> BillingInvoiceResponse:
        return await BillingInvoiceOperationWorkflow(
            self,
            stripe_service_cls=self.stripe_service_cls,
        ).retry_invoice_payment(invoice_id, studio_id, actor_id, idempotency_key)

    async def void_invoice(
        self,
        invoice_id: str,
        studio_id: str,
        actor_id: str,
        idempotency_key: Optional[str] = None,
    ) -> BillingInvoiceResponse:
        return await BillingInvoiceOperationWorkflow(
            self,
            stripe_service_cls=self.stripe_service_cls,
        ).void_invoice(invoice_id, studio_id, actor_id, idempotency_key)

    async def reconcile_invoice(self, invoice_id: str, studio_id: str, actor_id: str) -> BillingInvoiceResponse:
        invoice = self._get_row_or_404("billing_invoices", invoice_id, studio_id, "Invoice not found.")
        if not invoice.get("stripe_invoice_id") or not invoice.get("stripe_account_id"):
            raise HTTPException(status_code=409, detail="Invoice is not linked to Stripe.")
        stripe_invoice = self.stripe_service_cls().retrieve_connected_invoice(
            account_id=invoice["stripe_account_id"],
            invoice_id=invoice["stripe_invoice_id"],
            expand=["payment_intent"],
        )
        invoice = self._update_invoice_from_stripe(invoice_id, studio_id, stripe_invoice, invoice["stripe_account_id"])
        self._audit(studio_id, actor_id, "billing.invoice_reconciled", invoice_id, {})
        self._recompute_payer_balance(studio_id, invoice.get("payer_id"))
        return BillingInvoiceResponse(**invoice)

    def _normalize_idempotency_key(self, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        normalized = value.strip()
        if not normalized:
            return None
        if len(normalized) > 255:
            raise HTTPException(status_code=400, detail="Idempotency-Key must be 255 characters or fewer.")
        return normalized

    def _invoice_request_hash(self, data: BillingInvoiceCreate) -> str:
        payload = data.model_dump(mode="json", exclude_none=True)
        canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(canonical.encode("utf-8")).hexdigest()

    def _claim_invoice_create_request(
        self,
        studio_id: str,
        idempotency_key: Optional[str],
        request_hash: str,
        invoice_row: dict[str, Any],
    ) -> dict[str, Any]:
        if idempotency_key:
            existing = self._find_invoice_by_idempotency_key(studio_id, idempotency_key)
            if existing:
                if existing.get("request_hash") != request_hash:
                    raise HTTPException(
                        status_code=409,
                        detail="This idempotency key is already in use for a different invoice request.",
                    )
                return existing
        try:
            inserted = self.supabase.table("billing_invoices").insert(invoice_row).execute()
        except PostgrestAPIError as exc:
            if exc.code != "23505" or not idempotency_key:
                raise
            existing = self._find_invoice_by_idempotency_key(studio_id, idempotency_key)
            if not existing:
                raise
            if existing.get("request_hash") != request_hash:
                raise HTTPException(
                    status_code=409,
                    detail="This idempotency key is already in use for a different invoice request.",
                ) from exc
            return existing
        if not inserted.data:
            raise HTTPException(status_code=500, detail="Failed to create invoice.")
        return inserted.data[0]

    def _validate_invoice_item_refs(self, item: dict[str, Any], studio_id: str) -> None:
        student_id = item.get("student_id")
        enrollment_id = item.get("enrollment_id")
        billing_plan_id = item.get("billing_plan_id")

        if student_id:
            self._ensure_record_in_studio(
                "students",
                student_id,
                studio_id,
                "Invoice item student not found.",
            )

        enrollment = None
        if enrollment_id:
            enrollment = self._get_row_or_404(
                "student_billing_enrollments",
                enrollment_id,
                studio_id,
                "Invoice item enrollment not found.",
            )

        if billing_plan_id:
            self._ensure_record_in_studio(
                "billing_plans",
                billing_plan_id,
                studio_id,
                "Invoice item billing plan not found.",
            )

        if enrollment and student_id and enrollment.get("student_id") != student_id:
            raise HTTPException(
                status_code=409,
                detail="Invoice item enrollment belongs to a different student.",
            )

        if enrollment and billing_plan_id and enrollment.get("billing_plan_id") != billing_plan_id:
            raise HTTPException(
                status_code=409,
                detail="Invoice item enrollment belongs to a different billing plan.",
            )

    def _find_invoice_by_idempotency_key(self, studio_id: str, idempotency_key: str) -> Optional[dict[str, Any]]:
        result = (
            self.supabase.table("billing_invoices")
            .select("*")
            .eq("studio_id", studio_id)
            .eq("idempotency_key", idempotency_key)
            .limit(1)
            .execute()
        )
        return result.data[0] if result.data else None

    def _insert_invoice_item_once(self, row: dict[str, Any]) -> None:
        try:
            self.supabase.table("billing_invoice_items").insert(row).execute()
        except PostgrestAPIError as exc:
            if exc.code != "23505":
                raise

    def _date_to_epoch(self, value: str) -> int:
        parsed = date.fromisoformat(value)
        return int(datetime.combine(parsed, time.min, tzinfo=timezone.utc).timestamp())
