from __future__ import annotations

import asyncio
import hashlib

import pytest
from fastapi import HTTPException
from postgrest.exceptions import APIError as PostgrestAPIError

from app.schemas.billing import BillingPlanCreate, BillingPlanUpdate
from app.services.billing_plan_sync import BillingPlanSyncWorkflow
from app.services.billing_plans import BillingPlanManager
from app.services.billing_provider_operations import (
    BillingProviderOperationContext,
    BillingProviderOperationCoordinator,
    billing_provider_step_plan_sha256,
)
from app.services.platform_billing_helpers import build_idempotency_key
from tests.fakes.billing_provider_operations import BillingProviderOperationRpcMixin
from tests.fakes.supabase import RpcBackedSupabase


class _PlanSupabase(BillingProviderOperationRpcMixin, RpcBackedSupabase):
    def __init__(self, tables):
        super().__init__(tables)
        self.initialize_billing_provider_operations()
        self.lose_product_success_response_once = False
        self.unique_constraints["audit_logs"] = [("id",)]
        self.unique_conflict_error_factory = lambda _table, _columns: PostgrestAPIError({
            "code": "23505",
            "message": "duplicate key value violates unique constraint",
            "details": "",
            "hint": "",
        })

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
    retrieved_products = []
    update_error = None
    product_response = None

    @classmethod
    def reset(cls):
        cls.created_products = []
        cls.updated_products = []
        cls.created_prices = []
        cls.retrieved_products = []
        cls.update_error = None
        cls.product_response = None

    def create_connected_product(self, **payload):
        self.__class__.created_products.append(payload)
        return {"id": "prod_created"}

    def update_connected_product(self, **payload):
        self.__class__.updated_products.append(dict(payload))
        if self.__class__.update_error:
            raise self.__class__.update_error
        return {"id": payload["product_id"]}

    def retrieve_connected_product(self, **payload):
        self.__class__.retrieved_products.append(dict(payload))
        return self.__class__.product_response

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

    def test_completed_replay_repairs_failed_audit_once_without_provider_access(self):
        facade = _Facade(_tables())
        fail = {"pending": True}

        def fail_first_audit(table, _payloads, _rows):
            if table == "audit_logs" and fail["pending"]:
                fail["pending"] = False
                raise RuntimeError("audit unavailable")

        facade.supabase.before_insert = fail_first_audit
        manager = BillingPlanManager(facade, stripe_service_cls=_Stripe)

        with pytest.raises(RuntimeError, match="audit unavailable"):
            asyncio.run(manager.sync_plan(
                "plan_1", "studio_1", "actor_1", "audit-repair-key"
            ))
        parent = next(iter(facade.supabase.billing_provider_operations.values()))
        assert parent["state"] == "completed"
        provider_calls = (
            len(_Stripe.created_products)
            + len(_Stripe.updated_products)
            + len(_Stripe.created_prices)
            + len(_Stripe.retrieved_products)
        )

        repaired = asyncio.run(manager.sync_plan(
            "plan_1", "studio_1", "actor_1", "audit-repair-key"
        ))
        repeated = asyncio.run(manager.sync_plan(
            "plan_1", "studio_1", "actor_1", "audit-repair-key"
        ))

        assert repaired.id == repeated.id == "plan_1"
        assert len(facade.supabase.tables["audit_logs"]) == 1
        assert provider_calls == (
            len(_Stripe.created_products)
            + len(_Stripe.updated_products)
            + len(_Stripe.created_prices)
            + len(_Stripe.retrieved_products)
        )
        audit_reads = [
            query for query in facade.supabase.query_log
            if query["table"] == "audit_logs" and query["insert"] is None
        ]
        assert audit_reads
        assert all(
            query["filters"] == (("eq", "id", facade.supabase.tables["audit_logs"][0]["id"]),)
            for query in audit_reads
        )

    @pytest.mark.parametrize(
        "winner_change, expected_error",
        (
            (None, None),
            ("missing", "plan_sync_audit_conflict_unverified"),
            ("action", "plan_sync_audit_conflict_unverified"),
            ("studio_id", "plan_sync_audit_conflict_unverified"),
            ("metadata", "plan_sync_audit_conflict_unverified"),
        ),
    )
    def test_audit_insert_race_requires_exact_winner(
        self, winner_change, expected_error
    ):
        facade = _Facade(_tables())
        manager = BillingPlanManager(facade, stripe_service_cls=_Stripe)
        first = {"pending": True}

        def race_audit(table, payloads, rows):
            if table != "audit_logs" or not first["pending"]:
                return
            first["pending"] = False
            if winner_change != "missing":
                winner = dict(payloads[0])
                winner["metadata"] = dict(winner["metadata"])
                if winner_change == "action":
                    winner["action"] = "billing.plan_changed"
                elif winner_change == "studio_id":
                    winner["studio_id"] = "studio_other"
                elif winner_change == "metadata":
                    winner["metadata"]["connect_account_generation"] = 2
                rows.append(winner)
            raise PostgrestAPIError({
                "code": "23505",
                "message": "duplicate key value violates unique constraint",
                "details": "",
                "hint": "",
            })

        facade.supabase.before_insert = race_audit
        if expected_error:
            with pytest.raises(RuntimeError, match=expected_error):
                asyncio.run(manager.sync_plan(
                    "plan_1", "studio_1", "actor_1", "audit-race-key"
                ))
        else:
            result = asyncio.run(manager.sync_plan(
                "plan_1", "studio_1", "actor_1", "audit-race-key"
            ))
            assert result.id == "plan_1"
            assert len(facade.supabase.tables["audit_logs"]) == 1
        audit_reads = [
            query for query in facade.supabase.query_log
            if query["table"] == "audit_logs" and query["insert"] is None
        ]
        assert len(audit_reads) == 2

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

    def test_plan_projection_commit_then_lost_response_converges_and_replays(self):
        plan = _plan()
        facade = _Facade(_tables(plan))
        lost = {"pending": True}

        def commit_then_lose_response(query, _rows):
            if (
                lost["pending"]
                and query.name == "billing_plans"
                and (query.update_payload or {}).get("stripe_price_id")
            ):
                lost["pending"] = False
                plan.update(query.update_payload)
                raise RuntimeError("plan projection response lost")
            return None

        facade.supabase.on_update_query = commit_then_lose_response
        manager = BillingPlanManager(facade, stripe_service_cls=_Stripe)

        completed = asyncio.run(manager.sync_plan(
            "plan_1", "studio_1", "actor_1", "plan-update-lost"
        ))
        replay = asyncio.run(manager.sync_plan(
            "plan_1", "studio_1", "actor_1", "plan-update-lost"
        ))

        assert completed.status == "active"
        assert replay.stripe_price_id == completed.stripe_price_id == "price_1"
        assert len(facade.supabase.tables["billing_plan_prices"]) == 1
        assert facade.supabase.tables["billing_plan_prices"][0]["metadata"][
            "provider_operation_id"
        ]
        assert len(facade.supabase.tables["audit_logs"]) == 1
        parent = next(iter(facade.supabase.billing_provider_operations.values()))
        assert parent["state"] == "completed"
        assert len(_Stripe.created_products) == 1
        assert len(_Stripe.created_prices) == 1

    def test_price_insert_commit_then_lost_response_recovers_owned_row(self):
        facade = _Facade(_tables())
        lost = {"pending": True}

        def commit_price_then_lose_response(name, payloads, rows):
            if name == "billing_plan_prices" and lost["pending"]:
                lost["pending"] = False
                rows.append({
                    "id": "price_projection_lost",
                    "created_at": "2026-08-27T00:00:00Z",
                    **payloads[0],
                })
                raise RuntimeError("price projection response lost")

        facade.supabase.before_insert = commit_price_then_lose_response
        manager = BillingPlanManager(facade, stripe_service_cls=_Stripe)

        completed = asyncio.run(manager.sync_plan(
            "plan_1", "studio_1", "actor_1", "price-insert-lost"
        ))
        replay = asyncio.run(manager.sync_plan(
            "plan_1", "studio_1", "actor_1", "price-insert-lost"
        ))

        prices = facade.supabase.tables["billing_plan_prices"]
        assert completed.status == "active"
        assert replay.stripe_price_id == completed.stripe_price_id == "price_1"
        assert [price["id"] for price in prices] == ["price_projection_lost"]
        parent = next(iter(facade.supabase.billing_provider_operations.values()))
        assert prices[0]["metadata"] == {
            "connect_account_generation": 1,
            "provider_operation_id": parent["id"],
        }
        assert parent["state"] == "completed"
        assert len(facade.supabase.tables["audit_logs"]) == 1

    def test_archive_committing_during_two_step_sync_wins_projection_cas(self):
        plan = _plan()
        tables = _tables(plan)
        preexisting_price = _price_row(
            id="price_preexisting",
            stripe_product_id="prod_preexisting",
            stripe_price_id="price_preexisting",
            active=False,
        )
        tables["billing_plan_prices"].append(preexisting_price)
        facade = _Facade(tables)

        def archive_before_projection(_rows):
            plan["status"] = "archived"
            plan["archived_at"] = "2026-08-27T01:00:00Z"

        facade.supabase.before_update = archive_before_projection

        with pytest.raises(HTTPException) as failed:
            asyncio.run(BillingPlanManager(
                facade,
                stripe_service_cls=_Stripe,
            ).sync_plan("plan_1", "studio_1", "actor_1", "archive-race"))

        assert failed.value.status_code == 503
        assert plan["status"] == "archived"
        assert plan["archived_at"] == "2026-08-27T01:00:00Z"
        assert plan["stripe_account_id"] is None
        assert plan["stripe_product_id"] is None
        assert plan["stripe_price_id"] is None
        assert len(_Stripe.created_products) == 1
        assert len(_Stripe.created_prices) == 1
        parent = next(iter(facade.supabase.billing_provider_operations.values()))
        assert parent["state"] == "reconciliation_required"
        assert parent["reconciliation_reason_code"] == "plan_sync_local_projection_failed"
        assert facade.supabase.tables["audit_logs"] == []
        assert facade.supabase.tables["billing_plan_prices"] == [preexisting_price]

    def test_conclusive_cas_miss_never_deletes_price_owned_by_other_operation(self):
        plan = _plan()
        other_owned_price = _price_row(
            id="price_owned_elsewhere",
            stripe_product_id="prod_created",
            stripe_price_id="price_1",
            metadata={
                "connect_account_generation": 1,
                "provider_operation_id": "other_operation",
            },
        )
        facade = _Facade(_tables(plan))
        price_reads = {"count": 0}

        def expose_other_owned_price_after_provider(_columns):
            price_reads["count"] += 1
            if price_reads["count"] == 2:
                facade.supabase.tables["billing_plan_prices"].append(
                    other_owned_price
                )

        facade.supabase.select_assertions["billing_plan_prices"] = (
            expose_other_owned_price_after_provider
        )

        def archive_before_projection(_rows):
            plan["status"] = "archived"
            plan["archived_at"] = "2026-08-27T02:00:00Z"

        facade.supabase.before_update = archive_before_projection

        with pytest.raises(HTTPException) as failed:
            asyncio.run(BillingPlanManager(
                facade,
                stripe_service_cls=_Stripe,
            ).sync_plan("plan_1", "studio_1", "actor_1", "other-owned-price"))

        assert failed.value.status_code == 503
        assert plan["status"] == "archived"
        assert facade.supabase.tables["billing_plan_prices"] == [other_owned_price]
        assert not any(
            query["delete"]
            for query in facade.supabase.query_log
            if query["table"] == "billing_plan_prices"
        )
        parent = next(iter(facade.supabase.billing_provider_operations.values()))
        assert parent["state"] == "reconciliation_required"

    def test_amount_interval_edit_during_product_sync_wins_projection_cas(self):
        plan = _plan(
            status="active",
            stripe_account_id="acct_1",
            stripe_product_id="prod_existing",
            stripe_price_id="price_existing",
            stripe_price_lookup_key="koaryu_studio_1_plan_1_v1",
        )
        tables = _tables(plan)
        tables["billing_plan_prices"].append(_price_row())
        facade = _Facade(tables)

        def edit_before_projection(_rows):
            plan["amount_cents"] = 18000
            plan["billing_interval"] = "annual"
            plan["status"] = "pending"

        facade.supabase.before_update = edit_before_projection

        with pytest.raises(HTTPException) as failed:
            asyncio.run(BillingPlanManager(
                facade,
                stripe_service_cls=_Stripe,
            ).sync_plan("plan_1", "studio_1", "actor_1", "terms-race"))

        assert failed.value.status_code == 503
        assert plan["amount_cents"] == 18000
        assert plan["billing_interval"] == "annual"
        assert plan["status"] == "pending"
        assert plan["stripe_product_id"] == "prod_existing"
        assert plan["stripe_price_id"] == "price_existing"
        assert len(_Stripe.updated_products) == 1
        assert _Stripe.created_products == []
        assert _Stripe.created_prices == []
        parent = next(iter(facade.supabase.billing_provider_operations.values()))
        assert parent["state"] == "reconciliation_required"
        assert parent["reconciliation_reason_code"] == "plan_sync_local_projection_failed"
        assert facade.supabase.tables["audit_logs"] == []

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

    def _product_update_recovery(self, outcome, recovered_id=None):
        plan = _plan(
            status="active",
            stripe_account_id="acct_1",
            stripe_product_id="prod_existing",
            stripe_price_id="price_existing",
        )
        facade = _Facade(_tables(plan))
        facade.supabase.tables["billing_plan_prices"] = [_price_row()]
        manager = BillingPlanManager(facade, stripe_service_cls=_Stripe)
        _Stripe.update_error = RuntimeError("lost update response")
        with pytest.raises(HTTPException):
            asyncio.run(manager.sync_plan(
                "plan_1", "studio_1", "actor_1", "plan-recovery-key"
            ))
        operation = next(iter(facade.supabase.billing_provider_operations.values()))
        context = BillingProviderOperationContext(
            operation["id"], "studio_1", "actor_1", "plan.sync",
            operation["caller_request_key"], operation["request_sha256"],
            "acct_1", 1, str(operation["lease_owner"]),
        )
        BillingProviderOperationCoordinator(facade.supabase).authorize_recovery_v2(
            context,
            operation,
            recovery_actor_id="00000000-0000-4000-8000-000000000201",
            recovery_proof_sha256="a" * 64,
            recovery_outcome=outcome,
            recovered_provider_object_id=recovered_id,
            lease_owner="00000000-0000-4000-8000-000000000101",
        )
        return facade, manager, operation, plan

    def test_product_update_safe_retry_reuses_exact_payload_and_key(self):
        facade, manager, operation, _plan_row = self._product_update_recovery(
            "provider_no_object_safe_to_retry"
        )
        first_payload = dict(_Stripe.updated_products[0])
        _Stripe.update_error = None
        result = asyncio.run(manager.sync_plan(
            "plan_1", "studio_1", "actor_1", "plan-recovery-key"
        ))
        assert result.status == "active"
        assert _Stripe.updated_products == [first_payload, first_payload]
        assert operation["provider_request_attempt_count"] == 2
        assert operation["state"] == "completed"
        asyncio.run(manager.sync_plan(
            "plan_1", "studio_1", "actor_1", "plan-recovery-key"
        ))
        assert len(_Stripe.updated_products) == 2
        assert len(facade.supabase.billing_provider_operations) == 1
        assert len(facade.supabase.billing_provider_operation_resources) == 1
        assert len(facade.supabase.billing_provider_operation_aliases) == 1

    def test_product_update_safe_retry_rejects_provider_id_drift_before_stripe(self):
        facade, manager, operation, plan = self._product_update_recovery(
            "provider_no_object_safe_to_retry"
        )
        plan["stripe_product_id"] = "prod_drifted"
        _Stripe.update_error = None
        with pytest.raises(HTTPException):
            asyncio.run(manager.sync_plan(
                "plan_1", "studio_1", "actor_1", "plan-recovery-key"
            ))
        assert len(_Stripe.updated_products) == 1
        assert operation["state"] == "definitive_rejected"
        assert operation["error_code"] == "plan_sync_recovery_source_drift"

    def test_product_update_reconcile_only_gets_without_second_mutation(self):
        facade, manager, operation, plan = self._product_update_recovery(
            "provider_succeeded_reconcile_only", "prod_existing"
        )
        _Stripe.update_error = None
        _Stripe.product_response = {
            "id": "prod_existing",
            "name": plan["name"],
            "description": plan["description"],
            "metadata": BillingPlanSyncWorkflow(
                facade, stripe_service_cls=_Stripe
            )._product_metadata(plan),
        }
        result = asyncio.run(manager.sync_plan(
            "plan_1", "studio_1", "actor_1", "plan-recovery-key"
        ))
        assert result.status == "active"
        assert len(_Stripe.updated_products) == 1
        assert _Stripe.retrieved_products == [{
            "account_id": "acct_1", "product_id": "prod_existing"
        }]
        assert operation["provider_request_attempt_count"] == 1
        assert operation["state"] == "completed"

    @pytest.mark.parametrize("mismatch", ["id", "name", "metadata"])
    def test_product_reconcile_only_mismatch_returns_to_reconciliation(self, mismatch):
        facade, manager, operation, plan = self._product_update_recovery(
            "provider_succeeded_reconcile_only", "prod_existing"
        )
        response = {
            "id": "prod_existing", "name": plan["name"],
            "description": plan["description"],
            "metadata": BillingPlanSyncWorkflow(
                facade, stripe_service_cls=_Stripe
            )._product_metadata(plan),
        }
        if mismatch == "id":
            response["id"] = "prod_wrong"
        elif mismatch == "name":
            response["name"] = "Wrong"
        else:
            response["metadata"] = {"studio_id": "wrong"}
        _Stripe.product_response = response
        with pytest.raises(HTTPException):
            asyncio.run(manager.sync_plan(
                "plan_1", "studio_1", "actor_1", "plan-recovery-key"
            ))
        assert len(_Stripe.updated_products) == 1
        assert operation["state"] == "reconciliation_required"
        assert facade.supabase.tables["audit_logs"] == []
