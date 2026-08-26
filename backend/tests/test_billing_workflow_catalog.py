from __future__ import annotations

import inspect

import pytest

from app.api.v1.endpoints import billing, internal
from app.services.billing_workflow_catalog import (
    BILLING_WORKFLOWS,
    CONNECTED_STRIPE_SINKS,
    LIVE_SCOPE_OPERATIONS,
    WORKFLOWS_BY_ROUTE,
    validate_live_authorization_operations,
    workflow_capabilities_for_role,
)
from app.services.stripe_service import StripeService


def _mutation_route_names(router) -> set[str]:
    return {
        route.endpoint.__name__
        for route in router.routes
        if set(route.methods or ()) & {"POST", "PUT", "PATCH", "DELETE"}
    }


def test_every_billing_mutation_route_has_one_catalog_owner():
    public_routes = _mutation_route_names(billing.router)
    catalog_public_routes = {
        route_name
        for route_name in WORKFLOWS_BY_ROUTE
        if route_name != "process_due_billing_enrollment_transitions"
    }

    assert catalog_public_routes == public_routes
    assert "process_due_billing_enrollment_transitions" in _mutation_route_names(internal.router)
    assert len(WORKFLOWS_BY_ROUTE) == sum(
        len(workflow.route_names) for workflow in BILLING_WORKFLOWS
    )


def test_catalog_roles_match_authoritative_endpoint_resolvers():
    for route in billing.router.routes:
        if not set(route.methods or ()) & {"POST", "PUT", "PATCH", "DELETE"}:
            continue
        workflow = WORKFLOWS_BY_ROUTE[route.endpoint.__name__]
        source = inspect.getsource(route.endpoint)
        if "_admin_studio_id(" in source:
            assert workflow.roles == ("admin",)
        elif "_routine_studio_id(" in source:
            assert workflow.roles == ("admin", "front_desk")
        else:
            raise AssertionError(f"{route.endpoint.__name__} has no classified role resolver")


def test_every_connected_stripe_sink_is_explicitly_classified():
    decorated = {
        operation
        for name in dir(StripeService)
        if (
            operation := getattr(
                getattr(StripeService, name),
                "__stripe_mutation_operation__",
                None,
            )
        )
        if operation.startswith("connected_")
    }

    assert set(CONNECTED_STRIPE_SINKS) == decorated
    assert set(CONNECTED_STRIPE_SINKS) == (
        set(LIVE_SCOPE_OPERATIONS["connect_payments"])
        - {"connected_capability.readiness"}
    )
    assert CONNECTED_STRIPE_SINKS[
        "connected_customer.default_payment_method.update"
    ].classification == "unsupported"
    assert all(
        sink.workflow_ids or sink.classification == "unsupported"
        for sink in CONNECTED_STRIPE_SINKS.values()
    )


@pytest.mark.parametrize(
    "operations",
    (
        None,
        (),
        ("connected_invoice.create", "connected_invoice.create"),
        ("connected_invoice.pay", "connected_invoice.create"),
        ("connected_invoice.*",),
        ("connected_invoice.%",),
        ("connected_invoice",),
        ("connected_unknown.create",),
        (" connected_invoice.create",),
    ),
)
def test_live_operation_arrays_reject_empty_wildcard_duplicate_prefix_and_unknown(operations):
    with pytest.raises(ValueError, match="live_billing_operation_set_invalid"):
        validate_live_authorization_operations(
            "connect_payments",
            operations,
            enabled=True,
        )


def test_role_capabilities_are_sanitized_and_fail_closed():
    allowed = {
        "core_subscription": frozenset(LIVE_SCOPE_OPERATIONS["core_subscription"]),
        "connect_onboarding": frozenset(LIVE_SCOPE_OPERATIONS["connect_onboarding"]),
        "connect_payments": frozenset(LIVE_SCOPE_OPERATIONS["connect_payments"]),
    }
    ready = {scope: True for scope in LIVE_SCOPE_OPERATIONS}

    admin = workflow_capabilities_for_role(
        "admin", stripe_mode="live", scope_ready=ready, allowed_operations=allowed
    )
    front_desk = workflow_capabilities_for_role(
        "front_desk", stripe_mode="live", scope_ready=ready, allowed_operations=allowed
    )

    assert workflow_capabilities_for_role(
        "instructor", stripe_mode="live", scope_ready=ready, allowed_operations=allowed
    ) == []
    assert {tuple(sorted(capability)) for capability in admin} == {
        ("denial_reason_code", "enabled", "workflow_id")
    }
    assert all(capability["workflow_id"] != "billing.reconcile" for capability in admin)
    assert all(
        "front_desk" in next(
            workflow.roles
            for workflow in BILLING_WORKFLOWS
            if workflow.workflow_id == capability["workflow_id"]
        )
        for capability in front_desk
    )
    unsupported = next(
        capability
        for capability in admin
        if capability["workflow_id"] == "enrollment.cancel.generic"
    )
    assert unsupported == {
        "workflow_id": "enrollment.cancel.generic",
        "enabled": False,
        "denial_reason_code": "named_enrollment_cancellation_workflow_required",
    }


def test_catalog_is_immutable_data_without_callable_provider_logic():
    assert all(not inspect.isroutine(value) for workflow in BILLING_WORKFLOWS for value in workflow.stripe_operations)
