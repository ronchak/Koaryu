from __future__ import annotations

from datetime import datetime, timezone
from typing import Any
from uuid import NAMESPACE_URL, uuid4, uuid5

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
from app.services.billing_invoice_projection import _object_get, _stripe_id
from app.services.billing_provider_operations import (
    BillingProviderOperationContext,
    BillingProviderOperationCoordinator,
    PAYMENT_REFUND_OPERATION_TYPE,
    provider_operation_disposition,
)
from app.services.platform_billing_helpers import normalize_idempotency_key, stable_hash
from app.services.stripe_mutation_policy import StripeMutationBlocked
from app.services.supabase_rpc import execute_required_rpc, first_rpc_row
from app.services.stripe_service import StripeService



EXTERNAL_PAYMENT_IDEMPOTENCY_REQUIRED_DETAIL = "Idempotency-Key is required for external payments."
PAYER_EXTERNAL_PAYMENT_ONLY_DETAIL = "External payments must currently target one payer, not an invoice."
EXTERNAL_PAYMENT_USD_ONLY_DETAIL = "New external payments must use USD."
REFUND_AMBIGUOUS_DETAIL = (
    "Refund outcome is not confirmed. Retry with the same Idempotency-Key after reconciliation."
)
SUPPORTED_REFUND_REASONS = frozenset({"duplicate", "fraudulent", "requested_by_customer"})


def build_external_payment_request_hash(
    data: ExternalPaymentCreate,
    *,
    effective_payer_id: str | None,
) -> str:
    payload = data.model_dump(mode="json", exclude_none=True)
    if effective_payer_id is not None:
        payload["payer_id"] = effective_payer_id
    return stable_hash(payload)


class BillingPaymentManager:
    def __init__(self, billing_service: Any, *, stripe_service_cls: type[StripeService] = StripeService):
        self.billing_service = billing_service
        self.stripe_service_cls = stripe_service_cls

    @property
    def supabase(self):
        return self.billing_service.supabase

    def _get_row_or_404(self, *args, **kwargs):
        return self.billing_service._get_row_or_404(*args, **kwargs)

    def _connect_accounts(self):
        return self.billing_service._connect_accounts()

    def _recompute_payer_balance(self, studio_id: str, payer_id: str | None) -> None:
        self.billing_service._recompute_payer_balance(studio_id, payer_id)

    def _idempotency_key(self, *parts: str) -> str:
        return self.billing_service._idempotency_key(*parts)

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
        from app.services.billing_landing import payment_cohort_period

        period_start, period_end = payment_cohort_period(as_of)
        result = execute_required_rpc(self.supabase, "billing_payment_cohort", {
            "p_studio_id": studio_id,
            "p_period_start": period_start.isoformat(),
            "p_period_end": period_end.isoformat(),
        })
        return BillingPaymentCohortSummaryResponse.model_validate(result.data)

    async def record_external_payment(
        self,
        data: ExternalPaymentCreate,
        studio_id: str,
        actor_id: str,
        idempotency_key: str | None = None,
    ) -> BillingPaymentResponse:
        if not data.payer_id or data.invoice_id:
            raise HTTPException(status_code=409, detail=PAYER_EXTERNAL_PAYMENT_ONLY_DETAIL)
        request_key = normalize_idempotency_key(idempotency_key)
        if not request_key:
            raise HTTPException(status_code=400, detail=EXTERNAL_PAYMENT_IDEMPOTENCY_REQUIRED_DETAIL)
        request_hash = build_external_payment_request_hash(data, effective_payer_id=data.payer_id)
        try:
            result = execute_required_rpc(self.supabase, "record_external_payment_v1", {
                "p_studio_id": studio_id,
                "p_actor_id": actor_id,
                "p_payer_id": data.payer_id,
                "p_amount_cents": data.amount_cents,
                "p_currency": data.currency,
                "p_external_method": data.external_method,
                "p_note": data.note,
                "p_idempotency_key": request_key,
                "p_request_hash": request_hash,
            })
        except PostgrestAPIError as exc:
            rejection = {
                ("P0001", "external_payment_request_conflict"): (
                    409, "This idempotency key is already in use for a different external payment request."),
                ("22023", "external_payment_requires_usd"): (400, EXTERNAL_PAYMENT_USD_ONLY_DETAIL),
                ("22023", "external_payment_invalid_key"): (400, EXTERNAL_PAYMENT_IDEMPOTENCY_REQUIRED_DETAIL),
                ("22023", "external_payment_invalid_request"): (400, "Invalid external payment request."),
                ("P0002", "external_payment_payer_not_found"): (404, "Payer not found."),
            }.get((getattr(exc, "code", None), getattr(exc, "message", None)))
            if rejection:
                raise HTTPException(status_code=rejection[0], detail=rejection[1]) from exc
            raise
        row = first_rpc_row(result)
        if not row:
            raise HTTPException(status_code=500, detail="External payment confirmation is unavailable. Retry the original request.")
        payment = BillingPaymentResponse(**row)
        # The payment and original-actor audit have already committed together.
        # A failed balance refresh remains recoverable with this same request key.
        self._recompute_payer_balance(studio_id, payment.payer_id)
        return payment

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
        if data.reason is not None and data.reason not in SUPPORTED_REFUND_REASONS:
            raise HTTPException(
                status_code=400,
                detail="Refund reason must be duplicate, fraudulent, or requested_by_customer.",
            )
        payment = self._get_row_or_404("billing_payments", payment_id, studio_id, "Payment not found.")
        if not payment.get("stripe_charge_id") or not payment.get("stripe_account_id"):
            raise HTTPException(status_code=409, detail="Only Stripe payments can be refunded through Koaryu.")
        payer_id = payment.get("payer_id")
        if not payer_id:
            raise HTTPException(
                status_code=409,
                detail="Payment payer identity is incomplete and requires reconciliation.",
            )
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
        claimed = coordinator.claim_resource(
            studio_id=studio_id,
            actor_id=actor_id,
            operation_type=PAYMENT_REFUND_OPERATION_TYPE,
            resource_type="payment",
            resource_id=payment_id,
            payer_id=str(payer_id),
            caller_request_key=normalized_idempotency_key,
            request_sha256=request_sha256,
            stripe_connected_account_id=account_id,
            connect_account_generation=generation,
            lease_owner=lease_owner,
        )
        operation = claimed["operation"]
        disposition = provider_operation_disposition(claimed)
        recovery = disposition in {"recovery_safe_retry", "recovery_reconcile_only"}
        context = BillingProviderOperationContext(
            operation_id=str(operation["id"]),
            studio_id=studio_id,
            actor_id=str(operation["actor_id"]),
            operation_type=PAYMENT_REFUND_OPERATION_TYPE,
            caller_request_key=str(claimed["canonical_caller_request_key"]),
            request_sha256=str(operation["request_sha256"]),
            stripe_connected_account_id=account_id,
            connect_account_generation=generation,
            lease_owner=str(operation["lease_owner"]) if recovery else lease_owner,
        )
        if disposition == "replay":
            try:
                amount = self._refund_operation_amount(operation, data.amount_cents)
                row = self._load_refund_operation_result(
                    payment=payment,
                    operation=operation,
                    context=context,
                    requested_amount_cents=amount,
                )
                self._ensure_refund_audit(
                    payment=payment, refund=row, data=data, amount=amount,
                    operation=operation, context=context,
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
            operation = coordinator.complete(
                context, operation, result_code="payment_refund_completed"
            )
            self._ensure_refund_audit(
                payment=payment, refund=row, data=data, amount=amount,
                operation=operation, context=context,
            )
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
            operation = coordinator.complete(
                context, operation, result_code="payment_refund_completed"
            )
            self._ensure_refund_audit(
                payment=payment, refund=row, data=data, amount=amount,
                operation=operation, context=context,
            )
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
        amount = (
            self._refund_operation_amount(operation, data.amount_cents)
            if recovery
            else (data.amount_cents or refundable_remaining)
        )
        if not recovery and amount < 1:
            coordinator.transition(
                context,
                operation,
                "definitive_rejected",
                error_code="payment_refund_no_balance",
            )
            raise HTTPException(status_code=409, detail="This payment has no refundable balance.")
        if not recovery and amount > refundable_remaining:
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
        stripe_service = self.stripe_service_cls()
        if disposition == "recovery_reconcile_only":
            refund_id = str(operation.get("provider_object_id") or "")
            try:
                refund = stripe_service.retrieve_connected_refund(
                    account_id=account_id,
                    refund_id=refund_id,
                )
                self._verify_recovered_refund(
                    refund,
                    refund_id=refund_id,
                    payment=payment,
                    studio_id=studio_id,
                    payment_id=payment_id,
                    amount=amount,
                    reason=data.reason,
                )
            except Exception as exc:
                self._mark_refund_reconciliation(
                    coordinator,
                    context,
                    operation,
                    "payment_refund_recovered_object_mismatch",
                    exc,
                )
            provider_status = self._safe_refund_status(refund)
            operation = coordinator.transition(
                context,
                operation,
                "provider_succeeded",
                provider_object_id=refund_id,
                result_code=f"payment_refund_status_{provider_status}",
                result_summary=f"amount_cents:{amount}",
            )
            if disposition == "recovery_safe_retry" and int(
                operation.get("provider_request_attempt_count") or 0
            ) != 2:
                raise HTTPException(status_code=503, detail=REFUND_AMBIGUOUS_DETAIL)
        else:
            operation = coordinator.transition(
                context,
                operation,
                "provider_request_in_flight",
                result_code="payment_refund_started",
                result_summary=f"amount_cents:{amount}",
            )
            try:
                refund = stripe_service.create_connected_refund(
                    account_id=account_id,
                    studio_id=studio_id,
                    charge_id=payment["stripe_charge_id"],
                    amount=amount,
                    reason=data.reason,
                    refund_application_fee=(
                        int(payment.get("application_fee_amount_cents") or 0) > 0
                    ),
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
        operation = coordinator.complete(
            context, operation, result_code="payment_refund_completed"
        )
        self._ensure_refund_audit(
            payment=payment, refund=row, data=data, amount=amount,
            operation=operation, context=context,
        )
        return BillingRefundResponse(**row)

    def _ensure_refund_audit(
        self,
        *,
        payment: dict[str, Any],
        refund: dict[str, Any],
        data: BillingRefundCreate,
        amount: int,
        operation: dict[str, Any],
        context: BillingProviderOperationContext,
    ) -> None:
        payment_id = str(payment.get("id") or "")
        refund_status = str(refund.get("status") or "pending")
        audit_action = (
            "billing.payment_refunded"
            if refund_status == "succeeded"
            else "billing.payment_refund_requested"
        )
        expected_metadata = {
            "amount_cents": amount,
            "stripe_refund_id": refund.get("stripe_refund_id"),
            "status": refund_status,
            "operation_id": context.operation_id,
        }
        expected_request_sha256 = stable_hash({
            "operation_type": PAYMENT_REFUND_OPERATION_TYPE,
            "studio_id": context.studio_id,
            "payment_id": payment_id,
            "stripe_connected_account_id": context.stripe_connected_account_id,
            "connect_account_generation": context.connect_account_generation,
            "stripe_charge_id": payment.get("stripe_charge_id"),
            "requested_amount_cents": data.amount_cents,
            "reason": data.reason,
        })
        if (
            not payment_id
            or payment.get("studio_id") != context.studio_id
            or payment.get("stripe_account_id")
            != context.stripe_connected_account_id
            or payment.get("connect_account_generation")
            != context.connect_account_generation
            or operation.get("id") != context.operation_id
            or operation.get("studio_id") != context.studio_id
            or operation.get("actor_id") != context.actor_id
            or operation.get("operation_type") != PAYMENT_REFUND_OPERATION_TYPE
            or operation.get("request_sha256") != context.request_sha256
            or expected_request_sha256 != context.request_sha256
            or operation.get("stripe_connected_account_id")
            != context.stripe_connected_account_id
            or operation.get("connect_account_generation")
            != context.connect_account_generation
            or operation.get("provider_object_id")
            != refund.get("stripe_refund_id")
            or operation.get("state") != "completed"
            or operation.get("result_code") != "payment_refund_completed"
            or self._refund_operation_amount(operation, data.amount_cents) != amount
        ):
            raise RuntimeError("payment_refund_audit_identity_mismatch")
        self._verify_refund_projection(
            refund,
            payment=payment,
            operation=operation,
            context=context,
            expected_amount=amount,
        )

        audit_id = str(uuid5(
            NAMESPACE_URL,
            f"koaryu:{audit_action}:{context.operation_id}",
        ))
        existing = (
            self.supabase.table("audit_logs")
            .select("*")
            .eq("id", audit_id)
            .limit(1)
            .execute()
        )
        if existing.data:
            self._validate_refund_audit_row(
                existing.data[0], audit_id=audit_id,
                studio_id=context.studio_id, actor_id=context.actor_id,
                action=audit_action, payment_id=payment_id,
                metadata=expected_metadata,
            )
            return
        legacy = (
            self.supabase.table("audit_logs")
            .select("*")
            .eq("studio_id", context.studio_id)
            .eq("action", audit_action)
            .eq("entity_id", payment_id)
            .eq("metadata->>operation_id", context.operation_id)
            .limit(2)
            .execute()
        )
        if len(legacy.data or []) > 1:
            raise RuntimeError("payment_refund_legacy_audit_ambiguous")
        if legacy.data:
            legacy_row = legacy.data[0]
            if (
                str(legacy_row.get("id") or "") == audit_id
                or legacy_row.get("studio_id") != context.studio_id
                or legacy_row.get("actor_id") != context.actor_id
                or legacy_row.get("action") != audit_action
                or legacy_row.get("entity_type") != "billing"
                or str(legacy_row.get("entity_id") or "") != payment_id
                or legacy_row.get("metadata") != expected_metadata
            ):
                raise RuntimeError("payment_refund_legacy_audit_identity_mismatch")
            return
        try:
            self.supabase.table("audit_logs").insert({
                "id": audit_id,
                "studio_id": context.studio_id,
                "actor_id": context.actor_id,
                "action": audit_action,
                "entity_type": "billing",
                "entity_id": payment_id,
                "metadata": expected_metadata,
            }).execute()
        except PostgrestAPIError as exc:
            if getattr(exc, "code", None) != "23505":
                raise
            winner = (
                self.supabase.table("audit_logs")
                .select("*")
                .eq("id", audit_id)
                .limit(1)
                .execute()
            )
            if not winner.data:
                raise RuntimeError("payment_refund_audit_conflict_unverified") from exc
            try:
                self._validate_refund_audit_row(
                    winner.data[0], audit_id=audit_id,
                    studio_id=context.studio_id, actor_id=context.actor_id,
                    action=audit_action, payment_id=payment_id,
                    metadata=expected_metadata,
                )
            except RuntimeError as invariant_exc:
                raise RuntimeError(
                    "payment_refund_audit_conflict_unverified"
                ) from invariant_exc

    @staticmethod
    def _validate_refund_audit_row(
        audit: dict[str, Any],
        *,
        audit_id: str,
        studio_id: str,
        actor_id: str,
        action: str,
        payment_id: str,
        metadata: dict[str, Any],
    ) -> None:
        if (
            str(audit.get("id") or "") != audit_id
            or audit.get("studio_id") != studio_id
            or audit.get("actor_id") != actor_id
            or audit.get("action") != action
            or audit.get("entity_type") != "billing"
            or str(audit.get("entity_id") or "") != payment_id
            or audit.get("metadata") != metadata
        ):
            raise RuntimeError("payment_refund_audit_identity_mismatch")

    @staticmethod
    def _verify_recovered_refund(
        refund: Any,
        *,
        refund_id: str,
        payment: dict[str, Any],
        studio_id: str,
        payment_id: str,
        amount: int,
        reason: str | None,
    ) -> None:
        metadata = _object_get(refund, "metadata") or {}
        if (
            _stripe_id(refund) != refund_id
            or _stripe_id(_object_get(refund, "charge"))
            != str(payment.get("stripe_charge_id") or "")
            or int(_object_get(refund, "amount") or 0) != amount
            or (_object_get(refund, "reason") or None) != reason
            or dict(metadata) != {
                "studio_id": studio_id,
                "payment_id": payment_id,
                "product": "koaryu_payments",
            }
        ):
            raise RuntimeError("payment_refund_recovered_object_mismatch")

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
        return normalized if normalized in {
            "pending", "requires_action", "succeeded", "failed", "canceled"
        } else "unknown"

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
            if provider_status not in {
                "pending", "requires_action", "succeeded", "failed", "canceled", "unknown"
            }:
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
            if operation.get("state") == "recovery_authorized":
                coordinator.mark_recovery_reconciliation_v2(
                    context,
                    operation,
                    reconciliation_reason_code=reason_code,
                )
            else:
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
