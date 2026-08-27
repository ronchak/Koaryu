from __future__ import annotations

import asyncio
import copy
from datetime import datetime, timedelta

import pytest
from fastapi import HTTPException

from app.services.billing_enrollments import BillingEnrollmentManager
from app.services.billing_enrollment_transitions import (
    BillingEnrollmentTransitionWorkflow,
    WHOLE_SUBSCRIPTION_PERIOD_END_GRACE,
)
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

    @classmethod
    def reset(cls):
        super().reset()
        cls.subscription_update_calls = []
        cls.subscription_cancel_calls = []
        cls.delete_item_calls = []

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


def _provider(*, items, status="active", cancel_at_period_end=False):
    return {
        "id": "sub_1",
        "status": status,
        "customer": "cus_1",
        "cancel_at_period_end": cancel_at_period_end,
        "current_period_end": PERIOD_END_EPOCH,
        "metadata": {
            "studio_id": "studio_1",
            "payer_id": "payer_1",
            "billing_subscription_id": "group_1",
        },
        "items": {"data": items},
    }


def _item(item_id="si_1", quantity=1):
    return {"id": item_id, "quantity": quantity, "price": {"id": "price_1"}, "metadata": {}}


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
        status="active",
        billing_subscription_id="group_1",
        stripe_subscription_id="sub_1",
        stripe_subscription_item_id="si_2",
    )
    facade = _TransitionFacade(_tables(peers=[peer]))
    _TransitionStripe.subscriptions["sub_1"] = _provider(items=[_item(), _item("si_2")])

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
    _TransitionStripe.subscriptions["sub_1"] = _provider(items=[_item(), _item("si_2")])
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


def test_item_due_deletes_once_and_converges_source_intent():
    peer = _enrollment(
        id="enrollment_2",
        student_id="student_2",
        status="active",
        billing_subscription_id="group_1",
        stripe_subscription_id="sub_1",
        stripe_subscription_item_id="si_2",
    )
    facade = _TransitionFacade(_tables(peers=[peer]))
    _TransitionStripe.subscriptions["sub_1"] = _provider(items=[_item(), _item("si_2")])
    manager = _manager(facade)

    scheduled = asyncio.run(manager.schedule_period_end(
        "enrollment_1", "studio_1", "actor_1", "item-due", "staff_requested"
    ))
    result = asyncio.run(manager.process_due_transitions(worker_id="worker_1", limit=25))
    replay = asyncio.run(manager.process_due_transitions(worker_id="worker_1", limit=25))

    assert result == {"claimed": 1, "completed": 1, "reconciliation_required": 0, "failed": 0}
    assert replay == {"claimed": 0, "completed": 0, "reconciliation_required": 0, "failed": 0}
    assert _TransitionStripe.subscription_update_calls == []
    assert len(_TransitionStripe.delete_item_calls) == 1
    assert _TransitionStripe.delete_item_calls[0]["subscription_item_id"] == "si_1"
    assert facade.supabase.billing_enrollment_transition_intents[
        scheduled["intent"]["id"]
    ]["state"] == "completed"
    assert facade.supabase.tables["student_billing_enrollments"][0]["status"] == "canceled"
    assert facade.supabase.tables["student_billing_enrollments"][1]["status"] == "active"


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
    _TransitionStripe.subscriptions["sub_1"] = _provider(items=[_item(), _item("si_2")])
    manager = _manager(facade)
    scheduled = asyncio.run(manager.schedule_period_end(
        "enrollment_1", "studio_1", "actor_1", "item-drift", "staff_requested"
    ))
    _TransitionStripe.subscriptions["sub_1"]["items"]["data"][0]["quantity"] = 2

    result = asyncio.run(manager.process_due_transitions(worker_id="worker_1", limit=25))

    assert result == {"claimed": 1, "completed": 0, "reconciliation_required": 1, "failed": 0}
    assert _TransitionStripe.delete_item_calls == []
    assert _TransitionStripe.subscription_cancel_calls == []
    assert facade.supabase.billing_provider_operations == {}
    source = facade.supabase.billing_enrollment_transition_intents[scheduled["intent"]["id"]]
    execute = next(
        intent
        for intent in facade.supabase.billing_enrollment_transition_intents.values()
        if intent.get("source_intent_id") == source["id"]
    )
    assert source["state"] == execute["state"] == "reconciliation_required"
    assert source["reconciliation_reason_code"] == "item_due_pre_provider_identity_drift"
    assert execute["reconciliation_reason_code"] == "item_due_pre_provider_identity_drift"


def test_transition_key_is_required_and_bounded_by_utf8_bytes():
    with pytest.raises(HTTPException) as missing:
        BillingEnrollmentTransitionWorkflow._request_key("   ")
    with pytest.raises(HTTPException) as oversized:
        BillingEnrollmentTransitionWorkflow._request_key("é" * 128)

    assert missing.value.status_code == 400
    assert oversized.value.status_code == 400
