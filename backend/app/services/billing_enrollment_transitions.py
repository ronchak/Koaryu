from __future__ import annotations

from datetime import datetime, timezone
from typing import Any
from uuid import NAMESPACE_URL, uuid4, uuid5

from fastapi import HTTPException, status
from postgrest.exceptions import APIError as PostgrestAPIError

from app.services.billing_invoice_projection import _object_get, _stripe_id, subscription_period_bounds
from app.services.billing_provider_operations import (
    BillingProviderOperationContext,
    BillingProviderOperationCoordinator,
    ENROLLMENT_CANCEL_IMMEDIATE_OPERATION_TYPE,
    ENROLLMENT_CANCEL_PERIOD_END_EXECUTE_OPERATION_TYPE,
    ENROLLMENT_CANCEL_PERIOD_END_REVOKE_OPERATION_TYPE,
    ENROLLMENT_CANCEL_PERIOD_END_SCHEDULE_OPERATION_TYPE,
)
from app.services.billing_webhook_event_state import timestamp
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


class BillingEnrollmentTransitionWorkflow:
    def __init__(self, owner: Any, *, stripe_service_cls: type[StripeService] = StripeService):
        self.owner = owner
        self.supabase = owner.supabase
        self.stripe_service_cls = stripe_service_cls
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
        return self._drive_provider_operation(
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
                    snapshot = self._snapshot(
                        str(intent["enrollment_id"]),
                        str(intent["studio_id"]),
                        immediate=True,
                    )
                    self._verify_intent_snapshot(intent, snapshot)
                    self._bind_due_intent_snapshot(intent, snapshot)
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
                if intent["mutation_strategy"] == "subscription_cancel_at_period_end":
                    try:
                        provider = self._retrieve_subscription(snapshot)
                        self._verify_provider(snapshot, provider, require_cancel_at_period_end=None)
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
        if snapshot["mutation_strategy"].startswith("subscription_item_delete_"):
            lock_token = self.lifecycle._claim_subscription_quantity_sync_lock(
                str(snapshot["enrollment"]["studio_id"]), group_id,
            )
            try:
                refreshed = self._snapshot(
                    str(snapshot["enrollment"]["id"]),
                    str(snapshot["enrollment"]["studio_id"]),
                    immediate=True,
                )
                intent = envelope["intent"]
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
        operation = envelope.get("operation")
        if not isinstance(operation, dict):
            operation = self._read_operation(intent, lease_owner=lease_owner)
        context = self._operation_context(intent, operation, lease_owner=lease_owner)
        state = str(operation.get("state") or "")
        if state == "provider_request_in_flight":
            raise HTTPException(status_code=409, detail=TRANSITION_IN_PROGRESS_DETAIL)
        if state == "reconciliation_required":
            raise HTTPException(status_code=409, detail=TRANSITION_AMBIGUOUS_DETAIL)
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
        if state == "started":
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
        return target

    def _verify_before_mutation(self, snapshot: dict[str, Any], provider: Any, *, mutation: str) -> None:
        required_cancel_state = {
            "schedule": False,
            "revoke": True,
        }.get(mutation)
        self._verify_provider(
            snapshot,
            provider,
            require_cancel_at_period_end=required_cancel_state,
        )

    def _verify_after_mutation(self, snapshot: dict[str, Any], provider: Any, *, mutation: str) -> None:
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
        if mutation == "schedule":
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
        return stable_hash({
            "account_id": snapshot["account_id"],
            "generation": snapshot["generation"],
            "subscription_id": _stripe_id(provider),
            "customer_id": _stripe_id(_object_get(provider, "customer")),
            "status": str(_object_get(provider, "status") or ""),
            "cancel_at_period_end": bool(_object_get(provider, "cancel_at_period_end")),
            "items": sorted(items, key=lambda item: str(item["id"])),
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
