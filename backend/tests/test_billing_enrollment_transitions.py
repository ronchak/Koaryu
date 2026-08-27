from __future__ import annotations

import asyncio
import copy

import pytest
from fastapi import HTTPException

from app.services.billing_enrollments import BillingEnrollmentManager
from app.services.billing_enrollment_transitions import BillingEnrollmentTransitionWorkflow
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


def test_identity_drift_between_claim_and_mutation_reconciles_without_provider_write(monkeypatch):
    facade = _TransitionFacade(_tables())
    _TransitionStripe.subscriptions["sub_1"] = _provider(items=[_item()])
    original = _TransitionStripe.retrieve_connected_subscription
    reads = 0

    def retrieve_with_drift(self, **payload):
        nonlocal reads
        reads += 1
        provider = original(self, **payload)
        if reads == 2:
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
