from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from typing import Any

from fastapi import HTTPException
from postgrest.exceptions import APIError as PostgrestAPIError

from app.schemas.billing import (
    BillingPaymentResponse,
    BillingRefundCreate,
    BillingRefundResponse,
    ExportJobCreate,
    ExportJobResponse,
    ExternalPaymentCreate,
)
from app.services.supabase_rpc import execute_required_rpc
from app.services.stripe_service import StripeService


class BillingPaymentManager:
    def __init__(self, billing_service: Any, *, stripe_service_cls: type[StripeService] = StripeService):
        self.billing_service = billing_service
        self.stripe_service_cls = stripe_service_cls

    @property
    def supabase(self):
        return self.billing_service.supabase

    def _ensure_record_in_studio(self, *args, **kwargs) -> None:
        self.billing_service._ensure_record_in_studio(*args, **kwargs)

    def _get_row_or_404(self, *args, **kwargs):
        return self.billing_service._get_row_or_404(*args, **kwargs)

    def _recompute_payer_balance(self, studio_id: str, payer_id: str | None) -> None:
        self.billing_service._recompute_payer_balance(studio_id, payer_id)

    def _idempotency_key(self, *parts: str) -> str:
        return self.billing_service._idempotency_key(*parts)

    def _normalize_idempotency_key(self, value: str | None) -> str | None:
        helper = getattr(self.billing_service, "_normalize_idempotency_key", None)
        if callable(helper):
            return helper(value)
        if value is None:
            return None
        normalized = value.strip()
        if not normalized:
            return None
        if len(normalized) > 255:
            raise HTTPException(status_code=400, detail="Idempotency-Key must be 255 characters or fewer.")
        return normalized

    def _audit(self, studio_id: str, actor_id: str, action: str, entity_id: str, metadata: dict[str, Any]) -> None:
        self.billing_service._audit(studio_id, actor_id, action, entity_id, metadata)

    def _project_refund(self, refund: Any, account_id: str, **kwargs) -> dict[str, Any]:
        return self.billing_service._project_refund(refund, account_id, **kwargs)

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

    async def record_external_payment(
        self,
        data: ExternalPaymentCreate,
        studio_id: str,
        actor_id: str,
        idempotency_key: str | None = None,
    ) -> BillingPaymentResponse:
        invoice = None
        if data.invoice_id:
            invoice = self._get_row_or_404("billing_invoices", data.invoice_id, studio_id, "Invoice not found.")
            invoice_payer_id = invoice.get("payer_id")
            if data.payer_id and invoice_payer_id and data.payer_id != invoice_payer_id:
                raise HTTPException(status_code=409, detail="Invoice belongs to a different payer.")
        effective_payer_id = data.payer_id or (invoice or {}).get("payer_id")
        if effective_payer_id:
            self._ensure_record_in_studio("billing_payers", effective_payer_id, studio_id, "Payer not found.")
        normalized_idempotency_key = self._normalize_idempotency_key(idempotency_key)
        request_hash = self._external_payment_request_hash(data, effective_payer_id=effective_payer_id)
        row = data.model_dump()
        row.update({
            "studio_id": studio_id,
            "payer_id": effective_payer_id,
            "status": "externally_recorded",
            "payment_method_type": "external",
            "processed_at": datetime.now(timezone.utc).isoformat(),
            "idempotency_key": normalized_idempotency_key,
            "request_hash": request_hash if normalized_idempotency_key else None,
        })
        payment, created = self._claim_external_payment_request(
            studio_id,
            normalized_idempotency_key,
            request_hash,
            row,
        )
        if data.invoice_id:
            invoice = self._apply_external_payment_to_invoice(studio_id, invoice, payment)
            self._recompute_payer_balance(studio_id, invoice.get("payer_id"))
        elif effective_payer_id:
            self._recompute_payer_balance(studio_id, effective_payer_id)
        if created:
            self._audit(studio_id, actor_id, "billing.external_payment_recorded", payment["id"], {
                "amount_cents": data.amount_cents,
                "external_method": data.external_method,
            })
        return BillingPaymentResponse(**payment)

    def _external_payment_request_hash(self, data: ExternalPaymentCreate, *, effective_payer_id: str | None) -> str:
        payload = data.model_dump(mode="json", exclude_none=True)
        if effective_payer_id:
            payload["payer_id"] = effective_payer_id
        canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(canonical.encode("utf-8")).hexdigest()

    def _claim_external_payment_request(
        self,
        studio_id: str,
        idempotency_key: str | None,
        request_hash: str,
        payment_row: dict[str, Any],
    ) -> tuple[dict[str, Any], bool]:
        if idempotency_key:
            existing = self._find_payment_by_idempotency_key(studio_id, idempotency_key)
            if existing:
                self._ensure_external_payment_hash_matches(existing, request_hash)
                return existing, False
        try:
            result = self.supabase.table("billing_payments").insert(payment_row).execute()
        except PostgrestAPIError as exc:
            if getattr(exc, "code", None) != "23505" or not idempotency_key:
                raise
            existing = self._find_payment_by_idempotency_key(studio_id, idempotency_key)
            if not existing:
                raise
            self._ensure_external_payment_hash_matches(existing, request_hash)
            return existing, False
        if not result.data:
            raise HTTPException(status_code=500, detail="Failed to record external payment.")
        return result.data[0], True

    def _ensure_external_payment_hash_matches(self, payment: dict[str, Any], request_hash: str) -> None:
        if payment.get("request_hash") != request_hash:
            raise HTTPException(
                status_code=409,
                detail="This idempotency key is already in use for a different external payment request.",
            )

    def _find_payment_by_idempotency_key(self, studio_id: str, idempotency_key: str) -> dict[str, Any] | None:
        result = (
            self.supabase.table("billing_payments")
            .select("*")
            .eq("studio_id", studio_id)
            .eq("idempotency_key", idempotency_key)
            .limit(1)
            .execute()
        )
        return result.data[0] if result.data else None

    def _recompute_external_invoice_payment_totals(self, studio_id: str, invoice_id: str) -> dict[str, Any]:
        execute_required_rpc(
            self.supabase,
            "recompute_billing_invoice_external_payment_totals",
            {
                "p_studio_id": studio_id,
                "p_invoice_id": invoice_id,
            },
        )
        return self._get_row_or_404("billing_invoices", invoice_id, studio_id, "Invoice not found.")

    def _apply_external_payment_to_invoice(
        self,
        studio_id: str,
        invoice: dict[str, Any],
        payment: dict[str, Any],
    ) -> dict[str, Any]:
        if not self._invoice_requires_stripe_external_sync(invoice):
            return self._recompute_external_invoice_payment_totals(studio_id, invoice["id"])
        if not self._external_payments_cover_invoice(studio_id, invoice):
            return self._recompute_external_invoice_payment_totals(studio_id, invoice["id"])
        if not self._mark_stripe_invoice_paid_out_of_band(invoice, payment, studio_id):
            return self._get_row_or_404("billing_invoices", invoice["id"], studio_id, "Invoice not found.")
        return self._recompute_external_invoice_payment_totals(studio_id, invoice["id"])

    def _invoice_requires_stripe_external_sync(self, invoice: dict[str, Any]) -> bool:
        if not invoice.get("stripe_invoice_id") or not invoice.get("stripe_account_id"):
            return False
        return invoice.get("status") != "paid" or bool(invoice.get("last_payment_error"))

    def _external_payments_cover_invoice(self, studio_id: str, invoice: dict[str, Any]) -> bool:
        due = int(invoice.get("amount_due_cents") or 0)
        result = (
            self.supabase.table("billing_payments")
            .select("amount_cents")
            .eq("studio_id", studio_id)
            .eq("invoice_id", invoice["id"])
            .in_("status", ["succeeded", "externally_recorded"])
            .execute()
        )
        paid = sum(max(0, int(row.get("amount_cents") or 0)) for row in (result.data or []))
        return paid >= due

    def _mark_stripe_invoice_paid_out_of_band(
        self,
        invoice: dict[str, Any],
        payment: dict[str, Any],
        studio_id: str,
    ) -> bool:
        try:
            self.stripe_service_cls().pay_connected_invoice(
                account_id=invoice["stripe_account_id"],
                invoice_id=invoice["stripe_invoice_id"],
                paid_out_of_band=True,
                idempotency_key=self._idempotency_key("external-invoice-pay", payment["id"]),
            )
        except Exception as exc:
            update = {
                "status": "open",
                "paid_at": None,
                "last_payment_error": f"External payment recorded locally but Stripe sync failed: {exc}",
            }
            self.supabase.table("billing_invoices").update(update).eq("id", invoice["id"]).eq("studio_id", studio_id).execute()
            return False
        else:
            update = {"last_payment_error": None}
            self.supabase.table("billing_invoices").update(update).eq("id", invoice["id"]).eq("studio_id", studio_id).execute()
            return True

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
        refund = self.stripe_service_cls().create_connected_refund(
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
