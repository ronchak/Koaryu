from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Sequence


BillingWorkflowClassification = Literal["supported", "internal_only", "unsupported"]
BillingWorkflowRole = Literal["admin", "front_desk", "instructor"]
LiveBillingScope = Literal["core_subscription", "connect_onboarding", "connect_payments"]

WORKFLOW_ROLE_DENIED = "billing_workflow_role_denied"
WORKFLOW_GRANT_DENIED = "billing_workflow_live_grant_operations_missing"
WORKFLOW_INTERNAL_ONLY = "billing_workflow_internal_only"
WORKFLOW_UNSUPPORTED = "billing_workflow_unsupported"
WORKFLOW_OBJECT_NOT_READY = "billing_workflow_object_prerequisite_missing"


@dataclass(frozen=True)
class BillingWorkflowDefinition:
    workflow_id: str
    classification: BillingWorkflowClassification
    route_names: tuple[str, ...]
    roles: tuple[BillingWorkflowRole, ...]
    stripe_operations: tuple[str, ...]
    object_prerequisites: tuple[str, ...]
    live_grant_scope: LiveBillingScope | None
    denial_reason_code: str


@dataclass(frozen=True)
class StripeSinkDefinition:
    operation: str
    classification: BillingWorkflowClassification
    workflow_ids: tuple[str, ...]
    denial_reason_code: str


def _workflow(
    workflow_id: str,
    *,
    routes: Sequence[str] = (),
    roles: Sequence[BillingWorkflowRole] = (),
    operations: Sequence[str] = (),
    prerequisites: Sequence[str] = (),
    scope: LiveBillingScope | None = None,
    classification: BillingWorkflowClassification = "supported",
    denial: str = WORKFLOW_GRANT_DENIED,
) -> BillingWorkflowDefinition:
    return BillingWorkflowDefinition(
        workflow_id=workflow_id,
        classification=classification,
        route_names=tuple(routes),
        roles=tuple(roles),
        stripe_operations=tuple(operations),
        object_prerequisites=tuple(prerequisites),
        live_grant_scope=scope,
        denial_reason_code=denial,
    )


BILLING_WORKFLOWS = (
    _workflow("connect.onboarding", routes=("create_connect_onboarding_link",), roles=("admin",), operations=("connect_account.create", "connect_onboarding_link.create"), prerequisites=("studio_identity", "connect_bootstrap"), scope="connect_onboarding"),
    _workflow("connect.onboarding_delivery.acknowledge", routes=("acknowledge_connect_onboarding_link_delivery",), roles=("admin",), prerequisites=("onboarding_delivery_receipt",)),
    _workflow("connect.sync", routes=("sync_connect_status",), roles=("admin",), prerequisites=("studio_payment_account",)),
    _workflow("connect.reset", routes=("reset_connect_account",), roles=("admin",), prerequisites=("studio_payment_account",)),
    _workflow("connect.dashboard", routes=("create_connect_dashboard_link",), roles=("admin",), operations=("connect_dashboard_login_link.create",), prerequisites=("connected_account",), scope="connect_onboarding"),
    _workflow("connect.branding", roles=("admin",), operations=("connect_account.branding.update", "connect_branding_file.create"), prerequisites=("connected_account", "reviewed_brand_assets"), scope="connect_onboarding", classification="internal_only", denial=WORKFLOW_INTERNAL_ONLY),
    _workflow("billing.reconcile", routes=("reconcile_billing_from_stripe",), roles=("admin",), prerequisites=("exact_provider_object",), classification="internal_only", denial=WORKFLOW_INTERNAL_ONLY),
    _workflow("plan.create", routes=("create_plan",), roles=("admin",), prerequisites=("studio_identity",)),
    _workflow("plan.update", routes=("update_plan",), roles=("admin",), prerequisites=("billing_plan",)),
    _workflow("plan.archive", routes=("archive_plan",), roles=("admin",), prerequisites=("billing_plan",)),
    _workflow("plan.sync", routes=("sync_plan",), roles=("admin",), operations=("connected_price.create", "connected_product.create", "connected_product.update"), prerequisites=("billing_plan", "connected_account_generation"), scope="connect_payments"),
    _workflow("payer.create", routes=("create_payer",), roles=("admin",), prerequisites=("studio_identity",)),
    _workflow("payer.update", routes=("update_payer",), roles=("admin",), prerequisites=("billing_payer",)),
    _workflow("payer.sync", routes=("sync_payer",), roles=("admin",), operations=("connected_customer.create", "connected_customer.update"), prerequisites=("billing_payer", "connected_account_generation"), scope="connect_payments"),
    _workflow("payer.setup", routes=("create_autopay_setup_link",), roles=("admin", "front_desk"), operations=("connected_setup_checkout_session.create",), prerequisites=("billing_payer", "connected_customer", "connected_account_generation"), scope="connect_payments"),
    _workflow("payer.autopay.disable", routes=("disable_autopay",), roles=("admin",), prerequisites=("billing_payer", "no_provider_subscription_rewire")),
    _workflow("enrollment.create.external", routes=("create_enrollment",), roles=("admin", "front_desk"), prerequisites=("student", "billing_plan", "external_collection")),
    _workflow("enrollment.update.external", routes=("update_enrollment",), roles=("admin",), prerequisites=("external_enrollment",)),
    _workflow("enrollment.activate", routes=("activate_enrollment",), roles=("admin", "front_desk"), operations=("connected_subscription.create", "connected_subscription_item.create", "connected_subscription_item.update"), prerequisites=("active_plan_price", "connected_payer", "verified_consent_when_autopay"), scope="connect_payments"),
    _workflow("enrollment.cancel.period_end.schedule", routes=("schedule_enrollment_period_end",), roles=("admin", "front_desk"), operations=("connected_subscription.update", "connected_subscription_schedule.create", "connected_subscription_schedule.update"), prerequisites=("active_recurring_enrollment", "exact_subscription_quantity"), scope="connect_payments"),
    _workflow("enrollment.cancel.period_end.revoke", routes=("revoke_scheduled_enrollment_transition",), roles=("admin", "front_desk"), operations=("connected_subscription.update", "connected_subscription_schedule.release"), prerequisites=("scheduled_cancellation_intent", "exact_subscription_quantity"), scope="connect_payments"),
    _workflow("enrollment.cancel.immediate", routes=("cancel_enrollment_immediate",), roles=("admin",), operations=("connected_subscription.cancel", "connected_subscription_item.delete", "connected_subscription_item.update"), prerequisites=("active_recurring_enrollment", "exact_subscription_quantity"), scope="connect_payments"),
    _workflow("enrollment.pause.generic", routes=("pause_enrollment",), roles=("admin",), classification="unsupported", denial="named_enrollment_pause_workflow_required"),
    _workflow("enrollment.resume.generic", routes=("resume_enrollment",), roles=("admin",), classification="unsupported", denial="named_enrollment_resume_workflow_required"),
    _workflow("enrollment.cancel.generic", routes=("cancel_enrollment",), roles=("admin",), classification="unsupported", denial="named_enrollment_cancellation_workflow_required"),
    _workflow("invoice.create", routes=("create_invoice",), roles=("admin",), operations=("connected_invoice.create", "connected_invoice_item.create"), prerequisites=("connected_payer", "normalized_invoice_items"), scope="connect_payments"),
    _workflow("invoice.finalize", routes=("finalize_invoice",), roles=("admin",), operations=("connected_invoice.finalize", "connected_invoice.send"), prerequisites=("draft_connected_invoice",), scope="connect_payments"),
    _workflow("invoice.retry", routes=("retry_invoice_payment",), roles=("admin",), operations=("connected_invoice.pay",), prerequisites=("open_connected_invoice", "verified_payment_method"), scope="connect_payments"),
    _workflow("invoice.void", routes=("void_invoice",), roles=("admin",), operations=("connected_invoice.void",), prerequisites=("voidable_connected_invoice",), scope="connect_payments"),
    _workflow("invoice.reconcile", routes=("reconcile_invoice",), roles=("admin", "front_desk"), prerequisites=("exact_connected_invoice",), classification="internal_only", denial=WORKFLOW_INTERNAL_ONLY),
    _workflow("payment.external.record", routes=("record_external_payment",), roles=("admin", "front_desk"), prerequisites=("billing_payer", "external_payment_evidence")),
    _workflow("payment.refund", routes=("refund_payment",), roles=("admin",), operations=("connected_refund.create",), prerequisites=("refundable_connected_charge", "exact_refundable_amount"), scope="connect_payments"),
    _workflow("billing.export.create", routes=("create_export_job",), roles=("admin",), prerequisites=("supported_export_type",), classification="internal_only", denial=WORKFLOW_INTERNAL_ONLY),
    _workflow("enrollment.cancel.period_end.execute", routes=("process_due_billing_enrollment_transitions",), operations=("connected_subscription_item.delete", "connected_subscription_item.update"), prerequisites=("due_transition_intent", "exact_subscription_quantity"), scope="connect_payments", classification="internal_only", denial=WORKFLOW_INTERNAL_ONLY),
    _workflow("core.subscription.checkout", roles=("admin",), operations=("core_checkout_session.create", "customer.create"), prerequisites=("core_checkout_reservation",), scope="core_subscription"),
    _workflow("core.subscription.portal", roles=("admin",), operations=("customer_portal_session.create",), prerequisites=("core_customer",), scope="core_subscription"),
    _workflow("core.checkout.expire", operations=("core_checkout_session.expire",), prerequisites=("exact_rejected_checkout_session",), scope="core_subscription", classification="internal_only", denial=WORKFLOW_INTERNAL_ONLY),
    _workflow("core.subscription.cancel_compensation", operations=("core_subscription.cancel",), prerequisites=("exact_rejected_core_subscription",), scope="core_subscription", classification="internal_only", denial=WORKFLOW_INTERNAL_ONLY),
)

WORKFLOWS_BY_ID = {workflow.workflow_id: workflow for workflow in BILLING_WORKFLOWS}
WORKFLOWS_BY_ROUTE = {
    route_name: workflow
    for workflow in BILLING_WORKFLOWS
    for route_name in workflow.route_names
}

LIVE_SCOPE_OPERATIONS: dict[LiveBillingScope, tuple[str, ...]] = {
    "core_subscription": (
        "core_checkout_session.create",
        "customer.create",
        "customer_portal_session.create",
    ),
    "connect_onboarding": (
        "connect_account.branding.update",
        "connect_account.create",
        "connect_branding_file.create",
        "connect_dashboard_login_link.create",
        "connect_onboarding_link.create",
    ),
    "connect_payments": (
        "connected_capability.readiness",
        "connected_customer.create",
        "connected_customer.default_payment_method.update",
        "connected_customer.update",
        "connected_invoice.create",
        "connected_invoice.finalize",
        "connected_invoice.pay",
        "connected_invoice.send",
        "connected_invoice.void",
        "connected_invoice_item.create",
        "connected_price.create",
        "connected_product.create",
        "connected_product.update",
        "connected_refund.create",
        "connected_setup_checkout_session.create",
        "connected_subscription.cancel",
        "connected_subscription.create",
        "connected_subscription_schedule.create",
        "connected_subscription_schedule.release",
        "connected_subscription_schedule.update",
        "connected_subscription.update",
        "connected_subscription_item.create",
        "connected_subscription_item.delete",
        "connected_subscription_item.update",
    ),
}


def _sink_workflows(operation: str) -> tuple[str, ...]:
    return tuple(
        workflow.workflow_id
        for workflow in BILLING_WORKFLOWS
        if operation in workflow.stripe_operations
    )


CONNECTED_STRIPE_SINKS = {
    operation: StripeSinkDefinition(
        operation=operation,
        classification=(
            "unsupported"
            if operation == "connected_customer.default_payment_method.update"
            else "supported"
        ),
        workflow_ids=_sink_workflows(operation),
        denial_reason_code=(
            "payer_setup_must_not_mutate_customer_default_payment_method"
            if operation == "connected_customer.default_payment_method.update"
            else WORKFLOW_GRANT_DENIED
        ),
    )
    for operation in LIVE_SCOPE_OPERATIONS["connect_payments"]
    if operation != "connected_capability.readiness"
}


def workflow_for_route(route_name: str) -> BillingWorkflowDefinition:
    return WORKFLOWS_BY_ROUTE[route_name]


def stripe_operation_scope(operation: str) -> LiveBillingScope | None:
    if operation in {"core_checkout_session.expire", "core_subscription.cancel"}:
        return "core_subscription"
    for scope, operations in LIVE_SCOPE_OPERATIONS.items():
        if operation in operations:
            return scope
    return None


def validate_live_authorization_operations(
    scope: str,
    operations: Sequence[str] | None,
    *,
    enabled: bool,
) -> tuple[str, ...]:
    if scope not in LIVE_SCOPE_OPERATIONS or operations is None:
        raise ValueError("live_billing_operation_set_invalid")
    values = tuple(operations)
    if not enabled:
        if values:
            raise ValueError("live_billing_operation_set_invalid")
        return ()
    if not 1 <= len(values) <= 32 or values != tuple(sorted(values)):
        raise ValueError("live_billing_operation_set_invalid")
    if len(values) != len(set(values)):
        raise ValueError("live_billing_operation_set_invalid")
    allowed = set(LIVE_SCOPE_OPERATIONS[scope])
    if any(
        not isinstance(value, str)
        or not value
        or value != value.strip()
        or len(value.encode("utf-8")) > 128
        or "*" in value
        or "%" in value
        or value not in allowed
        for value in values
    ):
        raise ValueError("live_billing_operation_set_invalid")
    return values


def workflow_capabilities_for_role(
    role: str,
    *,
    stripe_mode: str | None,
    scope_ready: dict[LiveBillingScope, bool],
    allowed_operations: dict[LiveBillingScope, frozenset[str]],
    transition_scheduler_ready: bool,
) -> list[dict[str, object]]:
    if role not in {"admin", "front_desk"}:
        return []
    capabilities: list[dict[str, object]] = []
    for workflow in BILLING_WORKFLOWS:
        if role not in workflow.roles or workflow.classification == "internal_only":
            continue
        enabled = workflow.classification == "supported"
        denial_reason: str | None = None
        if workflow.classification == "unsupported":
            enabled = False
            denial_reason = workflow.denial_reason_code
        elif workflow.live_grant_scope is not None:
            scope = workflow.live_grant_scope
            if stripe_mode == "test":
                enabled = bool(scope_ready.get(scope))
            else:
                enabled = bool(scope_ready.get(scope)) and set(workflow.stripe_operations).issubset(
                    allowed_operations.get(scope, frozenset())
                )
            if not enabled:
                denial_reason = WORKFLOW_GRANT_DENIED
        if (
            workflow.workflow_id == "enrollment.cancel.period_end.schedule"
            and not transition_scheduler_ready
        ):
            enabled = False
            denial_reason = "billing_transition_scheduler_not_ready"
        capabilities.append({
            "workflow_id": workflow.workflow_id,
            "enabled": enabled,
            "denial_reason_code": denial_reason,
        })
    return capabilities
