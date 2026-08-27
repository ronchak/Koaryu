from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any
from uuid import NAMESPACE_URL, uuid4, uuid5

from fastapi import HTTPException, status
from postgrest.exceptions import APIError as PostgrestAPIError
from stripe import (
    AuthenticationError as StripeAuthenticationError,
    CardError as StripeCardError,
    InvalidRequestError as StripeInvalidRequestError,
    PermissionError as StripePermissionError,
    RateLimitError as StripeRateLimitError,
)

from app.schemas.billing import BillingInvoiceCreate, BillingInvoiceResponse
from app.services.billing_invoice_projection import _object_get, _stripe_id
from app.services.billing_provider_operations import (
    AUTOPAY_TERMS_VERSION,
    BillingProviderOperationContext,
    BillingProviderOperationCoordinator,
    BillingProviderOperationStepContext,
    BillingProviderStepCoordinator,
    INVOICE_CREATE_OPERATION_TYPE,
    INVOICE_FINALIZE_OPERATION_TYPE,
    INVOICE_RETRY_OPERATION_TYPE,
    INVOICE_VOID_OPERATION_TYPE,
    billing_provider_step_plan_sha256,
    provider_operation_disposition,
)
from app.services.platform_billing_helpers import normalize_idempotency_key, stable_hash
from app.services.stripe_mutation_policy import StripeMutationBlocked
from app.services.stripe_service import StripeService


logger = logging.getLogger("app.services.billing_invoices")


INVOICE_CREATE_AMBIGUOUS_DETAIL = (
    "Invoice creation outcome is not confirmed. "
    "Retry with the same Idempotency-Key after reconciliation."
)
INVOICE_RETRY_AMBIGUOUS_DETAIL = (
    "Invoice payment outcome is not confirmed. "
    "Retry with the same Idempotency-Key after reconciliation."
)
INVOICE_FINALIZE_AMBIGUOUS_DETAIL = (
    "Invoice finalization outcome is not confirmed. "
    "Retry with the same Idempotency-Key after reconciliation."
)
INVOICE_VOID_AMBIGUOUS_DETAIL = (
    "Invoice void outcome is not confirmed. "
    "Retry with the same Idempotency-Key after reconciliation."
)
INVOICE_CREATE_MODE = "invoice_create_mode:invoice_items"
INVOICE_FINALIZE_MODE = "invoice_finalize_mode:finalize"
INVOICE_FINALIZE_SEND_MODE = "invoice_finalize_mode:finalize_send"
INVOICE_RETRY_MODE = "invoice_retry_mode:pay"
INVOICE_VOID_MODE = "invoice_void_mode:void"


class BillingInvoiceOperationWorkflow:
    def __init__(self, owner: Any, *, stripe_service_cls: type[StripeService] = StripeService):
        self.owner = owner
        self.supabase = owner.supabase
        self.stripe_service_cls = stripe_service_cls

    def create_invoice(
        self,
        data: BillingInvoiceCreate,
        studio_id: str,
        actor_id: str,
        idempotency_key: str | None,
    ) -> BillingInvoiceResponse:
        request_key = self._required_key(idempotency_key, "invoice creation")
        if data.send_hosted_invoice:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Hosted invoice finalization and sending are separate unsupported actions.",
            )
        payer = self.owner._get_row_or_404(
            "billing_payers", data.payer_id, studio_id, "Payer not found."
        )
        items = self._normalized_items(data, studio_id)
        account = self._local_ready_account(studio_id)
        account_id = str(account["stripe_connected_account_id"])
        generation = self._account_generation(account)
        self._require_exact_payer(payer, account_id, generation)
        if data.collection_mode == "autopay":
            if not payer.get("default_payment_method_id"):
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="Autopay requires a saved payer payment method.",
                )
            if not self.owner._payer_autopay_authorized(payer):
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="Autopay requires verified payer-owned consent.",
                )

        amount_due = sum(item["amount_cents"] * item["quantity"] for item in items)
        application_fee = self.owner._application_fee_amount(amount_due, account)
        caller_hash = self.owner._invoice_request_hash(data)
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
            "stripe_account_id": account_id,
            "stripe_customer_id": payer["stripe_customer_id"],
            "collection_method": (
                "charge_automatically"
                if data.collection_mode == "autopay"
                else "send_invoice"
            ),
            "application_fee_amount_cents": application_fee,
            "external": False,
            "idempotency_key": request_key,
            "request_hash": caller_hash,
            "metadata": {
                "connect_account_generation": generation,
                "provider_workflow": INVOICE_CREATE_OPERATION_TYPE,
            },
        }
        local_invoice = self.owner._claim_invoice_create_request(
            studio_id,
            request_key,
            caller_hash,
            invoice_row,
        )
        self._verify_local_invoice_intent(
            local_invoice,
            payer=payer,
            account_id=account_id,
            generation=generation,
            amount_due=amount_due,
            application_fee=application_fee,
        )
        desired_hash = stable_hash({
            "operation_type": INVOICE_CREATE_OPERATION_TYPE,
            "studio_id": studio_id,
            "invoice_id": local_invoice["id"],
            "payer_id": payer["id"],
            "stripe_customer_id": payer["stripe_customer_id"],
            "stripe_connected_account_id": account_id,
            "connect_account_generation": generation,
            "collection_method": invoice_row["collection_method"],
            "application_fee_amount_cents": application_fee,
            "currency": data.currency,
            "due_date": str(data.due_date) if data.due_date else None,
            "items": items,
        })
        operations = BillingProviderOperationCoordinator(self.supabase)
        context, claimed = self._claim_parent(
            operations,
            studio_id=studio_id,
            actor_id=actor_id,
            operation_type=INVOICE_CREATE_OPERATION_TYPE,
            caller_request_key=request_key,
            request_sha256=desired_hash,
            account_id=account_id,
            generation=generation,
        )
        operation = claimed["operation"]
        state = str(operation.get("state") or "")
        outcome = str(claimed.get("outcome") or "")
        if state == "completed":
            try:
                invoice = self._load_created_invoice(
                    local_invoice, context, operation, items
                )
            except Exception as exc:
                raise HTTPException(
                    status_code=503,
                    detail=INVOICE_CREATE_AMBIGUOUS_DETAIL,
                ) from exc
            self._audit_created_once(context, invoice)
            return BillingInvoiceResponse(**invoice)
        if state == "reconciliation_required" or outcome == "reconciliation_required":
            raise HTTPException(status_code=409, detail=INVOICE_CREATE_AMBIGUOUS_DETAIL)
        if state == "provider_request_in_flight" or outcome in {
            "busy", "provider_request_in_flight"
        }:
            provider_operation_disposition(claimed)
        if state in {"definitive_failed", "definitive_rejected"}:
            provider_operation_disposition(claimed)
        if state == "projected":
            try:
                invoice = self._load_created_invoice(local_invoice, context, operation, items)
            except Exception as exc:
                self._mark_parent_reconciliation(
                    operations,
                    context,
                    operation,
                    "invoice_create_projection_unverified",
                    exc,
                    INVOICE_CREATE_AMBIGUOUS_DETAIL,
                )
            operations.complete(context, operation, result_code="invoice_create_completed")
            self._audit_created_once(context, invoice)
            self.owner._recompute_payer_balance(studio_id, payer["id"])
            return BillingInvoiceResponse(**invoice)

        spec = self._invoice_step_plan(
            local_invoice,
            payer=payer,
            context=context,
            items=items,
            application_fee=application_fee,
            due_date=data.due_date,
        )
        if state == "provider_succeeded":
            if operation.get("result_code") != "provider_step_phase_completed":
                self._mark_parent_reconciliation(
                    operations,
                    context,
                    operation,
                    "invoice_create_provider_phase_unverified",
                    RuntimeError("invoice_create_provider_phase_unverified"),
                    INVOICE_CREATE_AMBIGUOUS_DETAIL,
                )
            try:
                invoice = self._project_created_invoice(
                    local_invoice,
                    context,
                    operation,
                    spec=spec,
                    items=items,
                )
            except Exception as exc:
                self._mark_parent_reconciliation(
                    operations,
                    context,
                    operation,
                    "invoice_create_projection_failed",
                    exc,
                    INVOICE_CREATE_AMBIGUOUS_DETAIL,
                )
        else:
            invoice = self._execute_invoice_steps(
                local_invoice,
                payer=payer,
                context=context,
                operation=operation,
                operations=operations,
                spec=spec,
                items=items,
                application_fee=application_fee,
                due_date=data.due_date,
            )
        operation = operations.transition(
            context,
            operation if state == "provider_succeeded" else invoice.pop("_operation"),
            "projected",
            result_code="invoice_create_projected",
            result_summary=INVOICE_CREATE_MODE,
        )
        operations.complete(context, operation, result_code="invoice_create_completed")
        self._audit_created_once(context, invoice)
        self.owner._recompute_payer_balance(studio_id, payer["id"])
        return BillingInvoiceResponse(**invoice)

    async def finalize_invoice(
        self,
        invoice_id: str,
        studio_id: str,
        actor_id: str,
        idempotency_key: str | None,
    ) -> BillingInvoiceResponse:
        request_key = self._required_key(idempotency_key, "invoice finalization")
        invoice = self.owner._get_row_or_404(
            "billing_invoices", invoice_id, studio_id, "Invoice not found."
        )
        if not invoice.get("stripe_invoice_id") or not invoice.get("stripe_account_id"):
            raise HTTPException(status_code=409, detail="Invoice is not linked to Stripe.")
        _account, generation = self._invoice_generation(invoice, studio_id)
        payer = self.owner._get_row_or_404(
            "billing_payers", invoice["payer_id"], studio_id, "Payer not found."
        )
        self._require_exact_payer(payer, str(invoice["stripe_account_id"]), generation)
        provider_before = self._read_invoice(invoice)
        collection_method, provider_before_status = self._verify_finalize_preread(
            invoice, provider_before
        )
        desired_hash = stable_hash({
            "operation_type": INVOICE_FINALIZE_OPERATION_TYPE,
            "studio_id": studio_id,
            "invoice_id": invoice_id,
            "payer_id": invoice["payer_id"],
            "stripe_invoice_id": invoice["stripe_invoice_id"],
            "stripe_customer_id": invoice["stripe_customer_id"],
            "stripe_connected_account_id": invoice["stripe_account_id"],
            "connect_account_generation": generation,
            "collection_method": collection_method,
        })
        operations = BillingProviderOperationCoordinator(self.supabase)
        context, claimed = self._claim_parent(
            operations,
            studio_id=studio_id,
            actor_id=actor_id,
            operation_type=INVOICE_FINALIZE_OPERATION_TYPE,
            caller_request_key=request_key,
            request_sha256=desired_hash,
            account_id=str(invoice["stripe_account_id"]),
            generation=generation,
            resource_type="invoice_finalize",
            resource_id=invoice_id,
            resource_payer_id=str(invoice["payer_id"]),
        )
        operation = claimed["operation"]
        state = str(operation.get("state") or "")
        outcome = str(claimed.get("outcome") or "")
        result_summary = (
            INVOICE_FINALIZE_SEND_MODE
            if collection_method == "send_invoice"
            else INVOICE_FINALIZE_MODE
        )
        if state == "completed":
            try:
                finalized = self._load_finalized_invoice(
                    invoice_id, context, operation, result_summary
                )
            except Exception as exc:
                raise HTTPException(
                    status_code=503, detail=INVOICE_FINALIZE_AMBIGUOUS_DETAIL
                ) from exc
            self._audit_finalized_once(context, finalized)
            return BillingInvoiceResponse(**finalized)
        if state == "projected":
            try:
                finalized = self._load_finalized_invoice(
                    invoice_id, context, operation, result_summary
                )
            except Exception as exc:
                self._mark_parent_reconciliation(
                    operations, context, operation,
                    "invoice_finalize_projection_unverified", exc,
                    INVOICE_FINALIZE_AMBIGUOUS_DETAIL,
                )
            self.owner._recompute_payer_balance(studio_id, invoice["payer_id"])
            operations.complete(
                context, operation, result_code="invoice_finalize_completed"
            )
            self._audit_finalized_once(context, finalized)
            return BillingInvoiceResponse(**finalized)
        if state == "provider_succeeded":
            try:
                finalized = self._project_finalized_invoice(invoice, context, operation)
            except Exception as exc:
                self._mark_parent_reconciliation(
                    operations, context, operation,
                    "invoice_finalize_projection_failed", exc,
                    INVOICE_FINALIZE_AMBIGUOUS_DETAIL,
                )
        elif state == "reconciliation_required" or outcome == "reconciliation_required":
            if collection_method == "send_invoice" or provider_before_status not in {
                "open", "paid"
            }:
                raise HTTPException(
                    status_code=409, detail=INVOICE_FINALIZE_AMBIGUOUS_DETAIL
                )
            operation = operations.transition(
                context,
                operation,
                "provider_succeeded",
                provider_object_id=str(invoice["stripe_invoice_id"]),
                result_code="invoice_finalize_provider_verified",
            )
            finalized = self._project_finalized_invoice(
                invoice, context, operation, provider=provider_before
            )
        elif state == "provider_request_in_flight" or outcome in {
            "busy", "provider_request_in_flight"
        }:
            raise HTTPException(status_code=409, detail=INVOICE_FINALIZE_AMBIGUOUS_DETAIL)
        elif state in {"definitive_failed", "definitive_rejected"}:
            provider_operation_disposition(claimed)
        elif provider_before_status != "draft":
            operations.transition(
                context,
                operation,
                "definitive_rejected",
                error_code="invoice_not_draft",
            )
            raise HTTPException(
                status_code=409,
                detail="Invoice was finalized outside this workflow and requires reconciliation.",
            )
        elif collection_method == "send_invoice":
            finalized, operation = self._execute_finalize_steps(
                invoice, context=context, operation=operation, operations=operations
            )
        else:
            finalized, operation = self._execute_finalize_single(
                invoice, context=context, operation=operation, operations=operations
            )
        operation = operations.transition(
            context,
            operation,
            "projected",
            result_code="invoice_finalize_projected",
            result_summary=result_summary,
        )
        self.owner._recompute_payer_balance(studio_id, invoice["payer_id"])
        operations.complete(context, operation, result_code="invoice_finalize_completed")
        self._audit_finalized_once(context, finalized)
        return BillingInvoiceResponse(**finalized)

    async def void_invoice(
        self,
        invoice_id: str,
        studio_id: str,
        actor_id: str,
        idempotency_key: str | None,
    ) -> BillingInvoiceResponse:
        request_key = self._required_key(idempotency_key, "invoice void")
        invoice = self.owner._get_row_or_404(
            "billing_invoices", invoice_id, studio_id, "Invoice not found."
        )
        if not invoice.get("stripe_invoice_id") and not invoice.get("stripe_account_id"):
            result = (
                self.supabase.table("billing_invoices")
                .update({
                    "status": "void",
                    "voided_at": datetime.now(timezone.utc).isoformat(),
                })
                .eq("id", invoice_id)
                .eq("studio_id", studio_id)
                .execute()
            )
            if not result.data:
                raise HTTPException(status_code=404, detail="Invoice not found.")
            local_void = result.data[0]
            self.owner._audit(studio_id, actor_id, "billing.invoice_voided", invoice_id, {
                "provider_workflow": "local_only",
            })
            self.owner._recompute_payer_balance(studio_id, local_void.get("payer_id"))
            return BillingInvoiceResponse(**local_void)
        if not invoice.get("stripe_invoice_id") or not invoice.get("stripe_account_id"):
            raise HTTPException(
                status_code=409,
                detail="Invoice provider identity is incomplete and requires reconciliation.",
            )
        _account, generation = self._invoice_generation(invoice, studio_id)
        provider_before = self._read_invoice(invoice)
        provider_status = self._verify_void_preread(invoice, provider_before)
        desired_hash = stable_hash({
            "operation_type": INVOICE_VOID_OPERATION_TYPE,
            "studio_id": studio_id,
            "invoice_id": invoice_id,
            "payer_id": invoice["payer_id"],
            "stripe_invoice_id": invoice["stripe_invoice_id"],
            "stripe_connected_account_id": invoice["stripe_account_id"],
            "connect_account_generation": generation,
        })
        operations = BillingProviderOperationCoordinator(self.supabase)
        context, claimed = self._claim_parent(
            operations,
            studio_id=studio_id,
            actor_id=actor_id,
            operation_type=INVOICE_VOID_OPERATION_TYPE,
            caller_request_key=request_key,
            request_sha256=desired_hash,
            account_id=str(invoice["stripe_account_id"]),
            generation=generation,
            resource_type="invoice_void",
            resource_id=invoice_id,
            resource_payer_id=str(invoice["payer_id"]),
        )
        operation = claimed["operation"]
        state = str(operation.get("state") or "")
        outcome = str(claimed.get("outcome") or "")
        if state == "completed":
            try:
                voided = self._load_void_invoice(invoice_id, context, operation)
            except Exception as exc:
                raise HTTPException(
                    status_code=503, detail=INVOICE_VOID_AMBIGUOUS_DETAIL
                ) from exc
            self._audit_voided_once(context, voided)
            return BillingInvoiceResponse(**voided)
        if state == "projected":
            voided = self._load_void_invoice(invoice_id, context, operation)
            self.owner._recompute_payer_balance(studio_id, voided.get("payer_id"))
            operations.complete(context, operation, result_code="invoice_void_completed")
            self._audit_voided_once(context, voided)
            return BillingInvoiceResponse(**voided)
        if state == "provider_succeeded":
            try:
                voided = self._project_void_invoice(invoice, context, operation)
            except Exception as exc:
                self._mark_parent_reconciliation(
                    operations, context, operation,
                    "invoice_void_projection_failed", exc,
                    INVOICE_VOID_AMBIGUOUS_DETAIL,
                )
        elif state == "reconciliation_required" or outcome == "reconciliation_required":
            readback = self._read_invoice(invoice)
            if str(_object_get(readback, "status") or "") != "void":
                raise HTTPException(status_code=409, detail=INVOICE_VOID_AMBIGUOUS_DETAIL)
            operation = operations.transition(
                context,
                operation,
                "provider_succeeded",
                provider_object_id=str(invoice["stripe_invoice_id"]),
                result_code="invoice_void_provider_verified",
            )
            voided = self._project_void_invoice(
                invoice, context, operation, provider=readback
            )
        elif state == "provider_request_in_flight" or outcome in {
            "busy", "provider_request_in_flight"
        }:
            raise HTTPException(status_code=409, detail=INVOICE_VOID_AMBIGUOUS_DETAIL)
        elif state in {"definitive_failed", "definitive_rejected"}:
            provider_operation_disposition(claimed)
        elif provider_status == "void":
            operations.transition(
                context,
                operation,
                "definitive_rejected",
                error_code="invoice_already_void",
            )
            raise HTTPException(
                status_code=409,
                detail="Invoice was voided outside this workflow and requires reconciliation.",
            )
        else:
            operation = operations.transition(
                context,
                operation,
                "provider_request_in_flight",
                result_code="invoice_void_started",
                result_summary=INVOICE_VOID_MODE,
            )
            try:
                provider_void = self.stripe_service_cls().void_connected_invoice(
                    account_id=context.stripe_connected_account_id,
                    studio_id=context.studio_id,
                    invoice_id=str(invoice["stripe_invoice_id"]),
                    idempotency_key=self.owner._idempotency_key(
                        "invoice-void", context.operation_id
                    ),
                )
            except StripeMutationBlocked:
                operations.transition(
                    context, operation, "definitive_rejected",
                    error_code="provider_mutation_blocked",
                )
                raise
            except Exception as exc:
                self._mark_parent_reconciliation(
                    operations, context, operation,
                    "invoice_void_provider_outcome_ambiguous", exc,
                    INVOICE_VOID_AMBIGUOUS_DETAIL,
                )
            if (
                _stripe_id(provider_void) != invoice.get("stripe_invoice_id")
                or str(_object_get(provider_void, "status") or "") != "void"
            ):
                self._mark_parent_reconciliation(
                    operations, context, operation,
                    "invoice_void_provider_identity_ambiguous",
                    RuntimeError("invoice_void_provider_identity_ambiguous"),
                    INVOICE_VOID_AMBIGUOUS_DETAIL,
                )
            operation = operations.transition(
                context,
                operation,
                "provider_succeeded",
                provider_object_id=str(invoice["stripe_invoice_id"]),
                result_code="invoice_void_provider_succeeded",
            )
            try:
                voided = self._project_void_invoice(
                    invoice, context, operation, provider=provider_void
                )
            except Exception as exc:
                self._mark_parent_reconciliation(
                    operations, context, operation,
                    "invoice_void_projection_failed", exc,
                    INVOICE_VOID_AMBIGUOUS_DETAIL,
                )
        operation = operations.transition(
            context,
            operation,
            "projected",
            result_code="invoice_void_projected",
            result_summary=INVOICE_VOID_MODE,
        )
        self.owner._recompute_payer_balance(studio_id, voided.get("payer_id"))
        operations.complete(context, operation, result_code="invoice_void_completed")
        self._audit_voided_once(context, voided)
        return BillingInvoiceResponse(**voided)

    async def retry_invoice_payment(
        self,
        invoice_id: str,
        studio_id: str,
        actor_id: str,
        idempotency_key: str | None,
    ) -> BillingInvoiceResponse:
        request_key = self._required_key(idempotency_key, "invoice payment retry")
        invoice = self.owner._get_row_or_404(
            "billing_invoices", invoice_id, studio_id, "Invoice not found."
        )
        if not invoice.get("stripe_invoice_id") or not invoice.get("stripe_account_id"):
            raise HTTPException(status_code=409, detail="Invoice is not linked to Stripe.")
        account, generation = self._invoice_generation(invoice, studio_id)
        desired_hash = stable_hash({
            "operation_type": INVOICE_RETRY_OPERATION_TYPE,
            "studio_id": studio_id,
            "invoice_id": invoice_id,
            "stripe_invoice_id": invoice["stripe_invoice_id"],
            "stripe_connected_account_id": invoice["stripe_account_id"],
            "connect_account_generation": generation,
        })
        operations = BillingProviderOperationCoordinator(self.supabase)
        context, claimed = self._claim_parent(
            operations,
            studio_id=studio_id,
            actor_id=actor_id,
            operation_type=INVOICE_RETRY_OPERATION_TYPE,
            caller_request_key=request_key,
            request_sha256=desired_hash,
            account_id=str(invoice["stripe_account_id"]),
            generation=generation,
            resource_type="invoice",
            resource_id=invoice_id,
            resource_payer_id=str(invoice["payer_id"]),
        )
        operation = claimed["operation"]
        state = str(operation.get("state") or "")
        outcome = str(claimed.get("outcome") or "")
        if state == "completed":
            try:
                paid = self._load_paid_invoice(invoice_id, context, operation)
            except Exception as exc:
                raise HTTPException(
                    status_code=503,
                    detail=INVOICE_RETRY_AMBIGUOUS_DETAIL,
                ) from exc
            self._audit_retry_once(context, paid)
            return BillingInvoiceResponse(**paid)
        if state == "projected":
            try:
                paid = self._load_paid_invoice(invoice_id, context, operation)
            except Exception as exc:
                self._mark_parent_reconciliation(
                    operations,
                    context,
                    operation,
                    "invoice_retry_projection_unverified",
                    exc,
                    INVOICE_RETRY_AMBIGUOUS_DETAIL,
                )
            operations.complete(context, operation, result_code="invoice_retry_completed")
            self._audit_retry_once(context, paid)
            return BillingInvoiceResponse(**paid)
        if state == "provider_succeeded":
            try:
                paid = self._finish_retry_projection(
                    invoice, context, operation, operations
                )
            except Exception as exc:
                self._mark_parent_reconciliation(
                    operations,
                    context,
                    operation,
                    "invoice_retry_projection_failed",
                    exc,
                    INVOICE_RETRY_AMBIGUOUS_DETAIL,
                )
            return BillingInvoiceResponse(**paid)
        if state == "reconciliation_required" or outcome == "reconciliation_required":
            paid = self._retry_readback(invoice, context, operation, operations)
            return BillingInvoiceResponse(**paid)
        if state == "provider_request_in_flight" or outcome in {
            "busy", "provider_request_in_flight"
        }:
            raise HTTPException(status_code=409, detail=INVOICE_RETRY_AMBIGUOUS_DETAIL)
        if state in {"definitive_failed", "definitive_rejected"}:
            provider_operation_disposition(claimed)
        if invoice.get("status") == "paid" or int(invoice.get("amount_remaining_cents") or 0) == 0:
            operations.transition(
                context,
                operation,
                "definitive_rejected",
                error_code="invoice_already_paid",
            )
            raise HTTPException(status_code=409, detail="Invoice is already paid.")

        retry_autopay_consent: dict[str, Any] | None = None
        if invoice.get("collection_method") == "charge_automatically":
            try:
                retry_autopay_consent = self._require_retry_autopay_consent(
                    invoice,
                    studio_id=studio_id,
                    generation=generation,
                )
            except HTTPException:
                operations.transition(
                    context,
                    operation,
                    "definitive_rejected",
                    error_code="invoice_retry_autopay_consent_invalid",
                )
                raise

        if retry_autopay_consent is not None:
            try:
                self._require_retry_autopay_consent_current(
                    invoice,
                    studio_id=studio_id,
                    generation=generation,
                    expected=retry_autopay_consent,
                )
            except HTTPException:
                operations.transition(
                    context,
                    operation,
                    "definitive_rejected",
                    error_code="invoice_retry_autopay_consent_invalid",
                )
                raise

        operation = operations.transition(
            context,
            operation,
            "provider_request_in_flight",
            result_code="invoice_retry_started",
            result_summary=INVOICE_RETRY_MODE,
        )
        try:
            provider_invoice = self.stripe_service_cls().pay_connected_invoice(
                account_id=context.stripe_connected_account_id,
                studio_id=context.studio_id,
                invoice_id=str(invoice["stripe_invoice_id"]),
                idempotency_key=self.owner._idempotency_key(
                    "invoice-retry", context.operation_id
                ),
            )
        except StripeMutationBlocked as exc:
            operations.transition(
                context,
                operation,
                "definitive_rejected",
                error_code="provider_mutation_blocked",
            )
            raise exc
        except Exception as exc:
            definitive = self._definitive_invoice_retry_error(exc)
            if definitive is not None:
                response_status, detail, error_code = definitive
                operations.transition(
                    context,
                    operation,
                    "definitive_rejected",
                    error_code=error_code,
                )
                raise HTTPException(status_code=response_status, detail=detail) from None
            self._mark_parent_reconciliation(
                operations,
                context,
                operation,
                "invoice_retry_provider_outcome_ambiguous",
                exc,
                INVOICE_RETRY_AMBIGUOUS_DETAIL,
            )
        provider_id = _stripe_id(provider_invoice)
        if provider_id != invoice.get("stripe_invoice_id"):
            self._mark_parent_reconciliation(
                operations,
                context,
                operation,
                "invoice_retry_provider_identity_ambiguous",
                RuntimeError("invoice_retry_provider_identity_ambiguous"),
                INVOICE_RETRY_AMBIGUOUS_DETAIL,
            )
        if str(_object_get(provider_invoice, "status") or "") != "paid":
            self._mark_parent_reconciliation(
                operations,
                context,
                operation,
                "invoice_retry_provider_nonterminal",
                RuntimeError("invoice_retry_provider_nonterminal"),
                INVOICE_RETRY_AMBIGUOUS_DETAIL,
            )
        operation = operations.transition(
            context,
            operation,
            "provider_succeeded",
            provider_object_id=provider_id,
            result_code="invoice_retry_provider_paid",
        )
        try:
            paid = self._project_paid_invoice(invoice, provider_invoice, context)
        except Exception as exc:
            self._mark_parent_reconciliation(
                operations,
                context,
                operation,
                "invoice_retry_projection_failed",
                exc,
                INVOICE_RETRY_AMBIGUOUS_DETAIL,
            )
        return BillingInvoiceResponse(**self._finish_retry_projection(
            paid,
            context,
            operation,
            operations,
            already_projected=True,
        ))

    def _require_retry_autopay_consent(
        self,
        invoice: dict[str, Any],
        *,
        studio_id: str,
        generation: int,
    ) -> dict[str, Any]:
        payer, consent, payment_method_id = self._read_retry_autopay_consent(
            invoice,
            studio_id=studio_id,
            generation=generation,
        )
        detail = self._retry_autopay_consent_detail()
        setup_intent_id = str(consent["stripe_setup_intent_id"])
        try:
            provider_invoice = self._read_invoice(invoice)
            setup_intent = self.stripe_service_cls().retrieve_connected_setup_intent(
                account_id=str(invoice["stripe_account_id"]),
                setup_intent_id=setup_intent_id,
            )
        except Exception:
            raise HTTPException(status_code=409, detail=detail) from None

        invoice_metadata = _object_get(provider_invoice, "metadata") or {}
        setup_metadata = _object_get(setup_intent, "metadata") or {}
        if (
            _stripe_id(provider_invoice) != invoice.get("stripe_invoice_id")
            or _stripe_id(_object_get(provider_invoice, "customer"))
            != invoice.get("stripe_customer_id")
            or str(_object_get(provider_invoice, "status") or "") != "open"
            or str(_object_get(provider_invoice, "collection_method") or "")
            != "charge_automatically"
            or _stripe_id(_object_get(provider_invoice, "default_payment_method"))
            != payment_method_id
            or str(invoice_metadata.get("studio_id") or "") != studio_id
            or str(invoice_metadata.get("payer_id") or "")
            != str(invoice.get("payer_id") or "")
            or str(invoice_metadata.get("invoice_id") or "")
            != str(invoice.get("id") or "")
            or _stripe_id(setup_intent) != setup_intent_id
            or str(_object_get(setup_intent, "status") or "") != "succeeded"
            or _stripe_id(_object_get(setup_intent, "customer"))
            != invoice.get("stripe_customer_id")
            or _stripe_id(_object_get(setup_intent, "payment_method"))
            != payment_method_id
            or setup_metadata.get("product") != "koaryu_payments_autopay"
            or setup_metadata.get("studio_id") != studio_id
            or setup_metadata.get("payer_id") != str(invoice["payer_id"])
            or setup_metadata.get("setup_request_id")
            != str(consent.get("setup_request_id") or "")
            or setup_metadata.get("terms_version") != AUTOPAY_TERMS_VERSION
            or setup_metadata.get("stripe_account_id")
            != str(invoice["stripe_account_id"])
            or setup_metadata.get("connect_account_generation") != str(generation)
        ):
            raise HTTPException(status_code=409, detail=detail)
        return self._retry_autopay_consent_snapshot(payer, consent)

    def _require_retry_autopay_consent_current(
        self,
        invoice: dict[str, Any],
        *,
        studio_id: str,
        generation: int,
        expected: dict[str, Any],
    ) -> None:
        payer, consent, _ = self._read_retry_autopay_consent(
            invoice,
            studio_id=studio_id,
            generation=generation,
        )
        if self._retry_autopay_consent_snapshot(payer, consent) != expected:
            raise HTTPException(
                status_code=409,
                detail=self._retry_autopay_consent_detail(),
            )

    def _read_retry_autopay_consent(
        self,
        invoice: dict[str, Any],
        *,
        studio_id: str,
        generation: int,
    ) -> tuple[dict[str, Any], dict[str, Any], str]:
        detail = self._retry_autopay_consent_detail()
        payer = self.owner._get_row_or_404(
            "billing_payers",
            invoice["payer_id"],
            studio_id,
            "Payer not found.",
        )
        try:
            self._require_exact_payer(
                payer,
                str(invoice["stripe_account_id"]),
                generation,
            )
        except HTTPException:
            raise HTTPException(status_code=409, detail=detail) from None

        payment_method_id = str(payer.get("default_payment_method_id") or "")
        if (
            payer.get("stripe_customer_id") != invoice.get("stripe_customer_id")
            or payer.get("autopay_status") != "enabled"
            or not payer.get("autopay_authorized_at")
            or not payer.get("autopay_terms_accepted_at")
            or not payment_method_id
        ):
            raise HTTPException(status_code=409, detail=detail)

        try:
            consent = BillingProviderOperationCoordinator(
                self.supabase
            ).read_active_payer_consent(
                studio_id=studio_id,
                payer_id=str(invoice["payer_id"]),
                terms_version=AUTOPAY_TERMS_VERSION,
                stripe_connected_account_id=str(invoice["stripe_account_id"]),
                connect_account_generation=generation,
            )
            setup_intent_id = str(consent.get("stripe_setup_intent_id") or "")
            if (
                not setup_intent_id
                or not consent.get("completed_at")
                or consent.get("revoked_at")
                or consent.get("superseded_at")
                or consent.get("completed_at") != payer.get("autopay_authorized_at")
                or consent.get("accepted_at")
                != payer.get("autopay_terms_accepted_at")
            ):
                raise RuntimeError("invoice_retry_autopay_consent_not_active")
        except Exception:
            raise HTTPException(status_code=409, detail=detail) from None
        return payer, consent, payment_method_id

    @staticmethod
    def _retry_autopay_consent_snapshot(
        payer: dict[str, Any],
        consent: dict[str, Any],
    ) -> dict[str, Any]:
        return {
            "payer": {
                key: payer.get(key)
                for key in (
                    "id",
                    "stripe_account_id",
                    "stripe_customer_id",
                    "connect_account_generation",
                    "default_payment_method_id",
                    "autopay_status",
                    "autopay_authorized_at",
                    "autopay_terms_accepted_at",
                )
            },
            "consent": {
                key: consent.get(key)
                for key in (
                    "id",
                    "setup_request_id",
                    "studio_id",
                    "payer_id",
                    "terms_version",
                    "stripe_connected_account_id",
                    "connect_account_generation",
                    "stripe_setup_intent_id",
                    "accepted_at",
                    "completed_at",
                    "revoked_at",
                    "superseded_at",
                    "revision",
                )
            },
        }

    @staticmethod
    def _retry_autopay_consent_detail() -> str:
        return (
            "Autopay consent no longer matches this invoice. "
            "Restore verified payer consent and retry with a new Idempotency-Key."
        )

    def _normalized_items(self, data: BillingInvoiceCreate, studio_id: str) -> list[dict[str, Any]]:
        source = [item.model_dump() for item in data.items] if data.items else [{
            "description": data.description or "Tuition invoice",
            "amount_cents": data.amount_cents or 0,
            "quantity": 1,
            "student_id": data.student_id,
            "enrollment_id": data.enrollment_id,
            "billing_plan_id": None,
        }]
        if not 1 <= len(source) <= 31:
            raise HTTPException(status_code=400, detail="Invoices require 1 to 31 line items.")
        normalized: list[dict[str, Any]] = []
        for item in source:
            row = {
                "description": " ".join(str(item.get("description") or "Tuition invoice").split()),
                "amount_cents": int(item.get("amount_cents") or 0),
                "quantity": int(item.get("quantity") or 1),
                "student_id": item.get("student_id"),
                "enrollment_id": item.get("enrollment_id"),
                "billing_plan_id": item.get("billing_plan_id"),
            }
            if not row["description"] or row["amount_cents"] < 1 or row["quantity"] < 1:
                raise HTTPException(status_code=400, detail="Invoice line items are invalid.")
            self.owner._validate_invoice_item_refs(row, studio_id)
            normalized.append(row)
        return normalized

    def _local_ready_account(self, studio_id: str) -> dict[str, Any]:
        account = self.owner._connect_accounts().ensure_row(studio_id)
        if (
            account.get("studio_id") != studio_id
            or not account.get("stripe_connected_account_id")
            or not account.get("charges_enabled")
            or account.get("status") == "deauthorized"
        ):
            raise HTTPException(status_code=409, detail="Stripe Connect charges are not enabled yet.")
        return account

    @staticmethod
    def _account_generation(account: dict[str, Any]) -> int:
        raw = (account.get("metadata") or {}).get("connect_account_generation") or 1
        try:
            generation = int(raw)
        except (TypeError, ValueError):
            generation = 0
        if generation <= 0:
            raise HTTPException(status_code=409, detail="Stripe account generation is not ready.")
        return generation

    @staticmethod
    def _require_exact_payer(payer: dict[str, Any], account_id: str, generation: int) -> None:
        if (
            payer.get("stripe_account_id") != account_id
            or payer.get("connect_account_generation") != generation
            or not payer.get("stripe_customer_id")
        ):
            raise HTTPException(
                status_code=409,
                detail="Payer must be synchronized to the current Stripe account generation.",
            )

    def _invoice_generation(self, invoice: dict[str, Any], studio_id: str) -> tuple[dict[str, Any], int]:
        account = self.owner._connect_accounts().by_stripe_account(invoice["stripe_account_id"])
        if not account or account.get("studio_id") != studio_id or not account.get("charges_enabled"):
            raise HTTPException(status_code=409, detail="Invoice Stripe account is not current.")
        generation = self._account_generation(account)
        raw = (invoice.get("metadata") or {}).get("connect_account_generation")
        try:
            invoice_generation = int(raw)
        except (TypeError, ValueError):
            invoice_generation = 0
        if invoice_generation != generation:
            raise HTTPException(status_code=409, detail="Invoice Stripe account generation is not current.")
        return account, generation

    @staticmethod
    def _required_key(value: str | None, workflow: str) -> str:
        normalized = normalize_idempotency_key(value)
        if not normalized:
            raise HTTPException(status_code=400, detail=f"Idempotency-Key is required for {workflow}.")
        return normalized

    def _claim_parent(
        self,
        operations: BillingProviderOperationCoordinator,
        *,
        studio_id: str,
        actor_id: str,
        operation_type: str,
        caller_request_key: str,
        request_sha256: str,
        account_id: str,
        generation: int,
        resource_type: str | None = None,
        resource_id: str | None = None,
        resource_payer_id: str | None = None,
    ) -> tuple[BillingProviderOperationContext, dict[str, Any]]:
        lease_owner = str(uuid4())
        if resource_type and resource_id and resource_payer_id:
            claimed = operations.claim_resource(
                studio_id=studio_id,
                actor_id=actor_id,
                operation_type=operation_type,
                resource_type=resource_type,
                resource_id=resource_id,
                payer_id=resource_payer_id,
                caller_request_key=caller_request_key,
                request_sha256=request_sha256,
                stripe_connected_account_id=account_id,
                connect_account_generation=generation,
                lease_owner=lease_owner,
            )
        else:
            claimed = operations.claim(
                studio_id=studio_id,
                actor_id=actor_id,
                operation_type=operation_type,
                caller_request_key=caller_request_key,
                request_sha256=request_sha256,
                stripe_connected_account_id=account_id,
                connect_account_generation=generation,
                lease_owner=lease_owner,
            )
        operation = claimed["operation"]
        return BillingProviderOperationContext(
            operation_id=str(operation["id"]),
            studio_id=studio_id,
            actor_id=str(operation["actor_id"]),
            operation_type=operation_type,
            caller_request_key=str(operation["caller_request_key"]),
            request_sha256=request_sha256,
            stripe_connected_account_id=account_id,
            connect_account_generation=generation,
            lease_owner=lease_owner,
        ), claimed

    def _verify_local_invoice_intent(
        self,
        invoice: dict[str, Any],
        *,
        payer: dict[str, Any],
        account_id: str,
        generation: int,
        amount_due: int,
        application_fee: int,
    ) -> None:
        metadata = invoice.get("metadata") or {}
        if (
            invoice.get("payer_id") != payer.get("id")
            or invoice.get("stripe_account_id") != account_id
            or invoice.get("stripe_customer_id") != payer.get("stripe_customer_id")
            or metadata.get("connect_account_generation") != generation
            or metadata.get("provider_workflow") != INVOICE_CREATE_OPERATION_TYPE
            or int(invoice.get("amount_due_cents") or 0) != amount_due
            or int(invoice.get("application_fee_amount_cents") or 0) != application_fee
        ):
            raise HTTPException(status_code=409, detail="Invoice intent identity is not exact.")

    def _invoice_step_plan(
        self,
        invoice: dict[str, Any],
        *,
        payer: dict[str, Any],
        context: BillingProviderOperationContext,
        items: list[dict[str, Any]],
        application_fee: int,
        due_date: Any,
    ) -> dict[str, Any]:
        invoice_step = {
            "step_name": "invoice",
            "provider_operation": "connected_invoice.create",
            "request_sha256": stable_hash({
                "invoice_id": invoice["id"],
                "payer_id": payer["id"],
                "customer_id": payer["stripe_customer_id"],
                "account_id": context.stripe_connected_account_id,
                "generation": context.connect_account_generation,
                "collection_method": invoice["collection_method"],
                "application_fee_amount_cents": application_fee,
                "due_date": str(due_date) if due_date else None,
            }),
            "stripe_idempotency_key": self.owner._idempotency_key(
                "invoice-create", context.operation_id, "step-1-invoice"
            ),
        }
        item_steps = []
        for index, item in enumerate(items, start=1):
            item_steps.append({
                "step_name": f"item_{index:03d}",
                "provider_operation": "connected_invoice_item.create",
                "request_sha256": stable_hash({
                    "invoice_id": invoice["id"],
                    "invoice_source": "step:invoice",
                    "account_id": context.stripe_connected_account_id,
                    "generation": context.connect_account_generation,
                    "order": index,
                    **item,
                }),
                "stripe_idempotency_key": self.owner._idempotency_key(
                    "invoice-create", context.operation_id, f"step-{index + 1}-item"
                ),
            })
        steps = [invoice_step, *item_steps]
        return {"steps": steps, "plan_sha256": billing_provider_step_plan_sha256(steps)}

    def _execute_invoice_steps(
        self,
        invoice: dict[str, Any],
        *,
        payer: dict[str, Any],
        context: BillingProviderOperationContext,
        operation: dict[str, Any],
        operations: BillingProviderOperationCoordinator,
        spec: dict[str, Any],
        items: list[dict[str, Any]],
        application_fee: int,
        due_date: Any,
    ) -> dict[str, Any]:
        client = BillingProviderStepCoordinator(self.supabase)
        registered = client.register_plan(
            context,
            operation,
            plan_sha256=spec["plan_sha256"],
            steps=spec["steps"],
        )
        operation = registered["operation"]
        invoice_id = self._execute_invoice_step(
            invoice,
            payer=payer,
            context=context,
            operation=operation,
            client=client,
            spec=spec,
            application_fee=application_fee,
            due_date=due_date,
        )
        item_ids = []
        for index, item in enumerate(items, start=1):
            item_ids.append(self._execute_item_step(
                invoice,
                item=item,
                index=index,
                provider_invoice_id=invoice_id,
                context=context,
                operation=operation,
                client=client,
                spec=spec,
            ))
        completed = client.complete_provider_phase(
            context,
            operation,
            plan_sha256=spec["plan_sha256"],
            expected_step_count=len(spec["steps"]),
        )
        operation = completed["operation"]
        if operation.get("state") != "provider_succeeded":
            raise HTTPException(status_code=409, detail=INVOICE_CREATE_AMBIGUOUS_DETAIL)
        try:
            projected = self._project_invoice_results(
                invoice,
                context,
                operation,
                items=items,
                provider_invoice_id=invoice_id,
                item_ids=item_ids,
            )
        except Exception as exc:
            self._mark_parent_reconciliation(
                operations,
                context,
                operation,
                "invoice_create_projection_failed",
                exc,
                INVOICE_CREATE_AMBIGUOUS_DETAIL,
            )
        projected["_operation"] = operation
        return projected

    def _execute_invoice_step(
        self,
        invoice: dict[str, Any],
        *,
        payer: dict[str, Any],
        context: BillingProviderOperationContext,
        operation: dict[str, Any],
        client: BillingProviderStepCoordinator,
        spec: dict[str, Any],
        application_fee: int,
        due_date: Any,
    ) -> str:
        step = self._step_context(context, spec, 1)
        envelope = client.claim_step(step)
        current = envelope["step"]
        if current.get("state") == "provider_succeeded":
            return self._required_provider_id(current)
        self._raise_for_blocked_step(envelope, INVOICE_CREATE_AMBIGUOUS_DETAIL)
        current = client.transition_step(step, current, "provider_request_in_flight")
        try:
            provider_invoice = self.stripe_service_cls().create_connected_invoice(
                account_id=context.stripe_connected_account_id,
                studio_id=context.studio_id,
                customer_id=payer["stripe_customer_id"],
                collection_method=invoice["collection_method"],
                application_fee_amount=application_fee,
                default_payment_method=(
                    payer.get("default_payment_method_id")
                    if invoice["collection_method"] == "charge_automatically"
                    else None
                ),
                due_date=self.owner._date_to_epoch(due_date) if due_date else None,
                days_until_due=7,
                metadata={
                    "studio_id": context.studio_id,
                    "payer_id": payer["id"],
                    "invoice_id": invoice["id"],
                    "product": "koaryu_payments",
                },
                idempotency_key=step.stripe_idempotency_key,
            )
        except StripeMutationBlocked:
            client.transition_step(
                step, current, "definitive_rejected", error_code="provider_mutation_blocked"
            )
            self._complete_failed_phase(client, context, operation, spec)
            raise
        except Exception as exc:
            self._mark_step_reconciliation(
                client, step, current, operation, spec,
                "invoice_create_provider_outcome_ambiguous", exc,
            )
        provider_id = _stripe_id(provider_invoice)
        if not provider_id:
            self._mark_step_reconciliation(
                client, step, current, operation, spec,
                "invoice_create_provider_identity_ambiguous",
                RuntimeError("invoice_create_provider_identity_ambiguous"),
            )
        try:
            client.transition_step(
                step, current, "provider_succeeded",
                provider_object_id=provider_id,
                result_code="invoice_create_invoice_succeeded",
            )
        except Exception as exc:
            raise HTTPException(status_code=503, detail=INVOICE_CREATE_AMBIGUOUS_DETAIL) from exc
        return provider_id

    def _execute_item_step(
        self,
        invoice: dict[str, Any],
        *,
        item: dict[str, Any],
        index: int,
        provider_invoice_id: str,
        context: BillingProviderOperationContext,
        operation: dict[str, Any],
        client: BillingProviderStepCoordinator,
        spec: dict[str, Any],
    ) -> str:
        step = self._step_context(context, spec, index + 1)
        envelope = client.claim_step(step)
        current = envelope["step"]
        if current.get("state") == "provider_succeeded":
            return self._required_provider_id(current)
        self._raise_for_blocked_step(envelope, INVOICE_CREATE_AMBIGUOUS_DETAIL)
        current = client.transition_step(step, current, "provider_request_in_flight")
        metadata = self._item_metadata(invoice, item)
        try:
            provider_item = self.stripe_service_cls().create_connected_invoice_item(
                account_id=context.stripe_connected_account_id,
                studio_id=context.studio_id,
                customer_id=invoice["stripe_customer_id"],
                amount=item["amount_cents"] * item["quantity"],
                currency=invoice["currency"],
                description=item["description"],
                metadata=metadata,
                idempotency_key=step.stripe_idempotency_key,
                invoice_id=provider_invoice_id,
            )
        except StripeMutationBlocked:
            client.transition_step(
                step, current, "definitive_rejected", error_code="provider_mutation_blocked"
            )
            self._complete_failed_phase(client, context, operation, spec)
            raise
        except Exception as exc:
            self._mark_step_reconciliation(
                client, step, current, operation, spec,
                "invoice_create_item_outcome_ambiguous", exc,
            )
        provider_id = _stripe_id(provider_item)
        if not provider_id:
            self._mark_step_reconciliation(
                client, step, current, operation, spec,
                "invoice_create_item_identity_ambiguous",
                RuntimeError("invoice_create_item_identity_ambiguous"),
            )
        try:
            client.transition_step(
                step, current, "provider_succeeded",
                provider_object_id=provider_id,
                result_code="invoice_create_item_succeeded",
            )
        except Exception as exc:
            raise HTTPException(status_code=503, detail=INVOICE_CREATE_AMBIGUOUS_DETAIL) from exc
        return provider_id

    def _project_created_invoice(
        self,
        invoice: dict[str, Any],
        context: BillingProviderOperationContext,
        operation: dict[str, Any],
        *,
        spec: dict[str, Any],
        items: list[dict[str, Any]],
    ) -> dict[str, Any]:
        envelope = BillingProviderStepCoordinator(self.supabase).read_plan(
            context, plan_sha256=spec["plan_sha256"]
        )
        steps = envelope["steps"]
        if len(steps) != len(spec["steps"]) or any(
            step.get("state") != "provider_succeeded" for step in steps
        ):
            raise HTTPException(status_code=503, detail=INVOICE_CREATE_AMBIGUOUS_DETAIL)
        return self._project_invoice_results(
            invoice,
            context,
            operation,
            items=items,
            provider_invoice_id=self._required_provider_id(steps[0]),
            item_ids=[self._required_provider_id(step) for step in steps[1:]],
        )

    def _project_invoice_results(
        self,
        invoice: dict[str, Any],
        context: BillingProviderOperationContext,
        operation: dict[str, Any],
        *,
        items: list[dict[str, Any]],
        provider_invoice_id: str,
        item_ids: list[str],
    ) -> dict[str, Any]:
        if len(item_ids) != len(items) or operation.get("provider_object_id") != item_ids[-1]:
            raise RuntimeError("invoice_create_step_result_mismatch")
        try:
            provider_invoice = self.stripe_service_cls().retrieve_connected_invoice(
                account_id=context.stripe_connected_account_id,
                invoice_id=provider_invoice_id,
            )
            self._verify_invoice_readback(
                provider_invoice,
                invoice,
                context,
                provider_invoice_id,
            )
            for item, provider_item_id in zip(items, item_ids, strict=True):
                row = {
                    "studio_id": context.studio_id,
                    "invoice_id": invoice["id"],
                    "student_id": item.get("student_id"),
                    "enrollment_id": item.get("enrollment_id"),
                    "billing_plan_id": item.get("billing_plan_id"),
                    "description": item["description"],
                    "quantity": item["quantity"],
                    "unit_amount_cents": item["amount_cents"],
                    "amount_cents": item["amount_cents"] * item["quantity"],
                    "stripe_invoice_item_id": provider_item_id,
                    "metadata": self._item_metadata(invoice, item),
                }
                self.owner._insert_invoice_item_once(row)
                saved = self._local_item_by_provider_id(
                    context.studio_id,
                    provider_item_id,
                )
                self._verify_local_item(saved, row)
            projected = self.owner._update_invoice_from_stripe(
                invoice["id"], context.studio_id, provider_invoice,
                context.stripe_connected_account_id,
            )
            self._verify_projected_invoice(projected, invoice, context, provider_invoice_id)
            return projected
        except Exception as exc:
            raise HTTPException(status_code=503, detail=INVOICE_CREATE_AMBIGUOUS_DETAIL) from exc

    def _load_created_invoice(
        self,
        invoice: dict[str, Any],
        context: BillingProviderOperationContext,
        operation: dict[str, Any],
        items: list[dict[str, Any]],
    ) -> dict[str, Any]:
        if operation.get("result_summary") != INVOICE_CREATE_MODE:
            raise RuntimeError("invoice_create_saved_mode_invalid")
        spec = self._invoice_step_plan(
            invoice,
            payer={"id": invoice["payer_id"], "stripe_customer_id": invoice["stripe_customer_id"]},
            context=context,
            items=items,
            application_fee=int(invoice.get("application_fee_amount_cents") or 0),
            due_date=invoice.get("due_date"),
        )
        envelope = BillingProviderStepCoordinator(self.supabase).read_plan(
            context, plan_sha256=spec["plan_sha256"]
        )
        steps = envelope["steps"]
        saved = self.owner._get_row_or_404(
            "billing_invoices", invoice["id"], context.studio_id, "Invoice not found."
        )
        if len(steps) != len(items) + 1 or not saved.get("stripe_invoice_id"):
            raise RuntimeError("invoice_create_saved_result_mismatch")
        if self._required_provider_id(steps[0]) != saved["stripe_invoice_id"]:
            raise RuntimeError("invoice_create_saved_invoice_mismatch")
        if operation.get("provider_object_id") != self._required_provider_id(steps[-1]):
            raise RuntimeError("invoice_create_saved_parent_mismatch")
        local_items = (
            self.supabase.table("billing_invoice_items")
            .select("*")
            .eq("studio_id", context.studio_id)
            .eq("invoice_id", saved["id"])
            .execute()
        ).data or []
        if len(local_items) != len(items):
            raise RuntimeError("invoice_create_saved_items_missing")
        local_by_provider_id = {
            str(local.get("stripe_invoice_item_id") or ""): local
            for local in local_items
            if local.get("stripe_invoice_item_id")
        }
        if len(local_by_provider_id) != len(local_items):
            raise RuntimeError("invoice_create_saved_items_ambiguous")
        for expected, step in zip(items, steps[1:], strict=True):
            provider_item_id = self._required_provider_id(step)
            local = local_by_provider_id.get(provider_item_id)
            if local is None:
                raise RuntimeError("invoice_create_saved_item_identity_missing")
            self._verify_local_item(local, {
                "studio_id": context.studio_id,
                "invoice_id": saved["id"],
                "student_id": expected.get("student_id"),
                "enrollment_id": expected.get("enrollment_id"),
                "billing_plan_id": expected.get("billing_plan_id"),
                "description": expected["description"],
                "quantity": expected["quantity"],
                "unit_amount_cents": expected["amount_cents"],
                "amount_cents": expected["amount_cents"] * expected["quantity"],
                "stripe_invoice_item_id": provider_item_id,
            })
        self._verify_projected_invoice(
            saved, invoice, context, str(saved["stripe_invoice_id"])
        )
        return saved

    def _retry_readback(
        self,
        invoice: dict[str, Any],
        context: BillingProviderOperationContext,
        operation: dict[str, Any],
        operations: BillingProviderOperationCoordinator,
    ) -> dict[str, Any]:
        try:
            provider = self._read_invoice(invoice)
        except Exception as exc:
            raise HTTPException(status_code=503, detail=INVOICE_RETRY_AMBIGUOUS_DETAIL) from exc
        if _stripe_id(provider) != invoice.get("stripe_invoice_id") or str(
            _object_get(provider, "status") or ""
        ) != "paid":
            raise HTTPException(status_code=409, detail=INVOICE_RETRY_AMBIGUOUS_DETAIL)
        operation = operations.transition(
            context,
            operation,
            "provider_succeeded",
            provider_object_id=str(invoice["stripe_invoice_id"]),
            result_code="invoice_retry_provider_paid",
            result_summary=INVOICE_RETRY_MODE,
        )
        try:
            paid = self._project_paid_invoice(invoice, provider, context)
        except Exception as exc:
            self._mark_parent_reconciliation(
                operations,
                context,
                operation,
                "invoice_retry_projection_failed",
                exc,
                INVOICE_RETRY_AMBIGUOUS_DETAIL,
            )
        return self._finish_retry_projection(
            paid, context, operation, operations, already_projected=True
        )

    def _finish_retry_projection(
        self,
        invoice: dict[str, Any],
        context: BillingProviderOperationContext,
        operation: dict[str, Any],
        operations: BillingProviderOperationCoordinator,
        *,
        already_projected: bool = False,
    ) -> dict[str, Any]:
        paid = invoice
        if not already_projected:
            provider = self._read_invoice(invoice)
            paid = self._project_paid_invoice(invoice, provider, context)
        operation = operations.transition(
            context,
            operation,
            "projected",
            result_code="invoice_retry_projected",
            result_summary=INVOICE_RETRY_MODE,
        )
        operations.complete(context, operation, result_code="invoice_retry_completed")
        self._audit_retry_once(context, paid)
        self.owner._recompute_payer_balance(context.studio_id, paid.get("payer_id"))
        return paid

    def _project_paid_invoice(
        self,
        invoice: dict[str, Any],
        provider: Any,
        context: BillingProviderOperationContext,
    ) -> dict[str, Any]:
        if _stripe_id(provider) != invoice.get("stripe_invoice_id"):
            raise HTTPException(status_code=503, detail=INVOICE_RETRY_AMBIGUOUS_DETAIL)
        projected = self.owner._update_invoice_from_stripe(
            invoice["id"], context.studio_id, provider,
            context.stripe_connected_account_id,
        )
        if (
            projected.get("status") != "paid"
            or int(projected.get("amount_remaining_cents") or 0) != 0
            or projected.get("stripe_invoice_id") != invoice.get("stripe_invoice_id")
            or projected.get("stripe_account_id") != context.stripe_connected_account_id
            or (projected.get("metadata") or {}).get("connect_account_generation")
            != context.connect_account_generation
        ):
            raise HTTPException(status_code=503, detail=INVOICE_RETRY_AMBIGUOUS_DETAIL)
        return projected

    def _load_paid_invoice(
        self,
        invoice_id: str,
        context: BillingProviderOperationContext,
        operation: dict[str, Any],
    ) -> dict[str, Any]:
        invoice = self.owner._get_row_or_404(
            "billing_invoices", invoice_id, context.studio_id, "Invoice not found."
        )
        if (
            operation.get("result_summary") != INVOICE_RETRY_MODE
            or operation.get("provider_object_id") != invoice.get("stripe_invoice_id")
            or invoice.get("status") != "paid"
            or int(invoice.get("amount_remaining_cents") or 0) != 0
            or invoice.get("stripe_account_id") != context.stripe_connected_account_id
            or (invoice.get("metadata") or {}).get("connect_account_generation")
            != context.connect_account_generation
        ):
            raise RuntimeError("invoice_retry_saved_result_mismatch")
        return invoice

    @staticmethod
    def _verify_finalize_preread(
        invoice: dict[str, Any], provider: Any
    ) -> tuple[str, str]:
        collection_method = str(_object_get(provider, "collection_method") or "")
        provider_status = str(_object_get(provider, "status") or "")
        if (
            _stripe_id(provider) != invoice.get("stripe_invoice_id")
            or _stripe_id(_object_get(provider, "customer"))
            != invoice.get("stripe_customer_id")
            or provider_status not in {"draft", "open", "paid"}
            or collection_method not in {"charge_automatically", "send_invoice"}
            or collection_method != invoice.get("collection_method")
        ):
            raise HTTPException(
                status_code=409,
                detail="Invoice provider state is not eligible for finalization.",
            )
        return collection_method, provider_status

    @staticmethod
    def _verify_void_preread(invoice: dict[str, Any], provider: Any) -> str:
        provider_status = str(_object_get(provider, "status") or "")
        if (
            _stripe_id(provider) != invoice.get("stripe_invoice_id")
            or _stripe_id(_object_get(provider, "customer"))
            != invoice.get("stripe_customer_id")
            or provider_status not in {"draft", "open", "void"}
        ):
            raise HTTPException(
                status_code=409,
                detail="Invoice provider state is not eligible for voiding.",
            )
        return provider_status

    def _execute_finalize_single(
        self,
        invoice: dict[str, Any],
        *,
        context: BillingProviderOperationContext,
        operation: dict[str, Any],
        operations: BillingProviderOperationCoordinator,
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        operation = operations.transition(
            context,
            operation,
            "provider_request_in_flight",
            result_code="invoice_finalize_started",
            result_summary=INVOICE_FINALIZE_MODE,
        )
        try:
            provider = self.stripe_service_cls().finalize_connected_invoice(
                account_id=context.stripe_connected_account_id,
                studio_id=context.studio_id,
                invoice_id=str(invoice["stripe_invoice_id"]),
                idempotency_key=self.owner._idempotency_key(
                    "invoice-finalize", context.operation_id
                ),
            )
        except StripeMutationBlocked:
            operations.transition(
                context, operation, "definitive_rejected",
                error_code="provider_mutation_blocked",
            )
            raise
        except Exception as exc:
            self._mark_parent_reconciliation(
                operations, context, operation,
                "invoice_finalize_provider_outcome_ambiguous", exc,
                INVOICE_FINALIZE_AMBIGUOUS_DETAIL,
            )
        self._verify_finalized_provider(invoice, provider)
        operation = operations.transition(
            context,
            operation,
            "provider_succeeded",
            provider_object_id=str(invoice["stripe_invoice_id"]),
            result_code="invoice_finalize_provider_succeeded",
        )
        try:
            projected = self._project_finalized_invoice(
                invoice, context, operation, provider=provider
            )
        except Exception as exc:
            self._mark_parent_reconciliation(
                operations, context, operation,
                "invoice_finalize_projection_failed", exc,
                INVOICE_FINALIZE_AMBIGUOUS_DETAIL,
            )
        return projected, operation

    def _execute_finalize_steps(
        self,
        invoice: dict[str, Any],
        *,
        context: BillingProviderOperationContext,
        operation: dict[str, Any],
        operations: BillingProviderOperationCoordinator,
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        steps = [
            {
                "step_name": "finalize",
                "provider_operation": "connected_invoice.finalize",
                "request_sha256": stable_hash({
                    "invoice_id": invoice["id"],
                    "stripe_invoice_id": invoice["stripe_invoice_id"],
                    "account_id": context.stripe_connected_account_id,
                    "generation": context.connect_account_generation,
                }),
                "stripe_idempotency_key": self.owner._idempotency_key(
                    "invoice-finalize", context.operation_id, "step-1-finalize"
                ),
            },
            {
                "step_name": "send",
                "provider_operation": "connected_invoice.send",
                "request_sha256": stable_hash({
                    "invoice_id": invoice["id"],
                    "stripe_invoice_id": invoice["stripe_invoice_id"],
                    "account_id": context.stripe_connected_account_id,
                    "generation": context.connect_account_generation,
                    "predecessor": "finalize",
                }),
                "stripe_idempotency_key": self.owner._idempotency_key(
                    "invoice-finalize", context.operation_id, "step-2-send"
                ),
            },
        ]
        spec = {
            "steps": steps,
            "plan_sha256": billing_provider_step_plan_sha256(steps),
        }
        client = BillingProviderStepCoordinator(self.supabase)
        registered = client.register_plan(
            context, operation,
            plan_sha256=spec["plan_sha256"],
            steps=steps,
        )
        operation = registered["operation"]
        provider: Any = None
        for order, action in ((1, "finalize"), (2, "send")):
            step = self._step_context(context, spec, order)
            envelope = client.claim_step(step)
            current = envelope["step"]
            if current.get("state") == "provider_succeeded":
                self._required_provider_id(current)
                continue
            self._raise_for_blocked_step(envelope, INVOICE_FINALIZE_AMBIGUOUS_DETAIL)
            current = client.transition_step(
                step, current, "provider_request_in_flight"
            )
            try:
                if action == "finalize":
                    provider = self.stripe_service_cls().finalize_connected_invoice(
                        account_id=context.stripe_connected_account_id,
                        studio_id=context.studio_id,
                        invoice_id=str(invoice["stripe_invoice_id"]),
                        idempotency_key=step.stripe_idempotency_key,
                    )
                else:
                    provider = self.stripe_service_cls().send_connected_invoice(
                        account_id=context.stripe_connected_account_id,
                        studio_id=context.studio_id,
                        invoice_id=str(invoice["stripe_invoice_id"]),
                        idempotency_key=step.stripe_idempotency_key,
                    )
            except StripeMutationBlocked:
                client.transition_step(
                    step, current, "definitive_rejected",
                    error_code="provider_mutation_blocked",
                )
                self._complete_failed_phase(client, context, operation, spec)
                raise
            except Exception as exc:
                detail = INVOICE_FINALIZE_AMBIGUOUS_DETAIL
                if action == "send":
                    error_id = uuid4().hex
                    logger.error(
                        "Stripe hosted invoice email send failed; reference=%s; error_type=%s",
                        error_id,
                        type(exc).__name__,
                    )
                    detail = f"{detail} Reference: {error_id}"
                try:
                    client.transition_step(
                        step, current, "reconciliation_required",
                        reconciliation_reason_code=(
                            f"invoice_{action}_provider_outcome_ambiguous"
                        ),
                    )
                finally:
                    self._complete_failed_phase(client, context, operation, spec)
                raise HTTPException(
                    status_code=503, detail=detail
                ) from exc
            self._verify_finalized_provider(invoice, provider)
            try:
                client.transition_step(
                    step,
                    current,
                    "provider_succeeded",
                    provider_object_id=str(invoice["stripe_invoice_id"]),
                )
            except Exception as exc:
                raise HTTPException(
                    status_code=503, detail=INVOICE_FINALIZE_AMBIGUOUS_DETAIL
                ) from exc
        completed = client.complete_provider_phase(
            context,
            operation,
            plan_sha256=spec["plan_sha256"],
            expected_step_count=2,
        )
        operation = completed["operation"]
        if operation.get("state") != "provider_succeeded":
            raise HTTPException(status_code=409, detail=INVOICE_FINALIZE_AMBIGUOUS_DETAIL)
        try:
            projected = self._project_finalized_invoice(invoice, context, operation)
        except Exception as exc:
            self._mark_parent_reconciliation(
                operations, context, operation,
                "invoice_finalize_projection_failed", exc,
                INVOICE_FINALIZE_AMBIGUOUS_DETAIL,
            )
        return projected, operation

    @staticmethod
    def _verify_finalized_provider(invoice: dict[str, Any], provider: Any) -> None:
        if (
            _stripe_id(provider) != invoice.get("stripe_invoice_id")
            or _stripe_id(_object_get(provider, "customer"))
            != invoice.get("stripe_customer_id")
            or str(_object_get(provider, "status") or "") not in {"open", "paid"}
            or str(_object_get(provider, "collection_method") or "")
            != invoice.get("collection_method")
        ):
            raise HTTPException(status_code=503, detail=INVOICE_FINALIZE_AMBIGUOUS_DETAIL)

    def _project_finalized_invoice(
        self,
        invoice: dict[str, Any],
        context: BillingProviderOperationContext,
        operation: dict[str, Any],
        *,
        provider: Any | None = None,
    ) -> dict[str, Any]:
        readback = provider or self._read_invoice(invoice)
        self._verify_finalized_provider(invoice, readback)
        if operation.get("provider_object_id") != invoice.get("stripe_invoice_id"):
            raise HTTPException(status_code=503, detail=INVOICE_FINALIZE_AMBIGUOUS_DETAIL)
        projected = self.owner._update_invoice_from_stripe(
            invoice["id"], context.studio_id, readback,
            context.stripe_connected_account_id,
        )
        if (
            projected.get("status") not in {"open", "paid"}
            or projected.get("stripe_invoice_id") != invoice.get("stripe_invoice_id")
            or projected.get("stripe_account_id") != context.stripe_connected_account_id
            or (projected.get("metadata") or {}).get("connect_account_generation")
            != context.connect_account_generation
        ):
            raise HTTPException(status_code=503, detail=INVOICE_FINALIZE_AMBIGUOUS_DETAIL)
        return projected

    def _load_finalized_invoice(
        self,
        invoice_id: str,
        context: BillingProviderOperationContext,
        operation: dict[str, Any],
        result_summary: str,
    ) -> dict[str, Any]:
        invoice = self.owner._get_row_or_404(
            "billing_invoices", invoice_id, context.studio_id, "Invoice not found."
        )
        if (
            operation.get("result_summary") != result_summary
            or operation.get("provider_object_id") != invoice.get("stripe_invoice_id")
            or invoice.get("status") not in {"open", "paid"}
            or invoice.get("stripe_account_id") != context.stripe_connected_account_id
            or (invoice.get("metadata") or {}).get("connect_account_generation")
            != context.connect_account_generation
        ):
            raise RuntimeError("invoice_finalize_saved_result_mismatch")
        return invoice

    def _project_void_invoice(
        self,
        invoice: dict[str, Any],
        context: BillingProviderOperationContext,
        operation: dict[str, Any],
        *,
        provider: Any | None = None,
    ) -> dict[str, Any]:
        readback = provider or self._read_invoice(invoice)
        if (
            _stripe_id(readback) != invoice.get("stripe_invoice_id")
            or str(_object_get(readback, "status") or "") != "void"
            or operation.get("provider_object_id") != invoice.get("stripe_invoice_id")
        ):
            raise HTTPException(status_code=503, detail=INVOICE_VOID_AMBIGUOUS_DETAIL)
        projected = self.owner._update_invoice_from_stripe(
            invoice["id"], context.studio_id, readback,
            context.stripe_connected_account_id,
        )
        if (
            projected.get("status") != "void"
            or projected.get("stripe_invoice_id") != invoice.get("stripe_invoice_id")
            or projected.get("stripe_account_id") != context.stripe_connected_account_id
            or (projected.get("metadata") or {}).get("connect_account_generation")
            != context.connect_account_generation
        ):
            raise HTTPException(status_code=503, detail=INVOICE_VOID_AMBIGUOUS_DETAIL)
        return projected

    def _load_void_invoice(
        self,
        invoice_id: str,
        context: BillingProviderOperationContext,
        operation: dict[str, Any],
    ) -> dict[str, Any]:
        invoice = self.owner._get_row_or_404(
            "billing_invoices", invoice_id, context.studio_id, "Invoice not found."
        )
        if (
            operation.get("result_summary") != INVOICE_VOID_MODE
            or operation.get("provider_object_id") != invoice.get("stripe_invoice_id")
            or invoice.get("status") != "void"
            or invoice.get("stripe_account_id") != context.stripe_connected_account_id
            or (invoice.get("metadata") or {}).get("connect_account_generation")
            != context.connect_account_generation
        ):
            raise RuntimeError("invoice_void_saved_result_mismatch")
        return invoice

    def _read_invoice(self, invoice: dict[str, Any]) -> Any:
        return self.stripe_service_cls().retrieve_connected_invoice(
            account_id=invoice["stripe_account_id"],
            invoice_id=invoice["stripe_invoice_id"],
            expand=["payment_intent"],
        )

    @staticmethod
    def _definitive_invoice_retry_error(
        exc: Exception,
    ) -> tuple[int, str, str] | None:
        if isinstance(exc, StripeCardError):
            return (
                402,
                "Stripe declined the invoice payment. Review the payer payment method and retry.",
                "card_declined",
            )
        if isinstance(exc, StripeInvalidRequestError):
            return (
                409,
                "Stripe rejected the invoice payment request. Review the invoice before retrying.",
                "stripe_request_rejected",
            )
        if isinstance(exc, (StripeAuthenticationError, StripePermissionError)):
            return (
                409,
                "Stripe billing configuration rejected the invoice payment request.",
                "stripe_configuration_rejected",
            )
        if isinstance(exc, StripeRateLimitError):
            return (
                429,
                "Stripe rate-limited the invoice payment request. Retry later.",
                "stripe_rate_limited",
            )
        if isinstance(exc, HTTPException):
            if 400 <= exc.status_code < 500:
                return exc.status_code, str(exc.detail), "local_request_rejected"
            return (
                409,
                "Stripe billing is unavailable before the payment request can be sent.",
                "local_execution_unavailable",
            )
        return None

    def _local_item_by_provider_id(
        self,
        studio_id: str,
        stripe_invoice_item_id: str,
    ) -> dict[str, Any]:
        result = (
            self.supabase.table("billing_invoice_items")
            .select("*")
            .eq("studio_id", studio_id)
            .eq("stripe_invoice_item_id", stripe_invoice_item_id)
            .limit(1)
            .execute()
        )
        if not result.data:
            raise RuntimeError("invoice_create_local_item_missing")
        return result.data[0]

    @staticmethod
    def _step_context(
        parent: BillingProviderOperationContext,
        spec: dict[str, Any],
        order: int,
    ) -> BillingProviderOperationStepContext:
        step = spec["steps"][order - 1]
        return BillingProviderOperationStepContext(
            parent=parent,
            plan_sha256=spec["plan_sha256"],
            step_order=order,
            step_name=step["step_name"],
            provider_operation=step["provider_operation"],
            step_request_sha256=step["request_sha256"],
            stripe_idempotency_key=step["stripe_idempotency_key"],
        )

    @staticmethod
    def _required_provider_id(step: dict[str, Any]) -> str:
        value = str(step.get("provider_object_id") or "")
        if not value:
            raise RuntimeError("invoice_provider_step_identity_missing")
        return value

    @staticmethod
    def _item_metadata(invoice: dict[str, Any], item: dict[str, Any]) -> dict[str, str]:
        return {
            "studio_id": str(invoice["studio_id"]),
            "invoice_id": str(invoice["id"]),
            "student_id": str(item.get("student_id") or ""),
            "enrollment_id": str(item.get("enrollment_id") or ""),
            "billing_plan_id": str(item.get("billing_plan_id") or ""),
        }

    @staticmethod
    def _raise_for_blocked_step(envelope: dict[str, Any], detail: str) -> None:
        outcome = str(envelope.get("outcome") or "")
        state = str((envelope.get("step") or {}).get("state") or "")
        if outcome in {"busy", "provider_request_in_flight"} or state == "provider_request_in_flight":
            raise HTTPException(status_code=409, detail=detail)
        if outcome == "reconciliation_required" or state == "reconciliation_required":
            raise HTTPException(status_code=409, detail=detail)
        if state in {"definitive_failed", "definitive_rejected"}:
            raise HTTPException(status_code=409, detail="Invoice provider step was rejected.")
        if state not in {"pending", "recovery_authorized"}:
            raise HTTPException(status_code=503, detail=detail)

    def _mark_step_reconciliation(
        self,
        client: BillingProviderStepCoordinator,
        step: BillingProviderOperationStepContext,
        current: dict[str, Any],
        operation: dict[str, Any],
        spec: dict[str, Any],
        reason: str,
        exc: Exception,
    ) -> None:
        try:
            client.transition_step(
                step, current, "reconciliation_required",
                reconciliation_reason_code=reason,
            )
        except Exception:
            pass
        self._complete_failed_phase(client, step.parent, operation, spec)
        raise HTTPException(status_code=503, detail=INVOICE_CREATE_AMBIGUOUS_DETAIL) from exc

    @staticmethod
    def _complete_failed_phase(
        client: BillingProviderStepCoordinator,
        context: BillingProviderOperationContext,
        operation: dict[str, Any],
        spec: dict[str, Any],
    ) -> None:
        try:
            client.complete_provider_phase(
                context,
                operation,
                plan_sha256=spec["plan_sha256"],
                expected_step_count=len(spec["steps"]),
            )
        except Exception:
            pass

    @staticmethod
    def _mark_parent_reconciliation(
        operations: BillingProviderOperationCoordinator,
        context: BillingProviderOperationContext,
        operation: dict[str, Any],
        reason: str,
        exc: Exception,
        detail: str,
    ) -> None:
        try:
            operations.transition(
                context,
                operation,
                "reconciliation_required",
                reconciliation_reason_code=reason,
            )
        except Exception:
            pass
        raise HTTPException(status_code=503, detail=detail) from exc

    @staticmethod
    def _verify_invoice_readback(
        provider: Any,
        invoice: dict[str, Any],
        context: BillingProviderOperationContext,
        provider_invoice_id: str,
    ) -> None:
        metadata = _object_get(provider, "metadata") or {}
        customer_id = _stripe_id(_object_get(provider, "customer"))
        if (
            _stripe_id(provider) != provider_invoice_id
            or customer_id != invoice.get("stripe_customer_id")
            or str(metadata.get("studio_id") or "") != context.studio_id
            or str(metadata.get("payer_id") or "") != str(invoice.get("payer_id") or "")
            or str(metadata.get("invoice_id") or "") != str(invoice.get("id") or "")
            or str(_object_get(provider, "status") or "") != "draft"
            or str(_object_get(provider, "currency") or "") != invoice.get("currency")
            or int(_object_get(provider, "amount_due") or 0)
            != int(invoice.get("amount_due_cents") or 0)
            or int(_object_get(provider, "amount_remaining") or 0)
            != int(invoice.get("amount_due_cents") or 0)
        ):
            raise RuntimeError("invoice_create_provider_readback_mismatch")

    @staticmethod
    def _verify_local_item(saved: dict[str, Any], expected: dict[str, Any]) -> None:
        fields = (
            "studio_id", "invoice_id", "student_id", "enrollment_id", "billing_plan_id",
            "description", "quantity", "unit_amount_cents", "amount_cents",
            "stripe_invoice_item_id",
        )
        if any(saved.get(field) != expected.get(field) for field in fields):
            raise RuntimeError("invoice_create_local_item_mismatch")

    @staticmethod
    def _verify_projected_invoice(
        projected: dict[str, Any],
        intent: dict[str, Any],
        context: BillingProviderOperationContext,
        provider_invoice_id: str,
    ) -> None:
        if (
            projected.get("id") != intent.get("id")
            or projected.get("payer_id") != intent.get("payer_id")
            or projected.get("stripe_account_id") != context.stripe_connected_account_id
            or projected.get("stripe_customer_id") != intent.get("stripe_customer_id")
            or projected.get("stripe_invoice_id") != provider_invoice_id
            or (projected.get("metadata") or {}).get("connect_account_generation")
            != context.connect_account_generation
            or int(projected.get("amount_due_cents") or 0)
            != int(intent.get("amount_due_cents") or 0)
            or int(projected.get("amount_remaining_cents") or 0)
            != int(intent.get("amount_due_cents") or 0)
        ):
            raise RuntimeError("invoice_create_local_projection_mismatch")

    def _audit_created_once(
        self, context: BillingProviderOperationContext, invoice: dict[str, Any]
    ) -> None:
        self._audit_once(
            context,
            action="billing.invoice_created",
            entity_id=str(invoice["id"]),
            metadata={
                "operation_id": context.operation_id,
                "amount_due_cents": int(invoice.get("amount_due_cents") or 0),
                "stripe_invoice_id": invoice.get("stripe_invoice_id"),
            },
        )

    def _audit_retry_once(
        self, context: BillingProviderOperationContext, invoice: dict[str, Any]
    ) -> None:
        self._audit_once(
            context,
            action="billing.invoice_retry_requested",
            entity_id=str(invoice["id"]),
            metadata={
                "operation_id": context.operation_id,
                "stripe_invoice_id": invoice.get("stripe_invoice_id"),
                "status": invoice.get("status"),
            },
        )

    def _audit_finalized_once(
        self, context: BillingProviderOperationContext, invoice: dict[str, Any]
    ) -> None:
        self._audit_once(
            context,
            action="billing.invoice_finalized",
            entity_id=str(invoice["id"]),
            metadata={
                "operation_id": context.operation_id,
                "stripe_invoice_id": invoice.get("stripe_invoice_id"),
                "status": invoice.get("status"),
            },
        )

    def _audit_voided_once(
        self, context: BillingProviderOperationContext, invoice: dict[str, Any]
    ) -> None:
        self._audit_once(
            context,
            action="billing.invoice_voided",
            entity_id=str(invoice["id"]),
            metadata={
                "operation_id": context.operation_id,
                "stripe_invoice_id": invoice.get("stripe_invoice_id"),
                "status": invoice.get("status"),
            },
        )

    def _audit_once(
        self,
        context: BillingProviderOperationContext,
        *,
        action: str,
        entity_id: str,
        metadata: dict[str, Any],
    ) -> None:
        audit_id = str(uuid5(NAMESPACE_URL, f"koaryu:{action}:{context.operation_id}"))
        existing = (
            self.supabase.table("audit_logs")
            .select("id")
            .eq("id", audit_id)
            .eq("studio_id", context.studio_id)
            .limit(1)
            .execute()
        )
        if existing.data:
            return
        try:
            self.supabase.table("audit_logs").insert({
                "id": audit_id,
                "studio_id": context.studio_id,
                "actor_id": context.actor_id,
                "action": action,
                "entity_type": "billing",
                "entity_id": entity_id,
                "metadata": metadata,
            }).execute()
        except PostgrestAPIError as exc:
            if getattr(exc, "code", None) != "23505":
                raise
