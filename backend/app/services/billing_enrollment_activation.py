from __future__ import annotations

from typing import Any
from uuid import NAMESPACE_URL, uuid4, uuid5

from fastapi import HTTPException
from postgrest.exceptions import APIError as PostgrestAPIError

from app.schemas.billing import StudentBillingEnrollmentResponse
from app.services.billing_invoice_projection import _object_get, _stripe_id
from app.services.billing_provider_operations import (
    BillingProviderOperationContext,
    BillingProviderOperationCoordinator,
    ENROLLMENT_ACTIVATE_AUTOPAY_OPERATION_TYPE,
    ENROLLMENT_ACTIVATE_INVOICE_OPERATION_TYPE,
)
from app.services.platform_billing_helpers import normalize_idempotency_key, stable_hash
from app.services.stripe_mutation_policy import StripeMutationBlocked
from app.services.stripe_service import StripeService


ENROLLMENT_ACTIVATION_AMBIGUOUS_DETAIL = (
    "Enrollment activation outcome is not confirmed. "
    "Retry with the same Idempotency-Key after reconciliation."
)
ACTIVATION_INTENT_KEY = "provider_activation_intent"
OPEN_WHOLE_SUBSCRIPTION_TRANSITION_STATES = (
    "scheduled",
    "due_claimed",
    "provider_request_in_flight",
    "provider_succeeded",
    "projected",
    "recovery_authorized",
    "reconciliation_required",
)
ACTIVATABLE_SUBSCRIPTION_STATUSES = frozenset({"active", "trialing", "past_due", "incomplete"})


class BillingEnrollmentActivationWorkflow:
    def __init__(self, owner: Any, *, stripe_service_cls: type[StripeService] = StripeService):
        self.owner = owner
        self.supabase = owner.supabase
        self.stripe_service_cls = stripe_service_cls
        self.lifecycle = owner._stripe_lifecycle()

    def activate(
        self,
        enrollment_id: str,
        studio_id: str,
        actor_id: str,
        idempotency_key: str | None,
    ) -> StudentBillingEnrollmentResponse:
        request_key = normalize_idempotency_key(idempotency_key)
        if not request_key:
            raise HTTPException(status_code=400, detail="Idempotency-Key is required for enrollment activation.")
        enrollment = self.owner._get_row_or_404(
            "student_billing_enrollments", enrollment_id, studio_id,
            "Billing enrollment not found.",
        )
        activation_intent = (enrollment.get("metadata") or {}).get(ACTIVATION_INTENT_KEY)
        if enrollment.get("status") not in {"pending", "active"}:
            raise HTTPException(status_code=409, detail="Enrollment is not eligible for activation.")
        if (
            (enrollment.get("stripe_subscription_id") or enrollment.get("stripe_subscription_item_id"))
            and not isinstance(activation_intent, dict)
        ):
            raise HTTPException(
                status_code=409,
                detail="Enrollment provider identity requires reconciliation before activation.",
            )
        collection_mode = str(enrollment.get("collection_mode") or "")
        if collection_mode not in {"autopay", "invoice_link"}:
            raise HTTPException(status_code=409, detail="Only recurring provider enrollments can be activated.")
        if not enrollment.get("payer_id"):
            raise HTTPException(status_code=409, detail="Assign a payer before activation.")
        plan = self.owner._get_row_or_404(
            "billing_plans", enrollment["billing_plan_id"], studio_id,
            "Billing plan not found.",
        )
        if plan.get("billing_interval") == "paid_in_full":
            raise HTTPException(
                status_code=409,
                detail="Paid-in-full enrollment activation requires the separate invoice workflow.",
            )
        account = self._local_ready_account(studio_id)
        account_id = str(account["stripe_connected_account_id"])
        generation = self._account_generation(account)
        price = self._exact_active_plan_price(plan, account_id, generation)
        payer = self.owner._get_row_or_404(
            "billing_payers", enrollment["payer_id"], studio_id, "Payer not found."
        )
        self._require_exact_payer(payer, account_id, generation, collection_mode)
        operation_type = (
            ENROLLMENT_ACTIVATE_AUTOPAY_OPERATION_TYPE
            if collection_mode == "autopay"
            else ENROLLMENT_ACTIVATE_INVOICE_OPERATION_TYPE
        )

        group = self.owner._find_or_create_billing_subscription(
            enrollment, plan, payer, account
        )
        group = self._bind_local_group_generation(
            group, account_id=account_id, generation=generation, payer=payer,
        )
        lock_token = self.lifecycle._claim_subscription_quantity_sync_lock(
            studio_id, group["id"]
        )
        try:
            enrollment = self.owner._get_row_or_404(
                "student_billing_enrollments", enrollment_id, studio_id,
                "Billing enrollment not found.",
            )
            intent = self._prepare_activation_intent(
                enrollment,
                plan=plan,
                price=price,
                payer=payer,
                group=group,
                account_id=account_id,
                generation=generation,
                operation_type=operation_type,
            )
            operations = BillingProviderOperationCoordinator(self.supabase)
            lease_owner = str(uuid4())
            claimed = operations.claim_resource(
                studio_id=studio_id,
                actor_id=actor_id,
                operation_type=operation_type,
                resource_type="enrollment",
                resource_id=enrollment_id,
                payer_id=str(payer["id"]),
                caller_request_key=request_key,
                request_sha256=intent["desired_sha256"],
                stripe_connected_account_id=account_id,
                connect_account_generation=generation,
                lease_owner=lease_owner,
            )
            operation = claimed["operation"]
            context = BillingProviderOperationContext(
                operation_id=str(operation["id"]),
                studio_id=studio_id,
                actor_id=str(operation["actor_id"]),
                operation_type=str(operation["operation_type"]),
                caller_request_key=str(claimed["canonical_caller_request_key"]),
                request_sha256=str(operation["request_sha256"]),
                stripe_connected_account_id=account_id,
                connect_account_generation=generation,
                lease_owner=lease_owner,
            )
            state = str(operation.get("state") or "")
            outcome = str(claimed.get("outcome") or "")
            if state == "completed":
                try:
                    result = self._load_projected_activation(
                        enrollment_id, context, operation, intent
                    )
                except Exception as exc:
                    raise HTTPException(
                        status_code=503,
                        detail=ENROLLMENT_ACTIVATION_AMBIGUOUS_DETAIL,
                    ) from exc
                self._recompute_balance_or_raise(studio_id, payer["id"])
                self._audit_once(context, result)
                return StudentBillingEnrollmentResponse(**result)
            if state == "projected":
                try:
                    result = self._load_projected_activation(enrollment_id, context, operation, intent)
                except Exception as exc:
                    self._mark_reconciliation(
                        operations, context, operation,
                        "enrollment_activation_projection_unverified", exc,
                    )
                self._recompute_balance_or_raise(studio_id, payer["id"])
                operations.complete(
                    context, operation, result_code="enrollment_activation_completed"
                )
                self._audit_once(context, result)
                return StudentBillingEnrollmentResponse(**result)
            if state == "reconciliation_required" or outcome == "reconciliation_required":
                if not operation.get("provider_object_id"):
                    raise HTTPException(status_code=409, detail=ENROLLMENT_ACTIVATION_AMBIGUOUS_DETAIL)
                operation = operations.transition(
                    context,
                    operation,
                    "provider_succeeded",
                    provider_object_id=operation.get("provider_object_id"),
                    provider_secondary_object_id=operation.get("provider_secondary_object_id"),
                    result_code="enrollment_activation_provider_verified",
                )
                result = self._readback_and_project(
                    enrollment, context, operation, intent, plan=plan, payer=payer, group=group
                )
            elif state == "provider_succeeded":
                result = self._readback_and_project(
                    enrollment, context, operation, intent, plan=plan, payer=payer, group=group
                )
            elif state in {"provider_request_in_flight"} or outcome in {
                "busy", "provider_request_in_flight"
            }:
                raise HTTPException(status_code=409, detail=ENROLLMENT_ACTIVATION_AMBIGUOUS_DETAIL)
            elif state in {"definitive_failed", "definitive_rejected"}:
                raise HTTPException(status_code=409, detail="Enrollment activation was rejected.")
            elif state in {"started", "recovery_authorized"}:
                result, operation = self._execute_one_mutation(
                    enrollment,
                    plan=plan,
                    payer=payer,
                    group=group,
                    account=account,
                    context=context,
                    operation=operation,
                    operations=operations,
                    intent=intent,
                )
            else:
                raise HTTPException(status_code=503, detail=ENROLLMENT_ACTIVATION_AMBIGUOUS_DETAIL)

            operation = operations.transition(
                context,
                operation,
                "projected",
                result_code="enrollment_activation_projected",
                result_summary=self._result_summary(intent),
            )
            self._recompute_balance_or_raise(studio_id, payer["id"])
            operations.complete(
                context, operation, result_code="enrollment_activation_completed"
            )
            self._audit_once(context, result)
            return StudentBillingEnrollmentResponse(**result)
        finally:
            self.lifecycle._release_subscription_quantity_sync_lock(
                studio_id, group["id"], lock_token
            )

    def _execute_one_mutation(
        self,
        enrollment: dict[str, Any],
        *,
        plan: dict[str, Any],
        payer: dict[str, Any],
        group: dict[str, Any],
        account: dict[str, Any],
        context: BillingProviderOperationContext,
        operation: dict[str, Any],
        operations: BillingProviderOperationCoordinator,
        intent: dict[str, Any],
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        branch = intent["branch"]
        if branch in {"add_item", "update_quantity"}:
            try:
                self._require_subscription_open_for_activation(
                    group,
                    context=context,
                    intent=intent,
                    check_provider=False,
                )
            except Exception as exc:
                self._reject_scheduled_subscription_activation(
                    operations, context, operation, exc,
                )
        operation = operations.transition(
            context,
            operation,
            "provider_request_in_flight",
            result_code="enrollment_activation_started",
            result_summary=self._result_summary(intent),
        )
        if branch in {"add_item", "update_quantity"}:
            try:
                self._require_subscription_open_for_activation(
                    group,
                    context=context,
                    intent=intent,
                    check_provider=True,
                )
            except Exception as exc:
                self._reject_scheduled_subscription_activation(
                    operations, context, operation, exc,
                )
        key = self.owner._idempotency_key(
            "enrollment-activate", context.operation_id, branch.replace("_", "-")
        )
        try:
            if branch == "create_subscription":
                provider = self.stripe_service_cls().create_connected_subscription(
                    account_id=context.stripe_connected_account_id,
                    studio_id=context.studio_id,
                    customer_id=payer["stripe_customer_id"],
                    price_id=plan["stripe_price_id"],
                    collection_method=(
                        "charge_automatically"
                        if enrollment["collection_mode"] == "autopay"
                        else "send_invoice"
                    ),
                    application_fee_percent=self.owner._application_fee_percent(account),
                    default_payment_method=(
                        payer.get("default_payment_method_id")
                        if enrollment["collection_mode"] == "autopay"
                        else None
                    ),
                    trial_days=int(plan.get("trial_days") or 0),
                    days_until_due=7,
                    metadata=self._subscription_metadata(enrollment, group),
                    item_metadata=self._item_metadata(enrollment, group, plan),
                    idempotency_key=key,
                )
                subscription_id = _stripe_id(provider)
                item_id = self.lifecycle._subscription_item_id_for_enrollment(
                    provider, enrollment["id"]
                )
            elif branch == "add_item":
                provider = self.stripe_service_cls().create_connected_subscription_item(
                    account_id=context.stripe_connected_account_id,
                    studio_id=context.studio_id,
                    subscription_id=intent["expected_subscription_id"],
                    price_id=plan["stripe_price_id"],
                    metadata=self._item_metadata(enrollment, group, plan),
                    idempotency_key=key,
                )
                subscription_id = intent["expected_subscription_id"]
                item_id = _stripe_id(provider)
            else:
                provider = self.stripe_service_cls().update_connected_subscription_item(
                    account_id=context.stripe_connected_account_id,
                    studio_id=context.studio_id,
                    subscription_item_id=intent["expected_item_id"],
                    quantity=intent["expected_quantity"],
                    proration_behavior="none",
                    idempotency_key=key,
                )
                subscription_id = intent["expected_subscription_id"]
                item_id = _stripe_id(provider)
        except StripeMutationBlocked:
            operations.transition(
                context, operation, "definitive_rejected",
                error_code="provider_mutation_blocked",
            )
            raise
        except Exception as exc:
            self._mark_reconciliation(
                operations, context, operation,
                "enrollment_activation_provider_outcome_ambiguous", exc,
            )
        if not subscription_id or not item_id:
            self._mark_reconciliation(
                operations, context, operation,
                "enrollment_activation_provider_identity_ambiguous",
                RuntimeError("enrollment_activation_provider_identity_ambiguous"),
            )
        try:
            operation = operations.transition(
                context,
                operation,
                "provider_succeeded",
                provider_object_id=subscription_id,
                provider_secondary_object_id=item_id,
                result_code="enrollment_activation_provider_succeeded",
            )
        except Exception as exc:
            raise HTTPException(status_code=503, detail=ENROLLMENT_ACTIVATION_AMBIGUOUS_DETAIL) from exc
        result = self._readback_and_project(
            enrollment, context, operation, intent, plan=plan, payer=payer, group=group
        )
        return result, operation

    def _require_subscription_open_for_activation(
        self,
        group: dict[str, Any],
        *,
        context: BillingProviderOperationContext,
        intent: dict[str, Any],
        check_provider: bool,
    ) -> None:
        current_group = self.owner._get_row_or_404(
            "billing_subscriptions",
            group["id"],
            context.studio_id,
            "Billing subscription not found.",
        )
        pending = (
            self.supabase.table("billing_enrollment_transition_intents")
            .select("id")
            .eq("studio_id", context.studio_id)
            .eq("billing_subscription_id", group["id"])
            .eq("transition_kind", "schedule_period_end")
            .eq("mutation_strategy", "subscription_cancel_at_period_end")
            .in_("state", OPEN_WHOLE_SUBSCRIPTION_TRANSITION_STATES)
            .limit(1)
            .execute()
        )
        if current_group.get("cancel_at_period_end") is True or pending.data:
            raise RuntimeError("subscription_scheduled_for_cancellation")
        if not check_provider:
            return
        provider = self.stripe_service_cls().retrieve_connected_subscription(
            account_id=context.stripe_connected_account_id,
            subscription_id=str(intent["expected_subscription_id"]),
            expand=["items.data"],
        )
        metadata = _object_get(provider, "metadata") or {}
        if (
            _stripe_id(provider) != intent.get("expected_subscription_id")
            or _stripe_id(_object_get(provider, "customer")) != intent.get("customer_id")
            or str(metadata.get("studio_id") or "") != context.studio_id
            or str(metadata.get("payer_id") or "") != str(intent["payer_id"])
            or str(metadata.get("billing_subscription_id") or "") != str(group["id"])
            or str(_object_get(provider, "status") or "")
            not in ACTIVATABLE_SUBSCRIPTION_STATUSES
            or bool(_object_get(provider, "cancel_at_period_end"))
        ):
            raise RuntimeError("subscription_not_open_for_activation")

    @staticmethod
    def _reject_scheduled_subscription_activation(
        operations: BillingProviderOperationCoordinator,
        context: BillingProviderOperationContext,
        operation: dict[str, Any],
        cause: Exception,
    ) -> None:
        operations.transition(
            context,
            operation,
            "definitive_rejected",
            error_code="subscription_scheduled_for_cancellation",
        )
        raise HTTPException(
            status_code=409,
            detail=(
                "Billing subscription is scheduled for cancellation. "
                "Revoke the scheduled cancellation before activating another enrollment."
            ),
        ) from cause

    def _readback_and_project(
        self,
        enrollment: dict[str, Any],
        context: BillingProviderOperationContext,
        operation: dict[str, Any],
        intent: dict[str, Any],
        *,
        plan: dict[str, Any],
        payer: dict[str, Any],
        group: dict[str, Any],
    ) -> dict[str, Any]:
        try:
            provider = self.stripe_service_cls().retrieve_connected_subscription(
                account_id=context.stripe_connected_account_id,
                subscription_id=str(operation["provider_object_id"]),
                expand=["items.data", "latest_invoice"],
            )
            self._verify_subscription(
                provider,
                context=context,
                operation=operation,
                intent=intent,
                plan=plan,
                payer=payer,
                group=group,
            )
            projected_group = self.owner._project_subscription(
                provider, context.stripe_connected_account_id
            ) or group
            if projected_group.get("id") != group.get("id"):
                raise RuntimeError("enrollment_activation_group_projection_mismatch")
            metadata = dict(enrollment.get("metadata") or {})
            saved_intent = dict(intent)
            saved_intent["operation_id"] = context.operation_id
            metadata[ACTIVATION_INTENT_KEY] = saved_intent
            provider_status = str(_object_get(provider, "status") or "")
            update = {
                "billing_subscription_id": group["id"],
                "stripe_subscription_id": operation["provider_object_id"],
                "stripe_subscription_item_id": operation["provider_secondary_object_id"],
                "status": "active",
                "billing_status": (
                    "current"
                    if provider_status in {"active", "trialing"}
                    else "past_due"
                ),
                "metadata": metadata,
            }
            result = (
                self.supabase.table("student_billing_enrollments")
                .update(update)
                .eq("id", enrollment["id"])
                .eq("studio_id", context.studio_id)
                .execute()
            )
            if not result.data:
                raise RuntimeError("enrollment_activation_projection_failed")
            return result.data[0]
        except Exception as exc:
            self._mark_reconciliation(
                BillingProviderOperationCoordinator(self.supabase),
                context,
                operation,
                "enrollment_activation_local_projection_failed",
                exc,
            )

    def _prepare_activation_intent(
        self,
        enrollment: dict[str, Any],
        *,
        plan: dict[str, Any],
        price: dict[str, Any],
        payer: dict[str, Any],
        group: dict[str, Any],
        account_id: str,
        generation: int,
        operation_type: str,
    ) -> dict[str, Any]:
        metadata = dict(enrollment.get("metadata") or {})
        existing = metadata.get(ACTIVATION_INTENT_KEY)
        if isinstance(existing, dict):
            expected = {
                "version": 1,
                "operation_type": operation_type,
                "studio_id": enrollment["studio_id"],
                "enrollment_id": enrollment["id"],
                "student_id": enrollment["student_id"],
                "payer_id": payer["id"],
                "plan_id": plan["id"],
                "account_id": account_id,
                "generation": generation,
                "customer_id": payer["stripe_customer_id"],
                "product_id": plan["stripe_product_id"],
                "price_id": plan["stripe_price_id"],
                "group_id": group["id"],
            }
            if any(existing.get(key) != value for key, value in expected.items()):
                raise HTTPException(status_code=409, detail="Enrollment activation intent conflicts with current identity.")
            hash_payload = {
                key: value
                for key, value in existing.items()
                if key not in {"desired_sha256", "operation_id"}
            }
            if (
                existing.get("branch")
                not in {"create_subscription", "add_item", "update_quantity"}
                or int(existing.get("expected_quantity") or 0) <= 0
                or stable_hash(hash_payload) != existing.get("desired_sha256")
            ):
                raise HTTPException(status_code=409, detail="Enrollment activation intent is invalid.")
            return existing
        subscription_id = group.get("stripe_subscription_id")
        item_id = (
            self.owner._subscription_item_id_for_group_plan(
                enrollment["studio_id"], group["id"], plan["id"]
            )
            if subscription_id
            else None
        )
        if not subscription_id:
            branch = "create_subscription"
            quantity = 1
        elif not item_id:
            branch = "add_item"
            quantity = 1
        else:
            branch = "update_quantity"
            quantity = self.owner._active_enrollment_count_for_subscription_item(
                enrollment["studio_id"], group["id"], item_id,
                exclude_enrollment_id=enrollment["id"],
            ) + 1
        intent = {
            "version": 1,
            "operation_type": operation_type,
            "studio_id": enrollment["studio_id"],
            "enrollment_id": enrollment["id"],
            "student_id": enrollment["student_id"],
            "payer_id": payer["id"],
            "plan_id": plan["id"],
            "account_id": account_id,
            "generation": generation,
            "customer_id": payer["stripe_customer_id"],
            "product_id": plan["stripe_product_id"],
            "price_id": price["stripe_price_id"],
            "group_id": group["id"],
            "branch": branch,
            "expected_subscription_id": subscription_id,
            "expected_item_id": item_id,
            "expected_quantity": quantity,
        }
        intent["desired_sha256"] = stable_hash(intent)
        metadata[ACTIVATION_INTENT_KEY] = intent
        result = (
            self.supabase.table("student_billing_enrollments")
            .update({"metadata": metadata})
            .eq("id", enrollment["id"])
            .eq("studio_id", enrollment["studio_id"])
            .execute()
        )
        if not result.data:
            raise HTTPException(status_code=503, detail="Enrollment activation intent could not be stored.")
        return intent

    def _exact_active_plan_price(
        self, plan: dict[str, Any], account_id: str, generation: int
    ) -> dict[str, Any]:
        if (
            plan.get("status") != "active"
            or plan.get("stripe_account_id") != account_id
            or not plan.get("stripe_product_id")
            or not plan.get("stripe_price_id")
        ):
            raise HTTPException(status_code=409, detail="Billing plan must be synchronized first.")
        rows = (
            self.supabase.table("billing_plan_prices")
            .select("*")
            .eq("studio_id", plan["studio_id"])
            .eq("billing_plan_id", plan["id"])
            .eq("stripe_account_id", account_id)
            .eq("amount_cents", int(plan.get("amount_cents") or 0))
            .eq("currency", plan.get("currency") or "usd")
            .eq("billing_interval", plan.get("billing_interval") or "monthly")
            .eq("recurring", True)
            .eq("active", True)
            .limit(20)
            .execute()
        ).data or []
        product_ids = {str(row.get("stripe_product_id") or "") for row in rows}
        price_ids = {str(row.get("stripe_price_id") or "") for row in rows}
        if (
            not rows
            or len(product_ids) != 1
            or len(price_ids) != 1
            or product_ids != {str(plan["stripe_product_id"])}
            or price_ids != {str(plan["stripe_price_id"])}
        ):
            raise HTTPException(status_code=409, detail="Billing plan price identity is not exact.")
        row = self._adopt_legacy_plan_price_generation(
            rows[0],
            plan=plan,
            account_id=account_id,
            generation=generation,
        )
        row_generation = (row.get("metadata") or {}).get("connect_account_generation")
        try:
            exact_generation = int(row_generation) == generation
        except (TypeError, ValueError):
            exact_generation = False
        if (
            not exact_generation
            or int(row.get("amount_cents") or 0) != int(plan.get("amount_cents") or 0)
            or row.get("currency") != (plan.get("currency") or "usd")
            or row.get("billing_interval") != (plan.get("billing_interval") or "monthly")
            or row.get("recurring") is not True
        ):
            raise HTTPException(status_code=409, detail="Billing plan price identity is stale.")
        return row

    def _adopt_legacy_plan_price_generation(
        self,
        row: dict[str, Any],
        *,
        plan: dict[str, Any],
        account_id: str,
        generation: int,
    ) -> dict[str, Any]:
        metadata = row.get("metadata")
        if not isinstance(metadata, dict) or "connect_account_generation" in metadata:
            return row
        if (
            row.get("studio_id") != plan.get("studio_id")
            or row.get("billing_plan_id") != plan.get("id")
            or row.get("stripe_account_id") != account_id
            or row.get("stripe_product_id") != plan.get("stripe_product_id")
            or row.get("stripe_price_id") != plan.get("stripe_price_id")
            or not row.get("stripe_product_id")
            or not row.get("stripe_price_id")
        ):
            return row
        adopted_metadata = {**metadata, "connect_account_generation": generation}
        result = (
            self.supabase.table("billing_plan_prices")
            .update({"metadata": adopted_metadata})
            .eq("id", row["id"])
            .eq("studio_id", plan["studio_id"])
            .eq("billing_plan_id", plan["id"])
            .eq("stripe_account_id", account_id)
            .eq("stripe_product_id", plan["stripe_product_id"])
            .eq("stripe_price_id", plan["stripe_price_id"])
            .eq("amount_cents", int(plan.get("amount_cents") or 0))
            .eq("currency", plan.get("currency") or "usd")
            .eq("billing_interval", plan.get("billing_interval") or "monthly")
            .eq("recurring", True)
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

    def _require_exact_payer(
        self, payer: dict[str, Any], account_id: str, generation: int, mode: str
    ) -> None:
        if (
            payer.get("stripe_account_id") != account_id
            or payer.get("connect_account_generation") != generation
            or not payer.get("stripe_customer_id")
        ):
            raise HTTPException(status_code=409, detail="Payer must be synchronized first.")
        if mode == "autopay" and (
            not payer.get("default_payment_method_id")
            or not self.owner._payer_autopay_authorized(payer)
        ):
            raise HTTPException(status_code=409, detail="Autopay requires verified payer consent and payment method.")

    def _bind_local_group_generation(
        self,
        group: dict[str, Any],
        *,
        account_id: str,
        generation: int,
        payer: dict[str, Any],
    ) -> dict[str, Any]:
        raw_metadata = group.get("metadata")
        metadata = dict(raw_metadata) if isinstance(raw_metadata, dict) else {}
        can_adopt = (
            isinstance(raw_metadata, dict)
            and "connect_account_generation" not in metadata
            and group.get("studio_id") == payer.get("studio_id")
            and group.get("payer_id") == payer.get("id")
            and group.get("stripe_account_id") == account_id
            and group.get("stripe_customer_id") == payer.get("stripe_customer_id")
            and payer.get("stripe_account_id") == account_id
            and payer.get("connect_account_generation") == generation
            and bool(group.get("stripe_customer_id"))
        )
        if can_adopt:
            metadata["connect_account_generation"] = generation
            update = (
                self.supabase.table("billing_subscriptions")
                .update({"metadata": metadata})
                .eq("id", group["id"])
                .eq("studio_id", group["studio_id"])
                .eq("payer_id", payer["id"])
                .eq("stripe_account_id", account_id)
                .eq("stripe_customer_id", payer["stripe_customer_id"])
                .is_("metadata->connect_account_generation", "null")
            )
            if group.get("stripe_subscription_id"):
                update = update.eq(
                    "stripe_subscription_id", group["stripe_subscription_id"]
                )
            else:
                update = update.is_("stripe_subscription_id", "null")
            result = update.execute()
            if not result.data:
                group = self.owner._get_row_or_404(
                    "billing_subscriptions",
                    group["id"],
                    group["studio_id"],
                    "Billing subscription not found.",
                )
            else:
                group = result.data[0]
        if (
            group.get("studio_id") != payer.get("studio_id")
            or group.get("payer_id") != payer.get("id")
            or group.get("stripe_account_id") != account_id
            or group.get("stripe_customer_id") != payer.get("stripe_customer_id")
            or (group.get("metadata") or {}).get("connect_account_generation") != generation
        ):
            raise HTTPException(status_code=409, detail="Subscription group identity is stale.")
        return group

    def _load_projected_activation(
        self,
        enrollment_id: str,
        context: BillingProviderOperationContext,
        operation: dict[str, Any],
        intent: dict[str, Any],
    ) -> dict[str, Any]:
        enrollment = self.owner._get_row_or_404(
            "student_billing_enrollments", enrollment_id, context.studio_id,
            "Billing enrollment not found.",
        )
        saved = (enrollment.get("metadata") or {}).get(ACTIVATION_INTENT_KEY)
        if (
            not isinstance(saved, dict)
            or saved.get("desired_sha256") != intent.get("desired_sha256")
            or saved.get("operation_id") != context.operation_id
            or enrollment.get("status") != "active"
            or enrollment.get("billing_subscription_id") != intent.get("group_id")
            or enrollment.get("stripe_subscription_id") != operation.get("provider_object_id")
            or enrollment.get("stripe_subscription_item_id")
            != operation.get("provider_secondary_object_id")
            or operation.get("result_summary") != self._result_summary(intent)
        ):
            raise RuntimeError("enrollment_activation_saved_result_mismatch")
        return enrollment

    @staticmethod
    def _verify_subscription(
        provider: Any,
        *,
        context: BillingProviderOperationContext,
        operation: dict[str, Any],
        intent: dict[str, Any],
        plan: dict[str, Any],
        payer: dict[str, Any],
        group: dict[str, Any],
    ) -> None:
        metadata = _object_get(provider, "metadata") or {}
        branch = str(intent.get("branch") or "")
        if (
            _stripe_id(provider) != operation.get("provider_object_id")
            or _stripe_id(_object_get(provider, "customer")) != payer.get("stripe_customer_id")
            or str(metadata.get("studio_id") or "") != context.studio_id
            or str(metadata.get("payer_id") or "") != str(payer["id"])
            or str(metadata.get("billing_subscription_id") or "") != str(group["id"])
            or str(_object_get(provider, "status") or "")
            not in ACTIVATABLE_SUBSCRIPTION_STATUSES
            or (
                branch in {"add_item", "update_quantity"}
                and bool(_object_get(provider, "cancel_at_period_end"))
            )
            or (
                branch in {"add_item", "update_quantity"}
                and operation.get("provider_object_id")
                != intent.get("expected_subscription_id")
            )
            or (
                branch == "update_quantity"
                and operation.get("provider_secondary_object_id")
                != intent.get("expected_item_id")
            )
        ):
            raise RuntimeError("enrollment_activation_subscription_readback_mismatch")
        items = _object_get(_object_get(provider, "items") or {}, "data", []) or []
        matched = next(
            (item for item in items if _stripe_id(item) == operation.get("provider_secondary_object_id")),
            None,
        )
        if matched is None:
            raise RuntimeError("enrollment_activation_item_missing")
        price_id = _stripe_id(_object_get(matched, "price"))
        item_metadata = _object_get(matched, "metadata") or {}
        if price_id != plan.get("stripe_price_id") or int(
            _object_get(matched, "quantity", 0) or 0
        ) != int(intent["expected_quantity"]) or (
            str(item_metadata.get("studio_id") or "") != context.studio_id
            or str(item_metadata.get("payer_id") or "") != str(payer["id"])
            or str(item_metadata.get("billing_plan_id") or "") != str(plan["id"])
            or str(item_metadata.get("billing_subscription_id") or "") != str(group["id"])
            or (
                branch in {"create_subscription", "add_item"}
                and str(item_metadata.get("enrollment_id") or "")
                != str(intent["enrollment_id"])
            )
        ):
            raise RuntimeError("enrollment_activation_item_readback_mismatch")

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
        try:
            generation = int((account.get("metadata") or {}).get("connect_account_generation") or 0)
        except (TypeError, ValueError):
            generation = 0
        if generation <= 0:
            raise HTTPException(status_code=409, detail="Stripe account generation is not ready.")
        return generation

    @staticmethod
    def _subscription_metadata(
        enrollment: dict[str, Any], group: dict[str, Any]
    ) -> dict[str, str]:
        return {
            "studio_id": str(enrollment["studio_id"]),
            "payer_id": str(enrollment["payer_id"]),
            "billing_subscription_id": str(group["id"]),
            "product": "koaryu_payments",
        }

    @staticmethod
    def _item_metadata(
        enrollment: dict[str, Any], group: dict[str, Any], plan: dict[str, Any]
    ) -> dict[str, str]:
        return {
            "studio_id": str(enrollment["studio_id"]),
            "payer_id": str(enrollment["payer_id"]),
            "enrollment_id": str(enrollment["id"]),
            "student_id": str(enrollment["student_id"]),
            "billing_plan_id": str(plan["id"]),
            "billing_subscription_id": str(group["id"]),
            "product": "koaryu_payments",
        }

    @staticmethod
    def _result_summary(intent: dict[str, Any]) -> str:
        return (
            f"enrollment_branch:{intent['branch']}:quantity:"
            f"{int(intent['expected_quantity'])}"
        )

    @staticmethod
    def _mark_reconciliation(
        operations: BillingProviderOperationCoordinator,
        context: BillingProviderOperationContext,
        operation: dict[str, Any],
        reason: str,
        exc: Exception,
    ) -> None:
        try:
            operations.transition(
                context, operation, "reconciliation_required",
                reconciliation_reason_code=reason,
            )
        except Exception:
            pass
        raise HTTPException(status_code=503, detail=ENROLLMENT_ACTIVATION_AMBIGUOUS_DETAIL) from exc

    def _audit_once(
        self, context: BillingProviderOperationContext, enrollment: dict[str, Any]
    ) -> None:
        audit_id = str(uuid5(
            NAMESPACE_URL,
            f"koaryu:billing.student_enrollment_activated:{context.operation_id}",
        ))
        existing = (
            self.supabase.table("audit_logs").select("id")
            .eq("id", audit_id).eq("studio_id", context.studio_id).limit(1).execute()
        )
        if existing.data:
            return
        try:
            self.supabase.table("audit_logs").insert({
                "id": audit_id,
                "studio_id": context.studio_id,
                "actor_id": context.actor_id,
                "action": "billing.student_enrollment_activated",
                "entity_type": "billing",
                "entity_id": enrollment["id"],
                "metadata": {
                    "operation_id": context.operation_id,
                    "billing_subscription_id": enrollment.get("billing_subscription_id"),
                },
            }).execute()
        except PostgrestAPIError as exc:
            if getattr(exc, "code", None) != "23505":
                raise

    def _recompute_balance_or_raise(self, studio_id: str, payer_id: str) -> None:
        try:
            self.owner._recompute_payer_balance(studio_id, payer_id)
        except Exception as exc:
            raise HTTPException(
                status_code=503,
                detail=ENROLLMENT_ACTIVATION_AMBIGUOUS_DETAIL,
            ) from exc
