from __future__ import annotations

import asyncio
import copy

import pytest
from fastapi import HTTPException

from app.services.billing_enrollments import BillingEnrollmentManager
from app.services.stripe_mutation_policy import StripeMutationBlocked
from app.services.billing_provider_operations import BillingProviderOperationContext, BillingProviderOperationCoordinator
from app.services.platform_billing_helpers import stable_hash
from tests.billing_enrollment_activation_fixtures import (
    _Facade,
    _Stripe,
    _enrollment,
    _group,
    _plan,
    _price,
    _provider_subscription,
    _tables,
)


def _manager(facade):
    return BillingEnrollmentManager(facade, stripe_service_cls=_Stripe)


@pytest.fixture(autouse=True)
def _reset_stripe():
    _Stripe.reset()


def _operation(facade):
    return next(iter(facade.supabase.billing_provider_operations.values()))


def _existing_subscription_case(branch):
    if branch == "add_item":
        facade = _Facade(_tables(group=_group()))
        provider = _provider_subscription()
    else:
        item = {
            "id": "si_shared",
            "price": {"id": "price_1"},
            "quantity": 1,
            "metadata": {
                "studio_id": "studio_1",
                "payer_id": "payer_1",
                "billing_plan_id": "plan_1",
                "billing_subscription_id": "group_1",
            },
        }
        peer = _enrollment(
            id="enrollment_peer",
            billing_subscription_id="group_1",
            stripe_subscription_id="sub_1",
            stripe_subscription_item_id="si_shared",
            status="active",
        )
        facade = _Facade(_tables(group=_group(), peers=[peer]))
        provider = _provider_subscription(items=[item])
    _Stripe.subscriptions["sub_1"] = provider
    return facade


def test_activation_requires_canonical_key_and_recurring_identity():
    for key in (None, "é" * 128):
        facade = _Facade(_tables())
        with pytest.raises(HTTPException) as exc:
            asyncio.run(_manager(facade).activate_enrollment(
                "enrollment_1", "studio_1", "actor_1", key
            ))
        assert exc.value.status_code == 400
        assert facade.supabase.billing_provider_operations == {}

    for enrollment, plan in (
        (_enrollment(collection_mode="external"), _plan()),
        (_enrollment(), _plan(billing_interval="paid_in_full")),
    ):
        tables = _tables(enrollment=enrollment)
        tables["billing_plans"] = [plan]
        facade = _Facade(tables)
        with pytest.raises(HTTPException) as exc:
            asyncio.run(_manager(facade).activate_enrollment(
                "enrollment_1", "studio_1", "actor_1", "activation-key"
            ))
        assert exc.value.status_code == 409
        assert facade.supabase.billing_provider_operations == {}
        assert _Stripe.create_subscription_calls == []


@pytest.mark.parametrize("mode", ["autopay", "invoice_link"])
def test_new_non_usd_activation_leaves_local_and_provider_state_unchanged(mode):
    tables = _tables(enrollment=_enrollment(collection_mode=mode))
    tables["billing_plans"] = [_plan(currency="eur")]
    tables["billing_plan_prices"] = [_price(currency="eur")]
    facade = _Facade(tables)
    before = copy.deepcopy(facade.supabase.tables)
    with pytest.raises(HTTPException) as failure:
        asyncio.run(_manager(facade).activate_enrollment("enrollment_1", "studio_1", "actor_1", "new-eur"))
    assert failure.value.status_code == 400 and "USD" in failure.value.detail
    assert facade.supabase.tables == before
    assert not facade.supabase.billing_provider_operations
    assert not (_Stripe.create_subscription_calls or _Stripe.add_item_calls or _Stripe.update_item_calls)


@pytest.mark.parametrize("stage,error", [("unattempted", 400), ("attempted", 409), ("confirmed", None)])
def test_historical_non_usd_activation_uses_saved_provider_outcome(stage, error):
    intent = {"version": 1, "operation_type": "enrollment.activate.invoice", "studio_id": "studio_1",
        "enrollment_id": "enrollment_1", "student_id": "student_1", "payer_id": "payer_1", "plan_id": "plan_1",
        "account_id": "acct_1", "generation": 2, "customer_id": "cus_1", "product_id": "prod_1",
        "price_id": "price_1", "group_id": "group_1", "branch": "add_item", "expected_quantity": 1,
        "expected_subscription_id": "sub_1", "expected_item_id": None}
    intent["desired_sha256"] = stable_hash(intent)
    tables = _tables(group=_group(currency="eur"), enrollment=_enrollment(metadata={"provider_activation_intent": intent}))
    tables["billing_plans"] = [_plan(currency="eur")]
    tables["billing_plan_prices"] = [_price(currency="eur")]
    facade = _Facade(tables)
    operations = BillingProviderOperationCoordinator(facade.supabase)
    lease = "00000000-0000-4000-8000-000000000101"
    claimed = operations.claim_resource(studio_id="studio_1", actor_id="actor_1", operation_type="enrollment.activate.invoice",
        resource_type="enrollment", resource_id="enrollment_1", payer_id="payer_1", caller_request_key="historical",
        request_sha256=intent["desired_sha256"], stripe_connected_account_id="acct_1", connect_account_generation=2, lease_owner=lease)
    operation = claimed["operation"]
    context = BillingProviderOperationContext(operation["id"], "studio_1", "actor_1", "enrollment.activate.invoice",
        "historical", intent["desired_sha256"], "acct_1", 2, lease)
    if stage != "unattempted":
        operation = operations.transition(context, operation, "provider_request_in_flight")
    if stage == "confirmed":
        operations.transition(context, operation, "provider_succeeded", provider_object_id="sub_1",
            provider_secondary_object_id="si_historical", result_code="enrollment_activation_provider_succeeded")
        _Stripe.subscriptions["sub_1"] = _provider_subscription(items=[{"id": "si_historical", "quantity": 1,
            "price": {"id": "price_1"}, "metadata": {"studio_id": "studio_1", "payer_id": "payer_1",
            "billing_plan_id": "plan_1", "billing_subscription_id": "group_1", "enrollment_id": "enrollment_1"}}])
    facade.supabase.advance_billing_provider_clock(seconds=31)
    if error:
        with pytest.raises(HTTPException) as failure:
            asyncio.run(_manager(facade).activate_enrollment("enrollment_1", "studio_1", "actor_1", "historical"))
        assert failure.value.status_code == error
    else:
        asyncio.run(_manager(facade).activate_enrollment("enrollment_1", "studio_1", "actor_1", "historical"))
        replay = asyncio.run(_manager(facade).activate_enrollment("enrollment_1", "studio_1", "actor_1", "historical"))
        assert replay.stripe_subscription_item_id == "si_historical" and replay.status == "active"
        assert _operation(facade)["state"] == "completed"
        assert len(_Stripe.retrieve_calls) == 1
    assert _operation(facade)["provider_request_attempt_count"] == (0 if stage == "unattempted" else 1)
    assert _operation(facade)["caller_request_key"] == "historical"
    assert _operation(facade)["request_sha256"] == intent["desired_sha256"]
    assert all(facade.supabase.tables[name][0]["currency"] == "eur" for name in (
        "billing_plans", "billing_plan_prices", "billing_subscriptions"))
    assert not (_Stripe.create_subscription_calls or _Stripe.add_item_calls or _Stripe.update_item_calls)


@pytest.mark.parametrize("branch,subscription_id,item_id,key_suffix", [
    ("create_subscription", "sub_created", "si_created", "create-subscription"),
    ("add_item", "sub_1", "si_added", "add-item"),
    ("update_quantity", "sub_1", "si_shared", "update-quantity"),
])
def test_activation_branches_preserve_exact_owner_replay_and_release_lock(branch, subscription_id, item_id, key_suffix):
    facade = _Facade(_tables()) if branch == "create_subscription" else _existing_subscription_case(branch)
    if branch == "update_quantity":
        facade.supabase.tables["student_billing_enrollments"].append(_enrollment(
            id="enrollment_detaching", billing_subscription_id="group_1", stripe_subscription_id="sub_1",
            stripe_subscription_item_id="si_shared", metadata={"stripe_detach_pending": {"reason": "cancel"}}))
    manager = _manager(facade)

    def activate(key, actor="actor_1"):
        return asyncio.run(manager.activate_enrollment("enrollment_1", "studio_1", actor, key))

    first = activate("activation-owner")
    with pytest.raises(HTTPException) as denied:
        activate("activation-cross-actor", "actor_2")
    alias = activate("activation-adopter")
    replay = activate("activation-owner")
    assert denied.value.status_code == 409
    assert first.status == alias.status == replay.status == "active"
    assert first.stripe_subscription_id == alias.stripe_subscription_id == replay.stripe_subscription_id == subscription_id
    assert first.stripe_subscription_item_id == replay.stripe_subscription_item_id == item_id
    calls = {"create_subscription": _Stripe.create_subscription_calls,
             "add_item": _Stripe.add_item_calls, "update_quantity": _Stripe.update_item_calls}
    assert len(calls[branch]) == sum(map(len, calls.values())) == 1
    assert len(facade.supabase.tables["audit_logs"]) == 1
    parent = _operation(facade)
    assert (parent["state"], parent["actor_id"], parent["caller_request_key"]) == ("completed", "actor_1", "activation-owner")
    assert facade.supabase.billing_provider_operation_aliases[("studio_1", "enrollment.activate.invoice", "activation-adopter")] == parent["id"]
    intent = facade.supabase.tables["student_billing_enrollments"][0]["metadata"]["provider_activation_intent"]
    expected = {"create_subscription": (None, None, 1), "add_item": ("sub_1", None, 1),
                "update_quantity": ("sub_1", "si_shared", 2)}[branch]
    assert intent["branch"] == branch
    assert (intent["expected_subscription_id"], intent["expected_item_id"], intent["expected_quantity"]) == expected
    assert calls[branch][0]["idempotency_key"] == f"koaryu:enrollment-activate:{parent['id']}:{key_suffix}"
    if branch == "update_quantity":
        assert calls[branch][0]["quantity"] == 2
    claim = next(params for name, params in facade.supabase.rpc_calls if name == "claim_billing_provider_operation_resource_v1")
    assert (claim["p_resource_type"], claim["p_resource_id"], claim["p_payer_id"]) == ("enrollment", "enrollment_1", "payer_1")
    names = [name for name, _ in facade.supabase.rpc_calls]
    assert names.index("claim_billing_subscription_quantity_sync") < names.index("claim_billing_provider_operation_resource_v1")
    assert names[-1] == "finish_billing_subscription_quantity_sync"
    assert "stripe_quantity_sync_lock" not in facade.supabase.tables["billing_subscriptions"][0]["metadata"]
    assert "Core plan" not in repr(parent)


def test_provider_backed_legacy_group_adopts_generation_before_add_item():
    group = _group(metadata={"legacy_marker": "keep"})
    facade = _Facade(_tables(group=group))
    _Stripe.subscriptions["sub_1"] = _provider_subscription()

    result = asyncio.run(_manager(facade).activate_enrollment(
        "enrollment_1", "studio_1", "actor_1", "legacy-group-key"
    ))

    assert result.stripe_subscription_item_id == "si_added"
    assert group["metadata"] == {
        "legacy_marker": "keep",
        "connect_account_generation": 2,
    }
    adoption = next(
        query
        for query in facade.supabase.query_log
        if query["table"] == "billing_subscriptions"
        and query["update"]
        and query["update"].get("metadata", {}).get("connect_account_generation") == 2
    )
    assert ("is", "metadata->connect_account_generation", "null") in adoption["filters"]
    assert ("eq", "stripe_subscription_id", "sub_1") in adoption["filters"]


def test_legacy_group_adoption_rejects_stale_customer_without_mutation():
    group = _group(
        stripe_customer_id="cus_stale",
        metadata={"legacy_marker": "keep"},
    )
    facade = _Facade(_tables(group=group))

    with pytest.raises(HTTPException) as exc:
        asyncio.run(_manager(facade).activate_enrollment(
            "enrollment_1", "studio_1", "actor_1", "stale-group-key"
        ))

    assert exc.value.status_code == 409
    assert group["metadata"] == {"legacy_marker": "keep"}
    assert facade.supabase.billing_provider_operations == {}
    assert _Stripe.add_item_calls == []
    assert _Stripe.update_item_calls == []


@pytest.mark.parametrize("branch", ["add_item", "update_quantity"])
def test_local_scheduled_whole_subscription_rejects_activation_without_mutation(branch):
    facade = _existing_subscription_case(branch)
    group = facade.supabase.tables["billing_subscriptions"][0]
    group["cancel_at_period_end"] = True

    with pytest.raises(HTTPException) as exc:
        asyncio.run(_manager(facade).activate_enrollment(
            "enrollment_1", "studio_1", "actor_1", f"scheduled-group-{branch}"
        ))

    assert exc.value.status_code == 409
    assert "scheduled for cancellation" in exc.value.detail
    assert _operation(facade)["state"] == "definitive_rejected"
    assert _Stripe.create_subscription_calls == []
    assert _Stripe.add_item_calls == []
    assert _Stripe.update_item_calls == []
    assert "stripe_quantity_sync_lock" not in group["metadata"]


@pytest.mark.parametrize("branch", ["add_item", "update_quantity"])
def test_provider_scheduled_whole_subscription_rejects_activation_without_mutation(branch):
    facade = _existing_subscription_case(branch)
    _Stripe.subscriptions["sub_1"]["cancel_at_period_end"] = True

    with pytest.raises(HTTPException) as exc:
        asyncio.run(_manager(facade).activate_enrollment(
            "enrollment_1", "studio_1", "actor_1", f"provider-scheduled-{branch}"
        ))

    assert exc.value.status_code == 409
    assert "scheduled for cancellation" in exc.value.detail
    assert _operation(facade)["state"] == "definitive_rejected"
    assert _Stripe.add_item_calls == []
    assert _Stripe.update_item_calls == []


@pytest.mark.parametrize("guard", ["open_item_intent", "provider_schedule"])
def test_shared_item_schedule_blocks_activation_before_add_or_quantity_update(guard):
    facade = _existing_subscription_case("add_item")
    if guard == "open_item_intent":
        facade.supabase.tables.setdefault(
            "billing_enrollment_transition_intents",
            [],
        ).append({
            "id": "item_schedule",
            "studio_id": "studio_1",
            "billing_subscription_id": "group_1",
            "transition_kind": "schedule_period_end",
            "mutation_strategy": "subscription_item_delete_at_period_end",
            "state": "scheduled",
        })
    else:
        _Stripe.subscriptions["sub_1"]["schedule"] = "sub_sched_item"

    with pytest.raises(HTTPException) as blocked:
        asyncio.run(_manager(facade).activate_enrollment(
            "enrollment_1", "studio_1", "actor_1", f"item-schedule-{guard}"
        ))

    assert blocked.value.status_code == 409
    assert "scheduled for cancellation" in blocked.value.detail
    assert _Stripe.add_item_calls == []
    assert _Stripe.update_item_calls == []


@pytest.mark.parametrize("branch", ["add_item", "update_quantity"])
def test_schedule_inserted_between_activation_checks_prevents_provider_mutation(branch):
    facade = _existing_subscription_case(branch)
    original_transition = facade.supabase._rpc_transition_billing_provider_operation_v1

    def transition_with_schedule_race(params):
        result = original_transition(params)
        if (
            params["p_operation_type"].startswith("enrollment.activate.")
            and params["p_to_state"] == "provider_request_in_flight"
        ):
            facade.supabase.tables["billing_subscriptions"][0][
                "cancel_at_period_end"
            ] = True
            facade.supabase.tables.setdefault(
                "billing_enrollment_transition_intents", []
            ).append({
                "id": "transition_race",
                "studio_id": "studio_1",
                "billing_subscription_id": "group_1",
                "transition_kind": "schedule_period_end",
                "mutation_strategy": "subscription_cancel_at_period_end",
                "state": "scheduled",
            })
            _Stripe.subscriptions["sub_1"]["cancel_at_period_end"] = True
        return result

    facade.supabase._rpc_transition_billing_provider_operation_v1 = (
        transition_with_schedule_race
    )

    with pytest.raises(HTTPException) as exc:
        asyncio.run(_manager(facade).activate_enrollment(
            "enrollment_1", "studio_1", "actor_1", f"schedule-race-{branch}"
        ))

    assert exc.value.status_code == 409
    assert _operation(facade)["state"] == "definitive_rejected"
    assert _Stripe.add_item_calls == []
    assert _Stripe.update_item_calls == []


def test_provider_success_local_failure_reconciles_and_readback_never_mutates_again():
    facade = _Facade(_tables())
    facade.projection_failures = 1
    manager = _manager(facade)

    with pytest.raises(HTTPException) as exc:
        asyncio.run(manager.activate_enrollment(
            "enrollment_1", "studio_1", "actor_1", "projection-key"
        ))
    assert exc.value.status_code == 503
    assert _operation(facade)["state"] == "reconciliation_required"
    assert len(_Stripe.create_subscription_calls) == 1

    result = asyncio.run(manager.activate_enrollment(
        "enrollment_1", "studio_1", "actor_1", "projection-adopter"
    ))
    assert result.status == "active"
    assert len(_Stripe.create_subscription_calls) == 1
    assert len(facade.supabase.tables["audit_logs"]) == 1


def test_balance_failure_stays_projected_and_same_actor_replay_completes():
    facade = _Facade(_tables())
    facade.balance_failures = 1
    manager = _manager(facade)

    with pytest.raises(HTTPException) as failed_balance:
        asyncio.run(manager.activate_enrollment(
            "enrollment_1", "studio_1", "actor_1", "balance-key"
        ))
    parent = _operation(facade)
    assert failed_balance.value.status_code == 503
    assert parent["state"] == "projected"
    assert len(_Stripe.create_subscription_calls) == 1
    assert facade.supabase.tables["audit_logs"] == []

    replay = asyncio.run(manager.activate_enrollment(
        "enrollment_1", "studio_1", "actor_1", "balance-adopter"
    ))
    assert replay.status == "active"
    assert parent["state"] == "completed"
    assert facade.balance_recomputes == 1
    assert len(_Stripe.create_subscription_calls) == 1
    assert len(facade.supabase.tables["audit_logs"]) == 1


def test_provider_ambiguity_is_reconciliation_and_does_not_retry():
    facade = _Facade(_tables())
    _Stripe.provider_error = TimeoutError("raw provider payload")
    manager = _manager(facade)

    with pytest.raises(HTTPException) as exc:
        asyncio.run(manager.activate_enrollment(
            "enrollment_1", "studio_1", "actor_1", "ambiguous-key"
        ))
    assert exc.value.status_code == 503
    assert "raw" not in exc.value.detail
    assert _operation(facade)["state"] == "reconciliation_required"
    assert len(_Stripe.create_subscription_calls) == 1

    _Stripe.provider_error = None
    with pytest.raises(HTTPException) as replay:
        asyncio.run(manager.activate_enrollment(
            "enrollment_1", "studio_1", "actor_1", "ambiguous-adopter"
        ))
    assert replay.value.status_code == 409
    assert len(_Stripe.create_subscription_calls) == 1
    assert "stripe_quantity_sync_lock" not in facade.supabase.tables["billing_subscriptions"][0]["metadata"]


def test_prerequisites_fail_before_resource_or_provider():
    cases = []
    tables = _tables()
    tables["billing_plans"][0]["status"] = "pending"
    cases.append(tables)
    tables = _tables()
    tables["billing_plan_prices"][0]["metadata"] = {"connect_account_generation": 1}
    cases.append(tables)
    tables = _tables()
    tables["billing_payers"][0]["connect_account_generation"] = 1
    cases.append(tables)
    for tables in cases:
        facade = _Facade(tables)
        with pytest.raises(HTTPException) as exc:
            asyncio.run(_manager(facade).activate_enrollment(
                "enrollment_1", "studio_1", "actor_1", "invalid-key"
            ))
        assert exc.value.status_code == 409
        assert facade.supabase.billing_provider_operations == {}
        assert _Stripe.create_subscription_calls == []


def test_legacy_plan_price_adopts_generation_before_activation():
    tables = _tables()
    tables["billing_plan_prices"][0]["metadata"] = {"legacy_marker": "keep"}
    facade = _Facade(tables)

    result = asyncio.run(_manager(facade).activate_enrollment(
        "enrollment_1", "studio_1", "actor_1", "legacy-price-key"
    ))

    assert result.status == "active"
    assert tables["billing_plan_prices"][0]["metadata"] == {
        "legacy_marker": "keep",
        "connect_account_generation": 2,
    }
    adoption = next(
        query
        for query in facade.supabase.query_log
        if query["table"] == "billing_plan_prices"
        and query["update"]
        and query["update"].get("metadata", {}).get("connect_account_generation") == 2
    )
    assert ("is", "metadata->connect_account_generation", "null") in adoption["filters"]


def test_autopay_requires_consent_and_passes_exact_payment_method():
    enrollment = _enrollment(collection_mode="autopay")
    facade = _Facade(_tables(enrollment=enrollment))
    facade.authorized = False
    with pytest.raises(HTTPException):
        asyncio.run(_manager(facade).activate_enrollment(
            "enrollment_1", "studio_1", "actor_1", "autopay-key"
        ))
    assert _Stripe.create_subscription_calls == []

    facade.authorized = True
    result = asyncio.run(_manager(facade).activate_enrollment(
        "enrollment_1", "studio_1", "actor_1", "autopay-key"
    ))
    assert result.status == "active"
    assert _Stripe.create_subscription_calls[0]["default_payment_method"] == "pm_1"
    assert _Stripe.create_subscription_calls[0]["collection_method"] == "charge_automatically"


def test_autopay_create_reservation_rejects_disable_first_without_stale_group():
    enrollment = _enrollment(collection_mode="autopay")
    facade = _Facade(_tables(enrollment=enrollment))
    manager = _manager(facade)

    def disable_before_reservation():
        facade.authorized = False
        facade.supabase.autopay_consent_active = False

    facade.supabase.autopay_reservation_hook = disable_before_reservation

    with pytest.raises(HTTPException) as blocked:
        asyncio.run(manager.activate_enrollment(
            "enrollment_1",
            "studio_1",
            "actor_1",
            "autopay-disable-race",
        ))

    assert blocked.value.status_code == 409
    assert "current payer consent" in blocked.value.detail
    assert facade.supabase.tables["billing_subscriptions"] == []
    assert _Stripe.create_subscription_calls == []
    assert facade.supabase.billing_provider_operations == {}


class _PolicyBlockedStripe(_Stripe):
    def _authorize_stripe_mutation(self, _operation, **_scope):
        raise StripeMutationBlocked(status_code=503, detail="provider blocked")

    def create_connected_subscription(self, **_payload):
        raise StripeMutationBlocked(status_code=503, detail="provider blocked")

    def create_connected_subscription_item(self, **_payload):
        raise StripeMutationBlocked(status_code=503, detail="provider blocked")

    def update_connected_subscription_item(self, **_payload):
        raise StripeMutationBlocked(status_code=503, detail="provider blocked")


class _BoundaryRecheckBlockedStripe(_Stripe):
    authorization_calls = 0
    raw_create_calls = 0

    def _authorize_stripe_mutation(self, _operation, **_scope):
        self.__class__.authorization_calls += 1
        if self.__class__.authorization_calls == 2:
            raise StripeMutationBlocked(status_code=503, detail="provider blocked")

    def create_connected_subscription(self, **payload):
        self._authorize_stripe_mutation(
            "connected_subscription.create",
            studio_id=payload["studio_id"],
            account_id=payload["account_id"],
        )
        self.__class__.raw_create_calls += 1
        return super().create_connected_subscription(**payload)


def test_policy_blocked_autopay_create_deletes_exact_empty_reservation():
    facade = _Facade(_tables(enrollment=_enrollment(collection_mode="autopay")))
    manager = BillingEnrollmentManager(
        facade,
        stripe_service_cls=_PolicyBlockedStripe,
    )

    with pytest.raises(HTTPException) as blocked:
        asyncio.run(manager.activate_enrollment(
            "enrollment_1", "studio_1", "actor_1", "policy-blocked-create"
        ))

    assert blocked.value.status_code == 409
    operation = _operation(facade)
    enrollment = facade.supabase.tables["student_billing_enrollments"][0]
    assert operation["state"] == "definitive_rejected"
    assert operation["provider_request_attempt_count"] == 0
    assert operation["provider_object_id"] is None
    assert facade.supabase.tables["billing_subscriptions"] == []
    assert "provider_activation_intent" not in enrollment["metadata"]
    assert _Stripe.subscriptions == {}


def test_lost_policy_cleanup_response_same_key_never_recreates_group():
    facade = _Facade(_tables(enrollment=_enrollment(collection_mode="autopay")))
    facade.supabase.lose_autopay_rejection_response_once = True
    blocked_manager = BillingEnrollmentManager(
        facade,
        stripe_service_cls=_PolicyBlockedStripe,
    )

    with pytest.raises(HTTPException) as lost:
        asyncio.run(blocked_manager.activate_enrollment(
            "enrollment_1", "studio_1", "actor_1", "lost-policy-cleanup"
        ))
    assert lost.value.status_code == 503
    assert facade.supabase.tables["billing_subscriptions"] == []
    assert _operation(facade)["state"] == "definitive_rejected"

    with pytest.raises(HTTPException) as replay:
        asyncio.run(blocked_manager.activate_enrollment(
            "enrollment_1", "studio_1", "actor_1", "lost-policy-cleanup"
        ))
    assert replay.value.status_code == 409
    assert "new Idempotency-Key" in replay.value.detail
    assert facade.supabase.tables["billing_subscriptions"] == []
    assert _Stripe.subscriptions == {}

    result = asyncio.run(_manager(facade).activate_enrollment(
        "enrollment_1", "studio_1", "actor_1", "fresh-after-policy-cleanup"
    ))
    assert result.status == "active"
    assert len(facade.supabase.tables["billing_subscriptions"]) == 1
    assert facade.supabase.tables["billing_subscriptions"][0][
        "stripe_subscription_id"
    ] == "sub_created"


def test_precommit_cleanup_failure_same_key_reestablishes_policy_proof():
    facade = _Facade(_tables(enrollment=_enrollment(collection_mode="autopay")))
    facade.supabase.fail_autopay_rejection_before_commit_once = True
    blocked_manager = BillingEnrollmentManager(
        facade,
        stripe_service_cls=_PolicyBlockedStripe,
    )

    with pytest.raises(HTTPException) as failed_cleanup:
        asyncio.run(blocked_manager.activate_enrollment(
            "enrollment_1", "studio_1", "actor_1", "precommit-policy-cleanup"
        ))
    operation = _operation(facade)
    assert failed_cleanup.value.status_code == 503
    assert operation["state"] == "started"
    assert operation["provider_request_attempt_count"] == 0
    assert len(facade.supabase.tables["billing_subscriptions"]) == 1
    assert _Stripe.subscriptions == {}

    with pytest.raises(HTTPException) as converged:
        asyncio.run(blocked_manager.activate_enrollment(
            "enrollment_1", "studio_1", "actor_1", "precommit-policy-cleanup"
        ))
    assert converged.value.status_code == 409
    assert "new Idempotency-Key" in converged.value.detail
    assert operation["state"] == "definitive_rejected"
    assert operation["provider_request_attempt_count"] == 0
    assert facade.supabase.tables["billing_subscriptions"] == []
    assert _Stripe.subscriptions == {}

    result = asyncio.run(_manager(facade).activate_enrollment(
        "enrollment_1", "studio_1", "actor_1", "fresh-precommit-policy-cleanup"
    ))
    assert result.status == "active"


@pytest.mark.parametrize("cleanup_failure", ["before_commit", "after_commit"])
def test_boundary_policy_block_retries_exact_cleanup_once_before_returning(
    cleanup_failure,
):
    _BoundaryRecheckBlockedStripe.authorization_calls = 0
    _BoundaryRecheckBlockedStripe.raw_create_calls = 0
    facade = _Facade(_tables(enrollment=_enrollment(collection_mode="autopay")))
    if cleanup_failure == "before_commit":
        facade.supabase.fail_autopay_rejection_before_commit_once = True
    else:
        facade.supabase.lose_autopay_rejection_response_once = True
    manager = BillingEnrollmentManager(
        facade,
        stripe_service_cls=_BoundaryRecheckBlockedStripe,
    )

    with pytest.raises(StripeMutationBlocked):
        asyncio.run(manager.activate_enrollment(
            "enrollment_1",
            "studio_1",
            "actor_1",
            f"boundary-policy-cleanup-{cleanup_failure}",
        ))

    operation = _operation(facade)
    assert _BoundaryRecheckBlockedStripe.authorization_calls == 2
    assert _BoundaryRecheckBlockedStripe.raw_create_calls == 0
    assert facade.supabase.autopay_rejection_calls == 2
    assert operation["state"] == "definitive_rejected"
    assert operation["provider_request_attempt_count"] == 1
    assert operation["provider_object_id"] is None
    assert facade.supabase.tables["billing_subscriptions"] == []
    enrollment = facade.supabase.tables["student_billing_enrollments"][0]
    assert "provider_activation_intent" not in enrollment["metadata"]
    assert "provider_activation_rejection" in enrollment["metadata"]

    with pytest.raises(HTTPException) as replay:
        asyncio.run(manager.activate_enrollment(
            "enrollment_1",
            "studio_1",
            "actor_1",
            f"boundary-policy-cleanup-{cleanup_failure}",
        ))
    assert replay.value.status_code == 409
    assert facade.supabase.tables["billing_subscriptions"] == []
    assert _BoundaryRecheckBlockedStripe.raw_create_calls == 0

    result = asyncio.run(_manager(facade).activate_enrollment(
        "enrollment_1",
        "studio_1",
        "actor_1",
        f"fresh-boundary-policy-cleanup-{cleanup_failure}",
    ))
    assert result.status == "active"


@pytest.mark.parametrize("protected_kind", ["reused", "provider", "linked"])
def test_policy_blocked_autopay_never_deletes_protected_group(protected_kind):
    group = _group(
        collection_mode="autopay",
        status="pending",
        stripe_subscription_id=None,
    )
    peers = []
    if protected_kind == "provider":
        group["stripe_subscription_id"] = "sub_existing"
        group["status"] = "active"
        provider = _provider_subscription()
        provider["id"] = "sub_existing"
        _Stripe.subscriptions["sub_existing"] = provider
    elif protected_kind == "linked":
        group["metadata"]["activation_reservation"] = {
            "version": 1,
            "enrollment_id": "enrollment_1",
        }
        peers = [{
            **_enrollment(
                id="enrollment_peer",
                student_id="student_peer",
                status="active",
            ),
            "billing_subscription_id": "group_1",
        }]
    facade = _Facade(_tables(
        enrollment=_enrollment(collection_mode="autopay"),
        group=group,
        peers=peers,
    ))
    manager = BillingEnrollmentManager(
        facade,
        stripe_service_cls=_PolicyBlockedStripe,
    )

    with pytest.raises((StripeMutationBlocked, HTTPException)):
        asyncio.run(manager.activate_enrollment(
            "enrollment_1",
            "studio_1",
            "actor_1",
            f"policy-blocked-{protected_kind}",
        ))

    assert facade.supabase.tables["billing_subscriptions"] == [group]
    assert _operation(facade)["state"] == "definitive_rejected"
    assert group.get("stripe_subscription_id") == (
        "sub_existing" if protected_kind == "provider" else None
    )


def test_lost_provider_success_response_replays_without_second_mutation():
    facade = _Facade(_tables())
    facade.supabase.lose_provider_success_response_once = True
    manager = _manager(facade)

    with pytest.raises(HTTPException) as lost:
        asyncio.run(manager.activate_enrollment(
            "enrollment_1", "studio_1", "actor_1", "lost-key"
        ))
    assert lost.value.status_code == 503
    assert _operation(facade)["state"] == "provider_succeeded"

    result = asyncio.run(manager.activate_enrollment(
        "enrollment_1", "studio_1", "actor_1", "lost-adopter"
    ))
    assert result.status == "active"
    assert len(_Stripe.create_subscription_calls) == 1
    assert len(facade.supabase.tables["audit_logs"]) == 1


def test_completed_and_projected_local_drift_never_retries_provider():
    for state in ("completed", "projected"):
        _Stripe.reset()
        facade = _Facade(_tables())
        manager = _manager(facade)
        asyncio.run(manager.activate_enrollment(
            "enrollment_1", "studio_1", "actor_1", f"drift-{state}"
        ))
        parent = _operation(facade)
        parent["state"] = state
        enrollment = facade.supabase.tables["student_billing_enrollments"][0]
        enrollment["stripe_subscription_item_id"] = "si_corrupt"

        with pytest.raises(HTTPException) as drift:
            asyncio.run(manager.activate_enrollment(
                "enrollment_1", "studio_1", "actor_1", f"drift-{state}"
            ))
        assert drift.value.status_code == 503
        assert len(_Stripe.create_subscription_calls) == 1
        if state == "projected":
            assert parent["state"] == "reconciliation_required"


def test_tampered_intent_and_unowned_provider_link_fail_closed():
    linked = _enrollment(
        status="active",
        stripe_subscription_id="sub_unowned",
        stripe_subscription_item_id="si_unowned",
    )
    facade = _Facade(_tables(enrollment=linked))
    with pytest.raises(HTTPException) as unowned:
        asyncio.run(_manager(facade).activate_enrollment(
            "enrollment_1", "studio_1", "actor_1", "unowned-key"
        ))
    assert unowned.value.status_code == 409
    assert facade.supabase.billing_provider_operations == {}

    facade = _Facade(_tables())
    manager = _manager(facade)
    facade.projection_failures = 1
    with pytest.raises(HTTPException):
        asyncio.run(manager.activate_enrollment(
            "enrollment_1", "studio_1", "actor_1", "tamper-key"
        ))
    enrollment = facade.supabase.tables["student_billing_enrollments"][0]
    enrollment["metadata"]["provider_activation_intent"]["expected_quantity"] = 99
    with pytest.raises(HTTPException) as tampered:
        asyncio.run(manager.activate_enrollment(
            "enrollment_1", "studio_1", "actor_1", "tamper-adopter"
        ))
    assert tampered.value.status_code == 409
    assert len(_Stripe.create_subscription_calls) == 1


def test_contradictory_active_price_and_provider_readback_mismatch_fail_closed():
    tables = _tables()
    tables["billing_plan_prices"].append(_price(
        id="local_price_other",
        stripe_price_id="price_other",
    ))
    facade = _Facade(tables)
    with pytest.raises(HTTPException) as contradictory:
        asyncio.run(_manager(facade).activate_enrollment(
            "enrollment_1", "studio_1", "actor_1", "price-key"
        ))
    assert contradictory.value.status_code == 409
    assert facade.supabase.billing_provider_operations == {}

    facade = _Facade(_tables())
    manager = _manager(facade)
    original_retrieve = _Stripe.retrieve_connected_subscription

    def mismatched_retrieve(self, **payload):
        provider = original_retrieve(self, **payload)
        provider["customer"] = "cus_other"
        return provider

    _Stripe.retrieve_connected_subscription = mismatched_retrieve
    try:
        with pytest.raises(HTTPException) as mismatch:
            asyncio.run(manager.activate_enrollment(
                "enrollment_1", "studio_1", "actor_1", "readback-key"
            ))
        assert mismatch.value.status_code == 503
        assert _operation(facade)["state"] == "reconciliation_required"
        assert len(_Stripe.create_subscription_calls) == 1
    finally:
        _Stripe.retrieve_connected_subscription = original_retrieve


def test_incomplete_and_past_due_readback_keep_enrollment_past_due():
    for provider_status in ("incomplete", "past_due"):
        _Stripe.reset()
        facade = _Facade(_tables(group=_group()))
        _Stripe.subscriptions["sub_1"] = _provider_subscription(
            status=provider_status
        )

        result = asyncio.run(_manager(facade).activate_enrollment(
            "enrollment_1", "studio_1", "actor_1", f"status-{provider_status}"
        ))

        assert result.billing_status == "past_due"
        assert len(_Stripe.add_item_calls) == 1
