from __future__ import annotations

import asyncio
import copy
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
    BillingProviderStepCoordinator,
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
        self.unique_conflict_error_factory = lambda _table, _columns: PostgrestAPIError(
            {
                "code": "23505",
                "message": "duplicate key value violates unique constraint",
                "details": "",
                "hint": "",
            }
        )

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
                if candidate.get("id") == record_id and candidate.get("studio_id") == studio_id
            ),
            None,
        )
        if row is None:
            raise HTTPException(status_code=404, detail=detail)
        return row

    def _idempotency_key(self, *parts):
        return build_idempotency_key(*parts)


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

    @pytest.mark.parametrize(
        "plan_id,payload,values,program_ids,programs",
        [
            (
                None,
                BillingPlanCreate(name=" New  plan ", amount_cents=5000, currency=" USD "),
                {
                    "name": "New plan",
                    "description": None,
                    "amount_cents": 5000,
                    "currency": "usd",
                    "billing_interval": "monthly",
                    "signup_fee_cents": 0,
                    "trial_days": 0,
                    "proration_behavior": "next_cycle",
                    "freeze_behavior": None,
                    "cancellation_policy": None,
                    "tax_behavior": None,
                },
                [],
                [],
            ),
            (
                "plan_1",
                BillingPlanUpdate(name=" New  plan ", description=None, currency=" USD "),
                {"name": "New plan", "description": None, "currency": "usd"},
                None,
                [],
            ),
            ("plan_1", BillingPlanUpdate(program_ids=None), {}, None, []),
            ("plan_1", BillingPlanUpdate(program_ids=[]), {}, [], []),
            (
                "plan_1",
                BillingPlanUpdate(program_ids=["program_1", "program_1"]),
                {},
                ["program_1", "program_1"],
                [
                    {
                        "program_id": "program_1",
                        "program_name": "Committed program",
                        "program_color_hex": "#123456",
                    }
                ],
            ),
        ],
    )
    def test_local_plan_write_uses_rpc_identity_presence_and_committed_snapshot(
        self,
        plan_id,
        payload,
        values,
        program_ids,
        programs,
    ):
        facade = _Facade({})
        returned = {"plan": _plan(name="Committed plan", amount_cents=5000), "programs": programs}
        facade.supabase._rpc_write_billing_plan_v1 = lambda _params: returned
        manager = BillingPlanManager(facade, stripe_service_cls=_Stripe)
        result = asyncio.run(
            manager.create_plan(payload, "studio_1", "actor_1")
            if plan_id is None
            else manager.update_plan(plan_id, payload, "studio_1", "actor_1")
        )
        assert facade.supabase.rpc_calls == [
            (
                "write_billing_plan_v1",
                {
                    "p_studio_id": "studio_1",
                    "p_actor_id": "actor_1",
                    "p_plan_id": plan_id,
                    "p_values": values,
                    "p_program_ids": program_ids,
                },
            )
        ]
        assert (result.id, result.name, result.amount_cents) == ("plan_1", "Committed plan", 5000)
        assert [program.model_dump() for program in result.programs] == programs
        assert result.status == "pending"
        assert result.can_accept_payments is False
        assert facade.supabase.query_log == []
        assert _Stripe.created_products == []
        assert _Stripe.updated_products == []
        assert _Stripe.created_prices == []
        assert _Stripe.retrieved_products == []

    @pytest.mark.parametrize(
        "code,message,status",
        [
            ("23505", "duplicate key", 409),
            ("P0002", "billing_plan_not_found", 404),
            ("P0002", "billing_plan_program_not_found", 404),
            ("22023", "billing_plan_requires_usd", 400),
            ("42501", "billing_plan_actor_not_active", 403),
            ("40001", "retry required", None),
        ],
    )
    def test_local_plan_rpc_rejections_do_not_fall_back(self, code, message, status):
        facade = _Facade({})
        error = PostgrestAPIError({"code": code, "message": message, "details": "", "hint": ""})

        def reject(_params):
            raise error

        facade.supabase._rpc_write_billing_plan_v1 = reject
        with pytest.raises(HTTPException if status else PostgrestAPIError) as failure:
            asyncio.run(
                BillingPlanManager(facade, stripe_service_cls=_Stripe).update_plan(
                    "plan_1",
                    BillingPlanUpdate(description=None),
                    "studio_1",
                    "actor_1",
                )
            )
        if status:
            assert failure.value.status_code == status
        else:
            assert failure.value is error
        assert facade.supabase.query_log == []
        assert len(facade.supabase.rpc_calls) == 1
        assert not (_Stripe.created_products or _Stripe.updated_products or _Stripe.created_prices)

    def test_plan_sync_requires_canonical_byte_bounded_key(self):
        for key in (None, "é" * 128):
            facade = _Facade(_tables())
            try:
                asyncio.run(
                    BillingPlanManager(
                        facade,
                        stripe_service_cls=_Stripe,
                    ).sync_plan("plan_1", "studio_1", "actor_1", key)
                )
            except HTTPException as exc:
                assert exc.status_code == 400
            else:
                raise AssertionError("invalid key must fail")
            assert facade.supabase.billing_provider_operations == {}

    def test_two_step_create_replays_without_duplicate_product_price_or_audit(self):
        facade = _Facade(_tables())
        manager = BillingPlanManager(facade, stripe_service_cls=_Stripe)

        first = asyncio.run(
            manager.sync_plan(
                "plan_1",
                "studio_1",
                "actor_1",
                "plan-key-1",
            )
        )
        alias = asyncio.run(manager.sync_plan("plan_1", "studio_1", "actor_1", "plan-key-2"))
        replay = asyncio.run(
            manager.sync_plan(
                "plan_1",
                "studio_1",
                "actor_1",
                "plan-key-1",
            )
        )

        assert first.status == "active"
        assert first.can_accept_payments is True
        assert replay.stripe_product_id == first.stripe_product_id
        assert replay.stripe_price_id == first.stripe_price_id == alias.stripe_price_id
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
        assert _Stripe.created_prices[0]["currency"] == "usd"

    @pytest.mark.parametrize(
        "currency,product_id", [("eur", None), (None, "prod_existing"), (" ", None)]
    )
    def test_fresh_price_requires_usd_before_product_mutation(self, currency, product_id):
        facade = _Facade(
            _tables(
                _plan(
                    currency=currency,
                    stripe_product_id=product_id,
                    stripe_account_id="acct_1" if product_id else None,
                )
            )
        )
        before = copy.deepcopy(facade.supabase.tables)
        with pytest.raises(HTTPException) as failure:
            asyncio.run(
                BillingPlanManager(facade, stripe_service_cls=_Stripe).sync_plan(
                    "plan_1", "studio_1", "actor_1", "unsupported-currency"
                )
            )
        assert failure.value.status_code == 400
        parent = next(iter(facade.supabase.billing_provider_operations.values()))
        assert (
            parent["state"],
            parent["error_code"],
            parent["provider_request_attempt_count"],
        ) == ("definitive_rejected", "tuition_currency_requires_usd", 0)
        assert facade.supabase.tables == before
        assert not (_Stripe.created_products or _Stripe.updated_products or _Stripe.created_prices)
        assert not facade.supabase.billing_provider_step_plans

    @pytest.mark.parametrize(
        "stage,expected",
        [
            ("registered", 400),
            ("product", 409),
            ("attempted_price", 409),
            ("confirmed_price", None),
        ],
    )
    def test_historical_non_usd_price_respects_saved_attempt_evidence(self, stage, expected):
        # Seed historical receipts directly; no forbidden price is created through this workflow.
        facade = _Facade(_tables(_plan(currency="eur")))
        manager = BillingPlanManager(facade, stripe_service_cls=_Stripe)
        workflow = BillingPlanSyncWorkflow(manager, stripe_service_cls=_Stripe)
        plan = facade.supabase.tables["billing_plans"][0]
        operations = BillingProviderOperationCoordinator(facade.supabase)
        lease = "00000000-0000-4000-8000-000000000101"
        claimed = operations.claim_resource(
            studio_id="studio_1",
            actor_id="actor_1",
            operation_type="plan.sync",
            resource_type="plan",
            resource_id="plan_1",
            payer_id=None,
            caller_request_key="historical",
            request_sha256=workflow._desired_plan_hash(plan, "acct_1", 1),
            stripe_connected_account_id="acct_1",
            connect_account_generation=1,
            lease_owner=lease,
        )
        operation = claimed["operation"]
        context = BillingProviderOperationContext(
            operation["id"],
            "studio_1",
            "actor_1",
            "plan.sync",
            "historical",
            operation["request_sha256"],
            "acct_1",
            1,
            lease,
        )
        spec = workflow._two_step_plan(plan, context)
        client = BillingProviderStepCoordinator(facade.supabase)
        registered = client.register_plan(
            context, operation, plan_sha256=spec["plan_sha256"], steps=spec["steps"]
        )
        operation = registered["operation"]
        count = {"registered": 0, "product": 1, "attempted_price": 2, "confirmed_price": 2}[stage]
        for order in range(1, count + 1):
            step = workflow._step_context(
                context, spec["plan_sha256"], order, spec["steps"][order - 1]
            )
            current = client.claim_step(step)["step"]
            current = client.transition_step(step, current, "provider_request_in_flight")
            if not (stage == "attempted_price" and order == 2):
                client.transition_step(
                    step,
                    current,
                    "provider_succeeded",
                    provider_object_id=("prod_historical" if order == 1 else "price_historical"),
                )
        if stage == "confirmed_price":
            client.complete_provider_phase(
                context, operation, plan_sha256=spec["plan_sha256"], expected_step_count=2
            )
        parent = next(iter(facade.supabase.billing_provider_operations.values()))
        facade.supabase.advance_billing_provider_clock(seconds=31)
        saved = copy.deepcopy(facade.supabase.billing_provider_step_plans[parent["id"]]["steps"])
        if expected:
            with pytest.raises(HTTPException) as failure:
                asyncio.run(manager.sync_plan("plan_1", "studio_1", "actor_1", "historical"))
            assert failure.value.status_code == expected
            assert facade.supabase.tables["billing_plan_prices"] == []
        else:
            result = asyncio.run(manager.sync_plan("plan_1", "studio_1", "actor_1", "historical"))
            replay = asyncio.run(manager.sync_plan("plan_1", "studio_1", "actor_1", "historical"))
            assert result.stripe_price_id == replay.stripe_price_id == "price_historical"
            assert (
                result.currency == "eur"
                and facade.supabase.tables["billing_plan_prices"][0]["currency"] == "eur"
            )
            assert result.can_accept_payments is False and "USD" in result.pending_reason
        after = facade.supabase.billing_provider_step_plans[parent["id"]]["steps"]
        for old, new in zip(saved, after, strict=True):
            assert (
                new["provider_request_attempt_count"],
                new.get("provider_object_id"),
                new["stripe_idempotency_key"],
            ) == (
                old["provider_request_attempt_count"],
                old.get("provider_object_id"),
                old["stripe_idempotency_key"],
            )
        assert not (_Stripe.created_products or _Stripe.updated_products or _Stripe.created_prices)

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
            asyncio.run(manager.sync_plan("plan_1", "studio_1", "actor_1", "audit-repair-key"))
        parent = next(iter(facade.supabase.billing_provider_operations.values()))
        assert parent["state"] == "completed"
        provider_calls = (
            len(_Stripe.created_products)
            + len(_Stripe.updated_products)
            + len(_Stripe.created_prices)
            + len(_Stripe.retrieved_products)
        )

        repaired = asyncio.run(
            manager.sync_plan("plan_1", "studio_1", "actor_1", "audit-repair-key")
        )
        repeated = asyncio.run(
            manager.sync_plan("plan_1", "studio_1", "actor_1", "audit-repair-key")
        )

        assert repaired.id == repeated.id == "plan_1"
        assert len(facade.supabase.tables["audit_logs"]) == 1
        assert provider_calls == (
            len(_Stripe.created_products)
            + len(_Stripe.updated_products)
            + len(_Stripe.created_prices)
            + len(_Stripe.retrieved_products)
        )

    @pytest.mark.parametrize(
        "change,error",
        [
            ("none", None),
            ("actor", "mismatch"),
            ("product", "mismatch"),
            ("missing_price", "mismatch"),
            ("entity", "mismatch"),
            ("duplicate", "ambiguous"),
        ],
    )
    def test_completed_replay_verifies_legacy_audit_without_writing(self, change, error):
        facade = _Facade(_tables())
        manager = BillingPlanManager(facade, stripe_service_cls=_Stripe)
        asyncio.run(manager.sync_plan("plan_1", "studio_1", "actor_1", "legacy-audit-key"))
        audit = facade.supabase.tables["audit_logs"][0]
        audit["id"] = "legacy-random-id"
        audit["metadata"] = {
            key: audit["metadata"][key]
            for key in ("operation_id", "stripe_product_id", "stripe_price_id")
        }
        if change == "actor":
            audit["actor_id"] = "actor_other"
        elif change == "product":
            audit["metadata"]["stripe_product_id"] = "prod_other"
        elif change == "missing_price":
            audit["metadata"].pop("stripe_price_id")
        elif change == "entity":
            audit["entity_type"] = "other"
        elif change == "duplicate":
            facade.supabase.tables["audit_logs"].append(
                {**copy.deepcopy(audit), "id": "legacy-second-id"}
            )
        before = copy.deepcopy(facade.supabase.tables["audit_logs"])
        provider_calls = tuple(
            map(
                len,
                (
                    _Stripe.created_products,
                    _Stripe.updated_products,
                    _Stripe.created_prices,
                    _Stripe.retrieved_products,
                ),
            )
        )
        facade.supabase.query_log.clear()
        if error:
            with pytest.raises(RuntimeError, match=f"plan_sync_legacy_audit.*{error}"):
                asyncio.run(manager.sync_plan("plan_1", "studio_1", "actor_1", "legacy-audit-key"))
        else:
            replay = asyncio.run(
                manager.sync_plan("plan_1", "studio_1", "actor_1", "legacy-audit-key")
            )
            assert replay.id == "plan_1"
        assert facade.supabase.tables["audit_logs"] == before
        assert not any(
            query["insert"] is not None
            for query in facade.supabase.query_log
            if query["table"] == "audit_logs"
        )
        assert provider_calls == tuple(
            map(
                len,
                (
                    _Stripe.created_products,
                    _Stripe.updated_products,
                    _Stripe.created_prices,
                    _Stripe.retrieved_products,
                ),
            )
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
    def test_audit_insert_race_requires_exact_winner(self, winner_change, expected_error):
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
            raise PostgrestAPIError(
                {
                    "code": "23505",
                    "message": "duplicate key value violates unique constraint",
                    "details": "",
                    "hint": "",
                }
            )

        facade.supabase.before_insert = race_audit
        if expected_error:
            with pytest.raises(RuntimeError, match=expected_error):
                asyncio.run(manager.sync_plan("plan_1", "studio_1", "actor_1", "audit-race-key"))
        else:
            result = asyncio.run(
                manager.sync_plan("plan_1", "studio_1", "actor_1", "audit-race-key")
            )
            assert result.id == "plan_1"
            assert len(facade.supabase.tables["audit_logs"]) == 1
        audit_reads = [
            query
            for query in facade.supabase.query_log
            if query["table"] == "audit_logs" and query["insert"] is None
        ]
        assert (
            len(
                [
                    query
                    for query in audit_reads
                    if len(query["filters"]) == 1 and query["filters"][0][1] == "id"
                ]
            )
            == 2
        )

    def test_lost_product_success_response_resumes_at_price_step(self):
        facade = _Facade(_tables())
        facade.supabase.lose_product_success_response_once = True
        manager = BillingPlanManager(facade, stripe_service_cls=_Stripe)

        try:
            asyncio.run(
                manager.sync_plan(
                    "plan_1",
                    "studio_1",
                    "actor_1",
                    "plan-key",
                )
            )
        except HTTPException as exc:
            assert exc.status_code == 503
        else:
            raise AssertionError("lost response must not report success")
        result = asyncio.run(
            manager.sync_plan(
                "plan_1",
                "studio_1",
                "actor_1",
                "plan-key",
            )
        )

        assert result.status == "active"
        assert len(_Stripe.created_products) == 1
        assert len(_Stripe.created_prices) == 1
        assert len(facade.supabase.tables["audit_logs"]) == 1

    def test_provider_phase_receipt_resumes_projection_and_audits_once(self):
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
            asyncio.run(
                manager.sync_plan(
                    "plan_1",
                    "studio_1",
                    "actor_1",
                    "plan-key",
                )
            )
        except KeyboardInterrupt:
            pass
        else:
            raise AssertionError("fixture did not stop after provider phase")

        parent = next(iter(facade.supabase.billing_provider_operations.values()))
        assert parent["state"] == "provider_succeeded"
        assert parent["provider_request_attempt_count"] == 1
        assert parent["provider_object_id"] == "price_1"
        assert parent["result_code"] == "provider_step_phase_completed"
        assert facade.supabase.tables["audit_logs"] == []

        result = asyncio.run(
            manager.sync_plan(
                "plan_1",
                "studio_1",
                "actor_1",
                "plan-key",
            )
        )

        assert result.status == "active"
        assert len(_Stripe.created_products) == 1
        assert len(_Stripe.created_prices) == 1
        assert len(facade.supabase.tables["billing_plan_prices"]) == 1
        assert len(facade.supabase.tables["audit_logs"]) == 1

    def test_completed_two_step_price_drift_is_sanitized_without_provider_retry(self):
        facade = _Facade(_tables())
        manager = BillingPlanManager(facade, stripe_service_cls=_Stripe)
        asyncio.run(
            manager.sync_plan(
                "plan_1",
                "studio_1",
                "actor_1",
                "plan-key",
            )
        )
        provider_call_count = len(_Stripe.created_products) + len(_Stripe.created_prices)
        facade.supabase.tables["billing_plans"][0]["stripe_price_id"] = "price_replaced"

        try:
            asyncio.run(
                manager.sync_plan(
                    "plan_1",
                    "studio_1",
                    "actor_1",
                    "plan-key",
                )
            )
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
        asyncio.run(
            manager.sync_plan(
                "plan_1",
                "studio_1",
                "actor_1",
                "plan-key",
            )
        )
        parent = next(iter(facade.supabase.billing_provider_operations.values()))
        parent["state"] = "projected"
        facade.supabase.tables["billing_plans"][0]["stripe_price_id"] = "price_replaced"
        provider_call_count = len(_Stripe.created_products) + len(_Stripe.created_prices)

        try:
            asyncio.run(
                manager.sync_plan(
                    "plan_1",
                    "studio_1",
                    "actor_1",
                    "plan-key",
                )
            )
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
        tables["billing_plan_prices"].append(
            {
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
            }
        )
        facade = _Facade(tables)
        manager = BillingPlanManager(facade, stripe_service_cls=_Stripe)
        asyncio.run(
            manager.sync_plan(
                "plan_1",
                "studio_1",
                "actor_1",
                "plan-key",
            )
        )
        facade.supabase.tables["billing_plans"][0]["stripe_product_id"] = "prod_replaced"

        try:
            asyncio.run(
                manager.sync_plan(
                    "plan_1",
                    "studio_1",
                    "actor_1",
                    "plan-key",
                )
            )
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
        tables["billing_plan_prices"].append(_price_row(metadata={"legacy_marker": "keep"}))
        facade = _Facade(tables)

        result = asyncio.run(
            BillingPlanManager(
                facade,
                stripe_service_cls=_Stripe,
            ).sync_plan("plan_1", "studio_1", "actor_1", "legacy-price-key")
        )

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
            asyncio.run(
                BillingPlanManager(
                    facade,
                    stripe_service_cls=_Stripe,
                ).sync_plan("plan_1", "studio_1", "actor_1", "raced-generation-key")
            )
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
            if query.name == "billing_plans" and (query.update_payload or {}).get("stripe_price_id")
            else None
        )
        manager = BillingPlanManager(facade, stripe_service_cls=_Stripe)

        for expected_status in (503, 409):
            try:
                asyncio.run(
                    manager.sync_plan(
                        "plan_1",
                        "studio_1",
                        "actor_1",
                        "plan-key",
                    )
                )
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

        completed = asyncio.run(
            manager.sync_plan("plan_1", "studio_1", "actor_1", "plan-update-lost")
        )
        replay = asyncio.run(manager.sync_plan("plan_1", "studio_1", "actor_1", "plan-update-lost"))

        assert completed.status == "active"
        assert replay.stripe_price_id == completed.stripe_price_id == "price_1"
        assert len(facade.supabase.tables["billing_plan_prices"]) == 1
        assert facade.supabase.tables["billing_plan_prices"][0]["metadata"]["provider_operation_id"]
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
                rows.append(
                    {
                        "id": "price_projection_lost",
                        "created_at": "2026-08-27T00:00:00Z",
                        **payloads[0],
                    }
                )
                raise RuntimeError("price projection response lost")

        facade.supabase.before_insert = commit_price_then_lose_response
        manager = BillingPlanManager(facade, stripe_service_cls=_Stripe)

        completed = asyncio.run(
            manager.sync_plan("plan_1", "studio_1", "actor_1", "price-insert-lost")
        )
        replay = asyncio.run(
            manager.sync_plan("plan_1", "studio_1", "actor_1", "price-insert-lost")
        )

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
            asyncio.run(
                BillingPlanManager(
                    facade,
                    stripe_service_cls=_Stripe,
                ).sync_plan("plan_1", "studio_1", "actor_1", "archive-race")
            )

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
                facade.supabase.tables["billing_plan_prices"].append(other_owned_price)

        facade.supabase.select_assertions["billing_plan_prices"] = (
            expose_other_owned_price_after_provider
        )

        def archive_before_projection(_rows):
            plan["status"] = "archived"
            plan["archived_at"] = "2026-08-27T02:00:00Z"

        facade.supabase.before_update = archive_before_projection

        with pytest.raises(HTTPException) as failed:
            asyncio.run(
                BillingPlanManager(
                    facade,
                    stripe_service_cls=_Stripe,
                ).sync_plan("plan_1", "studio_1", "actor_1", "other-owned-price")
            )

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
            asyncio.run(
                BillingPlanManager(
                    facade,
                    stripe_service_cls=_Stripe,
                ).sync_plan("plan_1", "studio_1", "actor_1", "terms-race")
            )

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

    def test_changed_desired_plan_new_key_replaces_completed_owner(self):
        facade = _Facade(_tables())
        manager = BillingPlanManager(facade, stripe_service_cls=_Stripe)

        first = asyncio.run(
            manager.sync_plan(
                "plan_1",
                "studio_1",
                "actor_1",
                "plan-key-1",
            )
        )
        facade.supabase.tables["billing_plans"][0]["name"] = "Updated plan"
        second = asyncio.run(
            manager.sync_plan(
                "plan_1",
                "studio_1",
                "actor_1",
                "plan-key-2",
            )
        )

        assert second.stripe_price_id == first.stripe_price_id
        assert len(_Stripe.created_products) == 1
        assert len(_Stripe.updated_products) == 1
        assert len(_Stripe.created_prices) == 1
        assert len(facade.supabase.tables["audit_logs"]) == 2

    def test_changed_desired_plan_conflicts_with_old_key(self):
        facade = _Facade(_tables())
        manager = BillingPlanManager(facade, stripe_service_cls=_Stripe)
        asyncio.run(
            manager.sync_plan(
                "plan_1",
                "studio_1",
                "actor_1",
                "plan-key",
            )
        )
        facade.supabase.tables["billing_plans"][0]["amount_cents"] = 14000
        facade.supabase.tables["billing_plans"][0]["status"] = "pending"

        try:
            asyncio.run(
                manager.sync_plan(
                    "plan_1",
                    "studio_1",
                    "actor_1",
                    "plan-key",
                )
            )
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
        tables["billing_plan_prices"].append(
            {
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
            }
        )
        facade = _Facade(tables)

        try:
            asyncio.run(
                BillingPlanManager(
                    facade,
                    stripe_service_cls=_Stripe,
                ).sync_plan("plan_1", "studio_1", "actor_1", "plan-key")
            )
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
            '[{"step_name": "product", "request_sha256": "'
            + "a" * 64
            + '", "provider_operation": "connected_product.create", '
            '"stripe_idempotency_key": "key-1"}, {"step_name": "price", '
            '"request_sha256": "' + "b" * 64 + '", "provider_operation": "connected_price.create", '
            '"stripe_idempotency_key": "key-2"}]'
        )
        assert (
            billing_provider_step_plan_sha256(steps)
            == hashlib.sha256(postgres_text.encode("utf-8")).hexdigest()
        )

    def _product_update_recovery(self, outcome, recovered_id=None, *, currency="eur"):
        plan = _plan(
            status="active",
            currency=currency,
            stripe_account_id="acct_1",
            stripe_product_id="prod_existing",
            stripe_price_id="price_existing",
        )
        facade = _Facade(_tables(plan))
        facade.supabase.tables["billing_plan_prices"] = [_price_row(currency=currency)]
        manager = BillingPlanManager(facade, stripe_service_cls=_Stripe)
        _Stripe.update_error = RuntimeError("lost update response")
        with pytest.raises(HTTPException):
            asyncio.run(manager.sync_plan("plan_1", "studio_1", "actor_1", "plan-recovery-key"))
        operation = next(iter(facade.supabase.billing_provider_operations.values()))
        context = BillingProviderOperationContext(
            operation["id"],
            "studio_1",
            "actor_1",
            "plan.sync",
            operation["caller_request_key"],
            operation["request_sha256"],
            "acct_1",
            1,
            str(operation["lease_owner"]),
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
        result = asyncio.run(
            manager.sync_plan("plan_1", "studio_1", "actor_1", "plan-recovery-key")
        )
        assert result.status == "active"
        assert _Stripe.updated_products == [first_payload, first_payload]
        assert operation["provider_request_attempt_count"] == 2
        assert operation["state"] == "completed"
        asyncio.run(manager.sync_plan("plan_1", "studio_1", "actor_1", "plan-recovery-key"))
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
            asyncio.run(manager.sync_plan("plan_1", "studio_1", "actor_1", "plan-recovery-key"))
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
        result = asyncio.run(
            manager.sync_plan("plan_1", "studio_1", "actor_1", "plan-recovery-key")
        )
        assert result.status == "active"
        assert len(_Stripe.updated_products) == 1
        assert _Stripe.retrieved_products == [
            {"account_id": "acct_1", "product_id": "prod_existing"}
        ]
        assert operation["provider_request_attempt_count"] == 1
        assert operation["state"] == "completed"

    @pytest.mark.parametrize("mismatch", ["id", "name", "metadata"])
    def test_product_reconcile_only_mismatch_returns_to_reconciliation(self, mismatch):
        facade, manager, operation, plan = self._product_update_recovery(
            "provider_succeeded_reconcile_only", "prod_existing"
        )
        response = {
            "id": "prod_existing",
            "name": plan["name"],
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
            asyncio.run(manager.sync_plan("plan_1", "studio_1", "actor_1", "plan-recovery-key"))
        assert len(_Stripe.updated_products) == 1
        assert operation["state"] == "reconciliation_required"
        assert facade.supabase.tables["audit_logs"] == []
