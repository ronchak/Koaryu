from __future__ import annotations

import asyncio
import copy

import pytest
from fastapi import HTTPException

from app.services.billing_enrollments import BillingEnrollmentManager
from app.services.platform_billing_helpers import build_idempotency_key
from tests.billing_lifecycle_helpers import _FakeSupabase


class _ActivationSupabase(_FakeSupabase):
    def __init__(self, tables):
        super().__init__(tables)
        self.lose_provider_success_response_once = False

    def _rpc_transition_billing_provider_operation_v1(self, params):
        result = super()._rpc_transition_billing_provider_operation_v1(params)
        if (
            self.lose_provider_success_response_once
            and params["p_operation_type"].startswith("enrollment.activate.")
            and params["p_to_state"] == "provider_succeeded"
        ):
            self.lose_provider_success_response_once = False
            raise RuntimeError("lost provider success response")
        return result


class _Accounts:
    def __init__(self, account):
        self.account = account

    def ensure_row(self, studio_id):
        return {"studio_id": studio_id, **self.account}


class _Facade:
    def __init__(self, tables):
        self.supabase = _ActivationSupabase(tables)
        self.account = {
            "stripe_connected_account_id": "acct_1",
            "charges_enabled": True,
            "status": "charges_enabled",
            "platform_fee_bps": 50,
            "metadata": {"connect_account_generation": 2},
        }
        self.authorized = True
        self.projection_failures = 0
        self.balance_recomputes = 0
        self.balance_failures = 0
        self.supabase.insert_defaults["billing_subscriptions"] = {
            "id": "group_created",
            "metadata": {},
            "created_at": "2026-08-27T00:00:00Z",
            "updated_at": "2026-08-27T00:00:00Z",
        }

    def _connect_accounts(self):
        return _Accounts(self.account)

    def _get_row_or_404(self, table, record_id, studio_id, detail):
        row = next((
            candidate
            for candidate in self.supabase.tables.setdefault(table, [])
            if candidate.get("id") == record_id
            and candidate.get("studio_id") == studio_id
        ), None)
        if row is None:
            raise HTTPException(status_code=404, detail=detail)
        return row

    def _ensure_record_in_studio(self, table, record_id, studio_id, detail):
        self._get_row_or_404(table, record_id, studio_id, detail)

    def _ensure_connect_ready(self, studio_id):
        return {"studio_id": studio_id, **self.account}

    @staticmethod
    def _idempotency_key(*parts):
        return build_idempotency_key(*parts)

    @staticmethod
    def _application_fee_percent(account):
        return float(account.get("platform_fee_bps") or 0) / 100

    def _payer_autopay_authorized(self, _payer):
        return self.authorized

    def _project_subscription(self, provider, account_id):
        if self.projection_failures:
            self.projection_failures -= 1
            raise RuntimeError("local subscription projection failed")
        group_id = provider["metadata"]["billing_subscription_id"]
        group = self._get_row_or_404(
            "billing_subscriptions", group_id, "studio_1", "Group not found."
        )
        group.update({
            "stripe_subscription_id": provider["id"],
            "stripe_account_id": account_id,
            "stripe_customer_id": provider["customer"],
            "status": provider.get("status") or "active",
        })
        return dict(group)

    def _recompute_payer_balance(self, _studio_id, _payer_id):
        if self.balance_failures:
            self.balance_failures -= 1
            raise RuntimeError("payer balance projection failed")
        self.balance_recomputes += 1

    def _audit(self, studio_id, actor_id, action, entity_id, metadata):
        self.supabase.tables.setdefault("audit_logs", []).append({
            "studio_id": studio_id,
            "actor_id": actor_id,
            "action": action,
            "entity_id": entity_id,
            "metadata": metadata,
        })


class _Stripe:
    subscriptions = {}
    create_subscription_calls = []
    add_item_calls = []
    update_item_calls = []
    retrieve_calls = []
    provider_error = None

    @classmethod
    def reset(cls):
        cls.subscriptions = {}
        cls.create_subscription_calls = []
        cls.add_item_calls = []
        cls.update_item_calls = []
        cls.retrieve_calls = []
        cls.provider_error = None

    def create_connected_subscription(self, **payload):
        self.__class__.create_subscription_calls.append(copy.deepcopy(payload))
        if self.__class__.provider_error:
            raise self.__class__.provider_error
        item = {
            "id": "si_created",
            "price": {"id": payload["price_id"]},
            "quantity": 1,
            "metadata": copy.deepcopy(payload["item_metadata"]),
        }
        subscription = {
            "id": "sub_created",
            "status": "active",
            "customer": payload["customer_id"],
            "metadata": copy.deepcopy(payload["metadata"]),
            "items": {"data": [item]},
        }
        self.__class__.subscriptions[subscription["id"]] = subscription
        return copy.deepcopy(subscription)

    def create_connected_subscription_item(self, **payload):
        self.__class__.add_item_calls.append(copy.deepcopy(payload))
        if self.__class__.provider_error:
            raise self.__class__.provider_error
        item = {
            "id": "si_added",
            "price": {"id": payload["price_id"]},
            "quantity": 1,
            "metadata": copy.deepcopy(payload["metadata"]),
        }
        self.__class__.subscriptions[payload["subscription_id"]]["items"]["data"].append(item)
        return copy.deepcopy(item)

    def update_connected_subscription_item(self, **payload):
        self.__class__.update_item_calls.append(copy.deepcopy(payload))
        if self.__class__.provider_error:
            raise self.__class__.provider_error
        for subscription in self.__class__.subscriptions.values():
            for item in subscription["items"]["data"]:
                if item["id"] == payload["subscription_item_id"]:
                    item["quantity"] = payload["quantity"]
                    return copy.deepcopy(item)
        raise AssertionError("subscription item missing")

    def retrieve_connected_subscription(self, **payload):
        self.__class__.retrieve_calls.append(copy.deepcopy(payload))
        return copy.deepcopy(self.__class__.subscriptions[payload["subscription_id"]])


def _enrollment(**overrides):
    return {
        "id": "enrollment_1",
        "studio_id": "studio_1",
        "student_id": "student_1",
        "payer_id": "payer_1",
        "billing_plan_id": "plan_1",
        "collection_mode": "invoice_link",
        "status": "pending",
        "billing_status": "upcoming",
        "start_date": "2026-08-27",
        "end_date": None,
        "next_bill_on": None,
        "metadata": {},
        "created_at": "2026-08-27T00:00:00Z",
        "updated_at": "2026-08-27T00:00:00Z",
        **overrides,
    }


def _plan(**overrides):
    return {
        "id": "plan_1",
        "studio_id": "studio_1",
        "name": "Core plan",
        "status": "active",
        "amount_cents": 5000,
        "currency": "usd",
        "billing_interval": "monthly",
        "trial_days": 0,
        "stripe_account_id": "acct_1",
        "stripe_product_id": "prod_1",
        "stripe_price_id": "price_1",
        **overrides,
    }


def _payer(**overrides):
    return {
        "id": "payer_1",
        "studio_id": "studio_1",
        "stripe_account_id": "acct_1",
        "stripe_customer_id": "cus_1",
        "connect_account_generation": 2,
        "default_payment_method_id": "pm_1",
        **overrides,
    }


def _price(**overrides):
    return {
        "id": "local_price_1",
        "studio_id": "studio_1",
        "billing_plan_id": "plan_1",
        "stripe_account_id": "acct_1",
        "stripe_product_id": "prod_1",
        "stripe_price_id": "price_1",
        "amount_cents": 5000,
        "currency": "usd",
        "billing_interval": "monthly",
        "recurring": True,
        "active": True,
        "metadata": {"connect_account_generation": 2},
        **overrides,
    }


def _tables(*, enrollment=None, group=None, peers=None):
    enrollments = [enrollment or _enrollment(), *(peers or [])]
    return {
        "student_billing_enrollments": enrollments,
        "billing_plans": [_plan()],
        "billing_plan_prices": [_price()],
        "billing_payers": [_payer()],
        "billing_subscriptions": [group] if group else [],
        "audit_logs": [],
    }


def _group(**overrides):
    return {
        "id": "group_1",
        "studio_id": "studio_1",
        "payer_id": "payer_1",
        "stripe_account_id": "acct_1",
        "stripe_customer_id": "cus_1",
        "stripe_subscription_id": "sub_1",
        "collection_mode": "invoice_link",
        "billing_interval": "monthly",
        "currency": "usd",
        "status": "active",
        "metadata": {"connect_account_generation": 2},
        **overrides,
    }


def _provider_subscription(*, items=None, status="active"):
    return {
        "id": "sub_1",
        "status": status,
        "customer": "cus_1",
        "metadata": {
            "studio_id": "studio_1",
            "payer_id": "payer_1",
            "billing_subscription_id": "group_1",
        },
        "items": {"data": list(items or [])},
    }


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


def test_create_subscription_replays_and_different_key_adopts_without_duplicates():
    facade = _Facade(_tables())
    manager = _manager(facade)

    first = asyncio.run(manager.activate_enrollment(
        "enrollment_1", "studio_1", "actor_1", "activation-owner"
    ))
    with pytest.raises(HTTPException) as denied:
        asyncio.run(manager.activate_enrollment(
            "enrollment_1", "studio_1", "actor_2", "activation-cross-actor"
        ))
    replay = asyncio.run(manager.activate_enrollment(
        "enrollment_1", "studio_1", "actor_1", "activation-adopter"
    ))

    assert denied.value.status_code == 409
    assert first.status == replay.status == "active"
    assert first.stripe_subscription_id == replay.stripe_subscription_id == "sub_created"
    assert first.stripe_subscription_item_id == "si_created"
    assert len(_Stripe.create_subscription_calls) == 1
    assert _Stripe.add_item_calls == []
    assert _Stripe.update_item_calls == []
    assert len(facade.supabase.tables["audit_logs"]) == 1
    parent = _operation(facade)
    assert parent["state"] == "completed"
    assert parent["actor_id"] == "actor_1"
    assert parent["caller_request_key"] == "activation-owner"
    assert facade.supabase.billing_provider_operation_aliases[
        ("studio_1", "enrollment.activate.invoice", "activation-adopter")
    ] == parent["id"]
    intent = facade.supabase.tables["student_billing_enrollments"][0]["metadata"][
        "provider_activation_intent"
    ]
    assert intent["branch"] == "create_subscription"
    assert intent["expected_subscription_id"] is None
    assert intent["expected_item_id"] is None
    assert intent["expected_quantity"] == 1
    assert _Stripe.create_subscription_calls[0]["idempotency_key"] == (
        f"koaryu:enrollment-activate:{parent['id']}:create-subscription"
    )
    resource_claim = next(
        params
        for name, params in facade.supabase.rpc_calls
        if name == "claim_billing_provider_operation_resource_v1"
    )
    assert resource_claim["p_resource_type"] == "enrollment"
    assert resource_claim["p_resource_id"] == "enrollment_1"
    assert resource_claim["p_payer_id"] == "payer_1"
    assert "Core plan" not in repr(parent)


def test_add_item_uses_one_mutation_and_exact_provider_identity():
    facade = _Facade(_tables(group=_group()))
    _Stripe.subscriptions["sub_1"] = _provider_subscription()

    result = asyncio.run(_manager(facade).activate_enrollment(
        "enrollment_1", "studio_1", "actor_1", "add-item-key"
    ))

    assert result.stripe_subscription_id == "sub_1"
    assert result.stripe_subscription_item_id == "si_added"
    assert _Stripe.create_subscription_calls == []
    assert len(_Stripe.add_item_calls) == 1
    assert _Stripe.update_item_calls == []
    intent = facade.supabase.tables["student_billing_enrollments"][0]["metadata"][
        "provider_activation_intent"
    ]
    assert intent["branch"] == "add_item"
    assert intent["expected_subscription_id"] == "sub_1"
    assert intent["expected_item_id"] is None


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


def test_update_quantity_counts_exact_family_and_releases_lock():
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
    detaching = _enrollment(
        id="enrollment_detaching",
        billing_subscription_id="group_1",
        stripe_subscription_id="sub_1",
        stripe_subscription_item_id="si_shared",
        metadata={"stripe_detach_pending": {"reason": "cancel"}},
    )
    facade = _Facade(_tables(group=_group(), peers=[peer, detaching]))
    _Stripe.subscriptions["sub_1"] = _provider_subscription(items=[item])

    result = asyncio.run(_manager(facade).activate_enrollment(
        "enrollment_1", "studio_1", "actor_1", "quantity-key"
    ))

    assert result.stripe_subscription_item_id == "si_shared"
    assert len(_Stripe.update_item_calls) == 1
    assert _Stripe.update_item_calls[0]["quantity"] == 2
    intent = facade.supabase.tables["student_billing_enrollments"][0]["metadata"][
        "provider_activation_intent"
    ]
    assert intent["branch"] == "update_quantity"
    assert intent["expected_subscription_id"] == "sub_1"
    assert intent["expected_item_id"] == "si_shared"
    assert intent["expected_quantity"] == 2
    rpc_names = [name for name, _params in facade.supabase.rpc_calls]
    assert rpc_names.index("claim_billing_subscription_quantity_sync") < rpc_names.index(
        "claim_billing_provider_operation_resource_v1"
    )
    assert rpc_names[-1] == "finish_billing_subscription_quantity_sync"
    assert "stripe_quantity_sync_lock" not in facade.supabase.tables["billing_subscriptions"][0]["metadata"]


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
