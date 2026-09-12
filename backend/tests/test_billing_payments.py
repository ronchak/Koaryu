from __future__ import annotations

import asyncio
from dataclasses import replace
import unittest
from datetime import datetime, timezone
from uuid import NAMESPACE_URL, uuid5

from fastapi import HTTPException
from postgrest.exceptions import APIError as PostgrestAPIError

from app.schemas.billing import BillingRefundCreate, ExportJobCreate, ExternalPaymentCreate
from app.services.billing_payments import (
    EXTERNAL_PAYMENT_IDEMPOTENCY_REQUIRED_DETAIL,
    EXTERNAL_PAYMENT_USD_ONLY_DETAIL,
    PAYER_EXTERNAL_PAYMENT_ONLY_DETAIL,
    BillingPaymentManager,
    build_external_payment_request_hash,
)
from app.services.billing_provider_operations import (
    BillingProviderOperationContext,
    BillingProviderOperationCoordinator,
)
from app.services.billing_connect_accounts import BillingConnectAccountStore
from app.services.platform_billing_helpers import MAX_IDEMPOTENCY_KEY_LENGTH
from app.services.stripe_mutation_policy import StripeMutationBlocked
from tests.fakes.billing_balance import BillingBalanceRpcMixin
from tests.fakes.billing_provider_operations import BillingProviderOperationRpcMixin
from tests.fakes.billing_reads import BillingReadRpcMixin
from tests.fakes.supabase import RpcBackedSupabase


def conflict_error() -> PostgrestAPIError:
    return PostgrestAPIError(
        {
            "code": "23505",
            "message": "duplicate key value violates unique constraint",
            "details": "",
            "hint": "",
        }
    )


def _dated_defaults(_table: str) -> dict:
    return {
        "created_at": "2026-01-01T00:00:00Z",
        "updated_at": "2026-01-01T00:00:00Z",
    }


class _BillingSupabase(
    BillingBalanceRpcMixin,
    BillingReadRpcMixin,
    BillingProviderOperationRpcMixin,
    RpcBackedSupabase,
):
    def __init__(self, tables):
        super().__init__(tables)
        self.initialize_billing_provider_operations()


class _BillingPaymentFixture:
    def __init__(self, tables: dict[str, list[dict]]):
        payment_accounts = {
            row.get("stripe_account_id")
            for row in tables.get("billing_payments", [])
            if row.get("stripe_account_id")
        }
        tables.setdefault(
            "studio_payment_accounts",
            [
                {
                    "studio_id": "studio_1",
                    "stripe_connected_account_id": account_id,
                    "charges_enabled": True,
                    "metadata": {"connect_account_generation": 1},
                }
                for account_id in sorted(payment_accounts)
            ],
        )
        for payment in tables.get("billing_payments", []):
            payment.setdefault("payer_id", "payer_1")
            if payment.get("stripe_account_id"):
                payment.setdefault("connect_account_generation", 1)
            if payment.get("stripe_charge_id"):
                payment.setdefault("status", "succeeded")
        self.supabase = _BillingSupabase(tables)
        for table in ("billing_payments", "billing_refunds", "export_jobs", "audit_logs"):
            self.supabase.insert_defaults[table] = _dated_defaults
        self.supabase.insert_defaults["billing_refunds"] = {
            "id": "refund_local",
            **_dated_defaults("billing_refunds"),
        }
        self.supabase.unique_constraints["billing_payments"] = [("studio_id", "idempotency_key")]
        self.supabase.unique_conflict_error_factory = lambda _table, _columns: conflict_error()
        self.balance_recomputes: list[tuple[str, str | None]] = []
        self.supabase.on_payer_balance_recompute = self._observe_balance_recompute
        self.connect_accounts = BillingConnectAccountStore(
            self.supabase,
            settings=None,
            stripe_service_cls=_FakeStripeService,
        )
        self.manager = BillingPaymentManager(
            self.supabase,
            self.connect_accounts,
            stripe_service_cls=_FakeStripeService,
        )

    def _observe_balance_recompute(self, params: dict) -> None:
        self.balance_recomputes.append((params["p_studio_id"], params["p_payer_id"]))


class _FakeStripeService:
    out_of_band_payments: list[dict] = []
    refunds: list[dict] = []
    pay_error: Exception | None = None
    refund_error: Exception | None = None
    refund_status = "succeeded"
    retrieved_refunds: list[dict] = []
    refund_response: dict | None = None

    @classmethod
    def reset(cls) -> None:
        cls.out_of_band_payments = []
        cls.refunds = []
        cls.pay_error = None
        cls.refund_error = None
        cls.refund_status = "succeeded"
        cls.retrieved_refunds = []
        cls.refund_response = None

    def pay_connected_invoice(self, **payload):
        self.__class__.out_of_band_payments.append(payload)
        if self.__class__.pay_error:
            raise self.__class__.pay_error
        return {"id": payload["invoice_id"]}

    def create_connected_refund(self, **payload):
        self.__class__.refunds.append(payload)
        if self.__class__.refund_error:
            raise self.__class__.refund_error
        return {
            "id": "re_created",
            "charge": payload["charge_id"],
            "amount": payload["amount"],
            "reason": payload.get("reason"),
            "status": self.__class__.refund_status,
            "metadata": payload["metadata"],
        }

    def retrieve_connected_refund(self, **payload):
        self.__class__.retrieved_refunds.append(dict(payload))
        return self.__class__.refund_response


class BillingPaymentManagerTests(unittest.TestCase):
    def _completed_refund_audit_fixture(self, *, refund_status="succeeded"):
        _FakeStripeService.reset()
        _FakeStripeService.refund_status = refund_status
        facade = _BillingPaymentFixture(
            {
                "billing_payments": [
                    {
                        "id": "payment_1",
                        "studio_id": "studio_1",
                        "stripe_charge_id": "ch_1",
                        "stripe_account_id": "acct_1",
                        "connect_account_generation": 1,
                        "amount_cents": 1200,
                        "refunded_amount_cents": 0,
                    }
                ],
                "audit_logs": [],
            }
        )
        manager = facade.manager
        data = BillingRefundCreate(amount_cents=500, reason="requested_by_customer")
        result = asyncio.run(
            manager.refund_payment(
                "payment_1",
                data,
                "studio_1",
                "actor_1",
                "refund-key",
            )
        )
        operation = next(iter(facade.supabase.billing_provider_operations.values()))
        payment = facade.supabase.tables["billing_payments"][0]
        refund = next(
            row
            for row in facade.supabase.tables["billing_refunds"]
            if row["stripe_refund_id"] == result.stripe_refund_id
        )
        context = BillingProviderOperationContext(
            operation["id"],
            "studio_1",
            "actor_1",
            "payment.refund",
            operation["caller_request_key"],
            operation["request_sha256"],
            "acct_1",
            1,
            str(operation["lease_owner"]),
        )
        audit = dict(facade.supabase.tables["audit_logs"][0])
        return facade, manager, payment, refund, data, operation, context, audit

    def test_completed_refund_replay_repairs_exactly_one_audit_without_provider_call(self):
        for refund_status, expected_action in (
            ("succeeded", "billing.payment_refunded"),
            ("requires_action", "billing.payment_refund_requested"),
        ):
            with self.subTest(refund_status=refund_status):
                _FakeStripeService.reset()
                _FakeStripeService.refund_status = refund_status
                facade = _BillingPaymentFixture(
                    {
                        "billing_payments": [
                            {
                                "id": "payment_1",
                                "studio_id": "studio_1",
                                "stripe_charge_id": "ch_1",
                                "stripe_account_id": "acct_1",
                                "connect_account_generation": 1,
                                "amount_cents": 1200,
                                "refunded_amount_cents": 0,
                            }
                        ],
                        "audit_logs": [],
                    }
                )
                manager = facade.manager
                data = BillingRefundCreate(amount_cents=500, reason="requested_by_customer")

                def fail_audit(table_name, _payloads, _rows):
                    if table_name == "audit_logs":
                        facade.supabase.before_insert = None
                        raise RuntimeError("transient audit failure")

                facade.supabase.before_insert = fail_audit
                with self.assertRaisesRegex(RuntimeError, "transient audit failure"):
                    asyncio.run(
                        manager.refund_payment(
                            "payment_1",
                            data,
                            "studio_1",
                            "actor_1",
                            "refund-key",
                        )
                    )
                operation = next(iter(facade.supabase.billing_provider_operations.values()))
                self.assertEqual(operation["state"], "completed")
                self.assertEqual(facade.supabase.tables["audit_logs"], [])
                asyncio.run(
                    manager.refund_payment(
                        "payment_1",
                        data,
                        "studio_1",
                        "actor_1",
                        "refund-key",
                    )
                )
                asyncio.run(
                    manager.refund_payment(
                        "payment_1",
                        data,
                        "studio_1",
                        "actor_1",
                        "refund-key",
                    )
                )
                self.assertEqual(len(_FakeStripeService.refunds), 1)
                self.assertEqual(_FakeStripeService.retrieved_refunds, [])
                self.assertEqual(len(facade.supabase.tables["audit_logs"]), 1)
                self.assertEqual(
                    facade.supabase.tables["audit_logs"][0]["action"],
                    expected_action,
                )

    def test_refund_audit_repair_rejects_every_context_falsifier_without_provider(self):
        facade, manager, payment, refund, data, operation, context, _audit = (
            self._completed_refund_audit_fixture()
        )
        facade.supabase.tables["audit_logs"] = []
        _FakeStripeService.reset()
        cases = (
            ("payment", {**payment, "id": "payment_other"}, refund, data, operation, context),
            ("studio", {**payment, "studio_id": "studio_other"}, refund, data, operation, context),
            (
                "payment_account",
                {**payment, "stripe_account_id": "acct_other"},
                refund,
                data,
                operation,
                context,
            ),
            (
                "payment_generation",
                {**payment, "connect_account_generation": 2},
                refund,
                data,
                operation,
                context,
            ),
            (
                "refund",
                payment,
                {**refund, "stripe_refund_id": "re_other"},
                data,
                operation,
                context,
            ),
            ("operation", payment, refund, data, {**operation, "id": "operation_other"}, context),
            (
                "operation_actor",
                payment,
                refund,
                data,
                {**operation, "actor_id": "actor_other"},
                context,
            ),
            (
                "operation_request",
                payment,
                refund,
                data,
                {**operation, "request_sha256": "f" * 64},
                context,
            ),
            (
                "operation_account",
                payment,
                refund,
                data,
                {**operation, "stripe_connected_account_id": "acct_other"},
                context,
            ),
            (
                "operation_generation",
                payment,
                refund,
                data,
                {**operation, "connect_account_generation": 2},
                context,
            ),
            (
                "provider_result",
                payment,
                refund,
                data,
                {**operation, "provider_object_id": "re_other"},
                context,
            ),
            ("precompletion", payment, refund, data, {**operation, "state": "projected"}, context),
            (
                "context_actor",
                payment,
                refund,
                data,
                operation,
                replace(context, actor_id="actor_other"),
            ),
            (
                "context_request",
                payment,
                refund,
                data,
                operation,
                replace(context, request_sha256="f" * 64),
            ),
            (
                "context_account",
                payment,
                refund,
                data,
                operation,
                replace(context, stripe_connected_account_id="acct_other"),
            ),
            (
                "context_generation",
                payment,
                refund,
                data,
                operation,
                replace(context, connect_account_generation=2),
            ),
            (
                "request_amount",
                payment,
                refund,
                BillingRefundCreate(amount_cents=600),
                operation,
                context,
            ),
            (
                "request_reason",
                payment,
                refund,
                BillingRefundCreate(amount_cents=500, reason="duplicate"),
                operation,
                context,
            ),
        )
        for label, bad_payment, bad_refund, bad_data, bad_operation, bad_context in cases:
            with self.subTest(label=label):
                with self.assertRaisesRegex(
                    RuntimeError,
                    "payment_refund_audit_identity_mismatch|payment_refund_saved_amount_invalid|payment_refund_projection",
                ):
                    manager._ensure_refund_audit(
                        payment=bad_payment,
                        refund=bad_refund,
                        data=bad_data,
                        amount=500,
                        operation=bad_operation,
                        context=bad_context,
                    )
                self.assertEqual(facade.supabase.tables["audit_logs"], [])
        self.assertEqual(_FakeStripeService.refunds, [])
        self.assertEqual(_FakeStripeService.retrieved_refunds, [])

    def test_refund_audit_id_only_validation_and_bounded_23505_reread(self):
        for winner_kind in ("exact", "wrong_studio", "malformed", "missing"):
            with self.subTest(winner_kind=winner_kind):
                facade, manager, payment, refund, data, operation, context, exact = (
                    self._completed_refund_audit_fixture()
                )
                facade.supabase.tables["audit_logs"] = []
                facade.supabase.query_log = []
                _FakeStripeService.reset()

                def lose_insert(table_name, _payloads, rows):
                    if table_name != "audit_logs":
                        return
                    facade.supabase.before_insert = None
                    if winner_kind == "exact":
                        rows.append(dict(exact))
                    elif winner_kind == "wrong_studio":
                        rows.append({**exact, "studio_id": "studio_other"})
                    elif winner_kind == "malformed":
                        rows.append({**exact, "metadata": {}})
                    raise conflict_error()

                facade.supabase.before_insert = lose_insert
                if winner_kind == "exact":
                    manager._ensure_refund_audit(
                        payment=payment,
                        refund=refund,
                        data=data,
                        amount=500,
                        operation=operation,
                        context=context,
                    )
                else:
                    with self.assertRaisesRegex(
                        RuntimeError, "payment_refund_audit_conflict_unverified"
                    ):
                        manager._ensure_refund_audit(
                            payment=payment,
                            refund=refund,
                            data=data,
                            amount=500,
                            operation=operation,
                            context=context,
                        )
                audit_queries = [
                    entry for entry in facade.supabase.query_log if entry["table"] == "audit_logs"
                ]
                expected_id = str(
                    uuid5(
                        NAMESPACE_URL,
                        f"koaryu:billing.payment_refunded:{operation['id']}",
                    )
                )
                self.assertEqual(sum(entry["insert"] is not None for entry in audit_queries), 1)
                reads = [entry for entry in audit_queries if entry["columns"] == "*"]
                self.assertEqual(len(reads), 3)
                id_reads = [
                    entry for entry in reads if entry["filters"] == (("eq", "id", expected_id),)
                ]
                self.assertEqual(len(id_reads), 2)
                self.assertTrue(
                    all(entry["filters"] == (("eq", "id", expected_id),) for entry in id_reads)
                )
                self.assertEqual(_FakeStripeService.refunds, [])
                self.assertEqual(_FakeStripeService.retrieved_refunds, [])

    def test_refund_audit_rejects_each_malformed_preexisting_field(self):
        facade, manager, payment, refund, data, operation, context, exact = (
            self._completed_refund_audit_fixture()
        )
        _FakeStripeService.reset()
        malformed_rows = (
            {**exact, "studio_id": "studio_other"},
            {**exact, "actor_id": "actor_other"},
            {**exact, "action": "billing.payment_refund_requested"},
            {**exact, "entity_type": "payment"},
            {**exact, "entity_id": "payment_other"},
            {**exact, "metadata": {}},
        )
        for malformed in malformed_rows:
            with self.subTest(
                field=next(key for key in malformed if malformed.get(key) != exact.get(key))
            ):
                facade.supabase.tables["audit_logs"] = [malformed]
                with self.assertRaisesRegex(RuntimeError, "payment_refund_audit_identity_mismatch"):
                    manager._ensure_refund_audit(
                        payment=payment,
                        refund=refund,
                        data=data,
                        amount=500,
                        operation=operation,
                        context=context,
                    )
        self.assertEqual(_FakeStripeService.refunds, [])
        self.assertEqual(_FakeStripeService.retrieved_refunds, [])

    def test_refund_legacy_audit_is_exact_bounded_and_prevents_duplicate(self):
        facade, manager, payment, refund, data, operation, context, exact = (
            self._completed_refund_audit_fixture()
        )
        legacy = {
            **exact,
            "id": "00000000-0000-4000-8000-000000007001",
            "metadata->>operation_id": operation["id"],
        }
        facade.supabase.tables["audit_logs"] = [legacy]
        facade.supabase.query_log = []
        _FakeStripeService.reset()
        manager._ensure_refund_audit(
            payment=payment,
            refund=refund,
            data=data,
            amount=500,
            operation=operation,
            context=context,
        )
        self.assertEqual(facade.supabase.tables["audit_logs"], [legacy])
        self.assertFalse(
            any(
                entry["insert"] is not None
                for entry in facade.supabase.query_log
                if entry["table"] == "audit_logs"
            )
        )
        self.assertEqual(_FakeStripeService.refunds, [])
        self.assertEqual(_FakeStripeService.retrieved_refunds, [])

        for label, rows, expected_error in (
            (
                "duplicate",
                [legacy, {**legacy, "id": "00000000-0000-4000-8000-000000007002"}],
                "ambiguous",
            ),
            ("actor", [{**legacy, "actor_id": "actor_other"}], "identity_mismatch"),
            (
                "metadata",
                [{**legacy, "metadata": {"operation_id": operation["id"]}}],
                "identity_mismatch",
            ),
        ):
            with self.subTest(label=label):
                facade.supabase.tables["audit_logs"] = rows
                with self.assertRaisesRegex(RuntimeError, expected_error):
                    manager._ensure_refund_audit(
                        payment=payment,
                        refund=refund,
                        data=data,
                        amount=500,
                        operation=operation,
                        context=context,
                    )

        for label, unrelated in (
            (
                "operation",
                {
                    **legacy,
                    "metadata": {**legacy["metadata"], "operation_id": "operation_other"},
                    "metadata->>operation_id": "operation_other",
                },
            ),
            ("resource", {**legacy, "entity_id": "payment_other"}),
            ("studio", {**legacy, "studio_id": "studio_other"}),
        ):
            with self.subTest(label=label):
                facade.supabase.tables["audit_logs"] = [unrelated]
                manager._ensure_refund_audit(
                    payment=payment,
                    refund=refund,
                    data=data,
                    amount=500,
                    operation=operation,
                    context=context,
                )
                self.assertEqual(len(facade.supabase.tables["audit_logs"]), 2)

        unrelated = [
            {
                **legacy,
                "id": f"00000000-0000-4000-8000-{index:012d}",
                "actor_id": None,
                "metadata": {},
                "metadata->>operation_id": f"operation_{index}",
            }
            for index in range(80)
        ]
        facade.supabase.tables["audit_logs"] = [*unrelated, legacy]
        facade.supabase.query_log = []
        manager._ensure_refund_audit(
            payment=payment,
            refund=refund,
            data=data,
            amount=500,
            operation=operation,
            context=context,
        )
        self.assertEqual(len(facade.supabase.tables["audit_logs"]), 81)
        legacy_query = next(
            entry
            for entry in facade.supabase.query_log
            if entry["table"] == "audit_logs"
            and any(key == "metadata->>operation_id" for _op, key, _value in entry["filters"])
        )
        self.assertEqual(legacy_query["limit"], 2)
        self.assertIn(
            ("eq", "metadata->>operation_id", operation["id"]),
            legacy_query["filters"],
        )

        facade.supabase.tables["audit_logs"] = unrelated
        manager._ensure_refund_audit(
            payment=payment,
            refund=refund,
            data=data,
            amount=500,
            operation=operation,
            context=context,
        )
        self.assertEqual(len(facade.supabase.tables["audit_logs"]), 81)

    def test_current_month_cohort_summary_is_complete_beyond_list_limit(self):
        current_rows = [
            {
                "id": f"payment_{index}",
                "studio_id": "studio_1",
                "status": "succeeded",
                "amount_cents": 100,
                "refunded_amount_cents": 0,
                "processed_at": "2026-07-15T12:00:00+00:00",
            }
            for index in range(205)
        ]
        current_rows.extend(
            [
                {
                    "id": "payment_partial_refund",
                    "studio_id": "studio_1",
                    "status": "disputed",
                    "amount_cents": 1000,
                    "refunded_amount_cents": 400,
                    "disputed_amount_cents": 200,
                    "net_collected_amount_cents": 400,
                    "processed_at": "2026-07-16T12:00:00+00:00",
                },
                {
                    "id": "payment_external",
                    "studio_id": "studio_1",
                    "status": "externally_recorded",
                    "amount_cents": 500,
                    "refunded_amount_cents": 0,
                    "processed_at": "2026-07-31T23:59:59+00:00",
                },
                {
                    "id": "payment_prior_month_refunded_now",
                    "studio_id": "studio_1",
                    "status": "refunded",
                    "amount_cents": 900,
                    "refunded_amount_cents": 900,
                    "processed_at": "2026-06-30T23:59:59+00:00",
                },
                {
                    "id": "payment_other_studio",
                    "studio_id": "studio_2",
                    "status": "succeeded",
                    "amount_cents": 99999,
                    "refunded_amount_cents": 0,
                    "processed_at": "2026-07-15T12:00:00+00:00",
                },
            ]
        )
        fixture = _BillingPaymentFixture({"billing_payments": current_rows})
        manager = fixture.manager

        summary = asyncio.run(
            manager.current_month_payment_cohort_summary(
                "studio_1",
                as_of=datetime(2026, 7, 20, tzinfo=timezone.utc),
            )
        )

        self.assertEqual(
            [name for name, _ in manager.supabase.rpc_calls], ["billing_payment_cohort"]
        )
        self.assertFalse(
            any(query["table"] == "billing_payments" for query in manager.supabase.query_log)
        )
        self.assertEqual(summary.payment_count, 207)
        self.assertEqual(summary.gross_paid_amount_cents, 22000)
        self.assertEqual(summary.refunded_amount_cents, 400)
        self.assertEqual(summary.disputed_amount_cents, 200)
        self.assertEqual(summary.stripe_net_amount_cents, 20900)
        self.assertEqual(summary.external_net_amount_cents, 500)
        self.assertEqual(summary.net_amount_cents, 21400)
        self.assertEqual(summary.period_start, "2026-07-01T00:00:00+00:00")
        self.assertEqual(summary.period_end, "2026-08-01T00:00:00+00:00")
        self.assertIn("provider-confirmed refunds", summary.disclosure)
        self.assertIn("not cash movement or recognized revenue", summary.disclosure)

    def test_external_payment_preserves_legacy_request_bytes_and_uses_atomic_rpc(self):
        payload = ExternalPaymentCreate(
            payer_id="payer_1",
            amount_cents=500,
            external_method="cash",
            note="Guest's class — paid",
        )
        self.assertEqual(
            build_external_payment_request_hash(payload, effective_payer_id="payer_1"),
            "5c962180b754669afcfb875eede42df081d7c9bcbd164ba7bd7bdea0a1a45403",
        )
        returned = {
            **payload.model_dump(),
            **_dated_defaults("billing_payments"),
            "id": "payment_1",
            "studio_id": "studio_1",
            "status": "externally_recorded",
            "payment_method_type": "external",
            "net_collected_amount_cents": 500,
            "refundable_amount_cents": 0,
            "processed_at": "2026-01-01T00:00:00Z",
        }
        facade = _BillingPaymentFixture({})
        facade.supabase._rpc_record_external_payment_v1 = lambda _params: returned
        manager = facade.manager
        result = asyncio.run(
            manager.record_external_payment(payload, "studio_1", "actor_1", " payment-key ")
        )
        self.assertEqual(result.id, "payment_1")
        self.assertEqual(result.note, payload.note)
        self.assertEqual(
            facade.supabase.rpc_calls,
            [
                (
                    "record_external_payment_v1",
                    {
                        "p_studio_id": "studio_1",
                        "p_actor_id": "actor_1",
                        "p_payer_id": "payer_1",
                        "p_amount_cents": 500,
                        "p_currency": "usd",
                        "p_external_method": "cash",
                        "p_note": "Guest's class — paid",
                        "p_idempotency_key": "payment-key",
                        "p_request_hash": "5c962180b754669afcfb875eede42df081d7c9bcbd164ba7bd7bdea0a1a45403",
                    },
                ),
                (
                    "recompute_billing_payer_balance_v1",
                    {
                        "p_studio_id": "studio_1",
                        "p_payer_id": "payer_1",
                    },
                ),
            ],
        )
        self.assertEqual(
            facade.supabase.query_log, [], "No split payment or audit writes outside the RPC"
        )
        self.assertEqual(facade.balance_recomputes, [("studio_1", "payer_1")])

    def test_external_payment_enforces_supported_target_and_key_before_io(self):
        for fields, key, expected_status, detail in [
            ({}, "key", 409, PAYER_EXTERNAL_PAYMENT_ONLY_DETAIL),
            ({"invoice_id": "invoice_1"}, "key", 409, PAYER_EXTERNAL_PAYMENT_ONLY_DETAIL),
            (
                {"payer_id": "payer_1", "invoice_id": "invoice_1"},
                "key",
                409,
                PAYER_EXTERNAL_PAYMENT_ONLY_DETAIL,
            ),
            ({"payer_id": "payer_1"}, None, 400, EXTERNAL_PAYMENT_IDEMPOTENCY_REQUIRED_DETAIL),
        ]:
            with self.subTest(fields=fields, key=key):
                facade = _BillingPaymentFixture({})
                with self.assertRaises(HTTPException) as failure:
                    asyncio.run(
                        facade.manager.record_external_payment(
                            ExternalPaymentCreate(
                                amount_cents=500, external_method="cash", **fields
                            ),
                            "studio_1",
                            "actor_1",
                            key,
                        )
                    )
                self.assertEqual(
                    (failure.exception.status_code, failure.exception.detail),
                    (expected_status, detail),
                )
                self.assertEqual(facade.supabase.rpc_calls, [])
                self.assertEqual(facade.supabase.query_log, [])

    def test_external_payment_retries_balance_completion_without_rewriting_payment(self):
        payload = ExternalPaymentCreate(
            payer_id="payer_1", amount_cents=500, currency="eur", external_method="cash"
        )
        returned = {
            **payload.model_dump(),
            **_dated_defaults("billing_payments"),
            "id": "legacy_payment",
            "studio_id": "studio_1",
            "status": "externally_recorded",
            "payment_method_type": "external",
            "processed_at": "2026-01-01T00:00:00Z",
        }
        facade = _BillingPaymentFixture({})
        facade.supabase._rpc_record_external_payment_v1 = lambda _params: returned

        def recompute(params):
            facade._observe_balance_recompute(params)
            if len(facade.balance_recomputes) == 1:
                raise RuntimeError("balance refresh failed after confirmation")

        facade.supabase.on_payer_balance_recompute = recompute
        manager = facade.manager
        with self.assertRaisesRegex(RuntimeError, "balance refresh failed"):
            asyncio.run(
                manager.record_external_payment(payload, "studio_1", "actor_1", "original-key")
            )
        result = asyncio.run(
            manager.record_external_payment(payload, "studio_1", "actor_2", "original-key")
        )
        self.assertEqual(
            (result.id, result.currency, result.processed_at),
            ("legacy_payment", "eur", "2026-01-01T00:00:00Z"),
        )
        self.assertEqual(
            [name for name, _params in facade.supabase.rpc_calls],
            [
                "record_external_payment_v1",
                "recompute_billing_payer_balance_v1",
                "record_external_payment_v1",
                "recompute_billing_payer_balance_v1",
            ],
        )
        (_, first), (_, first_balance), (_, retry), (_, retry_balance) = facade.supabase.rpc_calls
        self.assertEqual(retry, {**first, "p_actor_id": "actor_2"})
        self.assertEqual(
            first_balance,
            {"p_studio_id": "studio_1", "p_payer_id": "payer_1"},
        )
        self.assertEqual(retry_balance, first_balance)
        self.assertEqual(facade.balance_recomputes, [("studio_1", "payer_1")] * 2)
        self.assertEqual(facade.supabase.query_log, [])

    def test_external_payment_rpc_rejections_and_unknown_outcomes_do_not_fall_back(self):
        for code, message, expected_status in [
            ("P0001", "external_payment_request_conflict", 409),
            ("22023", "external_payment_requires_usd", 400),
            ("P0002", "external_payment_payer_not_found", 404),
            ("40001", "external_payment_retry_required", None),
        ]:
            with self.subTest(message=message):
                facade = _BillingPaymentFixture({})
                error = PostgrestAPIError(
                    {"code": code, "message": message, "details": "", "hint": ""}
                )

                def reject(_params):
                    raise error

                facade.supabase._rpc_record_external_payment_v1 = reject
                with self.assertRaises(
                    HTTPException if expected_status else PostgrestAPIError
                ) as failure:
                    asyncio.run(
                        facade.manager.record_external_payment(
                            ExternalPaymentCreate(
                                payer_id="payer_1", amount_cents=500, external_method="cash"
                            ),
                            "studio_1",
                            "actor_1",
                            "key",
                        )
                    )
                if expected_status:
                    self.assertEqual(failure.exception.status_code, expected_status)
                if message == "external_payment_requires_usd":
                    self.assertEqual(failure.exception.detail, EXTERNAL_PAYMENT_USD_ONLY_DETAIL)
                self.assertEqual(
                    [name for name, _params in facade.supabase.rpc_calls],
                    ["record_external_payment_v1"],
                )
                self.assertEqual(facade.balance_recomputes, [])
                self.assertEqual(facade.supabase.query_log, [])
        facade = _BillingPaymentFixture({})
        facade.supabase._rpc_record_external_payment_v1 = lambda _params: None
        with self.assertRaises(HTTPException) as failure:
            asyncio.run(
                facade.manager.record_external_payment(
                    ExternalPaymentCreate(
                        payer_id="payer_1", amount_cents=500, external_method="cash"
                    ),
                    "studio_1",
                    "actor_1",
                    "key",
                )
            )
        self.assertEqual(failure.exception.status_code, 500)
        self.assertEqual(
            [name for name, _params in facade.supabase.rpc_calls],
            ["record_external_payment_v1"],
        )
        self.assertEqual(facade.balance_recomputes, [])

    def test_refund_payment_uses_injected_stripe_and_projection_delegate(self):
        _FakeStripeService.reset()
        facade = _BillingPaymentFixture(
            {
                "billing_payments": [
                    {
                        "id": "payment_1",
                        "studio_id": "studio_1",
                        "stripe_charge_id": "ch_1",
                        "stripe_account_id": "acct_1",
                        "amount_cents": 1200,
                        "refunded_amount_cents": 200,
                    }
                ]
            }
        )
        manager = facade.manager

        refund = asyncio.run(
            manager.refund_payment(
                "payment_1",
                BillingRefundCreate(reason="requested_by_customer"),
                "studio_1",
                "actor_1",
                "refund-key-1",
            )
        )

        self.assertEqual(refund.amount_cents, 1000)
        self.assertEqual(refund.stripe_refund_id, "re_created")
        self.assertEqual(
            _FakeStripeService.refunds[0]["idempotency_key"],
            "koaryu:payment-refund:00000000-0000-4000-8000-000000009001",
        )
        self.assertFalse(_FakeStripeService.refunds[0]["refund_application_fee"])
        self.assertEqual(
            facade.supabase.tables["audit_logs"][0]["action"], "billing.payment_refunded"
        )

    def test_refund_payment_refunds_application_fee_only_when_positive(self):
        for application_fee_amount_cents, expected in ((0, False), (6, True)):
            with self.subTest(application_fee_amount_cents=application_fee_amount_cents):
                _FakeStripeService.reset()
                facade = _BillingPaymentFixture(
                    {
                        "billing_payments": [
                            {
                                "id": "payment_1",
                                "studio_id": "studio_1",
                                "stripe_charge_id": "ch_1",
                                "stripe_account_id": "acct_1",
                                "amount_cents": 1200,
                                "refunded_amount_cents": 0,
                                "application_fee_amount_cents": application_fee_amount_cents,
                            }
                        ]
                    }
                )
                manager = facade.manager

                asyncio.run(
                    manager.refund_payment(
                        "payment_1",
                        BillingRefundCreate(
                            amount_cents=500,
                            reason="requested_by_customer",
                        ),
                        "studio_1",
                        "actor_1",
                        f"refund-key-fee-{application_fee_amount_cents}",
                    )
                )

                self.assertEqual(len(_FakeStripeService.refunds), 1)
                self.assertIs(
                    _FakeStripeService.refunds[0]["refund_application_fee"],
                    expected,
                )

    def test_pending_refund_audits_request_without_claiming_money_returned(self):
        _FakeStripeService.reset()
        _FakeStripeService.refund_status = "pending"
        facade = _BillingPaymentFixture(
            {
                "billing_payments": [
                    {
                        "id": "payment_1",
                        "studio_id": "studio_1",
                        "stripe_account_id": "acct_1",
                        "stripe_charge_id": "ch_1",
                        "amount_cents": 1200,
                        "refunded_amount_cents": 0,
                        "status": "succeeded",
                    }
                ],
            }
        )
        manager = facade.manager

        refund = asyncio.run(
            manager.refund_payment(
                "payment_1",
                BillingRefundCreate(amount_cents=1000),
                "studio_1",
                "actor_1",
                "refund-key-pending",
            )
        )

        self.assertEqual(refund.status, "pending")
        audit = facade.supabase.tables["audit_logs"][0]
        self.assertEqual(audit["action"], "billing.payment_refund_requested")
        self.assertEqual(audit["metadata"]["status"], "pending")

    def test_refund_payment_requires_canonical_request_idempotency_key(self):
        for key in (None, "é" * 128):
            with self.subTest(key=key):
                facade = _BillingPaymentFixture(
                    {
                        "billing_payments": [
                            {
                                "id": "payment_1",
                                "studio_id": "studio_1",
                                "stripe_charge_id": "ch_1",
                                "stripe_account_id": "acct_1",
                                "amount_cents": 1200,
                                "refunded_amount_cents": 0,
                            }
                        ]
                    }
                )
                manager = facade.manager

                with self.assertRaises(HTTPException) as context:
                    asyncio.run(
                        manager.refund_payment(
                            "payment_1",
                            BillingRefundCreate(amount_cents=500),
                            "studio_1",
                            "actor_1",
                            key,
                        )
                    )

                self.assertEqual(context.exception.status_code, 400)
                self.assertEqual(facade.supabase.billing_provider_operations, {})

    def test_invalid_refund_reason_does_not_claim_payment_or_block_later_valid_request(self):
        _FakeStripeService.reset()
        facade = _BillingPaymentFixture(
            {
                "billing_payments": [
                    {
                        "id": "payment_1",
                        "studio_id": "studio_1",
                        "stripe_charge_id": "ch_1",
                        "stripe_account_id": "acct_1",
                        "amount_cents": 1200,
                        "refunded_amount_cents": 0,
                    }
                ]
            }
        )
        manager = facade.manager

        invalid_payload = BillingRefundCreate.model_construct(
            amount_cents=500,
            reason="expired_uncaptured_charge",
        )
        with self.assertRaises(HTTPException) as invalid:
            asyncio.run(
                manager.refund_payment(
                    "payment_1",
                    invalid_payload,
                    "studio_1",
                    "actor_1",
                    "refund-key-invalid",
                )
            )

        self.assertEqual(invalid.exception.status_code, 400)
        self.assertEqual(facade.supabase.billing_provider_operations, {})
        self.assertEqual(_FakeStripeService.refunds, [])

        refund = asyncio.run(
            manager.refund_payment(
                "payment_1",
                BillingRefundCreate(amount_cents=500, reason="requested_by_customer"),
                "studio_1",
                "actor_1",
                "refund-key-valid",
            )
        )

        self.assertEqual(refund.status, "succeeded")
        self.assertEqual(len(facade.supabase.billing_provider_operations), 1)
        self.assertEqual(len(_FakeStripeService.refunds), 1)
        self.assertEqual(_FakeStripeService.refunds[0]["reason"], "requested_by_customer")

    def test_refund_payment_rejects_amount_above_refundable_balance_before_stripe(self):
        _FakeStripeService.reset()
        facade = _BillingPaymentFixture(
            {
                "billing_payments": [
                    {
                        "id": "payment_1",
                        "studio_id": "studio_1",
                        "stripe_charge_id": "ch_1",
                        "stripe_account_id": "acct_1",
                        "amount_cents": 1200,
                        "refunded_amount_cents": 1000,
                    }
                ]
            }
        )
        manager = facade.manager

        with self.assertRaises(HTTPException) as context:
            asyncio.run(
                manager.refund_payment(
                    "payment_1",
                    BillingRefundCreate(amount_cents=500),
                    "studio_1",
                    "actor_1",
                    "refund-key-1",
                )
            )

        self.assertEqual(context.exception.status_code, 409)
        self.assertIn("exceeds", context.exception.detail)
        self.assertEqual(_FakeStripeService.refunds, [])
        operation = next(iter(facade.supabase.billing_provider_operations.values()))
        self.assertEqual(operation["state"], "definitive_rejected")
        self.assertEqual(operation["provider_request_attempt_count"], 0)

    def test_same_amount_refunds_use_caller_idempotency_to_distinguish_operations(self):
        _FakeStripeService.reset()
        facade = _BillingPaymentFixture(
            {
                "billing_payments": [
                    {
                        "id": "payment_1",
                        "studio_id": "studio_1",
                        "stripe_charge_id": "ch_1",
                        "stripe_account_id": "acct_1",
                        "amount_cents": 1200,
                        "refunded_amount_cents": 0,
                    }
                ]
            }
        )
        manager = facade.manager
        payload = BillingRefundCreate(amount_cents=500)

        asyncio.run(
            manager.refund_payment("payment_1", payload, "studio_1", "actor_1", "refund-key-1")
        )
        payment = facade.supabase.tables["billing_payments"][0]
        payment["refunded_amount_cents"] = 500
        payment["refundable_amount_cents"] = 700
        asyncio.run(
            manager.refund_payment("payment_1", payload, "studio_1", "actor_1", "refund-key-2")
        )
        asyncio.run(
            manager.refund_payment("payment_1", payload, "studio_1", "actor_1", "refund-key-1")
        )

        self.assertEqual(
            [refund["idempotency_key"] for refund in _FakeStripeService.refunds],
            [
                "koaryu:payment-refund:00000000-0000-4000-8000-000000009001",
                "koaryu:payment-refund:00000000-0000-4000-8000-000000009002",
            ],
        )
        self.assertEqual(len(facade.supabase.tables["audit_logs"]), 2)

    def test_refund_same_key_different_hash_conflicts_without_second_provider_call(self):
        _FakeStripeService.reset()
        facade = _BillingPaymentFixture(
            {
                "billing_payments": [
                    {
                        "id": "payment_1",
                        "studio_id": "studio_1",
                        "stripe_charge_id": "ch_1",
                        "stripe_account_id": "acct_1",
                        "amount_cents": 1200,
                        "refunded_amount_cents": 0,
                    }
                ],
                "audit_logs": [],
            }
        )
        manager = facade.manager

        asyncio.run(
            manager.refund_payment(
                "payment_1",
                BillingRefundCreate(amount_cents=500),
                "studio_1",
                "actor_1",
                "refund-key",
            )
        )
        with self.assertRaises(HTTPException) as conflict:
            asyncio.run(
                manager.refund_payment(
                    "payment_1",
                    BillingRefundCreate(amount_cents=600),
                    "studio_1",
                    "actor_1",
                    "refund-key",
                )
            )

        self.assertEqual(conflict.exception.status_code, 409)
        self.assertEqual(len(_FakeStripeService.refunds), 1)
        self.assertEqual(len(facade.supabase.tables["audit_logs"]), 1)

    def test_new_refund_key_waits_while_prior_refund_is_unsettled(self):
        _FakeStripeService.reset()
        _FakeStripeService.refund_status = "pending"
        facade = _BillingPaymentFixture(
            {
                "billing_payments": [
                    {
                        "id": "payment_1",
                        "studio_id": "studio_1",
                        "stripe_charge_id": "ch_1",
                        "stripe_account_id": "acct_1",
                        "amount_cents": 1200,
                        "refunded_amount_cents": 0,
                    }
                ],
                "audit_logs": [],
            }
        )
        manager = facade.manager
        payload = BillingRefundCreate(amount_cents=500)

        first = asyncio.run(
            manager.refund_payment(
                "payment_1",
                payload,
                "studio_1",
                "actor_1",
                "refund-key-1",
            )
        )
        replay = asyncio.run(
            manager.refund_payment(
                "payment_1",
                payload,
                "studio_1",
                "actor_1",
                "refund-key-1",
            )
        )
        with self.assertRaises(HTTPException) as unsettled:
            asyncio.run(
                manager.refund_payment(
                    "payment_1",
                    payload,
                    "studio_1",
                    "actor_1",
                    "refund-key-2",
                )
            )

        self.assertEqual(first.status, "pending")
        self.assertEqual(replay.stripe_refund_id, first.stripe_refund_id)
        self.assertEqual(unsettled.exception.status_code, 409)
        self.assertIn("still settling", unsettled.exception.detail)
        self.assertEqual(len(_FakeStripeService.refunds), 1)
        self.assertEqual(len(facade.supabase.tables["audit_logs"]), 1)

    def test_new_refund_key_replaces_projected_failed_refund_owner(self):
        _FakeStripeService.reset()
        _FakeStripeService.refund_status = "failed"
        facade = _BillingPaymentFixture(
            {
                "billing_payments": [
                    {
                        "id": "payment_1",
                        "studio_id": "studio_1",
                        "stripe_charge_id": "ch_1",
                        "stripe_account_id": "acct_1",
                        "amount_cents": 1200,
                        "refunded_amount_cents": 0,
                    }
                ],
                "audit_logs": [],
            }
        )
        manager = facade.manager
        payload = BillingRefundCreate(amount_cents=500)

        first = asyncio.run(
            manager.refund_payment(
                "payment_1",
                payload,
                "studio_1",
                "actor_1",
                "refund-key-1",
            )
        )
        second = asyncio.run(
            manager.refund_payment(
                "payment_1",
                payload,
                "studio_1",
                "actor_1",
                "refund-key-2",
            )
        )

        self.assertEqual(first.status, "failed")
        self.assertEqual(second.status, "failed")
        self.assertEqual(len(_FakeStripeService.refunds), 2)
        self.assertEqual(len(facade.supabase.billing_provider_operations), 2)

    def test_different_refund_keys_use_parent_state_without_payment_metadata_receipts(self):
        _FakeStripeService.reset()
        original_metadata = {"support_note": "keep"}
        facade = _BillingPaymentFixture(
            {
                "billing_payments": [
                    {
                        "id": "payment_1",
                        "studio_id": "studio_1",
                        "stripe_charge_id": "ch_1",
                        "stripe_account_id": "acct_1",
                        "amount_cents": 1200,
                        "refunded_amount_cents": 0,
                        "metadata": dict(original_metadata),
                    }
                ],
                "audit_logs": [],
            }
        )
        manager = facade.manager

        asyncio.run(
            manager.refund_payment(
                "payment_1",
                BillingRefundCreate(amount_cents=400),
                "studio_1",
                "actor_1",
                "refund-key-1",
            )
        )
        payment = facade.supabase.tables["billing_payments"][0]
        payment["refunded_amount_cents"] = 400
        payment["refundable_amount_cents"] = 800
        asyncio.run(
            manager.refund_payment(
                "payment_1",
                BillingRefundCreate(amount_cents=500),
                "studio_1",
                "actor_1",
                "refund-key-2",
            )
        )

        self.assertEqual(
            facade.supabase.tables["billing_payments"][0]["metadata"],
            original_metadata,
        )
        operations = list(facade.supabase.billing_provider_operations.values())
        self.assertEqual(
            [operation["result_summary"] for operation in operations],
            ["amount_cents:400", "amount_cents:500"],
        )
        self.assertEqual(len(_FakeStripeService.refunds), 2)

    def test_omitted_refund_amount_replays_parent_amount_after_payment_totals_change(self):
        _FakeStripeService.reset()
        facade = _BillingPaymentFixture(
            {
                "billing_payments": [
                    {
                        "id": "payment_1",
                        "studio_id": "studio_1",
                        "stripe_charge_id": "ch_1",
                        "stripe_account_id": "acct_1",
                        "amount_cents": 1200,
                        "refunded_amount_cents": 0,
                        "refundable_amount_cents": 1200,
                        "metadata": {"support_note": "keep"},
                    }
                ],
                "audit_logs": [],
            }
        )
        manager = facade.manager

        first = asyncio.run(
            manager.refund_payment(
                "payment_1",
                BillingRefundCreate(),
                "studio_1",
                "actor_1",
                "refund-key",
            )
        )
        payment = facade.supabase.tables["billing_payments"][0]
        payment["refunded_amount_cents"] = 1200
        payment["refundable_amount_cents"] = 0
        replay = asyncio.run(
            manager.refund_payment(
                "payment_1",
                BillingRefundCreate(),
                "studio_1",
                "actor_1",
                "refund-key",
            )
        )

        self.assertEqual(first.amount_cents, 1200)
        self.assertEqual(replay.amount_cents, 1200)
        self.assertEqual(len(_FakeStripeService.refunds), 1)
        operation = next(iter(facade.supabase.billing_provider_operations.values()))
        self.assertEqual(operation["result_summary"], "amount_cents:1200")
        self.assertEqual(payment["metadata"], {"support_note": "keep"})

    def test_refund_provider_success_local_failure_requires_reconciliation_without_retry(self):
        _FakeStripeService.reset()
        facade = _BillingPaymentFixture(
            {
                "billing_payments": [
                    {
                        "id": "payment_1",
                        "studio_id": "studio_1",
                        "stripe_charge_id": "ch_1",
                        "stripe_account_id": "acct_1",
                        "amount_cents": 1200,
                        "refunded_amount_cents": 0,
                    }
                ],
                "audit_logs": [],
            }
        )
        manager = facade.manager
        observed_projection_failure = []

        def fail_refund_projection(table_name, payloads, _rows):
            if table_name == "billing_refunds":
                refund = payloads[0]
                observed_projection_failure.append(
                    {
                        "table": table_name,
                        "refund_id": refund["stripe_refund_id"],
                        "studio_id": refund["studio_id"],
                        "provider_refund_count": len(_FakeStripeService.refunds),
                    }
                )
                raise RuntimeError("local projection failed with private payload")

        facade.supabase.before_insert = fail_refund_projection

        with self.assertRaises(HTTPException) as failed:
            asyncio.run(
                manager.refund_payment(
                    "payment_1",
                    BillingRefundCreate(amount_cents=500),
                    "studio_1",
                    "actor_1",
                    "refund-key",
                )
            )
        with self.assertRaises(HTTPException) as replay:
            asyncio.run(
                manager.refund_payment(
                    "payment_1",
                    BillingRefundCreate(amount_cents=500),
                    "studio_1",
                    "actor_1",
                    "refund-key",
                )
            )

        self.assertEqual(failed.exception.status_code, 503)
        self.assertEqual(replay.exception.status_code, 409)
        self.assertEqual(
            observed_projection_failure,
            [
                {
                    "table": "billing_refunds",
                    "refund_id": "re_created",
                    "studio_id": "studio_1",
                    "provider_refund_count": 1,
                }
            ],
        )
        self.assertEqual(len(_FakeStripeService.refunds), 1)
        operation = next(iter(facade.supabase.billing_provider_operations.values()))
        self.assertEqual(operation["state"], "reconciliation_required")
        self.assertEqual(
            operation["reconciliation_reason_code"],
            "payment_refund_local_projection_failed",
        )
        self.assertNotIn("private payload", repr(operation))
        self.assertEqual(facade.supabase.tables["audit_logs"], [])

    def test_refund_ambiguous_provider_error_and_policy_rejection_are_never_reissued(self):
        for provider_error, expected_state in (
            (RuntimeError("provider timeout with secret payload"), "reconciliation_required"),
            (
                StripeMutationBlocked(status_code=503, detail="provider mutation blocked"),
                "definitive_rejected",
            ),
        ):
            with self.subTest(expected_state=expected_state):
                _FakeStripeService.reset()
                _FakeStripeService.refund_error = provider_error
                facade = _BillingPaymentFixture(
                    {
                        "billing_payments": [
                            {
                                "id": "payment_1",
                                "studio_id": "studio_1",
                                "stripe_charge_id": "ch_1",
                                "stripe_account_id": "acct_1",
                                "amount_cents": 1200,
                                "refunded_amount_cents": 0,
                            }
                        ],
                    }
                )
                manager = facade.manager

                with self.assertRaises(HTTPException):
                    asyncio.run(
                        manager.refund_payment(
                            "payment_1",
                            BillingRefundCreate(amount_cents=500),
                            "studio_1",
                            "actor_1",
                            "refund-key",
                        )
                    )
                with self.assertRaises(HTTPException):
                    asyncio.run(
                        manager.refund_payment(
                            "payment_1",
                            BillingRefundCreate(amount_cents=500),
                            "studio_1",
                            "actor_1",
                            "refund-key",
                        )
                    )

                self.assertEqual(len(_FakeStripeService.refunds), 1)
                operation = next(iter(facade.supabase.billing_provider_operations.values()))
                self.assertEqual(operation["state"], expected_state)
                self.assertNotIn("secret payload", repr(operation))

    def test_refund_rejects_cross_studio_generation_before_operation_or_provider(self):
        _FakeStripeService.reset()
        facade = _BillingPaymentFixture(
            {
                "billing_payments": [
                    {
                        "id": "payment_1",
                        "studio_id": "studio_1",
                        "stripe_charge_id": "ch_1",
                        "stripe_account_id": "acct_1",
                        "connect_account_generation": 1,
                        "amount_cents": 1200,
                        "refunded_amount_cents": 0,
                    }
                ],
                "studio_payment_accounts": [
                    {
                        "studio_id": "studio_2",
                        "stripe_connected_account_id": "acct_1",
                        "charges_enabled": True,
                        "metadata": {"connect_account_generation": 2},
                    }
                ],
            }
        )

        with self.assertRaises(HTTPException) as context:
            asyncio.run(
                facade.manager.refund_payment(
                    "payment_1",
                    BillingRefundCreate(amount_cents=500),
                    "studio_1",
                    "actor_1",
                    "refund-key",
                )
            )

        self.assertEqual(context.exception.status_code, 409)
        self.assertEqual(facade.supabase.billing_provider_operations, {})
        self.assertEqual(_FakeStripeService.refunds, [])

    def test_refund_projection_preserves_invoice_receivable_and_replays_saved_result(self):
        _FakeStripeService.reset()
        invoice = {
            "id": "invoice_1",
            "studio_id": "studio_1",
            "amount_remaining_cents": 700,
            "status": "open",
        }
        facade = _BillingPaymentFixture(
            {
                "billing_payments": [
                    {
                        "id": "payment_1",
                        "studio_id": "studio_1",
                        "invoice_id": "invoice_1",
                        "stripe_charge_id": "ch_1",
                        "stripe_account_id": "acct_1",
                        "amount_cents": 1200,
                        "refunded_amount_cents": 0,
                    }
                ],
                "billing_invoices": [invoice],
                "audit_logs": [],
            }
        )
        manager = facade.manager

        first = asyncio.run(
            manager.refund_payment(
                "payment_1",
                BillingRefundCreate(amount_cents=500),
                "studio_1",
                "actor_1",
                "refund-key",
            )
        )
        replay = asyncio.run(
            manager.refund_payment(
                "payment_1",
                BillingRefundCreate(amount_cents=500),
                "studio_1",
                "actor_1",
                "refund-key",
            )
        )

        self.assertEqual(replay.id, first.id)
        self.assertEqual(len(_FakeStripeService.refunds), 1)
        self.assertEqual(len(facade.supabase.tables["audit_logs"]), 1)
        self.assertEqual(invoice["amount_remaining_cents"], 700)
        self.assertEqual(invoice["status"], "open")

    def test_refund_saved_result_mismatch_is_sanitized_for_completed_and_reconciled_for_projected(
        self,
    ):
        for operation_state in ("completed", "projected"):
            with self.subTest(operation_state=operation_state):
                _FakeStripeService.reset()
                if operation_state == "projected":
                    _FakeStripeService.refund_status = "pending"
                facade = _BillingPaymentFixture(
                    {
                        "billing_payments": [
                            {
                                "id": "payment_1",
                                "studio_id": "studio_1",
                                "stripe_charge_id": "ch_1",
                                "stripe_account_id": "acct_1",
                                "amount_cents": 1200,
                                "refunded_amount_cents": 0,
                                "metadata": {},
                            }
                        ],
                        "audit_logs": [],
                    }
                )
                manager = facade.manager
                if operation_state == "completed":
                    asyncio.run(
                        manager.refund_payment(
                            "payment_1",
                            BillingRefundCreate(amount_cents=500),
                            "studio_1",
                            "actor_1",
                            "refund-key",
                        )
                    )
                else:
                    original_complete = facade.supabase._rpc_complete_billing_provider_operation_v1
                    completion_attempts = []

                    def fail_completion(params):
                        facade.supabase._rpc_complete_billing_provider_operation_v1 = (
                            original_complete
                        )
                        completion_attempts.append(dict(params))
                        raise RuntimeError("completion unavailable")

                    facade.supabase._rpc_complete_billing_provider_operation_v1 = fail_completion
                    with self.assertRaisesRegex(RuntimeError, "completion unavailable"):
                        asyncio.run(
                            manager.refund_payment(
                                "payment_1",
                                BillingRefundCreate(amount_cents=500),
                                "studio_1",
                                "actor_1",
                                "refund-key",
                            )
                        )
                    self.assertEqual(len(completion_attempts), 1)
                    facade.supabase.advance_billing_provider_clock(seconds=31)

                operation = next(iter(facade.supabase.billing_provider_operations.values()))
                if operation_state == "projected":
                    self.assertEqual(operation["state"], "projected")
                    self.assertEqual(
                        facade.supabase.tables["billing_payments"][0]["refunded_amount_cents"],
                        0,
                    )
                else:
                    self.assertEqual(operation["state"], "completed")
                    self.assertEqual(
                        facade.supabase.tables["billing_payments"][0]["refunded_amount_cents"],
                        500,
                    )
                facade.supabase.tables["billing_refunds"][0]["payment_id"] = "payment_other"

                with self.assertRaises(HTTPException) as mismatch:
                    asyncio.run(
                        manager.refund_payment(
                            "payment_1",
                            BillingRefundCreate(amount_cents=500),
                            "studio_1",
                            "actor_1",
                            "refund-key",
                        )
                    )

                self.assertEqual(mismatch.exception.status_code, 503)
                self.assertNotIn("payment_other", mismatch.exception.detail)
                self.assertEqual(len(_FakeStripeService.refunds), 1)
                if operation_state == "projected":
                    self.assertEqual(operation["state"], "reconciliation_required")
                    self.assertEqual(
                        operation["reconciliation_reason_code"],
                        "payment_refund_projection_unverified",
                    )
                else:
                    self.assertEqual(operation["state"], "completed")

    def test_long_refund_idempotency_keys_are_capped_for_stripe(self):
        _FakeStripeService.reset()
        facade = _BillingPaymentFixture(
            {
                "billing_payments": [
                    {
                        "id": "payment_1",
                        "studio_id": "studio_1",
                        "stripe_charge_id": "ch_1",
                        "stripe_account_id": "acct_1",
                        "amount_cents": 1200,
                        "refunded_amount_cents": 0,
                    }
                ]
            }
        )
        manager = facade.manager
        payload = BillingRefundCreate(amount_cents=500)

        asyncio.run(
            manager.refund_payment(
                "payment_1",
                payload,
                "studio_1",
                "actor_1",
                "a" * MAX_IDEMPOTENCY_KEY_LENGTH,
            )
        )
        payment = facade.supabase.tables["billing_payments"][0]
        payment["refunded_amount_cents"] = 500
        payment["refundable_amount_cents"] = 700
        asyncio.run(
            manager.refund_payment(
                "payment_1",
                payload,
                "studio_1",
                "actor_1",
                "b" * MAX_IDEMPOTENCY_KEY_LENGTH,
            )
        )

        keys = [refund["idempotency_key"] for refund in _FakeStripeService.refunds]
        self.assertEqual(len(keys), 2)
        self.assertNotEqual(keys[0], keys[1])
        self.assertTrue(all(len(key) <= MAX_IDEMPOTENCY_KEY_LENGTH for key in keys))
        self.assertTrue(all(key.startswith("koaryu:payment-refund:") for key in keys))

    def test_create_and_get_export_job_records_async_request_metadata(self):
        facade = _BillingPaymentFixture({"export_jobs": []})
        facade.supabase.insert_defaults["export_jobs"] = {
            "status": "queued",
            "created_at": "2026-01-01T00:00:00Z",
            "updated_at": "2026-01-01T00:00:00Z",
        }
        manager = facade.manager

        created = asyncio.run(
            manager.create_export_job(
                ExportJobCreate(export_type="billing_payments", filters={"status": "paid"}),
                "studio_1",
                "actor_1",
            )
        )
        fetched = asyncio.run(manager.get_export_job(created.id, "studio_1"))

        self.assertEqual(fetched.status, "queued")
        self.assertEqual(fetched.metadata["filters"], {"status": "paid"})
        self.assertTrue(fetched.metadata["async_required"])

    def _refund_recovery(self, outcome, recovered_id=None):
        _FakeStripeService.reset()
        facade = _BillingPaymentFixture(
            {
                "billing_payments": [
                    {
                        "id": "payment_1",
                        "studio_id": "studio_1",
                        "payer_id": "payer_1",
                        "stripe_charge_id": "ch_1",
                        "stripe_account_id": "acct_1",
                        "connect_account_generation": 1,
                        "amount_cents": 1200,
                        "refunded_amount_cents": 0,
                        "disputed_amount_cents": 0,
                        "refundable_amount_cents": 1200,
                        "status": "succeeded",
                    }
                ],
                "billing_refunds": [],
                "audit_logs": [],
            }
        )
        manager = facade.manager
        payload = BillingRefundCreate(amount_cents=500, reason="requested_by_customer")
        _FakeStripeService.refund_error = RuntimeError("lost refund response")
        with self.assertRaises(HTTPException):
            asyncio.run(
                manager.refund_payment(
                    "payment_1", payload, "studio_1", "actor_1", "refund-recovery-key"
                )
            )
        operation = next(iter(facade.supabase.billing_provider_operations.values()))
        context = BillingProviderOperationContext(
            operation["id"],
            "studio_1",
            "actor_1",
            "payment.refund",
            operation["caller_request_key"],
            operation["request_sha256"],
            "acct_1",
            1,
            str(operation["lease_owner"]),
        )
        BillingProviderOperationCoordinator(facade.supabase).authorize_recovery_v2(
            context,
            operation,
            recovery_actor_id="00000000-0000-4000-8000-000000000203",
            recovery_proof_sha256="c" * 64,
            recovery_outcome=outcome,
            recovered_provider_object_id=recovered_id,
            lease_owner="00000000-0000-4000-8000-000000000103",
        )
        return facade, manager, operation, payload

    def test_refund_safe_retry_reuses_saved_amount_payload_and_key(self):
        facade, manager, operation, payload = self._refund_recovery(
            "provider_no_object_safe_to_retry"
        )
        first = dict(_FakeStripeService.refunds[0])
        facade.supabase.tables["billing_payments"][0]["refundable_amount_cents"] = 0
        _FakeStripeService.refund_error = None
        result = asyncio.run(
            manager.refund_payment(
                "payment_1", payload, "studio_1", "actor_1", "refund-recovery-key"
            )
        )
        self.assertEqual(result.amount_cents, 500)
        self.assertEqual(_FakeStripeService.refunds, [first, first])
        self.assertEqual(operation["provider_request_attempt_count"], 2)
        self.assertEqual(operation["state"], "completed")
        asyncio.run(
            manager.refund_payment(
                "payment_1", payload, "studio_1", "actor_1", "refund-recovery-key"
            )
        )
        self.assertEqual(len(_FakeStripeService.refunds), 2)

    def test_refund_reconcile_only_gets_exact_refund_without_second_mutation(self):
        facade, manager, operation, payload = self._refund_recovery(
            "provider_succeeded_reconcile_only", "re_recovered"
        )
        _FakeStripeService.refund_error = None
        _FakeStripeService.refund_response = {
            "id": "re_recovered",
            "charge": "ch_1",
            "amount": 500,
            "reason": "requested_by_customer",
            "status": "succeeded",
            "metadata": {
                "studio_id": "studio_1",
                "payment_id": "payment_1",
                "product": "koaryu_payments",
            },
        }
        result = asyncio.run(
            manager.refund_payment(
                "payment_1", payload, "studio_1", "actor_1", "refund-recovery-key"
            )
        )
        self.assertEqual(result.stripe_refund_id, "re_recovered")
        self.assertEqual(len(_FakeStripeService.refunds), 1)
        self.assertEqual(
            _FakeStripeService.retrieved_refunds,
            [{"account_id": "acct_1", "refund_id": "re_recovered"}],
        )
        self.assertEqual(operation["provider_request_attempt_count"], 1)
        self.assertEqual(operation["state"], "completed")

    def test_refund_reconcile_only_wrong_charge_never_projects(self):
        facade, manager, operation, payload = self._refund_recovery(
            "provider_succeeded_reconcile_only", "re_recovered"
        )
        _FakeStripeService.refund_response = {
            "id": "re_recovered",
            "charge": "ch_wrong",
            "amount": 500,
            "reason": "requested_by_customer",
            "status": "succeeded",
            "metadata": {
                "studio_id": "studio_1",
                "payment_id": "payment_1",
                "product": "koaryu_payments",
            },
        }
        with self.assertRaises(HTTPException):
            asyncio.run(
                manager.refund_payment(
                    "payment_1",
                    payload,
                    "studio_1",
                    "actor_1",
                    "refund-recovery-key",
                )
            )
        self.assertEqual(operation["state"], "reconciliation_required")
        self.assertEqual(facade.supabase.tables["billing_refunds"], [])
        self.assertEqual(len(_FakeStripeService.refunds), 1)
        self.assertEqual(facade.supabase.tables["audit_logs"], [])
