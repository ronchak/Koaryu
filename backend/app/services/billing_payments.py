from __future__ import annotations

import hashlib
import json
import logging
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

from fastapi import HTTPException
from postgrest.exceptions import APIError as PostgrestAPIError

from app.schemas.billing import (
    BillingPaymentResponse,
    BillingPaymentCohortSummaryResponse,
    BillingRefundCreate,
    BillingRefundResponse,
    ExportJobCreate,
    ExportJobResponse,
    ExternalPaymentCreate,
)
from app.services.billing_invoice_projection import _stripe_id
from app.services.billing_provider_operations import (
    BillingProviderOperationContext,
    BillingProviderOperationCoordinator,
    PAYMENT_REFUND_OPERATION_TYPE,
    provider_operation_disposition,
)
from app.services.platform_billing_helpers import normalize_idempotency_key, stable_hash
from app.services.stripe_mutation_policy import StripeMutationBlocked
from app.services.supabase_rpc import execute_required_rpc
from app.services.stripe_service import StripeService


logger = logging.getLogger(__name__)

EXTERNAL_PAYMENT_IDEMPOTENCY_REQUIRED_DETAIL = "Idempotency-Key is required for external payments."
EXTERNAL_PAYMENT_OVERPAY_DETAIL = "External payment exceeds the invoice remaining balance."
EXTERNAL_PAYMENT_TARGET_REQUIRED_DETAIL = "External payments must target a payer or invoice."
REFUND_AMBIGUOUS_DETAIL = (
    "Refund outcome is not confirmed. Retry with the same Idempotency-Key after reconciliation."
)


def build_external_payment_request_hash(
    data: ExternalPaymentCreate,
    *,
    effective_payer_id: str | None,
) -> str:
    payload = data.model_dump(mode="json", exclude_none=True)
    if effective_payer_id is not None:
        payload["payer_id"] = effective_payer_id
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


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

    def _connect_accounts(self):
        return self.billing_service._connect_accounts()

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

    async def current_month_payment_cohort_summary(
        self,
        studio_id: str,
        *,
        as_of: datetime | None = None,
    ) -> BillingPaymentCohortSummaryResponse:
        observed_at = as_of or datetime.now(timezone.utc)
        if observed_at.tzinfo is None:
            observed_at = observed_at.replace(tzinfo=timezone.utc)
        observed_at = observed_at.astimezone(timezone.utc)
        period_start = observed_at.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        if period_start.month == 12:
            period_end = period_start.replace(year=period_start.year + 1, month=1)
        else:
            period_end = period_start.replace(month=period_start.month + 1)

        page_size = 1000
        offset = 0
        rows: list[dict[str, Any]] = []
        while True:
            page = (
                self.supabase.table("billing_payments")
                .select(
                    "id, status, amount_cents, gross_paid_amount_cents, refunded_amount_cents, disputed_amount_cents, "
                    "net_collected_amount_cents, processed_at"
                )
                .eq("studio_id", studio_id)
                .in_("status", ["succeeded", "refunded", "disputed", "externally_recorded"])
                .gte("processed_at", period_start.isoformat())
                .lt("processed_at", period_end.isoformat())
                .order("processed_at")
                .order("id")
                .range(offset, offset + page_size - 1)
                .execute()
                .data
                or []
            )
            rows.extend(page)
            if len(page) < page_size:
                break
            offset += page_size

        stripe_net = 0
        external_net = 0
        gross_paid = 0
        refunded_total = 0
        disputed_total = 0
        for payment in rows:
            gross = max(
                0,
                int(payment.get("gross_paid_amount_cents"))
                if payment.get("gross_paid_amount_cents") is not None
                else int(payment.get("amount_cents") or 0),
            )
            refunded = min(gross, max(0, int(payment.get("refunded_amount_cents") or 0)))
            disputed = min(
                max(0, gross - refunded),
                max(0, int(payment.get("disputed_amount_cents") or 0)),
            )
            net_amount = max(
                0,
                int(payment.get("net_collected_amount_cents"))
                if payment.get("net_collected_amount_cents") is not None
                else gross - refunded - disputed,
            )
            gross_paid += gross
            refunded_total += refunded
            disputed_total += disputed
            if payment.get("status") == "externally_recorded":
                external_net += net_amount
            else:
                stripe_net += net_amount

        return BillingPaymentCohortSummaryResponse(
            period_start=period_start.isoformat(),
            period_end=period_end.isoformat(),
            payment_count=len(rows),
            gross_paid_amount_cents=gross_paid,
            refunded_amount_cents=refunded_total,
            disputed_amount_cents=disputed_total,
            stripe_net_amount_cents=stripe_net,
            external_net_amount_cents=external_net,
            net_amount_cents=stripe_net + external_net,
        )

    async def record_external_payment(
        self,
        data: ExternalPaymentCreate,
        studio_id: str,
        actor_id: str,
        idempotency_key: str | None = None,
    ) -> BillingPaymentResponse:
        if not data.payer_id and not data.invoice_id:
            raise HTTPException(status_code=400, detail=EXTERNAL_PAYMENT_TARGET_REQUIRED_DETAIL)

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
        if not normalized_idempotency_key:
            raise HTTPException(status_code=400, detail=EXTERNAL_PAYMENT_IDEMPOTENCY_REQUIRED_DETAIL)
        request_hash = self._external_payment_request_hash(data, effective_payer_id=effective_payer_id)
        existing_idempotent_payment = None
        if normalized_idempotency_key:
            existing_idempotent_payment = self._find_payment_by_idempotency_key(studio_id, normalized_idempotency_key)
            if existing_idempotent_payment:
                self._ensure_external_payment_hash_matches(existing_idempotent_payment, request_hash)
        if data.invoice_id and not existing_idempotent_payment:
            self._ensure_external_payment_does_not_overpay_invoice(invoice or {}, data.amount_cents)
        row = data.model_dump()
        row.update({
            "studio_id": studio_id,
            "payer_id": effective_payer_id,
            "status": "externally_recorded",
            "payment_method_type": "external",
            "disputed_amount_cents": 0,
            "net_collected_amount_cents": data.amount_cents,
            "refundable_amount_cents": 0,
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

    def _ensure_external_payment_does_not_overpay_invoice(
        self,
        invoice: dict[str, Any],
        amount_cents: int,
    ) -> None:
        if invoice.get("amount_remaining_cents") is not None:
            remaining = int(invoice.get("amount_remaining_cents") or 0)
        else:
            remaining = max(0, int(invoice.get("amount_due_cents") or 0) - int(invoice.get("amount_paid_cents") or 0))
        if remaining <= 0:
            raise HTTPException(status_code=409, detail="Invoice has no remaining balance.")
        if int(amount_cents or 0) > remaining:
            raise HTTPException(status_code=409, detail=EXTERNAL_PAYMENT_OVERPAY_DETAIL)

    def _external_payment_request_hash(self, data: ExternalPaymentCreate, *, effective_payer_id: str | None) -> str:
        return build_external_payment_request_hash(data, effective_payer_id=effective_payer_id)

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
            if self._is_external_payment_idempotency_guard_error(exc):
                raise HTTPException(status_code=400, detail=EXTERNAL_PAYMENT_IDEMPOTENCY_REQUIRED_DETAIL) from exc
            if self._is_external_payment_overpay_guard_error(exc):
                raise HTTPException(status_code=409, detail=EXTERNAL_PAYMENT_OVERPAY_DETAIL) from exc
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

    def _is_external_payment_overpay_guard_error(self, exc: PostgrestAPIError) -> bool:
        message = getattr(exc, "message", None) or str(exc)
        return getattr(exc, "code", None) == "23514" and EXTERNAL_PAYMENT_OVERPAY_DETAIL in message

    def _is_external_payment_idempotency_guard_error(self, exc: PostgrestAPIError) -> bool:
        message = getattr(exc, "message", None) or str(exc)
        return getattr(exc, "code", None) == "23514" and EXTERNAL_PAYMENT_IDEMPOTENCY_REQUIRED_DETAIL in message

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
                studio_id=studio_id,
                invoice_id=invoice["stripe_invoice_id"],
                paid_out_of_band=True,
                idempotency_key=self._idempotency_key("external-invoice-pay", payment["id"]),
            )
        except Exception as exc:
            error_id = uuid4().hex
            logger.error(
                "Stripe out-of-band invoice sync failed; reference=%s; error_type=%s",
                error_id,
                type(exc).__name__,
            )
            update = {
                "status": "open",
                "paid_at": None,
                "last_payment_error": f"Stripe sync failed after local payment recording. Reference: {error_id}",
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
        idempotency_key: str | None = None,
    ) -> BillingRefundResponse:
        normalized_idempotency_key = normalize_idempotency_key(idempotency_key)
        if not normalized_idempotency_key:
            raise HTTPException(status_code=400, detail="Idempotency-Key is required for refunds.")
        payment = self._get_row_or_404("billing_payments", payment_id, studio_id, "Payment not found.")
        if not payment.get("stripe_charge_id") or not payment.get("stripe_account_id"):
            raise HTTPException(status_code=409, detail="Only Stripe payments can be refunded through Koaryu.")
        account_id = str(payment["stripe_account_id"])
        generation = self._exact_payment_account_generation(
            payment,
            studio_id=studio_id,
            account_id=account_id,
        )
        request_sha256 = stable_hash({
            "operation_type": PAYMENT_REFUND_OPERATION_TYPE,
            "studio_id": studio_id,
            "payment_id": payment_id,
            "stripe_connected_account_id": account_id,
            "connect_account_generation": generation,
            "stripe_charge_id": payment["stripe_charge_id"],
            "requested_amount_cents": data.amount_cents,
            "reason": data.reason,
        })
        lease_owner = str(uuid4())
        coordinator = BillingProviderOperationCoordinator(self.supabase)
        claimed = coordinator.claim(
            studio_id=studio_id,
            actor_id=actor_id,
            operation_type=PAYMENT_REFUND_OPERATION_TYPE,
            caller_request_key=normalized_idempotency_key,
            request_sha256=request_sha256,
            stripe_connected_account_id=account_id,
            connect_account_generation=generation,
            lease_owner=lease_owner,
        )
        operation = claimed["operation"]
        context = BillingProviderOperationContext(
            operation_id=str(operation["id"]),
            studio_id=studio_id,
            actor_id=actor_id,
            operation_type=PAYMENT_REFUND_OPERATION_TYPE,
            caller_request_key=normalized_idempotency_key,
            request_sha256=request_sha256,
            stripe_connected_account_id=account_id,
            connect_account_generation=generation,
            lease_owner=lease_owner,
        )
        disposition = provider_operation_disposition(claimed)
        if disposition == "replay":
            try:
                amount = self._refund_operation_amount(operation, data.amount_cents)
                row = self._load_refund_operation_result(
                    payment=payment,
                    operation=operation,
                    context=context,
                    requested_amount_cents=amount,
                )
            except Exception as exc:
                raise HTTPException(
                    status_code=503,
                    detail="Completed refund result could not be verified.",
                ) from exc
            return BillingRefundResponse(**row)
        if operation.get("state") == "projected":
            try:
                amount = self._refund_operation_amount(operation, data.amount_cents)
                row = self._load_refund_operation_result(
                    payment=payment,
                    operation=operation,
                    context=context,
                    requested_amount_cents=amount,
                )
            except Exception as exc:
                self._mark_refund_reconciliation(
                    coordinator,
                    context,
                    operation,
                    "payment_refund_projection_unverified",
                    exc,
                )
            coordinator.complete(context, operation, result_code="payment_refund_completed")
            return BillingRefundResponse(**row)
        if operation.get("state") == "provider_succeeded":
            try:
                amount = self._refund_operation_amount(operation, data.amount_cents)
            except Exception as exc:
                self._mark_refund_reconciliation(
                    coordinator,
                    context,
                    operation,
                    "payment_refund_projection_unverified",
                    exc,
                )
            try:
                row = self._load_refund_operation_result(
                    payment=payment,
                    operation=operation,
                    context=context,
                    requested_amount_cents=amount,
                )
            except Exception:
                row = self._resume_refund_projection(
                    payment=payment,
                    data=data,
                    operation=operation,
                    context=context,
                )
            operation = coordinator.transition(
                context,
                operation,
                "projected",
                result_code="payment_refund_projected",
            )
            coordinator.complete(context, operation, result_code="payment_refund_completed")
            return BillingRefundResponse(**row)

        refundable_remaining = max(
            0,
            int(payment.get("refundable_amount_cents"))
            if payment.get("refundable_amount_cents") is not None
            else (
                int(payment.get("amount_cents") or 0)
                - int(payment.get("refunded_amount_cents") or 0)
                - int(payment.get("disputed_amount_cents") or 0)
            ),
        )
        amount = data.amount_cents or refundable_remaining
        if amount < 1:
            coordinator.transition(
                context,
                operation,
                "definitive_rejected",
                error_code="payment_refund_no_balance",
            )
            raise HTTPException(status_code=409, detail="This payment has no refundable balance.")
        if amount > refundable_remaining:
            coordinator.transition(
                context,
                operation,
                "definitive_rejected",
                error_code="payment_refund_amount_exceeds_remaining",
            )
            raise HTTPException(
                status_code=409,
                detail="Refund amount exceeds the remaining refundable payment balance.",
            )
        operation = coordinator.transition(
            context,
            operation,
            "provider_request_in_flight",
            result_code="payment_refund_started",
            result_summary=f"amount_cents:{amount}",
        )
        try:
            refund = self.stripe_service_cls().create_connected_refund(
                account_id=account_id,
                studio_id=studio_id,
                charge_id=payment["stripe_charge_id"],
                amount=amount,
                reason=data.reason,
                refund_application_fee=True,
                metadata={
                    "studio_id": studio_id,
                    "payment_id": payment_id,
                    "product": "koaryu_payments",
                },
                idempotency_key=self._idempotency_key("payment-refund", context.operation_id),
            )
        except StripeMutationBlocked:
            coordinator.transition(
                context,
                operation,
                "definitive_rejected",
                error_code="provider_mutation_blocked",
            )
            raise
        except Exception as exc:
            self._mark_refund_reconciliation(
                coordinator,
                context,
                operation,
                "payment_refund_provider_outcome_ambiguous",
                exc,
            )
        refund_id = _stripe_id(refund)
        provider_status = self._safe_refund_status(refund)
        if not refund_id:
            self._mark_refund_reconciliation(
                coordinator,
                context,
                operation,
                "payment_refund_provider_identity_ambiguous",
                RuntimeError("payment_refund_provider_identity_ambiguous"),
            )
        try:
            operation = coordinator.transition(
                context,
                operation,
                "provider_succeeded",
                provider_object_id=refund_id,
                result_code=f"payment_refund_status_{provider_status}",
                result_summary=f"amount_cents:{amount}",
            )
        except Exception as exc:
            self._mark_refund_reconciliation(
                coordinator,
                context,
                operation,
                "payment_refund_provider_result_not_recorded",
                exc,
            )
        try:
            row = self._project_refund(refund, account_id)
            self._verify_refund_projection(
                row,
                payment=payment,
                operation=operation,
                context=context,
                expected_amount=amount,
            )
        except Exception as exc:
            self._mark_refund_reconciliation(
                coordinator,
                context,
                operation,
                "payment_refund_local_projection_failed",
                exc,
            )
        operation = coordinator.transition(
            context,
            operation,
            "projected",
            result_code="payment_refund_projected",
        )
        coordinator.complete(context, operation, result_code="payment_refund_completed")
        refund_status = str(row.get("status") or "pending")
        audit_action = (
            "billing.payment_refunded"
            if refund_status == "succeeded"
            else "billing.payment_refund_requested"
        )
        self._audit(studio_id, actor_id, audit_action, payment_id, {
            "amount_cents": amount,
            "stripe_refund_id": row.get("stripe_refund_id"),
            "status": refund_status,
            "operation_id": context.operation_id,
        })
        return BillingRefundResponse(**row)

    def _exact_payment_account_generation(
        self,
        payment: dict[str, Any],
        *,
        studio_id: str,
        account_id: str,
    ) -> int:
        account = self._connect_accounts().by_stripe_account(account_id)
        raw_generation = (account or {}).get("metadata", {}).get("connect_account_generation")
        if raw_generation is None:
            raw_generation = 1
        try:
            generation = int(raw_generation)
            payment_generation = int(payment.get("connect_account_generation"))
        except (TypeError, ValueError):
            generation = 0
            payment_generation = 0
        if (
            not account
            or account.get("studio_id") != studio_id
            or not account.get("charges_enabled")
            or generation <= 0
            or payment_generation != generation
        ):
            raise HTTPException(
                status_code=409,
                detail="Payment Stripe account identity is not current enough to refund safely.",
            )
        return generation

    @staticmethod
    def _refund_operation_amount(
        operation: dict[str, Any],
        requested_amount_cents: int | None,
    ) -> int:
        summary = str(operation.get("result_summary") or "")
        try:
            amount = int(summary.removeprefix("amount_cents:"))
        except ValueError:
            amount = 0
        if (
            not summary.startswith("amount_cents:")
            or amount < 1
            or (requested_amount_cents is not None and amount != requested_amount_cents)
        ):
            raise RuntimeError("payment_refund_saved_amount_invalid")
        return amount

    @staticmethod
    def _safe_refund_status(refund: Any) -> str:
        if isinstance(refund, dict):
            value = refund.get("status")
        else:
            value = getattr(refund, "status", None)
        normalized = str(value or "pending").strip().lower()
        return normalized if normalized in {"pending", "succeeded", "failed", "canceled"} else "unknown"

    def _load_refund_operation_result(
        self,
        *,
        payment: dict[str, Any],
        operation: dict[str, Any],
        context: BillingProviderOperationContext,
        requested_amount_cents: int | None,
    ) -> dict[str, Any]:
        refund_id = str(operation.get("provider_object_id") or "")
        result = (
            self.supabase.table("billing_refunds")
            .select("*")
            .eq("studio_id", context.studio_id)
            .eq("stripe_account_id", context.stripe_connected_account_id)
            .eq("stripe_refund_id", refund_id)
            .limit(1)
            .execute()
        )
        if not result.data:
            raise RuntimeError("payment_refund_saved_result_missing")
        row = result.data[0]
        self._verify_refund_projection(
            row,
            payment=payment,
            operation=operation,
            context=context,
            expected_amount=requested_amount_cents,
        )
        return row

    def _resume_refund_projection(
        self,
        *,
        payment: dict[str, Any],
        data: BillingRefundCreate,
        operation: dict[str, Any],
        context: BillingProviderOperationContext,
    ) -> dict[str, Any]:
        coordinator = BillingProviderOperationCoordinator(self.supabase)
        result_code = str(operation.get("result_code") or "")
        prefix = "payment_refund_status_"
        provider_status = result_code[len(prefix):] if result_code.startswith(prefix) else ""
        try:
            if provider_status not in {"pending", "succeeded", "failed", "canceled", "unknown"}:
                raise RuntimeError("payment_refund_saved_status_invalid")
            amount = self._refund_operation_amount(operation, data.amount_cents)
        except Exception as exc:
            self._mark_refund_reconciliation(
                coordinator,
                context,
                operation,
                "payment_refund_projection_unverified",
                exc,
            )
        try:
            row = self._project_refund({
                "id": operation["provider_object_id"],
                "charge": payment["stripe_charge_id"],
                "payment_intent": payment.get("stripe_payment_intent_id"),
                "amount": amount,
                "reason": data.reason,
                "status": provider_status,
                "metadata": {
                    "studio_id": context.studio_id,
                    "payment_id": payment["id"],
                    "product": "koaryu_payments",
                },
            }, context.stripe_connected_account_id)
            self._verify_refund_projection(
                row,
                payment=payment,
                operation=operation,
                context=context,
                expected_amount=amount,
            )
            return row
        except Exception as exc:
            self._mark_refund_reconciliation(
                coordinator,
                context,
                operation,
                "payment_refund_local_projection_failed",
                exc,
            )

    @staticmethod
    def _verify_refund_projection(
        row: dict[str, Any],
        *,
        payment: dict[str, Any],
        operation: dict[str, Any],
        context: BillingProviderOperationContext,
        expected_amount: int | None,
    ) -> None:
        if (
            not row
            or row.get("studio_id") != context.studio_id
            or row.get("payment_id") != payment.get("id")
            or row.get("stripe_refund_id") != operation.get("provider_object_id")
            or row.get("stripe_charge_id") != payment.get("stripe_charge_id")
            or row.get("stripe_account_id") != context.stripe_connected_account_id
            or row.get("connect_account_generation") != context.connect_account_generation
            or row.get("reconciliation_required") is True
            or (expected_amount is not None and int(row.get("amount_cents") or 0) != expected_amount)
        ):
            raise RuntimeError("payment_refund_projection_not_converged")

    @staticmethod
    def _mark_refund_reconciliation(
        coordinator: BillingProviderOperationCoordinator,
        context: BillingProviderOperationContext,
        operation: dict[str, Any],
        reason_code: str,
        exc: Exception,
    ) -> None:
        try:
            coordinator.transition(
                context,
                operation,
                "reconciliation_required",
                reconciliation_reason_code=reason_code,
            )
        except Exception:
            pass
        raise HTTPException(status_code=503, detail=REFUND_AMBIGUOUS_DETAIL) from exc

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
