from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from typing import Any, Optional

from fastapi import HTTPException, status
from postgrest.exceptions import APIError as PostgrestAPIError


IDEMPOTENCY_CONFLICT_DETAIL = (
    "Idempotency-Key was already used for a different billing request."
)
OPERATION_CONCURRENT_DETAIL = (
    "Billing operation changed concurrently. Retry with the same Idempotency-Key."
)
OPERATION_UNAVAILABLE_DETAIL = "This billing operation is not available yet."
OPERATION_IN_PROGRESS_DETAIL = (
    "This billing operation is already in progress. Retry with the same Idempotency-Key."
)
OPERATION_RECONCILIATION_DETAIL = (
    "This billing operation requires reconciliation and will not be retried automatically."
)
OPERATION_TERMINAL_DETAIL = (
    "This billing operation was rejected. Use a new Idempotency-Key after correcting the request."
)
PAYER_SETUP_OPERATION_TYPE = "payer.setup"
PAYER_SYNC_OPERATION_TYPE = "payer.sync"
PAYMENT_REFUND_OPERATION_TYPE = "payment.refund"
PLAN_SYNC_OPERATION_TYPE = "plan.sync"
INVOICE_CREATE_OPERATION_TYPE = "invoice.create"
INVOICE_FINALIZE_OPERATION_TYPE = "invoice.finalize"
INVOICE_RETRY_OPERATION_TYPE = "invoice.retry"
INVOICE_VOID_OPERATION_TYPE = "invoice.void"
ENROLLMENT_ACTIVATE_AUTOPAY_OPERATION_TYPE = "enrollment.activate.autopay"
ENROLLMENT_ACTIVATE_INVOICE_OPERATION_TYPE = "enrollment.activate.invoice"
ENROLLMENT_CANCEL_PERIOD_END_SCHEDULE_OPERATION_TYPE = "enrollment.cancel.period_end.schedule"
ENROLLMENT_CANCEL_PERIOD_END_EXECUTE_OPERATION_TYPE = "enrollment.cancel.period_end.execute"
ENROLLMENT_CANCEL_PERIOD_END_REVOKE_OPERATION_TYPE = "enrollment.cancel.period_end.revoke"
ENROLLMENT_CANCEL_IMMEDIATE_OPERATION_TYPE = "enrollment.cancel.immediate"
AUTOPAY_TERMS_VERSION = "koaryu-autopay-v1"
AUTOPAY_DISABLE_SETUP_PENDING_DETAIL = (
    "Autopay cannot be disabled while a payer setup session or consent is pending."
)
AUTOPAY_DISABLE_SUBSCRIPTION_ACTIVE_DETAIL = (
    "Autopay cannot be disabled while active provider subscriptions require the named cancellation workflow."
)
REFUND_PRIOR_SETTLING_DETAIL = (
    "A prior refund for this payment is still settling. Wait for its final provider status before starting another refund."
)
RESOURCE_IDENTITY_RECONCILIATION_DETAIL = (
    "The payer or payment provider identity requires reconciliation before this operation can continue."
)


def provider_operation_disposition(claimed: dict[str, Any]) -> str:
    operation = claimed.get("operation")
    outcome = str(claimed.get("outcome") or "")
    if not isinstance(operation, dict):
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Billing operation state could not be verified.",
        )
    state = str(operation.get("state") or "")
    if outcome in {"busy", "provider_request_in_flight"} or state == "provider_request_in_flight":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=OPERATION_IN_PROGRESS_DETAIL,
        )
    if outcome == "reconciliation_required" or state == "reconciliation_required":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=OPERATION_RECONCILIATION_DETAIL,
        )
    if state in {"definitive_failed", "definitive_rejected"}:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=OPERATION_TERMINAL_DETAIL,
        )
    if state == "completed":
        return "replay"
    if state in {"started", "provider_succeeded", "projected"}:
        return "continue"
    raise HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail="Billing operation state could not be verified.",
    )


@dataclass(frozen=True)
class BillingProviderOperationContext:
    operation_id: str
    studio_id: str
    actor_id: str
    operation_type: str
    caller_request_key: str
    request_sha256: str
    stripe_connected_account_id: str
    connect_account_generation: int
    lease_owner: str


@dataclass(frozen=True)
class BillingProviderOperationStepContext:
    parent: BillingProviderOperationContext
    plan_sha256: str
    step_order: int
    step_name: str
    provider_operation: str
    step_request_sha256: str
    stripe_idempotency_key: str


def billing_provider_step_plan_sha256(steps: list[dict[str, str]]) -> str:
    if not 2 <= len(steps) <= 32:
        raise ValueError("Billing provider step plans require 2 to 32 steps.")
    required_keys = {
        "step_name",
        "provider_operation",
        "request_sha256",
        "stripe_idempotency_key",
    }
    normalized: list[dict[str, str]] = []
    for step in steps:
        if set(step) != required_keys or any(not isinstance(value, str) or not value for value in step.values()):
            raise ValueError("Billing provider step plan shape is invalid.")
        normalized.append({
            "step_name": step["step_name"],
            "request_sha256": step["request_sha256"],
            "provider_operation": step["provider_operation"],
            "stripe_idempotency_key": step["stripe_idempotency_key"],
        })
    postgres_jsonb_text = json.dumps(normalized, ensure_ascii=False, separators=(", ", ": "))
    return hashlib.sha256(postgres_jsonb_text.encode("utf-8")).hexdigest()


class BillingProviderOperationCoordinator:
    def __init__(self, supabase: Any):
        self.supabase = supabase

    def claim(
        self,
        *,
        studio_id: str,
        actor_id: str,
        operation_type: str,
        caller_request_key: str,
        request_sha256: str,
        stripe_connected_account_id: str,
        connect_account_generation: int,
        lease_owner: str,
        lease_seconds: int = 30,
    ) -> dict[str, Any]:
        return self._rpc(
            "claim_billing_provider_operation_v1",
            {
                "p_studio_id": studio_id,
                "p_actor_id": actor_id,
                "p_operation_type": operation_type,
                "p_caller_request_key": caller_request_key,
                "p_request_sha256": request_sha256,
                "p_stripe_connected_account_id": stripe_connected_account_id,
                "p_connect_account_generation": connect_account_generation,
                "p_lease_owner": lease_owner,
                "p_lease_seconds": lease_seconds,
            },
            expected_key="operation",
        )

    def claim_resource(
        self,
        *,
        studio_id: str,
        actor_id: str,
        operation_type: str,
        resource_type: str,
        resource_id: str,
        payer_id: str | None,
        caller_request_key: str,
        request_sha256: str,
        stripe_connected_account_id: str,
        connect_account_generation: int,
        lease_owner: str,
        lease_seconds: int = 30,
    ) -> dict[str, Any]:
        rpc_name = (
            "claim_billing_invoice_closeout_operation_v1"
            if operation_type in {
                INVOICE_FINALIZE_OPERATION_TYPE,
                INVOICE_VOID_OPERATION_TYPE,
            }
            else "claim_billing_provider_operation_resource_v1"
        )
        envelope = self._rpc(
            rpc_name,
            {
                "p_studio_id": studio_id,
                "p_actor_id": actor_id,
                "p_operation_type": operation_type,
                "p_resource_type": resource_type,
                "p_resource_id": resource_id,
                "p_payer_id": payer_id,
                "p_caller_request_key": caller_request_key,
                "p_request_sha256": request_sha256,
                "p_stripe_connected_account_id": stripe_connected_account_id,
                "p_connect_account_generation": connect_account_generation,
                "p_lease_owner": lease_owner,
                "p_lease_seconds": lease_seconds,
            },
            expected_key="operation",
        )
        if (
            not isinstance(envelope.get("resource"), dict)
            or not isinstance(envelope.get("requested_caller_request_key"), str)
            or not isinstance(envelope.get("canonical_caller_request_key"), str)
        ):
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Billing operation resource state could not be verified.",
            )
        return envelope

    def read(self, context: BillingProviderOperationContext) -> dict[str, Any]:
        return self._rpc(
            "read_billing_provider_operation_v1",
            {
                "p_operation_id": context.operation_id,
                "p_studio_id": context.studio_id,
                "p_reader_id": context.actor_id,
                "p_operation_type": context.operation_type,
                "p_caller_request_key": context.caller_request_key,
                "p_request_sha256": context.request_sha256,
                "p_stripe_connected_account_id": context.stripe_connected_account_id,
                "p_connect_account_generation": context.connect_account_generation,
            },
            expected_key="operation",
        )

    def transition(
        self,
        context: BillingProviderOperationContext,
        operation: dict[str, Any],
        to_state: str,
        *,
        provider_object_id: Optional[str] = None,
        provider_secondary_object_id: Optional[str] = None,
        provider_request_id: Optional[str] = None,
        result_code: Optional[str] = None,
        result_summary: Optional[str] = None,
        error_code: Optional[str] = None,
        error_summary: Optional[str] = None,
        reconciliation_reason_code: Optional[str] = None,
    ) -> dict[str, Any]:
        return self._rpc(
            "transition_billing_provider_operation_v1",
            {
                "p_operation_id": context.operation_id,
                "p_studio_id": context.studio_id,
                "p_actor_id": context.actor_id,
                "p_operation_type": context.operation_type,
                "p_caller_request_key": context.caller_request_key,
                "p_request_sha256": context.request_sha256,
                "p_stripe_connected_account_id": context.stripe_connected_account_id,
                "p_connect_account_generation": context.connect_account_generation,
                "p_lease_owner": context.lease_owner,
                "p_expected_revision": int(operation["revision"]),
                "p_to_state": to_state,
                "p_provider_object_id": provider_object_id,
                "p_provider_secondary_object_id": provider_secondary_object_id,
                "p_provider_request_id": provider_request_id,
                "p_result_code": result_code,
                "p_result_summary": result_summary,
                "p_error_code": error_code,
                "p_error_summary": error_summary,
                "p_reconciliation_reason_code": reconciliation_reason_code,
            },
            expected_key="operation",
        )["operation"]

    def complete(
        self,
        context: BillingProviderOperationContext,
        operation: dict[str, Any],
        *,
        result_code: Optional[str] = None,
        result_summary: Optional[str] = None,
    ) -> dict[str, Any]:
        return self._rpc(
            "complete_billing_provider_operation_v1",
            {
                "p_operation_id": context.operation_id,
                "p_studio_id": context.studio_id,
                "p_actor_id": context.actor_id,
                "p_operation_type": context.operation_type,
                "p_caller_request_key": context.caller_request_key,
                "p_request_sha256": context.request_sha256,
                "p_stripe_connected_account_id": context.stripe_connected_account_id,
                "p_connect_account_generation": context.connect_account_generation,
                "p_lease_owner": context.lease_owner,
                "p_expected_revision": int(operation["revision"]),
                "p_result_code": result_code,
                "p_result_summary": result_summary,
            },
            expected_key="operation",
        )["operation"]

    def authorize_recovery(
        self,
        context: BillingProviderOperationContext,
        operation: dict[str, Any],
        *,
        recovery_actor_id: str,
        recovery_proof_sha256: str,
        recovery_outcome: str,
        lease_owner: str,
        lease_seconds: int = 30,
    ) -> dict[str, Any]:
        return self._rpc(
            "authorize_billing_provider_operation_recovery_v1",
            {
                "p_operation_id": context.operation_id,
                "p_studio_id": context.studio_id,
                "p_actor_id": context.actor_id,
                "p_operation_type": context.operation_type,
                "p_caller_request_key": context.caller_request_key,
                "p_request_sha256": context.request_sha256,
                "p_stripe_connected_account_id": context.stripe_connected_account_id,
                "p_connect_account_generation": context.connect_account_generation,
                "p_recovery_actor_id": recovery_actor_id,
                "p_recovery_proof_sha256": recovery_proof_sha256,
                "p_recovery_outcome": recovery_outcome,
                "p_lease_owner": lease_owner,
                "p_lease_seconds": lease_seconds,
                "p_expected_revision": int(operation["revision"]),
            },
            expected_key="operation",
        )["operation"]

    def prepare_payer_setup(
        self,
        context: BillingProviderOperationContext,
        operation: dict[str, Any],
        *,
        setup_request_id: str,
        payer_id: str,
        terms_version: str,
        expires_at: str,
    ) -> dict[str, Any]:
        return self._rpc(
            "prepare_billing_payer_setup_request_v1",
            {
                "p_operation_id": context.operation_id,
                "p_setup_request_id": setup_request_id,
                "p_studio_id": context.studio_id,
                "p_actor_id": context.actor_id,
                "p_payer_id": payer_id,
                "p_terms_version": terms_version,
                "p_stripe_connected_account_id": context.stripe_connected_account_id,
                "p_connect_account_generation": context.connect_account_generation,
                "p_lease_owner": context.lease_owner,
                "p_expected_operation_revision": int(operation["revision"]),
                "p_expires_at": expires_at,
            },
            expected_key="setup_request",
        )["setup_request"]

    def bind_payer_setup_session(
        self,
        context: BillingProviderOperationContext,
        *,
        setup_request: dict[str, Any],
        payer_id: str,
        stripe_checkout_session_id: str,
    ) -> dict[str, Any]:
        return self._rpc(
            "bind_billing_payer_setup_session_v1",
            {
                "p_setup_request_id": setup_request["id"],
                "p_operation_id": context.operation_id,
                "p_studio_id": context.studio_id,
                "p_payer_id": payer_id,
                "p_stripe_checkout_session_id": stripe_checkout_session_id,
                "p_stripe_connected_account_id": context.stripe_connected_account_id,
                "p_connect_account_generation": context.connect_account_generation,
                "p_expected_setup_revision": int(setup_request["revision"]),
            },
            expected_key="setup_request",
        )["setup_request"]

    def read_payer_setup_webhook(
        self,
        *,
        setup_request_id: str,
        stripe_checkout_session_id: str,
        stripe_connected_account_id: str,
        connect_account_generation: int,
    ) -> dict[str, Any]:
        return self._rpc(
            "read_billing_payer_setup_webhook_v1",
            {
                "p_setup_request_id": setup_request_id,
                "p_stripe_checkout_session_id": stripe_checkout_session_id,
                "p_stripe_connected_account_id": stripe_connected_account_id,
                "p_connect_account_generation": connect_account_generation,
            },
            expected_key="setup_request",
        )

    def read_payer_setup_request(
        self,
        *,
        setup_request_id: str,
        studio_id: str,
        payer_id: str,
        stripe_connected_account_id: str,
        connect_account_generation: int,
    ) -> dict[str, Any]:
        return self._rpc(
            "read_billing_payer_setup_request_v1",
            {
                "p_setup_request_id": setup_request_id,
                "p_studio_id": studio_id,
                "p_payer_id": payer_id,
                "p_stripe_connected_account_id": stripe_connected_account_id,
                "p_connect_account_generation": connect_account_generation,
            },
            expected_key="setup_request",
        )["setup_request"]

    def find_payer_setup_request(
        self,
        *,
        setup_request_id: str,
        studio_id: str,
        payer_id: str,
        stripe_connected_account_id: str,
        connect_account_generation: int,
    ) -> Optional[dict[str, Any]]:
        try:
            return self.read_payer_setup_request(
                setup_request_id=setup_request_id,
                studio_id=studio_id,
                payer_id=payer_id,
                stripe_connected_account_id=stripe_connected_account_id,
                connect_account_generation=connect_account_generation,
            )
        except PostgrestAPIError as exc:
            if (
                str(getattr(exc, "code", "") or "") == "P0002"
                and "billing_payer_setup_request_not_found"
                in str(getattr(exc, "message", "") or exc)
            ):
                return None
            raise

    def accept_payer_consent(
        self,
        *,
        setup_request: dict[str, Any],
        acceptance_proof_sha256: str,
        accepted_at: str,
    ) -> dict[str, Any]:
        return self._rpc(
            "accept_billing_payer_payment_consent_v1",
            {
                "p_setup_request_id": setup_request["id"],
                "p_studio_id": setup_request["studio_id"],
                "p_payer_id": setup_request["payer_id"],
                "p_terms_version": setup_request["terms_version"],
                "p_stripe_checkout_session_id": setup_request["stripe_checkout_session_id"],
                "p_stripe_connected_account_id": setup_request["stripe_connected_account_id"],
                "p_connect_account_generation": setup_request["connect_account_generation"],
                "p_acceptance_proof_sha256": acceptance_proof_sha256,
                "p_accepted_at": accepted_at,
            },
            expected_key="consent",
        )["consent"]

    def complete_payer_consent(
        self,
        *,
        consent: dict[str, Any],
        setup_request: dict[str, Any],
        operation_id: str,
        stripe_setup_intent_id: str,
        completed_at: str,
    ) -> dict[str, Any]:
        return self._rpc(
            "complete_billing_payer_payment_consent_v1",
            {
                "p_consent_id": consent["id"],
                "p_setup_request_id": setup_request["id"],
                "p_operation_id": operation_id,
                "p_stripe_checkout_session_id": setup_request["stripe_checkout_session_id"],
                "p_stripe_setup_intent_id": stripe_setup_intent_id,
                "p_stripe_connected_account_id": setup_request["stripe_connected_account_id"],
                "p_connect_account_generation": setup_request["connect_account_generation"],
                "p_completed_at": completed_at,
            },
            expected_key="consent",
        )

    def finalize_payer_setup_projection(
        self,
        *,
        consent: dict[str, Any],
        setup_request: dict[str, Any],
        operation_id: str,
        stripe_setup_intent_id: str,
    ) -> dict[str, Any]:
        return self._rpc(
            "finalize_billing_payer_setup_projection_v1",
            {
                "p_consent_id": consent["id"],
                "p_setup_request_id": setup_request["id"],
                "p_operation_id": operation_id,
                "p_studio_id": setup_request["studio_id"],
                "p_payer_id": setup_request["payer_id"],
                "p_stripe_checkout_session_id": setup_request["stripe_checkout_session_id"],
                "p_stripe_setup_intent_id": stripe_setup_intent_id,
                "p_stripe_connected_account_id": setup_request["stripe_connected_account_id"],
                "p_connect_account_generation": setup_request["connect_account_generation"],
            },
            expected_key="operation",
        )

    def read_active_payer_consent(
        self,
        *,
        studio_id: str,
        payer_id: str,
        terms_version: str,
        stripe_connected_account_id: str,
        connect_account_generation: int,
    ) -> dict[str, Any]:
        return self._rpc(
            "read_active_billing_payer_payment_consent_v1",
            {
                "p_studio_id": studio_id,
                "p_payer_id": payer_id,
                "p_terms_version": terms_version,
                "p_stripe_connected_account_id": stripe_connected_account_id,
                "p_connect_account_generation": connect_account_generation,
            },
            expected_key="consent",
        )["consent"]

    def disable_payer_autopay(
        self,
        *,
        studio_id: str,
        payer_id: str,
        actor_id: str,
        disabled_at: str,
        reason_code: str = "staff_disabled_autopay",
    ) -> dict[str, Any]:
        return self._rpc(
            "disable_billing_payer_autopay_v1",
            {
                "p_studio_id": studio_id,
                "p_payer_id": payer_id,
                "p_actor_id": actor_id,
                "p_disabled_at": disabled_at,
                "p_reason_code": reason_code,
            },
            expected_key="payer",
        )

    def reserve_autopay_activation(
        self,
        *,
        studio_id: str,
        actor_id: str,
        enrollment_id: str,
        payer_id: str,
        billing_plan_id: str,
        stripe_connected_account_id: str,
        connect_account_generation: int,
        application_fee_percent: float,
    ) -> dict[str, Any]:
        return self._rpc(
            "reserve_billing_autopay_activation_v31",
            {
                "p_studio_id": studio_id,
                "p_actor_id": actor_id,
                "p_enrollment_id": enrollment_id,
                "p_payer_id": payer_id,
                "p_billing_plan_id": billing_plan_id,
                "p_stripe_connected_account_id": stripe_connected_account_id,
                "p_connect_account_generation": connect_account_generation,
                "p_terms_version": AUTOPAY_TERMS_VERSION,
                "p_application_fee_percent": application_fee_percent,
            },
            expected_key="subscription",
        )

    def mark_payer_setup_reconciliation(
        self,
        *,
        setup_request_id: str,
        operation_id: str,
        stripe_checkout_session_id: str,
        stripe_setup_intent_id: Optional[str],
        stripe_connected_account_id: str,
        connect_account_generation: int,
        reconciliation_reason_code: str,
    ) -> dict[str, Any]:
        return self._rpc(
            "mark_billing_payer_setup_reconciliation_v1",
            {
                "p_setup_request_id": setup_request_id,
                "p_operation_id": operation_id,
                "p_stripe_checkout_session_id": stripe_checkout_session_id,
                "p_stripe_setup_intent_id": stripe_setup_intent_id,
                "p_stripe_connected_account_id": stripe_connected_account_id,
                "p_connect_account_generation": connect_account_generation,
                "p_reconciliation_reason_code": reconciliation_reason_code,
            },
            expected_key="operation",
        )

    def close_payer_setup_request(
        self,
        *,
        setup_request_id: str,
        operation_id: str,
        studio_id: str,
        payer_id: str,
        stripe_checkout_session_id: str,
        stripe_connected_account_id: str,
        connect_account_generation: int,
        close_reason_code: str,
        provider_read_proof_sha256: str,
    ) -> dict[str, Any]:
        return self._rpc(
            "close_billing_payer_setup_request_v1",
            {
                "p_setup_request_id": setup_request_id,
                "p_operation_id": operation_id,
                "p_studio_id": studio_id,
                "p_payer_id": payer_id,
                "p_stripe_checkout_session_id": stripe_checkout_session_id,
                "p_stripe_connected_account_id": stripe_connected_account_id,
                "p_connect_account_generation": connect_account_generation,
                "p_close_reason_code": close_reason_code,
                "p_provider_read_proof_sha256": provider_read_proof_sha256,
            },
            expected_key="operation",
        )

    def reject_payer_setup_without_provider(
        self,
        context: BillingProviderOperationContext,
        *,
        operation: dict[str, Any],
        setup_request: dict[str, Any],
        payer_id: str,
    ) -> dict[str, Any]:
        return self._rpc(
            "reject_billing_payer_setup_without_provider_v1",
            {
                "p_operation_id": context.operation_id,
                "p_setup_request_id": setup_request["id"],
                "p_studio_id": context.studio_id,
                "p_actor_id": context.actor_id,
                "p_payer_id": payer_id,
                "p_caller_request_key": context.caller_request_key,
                "p_request_sha256": context.request_sha256,
                "p_stripe_connected_account_id": context.stripe_connected_account_id,
                "p_connect_account_generation": context.connect_account_generation,
                "p_lease_owner": context.lease_owner,
                "p_expected_operation_revision": int(operation["revision"]),
                "p_expected_setup_revision": int(setup_request["revision"]),
            },
            expected_key="operation",
        )

    def claim_enrollment_transition(
        self,
        *,
        studio_id: str,
        actor_id: str,
        transition_kind: str,
        caller_request_key: str,
        request_sha256: str,
        enrollment_id: str,
        payer_id: str,
        billing_subscription_id: str,
        stripe_subscription_id: str,
        stripe_subscription_item_id: str,
        stripe_connected_account_id: str,
        connect_account_generation: int,
        period_boundary: str,
        expected_quantity: int,
        expected_subscription_item_count: int,
        same_item_active_count: int,
        provider_quantity: int,
        mutation_strategy: str,
        reason_code: str,
        lease_owner: str,
        lease_seconds: int = 30,
    ) -> dict[str, Any]:
        return self._rpc(
            "claim_billing_enrollment_transition_v1",
            {
                "p_studio_id": studio_id,
                "p_actor_id": actor_id,
                "p_transition_kind": transition_kind,
                "p_caller_request_key": caller_request_key,
                "p_request_sha256": request_sha256,
                "p_enrollment_id": enrollment_id,
                "p_payer_id": payer_id,
                "p_billing_subscription_id": billing_subscription_id,
                "p_stripe_subscription_id": stripe_subscription_id,
                "p_stripe_subscription_item_id": stripe_subscription_item_id,
                "p_stripe_connected_account_id": stripe_connected_account_id,
                "p_connect_account_generation": connect_account_generation,
                "p_period_boundary": period_boundary,
                "p_expected_quantity": expected_quantity,
                "p_expected_subscription_item_count": expected_subscription_item_count,
                "p_same_item_active_count": same_item_active_count,
                "p_provider_quantity": provider_quantity,
                "p_mutation_strategy": mutation_strategy,
                "p_reason_code": reason_code,
                "p_lease_owner": lease_owner,
                "p_lease_seconds": lease_seconds,
            },
            expected_key="intent",
        )

    def read_enrollment_transition_by_key(
        self,
        *,
        studio_id: str,
        actor_id: str,
        transition_kind: str,
        caller_request_key: str,
        request_sha256: str,
        enrollment_id: str,
    ) -> Optional[dict[str, Any]]:
        try:
            result = self.supabase.rpc(
                "read_billing_enrollment_transition_by_key_v1",
                {
                    "p_studio_id": studio_id,
                    "p_actor_id": actor_id,
                    "p_transition_kind": transition_kind,
                    "p_caller_request_key": caller_request_key,
                    "p_request_sha256": request_sha256,
                    "p_enrollment_id": enrollment_id,
                },
            ).execute()
        except PostgrestAPIError as exc:
            if (
                str(getattr(exc, "code", "") or "") == "P0002"
                and "billing_enrollment_transition_not_found"
                in str(getattr(exc, "message", "") or exc)
            ):
                return None
            self._raise_safe_rpc_error(exc)
            raise
        envelope = result.data
        if not isinstance(envelope, dict) or not isinstance(envelope.get("intent"), dict):
            raise HTTPException(status_code=503, detail="Billing transition replay could not be verified.")
        return envelope

    def revoke_enrollment_transition(
        self,
        *,
        intent_id: str,
        studio_id: str,
        actor_id: str,
        expected_revision: int,
        caller_request_key: str,
        request_sha256: str,
        reason_code: str,
        lease_owner: str,
        lease_seconds: int = 30,
    ) -> dict[str, Any]:
        return self._rpc(
            "revoke_billing_enrollment_transition_v1",
            {
                "p_intent_id": intent_id,
                "p_studio_id": studio_id,
                "p_actor_id": actor_id,
                "p_expected_revision": expected_revision,
                "p_caller_request_key": caller_request_key,
                "p_request_sha256": request_sha256,
                "p_reason_code": reason_code,
                "p_lease_owner": lease_owner,
                "p_lease_seconds": lease_seconds,
            },
            expected_key="intent",
        )

    def claim_due_enrollment_transitions(
        self,
        *,
        worker_id: str,
        lease_seconds: int = 30,
        limit: int = 25,
    ) -> list[dict[str, Any]]:
        try:
            result = self.supabase.rpc(
                "claim_due_billing_enrollment_transitions_v1",
                {
                    "p_worker_id": worker_id,
                    "p_lease_seconds": lease_seconds,
                    "p_limit": limit,
                },
            ).execute()
        except PostgrestAPIError as exc:
            self._raise_safe_rpc_error(exc)
            raise
        if not isinstance(result.data, list) or any(not isinstance(row, dict) for row in result.data):
            raise HTTPException(status_code=503, detail="Billing transition due work could not be verified.")
        return result.data

    def start_due_enrollment_transition(
        self,
        *,
        intent_id: str,
        worker_id: str,
        expected_revision: int,
        lease_seconds: int = 30,
    ) -> dict[str, Any]:
        return self._rpc(
            "start_due_billing_enrollment_transition_v1",
            {
                "p_intent_id": intent_id,
                "p_worker_id": worker_id,
                "p_expected_revision": expected_revision,
                "p_lease_seconds": lease_seconds,
            },
            expected_key="intent",
        )

    def complete_due_enrollment_transition(
        self,
        *,
        intent_id: str,
        worker_id: str,
        expected_revision: int,
        provider_evidence_sha256: str,
        provider_subscription_state: str,
    ) -> dict[str, Any]:
        return self._rpc(
            "complete_due_billing_enrollment_transition_v1",
            {
                "p_intent_id": intent_id,
                "p_worker_id": worker_id,
                "p_expected_revision": expected_revision,
                "p_provider_evidence_sha256": provider_evidence_sha256,
                "p_provider_subscription_state": provider_subscription_state,
            },
            expected_key="intent",
        )

    def complete_due_enrollment_item_transition(
        self,
        *,
        intent_id: str,
        studio_id: str,
        worker_id: str,
        expected_revision: int,
        provider_evidence_sha256: str,
        item_transitions: list[dict[str, Any]],
    ) -> dict[str, Any]:
        return self._rpc(
            "complete_due_billing_enrollment_item_transition_v31",
            {
                "p_intent_id": intent_id,
                "p_studio_id": studio_id,
                "p_worker_id": worker_id,
                "p_expected_revision": expected_revision,
                "p_provider_evidence_sha256": provider_evidence_sha256,
                "p_item_transitions": item_transitions,
            },
            expected_key="intent",
        )

    def mark_due_enrollment_readback_reconciliation(
        self,
        *,
        intent_id: str,
        studio_id: str,
        worker_id: str,
        expected_revision: int,
        provider_evidence_sha256: str,
        reconciliation_reason_code: str,
    ) -> dict[str, Any]:
        return self._rpc(
            "mark_billing_enrollment_due_readback_reconciliation_v1",
            {
                "p_intent_id": intent_id,
                "p_studio_id": studio_id,
                "p_worker_id": worker_id,
                "p_expected_revision": expected_revision,
                "p_provider_evidence_sha256": provider_evidence_sha256,
                "p_reconciliation_reason_code": reconciliation_reason_code,
            },
            expected_key="intent",
        )

    def mark_due_enrollment_pre_provider_reconciliation(
        self,
        *,
        intent_id: str,
        studio_id: str,
        worker_id: str,
        expected_revision: int,
        provider_evidence_sha256: str,
        reconciliation_reason_code: str,
    ) -> dict[str, Any]:
        return self._rpc(
            "mark_billing_enrollment_due_pre_provider_reconciliation_v1",
            {
                "p_intent_id": intent_id,
                "p_studio_id": studio_id,
                "p_worker_id": worker_id,
                "p_expected_revision": expected_revision,
                "p_provider_evidence_sha256": provider_evidence_sha256,
                "p_reconciliation_reason_code": reconciliation_reason_code,
            },
            expected_key="intent",
        )

    def transition_enrollment_transition(
        self,
        *,
        intent: dict[str, Any],
        operation: dict[str, Any],
        studio_id: str,
        actor_id: str,
        provider_evidence_sha256: Optional[str] = None,
        reconciliation_reason_code: Optional[str] = None,
    ) -> dict[str, Any]:
        return self._rpc(
            "transition_billing_enrollment_transition_v1",
            {
                "p_intent_id": intent["id"],
                "p_studio_id": studio_id,
                "p_actor_id": actor_id,
                "p_expected_revision": int(intent["revision"]),
                "p_provider_operation_id": operation["id"],
                "p_expected_operation_revision": int(operation["revision"]),
                "p_provider_evidence_sha256": provider_evidence_sha256,
                "p_reconciliation_reason_code": reconciliation_reason_code,
            },
            expected_key="intent",
        )

    def _rpc(
        self,
        name: str,
        params: dict[str, Any],
        *,
        expected_key: str,
    ) -> dict[str, Any]:
        try:
            result = self.supabase.rpc(name, params).execute()
        except PostgrestAPIError as exc:
            self._raise_safe_rpc_error(exc)
            raise
        envelope = result.data
        if not isinstance(envelope, dict) or not isinstance(envelope.get(expected_key), dict):
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Billing operation state could not be verified.",
            )
        return envelope

    @staticmethod
    def _raise_safe_rpc_error(exc: PostgrestAPIError) -> None:
        code = str(getattr(exc, "code", "") or "")
        message = str(getattr(exc, "message", "") or exc)
        if code == "23505" and "billing_provider_operation_request_conflict" in message:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=IDEMPOTENCY_CONFLICT_DETAIL,
            ) from exc
        if code == "23505" and "billing_enrollment_transition_request_conflict" in message:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=IDEMPOTENCY_CONFLICT_DETAIL,
            ) from exc
        if code == "23514" and "billing_enrollment_transition_read_identity_mismatch" in message:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=IDEMPOTENCY_CONFLICT_DETAIL,
            ) from exc
        if code == "23514" and (
            "billing_provider_operation_resource_payer_identity_mismatch" in message
            or "billing_provider_operation_resource_payment_identity_mismatch" in message
            or "billing_provider_operation_resource_prior_projection_unverified" in message
        ):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=RESOURCE_IDENTITY_RECONCILIATION_DETAIL,
            ) from exc
        if code == "40001":
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=OPERATION_CONCURRENT_DETAIL,
            ) from exc
        if code == "55P03" and "billing_invoice_mutation_in_progress" in message:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=OPERATION_CONCURRENT_DETAIL,
            ) from exc
        if code == "0A000":
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=OPERATION_UNAVAILABLE_DETAIL,
            ) from exc
        if code == "55000" and "billing_payer_autopay_disable_setup_pending" in message:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=AUTOPAY_DISABLE_SETUP_PENDING_DETAIL,
            ) from exc
        if code == "55000" and "billing_payer_autopay_disable_subscription_active" in message:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=AUTOPAY_DISABLE_SUBSCRIPTION_ACTIVE_DETAIL,
            ) from exc
        if code == "55000" and "billing_provider_operation_resource_prior_refund_unsettled" in message:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=REFUND_PRIOR_SETTLING_DETAIL,
            ) from exc


class BillingProviderStepCoordinator:
    def __init__(self, supabase: Any):
        self._operations = BillingProviderOperationCoordinator(supabase)

    def register_plan(
        self,
        context: BillingProviderOperationContext,
        operation: dict[str, Any],
        *,
        plan_sha256: str,
        steps: list[dict[str, str]],
    ) -> dict[str, Any]:
        envelope = self._operations._rpc(
            "register_billing_provider_operation_step_plan_v1",
            {
                "p_operation_id": context.operation_id,
                "p_studio_id": context.studio_id,
                "p_actor_id": context.actor_id,
                "p_operation_type": context.operation_type,
                "p_caller_request_key": context.caller_request_key,
                "p_request_sha256": context.request_sha256,
                "p_stripe_connected_account_id": context.stripe_connected_account_id,
                "p_connect_account_generation": context.connect_account_generation,
                "p_lease_owner": context.lease_owner,
                "p_expected_parent_revision": int(operation["revision"]),
                "p_plan_sha256": plan_sha256,
                "p_expected_step_count": len(steps),
                "p_steps": steps,
            },
            expected_key="operation",
        )
        self._require_steps(envelope)
        return envelope

    def read_plan(
        self,
        context: BillingProviderOperationContext,
        *,
        plan_sha256: str,
    ) -> dict[str, Any]:
        envelope = self._operations._rpc(
            "read_billing_provider_operation_step_plan_v1",
            {
                "p_operation_id": context.operation_id,
                "p_studio_id": context.studio_id,
                "p_reader_id": context.actor_id,
                "p_operation_type": context.operation_type,
                "p_caller_request_key": context.caller_request_key,
                "p_request_sha256": context.request_sha256,
                "p_stripe_connected_account_id": context.stripe_connected_account_id,
                "p_connect_account_generation": context.connect_account_generation,
                "p_plan_sha256": plan_sha256,
            },
            expected_key="operation",
        )
        self._require_steps(envelope)
        return envelope

    def claim_step(
        self,
        step: BillingProviderOperationStepContext,
        *,
        lease_seconds: int = 30,
    ) -> dict[str, Any]:
        return self._operations._rpc(
            "claim_billing_provider_operation_step_v1",
            {
                **self._step_identity(step),
                "p_lease_owner": step.parent.lease_owner,
                "p_lease_seconds": lease_seconds,
            },
            expected_key="step",
        )

    def transition_step(
        self,
        step: BillingProviderOperationStepContext,
        current_step: dict[str, Any],
        to_state: str,
        *,
        provider_object_id: Optional[str] = None,
        provider_secondary_object_id: Optional[str] = None,
        provider_request_id: Optional[str] = None,
        result_code: Optional[str] = None,
        error_code: Optional[str] = None,
        reconciliation_reason_code: Optional[str] = None,
    ) -> dict[str, Any]:
        return self._operations._rpc(
            "transition_billing_provider_operation_step_v1",
            {
                **self._step_identity(step),
                "p_lease_owner": step.parent.lease_owner,
                "p_expected_step_revision": int(current_step["revision"]),
                "p_to_state": to_state,
                "p_provider_object_id": provider_object_id,
                "p_provider_secondary_object_id": provider_secondary_object_id,
                "p_provider_request_id": provider_request_id,
                "p_result_code": result_code,
                "p_error_code": error_code,
                "p_reconciliation_reason_code": reconciliation_reason_code,
            },
            expected_key="step",
        )["step"]

    def complete_provider_phase(
        self,
        context: BillingProviderOperationContext,
        operation: dict[str, Any],
        *,
        plan_sha256: str,
        expected_step_count: int,
    ) -> dict[str, Any]:
        return self._operations._rpc(
            "complete_billing_provider_operation_provider_phase_v31",
            {
                "p_operation_id": context.operation_id,
                "p_studio_id": context.studio_id,
                "p_actor_id": context.actor_id,
                "p_operation_type": context.operation_type,
                "p_caller_request_key": context.caller_request_key,
                "p_parent_request_sha256": context.request_sha256,
                "p_stripe_connected_account_id": context.stripe_connected_account_id,
                "p_connect_account_generation": context.connect_account_generation,
                "p_plan_sha256": plan_sha256,
                "p_expected_step_count": expected_step_count,
                "p_expected_parent_revision": int(operation["revision"]),
                "p_lease_owner": context.lease_owner,
            },
            expected_key="operation",
        )

    def authorize_step_recovery(
        self,
        step: BillingProviderOperationStepContext,
        current_step: dict[str, Any],
        *,
        recovery_actor_id: str,
        recovery_proof_sha256: str,
        recovery_outcome: str,
        lease_seconds: int = 30,
    ) -> dict[str, Any]:
        return self._operations._rpc(
            "authorize_billing_provider_operation_step_recovery_v1",
            {
                **self._step_identity(step),
                "p_recovery_actor_id": recovery_actor_id,
                "p_recovery_proof_sha256": recovery_proof_sha256,
                "p_recovery_outcome": recovery_outcome,
                "p_lease_owner": step.parent.lease_owner,
                "p_lease_seconds": lease_seconds,
                "p_expected_step_revision": int(current_step["revision"]),
            },
            expected_key="step",
        )

    @staticmethod
    def _step_identity(step: BillingProviderOperationStepContext) -> dict[str, Any]:
        parent = step.parent
        return {
            "p_operation_id": parent.operation_id,
            "p_studio_id": parent.studio_id,
            "p_actor_id": parent.actor_id,
            "p_operation_type": parent.operation_type,
            "p_caller_request_key": parent.caller_request_key,
            "p_parent_request_sha256": parent.request_sha256,
            "p_stripe_connected_account_id": parent.stripe_connected_account_id,
            "p_connect_account_generation": parent.connect_account_generation,
            "p_plan_sha256": step.plan_sha256,
            "p_step_order": step.step_order,
            "p_step_name": step.step_name,
            "p_provider_operation": step.provider_operation,
            "p_step_request_sha256": step.step_request_sha256,
            "p_stripe_idempotency_key": step.stripe_idempotency_key,
        }

    @staticmethod
    def _require_steps(envelope: dict[str, Any]) -> None:
        if not isinstance(envelope.get("steps"), list):
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Billing provider step plan could not be verified.",
            )
