from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Callable
from uuid import NAMESPACE_URL, uuid4, uuid5

from fastapi import HTTPException, status
from postgrest.exceptions import APIError as PostgrestAPIError

from app.services.billing_invoice_projection import _object_get, _stripe_id, subscription_period_bounds
from app.services.billing_provider_operations import (
    BillingProviderOperationContext,
    BillingProviderOperationCoordinator,
    BillingProviderOperationStepContext,
    BillingProviderStepCoordinator,
    ENROLLMENT_CANCEL_IMMEDIATE_OPERATION_TYPE,
    ENROLLMENT_CANCEL_PERIOD_END_EXECUTE_OPERATION_TYPE,
    ENROLLMENT_CANCEL_PERIOD_END_REVOKE_OPERATION_TYPE,
    ENROLLMENT_CANCEL_PERIOD_END_SCHEDULE_OPERATION_TYPE,
    billing_provider_step_plan_sha256,
)
from app.services.billing_webhook_event_state import epoch_seconds, timestamp
from app.services.platform_billing_helpers import normalize_idempotency_key, stable_hash
from app.services.stripe_mutation_policy import StripeMutationBlocked
from app.services.stripe_service import StripeService


TRANSITION_AMBIGUOUS_DETAIL = (
    "Enrollment transition outcome is not confirmed. "
    "Retry with the same Idempotency-Key after reconciliation."
)
TRANSITION_IN_PROGRESS_DETAIL = (
    "Enrollment transition is already in progress. Retry with the same Idempotency-Key."
)
TRANSITION_REJECTED_DETAIL = "Enrollment transition was rejected."
WHOLE_SUBSCRIPTION_PERIOD_END_GRACE = timedelta(minutes=10)
PERIOD_END_SCHEDULABLE_PROVIDER_STATUSES = frozenset({"active", "trialing", "past_due"})
ITEM_SCHEDULE_METADATA_WORKFLOW = "enrollment_cancel_period_end"


class BillingEnrollmentTransitionWorkflow:
    def __init__(
        self,
        owner: Any,
        *,
        stripe_service_cls: type[StripeService] = StripeService,
        clock: Callable[[], datetime] | None = None,
    ):
        self.owner = owner
        self.supabase = owner.supabase
        self.stripe_service_cls = stripe_service_cls
        self._clock = clock or (lambda: datetime.now(timezone.utc))
        self.lifecycle = owner._stripe_lifecycle()
        self.operations = BillingProviderOperationCoordinator(self.supabase)

    def schedule_period_end(
        self,
        enrollment_id: str,
        studio_id: str,
        actor_id: str,
        idempotency_key: str | None,
        reason_code: str,
    ) -> dict[str, Any]:
        request_key = self._request_key(idempotency_key)
        request_sha256 = self._request_hash(
            studio_id, enrollment_id, "schedule_period_end", reason_code
        )
        existing = self.operations.read_enrollment_transition_by_key(
            studio_id=studio_id,
            actor_id=actor_id,
            transition_kind="schedule_period_end",
            caller_request_key=request_key,
            request_sha256=request_sha256,
            enrollment_id=enrollment_id,
        )
        if existing is not None:
            return self._resume_existing(existing, actor_id=actor_id, mutation="schedule")
        snapshot = self._snapshot(enrollment_id, studio_id, immediate=False)
        if (
            snapshot["mutation_strategy"] == "subscription_item_delete_at_period_end"
            and _stripe_id(_object_get(snapshot["provider"], "schedule"))
        ):
            raise HTTPException(
                status_code=409,
                detail="Subscription already has a provider-side schedule.",
            )
        if snapshot["mutation_strategy"] == "subscription_cancel_at_period_end":
            group_id = str(snapshot["group"]["id"])
            lock_token = self.lifecycle._claim_subscription_quantity_sync_lock(
                studio_id, group_id,
            )
            try:
                snapshot = self._snapshot(enrollment_id, studio_id, immediate=False)
                return self._claim_schedule(
                    snapshot,
                    actor_id=actor_id,
                    request_key=request_key,
                    request_sha256=request_sha256,
                    reason_code=reason_code,
                )
            finally:
                self.lifecycle._release_subscription_quantity_sync_lock(
                    studio_id, group_id, lock_token,
                )
        return self._claim_schedule(
            snapshot,
            actor_id=actor_id,
            request_key=request_key,
            request_sha256=request_sha256,
            reason_code=reason_code,
        )

    def _claim_schedule(
        self,
        snapshot: dict[str, Any],
        *,
        actor_id: str,
        request_key: str,
        request_sha256: str,
        reason_code: str,
    ) -> dict[str, Any]:
        studio_id = str(snapshot["enrollment"]["studio_id"])
        lease_owner = str(uuid4())
        envelope = self.operations.claim_enrollment_transition(
            **self._claim_params(
                snapshot,
                actor_id=actor_id,
                request_key=request_key,
                request_sha256=request_sha256,
                reason_code=reason_code,
                transition_kind="schedule_period_end",
                lease_owner=lease_owner,
            )
        )
        intent = envelope["intent"]
        if not intent.get("provider_operation_id"):
            self._audit_once(
                intent,
                studio_id=studio_id,
                actor_id=actor_id,
                action="billing.student_enrollment_cancel_scheduled",
            )
            return envelope
        return self._drive_provider_operation_locked(
            envelope,
            snapshot=snapshot,
            actor_id=actor_id,
            lease_owner=lease_owner,
            mutation="schedule",
        )

    def cancel_immediate(
        self,
        enrollment_id: str,
        studio_id: str,
        actor_id: str,
        idempotency_key: str | None,
        reason_code: str,
    ) -> dict[str, Any]:
        request_key = self._request_key(idempotency_key)
        request_sha256 = self._request_hash(
            studio_id, enrollment_id, "immediate_cancel", reason_code
        )
        existing = self.operations.read_enrollment_transition_by_key(
            studio_id=studio_id,
            actor_id=actor_id,
            transition_kind="immediate_cancel",
            caller_request_key=request_key,
            request_sha256=request_sha256,
            enrollment_id=enrollment_id,
        )
        if existing is not None:
            return self._resume_existing(existing, actor_id=actor_id, mutation="immediate")
        snapshot = self._snapshot(enrollment_id, studio_id, immediate=True)
        if _stripe_id(_object_get(snapshot["provider"], "schedule")):
            raise HTTPException(
                status_code=409,
                detail="Subscription already has a provider-side schedule.",
            )
        lease_owner = str(uuid4())
        envelope = self.operations.claim_enrollment_transition(
            **self._claim_params(
                snapshot,
                actor_id=actor_id,
                request_key=request_key,
                request_sha256=request_sha256,
                reason_code=reason_code,
                transition_kind="immediate_cancel",
                lease_owner=lease_owner,
            )
        )
        return self._drive_provider_operation(
            envelope,
            snapshot=snapshot,
            actor_id=actor_id,
            lease_owner=lease_owner,
            mutation="immediate",
        )

    def revoke_scheduled(
        self,
        transition_intent_id: str,
        expected_revision: int,
        studio_id: str,
        actor_id: str,
        idempotency_key: str | None,
        reason_code: str,
    ) -> dict[str, Any]:
        request_key = self._request_key(idempotency_key)
        request_sha256 = stable_hash({
            "version": 1,
            "studio_id": studio_id,
            "source_intent_id": transition_intent_id,
            "reason_code": reason_code,
        })
        lease_owner = str(uuid4())
        envelope = self.operations.revoke_enrollment_transition(
            intent_id=transition_intent_id,
            studio_id=studio_id,
            actor_id=actor_id,
            expected_revision=expected_revision,
            caller_request_key=request_key,
            request_sha256=request_sha256,
            reason_code=reason_code,
            lease_owner=lease_owner,
        )
        intent = envelope["intent"]
        enrollment_id = str(intent["enrollment_id"])
        snapshot = self._snapshot(enrollment_id, studio_id, immediate=False)
        self._verify_intent_snapshot(intent, snapshot)
        if not intent.get("provider_operation_id"):
            self._audit_once(
                intent,
                studio_id=studio_id,
                actor_id=actor_id,
                action="billing.student_enrollment_cancel_schedule_revoked",
            )
            return envelope
        return self._drive_provider_operation(
            envelope,
            snapshot=snapshot,
            actor_id=actor_id,
            lease_owner=lease_owner,
            mutation="revoke",
        )

    def process_due(self, *, worker_id: str, limit: int = 25) -> dict[str, int]:
        if not 1 <= limit <= 100:
            raise HTTPException(status_code=400, detail="Due transition limit must be between 1 and 100.")
        intents = self.operations.claim_due_enrollment_transitions(
            worker_id=worker_id,
            limit=limit,
        )
        result = {"claimed": len(intents), "completed": 0, "reconciliation_required": 0, "failed": 0}
        for intent in intents:
            try:
                try:
                    snapshot = self._snapshot_for_replay(intent)
                except Exception as exc:
                    if (
                        intent.get("mutation_strategy") == "subscription_item_delete_at_period_end"
                        and not intent.get("provider_operation_id")
                    ):
                        reason = "item_due_pre_provider_identity_drift"
                        proof = stable_hash({
                            "intent_id": str(intent["id"]),
                            "reason": reason,
                            "exception_type": type(exc).__name__,
                        })
                        self.operations.mark_due_enrollment_pre_provider_reconciliation(
                            intent_id=str(intent["id"]),
                            studio_id=str(intent["studio_id"]),
                            worker_id=worker_id,
                            expected_revision=int(intent["revision"]),
                            provider_evidence_sha256=proof,
                            reconciliation_reason_code=reason,
                        )
                        result["reconciliation_required"] += 1
                        continue
                    raise
                if (
                    intent["mutation_strategy"]
                    == "subscription_item_delete_at_period_end"
                    and intent.get("provider_caller_request_key") is None
                    and intent.get("provider_request_sha256") is None
                ):
                    lock_token: str | None = None
                    try:
                        group_id = str(intent["billing_subscription_id"])
                        lock_token = self.lifecycle._claim_subscription_quantity_sync_lock(
                            str(intent["studio_id"]),
                            group_id,
                        )
                        snapshot = self._snapshot_for_replay(intent)
                        provider = self._retrieve_subscription(snapshot)
                        item_transitions = self._item_schedule_due_transition_map(
                            intent,
                            snapshot,
                            provider,
                        )
                        if item_transitions is None:
                            continue
                        provider = self._release_owned_item_schedule_after_due(
                            intent,
                            snapshot,
                            provider,
                        )
                        proof = self._provider_proof(snapshot, provider)
                        self.operations.complete_due_enrollment_item_transition(
                            intent_id=str(intent["id"]),
                            studio_id=str(intent["studio_id"]),
                            worker_id=worker_id,
                            expected_revision=int(intent["revision"]),
                            provider_evidence_sha256=proof,
                            item_transitions=item_transitions,
                        )
                        result["completed"] += 1
                    except Exception as exc:
                        proof = stable_hash({
                            "intent_id": str(intent["id"]),
                            "reason": "item_schedule_due_readback_unconfirmed",
                            "exception_type": type(exc).__name__,
                        })
                        self.operations.mark_due_enrollment_readback_reconciliation(
                            intent_id=str(intent["id"]),
                            studio_id=str(intent["studio_id"]),
                            worker_id=worker_id,
                            expected_revision=int(intent["revision"]),
                            provider_evidence_sha256=proof,
                            reconciliation_reason_code="item_schedule_due_readback_unconfirmed",
                        )
                        result["reconciliation_required"] += 1
                    finally:
                        if lock_token is not None:
                            self.lifecycle._release_subscription_quantity_sync_lock(
                                str(intent["studio_id"]),
                                str(intent["billing_subscription_id"]),
                                lock_token,
                            )
                    continue
                if intent["mutation_strategy"] == "subscription_cancel_at_period_end":
                    try:
                        provider = self._retrieve_subscription(snapshot)
                        self._verify_provider(snapshot, provider, require_cancel_at_period_end=None)
                        if self._whole_subscription_due_readback_is_pending(snapshot, provider):
                            continue
                        if str(_object_get(provider, "status") or "") != "canceled":
                            raise RuntimeError("whole_due_subscription_not_canceled")
                        self._project_whole_cancellation(snapshot, provider)
                        proof = self._provider_proof(snapshot, provider)
                        self.operations.complete_due_enrollment_transition(
                            intent_id=str(intent["id"]),
                            worker_id=worker_id,
                            expected_revision=int(intent["revision"]),
                            provider_evidence_sha256=proof,
                            provider_subscription_state="canceled",
                        )
                        result["completed"] += 1
                    except Exception as exc:
                        proof = stable_hash({
                            "intent_id": str(intent["id"]),
                            "reason": "whole_subscription_due_readback_unconfirmed",
                            "exception_type": type(exc).__name__,
                        })
                        self.operations.mark_due_enrollment_readback_reconciliation(
                            intent_id=str(intent["id"]),
                            studio_id=str(intent["studio_id"]),
                            worker_id=worker_id,
                            expected_revision=int(intent["revision"]),
                            provider_evidence_sha256=proof,
                            reconciliation_reason_code="whole_subscription_due_readback_unconfirmed",
                        )
                        result["reconciliation_required"] += 1
                    continue
                started = (
                    {"outcome": "resumed", "intent": intent}
                    if intent.get("provider_operation_id")
                    else self.operations.start_due_enrollment_transition(
                        intent_id=str(intent["id"]),
                        worker_id=worker_id,
                        expected_revision=int(intent["revision"]),
                    )
                )
                self._drive_provider_operation(
                    started,
                    snapshot=snapshot,
                    actor_id=str(intent["initiated_by"]),
                    lease_owner=worker_id,
                    mutation="execute_due",
                )
                result["completed"] += 1
            except HTTPException as exc:
                if exc.status_code == 503:
                    result["reconciliation_required"] += 1
                else:
                    result["failed"] += 1
            except Exception:
                result["failed"] += 1
        return result

    def _resume_existing(
        self,
        envelope: dict[str, Any],
        *,
        actor_id: str,
        mutation: str,
    ) -> dict[str, Any]:
        intent = envelope["intent"]
        if intent["state"] in {"completed", "revoked"} or not intent.get("provider_operation_id"):
            return envelope
        if intent["state"] == "definitive_rejected":
            raise HTTPException(status_code=409, detail=TRANSITION_REJECTED_DETAIL)
        snapshot = self._snapshot_for_replay(intent)
        return self._drive_provider_operation(
            envelope,
            snapshot=snapshot,
            actor_id=actor_id,
            lease_owner=str(uuid4()),
            mutation=mutation,
        )

    def _drive_provider_operation(
        self,
        envelope: dict[str, Any],
        *,
        snapshot: dict[str, Any],
        actor_id: str,
        lease_owner: str,
        mutation: str,
    ) -> dict[str, Any]:
        lock_token: str | None = None
        group_id = str(snapshot["group"]["id"])
        needs_quantity_lock = snapshot["mutation_strategy"].startswith(
            "subscription_item_delete_"
        ) or (
            snapshot["mutation_strategy"] == "subscription_cancel_at_period_end"
            and mutation in {"schedule", "revoke"}
        )
        if needs_quantity_lock:
            lock_token = self.lifecycle._claim_subscription_quantity_sync_lock(
                str(snapshot["enrollment"]["studio_id"]), group_id,
            )
            try:
                refreshed = self._snapshot(
                    str(snapshot["enrollment"]["id"]),
                    str(snapshot["enrollment"]["studio_id"]),
                    immediate=mutation in {"immediate", "execute_due"},
                )
                intent = envelope["intent"]
                if (
                    mutation == "immediate"
                    and _stripe_id(_object_get(refreshed["provider"], "schedule"))
                ):
                    raise HTTPException(
                        status_code=409,
                        detail="Subscription already has a provider-side schedule.",
                    )
                self._verify_intent_snapshot(intent, refreshed)
                if mutation == "execute_due":
                    self._bind_due_intent_snapshot(intent, refreshed)
                snapshot = refreshed
                return self._drive_provider_operation_locked(
                    envelope,
                    snapshot=snapshot,
                    actor_id=actor_id,
                    lease_owner=lease_owner,
                    mutation=mutation,
                )
            finally:
                self.lifecycle._release_subscription_quantity_sync_lock(
                    str(snapshot["enrollment"]["studio_id"]), group_id, lock_token,
                )
        return self._drive_provider_operation_locked(
            envelope,
            snapshot=snapshot,
            actor_id=actor_id,
            lease_owner=lease_owner,
            mutation=mutation,
        )

    def _drive_provider_operation_locked(
        self,
        envelope: dict[str, Any],
        *,
        snapshot: dict[str, Any],
        actor_id: str,
        lease_owner: str,
        mutation: str,
    ) -> dict[str, Any]:
        intent = envelope["intent"]
        snapshot["_transition_intent"] = intent
        operation = envelope.get("operation")
        if not isinstance(operation, dict):
            operation = self._read_operation(intent, lease_owner=lease_owner)
        context = self._operation_context(intent, operation, lease_owner=lease_owner)
        state = str(operation.get("state") or "")
        if state == "provider_request_in_flight":
            raise HTTPException(status_code=409, detail=TRANSITION_IN_PROGRESS_DETAIL)
        if state == "reconciliation_required":
            if not (
                mutation == "schedule"
                and snapshot["mutation_strategy"]
                == "subscription_item_delete_at_period_end"
                and self._item_schedule_step_recovery_is_authorized(
                    intent,
                    operation,
                    context,
                    snapshot,
                )
            ):
                raise HTTPException(status_code=409, detail=TRANSITION_AMBIGUOUS_DETAIL)
            operation, provider = self._drive_item_schedule_provider_plan(
                intent,
                operation,
                context,
                snapshot,
            )
            proof = self._provider_proof(snapshot, provider)
            intent = self.operations.transition_enrollment_transition(
                intent=intent,
                operation=operation,
                studio_id=context.studio_id,
                actor_id=context.actor_id,
                provider_evidence_sha256=proof,
            )["intent"]
            state = "provider_succeeded"
        if state in {"definitive_failed", "definitive_rejected"}:
            raise HTTPException(status_code=409, detail=TRANSITION_REJECTED_DETAIL)
        if state == "completed":
            if intent["state"] not in {"completed", "scheduled"}:
                intent = self.operations.transition_enrollment_transition(
                    intent=intent,
                    operation=operation,
                    studio_id=context.studio_id,
                    actor_id=context.actor_id,
                    provider_evidence_sha256=str(intent["provider_evidence_sha256"]),
                )["intent"]
            return {**envelope, "intent": intent, "operation": operation}
        recovery_outcome = operation.get("recovery_outcome")
        if state == "recovery_authorized" and (
            intent.get("state") != "recovery_authorized"
            or intent.get("recovery_outcome") != recovery_outcome
            or intent.get("recovery_proof_sha256") != operation.get("recovery_proof_sha256")
            or intent.get("recovery_actor_id") != operation.get("recovery_actor_id")
        ):
            raise HTTPException(status_code=503, detail=TRANSITION_AMBIGUOUS_DETAIL)
        retry_authorized = (
            state == "recovery_authorized"
            and recovery_outcome == "provider_no_object_safe_to_retry"
        )
        if state == "recovery_authorized" and not retry_authorized:
            if recovery_outcome != "provider_succeeded_reconcile_only":
                raise HTTPException(status_code=503, detail=TRANSITION_AMBIGUOUS_DETAIL)
            try:
                provider = self._retrieve_subscription(snapshot)
                self._verify_after_mutation(snapshot, provider, mutation=mutation)
            except Exception as exc:
                self._mark_reconciliation(
                    intent,
                    operation,
                    context,
                    "enrollment_transition_provider_readback_failed",
                    exc,
                )
            proof = self._provider_proof(snapshot, provider)
            operation = self.operations.transition(
                context,
                operation,
                "provider_succeeded",
                provider_object_id=self._expected_provider_object_id(intent),
                result_code="enrollment_transition_recovery_readback_verified",
            )
            intent = self.operations.transition_enrollment_transition(
                intent=intent,
                operation=operation,
                studio_id=context.studio_id,
                actor_id=context.actor_id,
                provider_evidence_sha256=proof,
            )["intent"]
        elif (
            state == "started"
            and mutation == "schedule"
            and snapshot["mutation_strategy"] == "subscription_item_delete_at_period_end"
        ):
            operation, provider = self._drive_item_schedule_provider_plan(
                intent,
                operation,
                context,
                snapshot,
            )
            proof = self._provider_proof(snapshot, provider)
            intent = self.operations.transition_enrollment_transition(
                intent=intent,
                operation=operation,
                studio_id=context.studio_id,
                actor_id=context.actor_id,
                provider_evidence_sha256=proof,
            )["intent"]
        elif state == "started" or retry_authorized:
            operation = self.operations.transition(
                context,
                operation,
                "provider_request_in_flight",
                result_code="enrollment_transition_started",
            )
            intent = self.operations.transition_enrollment_transition(
                intent=intent,
                operation=operation,
                studio_id=context.studio_id,
                actor_id=context.actor_id,
            )["intent"]
            try:
                before = self._retrieve_subscription(snapshot)
                self._verify_before_mutation(snapshot, before, mutation=mutation)
                self._mutate_provider(snapshot, mutation=mutation, context=context)
            except StripeMutationBlocked as exc:
                operation = self.operations.transition(
                    context,
                    operation,
                    "definitive_rejected",
                    error_code="provider_mutation_blocked",
                )
                self.operations.transition_enrollment_transition(
                    intent=intent,
                    operation=operation,
                    studio_id=context.studio_id,
                    actor_id=context.actor_id,
                )
                raise HTTPException(status_code=409, detail=TRANSITION_REJECTED_DETAIL) from exc
            except Exception as exc:
                self._mark_reconciliation(intent, operation, context, "enrollment_transition_provider_outcome_ambiguous", exc)
            try:
                provider = self._retrieve_subscription(snapshot)
                self._verify_after_mutation(snapshot, provider, mutation=mutation)
            except Exception as exc:
                self._mark_reconciliation(intent, operation, context, "enrollment_transition_provider_readback_failed", exc)
            proof = self._provider_proof(snapshot, provider)
            operation = self.operations.transition(
                context,
                operation,
                "provider_succeeded",
                provider_object_id=self._expected_provider_object_id(intent),
                result_code="enrollment_transition_provider_succeeded",
            )
            intent = self.operations.transition_enrollment_transition(
                intent=intent,
                operation=operation,
                studio_id=context.studio_id,
                actor_id=context.actor_id,
                provider_evidence_sha256=proof,
            )["intent"]
        else:
            try:
                provider = self._retrieve_subscription(snapshot)
                self._verify_after_mutation(snapshot, provider, mutation=mutation)
            except Exception as exc:
                self._mark_reconciliation(intent, operation, context, "enrollment_transition_provider_readback_failed", exc)
            proof = self._provider_proof(snapshot, provider)

        if operation["state"] == "provider_succeeded":
            try:
                self._project_local(snapshot, provider, mutation=mutation)
            except Exception as exc:
                self._mark_reconciliation(intent, operation, context, "enrollment_transition_local_projection_failed", exc)
            operation = self.operations.transition(
                context,
                operation,
                "projected",
                result_code="enrollment_transition_projected",
            )
            intent = self.operations.transition_enrollment_transition(
                intent=intent,
                operation=operation,
                studio_id=context.studio_id,
                actor_id=context.actor_id,
                provider_evidence_sha256=proof,
            )["intent"]
        if operation["state"] == "projected":
            operation = self.operations.complete(
                context,
                operation,
                result_code="enrollment_transition_completed",
            )
            intent = self.operations.transition_enrollment_transition(
                intent=intent,
                operation=operation,
                studio_id=context.studio_id,
                actor_id=context.actor_id,
                provider_evidence_sha256=proof,
            )["intent"]
        action = {
            "schedule": "billing.student_enrollment_cancel_scheduled",
            "revoke": "billing.student_enrollment_cancel_schedule_revoked",
            "immediate": "billing.student_enrollment_canceled_immediately",
            "execute_due": "billing.student_enrollment_cancel_executed",
        }[mutation]
        self._audit_once(intent, studio_id=context.studio_id, actor_id=context.actor_id, action=action)
        return {**envelope, "intent": intent, "operation": operation}

    def _drive_item_schedule_provider_plan(
        self,
        intent: dict[str, Any],
        operation: dict[str, Any],
        context: BillingProviderOperationContext,
        snapshot: dict[str, Any],
    ) -> tuple[dict[str, Any], Any]:
        plan = self._item_schedule_provider_plan(intent, context, snapshot)
        steps = plan["steps"]
        plan_sha256 = str(plan["plan_sha256"])
        client = BillingProviderStepCoordinator(self.supabase)
        registered = client.register_plan(
            context,
            operation,
            plan_sha256=plan_sha256,
            steps=steps,
        )
        operation = registered["operation"]
        create_step = self._provider_step_context(
            context,
            plan_sha256,
            1,
            steps[0],
        )
        schedule_id = self._execute_item_schedule_create_step(
            intent,
            snapshot,
            create_step,
            client,
            operation,
            plan_sha256,
        )
        update_step = self._provider_step_context(
            context,
            plan_sha256,
            2,
            steps[1],
        )
        self._execute_item_schedule_update_step(
            intent,
            snapshot,
            schedule_id,
            update_step,
            client,
            operation,
            plan_sha256,
        )
        completed = client.complete_provider_phase(
            context,
            operation,
            plan_sha256=plan_sha256,
            expected_step_count=2,
        )
        operation = completed["operation"]
        if (
            operation.get("state") != "provider_succeeded"
            or operation.get("provider_object_id")
            != intent["stripe_subscription_item_id"]
            or operation.get("provider_secondary_object_id") != schedule_id
            or operation.get("lease_owner") != context.lease_owner
        ):
            raise HTTPException(status_code=503, detail=TRANSITION_AMBIGUOUS_DETAIL)
        provider = self._retrieve_subscription(snapshot)
        self._verify_after_mutation(snapshot, provider, mutation="schedule")
        return operation, provider

    def _item_schedule_step_recovery_is_authorized(
        self,
        intent: dict[str, Any],
        operation: dict[str, Any],
        context: BillingProviderOperationContext,
        snapshot: dict[str, Any],
    ) -> bool:
        try:
            plan = self._item_schedule_provider_plan(intent, context, snapshot)
            envelope = BillingProviderStepCoordinator(self.supabase).read_plan(
                context,
                plan_sha256=str(plan["plan_sha256"]),
            )
            if (
                (envelope.get("operation") or {}).get("id") != operation.get("id")
                or (envelope.get("operation") or {}).get("state")
                != "reconciliation_required"
            ):
                return False
            steps = list(envelope.get("steps") or [])
            authorized = [
                step for step in steps if step.get("state") == "recovery_authorized"
            ]
            if len(steps) != 2 or len(authorized) != 1:
                return False
            recovered = authorized[0]
            if (
                recovered.get("recovery_outcome")
                not in {
                    "provider_no_object_safe_to_retry",
                    "provider_succeeded_reconcile_only",
                }
                or not recovered.get("recovery_actor_id")
                or not isinstance(recovered.get("recovery_proof_sha256"), str)
                or len(recovered["recovery_proof_sha256"]) != 64
                or int(recovered.get("provider_request_attempt_count") or 0) != 1
            ):
                return False
            states = [str(step.get("state") or "") for step in steps]
            return states in (
                ["recovery_authorized", "pending"],
                ["provider_succeeded", "recovery_authorized"],
            )
        except Exception:
            return False

    def _execute_item_schedule_create_step(
        self,
        intent: dict[str, Any],
        snapshot: dict[str, Any],
        step: BillingProviderOperationStepContext,
        client: BillingProviderStepCoordinator,
        operation: dict[str, Any],
        plan_sha256: str,
    ) -> str:
        envelope = client.claim_step(step)
        current = envelope["step"]
        state = str(current.get("state") or "")
        if state == "provider_succeeded":
            schedule_id = str(current.get("provider_object_id") or "")
            if schedule_id:
                return schedule_id
            raise HTTPException(status_code=503, detail=TRANSITION_AMBIGUOUS_DETAIL)
        self._raise_for_blocked_provider_step(envelope)
        recovery_retry = state == "recovery_authorized"
        recovery_outcome = str(current.get("recovery_outcome") or "")
        if recovery_retry and recovery_outcome == "provider_succeeded_reconcile_only":
            provider = self._retrieve_subscription(snapshot)
            schedule_id = _stripe_id(_object_get(provider, "schedule"))
            if not schedule_id:
                raise HTTPException(status_code=503, detail=TRANSITION_AMBIGUOUS_DETAIL)
            schedule = self.stripe_service_cls().retrieve_connected_subscription_schedule(
                account_id=step.parent.stripe_connected_account_id,
                schedule_id=schedule_id,
            )
            self._verify_new_item_schedule(intent, schedule)
            client.transition_step(
                step,
                current,
                "provider_succeeded",
                provider_object_id=schedule_id,
                result_code="enrollment_item_schedule_create_reconciled",
            )
            return schedule_id
        current = client.transition_step(
            step,
            current,
            "provider_request_in_flight",
            result_code="enrollment_item_schedule_create_started",
        )
        try:
            provider = self._retrieve_subscription(snapshot)
            snapshot["provider"] = provider
            attached_schedule_id = _stripe_id(_object_get(provider, "schedule"))
            if attached_schedule_id and not recovery_retry:
                raise RuntimeError("enrollment_item_schedule_preexisting_schedule")
            schedule = self.stripe_service_cls().create_connected_subscription_schedule(
                account_id=step.parent.stripe_connected_account_id,
                studio_id=step.parent.studio_id,
                subscription_id=str(intent["stripe_subscription_id"]),
                idempotency_key=step.stripe_idempotency_key,
            )
            schedule_id = _stripe_id(schedule)
            self._verify_new_item_schedule(intent, schedule)
            if not schedule_id or (
                attached_schedule_id and schedule_id != attached_schedule_id
            ):
                raise RuntimeError("enrollment_item_schedule_create_identity_missing")
        except StripeMutationBlocked as exc:
            self._reject_provider_step(
                intent,
                step,
                current,
                client,
                operation,
                plan_sha256,
                exc,
            )
        except Exception as exc:
            self._reconcile_provider_step(
                intent,
                step,
                current,
                client,
                operation,
                plan_sha256,
                "enrollment_item_schedule_create_outcome_ambiguous",
                exc,
            )
        client.transition_step(
            step,
            current,
            "provider_succeeded",
            provider_object_id=schedule_id,
            result_code="enrollment_item_schedule_created",
        )
        return schedule_id

    def _execute_item_schedule_update_step(
        self,
        intent: dict[str, Any],
        snapshot: dict[str, Any],
        schedule_id: str,
        step: BillingProviderOperationStepContext,
        client: BillingProviderStepCoordinator,
        operation: dict[str, Any],
        plan_sha256: str,
    ) -> None:
        envelope = client.claim_step(step)
        current = envelope["step"]
        state = str(current.get("state") or "")
        if state == "provider_succeeded":
            if (
                current.get("provider_object_id")
                != intent["stripe_subscription_item_id"]
                or current.get("provider_secondary_object_id") != schedule_id
            ):
                raise HTTPException(status_code=503, detail=TRANSITION_AMBIGUOUS_DETAIL)
            schedule = self.stripe_service_cls().retrieve_connected_subscription_schedule(
                account_id=step.parent.stripe_connected_account_id,
                schedule_id=schedule_id,
            )
            self._verify_item_schedule_transition(intent, snapshot, schedule)
            snapshot["_verified_schedule"] = schedule
            return
        self._raise_for_blocked_provider_step(envelope)
        if (
            state == "recovery_authorized"
            and current.get("recovery_outcome") == "provider_succeeded_reconcile_only"
        ):
            schedule = self.stripe_service_cls().retrieve_connected_subscription_schedule(
                account_id=step.parent.stripe_connected_account_id,
                schedule_id=schedule_id,
            )
            self._verify_item_schedule_transition(intent, snapshot, schedule)
            snapshot["_verified_schedule"] = schedule
            client.transition_step(
                step,
                current,
                "provider_succeeded",
                provider_object_id=str(intent["stripe_subscription_item_id"]),
                provider_secondary_object_id=schedule_id,
                result_code="enrollment_item_schedule_update_reconciled",
            )
            return
        current = client.transition_step(
            step,
            current,
            "provider_request_in_flight",
            result_code="enrollment_item_schedule_update_started",
        )
        try:
            schedule = self.stripe_service_cls().retrieve_connected_subscription_schedule(
                account_id=step.parent.stripe_connected_account_id,
                schedule_id=schedule_id,
            )
            self._verify_new_item_schedule(intent, schedule)
            phases = self._item_schedule_phases(snapshot, schedule)
            schedule = self.stripe_service_cls().update_connected_subscription_schedule(
                account_id=step.parent.stripe_connected_account_id,
                studio_id=step.parent.studio_id,
                schedule_id=schedule_id,
                metadata=self._item_schedule_metadata(intent),
                phases=phases,
                idempotency_key=step.stripe_idempotency_key,
            )
            self._verify_item_schedule_transition(
                intent,
                snapshot,
                schedule,
                expected_phases=phases,
            )
        except StripeMutationBlocked as exc:
            self._reject_provider_step(
                intent,
                step,
                current,
                client,
                operation,
                plan_sha256,
                exc,
            )
        except Exception as exc:
            self._reconcile_provider_step(
                intent,
                step,
                current,
                client,
                operation,
                plan_sha256,
                "enrollment_item_schedule_update_outcome_ambiguous",
                exc,
            )
        snapshot["_verified_schedule"] = schedule
        client.transition_step(
            step,
            current,
            "provider_succeeded",
            provider_object_id=str(intent["stripe_subscription_item_id"]),
            provider_secondary_object_id=schedule_id,
            result_code="enrollment_item_schedule_updated",
        )

    def _reconcile_provider_step(
        self,
        intent: dict[str, Any],
        step: BillingProviderOperationStepContext,
        current: dict[str, Any],
        client: BillingProviderStepCoordinator,
        operation: dict[str, Any],
        plan_sha256: str,
        reason: str,
        exc: Exception,
    ) -> None:
        client.transition_step(
            step,
            current,
            "reconciliation_required",
            reconciliation_reason_code=reason,
        )
        parent = self.operations.read(step.parent)["operation"]
        if parent.get("state") != "reconciliation_required":
            completed = client.complete_provider_phase(
                step.parent,
                parent,
                plan_sha256=plan_sha256,
                expected_step_count=2,
            )
            parent = completed["operation"]
        proof = stable_hash({
            "operation_id": step.parent.operation_id,
            "step_name": step.step_name,
            "reason": reason,
            "exception_type": type(exc).__name__,
        })
        try:
            self.operations.transition_enrollment_transition(
                intent=intent,
                operation=parent,
                studio_id=step.parent.studio_id,
                actor_id=step.parent.actor_id,
                provider_evidence_sha256=proof,
                reconciliation_reason_code="provider_step_phase_incomplete",
            )
        except Exception:
            pass
        raise HTTPException(status_code=503, detail=TRANSITION_AMBIGUOUS_DETAIL) from exc

    def _reject_provider_step(
        self,
        intent: dict[str, Any],
        step: BillingProviderOperationStepContext,
        current: dict[str, Any],
        client: BillingProviderStepCoordinator,
        operation: dict[str, Any],
        plan_sha256: str,
        exc: StripeMutationBlocked,
    ) -> None:
        partial_provider_success = step.step_order > 1
        client.transition_step(
            step,
            current,
            "reconciliation_required" if partial_provider_success else "definitive_rejected",
            error_code="provider_mutation_blocked",
            reconciliation_reason_code=(
                "provider_mutation_blocked_after_partial_provider_success"
                if partial_provider_success
                else None
            ),
        )
        parent = self.operations.read(step.parent)["operation"]
        if not partial_provider_success:
            parent = self.operations.transition(
                step.parent,
                parent,
                "definitive_rejected",
                error_code="provider_mutation_blocked",
            )
            self.operations.transition_enrollment_transition(
                intent=intent,
                operation=parent,
                studio_id=step.parent.studio_id,
                actor_id=step.parent.actor_id,
            )
            raise HTTPException(
                status_code=409,
                detail=TRANSITION_REJECTED_DETAIL,
            ) from exc
        if parent.get("state") != "reconciliation_required":
            completed = client.complete_provider_phase(
                step.parent,
                parent,
                plan_sha256=plan_sha256,
                expected_step_count=2,
            )
            parent = completed["operation"]
        proof = stable_hash({
            "operation_id": step.parent.operation_id,
            "step_name": step.step_name,
            "reason": (
                "provider_mutation_blocked_after_partial_provider_success"
                if partial_provider_success
                else "provider_mutation_blocked"
            ),
        })
        try:
            self.operations.transition_enrollment_transition(
                intent=intent,
                operation=parent,
                studio_id=step.parent.studio_id,
                actor_id=step.parent.actor_id,
                provider_evidence_sha256=proof,
                reconciliation_reason_code="provider_step_phase_incomplete",
            )
        except Exception:
            pass
        raise HTTPException(status_code=503, detail=TRANSITION_AMBIGUOUS_DETAIL) from exc

    @staticmethod
    def _raise_for_blocked_provider_step(envelope: dict[str, Any]) -> None:
        state = str((envelope.get("step") or {}).get("state") or "")
        if state == "provider_request_in_flight":
            raise HTTPException(status_code=409, detail=TRANSITION_IN_PROGRESS_DETAIL)
        if state == "reconciliation_required":
            raise HTTPException(status_code=409, detail=TRANSITION_AMBIGUOUS_DETAIL)
        if state in {"definitive_failed", "definitive_rejected"}:
            raise HTTPException(status_code=409, detail=TRANSITION_REJECTED_DETAIL)

    @staticmethod
    def _provider_step_context(
        parent: BillingProviderOperationContext,
        plan_sha256: str,
        step_order: int,
        step: dict[str, str],
    ) -> BillingProviderOperationStepContext:
        return BillingProviderOperationStepContext(
            parent=parent,
            plan_sha256=plan_sha256,
            step_order=step_order,
            step_name=step["step_name"],
            provider_operation=step["provider_operation"],
            step_request_sha256=step["request_sha256"],
            stripe_idempotency_key=step["stripe_idempotency_key"],
        )

    def _item_schedule_provider_plan(
        self,
        intent: dict[str, Any],
        context: BillingProviderOperationContext,
        snapshot: dict[str, Any],
    ) -> dict[str, Any]:
        create_key = self.owner._idempotency_key(
            "enrollment-transition",
            context.operation_id,
            "step-1-schedule-create",
        )
        update_key = self.owner._idempotency_key(
            "enrollment-transition",
            context.operation_id,
            "step-2-schedule-update",
        )
        steps = [
            {
                "step_name": "schedule_create",
                "provider_operation": "connected_subscription_schedule.create",
                "request_sha256": stable_hash({
                    "provider_operation": "connected_subscription_schedule.create",
                    "from_subscription": intent["stripe_subscription_id"],
                    "account_id": context.stripe_connected_account_id,
                    "generation": context.connect_account_generation,
                }),
                "stripe_idempotency_key": create_key,
            },
            {
                "step_name": "schedule_update",
                "provider_operation": "connected_subscription_schedule.update",
                "request_sha256": stable_hash({
                    "provider_operation": "connected_subscription_schedule.update",
                    "schedule_source": "step:schedule_create",
                    "subscription_id": intent["stripe_subscription_id"],
                    "subscription_item_id": intent["stripe_subscription_item_id"],
                    "period_boundary": intent["period_boundary"],
                    "provider_quantity": intent["provider_quantity"],
                    "expected_quantity": intent["expected_quantity"],
                    "expected_subscription_item_count": intent[
                        "expected_subscription_item_count"
                    ],
                    "metadata": self._item_schedule_metadata(intent),
                    "account_id": context.stripe_connected_account_id,
                    "generation": context.connect_account_generation,
                }),
                "stripe_idempotency_key": update_key,
            },
        ]
        return {
            "steps": steps,
            "plan_sha256": billing_provider_step_plan_sha256(steps),
        }

    @staticmethod
    def _item_schedule_metadata(intent: dict[str, Any]) -> dict[str, str]:
        return {
            "koaryu_workflow": ITEM_SCHEDULE_METADATA_WORKFLOW,
            "koaryu_transition_intent_id": str(
                intent.get("source_intent_id") or intent["id"]
            ),
            "studio_id": str(intent["studio_id"]),
            "billing_subscription_id": str(intent["billing_subscription_id"]),
            "connect_account_generation": str(intent["connect_account_generation"]),
        }

    @staticmethod
    def _schedule_phases(schedule: Any) -> list[Any]:
        phases = _object_get(schedule, "phases") or []
        if isinstance(phases, (list, tuple)):
            return list(phases)
        return list(_object_get(phases, "data", []) or [])

    @staticmethod
    def _phase_item_signature(items: list[Any]) -> dict[str, dict[str, Any]]:
        signature: dict[str, dict[str, Any]] = {}
        for item in items:
            price_id = _stripe_id(_object_get(item, "price"))
            quantity = int(_object_get(item, "quantity", 0) or 0)
            if not price_id or quantity <= 0 or price_id in signature:
                raise RuntimeError("enrollment_item_schedule_phase_items_invalid")
            metadata = _object_get(item, "metadata") or {}
            if not isinstance(metadata, dict):
                raise RuntimeError("enrollment_item_schedule_item_metadata_invalid")
            signature[price_id] = {
                "quantity": quantity,
                "metadata": {
                    str(key): str(value) for key, value in metadata.items()
                },
            }
        return signature

    def _provider_item_phase_payloads(
        self,
        snapshot: dict[str, Any],
        *,
        future: bool,
    ) -> list[dict[str, Any]]:
        provider = snapshot["provider"]
        target_id = str(snapshot["enrollment"]["stripe_subscription_item_id"])
        payloads: list[dict[str, Any]] = []
        for item in list(
            _object_get(_object_get(provider, "items") or {}, "data", []) or []
        ):
            item_id = _stripe_id(item)
            price_id = _stripe_id(_object_get(item, "price"))
            quantity = int(_object_get(item, "quantity", 0) or 0)
            if not item_id or not price_id or quantity <= 0:
                raise RuntimeError("enrollment_item_schedule_provider_items_invalid")
            if _object_get(item, "discounts") or _object_get(item, "tax_rates"):
                raise RuntimeError("enrollment_item_schedule_item_adjustments_unsupported")
            if _object_get(item, "billing_thresholds"):
                raise RuntimeError("enrollment_item_schedule_item_thresholds_unsupported")
            if future and item_id == target_id:
                quantity = int(snapshot["expected_quantity"])
                if quantity == 0:
                    continue
            payload: dict[str, Any] = {"price": price_id, "quantity": quantity}
            metadata = _object_get(item, "metadata")
            if isinstance(metadata, dict) and metadata:
                phase_metadata = {
                    str(key): str(value) for key, value in metadata.items()
                }
                if future:
                    # A shared provider item can represent multiple local rows.
                    # Carrying one row's identity into the replacement phase lets
                    # a webhook rotate only that row before the due CAS owns the
                    # whole family.
                    phase_metadata.pop("enrollment_id", None)
                    phase_metadata.pop("student_id", None)
                payload["metadata"] = phase_metadata
            payloads.append(payload)
        if not payloads:
            raise RuntimeError("enrollment_item_schedule_future_phase_empty")
        self._phase_item_signature(payloads)
        return payloads

    def _item_schedule_phases(
        self,
        snapshot: dict[str, Any],
        schedule: Any,
    ) -> list[dict[str, Any]]:
        current_phase = _object_get(schedule, "current_phase") or {}
        start_date = epoch_seconds(_object_get(current_phase, "start_date"))
        end_date = epoch_seconds(_object_get(current_phase, "end_date"))
        boundary = epoch_seconds(snapshot["period_boundary"])
        if (
            start_date is None
            or end_date is None
            or boundary is None
            or end_date != boundary
            or start_date >= boundary
        ):
            raise RuntimeError("enrollment_item_schedule_phase_boundary_mismatch")
        if len(self._schedule_phases(schedule)) != 1:
            raise RuntimeError("enrollment_item_schedule_phase_count_mismatch")
        phase = self._schedule_phases(schedule)[0]
        default_settings = _object_get(schedule, "default_settings") or {}
        current_settings = self._supported_phase_settings(
            phase,
            include_trial_end=True,
            defaults=default_settings,
        )
        future_settings = self._supported_phase_settings(
            phase,
            include_trial_end=False,
            defaults=default_settings,
        )
        return [
            {
                **current_settings,
                "start_date": start_date,
                "end_date": boundary,
                "items": self._provider_item_phase_payloads(snapshot, future=False),
                "proration_behavior": "none",
            },
            {
                **future_settings,
                "start_date": boundary,
                "iterations": 1,
                "items": self._provider_item_phase_payloads(snapshot, future=True),
                "proration_behavior": "none",
            },
        ]

    @staticmethod
    def _supported_phase_settings(
        phase: Any,
        *,
        include_trial_end: bool,
        defaults: Any | None = None,
        subscription_source: bool = False,
    ) -> dict[str, Any]:
        defaults = defaults or {}

        def effective(field: str) -> Any:
            value = _object_get(phase, field)
            return _object_get(defaults, field) if value is None else value

        unsupported = (
            "add_invoice_items",
            "billing_thresholds",
            "coupon",
            "default_tax_rates",
            "description",
            "discounts",
            "on_behalf_of",
            "transfer_data",
        )
        if any(effective(field) for field in unsupported):
            raise RuntimeError("enrollment_item_schedule_phase_settings_unsupported")
        automatic_tax = effective("automatic_tax") or {}
        if bool(_object_get(automatic_tax, "enabled")) or _object_get(
            automatic_tax,
            "liability",
        ):
            raise RuntimeError("enrollment_item_schedule_automatic_tax_unsupported")
        raw_invoice_settings = _object_get(phase, "invoice_settings")
        invoice_settings = (
            _object_get(defaults, "invoice_settings") or {}
            if raw_invoice_settings is None
            else raw_invoice_settings
        )
        issuer = _object_get(invoice_settings, "issuer") or {}
        issuer_type = _object_get(issuer, "type")
        if _object_get(invoice_settings, "account_tax_ids") or (
            issuer_type is not None and issuer_type != "self"
        ):
            raise RuntimeError("enrollment_item_schedule_invoice_settings_unsupported")
        if bool(_object_get(phase, "trial")):
            raise RuntimeError("enrollment_item_schedule_trial_phase_unsupported")
        payload: dict[str, Any] = {}
        collection_method = effective("collection_method")
        if collection_method is not None:
            if collection_method not in {"charge_automatically", "send_invoice"}:
                raise RuntimeError("enrollment_item_schedule_collection_method_invalid")
            payload["collection_method"] = collection_method
        for field in ("application_fee_percent", "currency"):
            value = effective(field)
            if value is not None:
                payload[field] = value
        default_payment_method = _stripe_id(
            effective("default_payment_method")
        )
        if default_payment_method:
            payload["default_payment_method"] = default_payment_method
        billing_cycle_anchor = effective("billing_cycle_anchor")
        if billing_cycle_anchor is not None and not subscription_source:
            if billing_cycle_anchor not in {"automatic", "phase_start"}:
                raise RuntimeError(
                    "enrollment_item_schedule_billing_cycle_anchor_invalid"
                )
            payload["billing_cycle_anchor"] = billing_cycle_anchor
        metadata = _object_get(phase, "metadata")
        if metadata:
            if not isinstance(metadata, dict):
                raise RuntimeError("enrollment_item_schedule_phase_metadata_invalid")
            payload["metadata"] = {
                str(key): str(value) for key, value in metadata.items()
            }
        days_until_due = _object_get(invoice_settings, "days_until_due")
        if days_until_due is None:
            # Subscription exposes this at top level; Schedule Phase exposes it
            # under invoice_settings. Normalize both into the phase payload.
            days_until_due = _object_get(phase, "days_until_due")
        if days_until_due is not None:
            payload["invoice_settings"] = {"days_until_due": int(days_until_due)}
        if include_trial_end:
            trial_end = epoch_seconds(_object_get(phase, "trial_end"))
            if trial_end is not None:
                payload["trial_end"] = int(trial_end)
        return payload

    def _verify_new_item_schedule(
        self,
        intent: dict[str, Any],
        schedule: Any,
    ) -> None:
        phases = self._schedule_phases(schedule)
        if (
            not _stripe_id(schedule)
            or _stripe_id(_object_get(schedule, "subscription"))
            != intent["stripe_subscription_id"]
            or str(_object_get(schedule, "status") or "") != "active"
            or len(phases) != 1
        ):
            raise RuntimeError("enrollment_item_schedule_create_identity_mismatch")

    def _verify_item_schedule_owner(
        self,
        intent: dict[str, Any],
        schedule: Any,
    ) -> None:
        metadata = _object_get(schedule, "metadata") or {}
        subscription_id = _stripe_id(_object_get(schedule, "subscription")) or _stripe_id(
            _object_get(schedule, "released_subscription")
        )
        if (
            subscription_id != intent["stripe_subscription_id"]
            or any(
                str(metadata.get(key) or "") != value
                for key, value in self._item_schedule_metadata(intent).items()
            )
        ):
            raise RuntimeError("enrollment_item_schedule_owner_mismatch")

    def _verify_item_schedule_transition(
        self,
        intent: dict[str, Any],
        snapshot: dict[str, Any],
        schedule: Any,
        *,
        expected_phases: list[dict[str, Any]] | None = None,
    ) -> None:
        self._verify_item_schedule_owner(intent, schedule)
        phases = self._schedule_phases(schedule)
        boundary = epoch_seconds(snapshot["period_boundary"])
        current_phase = _object_get(schedule, "current_phase") or {}
        default_settings = _object_get(schedule, "default_settings") or {}
        provider = snapshot.get("provider") or {}
        if expected_phases is not None:
            if len(expected_phases) != 2:
                raise RuntimeError("enrollment_item_schedule_expected_phase_count_invalid")
            expected_current_settings = self._supported_phase_settings(
                expected_phases[0],
                include_trial_end=True,
            )
            expected_future_settings = self._supported_phase_settings(
                expected_phases[1],
                include_trial_end=False,
            )
        else:
            expected_current_settings = self._supported_phase_settings(
                provider,
                include_trial_end=True,
                subscription_source=True,
            )
            expected_future_settings = self._supported_phase_settings(
                provider,
                include_trial_end=False,
                subscription_source=True,
            )
        actual_current_settings = self._supported_phase_settings(
            phases[0],
            include_trial_end=True,
            defaults=default_settings,
        )
        actual_future_settings = self._supported_phase_settings(
            phases[1],
            include_trial_end=False,
            defaults=default_settings,
        )
        if expected_phases is None:
            actual_current_settings.pop("billing_cycle_anchor", None)
            actual_future_settings.pop("billing_cycle_anchor", None)
        if (
            len(phases) != 2
            or boundary is None
            or epoch_seconds(_object_get(current_phase, "end_date")) != boundary
            or epoch_seconds(_object_get(phases[0], "end_date")) != boundary
            or epoch_seconds(_object_get(phases[1], "start_date")) != boundary
            or str(_object_get(schedule, "end_behavior") or "") != "release"
            or str(_object_get(phases[1], "proration_behavior") or "") != "none"
            or actual_current_settings != expected_current_settings
            or actual_future_settings != expected_future_settings
            or self._phase_item_signature(
                list(_object_get(phases[0], "items") or [])
            )
            != self._phase_item_signature(
                self._provider_item_phase_payloads(snapshot, future=False)
            )
            or self._phase_item_signature(
                list(_object_get(phases[1], "items") or [])
            )
            != self._phase_item_signature(
                self._provider_item_phase_payloads(snapshot, future=True)
            )
        ):
            raise RuntimeError("enrollment_item_schedule_transition_mismatch")

    def _item_schedule_due_transition_map(
        self,
        intent: dict[str, Any],
        snapshot: dict[str, Any],
        provider: Any,
    ) -> list[dict[str, Any]] | None:
        metadata = _object_get(provider, "metadata") or {}
        if (
            _stripe_id(provider) != intent["stripe_subscription_id"]
            or _stripe_id(_object_get(provider, "customer"))
            != snapshot["payer"].get("stripe_customer_id")
            or str(metadata.get("studio_id") or "") != str(intent["studio_id"])
            or str(metadata.get("payer_id") or "") != str(intent["payer_id"])
            or str(metadata.get("billing_subscription_id") or "")
            != str(intent["billing_subscription_id"])
            or bool(_object_get(provider, "cancel_at_period_end"))
        ):
            raise RuntimeError("enrollment_item_schedule_due_identity_mismatch")

        local_result = (
            self.supabase.table("student_billing_enrollments")
            .select("id,billing_plan_id,stripe_subscription_item_id,status,metadata")
            .eq("studio_id", intent["studio_id"])
            .eq("billing_subscription_id", intent["billing_subscription_id"])
            .in_("status", ["pending", "active"])
            .execute()
        )
        local_rows = [
            row
            for row in (local_result.data or [])
            if not (row.get("metadata") or {}).get("stripe_detach_pending")
        ]
        families: dict[str, dict[str, Any]] = {}
        for row in local_rows:
            old_item_id = str(row.get("stripe_subscription_item_id") or "")
            plan_id = str(row.get("billing_plan_id") or "")
            if not old_item_id or not plan_id:
                raise RuntimeError("enrollment_item_schedule_local_family_invalid")
            family = families.setdefault(
                old_item_id,
                {"plan_id": plan_id, "count": 0, "row_ids": []},
            )
            if family["plan_id"] != plan_id:
                raise RuntimeError("enrollment_item_schedule_local_family_ambiguous")
            family["count"] += 1
            family["row_ids"].append(str(row["id"]))

        target_old_item_id = str(intent["stripe_subscription_item_id"])
        target_family = families.get(target_old_item_id)
        if (
            len(families) != int(intent["expected_subscription_item_count"])
            or not target_family
            or int(target_family["count"]) != int(intent["same_item_active_count"])
            or str(intent["enrollment_id"]) not in target_family["row_ids"]
            or int(intent["expected_quantity"])
            != int(intent["same_item_active_count"]) - 1
        ):
            raise RuntimeError("enrollment_item_schedule_local_family_drift")

        provider_items = list(
            _object_get(_object_get(provider, "items") or {}, "data", []) or []
        )
        provider_by_plan: dict[str, Any] = {}
        provider_by_id: dict[str, Any] = {}
        for item in provider_items:
            item_id = _stripe_id(item)
            item_metadata = _object_get(item, "metadata") or {}
            plan_id = str(item_metadata.get("billing_plan_id") or "")
            if (
                not item_id
                or not plan_id
                or plan_id in provider_by_plan
                or item_id in provider_by_id
                or str(item_metadata.get("studio_id") or "")
                != str(intent["studio_id"])
                or str(item_metadata.get("payer_id") or "")
                != str(intent["payer_id"])
                or str(item_metadata.get("billing_subscription_id") or "")
                != str(intent["billing_subscription_id"])
                or item_metadata.get("product") != "koaryu_payments"
            ):
                raise RuntimeError("enrollment_item_schedule_provider_family_ambiguous")
            provider_by_plan[plan_id] = item
            provider_by_id[item_id] = item

        plans: dict[str, dict[str, Any]] = {}
        for family in families.values():
            plan_id = str(family["plan_id"])
            plan = self.owner._get_row_or_404(
                "billing_plans",
                plan_id,
                str(intent["studio_id"]),
                "Billing plan not found.",
            )
            if (
                not plan.get("stripe_price_id")
                or plan.get("stripe_account_id")
                != intent["stripe_connected_account_id"]
            ):
                raise RuntimeError("enrollment_item_schedule_plan_identity_drift")
            plans[plan_id] = plan

        pre_transition = (
            len(provider_items) == len(families)
            and all(
                (
                    (item := provider_by_id.get(old_item_id)) is not None
                    and _stripe_id(_object_get(item, "price"))
                    == plans[str(family["plan_id"])]["stripe_price_id"]
                    and int(_object_get(item, "quantity", 0) or 0)
                    == int(family["count"])
                )
                for old_item_id, family in families.items()
            )
        )
        boundary = epoch_seconds(intent["period_boundary"])
        if boundary is None:
            raise RuntimeError("enrollment_item_schedule_due_boundary_missing")
        grace_end = boundary + WHOLE_SUBSCRIPTION_PERIOD_END_GRACE.total_seconds()
        if pre_transition:
            if boundary <= self._clock().timestamp() <= grace_end:
                return None
            raise RuntimeError("enrollment_item_schedule_due_transition_late")

        transitions: list[dict[str, Any]] = []
        for old_item_id in sorted(families):
            family = families[old_item_id]
            plan_id = str(family["plan_id"])
            expected_active_count = int(family["count"])
            if old_item_id == target_old_item_id:
                expected_active_count = int(intent["expected_quantity"])
            provider_item = provider_by_plan.get(plan_id)
            if expected_active_count == 0:
                if provider_item is not None:
                    raise RuntimeError("enrollment_item_schedule_removed_family_present")
                replacement_item_id = None
            else:
                if (
                    provider_item is None
                    or _stripe_id(_object_get(provider_item, "price"))
                    != plans[plan_id]["stripe_price_id"]
                    or int(_object_get(provider_item, "quantity", 0) or 0)
                    != expected_active_count
                ):
                    raise RuntimeError("enrollment_item_schedule_provider_family_drift")
                replacement_item_id = _stripe_id(provider_item)
            transitions.append({
                "old_item_id": old_item_id,
                "new_item_id": replacement_item_id,
                "expected_active_count": expected_active_count,
            })

        expected_provider_count = sum(
            1 for transition in transitions if transition["new_item_id"] is not None
        )
        if len(provider_items) != expected_provider_count:
            raise RuntimeError("enrollment_item_schedule_provider_item_count_drift")
        return transitions

    def _release_owned_item_schedule_after_due(
        self,
        intent: dict[str, Any],
        snapshot: dict[str, Any],
        provider: Any,
    ) -> Any:
        schedule_identity = self._canonical_item_schedule_identity(intent)
        canonical_schedule_id = schedule_identity["schedule_id"]
        schedule_id = _stripe_id(_object_get(provider, "schedule"))
        if not schedule_id:
            released = self._retrieve_released_item_schedule(
                intent,
                snapshot,
                expected_schedule_id=canonical_schedule_id,
            )
            self._verify_item_schedule_owner(intent, released)
            if str(_object_get(released, "status") or "") != "released":
                raise RuntimeError("enrollment_item_schedule_due_release_unconfirmed")
            snapshot["_released_schedule"] = released
            return provider

        if schedule_id != canonical_schedule_id:
            raise RuntimeError("enrollment_item_schedule_due_identity_mismatch")

        schedule = self.stripe_service_cls().retrieve_connected_subscription_schedule(
            account_id=snapshot["account_id"],
            schedule_id=schedule_id,
        )
        self._verify_item_schedule_due_phase(intent, snapshot, provider, schedule)
        key = self.owner._idempotency_key(
            "enrollment-transition",
            str(intent["source_intent_id"]),
            "boundary-schedule-release",
        )
        release_error: Exception | None = None
        try:
            released = self.stripe_service_cls().release_connected_subscription_schedule(
                account_id=snapshot["account_id"],
                studio_id=str(intent["studio_id"]),
                schedule_id=schedule_id,
                idempotency_key=key,
            )
        except Exception as exc:
            release_error = exc
            released = None

        refreshed = self._retrieve_subscription(snapshot)
        if _stripe_id(_object_get(refreshed, "schedule")):
            if release_error is not None:
                raise release_error
            raise RuntimeError("enrollment_item_schedule_due_release_unconfirmed")
        if released is None:
            released = self._retrieve_released_item_schedule(
                intent,
                snapshot,
                expected_schedule_id=canonical_schedule_id,
            )
        self._verify_item_schedule_owner(intent, released)
        if (
            _stripe_id(released) != schedule_id
            or str(_object_get(released, "status") or "") != "released"
        ):
            raise RuntimeError("enrollment_item_schedule_due_release_unconfirmed")
        snapshot["_released_schedule"] = released
        return refreshed

    def _verify_item_schedule_due_phase(
        self,
        intent: dict[str, Any],
        snapshot: dict[str, Any],
        provider: Any,
        schedule: Any,
    ) -> None:
        self._verify_item_schedule_owner(intent, schedule)
        boundary = epoch_seconds(intent["period_boundary"])
        phases = self._schedule_phases(schedule)
        due_phases = [
            phase
            for phase in phases
            if epoch_seconds(_object_get(phase, "start_date")) == boundary
        ]
        current_phase = _object_get(schedule, "current_phase") or {}
        provider_items = list(
            _object_get(_object_get(provider, "items") or {}, "data", []) or []
        )
        if (
            boundary is None
            or len(due_phases) != 1
            or str(_object_get(schedule, "status") or "") != "active"
            or str(_object_get(schedule, "end_behavior") or "") != "release"
            or epoch_seconds(_object_get(current_phase, "start_date")) != boundary
            or self._phase_item_signature(
                list(_object_get(due_phases[0], "items") or [])
            )
            != self._phase_item_signature(provider_items)
        ):
            raise RuntimeError("enrollment_item_schedule_due_phase_mismatch")

    def _verify_item_schedule_revoke_before(
        self,
        snapshot: dict[str, Any],
        provider: Any,
    ) -> None:
        intent = snapshot.get("_transition_intent")
        if not isinstance(intent, dict):
            raise RuntimeError("enrollment_item_schedule_intent_missing")
        self._verify_provider(
            snapshot,
            provider,
            require_cancel_at_period_end=False,
        )
        schedule_identity = self._canonical_item_schedule_identity(intent)
        canonical_schedule_id = schedule_identity["schedule_id"]
        snapshot["_canonical_schedule_id"] = canonical_schedule_id
        schedule_id = _stripe_id(_object_get(provider, "schedule"))
        if schedule_id:
            if schedule_id != canonical_schedule_id:
                raise RuntimeError("enrollment_item_schedule_owner_mismatch")
            schedule = self.stripe_service_cls().retrieve_connected_subscription_schedule(
                account_id=snapshot["account_id"],
                schedule_id=schedule_id,
            )
            self._verify_item_schedule_transition(intent, snapshot, schedule)
            snapshot["_attached_schedule_id"] = schedule_id
            return
        released = self._retrieve_released_item_schedule(
            intent,
            snapshot,
            expected_schedule_id=canonical_schedule_id,
        )
        self._verify_item_schedule_owner(intent, released)
        if str(_object_get(released, "status") or "") != "released":
            raise RuntimeError("enrollment_item_schedule_release_state_mismatch")
        snapshot["_released_schedule"] = released

    def _retrieve_released_item_schedule(
        self,
        intent: dict[str, Any],
        snapshot: dict[str, Any],
        *,
        expected_schedule_id: str,
    ) -> Any:
        schedule = self.stripe_service_cls().retrieve_connected_subscription_schedule(
            account_id=snapshot["account_id"],
            schedule_id=expected_schedule_id,
        )
        self._verify_item_schedule_owner(intent, schedule)
        if (
            _stripe_id(schedule) != expected_schedule_id
            or str(_object_get(schedule, "status") or "") != "released"
            or _stripe_id(_object_get(schedule, "released_subscription"))
            != intent["stripe_subscription_id"]
        ):
            raise RuntimeError("enrollment_item_schedule_release_identity_ambiguous")
        return schedule

    def _canonical_item_schedule_identity(
        self,
        intent: dict[str, Any],
    ) -> dict[str, str]:
        identity = self.operations.read_enrollment_item_schedule_identity(
            intent_id=str(intent["id"]),
            studio_id=str(intent["studio_id"]),
        )
        expected_source_id = str(
            intent["id"]
            if intent.get("transition_kind") == "schedule_period_end"
            else intent.get("source_intent_id") or ""
        )
        if (
            set(identity) != {
                "source_intent_id",
                "provider_operation_id",
                "schedule_id",
            }
            or str(identity.get("source_intent_id") or "") != expected_source_id
            or not str(identity.get("provider_operation_id") or "")
            or not str(identity.get("schedule_id") or "").startswith("sub_sched_")
        ):
            raise RuntimeError("enrollment_item_schedule_durable_identity_mismatch")
        return {
            "source_intent_id": expected_source_id,
            "provider_operation_id": str(identity["provider_operation_id"]),
            "schedule_id": str(identity["schedule_id"]),
        }

    def _whole_subscription_due_readback_is_pending(
        self,
        snapshot: dict[str, Any],
        provider: Any,
    ) -> bool:
        if (
            str(_object_get(provider, "status") or "")
            not in PERIOD_END_SCHEDULABLE_PROVIDER_STATUSES
            or not bool(_object_get(provider, "cancel_at_period_end"))
        ):
            return False
        boundary_epoch = epoch_seconds(snapshot.get("period_boundary"))
        if boundary_epoch is None:
            return False
        now_epoch = self._clock().timestamp()
        grace_ends_at = boundary_epoch + WHOLE_SUBSCRIPTION_PERIOD_END_GRACE.total_seconds()
        return boundary_epoch <= now_epoch <= grace_ends_at

    def _snapshot(self, enrollment_id: str, studio_id: str, *, immediate: bool) -> dict[str, Any]:
        enrollment = self.owner._get_row_or_404(
            "student_billing_enrollments", enrollment_id, studio_id, "Billing enrollment not found."
        )
        if enrollment.get("status") not in {"pending", "active"}:
            raise HTTPException(status_code=409, detail="Enrollment is not eligible for cancellation.")
        if enrollment.get("collection_mode") not in {"autopay", "invoice_link"}:
            raise HTTPException(status_code=409, detail="External enrollment cancellation is local-only.")
        if not enrollment.get("payer_id") or not enrollment.get("billing_subscription_id"):
            raise HTTPException(status_code=409, detail="Enrollment provider identity is incomplete.")
        plan = self.owner._get_row_or_404(
            "billing_plans", enrollment["billing_plan_id"], studio_id, "Billing plan not found."
        )
        if plan.get("billing_interval") == "paid_in_full":
            raise HTTPException(status_code=409, detail="Paid-in-full cancellation requires the separate invoice workflow.")
        payer = self.owner._get_row_or_404(
            "billing_payers", enrollment["payer_id"], studio_id, "Billing payer not found."
        )
        group = self.owner._get_row_or_404(
            "billing_subscriptions", enrollment["billing_subscription_id"], studio_id,
            "Billing subscription not found.",
        )
        account = self.owner._connect_accounts().ensure_row(studio_id)
        account_id = str(account.get("stripe_connected_account_id") or "")
        try:
            generation = int((account.get("metadata") or {}).get("connect_account_generation") or 0)
        except (TypeError, ValueError):
            generation = 0
        if (
            not account_id
            or generation <= 0
            or payer.get("stripe_account_id") != account_id
            or payer.get("connect_account_generation") != generation
            or group.get("stripe_account_id") != account_id
            or (group.get("metadata") or {}).get("connect_account_generation") != generation
            or group.get("payer_id") != payer.get("id")
            or enrollment.get("stripe_subscription_id") != group.get("stripe_subscription_id")
            or not enrollment.get("stripe_subscription_item_id")
        ):
            raise HTTPException(status_code=409, detail="Enrollment provider identity requires reconciliation.")
        provider = self.stripe_service_cls().retrieve_connected_subscription(
            account_id=account_id,
            subscription_id=str(group["stripe_subscription_id"]),
            expand=["items.data"],
        )
        rows = (
            self.supabase.table("student_billing_enrollments")
            .select("id,stripe_subscription_item_id,metadata")
            .eq("studio_id", studio_id)
            .eq("billing_subscription_id", group["id"])
            .in_("status", ["pending", "active"])
            .execute()
        ).data or []
        active_rows = [row for row in rows if not (row.get("metadata") or {}).get("stripe_detach_pending")]
        item_ids = {str(row.get("stripe_subscription_item_id") or "") for row in active_rows}
        if "" in item_ids:
            raise HTTPException(status_code=409, detail="Enrollment item identity requires reconciliation.")
        target_item_id = str(enrollment["stripe_subscription_item_id"])
        same_item_count = sum(row.get("stripe_subscription_item_id") == target_item_id for row in active_rows)
        provider_item = self._verify_provider(
            {
                "enrollment": enrollment,
                "plan": plan,
                "payer": payer,
                "group": group,
                "account": account,
                "account_id": account_id,
                "generation": generation,
                "expected_subscription_item_count": len(item_ids),
                "same_item_active_count": same_item_count,
            },
            provider,
            require_cancel_at_period_end=None,
        )
        provider_quantity = int(_object_get(provider_item, "quantity", 0) or 0)
        _period_start, provider_period_end = subscription_period_bounds(provider)
        if not self._same_instant(timestamp(provider_period_end), group.get("current_period_end")):
            raise HTTPException(status_code=409, detail="Subscription period boundary requires reconciliation.")
        if provider_quantity != same_item_count:
            raise HTTPException(status_code=409, detail="Subscription quantity requires reconciliation.")
        whole = len(item_ids) == 1 and same_item_count == 1
        suffix = "immediate" if immediate else "at_period_end"
        strategy = f"subscription_cancel_{suffix}" if whole else f"subscription_item_delete_{suffix}"
        boundary = datetime.now(timezone.utc).isoformat() if immediate else str(group.get("current_period_end") or "")
        if not boundary:
            raise HTTPException(status_code=409, detail="Subscription period boundary is not ready.")
        return {
            "enrollment": enrollment,
            "plan": plan,
            "payer": payer,
            "group": group,
            "account": account,
            "account_id": account_id,
            "generation": generation,
            "provider": provider,
            "expected_subscription_item_count": len(item_ids),
            "same_item_active_count": same_item_count,
            "provider_quantity": provider_quantity,
            "expected_quantity": same_item_count - 1,
            "mutation_strategy": strategy,
            "period_boundary": boundary,
        }

    def _snapshot_for_replay(self, intent: dict[str, Any]) -> dict[str, Any]:
        studio_id = str(intent["studio_id"])
        enrollment = self.owner._get_row_or_404(
            "student_billing_enrollments",
            str(intent["enrollment_id"]),
            studio_id,
            "Billing enrollment not found.",
        )
        plan = self.owner._get_row_or_404(
            "billing_plans", enrollment["billing_plan_id"], studio_id, "Billing plan not found."
        )
        payer = self.owner._get_row_or_404(
            "billing_payers", str(intent["payer_id"]), studio_id, "Billing payer not found."
        )
        group = self.owner._get_row_or_404(
            "billing_subscriptions",
            str(intent["billing_subscription_id"]),
            studio_id,
            "Billing subscription not found.",
        )
        account = self.owner._connect_accounts().ensure_row(studio_id)
        if (
            enrollment.get("payer_id") != intent["payer_id"]
            or payer.get("stripe_account_id") != intent["stripe_connected_account_id"]
            or payer.get("connect_account_generation") != intent["connect_account_generation"]
            or group.get("payer_id") != intent["payer_id"]
            or group.get("stripe_subscription_id") != intent["stripe_subscription_id"]
            or group.get("stripe_account_id") != intent["stripe_connected_account_id"]
            or (group.get("metadata") or {}).get("connect_account_generation")
                != intent["connect_account_generation"]
            or account.get("stripe_connected_account_id") != intent["stripe_connected_account_id"]
            or (account.get("metadata") or {}).get("connect_account_generation")
                != intent["connect_account_generation"]
        ):
            raise HTTPException(status_code=409, detail="Enrollment transition identity requires reconciliation.")
        bound_enrollment = {
            **enrollment,
            "billing_subscription_id": intent["billing_subscription_id"],
            "stripe_subscription_id": intent["stripe_subscription_id"],
            "stripe_subscription_item_id": intent["stripe_subscription_item_id"],
        }
        return {
            "enrollment": bound_enrollment,
            "plan": plan,
            "payer": payer,
            "group": group,
            "account": account,
            "account_id": str(intent["stripe_connected_account_id"]),
            "generation": int(intent["connect_account_generation"]),
            "expected_subscription_item_count": int(intent["expected_subscription_item_count"]),
            "same_item_active_count": int(intent["same_item_active_count"]),
            "provider_quantity": int(intent["provider_quantity"]),
            "expected_quantity": int(intent["expected_quantity"]),
            "mutation_strategy": str(intent["mutation_strategy"]),
            "period_boundary": str(intent["period_boundary"]),
        }

    def _verify_provider(
        self,
        snapshot: dict[str, Any],
        provider: Any,
        *,
        require_cancel_at_period_end: bool | None,
    ) -> Any:
        enrollment = snapshot["enrollment"]
        payer = snapshot["payer"]
        group = snapshot["group"]
        metadata = _object_get(provider, "metadata") or {}
        items = list(_object_get(_object_get(provider, "items") or {}, "data", []) or [])
        target = next(
            (item for item in items if _stripe_id(item) == enrollment.get("stripe_subscription_item_id")),
            None,
        )
        if (
            _stripe_id(provider) != group.get("stripe_subscription_id")
            or _stripe_id(_object_get(provider, "customer")) != payer.get("stripe_customer_id")
            or str(metadata.get("studio_id") or "") != str(enrollment["studio_id"])
            or str(metadata.get("payer_id") or "") != str(payer["id"])
            or str(metadata.get("billing_subscription_id") or "") != str(group["id"])
            or target is None
            or len(items) != int(snapshot["expected_subscription_item_count"])
            or (
                require_cancel_at_period_end is not None
                and bool(_object_get(provider, "cancel_at_period_end")) is not require_cancel_at_period_end
            )
        ):
            raise RuntimeError("enrollment_transition_provider_identity_mismatch")
        if (
            "provider_quantity" in snapshot
            and int(_object_get(target, "quantity", 0) or 0) != int(snapshot["provider_quantity"])
        ):
            raise RuntimeError("enrollment_transition_provider_quantity_mismatch")
        if "plan" in snapshot and not self._item_matches_plan_family(snapshot, target):
            raise RuntimeError("enrollment_transition_provider_item_family_mismatch")
        return target

    @staticmethod
    def _item_matches_plan_family(snapshot: dict[str, Any], item: Any) -> bool:
        metadata = _object_get(item, "metadata") or {}
        return (
            _stripe_id(_object_get(item, "price"))
            == snapshot["plan"].get("stripe_price_id")
            and str(metadata.get("studio_id") or "")
            == str(snapshot["enrollment"]["studio_id"])
            and str(metadata.get("payer_id") or "")
            == str(snapshot["payer"]["id"])
            and str(metadata.get("billing_plan_id") or "")
            == str(snapshot["plan"]["id"])
            and str(metadata.get("billing_subscription_id") or "")
            == str(snapshot["group"]["id"])
            and str(metadata.get("product") or "") == "koaryu_payments"
        )

    def _verify_before_mutation(self, snapshot: dict[str, Any], provider: Any, *, mutation: str) -> None:
        if (
            mutation == "revoke"
            and snapshot["mutation_strategy"]
            == "subscription_item_delete_at_period_end"
        ):
            self._verify_item_schedule_revoke_before(snapshot, provider)
            return
        required_cancel_state = {
            "schedule": False,
            "revoke": True,
        }.get(mutation)
        self._verify_provider(
            snapshot,
            provider,
            require_cancel_at_period_end=required_cancel_state,
        )
        if (
            mutation == "schedule"
            and str(_object_get(provider, "status") or "")
            not in PERIOD_END_SCHEDULABLE_PROVIDER_STATUSES
        ):
            raise RuntimeError("enrollment_transition_provider_status_not_schedulable")

    def _verify_after_mutation(self, snapshot: dict[str, Any], provider: Any, *, mutation: str) -> None:
        if snapshot["mutation_strategy"] == "subscription_item_delete_at_period_end":
            intent = snapshot.get("_transition_intent")
            if not isinstance(intent, dict):
                raise RuntimeError("enrollment_item_schedule_intent_missing")
            if mutation == "schedule":
                snapshot["provider"] = provider
                schedule_id = _stripe_id(_object_get(provider, "schedule"))
                if not schedule_id:
                    raise RuntimeError("enrollment_item_schedule_readback_missing")
                schedule = self.stripe_service_cls().retrieve_connected_subscription_schedule(
                    account_id=snapshot["account_id"],
                    schedule_id=schedule_id,
                )
                self._verify_item_schedule_transition(intent, snapshot, schedule)
                snapshot["_verified_schedule"] = schedule
                return
            if mutation == "revoke":
                if _stripe_id(_object_get(provider, "schedule")):
                    raise RuntimeError("enrollment_item_schedule_release_readback_mismatch")
                released = snapshot.get("_released_schedule")
                if not released:
                    canonical_schedule_id = str(
                        snapshot.get("_canonical_schedule_id")
                        or self._canonical_item_schedule_identity(intent)["schedule_id"]
                    )
                    released = self._retrieve_released_item_schedule(
                        intent,
                        snapshot,
                        expected_schedule_id=canonical_schedule_id,
                    )
                self._verify_item_schedule_owner(intent, released)
                if str(_object_get(released, "status") or "") != "released":
                    raise RuntimeError("enrollment_item_schedule_release_state_mismatch")
                snapshot["_released_schedule"] = released
                return
        if mutation == "schedule":
            self._verify_provider(snapshot, provider, require_cancel_at_period_end=True)
            return
        if mutation == "revoke":
            self._verify_provider(snapshot, provider, require_cancel_at_period_end=False)
            return
        if snapshot["mutation_strategy"].startswith("subscription_cancel_"):
            if _stripe_id(provider) != snapshot["group"]["stripe_subscription_id"] or str(
                _object_get(provider, "status") or ""
            ) != "canceled":
                raise RuntimeError("enrollment_transition_subscription_cancel_readback_mismatch")
            return
        items = list(_object_get(_object_get(provider, "items") or {}, "data", []) or [])
        target = next(
            (item for item in items if _stripe_id(item) == snapshot["enrollment"]["stripe_subscription_item_id"]),
            None,
        )
        expected = int(snapshot["expected_quantity"])
        if (expected == 0 and target is not None) or (
            expected > 0 and (target is None or int(_object_get(target, "quantity", 0) or 0) != expected)
        ):
            raise RuntimeError("enrollment_transition_item_cancel_readback_mismatch")

    def _mutate_provider(
        self,
        snapshot: dict[str, Any],
        *,
        mutation: str,
        context: BillingProviderOperationContext,
    ) -> None:
        stripe = self.stripe_service_cls()
        key = self.owner._idempotency_key("enrollment-transition", context.operation_id)
        if (
            mutation == "revoke"
            and snapshot["mutation_strategy"]
            == "subscription_item_delete_at_period_end"
        ):
            if snapshot.get("_released_schedule"):
                return
            schedule_id = str(snapshot.get("_attached_schedule_id") or "")
            if not schedule_id:
                raise RuntimeError("enrollment_item_schedule_release_identity_missing")
            snapshot["_released_schedule"] = stripe.release_connected_subscription_schedule(
                account_id=context.stripe_connected_account_id,
                studio_id=context.studio_id,
                schedule_id=schedule_id,
                idempotency_key=key,
            )
        elif mutation == "schedule":
            stripe.update_connected_subscription(
                account_id=context.stripe_connected_account_id,
                studio_id=context.studio_id,
                subscription_id=snapshot["group"]["stripe_subscription_id"],
                cancel_at_period_end=True,
                idempotency_key=key,
            )
        elif mutation == "revoke":
            stripe.update_connected_subscription(
                account_id=context.stripe_connected_account_id,
                studio_id=context.studio_id,
                subscription_id=snapshot["group"]["stripe_subscription_id"],
                cancel_at_period_end=False,
                idempotency_key=key,
            )
        elif snapshot["mutation_strategy"].startswith("subscription_cancel_"):
            stripe.cancel_connected_subscription(
                account_id=context.stripe_connected_account_id,
                studio_id=context.studio_id,
                subscription_id=snapshot["group"]["stripe_subscription_id"],
                idempotency_key=key,
            )
        elif int(snapshot["expected_quantity"]) == 0:
            stripe.delete_connected_subscription_item(
                account_id=context.stripe_connected_account_id,
                studio_id=context.studio_id,
                subscription_item_id=snapshot["enrollment"]["stripe_subscription_item_id"],
                idempotency_key=key,
            )
        else:
            stripe.update_connected_subscription_item(
                account_id=context.stripe_connected_account_id,
                studio_id=context.studio_id,
                subscription_item_id=snapshot["enrollment"]["stripe_subscription_item_id"],
                quantity=int(snapshot["expected_quantity"]),
                proration_behavior="none",
                idempotency_key=key,
            )

    def _project_local(self, snapshot: dict[str, Any], provider: Any, *, mutation: str) -> None:
        if mutation in {"schedule", "revoke"}:
            projected = self.owner._project_subscription(provider, snapshot["account_id"])
            if not projected or projected.get("id") != snapshot["group"]["id"]:
                raise RuntimeError("enrollment_transition_group_projection_failed")
            return
        if snapshot["mutation_strategy"].startswith("subscription_cancel_"):
            self._project_whole_cancellation(snapshot, provider)
            return
        update = {
            "status": "canceled",
            "billing_status": "unpaid",
            "billing_subscription_id": None,
            "stripe_subscription_id": None,
            "stripe_subscription_item_id": None,
        }
        result = (
            self.supabase.table("student_billing_enrollments")
            .update(update)
            .eq("id", snapshot["enrollment"]["id"])
            .eq("studio_id", snapshot["enrollment"]["studio_id"])
            .execute()
        )
        if not result.data:
            raise RuntimeError("enrollment_transition_projection_failed")
        self.owner._project_subscription(provider, snapshot["account_id"])
        self.owner._recompute_payer_balance(snapshot["enrollment"]["studio_id"], snapshot["payer"]["id"])

    def _project_whole_cancellation(self, snapshot: dict[str, Any], provider: Any) -> None:
        projected = self.owner._project_subscription(
            provider,
            snapshot["account_id"],
            event_type="customer.subscription.deleted",
        )
        if not projected or projected.get("id") != snapshot["group"]["id"]:
            raise RuntimeError("enrollment_transition_subscription_projection_failed")
        self.owner._recompute_payer_balance(snapshot["enrollment"]["studio_id"], snapshot["payer"]["id"])

    def _read_operation(self, intent: dict[str, Any], *, lease_owner: str) -> dict[str, Any]:
        context = BillingProviderOperationContext(
            operation_id=str(intent["provider_operation_id"]),
            studio_id=str(intent["studio_id"]),
            actor_id=str(intent["initiated_by"]),
            operation_type=self._operation_type(str(intent["transition_kind"])),
            caller_request_key=str(intent["provider_caller_request_key"]),
            request_sha256=str(intent["provider_request_sha256"]),
            stripe_connected_account_id=str(intent["stripe_connected_account_id"]),
            connect_account_generation=int(intent["connect_account_generation"]),
            lease_owner=lease_owner,
        )
        return self.operations.read(context)["operation"]

    def _operation_context(
        self,
        intent: dict[str, Any],
        operation: dict[str, Any],
        *,
        lease_owner: str,
    ) -> BillingProviderOperationContext:
        return BillingProviderOperationContext(
            operation_id=str(operation["id"]),
            studio_id=str(intent["studio_id"]),
            actor_id=str(operation["actor_id"]),
            operation_type=str(operation["operation_type"]),
            caller_request_key=str(operation["caller_request_key"]),
            request_sha256=str(operation["request_sha256"]),
            stripe_connected_account_id=str(intent["stripe_connected_account_id"]),
            connect_account_generation=int(intent["connect_account_generation"]),
            lease_owner=str(operation.get("lease_owner") or lease_owner),
        )

    def _mark_reconciliation(
        self,
        intent: dict[str, Any],
        operation: dict[str, Any],
        context: BillingProviderOperationContext,
        reason: str,
        exc: Exception,
    ) -> None:
        proof = stable_hash({
            "operation_id": context.operation_id,
            "reason": reason,
            "exception_type": type(exc).__name__,
        })
        try:
            operation = self.operations.transition(
                context,
                operation,
                "reconciliation_required",
                reconciliation_reason_code=reason,
            )
            self.operations.transition_enrollment_transition(
                intent=intent,
                operation=operation,
                studio_id=context.studio_id,
                actor_id=context.actor_id,
                provider_evidence_sha256=proof,
                reconciliation_reason_code=reason,
            )
        except Exception:
            pass
        raise HTTPException(status_code=503, detail=TRANSITION_AMBIGUOUS_DETAIL) from exc

    def _retrieve_subscription(self, snapshot: dict[str, Any]) -> Any:
        return self.stripe_service_cls().retrieve_connected_subscription(
            account_id=snapshot["account_id"],
            subscription_id=snapshot["group"]["stripe_subscription_id"],
            expand=["items.data"],
        )

    @staticmethod
    def _provider_proof(snapshot: dict[str, Any], provider: Any) -> str:
        items = [
            {"id": _stripe_id(item), "quantity": int(_object_get(item, "quantity", 0) or 0)}
            for item in list(_object_get(_object_get(provider, "items") or {}, "data", []) or [])
        ]
        schedule = snapshot.get("_verified_schedule") or snapshot.get(
            "_released_schedule"
        )
        schedule_proof = None
        if schedule:
            schedule_proof = {
                "id": _stripe_id(schedule),
                "subscription_id": _stripe_id(
                    _object_get(schedule, "subscription")
                )
                or _stripe_id(_object_get(schedule, "released_subscription")),
                "status": str(_object_get(schedule, "status") or ""),
                "metadata": dict(_object_get(schedule, "metadata") or {}),
                "phases": [
                    {
                        "start_date": epoch_seconds(_object_get(phase, "start_date")),
                        "end_date": epoch_seconds(_object_get(phase, "end_date")),
                        "items": sorted(
                            [
                                {
                                    "price": _stripe_id(_object_get(item, "price")),
                                    "quantity": int(
                                        _object_get(item, "quantity", 0) or 0
                                    ),
                                }
                                for item in list(
                                    _object_get(phase, "items") or []
                                )
                            ],
                            key=lambda item: str(item["price"]),
                        ),
                    }
                    for phase in BillingEnrollmentTransitionWorkflow._schedule_phases(
                        schedule
                    )
                ],
            }
        return stable_hash({
            "account_id": snapshot["account_id"],
            "generation": snapshot["generation"],
            "subscription_id": _stripe_id(provider),
            "customer_id": _stripe_id(_object_get(provider, "customer")),
            "status": str(_object_get(provider, "status") or ""),
            "cancel_at_period_end": bool(_object_get(provider, "cancel_at_period_end")),
            "items": sorted(items, key=lambda item: str(item["id"])),
            "schedule": schedule_proof,
        })

    @staticmethod
    def _expected_provider_object_id(intent: dict[str, Any]) -> str:
        if str(intent["mutation_strategy"]).startswith("subscription_cancel_"):
            return str(intent["stripe_subscription_id"])
        return str(intent["stripe_subscription_item_id"])

    @staticmethod
    def _operation_type(transition_kind: str) -> str:
        return {
            "schedule_period_end": ENROLLMENT_CANCEL_PERIOD_END_SCHEDULE_OPERATION_TYPE,
            "revoke_scheduled": ENROLLMENT_CANCEL_PERIOD_END_REVOKE_OPERATION_TYPE,
            "execute_due": ENROLLMENT_CANCEL_PERIOD_END_EXECUTE_OPERATION_TYPE,
            "immediate_cancel": ENROLLMENT_CANCEL_IMMEDIATE_OPERATION_TYPE,
        }[transition_kind]

    @staticmethod
    def _request_key(value: str | None) -> str:
        normalized = normalize_idempotency_key(value)
        if not normalized:
            raise HTTPException(status_code=400, detail="Idempotency-Key is required for enrollment transitions.")
        return normalized

    @staticmethod
    def _request_hash(studio_id: str, enrollment_id: str, transition_kind: str, reason_code: str) -> str:
        return stable_hash({
            "version": 1,
            "transition_kind": transition_kind,
            "studio_id": studio_id,
            "enrollment_id": enrollment_id,
            "reason_code": reason_code,
        })

    @staticmethod
    def _claim_params(
        snapshot: dict[str, Any],
        *,
        actor_id: str,
        request_key: str,
        request_sha256: str,
        reason_code: str,
        transition_kind: str,
        lease_owner: str,
    ) -> dict[str, Any]:
        enrollment = snapshot["enrollment"]
        return {
            "studio_id": enrollment["studio_id"],
            "actor_id": actor_id,
            "transition_kind": transition_kind,
            "caller_request_key": request_key,
            "request_sha256": request_sha256,
            "enrollment_id": enrollment["id"],
            "payer_id": enrollment["payer_id"],
            "billing_subscription_id": enrollment["billing_subscription_id"],
            "stripe_subscription_id": enrollment["stripe_subscription_id"],
            "stripe_subscription_item_id": enrollment["stripe_subscription_item_id"],
            "stripe_connected_account_id": snapshot["account_id"],
            "connect_account_generation": snapshot["generation"],
            "period_boundary": snapshot["period_boundary"],
            "expected_quantity": snapshot["expected_quantity"],
            "expected_subscription_item_count": snapshot["expected_subscription_item_count"],
            "same_item_active_count": snapshot["same_item_active_count"],
            "provider_quantity": snapshot["provider_quantity"],
            "mutation_strategy": snapshot["mutation_strategy"],
            "reason_code": reason_code,
            "lease_owner": lease_owner,
        }

    @staticmethod
    def _verify_intent_snapshot(intent: dict[str, Any], snapshot: dict[str, Any]) -> None:
        enrollment = snapshot["enrollment"]
        expected = {
            "studio_id": enrollment["studio_id"],
            "enrollment_id": enrollment["id"],
            "payer_id": enrollment["payer_id"],
            "billing_subscription_id": enrollment["billing_subscription_id"],
            "stripe_connected_account_id": snapshot["account_id"],
            "connect_account_generation": snapshot["generation"],
            "stripe_subscription_id": enrollment["stripe_subscription_id"],
            "stripe_subscription_item_id": enrollment["stripe_subscription_item_id"],
        }
        if any(intent.get(key) != value for key, value in expected.items()):
            raise HTTPException(status_code=409, detail="Enrollment transition identity requires reconciliation.")

    @staticmethod
    def _bind_due_intent_snapshot(intent: dict[str, Any], snapshot: dict[str, Any]) -> None:
        current_strategy = str(snapshot["mutation_strategy"])
        expected_strategy = current_strategy.removesuffix("_immediate") + "_at_period_end"
        exact_fields = (
            "expected_quantity",
            "expected_subscription_item_count",
            "same_item_active_count",
            "provider_quantity",
        )
        if (
            intent.get("mutation_strategy") != expected_strategy
            or any(intent.get(field) != snapshot.get(field) for field in exact_fields)
        ):
            raise HTTPException(status_code=409, detail="Enrollment transition facts require reconciliation.")
        snapshot["mutation_strategy"] = str(intent["mutation_strategy"])
        snapshot["period_boundary"] = str(intent["period_boundary"])

    @staticmethod
    def _same_instant(left: Any, right: Any) -> bool:
        if not left or not right:
            return False
        try:
            left_value = datetime.fromisoformat(str(left).replace("Z", "+00:00")).astimezone(timezone.utc)
            right_value = datetime.fromisoformat(str(right).replace("Z", "+00:00")).astimezone(timezone.utc)
        except (TypeError, ValueError):
            return False
        return left_value == right_value

    def _audit_once(self, intent: dict[str, Any], *, studio_id: str, actor_id: str, action: str) -> None:
        audit_id = str(uuid5(NAMESPACE_URL, f"koaryu:{action}:{intent['id']}"))
        existing = self.supabase.table("audit_logs").select("id").eq("id", audit_id).limit(1).execute()
        if existing.data:
            return
        try:
            self.supabase.table("audit_logs").insert({
                "id": audit_id,
                "studio_id": studio_id,
                "actor_id": actor_id,
                "action": action,
                "entity_type": "billing",
                "entity_id": intent["enrollment_id"],
                "metadata": {"transition_intent_id": intent["id"]},
            }).execute()
        except PostgrestAPIError as exc:
            if getattr(exc, "code", None) != "23505":
                raise
