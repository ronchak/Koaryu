from __future__ import annotations

import asyncio
import copy
from datetime import datetime, timedelta

import pytest
import stripe
from fastapi import HTTPException

from app.services.billing_subscription_webhook_projection import (
    BillingSubscriptionWebhookProjector,
)
from app.services.billing_enrollments import BillingEnrollmentManager
from app.services.billing_enrollment_transitions import (
    BillingEnrollmentTransitionWorkflow,
    WHOLE_SUBSCRIPTION_PERIOD_END_GRACE,
)
from app.services.billing_provider_operations import BillingProviderStepCoordinator
from app.services.stripe_mutation_policy import StripeMutationBlocked
from tests.test_billing_enrollment_activation import (
    _Facade,
    _Stripe,
    _enrollment,
    _group,
    _payer,
    _plan,
)


PERIOD_END = "2026-09-01T00:00:00+00:00"
PERIOD_END_EPOCH = 1788220800


class _TransitionFacade(_Facade):
    def _project_subscription(self, provider, account_id, event_type=""):
        group = self._get_row_or_404(
            "billing_subscriptions", "group_1", "studio_1", "Group not found."
        )
        group.update({
            "stripe_account_id": account_id,
            "status": "canceled" if event_type == "customer.subscription.deleted" else provider["status"],
            "cancel_at_period_end": bool(provider.get("cancel_at_period_end")),
        })
        if event_type == "customer.subscription.deleted":
            for enrollment in self.supabase.tables["student_billing_enrollments"]:
                if enrollment.get("billing_subscription_id") == group["id"]:
                    enrollment.update({
                        "status": "canceled",
                        "billing_status": "unpaid",
                        "stripe_subscription_id": None,
                        "stripe_subscription_item_id": None,
                    })
        return dict(group)


class _TransitionStripe(_Stripe):
    subscription_update_calls = []
    subscription_cancel_calls = []
    delete_item_calls = []
    schedule_create_calls = []
    schedule_update_calls = []
    schedule_release_calls = []
    schedule_retrieve_calls = []
    schedule_list_calls = []
    schedules = {}
    schedule_idempotency = {}
    schedule_create_error = None
    schedule_update_error = None
    schedule_release_error = None
    schedule_create_response_error_after = None
    schedule_update_response_error_after = None
    schedule_release_response_error_after = None
    schedule_retrieve_error = None
    schedule_retrieve_override = None

    @classmethod
    def reset(cls):
        super().reset()
        cls.subscription_update_calls = []
        cls.subscription_cancel_calls = []
        cls.delete_item_calls = []
        cls.schedule_create_calls = []
        cls.schedule_update_calls = []
        cls.schedule_release_calls = []
        cls.schedule_retrieve_calls = []
        cls.schedule_list_calls = []
        cls.schedules = {}
        cls.schedule_idempotency = {}
        cls.schedule_create_error = None
        cls.schedule_update_error = None
        cls.schedule_release_error = None
        cls.schedule_create_response_error_after = None
        cls.schedule_update_response_error_after = None
        cls.schedule_release_response_error_after = None
        cls.schedule_retrieve_error = None
        cls.schedule_retrieve_override = None

    def update_connected_subscription(self, **payload):
        self.__class__.subscription_update_calls.append(copy.deepcopy(payload))
        if self.__class__.provider_error:
            raise self.__class__.provider_error
        subscription = self.__class__.subscriptions[payload["subscription_id"]]
        subscription["cancel_at_period_end"] = payload["cancel_at_period_end"]
        return copy.deepcopy(subscription)

    def cancel_connected_subscription(self, **payload):
        self.__class__.subscription_cancel_calls.append(copy.deepcopy(payload))
        subscription = self.__class__.subscriptions[payload["subscription_id"]]
        subscription["status"] = "canceled"
        return copy.deepcopy(subscription)

    def delete_connected_subscription_item(self, **payload):
        self.__class__.delete_item_calls.append(copy.deepcopy(payload))
        for subscription in self.__class__.subscriptions.values():
            subscription["items"]["data"] = [
                item for item in subscription["items"]["data"]
                if item["id"] != payload["subscription_item_id"]
            ]
        return {"id": payload["subscription_item_id"], "deleted": True}

    def create_connected_subscription_schedule(self, **payload):
        self.__class__.schedule_create_calls.append(copy.deepcopy(payload))
        if self.__class__.schedule_create_error or self.__class__.provider_error:
            raise self.__class__.schedule_create_error or self.__class__.provider_error
        prior = self.__class__.schedule_idempotency.get(payload["idempotency_key"])
        if prior:
            return copy.deepcopy(self.__class__.schedules[prior])
        subscription = self.__class__.subscriptions[payload["subscription_id"]]
        schedule_id = f"sub_sched_{len(self.__class__.schedules) + 1}"
        phase_items = [
            {
                "price": copy.deepcopy(item["price"]),
                "quantity": item["quantity"],
                "metadata": copy.deepcopy(item.get("metadata") or {}),
            }
            for item in subscription["items"]["data"]
        ]
        default_settings = {
            "collection_method": subscription["collection_method"],
            "application_fee_percent": subscription.get(
                "application_fee_percent"
            ),
            "default_payment_method": subscription.get(
                "default_payment_method"
            ),
        }
        if subscription.get("days_until_due") is not None:
            default_settings["invoice_settings"] = {
                "days_until_due": subscription["days_until_due"]
            }
        phase = {
            "start_date": PERIOD_END_EPOCH - 2_592_000,
            "end_date": PERIOD_END_EPOCH,
            "items": phase_items,
            "metadata": copy.deepcopy(subscription["metadata"]),
            "collection_method": None,
            "invoice_settings": None,
            "proration_behavior": "none",
        }
        schedule = {
            "id": schedule_id,
            "status": "active",
            "subscription": subscription["id"],
            "released_subscription": None,
            "customer": subscription["customer"],
            "metadata": {},
            "default_settings": default_settings,
            "end_behavior": "release",
            "current_phase": {
                "start_date": PERIOD_END_EPOCH - 2_592_000,
                "end_date": PERIOD_END_EPOCH,
            },
            "phases": [phase],
        }
        self.__class__.schedules[schedule_id] = schedule
        self.__class__.schedule_idempotency[payload["idempotency_key"]] = schedule_id
        subscription["schedule"] = schedule_id
        if self.__class__.schedule_create_response_error_after:
            raise self.__class__.schedule_create_response_error_after
        return copy.deepcopy(schedule)

    def retrieve_connected_subscription_schedule(self, **payload):
        self.__class__.schedule_retrieve_calls.append(copy.deepcopy(payload))
        if self.__class__.schedule_retrieve_error:
            raise self.__class__.schedule_retrieve_error
        if self.__class__.schedule_retrieve_override is not None:
            return copy.deepcopy(self.__class__.schedule_retrieve_override)
        return copy.deepcopy(self.__class__.schedules[payload["schedule_id"]])

    def update_connected_subscription_schedule(self, **payload):
        self.__class__.schedule_update_calls.append(copy.deepcopy(payload))
        if self.__class__.schedule_update_error or self.__class__.provider_error:
            raise self.__class__.schedule_update_error or self.__class__.provider_error
        prior = self.__class__.schedule_idempotency.get(payload["idempotency_key"])
        schedule_id = prior or payload["schedule_id"]
        schedule = self.__class__.schedules[schedule_id]
        returned_phases = copy.deepcopy(payload["phases"])
        defaults = schedule.get("default_settings") or {}
        for phase in returned_phases:
            for field in (
                "collection_method",
                "application_fee_percent",
                "default_payment_method",
            ):
                if phase.get(field) == defaults.get(field):
                    phase[field] = None
            if phase.get("invoice_settings") == defaults.get("invoice_settings"):
                phase["invoice_settings"] = None
        schedule.update({
            "metadata": copy.deepcopy(payload["metadata"]),
            "end_behavior": "release",
            "phases": returned_phases,
        })
        self.__class__.schedule_idempotency[payload["idempotency_key"]] = schedule_id
        if self.__class__.schedule_update_response_error_after:
            raise self.__class__.schedule_update_response_error_after
        return copy.deepcopy(schedule)

    def release_connected_subscription_schedule(self, **payload):
        self.__class__.schedule_release_calls.append(copy.deepcopy(payload))
        prior = self.__class__.schedule_idempotency.get(payload["idempotency_key"])
        schedule_id = prior or payload["schedule_id"]
        schedule = self.__class__.schedules[schedule_id]
        subscription_id = schedule.get("subscription") or schedule.get(
            "released_subscription"
        )
        if self.__class__.schedule_release_error or self.__class__.provider_error:
            raise self.__class__.schedule_release_error or self.__class__.provider_error
        schedule.update({
            "status": "released",
            "subscription": None,
            "released_subscription": subscription_id,
        })
        self.__class__.subscriptions[subscription_id]["schedule"] = None
        self.__class__.schedule_idempotency[payload["idempotency_key"]] = schedule_id
        if self.__class__.schedule_release_response_error_after:
            raise self.__class__.schedule_release_response_error_after
        return copy.deepcopy(schedule)

    def list_connected_subscription_schedules(self, **payload):
        self.__class__.schedule_list_calls.append(copy.deepcopy(payload))
        return {
            "data": [
                copy.deepcopy(schedule)
                for schedule in self.__class__.schedules.values()
                if schedule.get("customer") == payload["customer_id"]
            ]
        }


def _provider(
    *,
    items,
    status="active",
    cancel_at_period_end=False,
    collection_method="charge_automatically",
    days_until_due=None,
    application_fee_percent=0.5,
    default_payment_method="pm_1",
):
    provider = {
        "id": "sub_1",
        "status": status,
        "customer": "cus_1",
        "collection_method": collection_method,
        "application_fee_percent": application_fee_percent,
        "default_payment_method": default_payment_method,
        "billing_cycle_anchor": PERIOD_END_EPOCH - 2_592_000,
        "invoice_settings": {"issuer": {"type": "self"}},
        "cancel_at_period_end": cancel_at_period_end,
        "current_period_end": PERIOD_END_EPOCH,
        "schedule": None,
        "metadata": {
            "studio_id": "studio_1",
            "payer_id": "payer_1",
            "billing_subscription_id": "group_1",
        },
        "items": {"data": items},
    }
    if days_until_due is not None:
        provider["days_until_due"] = days_until_due
    return provider


def _item(item_id="si_1", quantity=1, price_id="price_1"):
    return {
        "id": item_id,
        "quantity": quantity,
        "price": {"id": price_id},
        "metadata": {
            "studio_id": "studio_1",
            "payer_id": "payer_1",
            "enrollment_id": "enrollment_1" if item_id == "si_1" else "enrollment_2",
            "student_id": "student_1" if item_id == "si_1" else "student_2",
            "billing_plan_id": "plan_1" if price_id == "price_1" else "plan_2",
            "billing_subscription_id": "group_1",
            "product": "koaryu_payments",
        },
    }


def _apply_scheduled_item_phase(subscription_id="sub_1", *, rotate_items=False):
    subscription = _TransitionStripe.subscriptions[subscription_id]
    schedule = _TransitionStripe.schedules[subscription["schedule"]]
    by_price = {
        item["price"]["id"]: item for item in subscription["items"]["data"]
    }
    transitioned = []
    for index, phase_item in enumerate(schedule["phases"][1]["items"], start=1):
        price_id = phase_item["price"]
        item = copy.deepcopy(by_price[price_id])
        if rotate_items:
            item["id"] = f"si_replacement_{index}"
        item["quantity"] = phase_item["quantity"]
        item["metadata"] = copy.deepcopy(phase_item.get("metadata") or {})
        transitioned.append(item)
    subscription["items"]["data"] = transitioned
    schedule["current_phase"] = {
        "start_date": PERIOD_END_EPOCH,
        "end_date": PERIOD_END_EPOCH + 2_592_000,
    }


def _tables(*, peers=None):
    enrollment = _enrollment(
        status="active",
        billing_subscription_id="group_1",
        stripe_subscription_id="sub_1",
        stripe_subscription_item_id="si_1",
    )
    return {
        "student_billing_enrollments": [enrollment, *(peers or [])],
        "billing_plans": [_plan()],
        "billing_payers": [_payer()],
        "billing_subscriptions": [_group(current_period_end=PERIOD_END, cancel_at_period_end=False)],
        "audit_logs": [],
    }


def test_schedule_phases_accepts_real_stripe_direct_list_shape():
    schedule = stripe.SubscriptionSchedule.construct_from(
        {
            "id": "sub_sched_shape",
            "object": "subscription_schedule",
            "phases": [
                {
                    "start_date": PERIOD_END_EPOCH - 2_592_000,
                    "end_date": PERIOD_END_EPOCH,
                    "items": [{"price": "price_1", "quantity": 1}],
                }
            ],
        },
        "sk_test_shape",
    )

    phases = BillingEnrollmentTransitionWorkflow._schedule_phases(schedule)

    assert len(phases) == 1
    assert phases[0]["end_date"] == PERIOD_END_EPOCH


def _manager(facade):
    return BillingEnrollmentManager(facade, stripe_service_cls=_TransitionStripe)


def _workflow(facade, *, now=None):
    return BillingEnrollmentTransitionWorkflow(
        _manager(facade),
        stripe_service_cls=_TransitionStripe,
        clock=(lambda: now) if now is not None else None,
    )


def _authorize_recovery(facade, workflow, *, outcome):
    intent = next(iter(facade.supabase.billing_enrollment_transition_intents.values()))
    operation = next(iter(facade.supabase.billing_provider_operations.values()))
    context = workflow._operation_context(intent, operation, lease_owner="recovery_worker")
    recovered = workflow.operations.authorize_recovery(
        context,
        operation,
        recovery_actor_id="recovery_admin",
        recovery_proof_sha256="a" * 64,
        recovery_outcome=outcome,
        lease_owner="recovery_worker",
    )
    stored_intent = facade.supabase.billing_enrollment_transition_intents[intent["id"]]
    stored_intent.update({
        "state": "recovery_authorized",
        "recovery_actor_id": "recovery_admin",
        "recovery_proof_sha256": "a" * 64,
        "recovery_outcome": outcome,
        "revision": stored_intent["revision"] + 1,
    })
    return recovered


def _authorize_schedule_step_recovery(facade, workflow, *, step_order, outcome):
    intent = next(iter(facade.supabase.billing_enrollment_transition_intents.values()))
    operation = next(iter(facade.supabase.billing_provider_operations.values()))
    snapshot = workflow._snapshot_for_replay(intent)
    context = workflow._operation_context(intent, operation, lease_owner="recovery_worker")
    plan = workflow._item_schedule_provider_plan(intent, context, snapshot)
    step = workflow._provider_step_context(
        context,
        plan["plan_sha256"],
        step_order,
        plan["steps"][step_order - 1],
    )
    stored = facade.supabase.billing_provider_step_plans[operation["id"]]["steps"][
        step_order - 1
    ]
    BillingProviderStepCoordinator(facade.supabase).authorize_step_recovery(
        step,
        stored,
        recovery_actor_id="recovery_admin",
        recovery_proof_sha256="a" * 64,
        recovery_outcome=outcome,
    )


@pytest.fixture(autouse=True)
def _reset_provider():
    _TransitionStripe.reset()


def test_whole_schedule_replays_without_second_provider_mutation():
    facade = _TransitionFacade(_tables())
    _TransitionStripe.subscriptions["sub_1"] = _provider(items=[_item()])
    manager = _manager(facade)

    first = asyncio.run(manager.schedule_period_end(
        "enrollment_1", "studio_1", "actor_1", "schedule-key", "staff_requested"
    ))
    replay = asyncio.run(manager.schedule_period_end(
        "enrollment_1", "studio_1", "actor_1", "schedule-key", "staff_requested"
    ))

    assert first["intent"]["state"] == replay["intent"]["state"] == "scheduled"
    assert len(_TransitionStripe.subscription_update_calls) == 1
    assert _TransitionStripe.subscription_update_calls[0]["cancel_at_period_end"] is True
    assert _TransitionStripe.subscription_cancel_calls == []
    assert len(facade.supabase.tables["audit_logs"]) == 1
    rpc_names = [name for name, _params in facade.supabase.rpc_calls]
    assert rpc_names.index("claim_billing_subscription_quantity_sync") < rpc_names.index(
        "claim_billing_enrollment_transition_v1"
    )
    assert "stripe_quantity_sync_lock" not in facade.supabase.tables[
        "billing_subscriptions"
    ][0]["metadata"]


def test_whole_schedule_cannot_insert_intent_while_activation_lock_is_held():
    facade = _TransitionFacade(_tables())
    _TransitionStripe.subscriptions["sub_1"] = _provider(items=[_item()])
    workflow = _workflow(facade)
    token = workflow.lifecycle._claim_subscription_quantity_sync_lock(
        "studio_1", "group_1"
    )

    try:
        with pytest.raises(HTTPException) as blocked:
            workflow.schedule_period_end(
                "enrollment_1",
                "studio_1",
                "actor_1",
                "activation-lock-held",
                "staff_requested",
            )
    finally:
        workflow.lifecycle._release_subscription_quantity_sync_lock(
            "studio_1", "group_1", token
        )

    assert blocked.value.status_code == 409
    assert facade.supabase.billing_enrollment_transition_intents == {}
    assert _TransitionStripe.subscription_update_calls == []


def test_transition_replay_is_bound_to_original_actor():
    facade = _TransitionFacade(_tables())
    _TransitionStripe.subscriptions["sub_1"] = _provider(items=[_item()])
    manager = _manager(facade)
    asyncio.run(manager.schedule_period_end(
        "enrollment_1", "studio_1", "actor_1", "actor-bound", "staff_requested"
    ))

    with pytest.raises(HTTPException) as conflict:
        asyncio.run(manager.schedule_period_end(
            "enrollment_1", "studio_1", "actor_2", "actor-bound", "staff_requested"
        ))

    assert conflict.value.status_code == 409
    assert len(_TransitionStripe.subscription_update_calls) == 1


def test_immediate_item_delete_is_one_mutation_and_projects_only_target():
    peer = _enrollment(
        id="enrollment_2",
        student_id="student_2",
        billing_plan_id="plan_2",
        status="active",
        billing_subscription_id="group_1",
        stripe_subscription_id="sub_1",
        stripe_subscription_item_id="si_2",
    )
    facade = _TransitionFacade(_tables(peers=[peer]))
    facade.supabase.tables["billing_plans"].append(
        _plan(id="plan_2", stripe_price_id="price_2")
    )
    _TransitionStripe.subscriptions["sub_1"] = _provider(items=[_item(), _item("si_2", price_id="price_2")])

    manager = _manager(facade)
    result = asyncio.run(manager.cancel_immediate(
        "enrollment_1", "studio_1", "actor_1", "immediate-key", "staff_requested"
    ))
    replay = asyncio.run(manager.cancel_immediate(
        "enrollment_1", "studio_1", "actor_1", "immediate-key", "staff_requested"
    ))

    assert result["intent"]["state"] == replay["intent"]["state"] == "completed"
    assert len(_TransitionStripe.delete_item_calls) == 1
    assert _TransitionStripe.subscription_cancel_calls == []
    assert facade.supabase.tables["student_billing_enrollments"][0]["status"] == "canceled"
    assert facade.supabase.tables["student_billing_enrollments"][1]["status"] == "active"


def test_immediate_replay_rejects_changed_reason_without_provider_retry():
    peer = _enrollment(
        id="enrollment_2",
        student_id="student_2",
        status="active",
        billing_subscription_id="group_1",
        stripe_subscription_id="sub_1",
        stripe_subscription_item_id="si_2",
    )
    facade = _TransitionFacade(_tables(peers=[peer]))
    facade.supabase.tables["billing_plans"].append(
        _plan(id="plan_2", stripe_price_id="price_2")
    )
    _TransitionStripe.subscriptions["sub_1"] = _provider(items=[_item(), _item("si_2", price_id="price_2")])
    manager = _manager(facade)
    asyncio.run(manager.cancel_immediate(
        "enrollment_1", "studio_1", "actor_1", "immediate-conflict", "staff_requested"
    ))

    with pytest.raises(HTTPException) as conflict:
        asyncio.run(manager.cancel_immediate(
            "enrollment_1", "studio_1", "actor_1", "immediate-conflict", "fraud_review"
        ))

    assert conflict.value.status_code == 409
    assert len(_TransitionStripe.delete_item_calls) == 1


def test_ambiguous_schedule_enters_reconciliation_and_same_key_does_not_retry():
    facade = _TransitionFacade(_tables())
    _TransitionStripe.subscriptions["sub_1"] = _provider(items=[_item()])
    _TransitionStripe.provider_error = RuntimeError("provider timeout")
    manager = _manager(facade)

    with pytest.raises(HTTPException) as first:
        asyncio.run(manager.schedule_period_end(
            "enrollment_1", "studio_1", "actor_1", "ambiguous-key", "staff_requested"
        ))
    with pytest.raises(HTTPException) as replay:
        asyncio.run(manager.schedule_period_end(
            "enrollment_1", "studio_1", "actor_1", "ambiguous-key", "staff_requested"
        ))

    assert first.value.status_code == 503
    assert replay.value.status_code == 409
    assert len(_TransitionStripe.subscription_update_calls) == 1
    operation = next(iter(facade.supabase.billing_provider_operations.values()))
    assert operation["state"] == "reconciliation_required"


def test_safe_to_retry_recovery_executes_one_mutation_with_the_original_provider_key():
    facade = _TransitionFacade(_tables())
    _TransitionStripe.subscriptions["sub_1"] = _provider(items=[_item()])
    _TransitionStripe.provider_error = RuntimeError("provider timeout")
    workflow = _workflow(facade)

    with pytest.raises(HTTPException) as ambiguous:
        workflow.schedule_period_end(
            "enrollment_1", "studio_1", "actor_1", "recovery-retry", "staff_requested"
        )

    assert ambiguous.value.status_code == 503
    first_key = _TransitionStripe.subscription_update_calls[0]["idempotency_key"]
    _TransitionStripe.provider_error = None
    recovered = _authorize_recovery(
        facade,
        workflow,
        outcome="provider_no_object_safe_to_retry",
    )

    result = workflow.schedule_period_end(
        "enrollment_1", "studio_1", "actor_1", "recovery-retry", "staff_requested"
    )
    replay = workflow.schedule_period_end(
        "enrollment_1", "studio_1", "actor_1", "recovery-retry", "staff_requested"
    )

    assert recovered["state"] == "recovery_authorized"
    assert result["intent"]["state"] == replay["intent"]["state"] == "scheduled"
    assert len(_TransitionStripe.subscription_update_calls) == 2
    assert _TransitionStripe.subscription_update_calls[1]["idempotency_key"] == first_key
    operation = next(iter(facade.supabase.billing_provider_operations.values()))
    assert operation["provider_request_attempt_count"] == 2
    assert operation["state"] == "completed"


def test_operation_only_recovery_cannot_mutate_before_intent_authorization():
    facade = _TransitionFacade(_tables())
    _TransitionStripe.subscriptions["sub_1"] = _provider(items=[_item()])
    _TransitionStripe.provider_error = RuntimeError("provider timeout")
    workflow = _workflow(facade)

    with pytest.raises(HTTPException):
        workflow.schedule_period_end(
            "enrollment_1", "studio_1", "actor_1", "partial-recovery", "staff_requested"
        )

    operation = next(iter(facade.supabase.billing_provider_operations.values()))
    intent = next(iter(facade.supabase.billing_enrollment_transition_intents.values()))
    context = workflow._operation_context(intent, operation, lease_owner="recovery_worker")
    workflow.operations.authorize_recovery(
        context,
        operation,
        recovery_actor_id="recovery_admin",
        recovery_proof_sha256="b" * 64,
        recovery_outcome="provider_no_object_safe_to_retry",
        lease_owner="recovery_worker",
    )
    _TransitionStripe.provider_error = None

    with pytest.raises(HTTPException) as blocked:
        workflow.schedule_period_end(
            "enrollment_1", "studio_1", "actor_1", "partial-recovery", "staff_requested"
        )

    assert blocked.value.status_code == 503
    assert len(_TransitionStripe.subscription_update_calls) == 1


def test_reconcile_only_recovery_reads_back_without_a_second_provider_mutation():
    facade = _TransitionFacade(_tables())
    _TransitionStripe.subscriptions["sub_1"] = _provider(items=[_item()])
    _TransitionStripe.provider_error = RuntimeError("provider response lost")
    workflow = _workflow(facade)

    with pytest.raises(HTTPException):
        workflow.schedule_period_end(
            "enrollment_1", "studio_1", "actor_1", "recovery-readback", "staff_requested"
        )

    _TransitionStripe.provider_error = None
    _TransitionStripe.subscriptions["sub_1"]["cancel_at_period_end"] = True
    _authorize_recovery(
        facade,
        workflow,
        outcome="provider_succeeded_reconcile_only",
    )

    result = workflow.schedule_period_end(
        "enrollment_1", "studio_1", "actor_1", "recovery-readback", "staff_requested"
    )
    replay = workflow.schedule_period_end(
        "enrollment_1", "studio_1", "actor_1", "recovery-readback", "staff_requested"
    )

    assert result["intent"]["state"] == replay["intent"]["state"] == "scheduled"
    assert len(_TransitionStripe.subscription_update_calls) == 1
    operation = next(iter(facade.supabase.billing_provider_operations.values()))
    assert operation["provider_request_attempt_count"] == 1
    assert operation["state"] == "completed"


def test_identity_drift_between_claim_and_mutation_reconciles_without_provider_write(monkeypatch):
    facade = _TransitionFacade(_tables())
    _TransitionStripe.subscriptions["sub_1"] = _provider(items=[_item()])
    original = _TransitionStripe.retrieve_connected_subscription
    reads = 0

    def retrieve_with_drift(self, **payload):
        nonlocal reads
        reads += 1
        provider = original(self, **payload)
        if reads == 3:
            provider["customer"] = "cus_wrong"
        return provider

    monkeypatch.setattr(_TransitionStripe, "retrieve_connected_subscription", retrieve_with_drift)

    with pytest.raises(HTTPException) as failed:
        asyncio.run(_manager(facade).schedule_period_end(
            "enrollment_1", "studio_1", "actor_1", "drift-key", "staff_requested"
        ))

    assert failed.value.status_code == 503
    assert _TransitionStripe.subscription_update_calls == []
    operation = next(iter(facade.supabase.billing_provider_operations.values()))
    assert operation["state"] == "reconciliation_required"


def test_whole_due_uses_readback_without_second_provider_mutation():
    facade = _TransitionFacade(_tables())
    _TransitionStripe.subscriptions["sub_1"] = _provider(items=[_item()])
    manager = _manager(facade)

    scheduled = asyncio.run(manager.schedule_period_end(
        "enrollment_1", "studio_1", "actor_1", "schedule-due", "staff_requested"
    ))
    _TransitionStripe.subscriptions["sub_1"]["status"] = "canceled"
    result = asyncio.run(manager.process_due_transitions(worker_id="worker_1", limit=25))

    assert scheduled["intent"]["state"] == "scheduled"
    assert result == {"claimed": 1, "completed": 1, "reconciliation_required": 0, "failed": 0}
    assert len(_TransitionStripe.subscription_update_calls) == 1
    assert _TransitionStripe.subscription_cancel_calls == []
    assert _TransitionStripe.delete_item_calls == []
    assert facade.supabase.tables["student_billing_enrollments"][0]["status"] == "canceled"


def test_whole_due_completes_after_cancellation_webhook_projects_first():
    facade = _TransitionFacade(_tables())
    _TransitionStripe.subscriptions["sub_1"] = _provider(items=[_item()])
    manager = _manager(facade)

    scheduled = asyncio.run(manager.schedule_period_end(
        "enrollment_1", "studio_1", "actor_1", "webhook-first-due", "staff_requested"
    ))
    _TransitionStripe.subscriptions["sub_1"]["status"] = "canceled"
    facade._project_subscription(
        copy.deepcopy(_TransitionStripe.subscriptions["sub_1"]),
        "acct_1",
        event_type="customer.subscription.deleted",
    )

    enrollment = facade.supabase.tables["student_billing_enrollments"][0]
    assert enrollment["status"] == "canceled"
    assert enrollment["stripe_subscription_id"] is None
    assert enrollment["stripe_subscription_item_id"] is None

    result = asyncio.run(manager.process_due_transitions(worker_id="worker_1", limit=25))
    replay = asyncio.run(manager.process_due_transitions(worker_id="worker_1", limit=25))

    assert result == {"claimed": 1, "completed": 1, "reconciliation_required": 0, "failed": 0}
    assert replay == {"claimed": 0, "completed": 0, "reconciliation_required": 0, "failed": 0}
    assert len(_TransitionStripe.subscription_update_calls) == 1
    assert _TransitionStripe.subscription_cancel_calls == []
    assert _TransitionStripe.delete_item_calls == []
    source = facade.supabase.billing_enrollment_transition_intents[scheduled["intent"]["id"]]
    execute = next(
        intent
        for intent in facade.supabase.billing_enrollment_transition_intents.values()
        if intent.get("source_intent_id") == source["id"]
    )
    assert source["state"] == execute["state"] == "completed"


@pytest.mark.parametrize(
    ("provider_status", "elapsed"),
    [
        ("active", timedelta(seconds=1)),
        ("active", WHOLE_SUBSCRIPTION_PERIOD_END_GRACE),
        ("trialing", timedelta(minutes=1)),
        ("past_due", timedelta(minutes=1)),
    ],
)
def test_whole_due_schedulable_provider_stays_retryable_through_explicit_grace(
    provider_status,
    elapsed,
):
    facade = _TransitionFacade(_tables())
    _TransitionStripe.subscriptions["sub_1"] = _provider(
        items=[_item()], status=provider_status
    )
    boundary = datetime.fromisoformat(PERIOD_END)
    workflow = _workflow(facade, now=boundary + elapsed)
    scheduled = workflow.schedule_period_end(
        "enrollment_1", "studio_1", "actor_1", "whole-due-grace", "staff_requested"
    )

    result = workflow.process_due(worker_id="worker_1", limit=25)

    assert result == {
        "claimed": 1,
        "completed": 0,
        "reconciliation_required": 0,
        "failed": 0,
    }
    source = facade.supabase.billing_enrollment_transition_intents[scheduled["intent"]["id"]]
    execute = next(
        intent
        for intent in facade.supabase.billing_enrollment_transition_intents.values()
        if intent.get("source_intent_id") == source["id"]
    )
    assert source["state"] == execute["state"] == "due_claimed"
    assert _TransitionStripe.subscription_cancel_calls == []


def test_whole_due_escalates_active_provider_after_grace_bound():
    facade = _TransitionFacade(_tables())
    _TransitionStripe.subscriptions["sub_1"] = _provider(items=[_item()])
    boundary = datetime.fromisoformat(PERIOD_END)
    workflow = _workflow(
        facade,
        now=boundary + WHOLE_SUBSCRIPTION_PERIOD_END_GRACE + timedelta(microseconds=1),
    )
    scheduled = workflow.schedule_period_end(
        "enrollment_1", "studio_1", "actor_1", "whole-due-expired", "staff_requested"
    )

    result = workflow.process_due(worker_id="worker_1", limit=25)

    assert result == {
        "claimed": 1,
        "completed": 0,
        "reconciliation_required": 1,
        "failed": 0,
    }
    source = facade.supabase.billing_enrollment_transition_intents[scheduled["intent"]["id"]]
    assert source["state"] == "reconciliation_required"
    assert source["reconciliation_reason_code"] == "whole_subscription_due_readback_unconfirmed"


def test_whole_due_grace_converges_after_cancellation_webhook():
    facade = _TransitionFacade(_tables())
    _TransitionStripe.subscriptions["sub_1"] = _provider(items=[_item()])
    boundary = datetime.fromisoformat(PERIOD_END)
    workflow = _workflow(facade, now=boundary + timedelta(minutes=1))
    scheduled = workflow.schedule_period_end(
        "enrollment_1", "studio_1", "actor_1", "whole-due-webhook-grace", "staff_requested"
    )

    deferred = workflow.process_due(worker_id="worker_1", limit=25)
    _TransitionStripe.subscriptions["sub_1"]["status"] = "canceled"
    facade._project_subscription(
        copy.deepcopy(_TransitionStripe.subscriptions["sub_1"]),
        "acct_1",
        event_type="customer.subscription.deleted",
    )
    completed = workflow.process_due(worker_id="worker_2", limit=25)

    assert deferred["completed"] == deferred["reconciliation_required"] == 0
    assert completed == {
        "claimed": 1,
        "completed": 1,
        "reconciliation_required": 0,
        "failed": 0,
    }
    source = facade.supabase.billing_enrollment_transition_intents[scheduled["intent"]["id"]]
    execute = next(
        intent
        for intent in facade.supabase.billing_enrollment_transition_intents.values()
        if intent.get("source_intent_id") == source["id"]
    )
    assert source["state"] == execute["state"] == "completed"
    assert _TransitionStripe.subscription_cancel_calls == []


def test_item_provider_schedule_applies_before_due_readback_and_converges_source_intent():
    peer = _enrollment(
        id="enrollment_2",
        student_id="student_2",
        billing_plan_id="plan_2",
        status="active",
        billing_subscription_id="group_1",
        stripe_subscription_id="sub_1",
        stripe_subscription_item_id="si_2",
    )
    facade = _TransitionFacade(_tables(peers=[peer]))
    facade.supabase.tables["billing_plans"].append(
        _plan(id="plan_2", stripe_price_id="price_2")
    )
    _TransitionStripe.subscriptions["sub_1"] = _provider(items=[_item(), _item("si_2", price_id="price_2")])
    manager = _manager(facade)

    scheduled = asyncio.run(manager.schedule_period_end(
        "enrollment_1", "studio_1", "actor_1", "item-due", "staff_requested"
    ))
    _apply_scheduled_item_phase()
    result = asyncio.run(manager.process_due_transitions(worker_id="worker_1", limit=25))
    replay = asyncio.run(manager.process_due_transitions(worker_id="worker_1", limit=25))

    assert result == {"claimed": 1, "completed": 1, "reconciliation_required": 0, "failed": 0}
    assert replay == {"claimed": 0, "completed": 0, "reconciliation_required": 0, "failed": 0}
    assert _TransitionStripe.subscription_update_calls == []
    assert _TransitionStripe.delete_item_calls == []
    assert len(_TransitionStripe.schedule_create_calls) == 1
    assert len(_TransitionStripe.schedule_update_calls) == 1
    assert len(_TransitionStripe.schedule_release_calls) == 1
    assert _TransitionStripe.subscriptions["sub_1"]["schedule"] is None
    assert facade.supabase.billing_enrollment_transition_intents[
        scheduled["intent"]["id"]
    ]["state"] == "completed"
    assert facade.supabase.tables["student_billing_enrollments"][0]["status"] == "canceled"
    assert facade.supabase.tables["student_billing_enrollments"][1]["status"] == "active"


def test_legacy_item_due_keeps_provider_mutation_owner_and_direct_execution_path():
    peer = _enrollment(
        id="enrollment_2",
        student_id="student_2",
        billing_plan_id="plan_2",
        status="active",
        billing_subscription_id="group_1",
        stripe_subscription_id="sub_1",
        stripe_subscription_item_id="si_2",
    )
    facade = _TransitionFacade(_tables(peers=[peer]))
    facade.supabase.tables["billing_plans"].append(
        _plan(id="plan_2", stripe_price_id="price_2")
    )
    _TransitionStripe.subscriptions["sub_1"] = _provider(
        items=[_item(), _item("si_2", price_id="price_2")]
    )
    manager = _manager(facade)
    scheduled = asyncio.run(manager.schedule_period_end(
        "enrollment_1",
        "studio_1",
        "actor_1",
        "legacy-item-due",
        "staff_requested",
    ))
    source = facade.supabase.billing_enrollment_transition_intents[
        scheduled["intent"]["id"]
    ]
    source.update({
        "provider_operation_id": None,
        "provider_caller_request_key": None,
        "provider_request_sha256": None,
    })
    _TransitionStripe.subscriptions["sub_1"]["schedule"] = None
    _TransitionStripe.schedules.clear()

    result = asyncio.run(manager.process_due_transitions(
        worker_id="legacy-worker",
        limit=25,
    ))

    execute = next(
        intent
        for intent in facade.supabase.billing_enrollment_transition_intents.values()
        if intent.get("source_intent_id") == source["id"]
    )
    assert result == {
        "claimed": 1,
        "completed": 1,
        "reconciliation_required": 0,
        "failed": 0,
    }
    assert execute["provider_caller_request_key"].startswith(
        "enrollment-period-execute:"
    )
    assert execute["provider_operation_id"] is not None
    assert len(_TransitionStripe.delete_item_calls) == 1
    assert source["state"] == execute["state"] == "completed"


def test_invoice_link_item_schedule_normalizes_real_subscription_invoice_settings():
    peer = _enrollment(
        id="enrollment_2",
        student_id="student_2",
        billing_plan_id="plan_2",
        status="active",
        billing_subscription_id="group_1",
        stripe_subscription_id="sub_1",
        stripe_subscription_item_id="si_2",
    )
    facade = _TransitionFacade(_tables(peers=[peer]))
    facade.supabase.tables["billing_plans"].append(
        _plan(id="plan_2", stripe_price_id="price_2")
    )
    _TransitionStripe.subscriptions["sub_1"] = _provider(
        items=[_item(), _item("si_2", price_id="price_2")],
        collection_method="send_invoice",
        days_until_due=7,
        default_payment_method=None,
    )

    asyncio.run(_manager(facade).schedule_period_end(
        "enrollment_1",
        "studio_1",
        "actor_1",
        "invoice-link-item-schedule",
        "staff_requested",
    ))

    schedule = next(iter(_TransitionStripe.schedules.values()))
    requested_phases = _TransitionStripe.schedule_update_calls[0]["phases"]
    assert [phase["collection_method"] for phase in requested_phases] == [
        "send_invoice",
        "send_invoice",
    ]
    assert [phase["invoice_settings"] for phase in requested_phases] == [
        {"days_until_due": 7},
        {"days_until_due": 7},
    ]
    assert schedule["default_settings"]["collection_method"] == "send_invoice"
    assert schedule["default_settings"]["invoice_settings"] == {
        "days_until_due": 7
    }
    assert schedule["default_settings"]["application_fee_percent"] == 0.5
    assert [phase["collection_method"] for phase in schedule["phases"]] == [
        None,
        None,
    ]
    assert [phase["invoice_settings"] for phase in schedule["phases"]] == [
        None,
        None,
    ]


def test_shared_item_rotation_webhook_does_not_split_family_before_due_cas():
    peer = _enrollment(
        id="enrollment_2",
        student_id="student_2",
        billing_plan_id="plan_1",
        status="active",
        billing_subscription_id="group_1",
        stripe_subscription_id="sub_1",
        stripe_subscription_item_id="si_1",
    )
    facade = _TransitionFacade(_tables(peers=[peer]))
    _TransitionStripe.subscriptions["sub_1"] = _provider(
        items=[_item(quantity=2)]
    )
    manager = _manager(facade)

    scheduled = asyncio.run(manager.schedule_period_end(
        "enrollment_1",
        "studio_1",
        "actor_1",
        "shared-item-webhook-before-due",
        "staff_requested",
    ))
    schedule = _TransitionStripe.schedules[
        _TransitionStripe.subscriptions["sub_1"]["schedule"]
    ]
    future_metadata = schedule["phases"][1]["items"][0]["metadata"]
    assert "enrollment_id" not in future_metadata
    assert "student_id" not in future_metadata

    _apply_scheduled_item_phase(rotate_items=True)
    provider = copy.deepcopy(_TransitionStripe.subscriptions["sub_1"])
    BillingSubscriptionWebhookProjector(facade).project_subscription_items(
        provider,
        facade.supabase.tables["billing_subscriptions"][0],
    )
    local = facade.supabase.tables["student_billing_enrollments"]
    assert [row["stripe_subscription_item_id"] for row in local] == [
        "si_1",
        "si_1",
    ]

    result = asyncio.run(manager.process_due_transitions(
        worker_id="worker_1",
        limit=25,
    ))

    assert result == {
        "claimed": 1,
        "completed": 1,
        "reconciliation_required": 0,
        "failed": 0,
    }
    assert facade.supabase.billing_enrollment_transition_intents[
        scheduled["intent"]["id"]
    ]["state"] == "completed"
    assert local[0]["status"] == "canceled"
    assert local[1]["status"] == "active"
    assert local[1]["stripe_subscription_item_id"] == "si_replacement_1"


def test_item_schedule_revoke_releases_exact_schedule_once_without_canceling_subscription():
    peer = _enrollment(
        id="enrollment_2",
        student_id="student_2",
        billing_plan_id="plan_2",
        status="active",
        billing_subscription_id="group_1",
        stripe_subscription_id="sub_1",
        stripe_subscription_item_id="si_2",
    )
    facade = _TransitionFacade(_tables(peers=[peer]))
    facade.supabase.tables["billing_plans"].append(
        _plan(id="plan_2", stripe_price_id="price_2")
    )
    _TransitionStripe.subscriptions["sub_1"] = _provider(
        items=[_item(), _item("si_2", price_id="price_2")]
    )
    workflow = _workflow(facade)
    scheduled = workflow.schedule_period_end(
        "enrollment_1", "studio_1", "actor_1", "item-release", "staff_requested"
    )

    revoked = workflow.revoke_scheduled(
        scheduled["intent"]["id"],
        scheduled["intent"]["revision"],
        "studio_1",
        "actor_1",
        "item-release-revoke",
        "staff_requested",
    )
    replay = workflow.revoke_scheduled(
        scheduled["intent"]["id"],
        scheduled["intent"]["revision"],
        "studio_1",
        "actor_1",
        "item-release-revoke",
        "staff_requested",
    )

    assert revoked["intent"]["state"] == replay["intent"]["state"] == "completed"
    assert len(_TransitionStripe.schedule_release_calls) == 1
    assert _TransitionStripe.subscription_cancel_calls == []
    assert _TransitionStripe.subscriptions["sub_1"]["schedule"] is None
    assert facade.supabase.billing_enrollment_transition_intents[
        scheduled["intent"]["id"]
    ]["state"] == "revoked"


def test_attached_item_schedule_blocks_immediate_sibling_mutation():
    peer = _enrollment(
        id="enrollment_2",
        student_id="student_2",
        billing_plan_id="plan_2",
        status="active",
        billing_subscription_id="group_1",
        stripe_subscription_id="sub_1",
        stripe_subscription_item_id="si_2",
    )
    facade = _TransitionFacade(_tables(peers=[peer]))
    facade.supabase.tables["billing_plans"].append(
        _plan(id="plan_2", stripe_price_id="price_2")
    )
    _TransitionStripe.subscriptions["sub_1"] = _provider(
        items=[_item(), _item("si_2", price_id="price_2")]
    )
    workflow = _workflow(facade)
    workflow.schedule_period_end(
        "enrollment_1", "studio_1", "actor_1", "item-schedule-first", "staff_requested"
    )

    with pytest.raises(HTTPException) as blocked:
        workflow.cancel_immediate(
            "enrollment_2", "studio_1", "actor_1", "sibling-immediate", "staff_requested"
        )

    assert blocked.value.status_code == 409
    assert _TransitionStripe.delete_item_calls == []
    assert _TransitionStripe.subscription_cancel_calls == []


def test_item_due_waits_for_provider_phase_through_grace_without_local_cancellation():
    peer = _enrollment(
        id="enrollment_2",
        student_id="student_2",
        billing_plan_id="plan_2",
        status="active",
        billing_subscription_id="group_1",
        stripe_subscription_id="sub_1",
        stripe_subscription_item_id="si_2",
    )
    facade = _TransitionFacade(_tables(peers=[peer]))
    facade.supabase.tables["billing_plans"].append(
        _plan(id="plan_2", stripe_price_id="price_2")
    )
    _TransitionStripe.subscriptions["sub_1"] = _provider(
        items=[_item(), _item("si_2", price_id="price_2")]
    )
    workflow = _workflow(
        facade,
        now=datetime.fromisoformat(PERIOD_END) + timedelta(minutes=1),
    )
    workflow.schedule_period_end(
        "enrollment_1", "studio_1", "actor_1", "item-phase-grace", "staff_requested"
    )

    pending = workflow.process_due(worker_id="worker_1", limit=25)
    assert pending == {
        "claimed": 1,
        "completed": 0,
        "reconciliation_required": 0,
        "failed": 0,
    }
    assert facade.supabase.tables["student_billing_enrollments"][0]["status"] == "active"
    assert _TransitionStripe.delete_item_calls == []

    _apply_scheduled_item_phase()
    completed = workflow.process_due(worker_id="worker_2", limit=25)
    assert completed == {
        "claimed": 1,
        "completed": 1,
        "reconciliation_required": 0,
        "failed": 0,
    }
    assert len(_TransitionStripe.schedule_release_calls) == 1
    assert _TransitionStripe.subscriptions["sub_1"]["schedule"] is None


def test_item_schedule_update_step_recovery_reuses_exact_step_key():
    peer = _enrollment(
        id="enrollment_2",
        student_id="student_2",
        billing_plan_id="plan_2",
        status="active",
        billing_subscription_id="group_1",
        stripe_subscription_id="sub_1",
        stripe_subscription_item_id="si_2",
    )
    facade = _TransitionFacade(_tables(peers=[peer]))
    _TransitionStripe.subscriptions["sub_1"] = _provider(
        items=[_item(), _item("si_2", price_id="price_2")]
    )
    workflow = _workflow(facade)
    _TransitionStripe.schedule_update_error = RuntimeError("update unavailable")

    with pytest.raises(HTTPException) as ambiguous:
        workflow.schedule_period_end(
            "enrollment_1", "studio_1", "actor_1", "item-step-recovery", "staff_requested"
        )
    assert ambiguous.value.status_code == 503

    intent = next(iter(facade.supabase.billing_enrollment_transition_intents.values()))
    operation = next(iter(facade.supabase.billing_provider_operations.values()))
    snapshot = workflow._snapshot_for_replay(intent)
    context = workflow._operation_context(intent, operation, lease_owner="recovery_worker")
    plan = workflow._item_schedule_provider_plan(intent, context, snapshot)
    step = workflow._provider_step_context(context, plan["plan_sha256"], 2, plan["steps"][1])
    stored_step = facade.supabase.billing_provider_step_plans[operation["id"]]["steps"][1]
    BillingProviderStepCoordinator(facade.supabase).authorize_step_recovery(
        step,
        stored_step,
        recovery_actor_id="recovery_admin",
        recovery_proof_sha256="a" * 64,
        recovery_outcome="provider_no_object_safe_to_retry",
    )
    first_update_key = _TransitionStripe.schedule_update_calls[0]["idempotency_key"]
    _TransitionStripe.schedule_update_error = None

    completed = workflow.schedule_period_end(
        "enrollment_1", "studio_1", "actor_1", "item-step-recovery", "staff_requested"
    )

    assert completed["intent"]["state"] == "scheduled"
    assert len(_TransitionStripe.schedule_create_calls) == 1
    assert len(_TransitionStripe.schedule_update_calls) == 2
    assert _TransitionStripe.schedule_update_calls[1]["idempotency_key"] == first_update_key


@pytest.mark.parametrize(
    ("failed_step", "error_attr", "expected_create_calls", "expected_update_calls"),
    [
        (1, "schedule_create_response_error_after", 1, 1),
        (2, "schedule_update_response_error_after", 1, 1),
    ],
)
def test_item_schedule_step_reconcile_only_reads_exact_provider_state_without_repeat(
    failed_step,
    error_attr,
    expected_create_calls,
    expected_update_calls,
):
    peer = _enrollment(
        id="enrollment_2",
        student_id="student_2",
        billing_plan_id="plan_2",
        status="active",
        billing_subscription_id="group_1",
        stripe_subscription_id="sub_1",
        stripe_subscription_item_id="si_2",
    )
    facade = _TransitionFacade(_tables(peers=[peer]))
    _TransitionStripe.subscriptions["sub_1"] = _provider(
        items=[_item(), _item("si_2", price_id="price_2")]
    )
    workflow = _workflow(facade)
    setattr(_TransitionStripe, error_attr, RuntimeError("provider response lost"))

    with pytest.raises(HTTPException) as ambiguous:
        workflow.schedule_period_end(
            "enrollment_1", "studio_1", "actor_1", f"reconcile-only-{failed_step}", "staff_requested"
        )
    assert ambiguous.value.status_code == 503
    _authorize_schedule_step_recovery(
        facade,
        workflow,
        step_order=failed_step,
        outcome="provider_succeeded_reconcile_only",
    )
    setattr(_TransitionStripe, error_attr, None)

    completed = workflow.schedule_period_end(
        "enrollment_1", "studio_1", "actor_1", f"reconcile-only-{failed_step}", "staff_requested"
    )

    assert completed["intent"]["state"] == "scheduled"
    assert len(_TransitionStripe.schedule_create_calls) == expected_create_calls
    assert len(_TransitionStripe.schedule_update_calls) == expected_update_calls


def test_item_schedule_create_policy_denial_terminally_rejects_without_provider_object():
    peer = _enrollment(
        id="enrollment_2",
        student_id="student_2",
        billing_plan_id="plan_2",
        status="active",
        billing_subscription_id="group_1",
        stripe_subscription_id="sub_1",
        stripe_subscription_item_id="si_2",
    )
    facade = _TransitionFacade(_tables(peers=[peer]))
    _TransitionStripe.subscriptions["sub_1"] = _provider(
        items=[_item(), _item("si_2", price_id="price_2")]
    )
    workflow = _workflow(facade)
    _TransitionStripe.schedule_create_error = StripeMutationBlocked(
        status_code=503,
        detail="operation not granted",
    )

    with pytest.raises(HTTPException) as blocked:
        workflow.schedule_period_end(
            "enrollment_1",
            "studio_1",
            "actor_1",
            "create-policy-denied",
            "staff_requested",
        )

    assert blocked.value.status_code == 409
    operation = next(iter(facade.supabase.billing_provider_operations.values()))
    intent = next(
        iter(facade.supabase.billing_enrollment_transition_intents.values())
    )
    steps = facade.supabase.billing_provider_step_plans[operation["id"]]["steps"]
    assert operation["state"] == "definitive_rejected"
    assert operation["error_code"] == "provider_mutation_blocked"
    assert operation.get("provider_object_id") is None
    assert operation.get("provider_secondary_object_id") is None
    assert intent["state"] == "definitive_rejected"
    assert [step["state"] for step in steps] == [
        "definitive_rejected",
        "pending",
    ]
    assert _TransitionStripe.schedules == {}
    assert _TransitionStripe.schedule_update_calls == []


def test_item_schedule_update_policy_denial_preserves_schedule_until_recovery_and_release():
    peer = _enrollment(
        id="enrollment_2",
        student_id="student_2",
        billing_plan_id="plan_2",
        status="active",
        billing_subscription_id="group_1",
        stripe_subscription_id="sub_1",
        stripe_subscription_item_id="si_2",
    )
    facade = _TransitionFacade(_tables(peers=[peer]))
    _TransitionStripe.subscriptions["sub_1"] = _provider(
        items=[_item(), _item("si_2", price_id="price_2")]
    )
    workflow = _workflow(facade)
    _TransitionStripe.schedule_update_error = StripeMutationBlocked(
        status_code=503,
        detail="operation not granted",
    )

    with pytest.raises(HTTPException) as blocked:
        workflow.schedule_period_end(
            "enrollment_1", "studio_1", "actor_1", "partial-policy", "staff_requested"
        )

    assert blocked.value.status_code == 503
    operation = next(iter(facade.supabase.billing_provider_operations.values()))
    assert operation["state"] == "reconciliation_required"
    assert _TransitionStripe.subscriptions["sub_1"]["schedule"] == "sub_sched_1"
    _authorize_schedule_step_recovery(
        facade,
        workflow,
        step_order=2,
        outcome="provider_no_object_safe_to_retry",
    )
    _TransitionStripe.schedule_update_error = None
    scheduled = workflow.schedule_period_end(
        "enrollment_1", "studio_1", "actor_1", "partial-policy", "staff_requested"
    )
    revoked = workflow.revoke_scheduled(
        scheduled["intent"]["id"],
        scheduled["intent"]["revision"],
        "studio_1",
        "actor_1",
        "partial-policy-release",
        "staff_requested",
    )

    assert revoked["intent"]["state"] == "completed"
    assert len(_TransitionStripe.schedule_release_calls) == 1
    assert _TransitionStripe.subscriptions["sub_1"]["schedule"] is None


def test_item_due_replacement_item_id_rebinds_every_surviving_shared_enrollment():
    peer = _enrollment(
        id="enrollment_2",
        student_id="student_2",
        status="active",
        billing_subscription_id="group_1",
        stripe_subscription_id="sub_1",
        stripe_subscription_item_id="si_1",
    )
    facade = _TransitionFacade(_tables(peers=[peer]))
    _TransitionStripe.subscriptions["sub_1"] = _provider(
        items=[_item(quantity=2)]
    )
    boundary = datetime.fromisoformat(PERIOD_END)
    workflow = _workflow(
        facade,
        now=boundary + WHOLE_SUBSCRIPTION_PERIOD_END_GRACE + timedelta(seconds=1),
    )
    workflow.schedule_period_end(
        "enrollment_1", "studio_1", "actor_1", "item-replacement", "staff_requested"
    )
    _apply_scheduled_item_phase()
    _TransitionStripe.subscriptions["sub_1"]["items"]["data"][0]["id"] = "si_replacement"
    mutation_counts = (
        len(_TransitionStripe.schedule_create_calls),
        len(_TransitionStripe.schedule_update_calls),
        len(_TransitionStripe.schedule_release_calls),
        len(_TransitionStripe.delete_item_calls),
    )

    result = workflow.process_due(worker_id="worker_1", limit=25)

    assert result == {
        "claimed": 1,
        "completed": 1,
        "reconciliation_required": 0,
        "failed": 0,
    }
    assert (
        len(_TransitionStripe.schedule_create_calls),
        len(_TransitionStripe.schedule_update_calls),
        len(_TransitionStripe.schedule_release_calls),
        len(_TransitionStripe.delete_item_calls),
    ) == (
        mutation_counts[0],
        mutation_counts[1],
        mutation_counts[2] + 1,
        mutation_counts[3],
    )
    target, survivor = facade.supabase.tables["student_billing_enrollments"]
    assert target["status"] == "canceled"
    assert target["stripe_subscription_item_id"] is None
    assert survivor["status"] == "active"
    assert survivor["stripe_subscription_item_id"] == "si_replacement"


def test_item_due_release_lost_response_converges_without_duplicate_release():
    peer = _enrollment(
        id="enrollment_2",
        student_id="student_2",
        billing_plan_id="plan_2",
        status="active",
        billing_subscription_id="group_1",
        stripe_subscription_id="sub_1",
        stripe_subscription_item_id="si_2",
    )
    facade = _TransitionFacade(_tables(peers=[peer]))
    facade.supabase.tables["billing_plans"].append(
        _plan(id="plan_2", stripe_price_id="price_2")
    )
    _TransitionStripe.subscriptions["sub_1"] = _provider(
        items=[_item(), _item("si_2", price_id="price_2")]
    )
    workflow = _workflow(facade)
    scheduled = workflow.schedule_period_end(
        "enrollment_1", "studio_1", "actor_1", "due-release-lost", "staff_requested"
    )
    _apply_scheduled_item_phase()
    for index in range(15):
        unrelated_id = f"sub_sched_unrelated_{index}"
        _TransitionStripe.schedules[unrelated_id] = {
            "id": unrelated_id,
            "status": "released",
            "subscription": None,
            "released_subscription": f"sub_unrelated_{index}",
            "customer": "cus_1",
            "metadata": {"koaryu_transition_intent_id": f"unrelated-{index}"},
            "phases": [],
        }
    retrieve_count_before_due = len(_TransitionStripe.schedule_retrieve_calls)
    _TransitionStripe.schedule_release_response_error_after = RuntimeError(
        "release response lost"
    )

    completed = workflow.process_due(worker_id="worker_1", limit=25)
    replay = workflow.process_due(worker_id="worker_2", limit=25)

    assert completed == {
        "claimed": 1,
        "completed": 1,
        "reconciliation_required": 0,
        "failed": 0,
    }
    assert replay == {
        "claimed": 0,
        "completed": 0,
        "reconciliation_required": 0,
        "failed": 0,
    }
    assert len(_TransitionStripe.schedule_release_calls) == 1
    release_call = _TransitionStripe.schedule_release_calls[0]
    assert release_call["schedule_id"] == "sub_sched_1"
    assert str(scheduled["intent"]["id"]) in release_call["idempotency_key"]
    assert _TransitionStripe.subscriptions["sub_1"]["schedule"] is None
    assert _TransitionStripe.schedule_list_calls == []
    assert {
        call["schedule_id"]
        for call in _TransitionStripe.schedule_retrieve_calls[
            retrieve_count_before_due:
        ]
    } == {"sub_sched_1"}


def test_item_due_reclaim_after_release_before_completion_does_not_release_twice():
    peer = _enrollment(
        id="enrollment_2",
        student_id="student_2",
        billing_plan_id="plan_2",
        status="active",
        billing_subscription_id="group_1",
        stripe_subscription_id="sub_1",
        stripe_subscription_item_id="si_2",
    )
    facade = _TransitionFacade(_tables(peers=[peer]))
    facade.supabase.tables["billing_plans"].append(
        _plan(id="plan_2", stripe_price_id="price_2")
    )
    _TransitionStripe.subscriptions["sub_1"] = _provider(
        items=[_item(), _item("si_2", price_id="price_2")]
    )
    workflow = _workflow(facade)
    workflow.schedule_period_end(
        "enrollment_1", "studio_1", "actor_1", "due-release-crash", "staff_requested"
    )
    _apply_scheduled_item_phase()
    execute = workflow.operations.claim_due_enrollment_transitions(
        worker_id="worker_1",
        limit=25,
    )[0]
    snapshot = workflow._snapshot_for_replay(execute)
    provider = workflow._retrieve_subscription(snapshot)
    workflow._release_owned_item_schedule_after_due(
        execute,
        snapshot,
        provider,
    )

    completed = workflow.process_due(worker_id="worker_2", limit=25)

    assert completed == {
        "claimed": 1,
        "completed": 1,
        "reconciliation_required": 0,
        "failed": 0,
    }
    assert len(_TransitionStripe.schedule_release_calls) == 1
    assert _TransitionStripe.subscriptions["sub_1"]["schedule"] is None


def test_item_due_release_failure_reconciles_with_owned_schedule_still_attached():
    peer = _enrollment(
        id="enrollment_2",
        student_id="student_2",
        billing_plan_id="plan_2",
        status="active",
        billing_subscription_id="group_1",
        stripe_subscription_id="sub_1",
        stripe_subscription_item_id="si_2",
    )
    facade = _TransitionFacade(_tables(peers=[peer]))
    facade.supabase.tables["billing_plans"].append(
        _plan(id="plan_2", stripe_price_id="price_2")
    )
    _TransitionStripe.subscriptions["sub_1"] = _provider(
        items=[_item(), _item("si_2", price_id="price_2")]
    )
    workflow = _workflow(facade)
    scheduled = workflow.schedule_period_end(
        "enrollment_1", "studio_1", "actor_1", "due-release-failed", "staff_requested"
    )
    _apply_scheduled_item_phase()
    _TransitionStripe.schedule_release_error = RuntimeError("release unavailable")

    result = workflow.process_due(worker_id="worker_1", limit=25)

    assert result == {
        "claimed": 1,
        "completed": 0,
        "reconciliation_required": 1,
        "failed": 0,
    }
    assert len(_TransitionStripe.schedule_release_calls) == 1
    assert _TransitionStripe.subscriptions["sub_1"]["schedule"] == "sub_sched_1"
    assert facade.supabase.billing_enrollment_transition_intents[
        scheduled["intent"]["id"]
    ]["state"] == "reconciliation_required"


def test_item_due_never_releases_schedule_with_mismatched_owner_metadata():
    peer = _enrollment(
        id="enrollment_2",
        student_id="student_2",
        billing_plan_id="plan_2",
        status="active",
        billing_subscription_id="group_1",
        stripe_subscription_id="sub_1",
        stripe_subscription_item_id="si_2",
    )
    facade = _TransitionFacade(_tables(peers=[peer]))
    facade.supabase.tables["billing_plans"].append(
        _plan(id="plan_2", stripe_price_id="price_2")
    )
    _TransitionStripe.subscriptions["sub_1"] = _provider(
        items=[_item(), _item("si_2", price_id="price_2")]
    )
    workflow = _workflow(facade)
    scheduled = workflow.schedule_period_end(
        "enrollment_1", "studio_1", "actor_1", "due-release-owner", "staff_requested"
    )
    _apply_scheduled_item_phase()
    _TransitionStripe.schedules["sub_sched_1"]["metadata"][
        "koaryu_transition_intent_id"
    ] = "00000000-0000-4000-8000-000000000999"

    result = workflow.process_due(worker_id="worker_1", limit=25)

    assert result == {
        "claimed": 1,
        "completed": 0,
        "reconciliation_required": 1,
        "failed": 0,
    }
    assert _TransitionStripe.schedule_release_calls == []
    assert _TransitionStripe.schedule_list_calls == []
    assert _TransitionStripe.schedule_retrieve_calls[-1]["schedule_id"] == "sub_sched_1"
    assert _TransitionStripe.subscriptions["sub_1"]["schedule"] == "sub_sched_1"
    assert facade.supabase.billing_enrollment_transition_intents[
        scheduled["intent"]["id"]
    ]["state"] == "reconciliation_required"


@pytest.mark.parametrize("readback_mode", ["failure", "mismatch"])
def test_item_due_exact_schedule_readback_failure_never_projects(
    readback_mode,
):
    peer = _enrollment(
        id="enrollment_2",
        student_id="student_2",
        billing_plan_id="plan_2",
        status="active",
        billing_subscription_id="group_1",
        stripe_subscription_id="sub_1",
        stripe_subscription_item_id="si_2",
    )
    facade = _TransitionFacade(_tables(peers=[peer]))
    facade.supabase.tables["billing_plans"].append(
        _plan(id="plan_2", stripe_price_id="price_2")
    )
    _TransitionStripe.subscriptions["sub_1"] = _provider(
        items=[_item(), _item("si_2", price_id="price_2")]
    )
    workflow = _workflow(facade)
    scheduled = workflow.schedule_period_end(
        "enrollment_1",
        "studio_1",
        "actor_1",
        f"due-release-read-{readback_mode}",
        "staff_requested",
    )
    _apply_scheduled_item_phase()
    released = _TransitionStripe.schedules["sub_sched_1"]
    released.update({
        "status": "released",
        "subscription": None,
        "released_subscription": "sub_1",
    })
    _TransitionStripe.subscriptions["sub_1"]["schedule"] = None
    if readback_mode == "failure":
        _TransitionStripe.schedule_retrieve_error = RuntimeError(
            "schedule read unavailable"
        )
    else:
        mismatched = copy.deepcopy(released)
        mismatched["id"] = "sub_sched_mismatch"
        _TransitionStripe.schedule_retrieve_override = mismatched

    result = workflow.process_due(worker_id="worker_1", limit=25)

    assert result == {
        "claimed": 1,
        "completed": 0,
        "reconciliation_required": 1,
        "failed": 0,
    }
    assert _TransitionStripe.schedule_release_calls == []
    assert _TransitionStripe.schedule_list_calls == []
    assert _TransitionStripe.schedule_retrieve_calls[-1] == {
        "account_id": "acct_1",
        "schedule_id": "sub_sched_1",
    }
    assert facade.supabase.tables["student_billing_enrollments"][0]["status"] == "active"
    assert "complete_due_billing_enrollment_item_transition_v31" not in {
        name for name, _params in facade.supabase.rpc_calls
    }
    assert facade.supabase.billing_enrollment_transition_intents[
        scheduled["intent"]["id"]
    ]["state"] == "reconciliation_required"


def test_item_due_recovery_rejects_copied_metadata_on_different_schedule_id():
    peer = _enrollment(
        id="enrollment_2",
        student_id="student_2",
        billing_plan_id="plan_2",
        status="active",
        billing_subscription_id="group_1",
        stripe_subscription_id="sub_1",
        stripe_subscription_item_id="si_2",
    )
    facade = _TransitionFacade(_tables(peers=[peer]))
    facade.supabase.tables["billing_plans"].append(
        _plan(id="plan_2", stripe_price_id="price_2")
    )
    _TransitionStripe.subscriptions["sub_1"] = _provider(
        items=[_item(), _item("si_2", price_id="price_2")]
    )
    workflow = _workflow(facade)
    scheduled = workflow.schedule_period_end(
        "enrollment_1", "studio_1", "actor_1", "due-release-copy", "staff_requested"
    )
    _apply_scheduled_item_phase()
    copied = copy.deepcopy(_TransitionStripe.schedules.pop("sub_sched_1"))
    copied.update({
        "id": "sub_sched_copied",
        "status": "released",
        "subscription": None,
        "released_subscription": "sub_1",
    })
    _TransitionStripe.schedules[copied["id"]] = copied
    _TransitionStripe.subscriptions["sub_1"]["schedule"] = None

    result = workflow.process_due(worker_id="worker_1", limit=25)

    assert result == {
        "claimed": 1,
        "completed": 0,
        "reconciliation_required": 1,
        "failed": 0,
    }
    assert _TransitionStripe.schedule_release_calls == []
    assert _TransitionStripe.schedule_list_calls == []
    assert _TransitionStripe.schedule_retrieve_calls[-1] == {
        "account_id": "acct_1",
        "schedule_id": "sub_sched_1",
    }
    assert facade.supabase.tables["student_billing_enrollments"][0]["status"] == "active"
    assert "complete_due_billing_enrollment_item_transition_v31" not in {
        name for name, _params in facade.supabase.rpc_calls
    }
    assert facade.supabase.billing_enrollment_transition_intents[
        scheduled["intent"]["id"]
    ]["state"] == "reconciliation_required"


def test_whole_due_unconfirmed_readback_marks_source_reconciliation_without_mutation():
    facade = _TransitionFacade(_tables())
    _TransitionStripe.subscriptions["sub_1"] = _provider(items=[_item()])
    manager = _manager(facade)
    scheduled = asyncio.run(manager.schedule_period_end(
        "enrollment_1", "studio_1", "actor_1", "whole-due-unknown", "staff_requested"
    ))

    result = asyncio.run(manager.process_due_transitions(worker_id="worker_1", limit=25))

    assert result == {"claimed": 1, "completed": 0, "reconciliation_required": 1, "failed": 0}
    assert facade.supabase.billing_enrollment_transition_intents[
        scheduled["intent"]["id"]
    ]["state"] == "reconciliation_required"
    assert len(_TransitionStripe.subscription_update_calls) == 1
    assert _TransitionStripe.subscription_cancel_calls == []


def test_item_due_fact_drift_fails_before_provider_operation_or_mutation():
    peer = _enrollment(
        id="enrollment_2",
        student_id="student_2",
        status="active",
        billing_subscription_id="group_1",
        stripe_subscription_id="sub_1",
        stripe_subscription_item_id="si_2",
    )
    facade = _TransitionFacade(_tables(peers=[peer]))
    _TransitionStripe.subscriptions["sub_1"] = _provider(items=[_item(), _item("si_2", price_id="price_2")])
    manager = _manager(facade)
    scheduled = asyncio.run(manager.schedule_period_end(
        "enrollment_1", "studio_1", "actor_1", "item-drift", "staff_requested"
    ))
    _TransitionStripe.subscriptions["sub_1"]["items"]["data"][0]["quantity"] = 2

    result = asyncio.run(manager.process_due_transitions(worker_id="worker_1", limit=25))

    assert result == {"claimed": 1, "completed": 0, "reconciliation_required": 1, "failed": 0}
    assert _TransitionStripe.delete_item_calls == []
    assert _TransitionStripe.subscription_cancel_calls == []
    assert len(facade.supabase.billing_provider_operations) == 1
    assert {
        operation["operation_type"]
        for operation in facade.supabase.billing_provider_operations.values()
    } == {"enrollment.cancel.period_end.schedule"}
    source = facade.supabase.billing_enrollment_transition_intents[scheduled["intent"]["id"]]
    execute = next(
        intent
        for intent in facade.supabase.billing_enrollment_transition_intents.values()
        if intent.get("source_intent_id") == source["id"]
    )
    assert source["state"] == execute["state"] == "reconciliation_required"
    assert source["reconciliation_reason_code"] == "item_schedule_due_readback_unconfirmed"
    assert execute["reconciliation_reason_code"] == "item_schedule_due_readback_unconfirmed"


def test_transition_key_is_required_and_bounded_by_utf8_bytes():
    with pytest.raises(HTTPException) as missing:
        BillingEnrollmentTransitionWorkflow._request_key("   ")
    with pytest.raises(HTTPException) as oversized:
        BillingEnrollmentTransitionWorkflow._request_key("é" * 128)

    assert missing.value.status_code == 400
    assert oversized.value.status_code == 400
