from __future__ import annotations

import asyncio

from tests.test_billing_enrollment_transitions import (
    _TransitionFacade,
    _TransitionStripe,
    _item,
    _manager,
    _provider,
    _tables,
)


def _install_scheduled_transition_list_rpc(facade: _TransitionFacade) -> None:
    def list_scheduled(params: dict) -> list[dict]:
        requested_ids = set(params["p_enrollment_ids"])
        return [
            {
                "enrollment_id": intent["enrollment_id"],
                "intent_id": intent["id"],
                "revision": intent["revision"],
            }
            for intent in facade.supabase.billing_enrollment_transition_intents.values()
            if intent["studio_id"] == params["p_studio_id"]
            and intent["enrollment_id"] in requested_ids
            and intent["transition_kind"] == "schedule_period_end"
            and intent["state"] == "scheduled"
        ]

    facade.supabase._rpc_list_billing_enrollment_scheduled_transitions_v1 = (
        list_scheduled
    )


def test_scheduled_transition_survives_reload_and_disappears_after_revoke():
    _TransitionStripe.reset()
    facade = _TransitionFacade(_tables())
    _install_scheduled_transition_list_rpc(facade)
    _TransitionStripe.subscriptions["sub_1"] = _provider(items=[_item()])

    scheduled = asyncio.run(_manager(facade).schedule_period_end(
        "enrollment_1",
        "studio_1",
        "actor_1",
        "schedule-before-reload",
        "staff_requested",
    ))

    reloaded = asyncio.run(_manager(facade).list_enrollments("studio_1"))
    durable_transition = reloaded[0].scheduled_period_end_transition
    assert durable_transition is not None
    assert durable_transition.intent_id == scheduled["intent"]["id"]
    assert durable_transition.revision == scheduled["intent"]["revision"]

    asyncio.run(_manager(facade).revoke_scheduled_transition(
        durable_transition.intent_id,
        durable_transition.revision,
        "studio_1",
        "actor_1",
        "revoke-after-reload",
        "staff_requested",
    ))

    after_revoke = asyncio.run(_manager(facade).list_enrollments("studio_1"))
    assert after_revoke[0].scheduled_period_end_transition is None
    assert [
        call["cancel_at_period_end"]
        for call in _TransitionStripe.subscription_update_calls
    ] == [True, False]

    list_calls = [
        params
        for name, params in facade.supabase.rpc_calls
        if name == "list_billing_enrollment_scheduled_transitions_v1"
    ]
    assert list_calls == [
        {
            "p_studio_id": "studio_1",
            "p_enrollment_ids": ["enrollment_1"],
        },
        {
            "p_studio_id": "studio_1",
            "p_enrollment_ids": ["enrollment_1"],
        },
    ]
