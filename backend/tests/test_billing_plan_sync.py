from __future__ import annotations

import asyncio
import hashlib

from fastapi import HTTPException

from app.schemas.billing import BillingPlanCreate, BillingPlanUpdate
from app.services.billing_plan_sync import BillingPlanSyncWorkflow
from app.services.billing_plans import BillingPlanManager
from app.services.billing_provider_operations import billing_provider_step_plan_sha256
from app.services.platform_billing_helpers import build_idempotency_key
from tests.fakes.billing_provider_operations import BillingProviderOperationRpcMixin
from tests.fakes.supabase import RpcBackedSupabase


class _PlanSupabase(BillingProviderOperationRpcMixin, RpcBackedSupabase):
    def __init__(self, tables):
        super().__init__(tables)
        self.initialize_billing_provider_operations()
        self.lose_product_success_response_once = False

    def _rpc_transition_billing_provider_operation_step_v1(self, params):
        result = super()._rpc_transition_billing_provider_operation_step_v1(params)
        if (
            self.lose_product_success_response_once
            and params["p_step_order"] == 1
            and params["p_to_state"] == "provider_succeeded"
        ):
            self.lose_product_success_response_once = False
            raise RuntimeError("lost product success response")
        return result


class _Accounts:
    def __init__(self, account):
        self.account = account

    def ensure_row(self, studio_id):
        return {"studio_id": studio_id, **self.account}


class _Facade:
    def __init__(self, tables, account=None):
        self.supabase = _PlanSupabase(tables)
        self.supabase.insert_defaults["billing_plans"] = {
            "id": "plan_created",
            "stripe_product_id": None,
            "stripe_price_id": None,
            "metadata": {},
            "created_at": "2026-08-27T00:00:00Z",
            "updated_at": "2026-08-27T00:00:00Z",
        }
        self.supabase.insert_defaults["billing_plan_prices"] = {
            "id": "plan_price_created",
            "created_at": "2026-08-27T00:00:00Z",
        }
        self.account = account or {
            "stripe_connected_account_id": "acct_1",
            "charges_enabled": True,
            "status": "charges_enabled",
            "metadata": {"connect_account_generation": 1},
        }

    def _connect_accounts(self):
        return _Accounts(self.account)

    def _get_row_or_404(self, table, record_id, studio_id, detail):
        row = next(
            (
                candidate
                for candidate in self.supabase.tables.setdefault(table, [])
                if candidate.get("id") == record_id
                and candidate.get("studio_id") == studio_id
            ),
            None,
        )
        if row is None:
            raise HTTPException(status_code=404, detail=detail)
        return row

    def _idempotency_key(self, *parts):
        return build_idempotency_key(*parts)

    def _audit(self, studio_id, actor_id, action, entity_id, metadata):
        self.supabase.tables.setdefault("audit_logs", []).append({
            "studio_id": studio_id,
            "actor_id": actor_id,
            "action": action,
            "entity_id": entity_id,
            "metadata": metadata,
        })


class _Stripe:
    created_products = []
    updated_products = []
    created_prices = []

    @classmethod
    def reset(cls):
        cls.created_products = []
        cls.updated_products = []
        cls.created_prices = []

    def create_connected_product(self, **payload):
        self.__class__.created_products.append(payload)
        return {"id": "prod_created"}

    def update_connected_product(self, **payload):
        self.__class__.updated_products.append(payload)
        return {"id": payload["product_id"]}

    def create_connected_price(self, **payload):
        self.__class__.created_prices.append(payload)
        return {"id": f"price_{len(self.__class__.created_prices)}"}


def _plan(**overrides):
    return {
        "id": "plan_1",
        "studio_id": "studio_1",
        "name": "Core plan",
        "description": "Membership",
        "amount_cents": 12000,
        "currency": "usd",
        "billing_interval": "monthly",
        "status": "pending",
        "signup_fee_cents": 0,
        "trial_days": 0,
        "proration_behavior": "next_cycle",
        "stripe_account_id": None,
        "stripe_product_id": None,
        "stripe_price_id": None,
        "stripe_price_version": 1,
        "metadata": {"support_note": "keep"},
        "archived_at": None,
        "created_at": "2026-08-27T00:00:00Z",
        "updated_at": "2026-08-27T00:00:00Z",
        **overrides,
    }


def _tables(plan=None):
    return {
        "billing_plans": [plan or _plan()],
        "billing_plan_prices": [],
        "billing_plan_programs": [],
        "programs": [],
        "audit_logs": [],
    }


def _price_row(**overrides):
    return {
        "id": "price_row",
        "studio_id": "studio_1",
        "billing_plan_id": "plan_1",
        "stripe_account_id": "acct_1",
        "stripe_product_id": "prod_existing",
        "stripe_price_id": "price_existing",
        "amount_cents": 12000,
        "currency": "usd",
        "billing_interval": "monthly",
        "recurring": True,
        "active": True,
        "version": 1,
        "metadata": {"connect_account_generation": 1},
        "created_at": "2026-08-27T00:00:00Z",
        **overrides,
    }


class TestBillingPlanSync:
    def setup_method(self):
        _Stripe.reset()

    def test_plan_create_and_provider_update_are_local_only_and_pending(self):
        facade = _Facade(_tables())
        manager = BillingPlanManager(facade, stripe_service_cls=_Stripe)

        created = asyncio.run(manager.create_plan(
            BillingPlanCreate(name="New plan", amount_cents=5000),
            "studio_1",
            "actor_1",
        ))
        updated = asyncio.run(manager.update_plan(
            "plan_1",
            BillingPlanUpdate(amount_cents=13000, description="Changed"),
            "studio_1",
            "actor_1",
        ))

        assert created.status == "pending"
        assert updated.status == "pending"
        assert _Stripe.created_products == []
        assert _Stripe.updated_products == []
        assert _Stripe.created_prices == []

    def test_plan_sync_requires_canonical_byte_bounded_key(self):
        for key in (None, "é" * 128):
            facade = _Facade(_tables())
            try:
                asyncio.run(BillingPlanManager(
                    facade,
                    stripe_service_cls=_Stripe,
                ).sync_plan("plan_1", "studio_1", "actor_1", key))
            except HTTPException as exc:
                assert exc.status_code == 400
            else:
                raise AssertionError("invalid key must fail")
            assert facade.supabase.billing_provider_operations == {}

    def test_two_step_create_replays_without_duplicate_product_price_or_audit(self):
        facade = _Facade(_tables())
        manager = BillingPlanManager(facade, stripe_service_cls=_Stripe)

        first = asyncio.run(manager.sync_plan(
            "plan_1", "studio_1", "actor_1", "plan-key-1",
        ))
        replay = asyncio.run(manager.sync_plan(
            "plan_1", "studio_1", "actor_1", "plan-key-1",
        ))

        assert first.status == "active"
        assert replay.stripe_product_id == first.stripe_product_id
        assert replay.stripe_price_id == first.stripe_price_id
        assert len(_Stripe.created_products) == 1
        assert len(_Stripe.created_prices) == 1
        assert _Stripe.updated_products == []
        assert len(facade.supabase.tables["billing_plan_prices"]) == 1
        assert len(facade.supabase.tables["audit_logs"]) == 1
        parent = next(iter(facade.supabase.billing_provider_operations.values()))
        assert parent["state"] == "completed"
        assert parent["provider_request_attempt_count"] == 1
        assert parent["provider_object_id"] == "price_1"
        steps = facade.supabase.billing_provider_step_plans[parent["id"]]["steps"]
        assert [step["state"] for step in steps] == [
            "provider_succeeded",
            "provider_succeeded",
        ]
        assert "Core plan" not in repr(parent)
        assert "Core plan" not in repr(steps)
        register_call = next(
            params
            for name, params in facade.supabase.rpc_calls
            if name == "register_billing_provider_operation_step_plan_v1"
        )
        assert set(register_call) == {
            "p_operation_id",
            "p_studio_id",
            "p_actor_id",
            "p_operation_type",
            "p_caller_request_key",
            "p_request_sha256",
            "p_stripe_connected_account_id",
            "p_connect_account_generation",
            "p_lease_owner",
            "p_expected_parent_revision",
            "p_plan_sha256",
            "p_expected_step_count",
            "p_steps",
        }
        complete_phase = next(
            params
            for name, params in facade.supabase.rpc_calls
            if name == "complete_billing_provider_operation_provider_phase_v31"
        )
        assert complete_phase["p_expected_parent_revision"] == 2
        assert complete_phase["p_lease_owner"] == register_call["p_lease_owner"]

    def test_lost_product_success_response_resumes_at_price_step(self):
        facade = _Facade(_tables())
        facade.supabase.lose_product_success_response_once = True
        manager = BillingPlanManager(facade, stripe_service_cls=_Stripe)

        try:
            asyncio.run(manager.sync_plan(
                "plan_1", "studio_1", "actor_1", "plan-key",
            ))
        except HTTPException as exc:
            assert exc.status_code == 503
        else:
            raise AssertionError("lost response must not report success")
        result = asyncio.run(manager.sync_plan(
            "plan_1", "studio_1", "actor_1", "plan-key",
        ))

        assert result.status == "active"
        assert len(_Stripe.created_products) == 1
        assert len(_Stripe.created_prices) == 1
        assert len(facade.supabase.tables["audit_logs"]) == 1

    def test_real_v28_parent_evidence_resumes_projection_and_audits_once(self):
        facade = _Facade(_tables())
        crash = {"pending": True}

        def crash_after_provider_phase(query, _rows):
            if (
                crash["pending"]
                and query.name == "billing_plans"
                and (query.update_payload or {}).get("stripe_price_id")
            ):
                crash["pending"] = False
                raise KeyboardInterrupt("process stopped after provider phase")
            return None

        facade.supabase.on_update_query = crash_after_provider_phase
        manager = BillingPlanManager(facade, stripe_service_cls=_Stripe)

        try:
            asyncio.run(manager.sync_plan(
                "plan_1", "studio_1", "actor_1", "plan-key",
            ))
        except KeyboardInterrupt:
            pass
        else:
            raise AssertionError("fixture did not stop after provider phase")

        parent = next(iter(facade.supabase.billing_provider_operations.values()))
        assert parent["state"] == "provider_succeeded"
        assert parent["provider_request_attempt_count"] == 1
        assert parent["provider_object_id"] == "price_1"
        assert parent["result_code"] == "provider_step_phase_completed"
        assert parent["revision"] == 3
        assert facade.supabase.tables["audit_logs"] == []

        result = asyncio.run(manager.sync_plan(
            "plan_1", "studio_1", "actor_1", "plan-key",
        ))

        assert result.status == "active"
        assert len(_Stripe.created_products) == 1
        assert len(_Stripe.created_prices) == 1
        assert len(facade.supabase.tables["billing_plan_prices"]) == 1
        assert len(facade.supabase.tables["audit_logs"]) == 1

    def test_completed_two_step_price_drift_is_sanitized_without_provider_retry(self):
        facade = _Facade(_tables())
        manager = BillingPlanManager(facade, stripe_service_cls=_Stripe)
        asyncio.run(manager.sync_plan(
            "plan_1", "studio_1", "actor_1", "plan-key",
        ))
        provider_call_count = len(_Stripe.created_products) + len(_Stripe.created_prices)
        facade.supabase.tables["billing_plans"][0]["stripe_price_id"] = "price_replaced"

        try:
            asyncio.run(manager.sync_plan(
                "plan_1", "studio_1", "actor_1", "plan-key",
            ))
        except HTTPException as exc:
            assert exc.status_code == 503
            assert "price_replaced" not in exc.detail
        else:
            raise AssertionError("completed provider drift must fail")

        parent = next(iter(facade.supabase.billing_provider_operations.values()))
        assert parent["state"] == "completed"
        assert parent["result_summary"] == "plan_sync_mode:product_price_steps"
        assert provider_call_count == len(_Stripe.created_products) + len(_Stripe.created_prices)

    def test_projected_two_step_price_drift_moves_to_reconciliation_without_provider_retry(self):
        facade = _Facade(_tables())
        manager = BillingPlanManager(facade, stripe_service_cls=_Stripe)
        asyncio.run(manager.sync_plan(
            "plan_1", "studio_1", "actor_1", "plan-key",
        ))
        parent = next(iter(facade.supabase.billing_provider_operations.values()))
        parent["state"] = "projected"
        facade.supabase.tables["billing_plans"][0]["stripe_price_id"] = "price_replaced"
        provider_call_count = len(_Stripe.created_products) + len(_Stripe.created_prices)

        try:
            asyncio.run(manager.sync_plan(
                "plan_1", "studio_1", "actor_1", "plan-key",
            ))
        except HTTPException as exc:
            assert exc.status_code == 503
        else:
            raise AssertionError("projected provider drift must reconcile")

        assert parent["state"] == "reconciliation_required"
        assert parent["reconciliation_reason_code"] == "plan_sync_projection_unverified"
        assert provider_call_count == len(_Stripe.created_products) + len(_Stripe.created_prices)

    def test_completed_product_only_drift_is_bound_to_parent_product(self):
        plan = _plan(
            status="active",
            stripe_account_id="acct_1",
            stripe_product_id="prod_existing",
            stripe_price_id="price_existing",
        )
        tables = _tables(plan)
        tables["billing_plan_prices"].append({
            "id": "price_row",
            "studio_id": "studio_1",
            "billing_plan_id": "plan_1",
            "stripe_account_id": "acct_1",
            "stripe_product_id": "prod_existing",
            "stripe_price_id": "price_existing",
            "amount_cents": 12000,
            "currency": "usd",
            "billing_interval": "monthly",
            "recurring": True,
            "active": True,
            "version": 1,
            "metadata": {"connect_account_generation": 1},
            "created_at": "2026-08-27T00:00:00Z",
        })
        facade = _Facade(tables)
        manager = BillingPlanManager(facade, stripe_service_cls=_Stripe)
        asyncio.run(manager.sync_plan(
            "plan_1", "studio_1", "actor_1", "plan-key",
        ))
        facade.supabase.tables["billing_plans"][0]["stripe_product_id"] = "prod_replaced"

        try:
            asyncio.run(manager.sync_plan(
                "plan_1", "studio_1", "actor_1", "plan-key",
            ))
        except HTTPException as exc:
            assert exc.status_code == 503
        else:
            raise AssertionError("completed product drift must fail")

        assert len(_Stripe.updated_products) == 1

    def test_exact_legacy_price_adopts_generation_before_product_update(self):
        plan = _plan(
            status="active",
            stripe_account_id="acct_1",
            stripe_product_id="prod_existing",
            stripe_price_id="price_existing",
        )
        tables = _tables(plan)
        tables["billing_plan_prices"].append(
            _price_row(metadata={"legacy_marker": "keep"})
        )
        facade = _Facade(tables)

        result = asyncio.run(BillingPlanManager(
            facade,
            stripe_service_cls=_Stripe,
        ).sync_plan("plan_1", "studio_1", "actor_1", "legacy-price-key"))

        assert result.status == "active"
        assert tables["billing_plan_prices"][0]["metadata"] == {
            "legacy_marker": "keep",
            "connect_account_generation": 1,
        }
        assert len(_Stripe.updated_products) == 1
        assert _Stripe.created_products == []
        assert _Stripe.created_prices == []
        adoption = next(
            query
            for query in facade.supabase.query_log
            if query["table"] == "billing_plan_prices"
            and query["update"]
            and query["update"].get("metadata", {}).get("connect_account_generation") == 1
        )
        assert ("is", "metadata->connect_account_generation", "null") in adoption["filters"]

    def test_legacy_price_adoption_does_not_overwrite_raced_generation(self):
        plan = _plan(
            status="active",
            stripe_account_id="acct_1",
            stripe_product_id="prod_existing",
            stripe_price_id="price_existing",
        )
        tables = _tables(plan)
        price = _price_row(metadata={"legacy_marker": "keep"})
        tables["billing_plan_prices"].append(price)
        facade = _Facade(tables)

        def race_generation(_rows):
            price["metadata"] = {
                "legacy_marker": "keep",
                "connect_account_generation": 2,
            }

        facade.supabase.before_update = race_generation

        try:
            asyncio.run(BillingPlanManager(
                facade,
                stripe_service_cls=_Stripe,
            ).sync_plan("plan_1", "studio_1", "actor_1", "raced-generation-key"))
        except HTTPException as exc:
            assert exc.status_code == 409
        else:
            raise AssertionError("raced legacy generation must fail closed")

        assert price["metadata"]["connect_account_generation"] == 2
        assert _Stripe.updated_products == []
        assert _Stripe.created_products == []
        assert _Stripe.created_prices == []

    def test_local_projection_failure_requires_reconciliation_without_provider_retry(self):
        facade = _Facade(_tables())
        facade.supabase.on_update_query = lambda query, _rows: (
            []
            if query.name == "billing_plans"
            and (query.update_payload or {}).get("stripe_price_id")
            else None
        )
        manager = BillingPlanManager(facade, stripe_service_cls=_Stripe)

        for expected_status in (503, 409):
            try:
                asyncio.run(manager.sync_plan(
                    "plan_1", "studio_1", "actor_1", "plan-key",
                ))
            except HTTPException as exc:
                assert exc.status_code == expected_status
            else:
                raise AssertionError("projection failure must fail closed")

        assert len(_Stripe.created_products) == 1
        assert len(_Stripe.created_prices) == 1
        parent = next(iter(facade.supabase.billing_provider_operations.values()))
        assert parent["state"] == "reconciliation_required"

    def test_different_key_same_desired_plan_collapses_and_old_key_replays(self):
        facade = _Facade(_tables())
        manager = BillingPlanManager(facade, stripe_service_cls=_Stripe)

        first = asyncio.run(manager.sync_plan(
            "plan_1", "studio_1", "actor_1", "plan-key-1",
        ))
        second = asyncio.run(manager.sync_plan(
            "plan_1", "studio_1", "actor_1", "plan-key-2",
        ))
        replay = asyncio.run(manager.sync_plan(
            "plan_1", "studio_1", "actor_1", "plan-key-1",
        ))

        assert replay.stripe_price_id == first.stripe_price_id == second.stripe_price_id
        assert len(_Stripe.created_products) == 1
        assert len(_Stripe.updated_products) == 0
        assert len(_Stripe.created_prices) == 1
        assert len(facade.supabase.tables["audit_logs"]) == 1

    def test_changed_desired_plan_new_key_replaces_completed_owner(self):
        facade = _Facade(_tables())
        manager = BillingPlanManager(facade, stripe_service_cls=_Stripe)

        first = asyncio.run(manager.sync_plan(
            "plan_1", "studio_1", "actor_1", "plan-key-1",
        ))
        facade.supabase.tables["billing_plans"][0]["name"] = "Updated plan"
        second = asyncio.run(manager.sync_plan(
            "plan_1", "studio_1", "actor_1", "plan-key-2",
        ))

        assert second.stripe_price_id == first.stripe_price_id
        assert len(_Stripe.created_products) == 1
        assert len(_Stripe.updated_products) == 1
        assert len(_Stripe.created_prices) == 1
        assert len(facade.supabase.tables["audit_logs"]) == 2

    def test_changed_desired_plan_conflicts_with_old_key(self):
        facade = _Facade(_tables())
        manager = BillingPlanManager(facade, stripe_service_cls=_Stripe)
        asyncio.run(manager.sync_plan(
            "plan_1", "studio_1", "actor_1", "plan-key",
        ))
        facade.supabase.tables["billing_plans"][0]["amount_cents"] = 14000
        facade.supabase.tables["billing_plans"][0]["status"] = "pending"

        try:
            asyncio.run(manager.sync_plan(
                "plan_1", "studio_1", "actor_1", "plan-key",
            ))
        except HTTPException as exc:
            assert exc.status_code == 409
        else:
            raise AssertionError("changed desired input must conflict")
        assert len(_Stripe.created_products) == 1
        assert len(_Stripe.created_prices) == 1

    def test_contradictory_active_price_identity_fails_before_provider(self):
        plan = _plan(
            stripe_account_id="acct_1",
            stripe_product_id="prod_expected",
            stripe_price_id="price_wrong",
        )
        tables = _tables(plan)
        tables["billing_plan_prices"].append({
            "id": "price_row",
            "studio_id": "studio_1",
            "billing_plan_id": "plan_1",
            "stripe_account_id": "acct_1",
            "stripe_product_id": "prod_other",
            "stripe_price_id": "price_wrong",
            "amount_cents": 12000,
            "currency": "usd",
            "billing_interval": "monthly",
            "recurring": True,
            "active": True,
            "version": 1,
            "metadata": {"connect_account_generation": 1},
            "created_at": "2026-08-27T00:00:00Z",
        })
        facade = _Facade(tables)

        try:
            asyncio.run(BillingPlanManager(
                facade,
                stripe_service_cls=_Stripe,
            ).sync_plan("plan_1", "studio_1", "actor_1", "plan-key"))
        except HTTPException as exc:
            assert exc.status_code == 409
        else:
            raise AssertionError("contradictory provider identity must fail")
        assert _Stripe.created_products == []
        assert _Stripe.updated_products == []
        assert _Stripe.created_prices == []

    def test_step_plan_hash_matches_postgres_jsonb_text_fixture(self):
        steps = [
            {
                "step_name": "product",
                "provider_operation": "connected_product.create",
                "request_sha256": "a" * 64,
                "stripe_idempotency_key": "key-1",
            },
            {
                "step_name": "price",
                "provider_operation": "connected_price.create",
                "request_sha256": "b" * 64,
                "stripe_idempotency_key": "key-2",
            },
        ]
        postgres_text = (
            '[{"step_name": "product", "request_sha256": "' + "a" * 64
            + '", "provider_operation": "connected_product.create", '
            '"stripe_idempotency_key": "key-1"}, {"step_name": "price", '
            '"request_sha256": "' + "b" * 64
            + '", "provider_operation": "connected_price.create", '
            '"stripe_idempotency_key": "key-2"}]'
        )
        assert billing_provider_step_plan_sha256(steps) == hashlib.sha256(
            postgres_text.encode("utf-8")
        ).hexdigest()
