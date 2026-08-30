from __future__ import annotations

from typing import Any, Optional
from uuid import NAMESPACE_URL, uuid4, uuid5

from fastapi import HTTPException, status
from postgrest.exceptions import APIError as PostgrestAPIError

from app.schemas.billing import BillingPlanResponse
from app.services.billing_invoice_projection import _stripe_id
from app.services.billing_provider_operations import (
    BillingProviderOperationContext,
    BillingProviderOperationCoordinator,
    BillingProviderOperationStepContext,
    BillingProviderStepCoordinator,
    PLAN_SYNC_OPERATION_TYPE,
    billing_provider_step_plan_sha256,
    provider_operation_disposition,
)
from app.services.platform_billing_helpers import normalize_idempotency_key, stable_hash
from app.services.stripe_mutation_policy import StripeMutationBlocked
from app.services.stripe_service import StripeService


PLAN_SYNC_AMBIGUOUS_DETAIL = (
    "Plan sync outcome is not confirmed. Retry with the same Idempotency-Key after reconciliation."
)


class _PlanProjectionCasMissError(RuntimeError):
    """The exact plan snapshot no longer owns the projection write."""


class BillingPlanSyncWorkflow:
    def __init__(self, owner: Any, *, stripe_service_cls: type[StripeService] = StripeService):
        self.owner = owner
        self.supabase = owner.supabase
        self.stripe_service_cls = stripe_service_cls

    async def sync_plan(
        self,
        plan_id: str,
        studio_id: str,
        actor_id: str,
        idempotency_key: str | None,
    ) -> BillingPlanResponse:
        normalized_key = normalize_idempotency_key(idempotency_key)
        if not normalized_key:
            raise HTTPException(status_code=400, detail="Idempotency-Key is required for plan sync.")
        plan = self.owner._get_row_or_404(
            "billing_plans", plan_id, studio_id, "Billing plan not found."
        )
        if plan.get("status") == "archived" or plan.get("archived_at"):
            raise HTTPException(status_code=409, detail="Archived billing plans cannot be synced.")
        account = self._local_ready_account(studio_id)
        account_id = str(account["stripe_connected_account_id"])
        generation = self._account_generation(account)
        self._validate_plan_identity(plan, account_id)
        desired_hash = self._desired_plan_hash(plan, account_id, generation)
        lease_owner = str(uuid4())
        operations = BillingProviderOperationCoordinator(self.supabase)
        claimed = operations.claim_resource(
            studio_id=studio_id,
            actor_id=actor_id,
            operation_type=PLAN_SYNC_OPERATION_TYPE,
            resource_type="plan",
            resource_id=plan_id,
            payer_id=None,
            caller_request_key=normalized_key,
            request_sha256=desired_hash,
            stripe_connected_account_id=account_id,
            connect_account_generation=generation,
            lease_owner=lease_owner,
        )
        operation = claimed["operation"]
        plan = self._bind_claimed_plan_resource(plan, claimed, operation)
        disposition = provider_operation_disposition(claimed)
        recovery = disposition in {"recovery_safe_retry", "recovery_reconcile_only"}
        context = BillingProviderOperationContext(
            operation_id=str(operation["id"]),
            studio_id=studio_id,
            actor_id=str(operation["actor_id"]),
            operation_type=PLAN_SYNC_OPERATION_TYPE,
            caller_request_key=str(claimed["canonical_caller_request_key"]),
            request_sha256=str(operation["request_sha256"]),
            stripe_connected_account_id=account_id,
            connect_account_generation=generation,
            lease_owner=(
                str(operation["lease_owner"])
                if recovery
                else lease_owner
            ),
        )
        if disposition == "replay":
            try:
                projected = self._load_projected_plan(plan_id, context, operation)
            except Exception as exc:
                raise HTTPException(
                    status_code=503,
                    detail="Completed plan sync result could not be verified.",
                ) from exc
            self._ensure_audit(context, projected, operation)
            return self._response(projected, account)
        if operation.get("state") == "projected":
            try:
                projected = self._load_projected_plan(plan_id, context, operation)
            except Exception as exc:
                self._mark_parent_reconciliation(
                    operations,
                    context,
                    operation,
                    "plan_sync_projection_unverified",
                    exc,
                )
            operation = operations.complete(
                context, operation, result_code="plan_sync_completed"
            )
            self._ensure_audit(context, projected, operation)
            return self._response(projected, account)
        if operation.get("state") == "provider_succeeded":
            try:
                projected = self._load_projected_plan(plan_id, context, operation)
            except Exception:
                if operation.get("result_code") == "provider_step_phase_completed":
                    product_id, price_id, version, lookup_key = self._read_two_step_results(
                        plan,
                        context,
                        operation,
                        generation,
                    )
                    projected = self._project_two_step_result(
                        plan,
                        context,
                        product_id=product_id,
                        price_id=price_id,
                        version=version,
                        lookup_key=lookup_key,
                        generation=generation,
                        allow_existing_projection=True,
                    )
                else:
                    if (
                        operation.get("result_code") != "plan_sync_product_updated"
                        or self._product_update_target(operation)
                        != operation.get("provider_object_id")
                        or int(operation.get("provider_request_attempt_count") or 0) not in {1, 2}
                    ):
                        self._mark_parent_reconciliation(
                            operations,
                            context,
                            operation,
                            "plan_sync_provider_phase_unverified",
                            RuntimeError("plan_sync_provider_phase_unverified"),
                        )
                    product_id = str(operation.get("provider_object_id") or "")
                    price = self._exact_active_price(plan, account_id, generation)
                    if not product_id or not price:
                        self._mark_parent_reconciliation(
                            operations,
                            context,
                            operation,
                            "plan_sync_projection_unverified",
                            RuntimeError("plan_sync_provider_result_missing"),
                        )
                    projected = self._project_plan(
                        plan,
                        context,
                        product_id=product_id,
                        price=price,
                        allow_existing_projection=True,
                    )
            operation = operations.transition(
                context,
                operation,
                "projected",
                result_code="plan_sync_projected",
                result_summary=(
                    "plan_sync_mode:product_price_steps"
                    if operation.get("result_code") == "provider_step_phase_completed"
                    else operation.get("result_summary")
                ),
            )
            operation = operations.complete(
                context, operation, result_code="plan_sync_completed"
            )
            self._ensure_audit(context, projected, operation)
            return self._response(projected, account)

        if recovery:
            try:
                saved_target = self._product_update_target(operation)
            except Exception as exc:
                operations.reject_recovery_source_drift_v2(
                    context, operation,
                    error_code="plan_sync_recovery_source_drift",
                )
                raise HTTPException(status_code=409, detail=PLAN_SYNC_AMBIGUOUS_DETAIL) from exc
            if (
                plan.get("status") != "active"
                or plan.get("archived_at") is not None
                or str(plan.get("stripe_product_id") or "") != saved_target
            ):
                operations.reject_recovery_source_drift_v2(
                    context, operation,
                    error_code="plan_sync_recovery_source_drift",
                )
                raise HTTPException(status_code=409, detail=PLAN_SYNC_AMBIGUOUS_DETAIL)
        exact_price = self._exact_active_price(plan, account_id, generation)
        if exact_price and not plan.get("stripe_product_id"):
            raise HTTPException(
                status_code=409,
                detail="Plan has an active Stripe price without an established product identity.",
            )
        if plan.get("stripe_product_id") and exact_price:
            if disposition == "recovery_reconcile_only":
                projected = self._reconcile_product_update_only(
                    plan,
                    context,
                    operation,
                    operations,
                    exact_price,
                )
            else:
                projected = self._run_product_update_only(
                    plan,
                    context,
                    operation,
                    operations,
                    exact_price,
                )
        else:
            if recovery:
                raise HTTPException(status_code=409, detail=PLAN_SYNC_AMBIGUOUS_DETAIL)
            projected = self._run_two_step_sync(
                plan,
                context,
                operation,
                operations,
                generation,
            )
        self._ensure_audit(context, projected, operations.read(context)["operation"])
        return self._response(projected, account)

    def _run_product_update_only(
        self,
        plan: dict[str, Any],
        context: BillingProviderOperationContext,
        operation: dict[str, Any],
        operations: BillingProviderOperationCoordinator,
        price: dict[str, Any],
    ) -> dict[str, Any]:
        product_id = str(plan["stripe_product_id"])
        recovering = operation.get("state") == "recovery_authorized"
        operation = operations.transition(
            context,
            operation,
            "provider_request_in_flight",
            result_code="plan_sync_product_update_started",
            result_summary=self._product_update_summary(product_id),
        )
        if recovering and int(operation.get("provider_request_attempt_count") or 0) != 2:
            raise HTTPException(status_code=503, detail=PLAN_SYNC_AMBIGUOUS_DETAIL)
        try:
            product = self.stripe_service_cls().update_connected_product(
                account_id=context.stripe_connected_account_id,
                studio_id=context.studio_id,
                product_id=product_id,
                name=plan["name"],
                description=plan.get("description"),
                metadata=self._product_metadata(plan),
                idempotency_key=self.owner._idempotency_key(
                    "plan-sync", context.operation_id, "product"
                ),
            )
        except StripeMutationBlocked:
            operations.transition(
                context,
                operation,
                "definitive_rejected",
                error_code="provider_mutation_blocked",
            )
            raise
        except Exception as exc:
            self._mark_parent_reconciliation(
                operations,
                context,
                operation,
                "plan_sync_product_outcome_ambiguous",
                exc,
            )
        if _stripe_id(product) != product_id:
            self._mark_parent_reconciliation(
                operations,
                context,
                operation,
                "plan_sync_product_identity_ambiguous",
                RuntimeError("plan_sync_product_identity_ambiguous"),
            )
        try:
            operation = operations.transition(
                context,
                operation,
                "provider_succeeded",
                provider_object_id=product_id,
                result_code="plan_sync_product_updated",
            )
        except Exception as exc:
            raise HTTPException(status_code=503, detail=PLAN_SYNC_AMBIGUOUS_DETAIL) from exc
        try:
            projected = self._project_plan(
                plan,
                context,
                product_id=product_id,
                price=price,
            )
        except Exception as exc:
            self._mark_parent_reconciliation(
                operations,
                context,
                operation,
                "plan_sync_local_projection_failed",
                exc,
            )
        operation = operations.transition(
            context,
            operation,
            "projected",
            result_code="plan_sync_projected",
        )
        operations.complete(context, operation, result_code="plan_sync_completed")
        return projected

    def _reconcile_product_update_only(
        self,
        plan: dict[str, Any],
        context: BillingProviderOperationContext,
        operation: dict[str, Any],
        operations: BillingProviderOperationCoordinator,
        price: dict[str, Any],
    ) -> dict[str, Any]:
        product_id = str(operation.get("provider_object_id") or "")
        try:
            product = self.stripe_service_cls().retrieve_connected_product(
                account_id=context.stripe_connected_account_id,
                product_id=product_id,
            )
            metadata = getattr(product, "metadata", None) or (
                product.get("metadata") if isinstance(product, dict) else {}
            ) or {}
            if (
                _stripe_id(product) != product_id
                or product_id != str(plan.get("stripe_product_id") or "")
                or (product.get("name") if isinstance(product, dict) else getattr(product, "name", None))
                != plan["name"]
                or str(
                    (product.get("description") if isinstance(product, dict)
                     else getattr(product, "description", None)) or ""
                ) != str(plan.get("description") or "")
                or metadata != self._product_metadata(plan)
            ):
                raise RuntimeError("plan_sync_recovered_product_mismatch")
        except Exception as exc:
            self._mark_parent_reconciliation(
                operations,
                context,
                operation,
                "plan_sync_recovered_product_mismatch",
                exc,
            )
        operation = operations.transition(
            context,
            operation,
            "provider_succeeded",
            provider_object_id=product_id,
            result_code="plan_sync_product_updated",
            result_summary=self._product_update_summary(product_id),
        )
        try:
            projected = self._project_plan(
                plan,
                context,
                product_id=product_id,
                price=price,
            )
        except Exception as exc:
            self._mark_parent_reconciliation(
                operations,
                context,
                operation,
                "plan_sync_local_projection_failed",
                exc,
            )
        operation = operations.transition(
            context, operation, "projected", result_code="plan_sync_projected"
        )
        operations.complete(context, operation, result_code="plan_sync_completed")
        return projected

    def _run_two_step_sync(
        self,
        plan: dict[str, Any],
        context: BillingProviderOperationContext,
        operation: dict[str, Any],
        operations: BillingProviderOperationCoordinator,
        generation: int,
    ) -> dict[str, Any]:
        plan_spec = self._two_step_plan(plan, context)
        steps = plan_spec["steps"]
        plan_sha256 = str(plan_spec["plan_sha256"])
        step_client = BillingProviderStepCoordinator(self.supabase)
        registered = step_client.register_plan(
            context,
            operation,
            plan_sha256=plan_sha256,
            steps=steps,
        )
        operation = registered["operation"]
        product_step = self._step_context(context, plan_sha256, 1, steps[0])
        product_id = self._execute_product_step(
            plan,
            product_step,
            step_client,
            operation,
            plan_sha256,
        )
        price_step = self._step_context(context, plan_sha256, 2, steps[1])
        price_id = self._execute_price_step(
            plan,
            price_step,
            step_client,
            operation,
            plan_sha256,
            product_id,
            version=int(plan_spec["version"]),
            lookup_key=str(plan_spec["lookup_key"]),
        )
        completed = step_client.complete_provider_phase(
            context,
            operation,
            plan_sha256=plan_sha256,
            expected_step_count=2,
        )
        operation = completed["operation"]
        if operation.get("state") != "provider_succeeded":
            raise HTTPException(status_code=409, detail=PLAN_SYNC_AMBIGUOUS_DETAIL)
        try:
            projected = self._project_two_step_result(
                plan,
                context,
                product_id=product_id,
                price_id=price_id,
                version=int(plan_spec["version"]),
                lookup_key=str(plan_spec["lookup_key"]),
                generation=generation,
            )
        except Exception as exc:
            self._mark_parent_reconciliation(
                operations,
                context,
                operation,
                "plan_sync_local_projection_failed",
                exc,
            )
        operation = operations.transition(
            context,
            operation,
            "projected",
            result_code="plan_sync_projected",
            result_summary="plan_sync_mode:product_price_steps",
        )
        operations.complete(context, operation, result_code="plan_sync_completed")
        return projected

    def _execute_product_step(
        self,
        plan: dict[str, Any],
        step: BillingProviderOperationStepContext,
        client: BillingProviderStepCoordinator,
        operation: dict[str, Any],
        plan_sha256: str,
    ) -> str:
        envelope = client.claim_step(step)
        current = envelope["step"]
        state = str(current.get("state") or "")
        if state == "provider_succeeded":
            provider_id = str(current.get("provider_object_id") or "")
            if provider_id:
                return provider_id
            raise HTTPException(status_code=503, detail=PLAN_SYNC_AMBIGUOUS_DETAIL)
        self._raise_for_blocked_step(envelope)
        current = client.transition_step(
            step,
            current,
            "provider_request_in_flight",
            result_code="plan_sync_product_started",
        )
        try:
            if step.provider_operation == "connected_product.update":
                product = self.stripe_service_cls().update_connected_product(
                    account_id=step.parent.stripe_connected_account_id,
                    studio_id=step.parent.studio_id,
                    product_id=str(plan["stripe_product_id"]),
                    name=plan["name"],
                    description=plan.get("description"),
                    metadata=self._product_metadata(plan),
                    idempotency_key=step.stripe_idempotency_key,
                )
            else:
                product = self.stripe_service_cls().create_connected_product(
                    account_id=step.parent.stripe_connected_account_id,
                    studio_id=step.parent.studio_id,
                    name=plan["name"],
                    description=plan.get("description"),
                    metadata=self._product_metadata(plan),
                    idempotency_key=step.stripe_idempotency_key,
                )
        except StripeMutationBlocked:
            client.transition_step(
                step,
                current,
                "definitive_rejected",
                error_code="provider_mutation_blocked",
            )
            self._complete_failed_phase(client, step.parent, operation, plan_sha256)
            raise
        except Exception as exc:
            self._mark_step_reconciliation(
                client,
                step,
                current,
                operation,
                plan_sha256,
                "plan_sync_product_outcome_ambiguous",
                exc,
            )
        product_id = _stripe_id(product)
        if not product_id or (
            step.provider_operation == "connected_product.update"
            and product_id != plan.get("stripe_product_id")
        ):
            self._mark_step_reconciliation(
                client,
                step,
                current,
                operation,
                plan_sha256,
                "plan_sync_product_identity_ambiguous",
                RuntimeError("plan_sync_product_identity_ambiguous"),
            )
        try:
            client.transition_step(
                step,
                current,
                "provider_succeeded",
                provider_object_id=product_id,
                result_code="plan_sync_product_succeeded",
            )
        except Exception as exc:
            raise HTTPException(status_code=503, detail=PLAN_SYNC_AMBIGUOUS_DETAIL) from exc
        return product_id

    def _execute_price_step(
        self,
        plan: dict[str, Any],
        step: BillingProviderOperationStepContext,
        client: BillingProviderStepCoordinator,
        operation: dict[str, Any],
        plan_sha256: str,
        product_id: str,
        *,
        version: int,
        lookup_key: str,
    ) -> str:
        envelope = client.claim_step(step)
        current = envelope["step"]
        state = str(current.get("state") or "")
        if state == "provider_succeeded":
            provider_id = str(current.get("provider_object_id") or "")
            if provider_id:
                return provider_id
            raise HTTPException(status_code=503, detail=PLAN_SYNC_AMBIGUOUS_DETAIL)
        self._raise_for_blocked_step(envelope)
        current = client.transition_step(
            step,
            current,
            "provider_request_in_flight",
            result_code="plan_sync_price_started",
        )
        recurring, _ = self.owner._stripe_recurring_for_interval(
            plan.get("billing_interval") or "monthly"
        )
        try:
            price = self.stripe_service_cls().create_connected_price(
                account_id=step.parent.stripe_connected_account_id,
                studio_id=step.parent.studio_id,
                product_id=product_id,
                unit_amount=int(plan.get("amount_cents") or 0),
                currency=plan.get("currency") or "usd",
                recurring=recurring,
                lookup_key=lookup_key,
                metadata={
                    **self._product_metadata(plan),
                    "version": str(version),
                    "billing_interval": plan.get("billing_interval") or "monthly",
                },
                idempotency_key=step.stripe_idempotency_key,
            )
        except StripeMutationBlocked:
            client.transition_step(
                step,
                current,
                "definitive_rejected",
                error_code="provider_mutation_blocked",
            )
            self._complete_failed_phase(client, step.parent, operation, plan_sha256)
            raise
        except Exception as exc:
            self._mark_step_reconciliation(
                client,
                step,
                current,
                operation,
                plan_sha256,
                "plan_sync_price_outcome_ambiguous",
                exc,
            )
        price_id = _stripe_id(price)
        if not price_id:
            self._mark_step_reconciliation(
                client,
                step,
                current,
                operation,
                plan_sha256,
                "plan_sync_price_identity_ambiguous",
                RuntimeError("plan_sync_price_identity_ambiguous"),
            )
        try:
            client.transition_step(
                step,
                current,
                "provider_succeeded",
                provider_object_id=price_id,
                result_code="plan_sync_price_succeeded",
            )
        except Exception as exc:
            raise HTTPException(status_code=503, detail=PLAN_SYNC_AMBIGUOUS_DETAIL) from exc
        return price_id

    def _read_two_step_results(
        self,
        plan: dict[str, Any],
        context: BillingProviderOperationContext,
        operation: dict[str, Any],
        generation: int,
    ) -> tuple[str, str, int, str]:
        spec = self._two_step_plan(plan, context)
        envelope = BillingProviderStepCoordinator(self.supabase).read_plan(
            context,
            plan_sha256=str(spec["plan_sha256"]),
        )
        steps = envelope["steps"]
        if len(steps) != 2 or any(step.get("state") != "provider_succeeded" for step in steps):
            raise HTTPException(status_code=503, detail=PLAN_SYNC_AMBIGUOUS_DETAIL)
        product_id = str(steps[0].get("provider_object_id") or "")
        price_id = str(steps[1].get("provider_object_id") or "")
        if not product_id or not price_id:
            raise HTTPException(status_code=503, detail=PLAN_SYNC_AMBIGUOUS_DETAIL)
        return product_id, price_id, int(spec["version"]), str(spec["lookup_key"])

    def _two_step_plan(
        self,
        plan: dict[str, Any],
        context: BillingProviderOperationContext,
    ) -> dict[str, Any]:
        product_operation = (
            "connected_product.update"
            if plan.get("stripe_product_id")
            else "connected_product.create"
        )
        version = int(plan.get("stripe_price_version") or 1)
        if plan.get("stripe_price_id"):
            version += 1
        lookup_key = f"koaryu_{plan['studio_id']}_{plan['id']}_v{version}"
        product_key = self.owner._idempotency_key(
            "plan-sync", context.operation_id, "step-1-product"
        )
        price_key = self.owner._idempotency_key(
            "plan-sync", context.operation_id, "step-2-price"
        )
        steps = [
            {
                "step_name": "product",
                "provider_operation": product_operation,
                "request_sha256": stable_hash({
                    "provider_operation": product_operation,
                    "stripe_product_id": plan.get("stripe_product_id"),
                    "name": plan["name"],
                    "description": plan.get("description"),
                    "studio_id": plan["studio_id"],
                    "plan_id": plan["id"],
                    "account_id": context.stripe_connected_account_id,
                    "generation": context.connect_account_generation,
                }),
                "stripe_idempotency_key": product_key,
            },
            {
                "step_name": "price",
                "provider_operation": "connected_price.create",
                "request_sha256": stable_hash({
                    "provider_operation": "connected_price.create",
                    "product_source": "step:product",
                    "amount_cents": int(plan.get("amount_cents") or 0),
                    "currency": plan.get("currency") or "usd",
                    "billing_interval": plan.get("billing_interval") or "monthly",
                    "lookup_key": lookup_key,
                    "version": version,
                    "account_id": context.stripe_connected_account_id,
                    "generation": context.connect_account_generation,
                }),
                "stripe_idempotency_key": price_key,
            },
        ]
        return {
            "steps": steps,
            "plan_sha256": billing_provider_step_plan_sha256(steps),
            "version": version,
            "lookup_key": lookup_key,
        }

    @staticmethod
    def _step_context(
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

    def _project_two_step_result(
        self,
        plan: dict[str, Any],
        context: BillingProviderOperationContext,
        *,
        product_id: str,
        price_id: str,
        version: int,
        lookup_key: str,
        generation: int,
        allow_existing_projection: bool = False,
    ) -> dict[str, Any]:
        recurring, interval_count = self.owner._stripe_recurring_for_interval(
            plan.get("billing_interval") or "monthly"
        )
        price_payload = {
            "studio_id": context.studio_id,
            "billing_plan_id": plan["id"],
            "stripe_account_id": context.stripe_connected_account_id,
            "stripe_product_id": product_id,
            "stripe_price_id": price_id,
            "amount_cents": int(plan.get("amount_cents") or 0),
            "currency": plan.get("currency") or "usd",
            "billing_interval": plan.get("billing_interval") or "monthly",
            "interval_count": interval_count,
            "recurring": bool(recurring),
            "active": True,
            "version": version,
            "metadata": {
                "connect_account_generation": generation,
                "provider_operation_id": context.operation_id,
            },
        }
        owned_price_id = None
        existing = (
            self.supabase.table("billing_plan_prices")
            .select("*")
            .eq("studio_id", context.studio_id)
            .eq("stripe_account_id", context.stripe_connected_account_id)
            .eq("stripe_price_id", price_id)
            .limit(1)
            .execute()
        )
        if existing.data:
            price = self._verify_price_row(
                existing.data[0],
                plan=plan,
                account_id=context.stripe_connected_account_id,
                generation=generation,
                product_id=product_id,
            )
            if self._is_exact_owned_price(price, price_payload):
                owned_price_id = price.get("id")
        else:
            try:
                inserted = (
                    self.supabase.table("billing_plan_prices")
                    .insert(price_payload)
                    .execute()
                )
            except Exception as exc:
                price = self._recover_owned_price_projection(
                    price_payload,
                    original_error=exc,
                )
            else:
                candidate = inserted.data[0] if inserted.data else None
                if isinstance(candidate, dict) and self._is_exact_owned_price(
                    candidate, price_payload
                ):
                    price = candidate
                else:
                    price = self._recover_owned_price_projection(
                        price_payload,
                        original_error=RuntimeError(
                            "plan_sync_price_projection_response_unverified"
                        ),
                    )
            owned_price_id = price.get("id")
        try:
            return self._project_plan(
                plan,
                context,
                product_id=product_id,
                price={**price, "stripe_price_lookup_key": lookup_key},
                allow_existing_projection=allow_existing_projection,
            )
        except _PlanProjectionCasMissError:
            if owned_price_id:
                self._remove_exact_owned_price(owned_price_id, price_payload)
            raise

    def _project_plan(
        self,
        plan: dict[str, Any],
        context: BillingProviderOperationContext,
        *,
        product_id: str,
        price: dict[str, Any],
        allow_existing_projection: bool = False,
    ) -> dict[str, Any]:
        if not plan.get("_sync_resource_claim_id"):
            raise RuntimeError("plan_sync_resource_owner_missing")
        update = {
            "stripe_account_id": context.stripe_connected_account_id,
            "stripe_product_id": product_id,
            "stripe_price_id": price["stripe_price_id"],
            "stripe_price_lookup_key": price.get("stripe_price_lookup_key")
            or f"koaryu_{plan['studio_id']}_{plan['id']}_v{int(price.get('version') or 1)}",
            "stripe_price_version": int(price.get("version") or 1),
            "status": "active",
        }
        if allow_existing_projection:
            projected = self._read_exact_projected_plan(plan, context, update)
            if projected is not None:
                return projected
        query = (
            self.supabase.table("billing_plans")
            .update(update)
            .eq("id", plan["id"])
            .eq("studio_id", context.studio_id)
        )
        for field, value in self._plan_projection_snapshot(plan).items():
            query = query.is_(field, "null") if value is None else query.eq(field, value)
        try:
            result = query.execute()
        except Exception as exc:
            try:
                projected = self._read_exact_projected_plan(plan, context, update)
            except Exception as readback_exc:
                raise RuntimeError("plan_sync_plan_projection_ambiguous") from readback_exc
            if projected is not None:
                return projected
            raise RuntimeError("plan_sync_plan_projection_ambiguous") from exc
        if result.data:
            projected = result.data[0]
            if self._is_exact_projected_plan(projected, plan, update):
                return projected
            raise RuntimeError("plan_sync_plan_projection_response_unverified")
        try:
            projected = self._read_exact_projected_plan(plan, context, update)
        except Exception as exc:
            raise RuntimeError("plan_sync_plan_projection_ambiguous") from exc
        if projected is not None:
            return projected
        raise _PlanProjectionCasMissError("plan_sync_plan_projection_stale")

    def _read_exact_projected_plan(
        self,
        plan: dict[str, Any],
        context: BillingProviderOperationContext,
        update: dict[str, Any],
    ) -> Optional[dict[str, Any]]:
        result = (
            self.supabase.table("billing_plans")
            .select("*")
            .eq("id", plan["id"])
            .eq("studio_id", context.studio_id)
            .limit(1)
            .execute()
        )
        row = result.data[0] if result.data else None
        return row if self._is_exact_projected_plan(row, plan, update) else None

    @staticmethod
    def _is_exact_projected_plan(
        row: Any,
        plan: dict[str, Any],
        update: dict[str, Any],
    ) -> bool:
        if not isinstance(row, dict):
            return False
        source = {
            "archived_at": plan.get("archived_at"),
            "name": plan.get("name"),
            "description": plan.get("description"),
            "amount_cents": int(plan.get("amount_cents") or 0),
            "currency": plan.get("currency") or "usd",
            "billing_interval": plan.get("billing_interval") or "monthly",
        }
        return all(row.get(field) == value for field, value in source.items()) and all(
            row.get(field) == value for field, value in update.items()
        )

    def _recover_owned_price_projection(
        self,
        payload: dict[str, Any],
        *,
        original_error: Exception,
    ) -> dict[str, Any]:
        try:
            result = (
                self.supabase.table("billing_plan_prices")
                .select("*")
                .eq("studio_id", payload["studio_id"])
                .eq("stripe_account_id", payload["stripe_account_id"])
                .eq("stripe_price_id", payload["stripe_price_id"])
                .limit(1)
                .execute()
            )
        except Exception as exc:
            raise RuntimeError("plan_sync_price_projection_ambiguous") from exc
        row = result.data[0] if result.data else None
        if not self._is_exact_owned_price(row, payload):
            raise RuntimeError("plan_sync_price_projection_ambiguous") from original_error
        return row

    @staticmethod
    def _is_exact_owned_price(row: Any, payload: dict[str, Any]) -> bool:
        return (
            isinstance(row, dict)
            and bool(row.get("id"))
            and all(row.get(field) == value for field, value in payload.items())
        )

    def _remove_exact_owned_price(
        self,
        price_row_id: str,
        payload: dict[str, Any],
    ) -> None:
        removed = (
            self.supabase.table("billing_plan_prices")
            .delete()
            .eq("id", price_row_id)
            .eq("studio_id", payload["studio_id"])
            .eq("billing_plan_id", payload["billing_plan_id"])
            .eq("stripe_account_id", payload["stripe_account_id"])
            .eq("stripe_product_id", payload["stripe_product_id"])
            .eq("stripe_price_id", payload["stripe_price_id"])
            .eq("amount_cents", payload["amount_cents"])
            .eq("currency", payload["currency"])
            .eq("billing_interval", payload["billing_interval"])
            .eq("interval_count", payload["interval_count"])
            .eq("recurring", payload["recurring"])
            .eq("active", True)
            .eq("version", payload["version"])
            .eq(
                "metadata->>connect_account_generation",
                str(payload["metadata"]["connect_account_generation"]),
            )
            .eq(
                "metadata->>provider_operation_id",
                payload["metadata"]["provider_operation_id"],
            )
            .execute()
        )
        if not removed.data:
            raise RuntimeError("plan_sync_stale_price_compensation_failed")

    @staticmethod
    def _bind_claimed_plan_resource(
        plan: dict[str, Any],
        claimed: dict[str, Any],
        operation: dict[str, Any],
    ) -> dict[str, Any]:
        resource = claimed.get("resource")
        if (
            not isinstance(resource, dict)
            or not resource.get("id")
            or resource.get("studio_id") != plan.get("studio_id")
            or resource.get("operation_type") != PLAN_SYNC_OPERATION_TYPE
            or resource.get("resource_type") != "plan"
            or resource.get("resource_id") != plan.get("id")
            or resource.get("operation_id") != operation.get("id")
        ):
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Plan sync resource ownership could not be verified.",
            )
        return {**plan, "_sync_resource_claim_id": str(resource["id"])}

    @staticmethod
    def _plan_projection_snapshot(plan: dict[str, Any]) -> dict[str, Any]:
        return {
            "status": plan.get("status"),
            "archived_at": plan.get("archived_at"),
            "name": plan.get("name"),
            "description": plan.get("description"),
            "amount_cents": int(plan.get("amount_cents") or 0),
            "currency": plan.get("currency") or "usd",
            "billing_interval": plan.get("billing_interval") or "monthly",
            "stripe_account_id": plan.get("stripe_account_id"),
            "stripe_product_id": plan.get("stripe_product_id"),
            "stripe_price_id": plan.get("stripe_price_id"),
            "stripe_price_lookup_key": plan.get("stripe_price_lookup_key"),
            "stripe_price_version": int(plan.get("stripe_price_version") or 1),
        }

    def _load_projected_plan(
        self,
        plan_id: str,
        context: BillingProviderOperationContext,
        operation: dict[str, Any],
    ) -> dict[str, Any]:
        plan = self.owner._get_row_or_404(
            "billing_plans", plan_id, context.studio_id, "Billing plan not found."
        )
        if (
            plan.get("status") != "active"
            or plan.get("stripe_account_id") != context.stripe_connected_account_id
            or not plan.get("stripe_product_id")
            or not plan.get("stripe_price_id")
        ):
            raise RuntimeError("plan_sync_saved_result_mismatch")
        price = self._exact_active_price(
            plan,
            context.stripe_connected_account_id,
            context.connect_account_generation,
        )
        if not price or price.get("stripe_price_id") != plan.get("stripe_price_id"):
            raise RuntimeError("plan_sync_saved_price_mismatch")
        summary = str(operation.get("result_summary") or "")
        if summary.startswith("plan_sync_mode:product_update_only:"):
            if (
                self._product_update_target(operation)
                != plan.get("stripe_product_id")
                or operation.get("provider_object_id")
                != plan.get("stripe_product_id")
            ):
                raise RuntimeError("plan_sync_saved_product_mismatch")
        elif summary == "plan_sync_mode:product_price_steps":
            if operation.get("provider_object_id") != plan.get("stripe_price_id"):
                raise RuntimeError("plan_sync_saved_step_price_mismatch")
        elif (
            operation.get("state") == "provider_succeeded"
            and operation.get("result_code") == "provider_step_phase_completed"
        ):
            if operation.get("provider_object_id") != plan.get("stripe_price_id"):
                raise RuntimeError("plan_sync_provider_step_price_mismatch")
        else:
            raise RuntimeError("plan_sync_saved_mode_missing")
        return plan

    def _exact_active_price(
        self,
        plan: dict[str, Any],
        account_id: str,
        generation: int,
    ) -> Optional[dict[str, Any]]:
        recurring, _ = self.owner._stripe_recurring_for_interval(
            plan.get("billing_interval") or "monthly"
        )
        result = (
            self.supabase.table("billing_plan_prices")
            .select("*")
            .eq("studio_id", plan["studio_id"])
            .eq("billing_plan_id", plan["id"])
            .eq("stripe_account_id", account_id)
            .eq("amount_cents", int(plan.get("amount_cents") or 0))
            .eq("currency", plan.get("currency") or "usd")
            .eq("billing_interval", plan.get("billing_interval") or "monthly")
            .eq("recurring", bool(recurring))
            .eq("active", True)
            .order("created_at", desc=True)
            .limit(20)
            .execute()
        )
        rows = result.data or []
        if not rows:
            return None
        product_ids = {str(row.get("stripe_product_id") or "") for row in rows}
        price_ids = {str(row.get("stripe_price_id") or "") for row in rows}
        if len(product_ids) != 1 or len(price_ids) != 1:
            raise HTTPException(status_code=409, detail="Plan has contradictory active Stripe price identity.")
        row = rows[0]
        row = self._verify_price_row(
            row,
            plan=plan,
            account_id=account_id,
            generation=generation,
            product_id=str(plan.get("stripe_product_id") or row.get("stripe_product_id") or ""),
        )
        return row

    def _verify_price_row(
        self,
        row: dict[str, Any],
        *,
        plan: dict[str, Any],
        account_id: str,
        generation: int,
        product_id: str,
    ) -> dict[str, Any]:
        row = self._adopt_legacy_price_generation(
            row,
            plan=plan,
            account_id=account_id,
            generation=generation,
            product_id=product_id,
        )
        row_generation = (row.get("metadata") or {}).get("connect_account_generation")
        try:
            exact_generation = int(row_generation) == generation
        except (TypeError, ValueError):
            exact_generation = False
        recurring = plan.get("billing_interval") not in {"paid_in_full"}
        if (
            row.get("studio_id") != plan.get("studio_id")
            or row.get("billing_plan_id") != plan.get("id")
            or row.get("stripe_account_id") != account_id
            or row.get("stripe_product_id") != product_id
            or not row.get("stripe_price_id")
            or int(row.get("amount_cents") or 0) != int(plan.get("amount_cents") or 0)
            or str(row.get("currency") or "") != str(plan.get("currency") or "usd")
            or row.get("billing_interval") != (plan.get("billing_interval") or "monthly")
            or bool(row.get("recurring")) != recurring
            or not exact_generation
        ):
            raise HTTPException(status_code=409, detail="Plan Stripe price identity is not exact.")
        return row

    def _adopt_legacy_price_generation(
        self,
        row: dict[str, Any],
        *,
        plan: dict[str, Any],
        account_id: str,
        generation: int,
        product_id: str,
    ) -> dict[str, Any]:
        metadata = row.get("metadata")
        if not isinstance(metadata, dict) or "connect_account_generation" in metadata:
            return row
        if (
            not plan.get("stripe_product_id")
            or not plan.get("stripe_price_id")
            or plan.get("stripe_product_id") != product_id
            or plan.get("stripe_price_id") != row.get("stripe_price_id")
            or row.get("studio_id") != plan.get("studio_id")
            or row.get("billing_plan_id") != plan.get("id")
            or row.get("stripe_account_id") != account_id
            or row.get("stripe_product_id") != product_id
        ):
            return row
        recurring = plan.get("billing_interval") != "paid_in_full"
        adopted_metadata = {**metadata, "connect_account_generation": generation}
        result = (
            self.supabase.table("billing_plan_prices")
            .update({"metadata": adopted_metadata})
            .eq("id", row["id"])
            .eq("studio_id", plan["studio_id"])
            .eq("billing_plan_id", plan["id"])
            .eq("stripe_account_id", account_id)
            .eq("stripe_product_id", product_id)
            .eq("stripe_price_id", plan["stripe_price_id"])
            .eq("amount_cents", int(plan.get("amount_cents") or 0))
            .eq("currency", plan.get("currency") or "usd")
            .eq("billing_interval", plan.get("billing_interval") or "monthly")
            .eq("recurring", recurring)
            .eq("active", True)
            .is_("metadata->connect_account_generation", "null")
            .execute()
        )
        if result.data:
            return result.data[0]
        refreshed = (
            self.supabase.table("billing_plan_prices")
            .select("*")
            .eq("id", row["id"])
            .eq("studio_id", plan["studio_id"])
            .limit(1)
            .execute()
        )
        return refreshed.data[0] if refreshed.data else row

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
            raise HTTPException(status_code=409, detail="Stripe account generation is not ready for plan sync.")
        return generation

    @staticmethod
    def _validate_plan_identity(plan: dict[str, Any], account_id: str) -> None:
        if plan.get("stripe_account_id") not in {None, account_id}:
            raise HTTPException(status_code=409, detail="Plan belongs to another Stripe account identity.")
        if plan.get("stripe_price_id") and not plan.get("stripe_product_id"):
            raise HTTPException(status_code=409, detail="Plan has contradictory Stripe product and price identity.")

    @staticmethod
    def _desired_plan_hash(plan: dict[str, Any], account_id: str, generation: int) -> str:
        return stable_hash({
            "studio_id": plan["studio_id"],
            "plan_id": plan["id"],
            "stripe_connected_account_id": account_id,
            "connect_account_generation": generation,
            "name": plan["name"],
            "description": plan.get("description"),
            "amount_cents": int(plan.get("amount_cents") or 0),
            "currency": plan.get("currency") or "usd",
            "billing_interval": plan.get("billing_interval") or "monthly",
        })

    @staticmethod
    def _product_update_summary(product_id: str) -> str:
        if not product_id.startswith("prod_") or not product_id[5:].isalnum():
            raise RuntimeError("plan_sync_target_product_invalid")
        return f"plan_sync_mode:product_update_only:target_product_id:{product_id}"

    @classmethod
    def _product_update_target(cls, operation: dict[str, Any]) -> str:
        prefix = "plan_sync_mode:product_update_only:target_product_id:"
        summary = str(operation.get("result_summary") or "")
        if not summary.startswith(prefix):
            raise RuntimeError("plan_sync_saved_target_invalid")
        target = summary[len(prefix):]
        cls._product_update_summary(target)
        return target

    @staticmethod
    def _product_metadata(plan: dict[str, Any]) -> dict[str, str]:
        return {
            "studio_id": str(plan["studio_id"]),
            "billing_plan_id": str(plan["id"]),
            "product": "koaryu_payments",
        }

    @staticmethod
    def _raise_for_blocked_step(envelope: dict[str, Any]) -> None:
        outcome = str(envelope.get("outcome") or "")
        state = str((envelope.get("step") or {}).get("state") or "")
        if outcome in {"busy", "provider_request_in_flight"} or state == "provider_request_in_flight":
            raise HTTPException(status_code=409, detail="Plan sync step is already in progress.")
        if outcome == "reconciliation_required" or state == "reconciliation_required":
            raise HTTPException(status_code=409, detail=PLAN_SYNC_AMBIGUOUS_DETAIL)
        if state in {"definitive_failed", "definitive_rejected"}:
            raise HTTPException(status_code=409, detail="Plan sync step was rejected.")
        if state not in {"pending", "recovery_authorized"}:
            raise HTTPException(status_code=503, detail=PLAN_SYNC_AMBIGUOUS_DETAIL)

    def _mark_step_reconciliation(
        self,
        client: BillingProviderStepCoordinator,
        step: BillingProviderOperationStepContext,
        current: dict[str, Any],
        operation: dict[str, Any],
        plan_sha256: str,
        reason: str,
        exc: Exception,
    ) -> None:
        try:
            client.transition_step(
                step,
                current,
                "reconciliation_required",
                reconciliation_reason_code=reason,
            )
        except Exception:
            pass
        self._complete_failed_phase(client, step.parent, operation, plan_sha256)
        raise HTTPException(status_code=503, detail=PLAN_SYNC_AMBIGUOUS_DETAIL) from exc

    @staticmethod
    def _complete_failed_phase(
        client: BillingProviderStepCoordinator,
        context: BillingProviderOperationContext,
        operation: dict[str, Any],
        plan_sha256: str,
    ) -> None:
        try:
            client.complete_provider_phase(
                context,
                operation,
                plan_sha256=plan_sha256,
                expected_step_count=2,
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
    ) -> None:
        try:
            if operation.get("state") == "recovery_authorized":
                operations.mark_recovery_reconciliation_v2(
                    context,
                    operation,
                    reconciliation_reason_code=reason,
                )
            else:
                operations.transition(
                    context,
                    operation,
                    "reconciliation_required",
                    reconciliation_reason_code=reason,
                )
        except Exception:
            pass
        raise HTTPException(status_code=503, detail=PLAN_SYNC_AMBIGUOUS_DETAIL) from exc

    def _ensure_audit(
        self,
        context: BillingProviderOperationContext,
        plan: dict[str, Any],
        operation: dict[str, Any],
    ) -> None:
        plan_id = str(plan.get("id") or "")
        product_id = str(plan.get("stripe_product_id") or "")
        price_id = str(plan.get("stripe_price_id") or "")
        summary = str(operation.get("result_summary") or "")
        product_result = (
            product_id
            if summary.startswith("plan_sync_mode:product_update_only:")
            else price_id
        )
        metadata = {
            "operation_id": context.operation_id,
            "plan_id": plan_id,
            "studio_id": context.studio_id,
            "actor_id": context.actor_id,
            "caller_request_key": context.caller_request_key,
            "request_sha256": context.request_sha256,
            "stripe_connected_account_id": context.stripe_connected_account_id,
            "connect_account_generation": context.connect_account_generation,
            "stripe_product_id": product_id,
            "stripe_price_id": price_id,
            "provider_result_id": product_result,
        }
        if (
            not plan_id
            or plan.get("studio_id") != context.studio_id
            or plan.get("status") != "active"
            or plan.get("stripe_account_id") != context.stripe_connected_account_id
            or not product_id
            or not price_id
            or operation.get("id") != context.operation_id
            or operation.get("studio_id") != context.studio_id
            or operation.get("actor_id") != context.actor_id
            or operation.get("operation_type") != PLAN_SYNC_OPERATION_TYPE
            or operation.get("caller_request_key") != context.caller_request_key
            or operation.get("request_sha256") != context.request_sha256
            or operation.get("stripe_connected_account_id")
            != context.stripe_connected_account_id
            or operation.get("connect_account_generation")
            != context.connect_account_generation
            or operation.get("state") != "completed"
            or operation.get("result_code") != "plan_sync_completed"
            or operation.get("provider_object_id") != product_result
            or not (
                summary == "plan_sync_mode:product_price_steps"
                or (
                    summary.startswith("plan_sync_mode:product_update_only:")
                    and self._product_update_target(operation) == product_id
                )
            )
        ):
            raise RuntimeError("plan_sync_audit_identity_mismatch")

        audit_id = str(uuid5(
            NAMESPACE_URL,
            f"koaryu:billing.plan_synced:{context.operation_id}",
        ))
        existing = (
            self.supabase.table("audit_logs")
            .select("*")
            .eq("id", audit_id)
            .limit(1)
            .execute()
        )
        if existing.data:
            self._validate_audit_row(
                existing.data[0], audit_id, context, plan_id, metadata
            )
            return
        payload = {
            "id": audit_id,
            "studio_id": context.studio_id,
            "actor_id": context.actor_id,
            "action": "billing.plan_synced",
            "entity_type": "billing",
            "entity_id": plan_id,
            "metadata": metadata,
        }
        try:
            self.supabase.table("audit_logs").insert(payload).execute()
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
                raise RuntimeError("plan_sync_audit_conflict_unverified") from exc
            try:
                self._validate_audit_row(
                    winner.data[0], audit_id, context, plan_id, metadata
                )
            except RuntimeError as invariant_exc:
                raise RuntimeError(
                    "plan_sync_audit_conflict_unverified"
                ) from invariant_exc

    @staticmethod
    def _validate_audit_row(
        audit: dict[str, Any],
        audit_id: str,
        context: BillingProviderOperationContext,
        plan_id: str,
        metadata: dict[str, Any],
    ) -> None:
        if (
            str(audit.get("id") or "") != audit_id
            or audit.get("studio_id") != context.studio_id
            or audit.get("actor_id") != context.actor_id
            or audit.get("action") != "billing.plan_synced"
            or audit.get("entity_type") != "billing"
            or str(audit.get("entity_id") or "") != plan_id
            or audit.get("metadata") != metadata
        ):
            raise RuntimeError("plan_sync_audit_row_mismatch")

    def _response(self, plan: dict[str, Any], account: dict[str, Any]) -> BillingPlanResponse:
        return self.owner._plan_response(plan, account)
