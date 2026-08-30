from __future__ import annotations

from typing import Any, Optional

from fastapi import HTTPException, status
from postgrest.exceptions import APIError as PostgrestAPIError

from app.schemas.billing import (
    BillingEnrollmentScheduledTransitionResponse,
    BillingSubscriptionResponse,
    StudentBillingEnrollmentCreate,
    StudentBillingEnrollmentResponse,
    StudentBillingEnrollmentUpdate,
)
from app.services.billing_enrollment_stripe_lifecycle import BillingEnrollmentStripeLifecycle
from app.services.billing_enrollment_activation import BillingEnrollmentActivationWorkflow
from app.services.billing_enrollment_transitions import BillingEnrollmentTransitionWorkflow
from app.services.supabase_rpc import execute_required_rpc, rpc_rows
from app.services.stripe_service import StripeService


SCHEDULED_TRANSITION_READ_BATCH_SIZE = 300


class BillingEnrollmentManager:
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

    def _ensure_connect_ready(self, studio_id: str) -> dict[str, Any]:
        return self.billing_service._ensure_connect_ready(studio_id)

    def _connect_accounts(self):
        return self.billing_service._connect_accounts()

    def _sync_plan_price(self, plan: dict[str, Any], account: dict[str, Any]) -> dict[str, Any]:
        return self.billing_service._sync_plan_price(plan, account)

    def _payer_autopay_authorized(self, payer: dict[str, Any]) -> bool:
        return self.billing_service._payer_autopay_authorized(payer)

    def _recompute_payer_balance(self, studio_id: str, payer_id: Optional[str]) -> None:
        self.billing_service._recompute_payer_balance(studio_id, payer_id)

    def _audit(self, studio_id: str, actor_id: str, action: str, entity_id: str, metadata: dict[str, Any]) -> None:
        self.billing_service._audit(studio_id, actor_id, action, entity_id, metadata)

    def _idempotency_key(self, *parts: str) -> str:
        return self.billing_service._idempotency_key(*parts)

    def _application_fee_percent(self, account: dict[str, Any]) -> float:
        return self.billing_service._application_fee_percent(account)

    def _application_fee_amount(self, amount_cents: int, account: dict[str, Any]) -> int:
        return self.billing_service._application_fee_amount(amount_cents, account)

    def _project_subscription(
        self,
        subscription: Any,
        account_id: str,
        event_type: str = "",
    ) -> Optional[dict[str, Any]]:
        if not event_type:
            return self.billing_service._project_subscription(subscription, account_id)
        return self.billing_service._project_subscription(
            subscription,
            account_id,
            event_type=event_type,
        )

    def _update_invoice_from_stripe(
        self,
        invoice_id: str,
        studio_id: str,
        stripe_invoice: Any,
        account_id: str,
    ) -> dict[str, Any]:
        return self.billing_service._update_invoice_from_stripe(invoice_id, studio_id, stripe_invoice, account_id)

    def _stripe_account_for_enrollment_subscription(self, enrollment: dict[str, Any]) -> Optional[str]:
        return self.billing_service._stripe_account_for_enrollment_subscription(enrollment)

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
        return self._enrollment_responses_with_scheduled_transitions(
            result.data or [],
            studio_id,
        )

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
        return self._enrollment_responses_with_scheduled_transitions(
            result.data or [],
            studio_id,
        )

    def _enrollment_responses_with_scheduled_transitions(
        self,
        rows: list[dict[str, Any]],
        studio_id: str,
    ) -> list[StudentBillingEnrollmentResponse]:
        if not rows:
            return []
        enrollment_ids = [str(row["id"]) for row in rows]
        expected_enrollment_ids = set(enrollment_ids)
        scheduled_by_enrollment: dict[
            str,
            BillingEnrollmentScheduledTransitionResponse,
        ] = {}
        for start in range(0, len(enrollment_ids), SCHEDULED_TRANSITION_READ_BATCH_SIZE):
            result = execute_required_rpc(
                self.supabase,
                "list_billing_enrollment_scheduled_transitions_v1",
                {
                    "p_studio_id": studio_id,
                    "p_enrollment_ids": enrollment_ids[
                        start:start + SCHEDULED_TRANSITION_READ_BATCH_SIZE
                    ],
                },
            )
            for transition in rpc_rows(result):
                enrollment_id = transition.get("enrollment_id")
                if (
                    not isinstance(enrollment_id, str)
                    or enrollment_id not in expected_enrollment_ids
                    or enrollment_id in scheduled_by_enrollment
                ):
                    raise RuntimeError(
                        "Scheduled enrollment transition state could not be verified."
                    )
                scheduled_by_enrollment[enrollment_id] = (
                    BillingEnrollmentScheduledTransitionResponse(
                        intent_id=transition.get("intent_id"),
                        revision=transition.get("revision"),
                    )
                )
        return [
            StudentBillingEnrollmentResponse(
                **row,
                scheduled_period_end_transition=scheduled_by_enrollment.get(str(row["id"])),
            )
            for row in rows
        ]

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
        if data.collection_mode != "external":
            row["status"] = "pending"
        row.setdefault("billing_status", "externally_paid" if data.collection_mode == "external" else "no_payment_method")
        try:
            result = self.supabase.table("student_billing_enrollments").insert(row).execute()
        except PostgrestAPIError as exc:
            if exc.code == "23505":
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="This student already has an active billing enrollment for the selected plan and payer.",
                ) from exc
            raise
        if not result.data:
            raise HTTPException(status_code=500, detail="Failed to add student billing enrollment.")
        enrollment = result.data[0]
        if data.collection_mode == "external":
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
        if current.get("collection_mode") != "external" or (
            "collection_mode" in update and update.get("collection_mode") != "external"
        ):
            raise HTTPException(
                status_code=409,
                detail=(
                    "Provider-backed enrollment changes require a named supported workflow. "
                    "Generic update is unavailable."
                ),
            )
        if update.get("billing_plan_id"):
            self._ensure_record_in_studio("billing_plans", update["billing_plan_id"], studio_id, "Billing plan not found.")
        if update.get("payer_id"):
            self._ensure_record_in_studio("billing_payers", update["payer_id"], studio_id, "Payer not found.")
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
        if current.get("collection_mode") != "external":
            raise HTTPException(
                status_code=409,
                detail=(
                    "Provider-backed pause, resume, and cancellation require named supported workflows."
                ),
            )
        update: dict[str, Any] = {"status": status_value}
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

    async def activate_enrollment(
        self,
        enrollment_id: str,
        studio_id: str,
        actor_id: str,
        idempotency_key: str | None = None,
    ) -> StudentBillingEnrollmentResponse:
        return BillingEnrollmentActivationWorkflow(
            self,
            stripe_service_cls=self.stripe_service_cls,
        ).activate(enrollment_id, studio_id, actor_id, idempotency_key)

    async def schedule_period_end(
        self,
        enrollment_id: str,
        studio_id: str,
        actor_id: str,
        idempotency_key: str | None,
        reason_code: str,
    ) -> dict[str, Any]:
        return BillingEnrollmentTransitionWorkflow(
            self,
            stripe_service_cls=self.stripe_service_cls,
        ).schedule_period_end(enrollment_id, studio_id, actor_id, idempotency_key, reason_code)

    async def revoke_scheduled_transition(
        self,
        transition_intent_id: str,
        expected_revision: int,
        studio_id: str,
        actor_id: str,
        idempotency_key: str | None,
        reason_code: str,
    ) -> dict[str, Any]:
        return BillingEnrollmentTransitionWorkflow(
            self,
            stripe_service_cls=self.stripe_service_cls,
        ).revoke_scheduled(
            transition_intent_id,
            expected_revision,
            studio_id,
            actor_id,
            idempotency_key,
            reason_code,
        )

    async def cancel_immediate(
        self,
        enrollment_id: str,
        studio_id: str,
        actor_id: str,
        idempotency_key: str | None,
        reason_code: str,
    ) -> dict[str, Any]:
        return BillingEnrollmentTransitionWorkflow(
            self,
            stripe_service_cls=self.stripe_service_cls,
        ).cancel_immediate(enrollment_id, studio_id, actor_id, idempotency_key, reason_code)

    async def process_due_transitions(self, *, worker_id: str, limit: int) -> dict[str, int]:
        return BillingEnrollmentTransitionWorkflow(
            self,
            stripe_service_cls=self.stripe_service_cls,
        ).process_due(worker_id=worker_id, limit=limit)
    def _stripe_lifecycle(self) -> BillingEnrollmentStripeLifecycle:
        return BillingEnrollmentStripeLifecycle(self)

    def _find_or_create_billing_subscription(
        self,
        enrollment: dict[str, Any],
        plan: dict[str, Any],
        payer: dict[str, Any],
        account: dict[str, Any],
    ) -> dict[str, Any]:
        return self._stripe_lifecycle()._find_or_create_billing_subscription(enrollment, plan, payer, account)

    def _subscription_item_id_for_group_plan(self, studio_id: str, group_id: str, plan_id: str) -> Optional[str]:
        return self._stripe_lifecycle()._subscription_item_id_for_group_plan(studio_id, group_id, plan_id)

    def _active_enrollment_count_for_subscription_item(
        self,
        studio_id: str,
        group_id: Optional[str],
        item_id: Optional[str],
        *,
        exclude_enrollment_id: Optional[str] = None,
    ) -> int:
        return self._stripe_lifecycle()._active_enrollment_count_for_subscription_item(
            studio_id,
            group_id,
            item_id,
            exclude_enrollment_id=exclude_enrollment_id,
        )

    def _update_enrollment(self, enrollment_id: str, studio_id: str, update: dict[str, Any]) -> dict[str, Any]:
        return self._stripe_lifecycle()._update_enrollment(enrollment_id, studio_id, update)

    def _subscription_item_id_for_enrollment(self, subscription: Any, enrollment_id: str) -> Optional[str]:
        return self._stripe_lifecycle()._subscription_item_id_for_enrollment(subscription, enrollment_id)
