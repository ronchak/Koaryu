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
    EXTERNAL_PAYMENT_OVERPAY_DETAIL,
    EXTERNAL_PAYMENT_TARGET_REQUIRED_DETAIL,
    BillingPaymentManager,
    build_external_payment_request_hash,
)
from app.services.billing_provider_operations import (
    BillingProviderOperationContext,
    BillingProviderOperationCoordinator,
)
from app.services.platform_billing_helpers import MAX_IDEMPOTENCY_KEY_LENGTH, build_idempotency_key
from app.services.stripe_mutation_policy import StripeMutationBlocked
from tests.fakes.billing_provider_operations import BillingProviderOperationRpcMixin
from tests.fakes.supabase import RpcBackedSupabase


def conflict_error() -> PostgrestAPIError:
    return PostgrestAPIError({
        "code": "23505",
        "message": "duplicate key value violates unique constraint",
        "details": "",
        "hint": "",
    })


def external_payment_overpay_error() -> PostgrestAPIError:
    return PostgrestAPIError({
        "code": "23514",
        "message": EXTERNAL_PAYMENT_OVERPAY_DETAIL,
        "details": "",
        "hint": "",
    })


def external_payment_idempotency_error() -> PostgrestAPIError:
    return PostgrestAPIError({
        "code": "23514",
        "message": EXTERNAL_PAYMENT_IDEMPOTENCY_REQUIRED_DETAIL,
        "details": "",
        "hint": "",
    })


def _dated_defaults(_table: str) -> dict:
    return {
        "created_at": "2026-01-01T00:00:00Z",
        "updated_at": "2026-01-01T00:00:00Z",
    }


class _BillingSupabase(BillingProviderOperationRpcMixin, RpcBackedSupabase):
    def __init__(self, tables):
        super().__init__(tables)
        self.initialize_billing_provider_operations()

    def _rpc_recompute_billing_invoice_external_payment_totals(self, params: dict) -> list[dict]:
        studio_id = params["p_studio_id"]
        invoice_id = params["p_invoice_id"]
        invoice = next(
            (
                row
                for row in self.tables.setdefault("billing_invoices", [])
                if row.get("id") == invoice_id and row.get("studio_id") == studio_id
            ),
            None,
        )
        if invoice is None:
            raise AssertionError("Invoice not found")
        paid = sum(
            int(row.get("amount_cents") or 0)
            for row in self.tables.setdefault("billing_payments", [])
            if row.get("invoice_id") == invoice_id
            and row.get("studio_id") == studio_id
            and row.get("status") in {"succeeded", "externally_recorded"}
        )
        due = int(invoice.get("amount_due_cents") or 0)
        invoice["amount_paid_cents"] = min(paid, due)
        invoice["amount_remaining_cents"] = max(0, due - paid)
        invoice["external"] = True
        if paid >= due:
            invoice["status"] = "paid"
            invoice["paid_at"] = invoice.get("paid_at") or "2026-01-01T00:00:00Z"
            invoice["application_fee_amount_cents"] = 0
        return [{
            "updated": True,
            "amount_paid_cents": invoice["amount_paid_cents"],
            "amount_remaining_cents": invoice["amount_remaining_cents"],
            "status": invoice.get("status"),
        }]


class _BillingFacade:
    def __init__(self, tables: dict[str, list[dict]]):
        payment_accounts = {
            row.get("stripe_account_id")
            for row in tables.get("billing_payments", [])
            if row.get("stripe_account_id")
        }
        tables.setdefault("studio_payment_accounts", [
            {
                "studio_id": "studio_1",
                "stripe_connected_account_id": account_id,
                "charges_enabled": True,
                "metadata": {"connect_account_generation": 1},
            }
            for account_id in sorted(payment_accounts)
        ])
        for payment in tables.get("billing_payments", []):
            payment.setdefault("payer_id", "payer_1")
            if payment.get("stripe_account_id"):
                payment.setdefault("connect_account_generation", 1)
        self.supabase = _BillingSupabase(tables)
        for table in ("billing_payments", "billing_refunds", "export_jobs", "audit_logs"):
            self.supabase.insert_defaults[table] = _dated_defaults
        self.supabase.unique_constraints["billing_payments"] = [("studio_id", "idempotency_key")]
        self.supabase.unique_conflict_error_factory = lambda _table, _columns: conflict_error()
        self.balance_recomputes: list[tuple[str, str | None]] = []

    def _ensure_record_in_studio(self, table: str, record_id: str, studio_id: str, detail: str) -> None:
        self._get_row_or_404(table, record_id, studio_id, detail)

    def _get_row_or_404(self, table: str, record_id: str, studio_id: str, detail: str) -> dict:
        result = self.supabase.table(table).select("*").eq("id", record_id).eq("studio_id", studio_id).limit(1).execute()
        if not result.data:
            raise AssertionError(detail)
        return result.data[0]

    def _recompute_payer_balance(self, studio_id: str, payer_id: str | None) -> None:
        self.balance_recomputes.append((studio_id, payer_id))

    def _idempotency_key(self, *parts: str) -> str:
        return build_idempotency_key(*parts)

    def _connect_accounts(self):
        facade = self

        class Accounts:
            @staticmethod
            def by_stripe_account(account_id: str):
                return next(
                    (
                        row
                        for row in facade.supabase.tables.get("studio_payment_accounts", [])
                        if row.get("stripe_connected_account_id") == account_id
                    ),
                    None,
                )

        return Accounts()

    def _audit(self, studio_id: str, actor_id: str, action: str, entity_id: str, metadata: dict) -> None:
        self.supabase.table("audit_logs").insert({
            "studio_id": studio_id,
            "actor_id": actor_id,
            "action": action,
            "entity_id": entity_id,
            "metadata": metadata,
        }).execute()

    def _project_refund(self, refund: dict, account_id: str) -> dict:
        payment = next(
            row
            for row in self.supabase.tables.get("billing_payments", [])
            if row["id"] == refund["metadata"]["payment_id"]
        )
        row = {
            "id": "refund_local",
            "studio_id": refund["metadata"]["studio_id"],
            "payment_id": refund["metadata"]["payment_id"],
            "stripe_refund_id": refund["id"],
            "stripe_charge_id": refund["charge"],
            "stripe_account_id": account_id,
            "connect_account_generation": payment["connect_account_generation"],
            "amount_cents": refund["amount"],
            "status": refund.get("status") or "succeeded",
            "reason": refund.get("reason"),
            "reconciliation_required": False,
            "created_at": "2026-01-01T00:00:00Z",
        }
        existing = self.supabase.tables.setdefault("billing_refunds", [])
        if not any(candidate.get("stripe_refund_id") == row["stripe_refund_id"] for candidate in existing):
            existing.append(row)
        return row


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
        facade = _BillingFacade({
            "billing_payments": [{
                "id": "payment_1", "studio_id": "studio_1",
                "stripe_charge_id": "ch_1", "stripe_account_id": "acct_1",
                "connect_account_generation": 1, "amount_cents": 1200,
                "refunded_amount_cents": 0,
            }],
            "audit_logs": [],
        })
        manager = BillingPaymentManager(facade, stripe_service_cls=_FakeStripeService)
        data = BillingRefundCreate(amount_cents=500, reason="requested_by_customer")
        result = asyncio.run(manager.refund_payment(
            "payment_1", data, "studio_1", "actor_1", "refund-key",
        ))
        operation = next(iter(facade.supabase.billing_provider_operations.values()))
        payment = facade.supabase.tables["billing_payments"][0]
        refund = next(
            row for row in facade.supabase.tables["billing_refunds"]
            if row["stripe_refund_id"] == result.stripe_refund_id
        )
        context = BillingProviderOperationContext(
            operation["id"], "studio_1", "actor_1", "payment.refund",
            operation["caller_request_key"], operation["request_sha256"],
            "acct_1", 1, str(operation["lease_owner"]),
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
                facade = _BillingFacade({
                    "billing_payments": [{
                        "id": "payment_1", "studio_id": "studio_1",
                        "stripe_charge_id": "ch_1", "stripe_account_id": "acct_1",
                        "connect_account_generation": 1, "amount_cents": 1200,
                        "refunded_amount_cents": 0,
                    }],
                    "audit_logs": [],
                })
                manager = BillingPaymentManager(facade, stripe_service_cls=_FakeStripeService)
                data = BillingRefundCreate(amount_cents=500, reason="requested_by_customer")

                def fail_audit(table_name, _payloads, _rows):
                    if table_name == "audit_logs":
                        facade.supabase.before_insert = None
                        raise RuntimeError("transient audit failure")

                facade.supabase.before_insert = fail_audit
                with self.assertRaisesRegex(RuntimeError, "transient audit failure"):
                    asyncio.run(manager.refund_payment(
                        "payment_1", data, "studio_1", "actor_1", "refund-key",
                    ))
                operation = next(iter(facade.supabase.billing_provider_operations.values()))
                self.assertEqual(operation["state"], "completed")
                self.assertEqual(facade.supabase.tables["audit_logs"], [])
                asyncio.run(manager.refund_payment(
                    "payment_1", data, "studio_1", "actor_1", "refund-key",
                ))
                asyncio.run(manager.refund_payment(
                    "payment_1", data, "studio_1", "actor_1", "refund-key",
                ))
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
            ("payment_account", {**payment, "stripe_account_id": "acct_other"}, refund, data, operation, context),
            ("payment_generation", {**payment, "connect_account_generation": 2}, refund, data, operation, context),
            ("refund", payment, {**refund, "stripe_refund_id": "re_other"}, data, operation, context),
            ("operation", payment, refund, data, {**operation, "id": "operation_other"}, context),
            ("operation_actor", payment, refund, data, {**operation, "actor_id": "actor_other"}, context),
            ("operation_request", payment, refund, data, {**operation, "request_sha256": "f" * 64}, context),
            ("operation_account", payment, refund, data, {**operation, "stripe_connected_account_id": "acct_other"}, context),
            ("operation_generation", payment, refund, data, {**operation, "connect_account_generation": 2}, context),
            ("provider_result", payment, refund, data, {**operation, "provider_object_id": "re_other"}, context),
            ("precompletion", payment, refund, data, {**operation, "state": "projected"}, context),
            ("context_actor", payment, refund, data, operation, replace(context, actor_id="actor_other")),
            ("context_request", payment, refund, data, operation, replace(context, request_sha256="f" * 64)),
            ("context_account", payment, refund, data, operation, replace(context, stripe_connected_account_id="acct_other")),
            ("context_generation", payment, refund, data, operation, replace(context, connect_account_generation=2)),
            ("request_amount", payment, refund, BillingRefundCreate(amount_cents=600), operation, context),
            ("request_reason", payment, refund, BillingRefundCreate(amount_cents=500, reason="duplicate"), operation, context),
        )
        for label, bad_payment, bad_refund, bad_data, bad_operation, bad_context in cases:
            with self.subTest(label=label):
                with self.assertRaisesRegex(RuntimeError, "payment_refund_audit_identity_mismatch|payment_refund_saved_amount_invalid|payment_refund_projection"):
                    manager._ensure_refund_audit(
                        payment=bad_payment, refund=bad_refund, data=bad_data,
                        amount=500, operation=bad_operation, context=bad_context,
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
                        payment=payment, refund=refund, data=data, amount=500,
                        operation=operation, context=context,
                    )
                else:
                    with self.assertRaisesRegex(
                        RuntimeError, "payment_refund_audit_conflict_unverified"
                    ):
                        manager._ensure_refund_audit(
                            payment=payment, refund=refund, data=data, amount=500,
                            operation=operation, context=context,
                        )
                audit_queries = [
                    entry for entry in facade.supabase.query_log
                    if entry["table"] == "audit_logs"
                ]
                expected_id = str(uuid5(
                    NAMESPACE_URL,
                    f"koaryu:billing.payment_refunded:{operation['id']}",
                ))
                self.assertEqual(sum(entry["insert"] is not None for entry in audit_queries), 1)
                self.assertEqual(sum(entry["columns"] == "*" for entry in audit_queries), 2)
                self.assertTrue(all(
                    entry["filters"] == (("eq", "id", expected_id),)
                    for entry in audit_queries if entry["columns"] == "*"
                ))
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
            with self.subTest(field=next(
                key for key in malformed if malformed.get(key) != exact.get(key)
            )):
                facade.supabase.tables["audit_logs"] = [malformed]
                with self.assertRaisesRegex(
                    RuntimeError, "payment_refund_audit_identity_mismatch"
                ):
                    manager._ensure_refund_audit(
                        payment=payment, refund=refund, data=data, amount=500,
                        operation=operation, context=context,
                    )
        self.assertEqual(_FakeStripeService.refunds, [])
        self.assertEqual(_FakeStripeService.retrieved_refunds, [])

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
        current_rows.extend([
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
        ])
        manager = BillingPaymentManager(_BillingFacade({"billing_payments": current_rows}))

        summary = asyncio.run(manager.current_month_payment_cohort_summary(
            "studio_1",
            as_of=datetime(2026, 7, 20, tzinfo=timezone.utc),
        ))

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

    def test_external_payment_request_hash_honors_empty_effective_payer_id(self):
        payload = ExternalPaymentCreate(
            payer_id="request-payer",
            amount_cents=500,
            external_method="cash",
        )

        request_payer_hash = build_external_payment_request_hash(payload, effective_payer_id=None)
        empty_effective_payer_hash = build_external_payment_request_hash(payload, effective_payer_id="")

        self.assertNotEqual(empty_effective_payer_hash, request_payer_hash)

    def test_external_payment_rejects_missing_target_before_any_side_effect(self):
        facade = _BillingFacade({
            "billing_payments": [],
            "audit_logs": [],
        })
        manager = BillingPaymentManager(facade)

        with self.assertRaises(HTTPException) as context:
            asyncio.run(manager.record_external_payment(
                ExternalPaymentCreate(amount_cents=500, external_method="cash"),
                "studio_1",
                "actor_1",
                "payment-key-1",
            ))

        self.assertEqual(context.exception.status_code, 400)
        self.assertEqual(context.exception.detail, EXTERNAL_PAYMENT_TARGET_REQUIRED_DETAIL)
        self.assertEqual(facade.supabase.query_log, [])
        self.assertEqual(facade.supabase.rpc_calls, [])
        self.assertEqual(facade.supabase.tables["billing_payments"], [])
        self.assertEqual(facade.supabase.tables["audit_logs"], [])
        self.assertEqual(facade.balance_recomputes, [])

    def test_external_payment_updates_invoice_and_recomputes_payer_balance(self):
        _FakeStripeService.reset()
        facade = _BillingFacade({
            "billing_payers": [{"id": "payer_1", "studio_id": "studio_1"}],
            "billing_invoices": [{
                "id": "invoice_1",
                "studio_id": "studio_1",
                "payer_id": "payer_1",
                "status": "open",
                "amount_due_cents": 1000,
                "amount_paid_cents": 250,
                "stripe_account_id": "acct_1",
                "stripe_invoice_id": "in_1",
            }],
            "billing_payments": [{
                "id": "payment_existing",
                "studio_id": "studio_1",
                "payer_id": "payer_1",
                "invoice_id": "invoice_1",
                "status": "succeeded",
                "amount_cents": 250,
                "created_at": "2026-01-01T00:00:00Z",
                "updated_at": "2026-01-01T00:00:00Z",
            }],
        })
        manager = BillingPaymentManager(facade, stripe_service_cls=_FakeStripeService)

        payment = asyncio.run(manager.record_external_payment(
            ExternalPaymentCreate(
                payer_id="payer_1",
                invoice_id="invoice_1",
                amount_cents=750,
                external_method="cash",
            ),
            "studio_1",
            "actor_1",
            "payment-key-1",
        ))

        invoice = facade.supabase.tables["billing_invoices"][0]
        self.assertEqual(payment.status, "externally_recorded")
        self.assertEqual(payment.net_collected_amount_cents, 750)
        self.assertEqual(payment.refundable_amount_cents, 0)
        self.assertEqual(invoice["status"], "paid")
        self.assertEqual(invoice["amount_remaining_cents"], 0)
        self.assertEqual(invoice["application_fee_amount_cents"], 0)
        self.assertEqual(facade.balance_recomputes, [("studio_1", "payer_1")])
        self.assertEqual(_FakeStripeService.out_of_band_payments, [])
        self.assertEqual(
            facade.supabase.rpc_calls[0][0],
            "recompute_billing_invoice_external_payment_totals",
        )

    def test_external_payment_requires_request_idempotency_key(self):
        facade = _BillingFacade({
            "billing_payers": [{"id": "payer_1", "studio_id": "studio_1"}],
            "billing_payments": [],
            "audit_logs": [],
        })
        manager = BillingPaymentManager(facade)

        with self.assertRaises(HTTPException) as context:
            asyncio.run(manager.record_external_payment(
                ExternalPaymentCreate(
                    payer_id="payer_1",
                    amount_cents=500,
                    external_method="cash",
                ),
                "studio_1",
                "actor_1",
            ))

        self.assertEqual(context.exception.status_code, 400)
        self.assertEqual(context.exception.detail, EXTERNAL_PAYMENT_IDEMPOTENCY_REQUIRED_DETAIL)
        self.assertEqual(facade.supabase.tables["billing_payments"], [])
        self.assertEqual(facade.supabase.tables["audit_logs"], [])

    def test_external_payment_provider_mutation_is_forbidden_and_retry_stays_local(self):
        class ProviderMutationForbidden(_FakeStripeService):
            def pay_connected_invoice(self, **_payload):
                raise AssertionError(
                    "External payment recording must not mutate a provider invoice."
                )

        ProviderMutationForbidden.reset()
        facade = _BillingFacade({
            "billing_payers": [{"id": "payer_1", "studio_id": "studio_1"}],
            "billing_invoices": [{
                "id": "invoice_1",
                "studio_id": "studio_1",
                "payer_id": "payer_1",
                "status": "open",
                "amount_due_cents": 1000,
                "amount_paid_cents": 0,
                "amount_remaining_cents": 1000,
                "stripe_account_id": "acct_1",
                "stripe_invoice_id": "in_1",
            }],
            "billing_payments": [],
        })
        manager = BillingPaymentManager(
            facade,
            stripe_service_cls=ProviderMutationForbidden,
        )
        payload = ExternalPaymentCreate(
            invoice_id="invoice_1",
            amount_cents=1000,
            external_method="check",
        )

        first = asyncio.run(manager.record_external_payment(
            payload, "studio_1", "actor_1", "payment-key-1",
        ))

        invoice = facade.supabase.tables["billing_invoices"][0]
        self.assertEqual(first.status, "externally_recorded")
        self.assertEqual(invoice["status"], "paid")
        self.assertEqual(invoice["amount_paid_cents"], 1000)
        self.assertEqual(invoice["amount_remaining_cents"], 0)
        self.assertEqual(len(facade.supabase.tables["billing_payments"]), 1)
        self.assertEqual(len(facade.supabase.tables["audit_logs"]), 1)
        second = asyncio.run(manager.record_external_payment(payload, "studio_1", "actor_1", "payment-key-1"))

        invoice = facade.supabase.tables["billing_invoices"][0]
        self.assertEqual(first.id, second.id)
        self.assertEqual(invoice["status"], "paid")
        self.assertEqual(invoice["amount_paid_cents"], 1000)
        self.assertEqual(invoice["amount_remaining_cents"], 0)
        self.assertEqual(ProviderMutationForbidden.out_of_band_payments, [])
        self.assertEqual(len(facade.supabase.tables["billing_payments"]), 1)
        self.assertEqual(len(facade.supabase.tables["audit_logs"]), 1)
        self.assertEqual(
            facade.supabase.rpc_calls[0][0],
            "recompute_billing_invoice_external_payment_totals",
        )

    def test_external_payment_uses_idempotency_key_once_for_matching_retry(self):
        _FakeStripeService.reset()
        facade = _BillingFacade({
            "billing_payers": [{"id": "payer_1", "studio_id": "studio_1"}],
            "billing_invoices": [{
                "id": "invoice_1",
                "studio_id": "studio_1",
                "payer_id": "payer_1",
                "status": "open",
                "amount_due_cents": 1000,
                "amount_paid_cents": 0,
                "stripe_account_id": "acct_1",
                "stripe_invoice_id": "in_1",
            }],
            "billing_payments": [],
        })
        manager = BillingPaymentManager(facade, stripe_service_cls=_FakeStripeService)
        payload = ExternalPaymentCreate(
            invoice_id="invoice_1",
            amount_cents=1000,
            external_method="check",
        )

        first = asyncio.run(manager.record_external_payment(payload, "studio_1", "actor_1", "payment-key-1"))
        second = asyncio.run(manager.record_external_payment(payload, "studio_1", "actor_1", "payment-key-1"))

        self.assertEqual(first.id, second.id)
        self.assertEqual(len(facade.supabase.tables["billing_payments"]), 1)
        self.assertEqual(len(facade.supabase.tables["audit_logs"]), 1)
        self.assertEqual(facade.supabase.tables["billing_payments"][0]["payer_id"], "payer_1")

    def test_external_payment_replays_existing_row_after_concurrent_idempotency_conflict(self):
        _FakeStripeService.reset()
        facade = _BillingFacade({
            "billing_payers": [{"id": "payer_1", "studio_id": "studio_1"}],
            "billing_invoices": [{
                "id": "invoice_1",
                "studio_id": "studio_1",
                "payer_id": "payer_1",
                "status": "open",
                "amount_due_cents": 1000,
                "amount_paid_cents": 0,
                "amount_remaining_cents": 1000,
            }],
            "billing_payments": [],
            "audit_logs": [],
        })
        manager = BillingPaymentManager(facade, stripe_service_cls=_FakeStripeService)
        payload = ExternalPaymentCreate(
            invoice_id="invoice_1",
            amount_cents=1000,
            external_method="check",
        )
        request_hash = manager._external_payment_request_hash(payload, effective_payer_id="payer_1")

        def insert_concurrent_row(table: str, _payloads: list[dict], rows: list[dict]) -> None:
            if table != "billing_payments" or rows:
                return
            rows.append({
                "id": "payment_concurrent",
                "studio_id": "studio_1",
                "payer_id": "payer_1",
                "invoice_id": "invoice_1",
                "status": "externally_recorded",
                "amount_cents": 1000,
                "currency": "usd",
                "payment_method_type": "external",
                "external_method": "check",
                "idempotency_key": "payment-key-1",
                "request_hash": request_hash,
                "processed_at": "2026-01-01T00:00:00Z",
                "created_at": "2026-01-01T00:00:00Z",
                "updated_at": "2026-01-01T00:00:00Z",
            })

        facade.supabase.before_insert = insert_concurrent_row

        payment = asyncio.run(manager.record_external_payment(payload, "studio_1", "actor_1", "payment-key-1"))

        invoice = facade.supabase.tables["billing_invoices"][0]
        self.assertEqual(payment.id, "payment_concurrent")
        self.assertEqual(invoice["status"], "paid")
        self.assertEqual(invoice["amount_paid_cents"], 1000)
        self.assertEqual(invoice["amount_remaining_cents"], 0)
        self.assertEqual(len(facade.supabase.tables["billing_payments"]), 1)
        self.assertEqual(facade.supabase.tables["audit_logs"], [])

    def test_external_payment_rejects_reused_idempotency_key_for_different_request(self):
        facade = _BillingFacade({
            "billing_payers": [{"id": "payer_1", "studio_id": "studio_1"}],
            "billing_payments": [],
        })
        manager = BillingPaymentManager(facade)

        asyncio.run(manager.record_external_payment(
            ExternalPaymentCreate(payer_id="payer_1", amount_cents=500, external_method="cash"),
            "studio_1",
            "actor_1",
            "payment-key-1",
        ))

        with self.assertRaises(HTTPException) as context:
            asyncio.run(manager.record_external_payment(
                ExternalPaymentCreate(payer_id="payer_1", amount_cents=600, external_method="cash"),
                "studio_1",
                "actor_1",
                "payment-key-1",
            ))

        self.assertEqual(context.exception.status_code, 409)
        self.assertEqual(len(facade.supabase.tables["billing_payments"]), 1)

    def test_external_payment_rejects_invoice_payer_mismatch(self):
        facade = _BillingFacade({
            "billing_payers": [{"id": "payer_2", "studio_id": "studio_1"}],
            "billing_invoices": [{
                "id": "invoice_1",
                "studio_id": "studio_1",
                "payer_id": "payer_1",
                "status": "open",
                "amount_due_cents": 1000,
            }],
            "billing_payments": [],
        })
        manager = BillingPaymentManager(facade)

        with self.assertRaises(HTTPException) as context:
            asyncio.run(manager.record_external_payment(
                ExternalPaymentCreate(
                    payer_id="payer_2",
                    invoice_id="invoice_1",
                    amount_cents=500,
                    external_method="cash",
                ),
                "studio_1",
                "actor_1",
                "payment-key-1",
            ))

        self.assertEqual(context.exception.status_code, 409)
        self.assertEqual(facade.supabase.tables["billing_payments"], [])

    def test_external_payment_maps_database_overpay_guard_to_conflict(self):
        facade = _BillingFacade({
            "billing_payers": [{"id": "payer_1", "studio_id": "studio_1"}],
            "billing_invoices": [{
                "id": "invoice_1",
                "studio_id": "studio_1",
                "payer_id": "payer_1",
                "status": "open",
                "amount_due_cents": 1000,
                "amount_paid_cents": 0,
                "amount_remaining_cents": 1000,
            }],
            "billing_payments": [],
            "audit_logs": [],
        })

        def reject_insert(table: str, _payloads: list[dict], _rows: list[dict]) -> None:
            if table == "billing_payments":
                raise external_payment_overpay_error()

        facade.supabase.before_insert = reject_insert
        manager = BillingPaymentManager(facade)

        with self.assertRaises(HTTPException) as context:
            asyncio.run(manager.record_external_payment(
                ExternalPaymentCreate(
                    payer_id="payer_1",
                    invoice_id="invoice_1",
                    amount_cents=1000,
                    external_method="cash",
                ),
                "studio_1",
                "actor_1",
                "payment-key-1",
            ))

        self.assertEqual(context.exception.status_code, 409)
        self.assertEqual(context.exception.detail, EXTERNAL_PAYMENT_OVERPAY_DETAIL)
        self.assertEqual(facade.supabase.tables["billing_payments"], [])
        self.assertEqual(facade.supabase.tables["audit_logs"], [])

    def test_external_payment_maps_database_idempotency_guard_to_bad_request(self):
        facade = _BillingFacade({
            "billing_payers": [{"id": "payer_1", "studio_id": "studio_1"}],
            "billing_payments": [],
            "audit_logs": [],
        })

        def reject_insert(table: str, _payloads: list[dict], _rows: list[dict]) -> None:
            if table == "billing_payments":
                raise external_payment_idempotency_error()

        facade.supabase.before_insert = reject_insert
        manager = BillingPaymentManager(facade)

        with self.assertRaises(HTTPException) as context:
            asyncio.run(manager.record_external_payment(
                ExternalPaymentCreate(
                    payer_id="payer_1",
                    amount_cents=500,
                    external_method="cash",
                ),
                "studio_1",
                "actor_1",
                "payment-key-1",
            ))

        self.assertEqual(context.exception.status_code, 400)
        self.assertEqual(context.exception.detail, EXTERNAL_PAYMENT_IDEMPOTENCY_REQUIRED_DETAIL)
        self.assertEqual(facade.supabase.tables["billing_payments"], [])
        self.assertEqual(facade.supabase.tables["audit_logs"], [])

    def test_refund_payment_uses_injected_stripe_and_projection_delegate(self):
        _FakeStripeService.reset()
        facade = _BillingFacade({
            "billing_payments": [{
                "id": "payment_1",
                "studio_id": "studio_1",
                "stripe_charge_id": "ch_1",
                "stripe_account_id": "acct_1",
                "amount_cents": 1200,
                "refunded_amount_cents": 200,
            }]
        })
        manager = BillingPaymentManager(facade, stripe_service_cls=_FakeStripeService)

        refund = asyncio.run(manager.refund_payment(
            "payment_1",
            BillingRefundCreate(reason="requested_by_customer"),
            "studio_1",
            "actor_1",
            "refund-key-1",
        ))

        self.assertEqual(refund.amount_cents, 1000)
        self.assertEqual(refund.stripe_refund_id, "re_created")
        self.assertEqual(
            _FakeStripeService.refunds[0]["idempotency_key"],
            "koaryu:payment-refund:00000000-0000-4000-8000-000000009001",
        )
        self.assertEqual(facade.supabase.tables["audit_logs"][0]["action"], "billing.payment_refunded")

    def test_pending_refund_audits_request_without_claiming_money_returned(self):
        class PendingRefundFacade(_BillingFacade):
            def _project_refund(self, refund: dict, account_id: str) -> dict:
                row = super()._project_refund(refund, account_id)
                row["status"] = "pending"
                return row

        facade = PendingRefundFacade({
            "billing_payments": [{
                "id": "payment_1",
                "studio_id": "studio_1",
                "stripe_account_id": "acct_1",
                "stripe_charge_id": "ch_1",
                "amount_cents": 1200,
                "refunded_amount_cents": 0,
                "status": "succeeded",
            }],
        })
        manager = BillingPaymentManager(facade, stripe_service_cls=_FakeStripeService)

        refund = asyncio.run(manager.refund_payment(
            "payment_1",
            BillingRefundCreate(amount_cents=1000),
            "studio_1",
            "actor_1",
            "refund-key-pending",
        ))

        self.assertEqual(refund.status, "pending")
        audit = facade.supabase.tables["audit_logs"][0]
        self.assertEqual(audit["action"], "billing.payment_refund_requested")
        self.assertEqual(audit["metadata"]["status"], "pending")

    def test_refund_payment_requires_canonical_request_idempotency_key(self):
        for key in (None, "é" * 128):
            with self.subTest(key=key):
                facade = _BillingFacade({
                    "billing_payments": [{
                        "id": "payment_1",
                        "studio_id": "studio_1",
                        "stripe_charge_id": "ch_1",
                        "stripe_account_id": "acct_1",
                        "amount_cents": 1200,
                        "refunded_amount_cents": 0,
                    }]
                })
                manager = BillingPaymentManager(
                    facade,
                    stripe_service_cls=_FakeStripeService,
                )

                with self.assertRaises(HTTPException) as context:
                    asyncio.run(manager.refund_payment(
                        "payment_1",
                        BillingRefundCreate(amount_cents=500),
                        "studio_1",
                        "actor_1",
                        key,
                    ))

                self.assertEqual(context.exception.status_code, 400)
                self.assertEqual(facade.supabase.billing_provider_operations, {})

    def test_invalid_refund_reason_does_not_claim_payment_or_block_later_valid_request(self):
        _FakeStripeService.reset()
        facade = _BillingFacade({
            "billing_payments": [{
                "id": "payment_1",
                "studio_id": "studio_1",
                "stripe_charge_id": "ch_1",
                "stripe_account_id": "acct_1",
                "amount_cents": 1200,
                "refunded_amount_cents": 0,
            }]
        })
        manager = BillingPaymentManager(facade, stripe_service_cls=_FakeStripeService)

        invalid_payload = BillingRefundCreate.model_construct(
            amount_cents=500,
            reason="expired_uncaptured_charge",
        )
        with self.assertRaises(HTTPException) as invalid:
            asyncio.run(manager.refund_payment(
                "payment_1",
                invalid_payload,
                "studio_1",
                "actor_1",
                "refund-key-invalid",
            ))

        self.assertEqual(invalid.exception.status_code, 400)
        self.assertEqual(facade.supabase.billing_provider_operations, {})
        self.assertEqual(_FakeStripeService.refunds, [])

        refund = asyncio.run(manager.refund_payment(
            "payment_1",
            BillingRefundCreate(amount_cents=500, reason="requested_by_customer"),
            "studio_1",
            "actor_1",
            "refund-key-valid",
        ))

        self.assertEqual(refund.status, "succeeded")
        self.assertEqual(len(facade.supabase.billing_provider_operations), 1)
        self.assertEqual(len(_FakeStripeService.refunds), 1)
        self.assertEqual(_FakeStripeService.refunds[0]["reason"], "requested_by_customer")

    def test_refund_payment_rejects_amount_above_refundable_balance_before_stripe(self):
        _FakeStripeService.reset()
        facade = _BillingFacade({
            "billing_payments": [{
                "id": "payment_1",
                "studio_id": "studio_1",
                "stripe_charge_id": "ch_1",
                "stripe_account_id": "acct_1",
                "amount_cents": 1200,
                "refunded_amount_cents": 1000,
            }]
        })
        manager = BillingPaymentManager(facade, stripe_service_cls=_FakeStripeService)

        with self.assertRaises(HTTPException) as context:
            asyncio.run(manager.refund_payment(
                "payment_1",
                BillingRefundCreate(amount_cents=500),
                "studio_1",
                "actor_1",
                "refund-key-1",
            ))

        self.assertEqual(context.exception.status_code, 409)
        self.assertIn("exceeds", context.exception.detail)
        self.assertEqual(_FakeStripeService.refunds, [])
        operation = next(iter(facade.supabase.billing_provider_operations.values()))
        self.assertEqual(operation["state"], "definitive_rejected")
        self.assertEqual(operation["provider_request_attempt_count"], 0)

    def test_same_amount_refunds_use_caller_idempotency_to_distinguish_operations(self):
        _FakeStripeService.reset()
        facade = _BillingFacade({
            "billing_payments": [{
                "id": "payment_1",
                "studio_id": "studio_1",
                "stripe_charge_id": "ch_1",
                "stripe_account_id": "acct_1",
                "amount_cents": 1200,
                "refunded_amount_cents": 0,
            }]
        })
        manager = BillingPaymentManager(facade, stripe_service_cls=_FakeStripeService)
        payload = BillingRefundCreate(amount_cents=500)

        asyncio.run(manager.refund_payment("payment_1", payload, "studio_1", "actor_1", "refund-key-1"))
        payment = facade.supabase.tables["billing_payments"][0]
        payment["refunded_amount_cents"] = 500
        payment["refundable_amount_cents"] = 700
        asyncio.run(manager.refund_payment("payment_1", payload, "studio_1", "actor_1", "refund-key-2"))
        asyncio.run(manager.refund_payment("payment_1", payload, "studio_1", "actor_1", "refund-key-1"))

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
        facade = _BillingFacade({
            "billing_payments": [{
                "id": "payment_1",
                "studio_id": "studio_1",
                "stripe_charge_id": "ch_1",
                "stripe_account_id": "acct_1",
                "amount_cents": 1200,
                "refunded_amount_cents": 0,
            }],
            "audit_logs": [],
        })
        manager = BillingPaymentManager(facade, stripe_service_cls=_FakeStripeService)

        asyncio.run(manager.refund_payment(
            "payment_1",
            BillingRefundCreate(amount_cents=500),
            "studio_1",
            "actor_1",
            "refund-key",
        ))
        with self.assertRaises(HTTPException) as conflict:
            asyncio.run(manager.refund_payment(
                "payment_1",
                BillingRefundCreate(amount_cents=600),
                "studio_1",
                "actor_1",
                "refund-key",
            ))

        self.assertEqual(conflict.exception.status_code, 409)
        self.assertEqual(len(_FakeStripeService.refunds), 1)
        self.assertEqual(len(facade.supabase.tables["audit_logs"]), 1)

    def test_new_refund_key_waits_while_prior_refund_is_unsettled(self):
        _FakeStripeService.reset()
        _FakeStripeService.refund_status = "pending"
        facade = _BillingFacade({
            "billing_payments": [{
                "id": "payment_1",
                "studio_id": "studio_1",
                "stripe_charge_id": "ch_1",
                "stripe_account_id": "acct_1",
                "amount_cents": 1200,
                "refunded_amount_cents": 0,
            }],
            "audit_logs": [],
        })
        manager = BillingPaymentManager(facade, stripe_service_cls=_FakeStripeService)
        payload = BillingRefundCreate(amount_cents=500)

        first = asyncio.run(manager.refund_payment(
            "payment_1", payload, "studio_1", "actor_1", "refund-key-1",
        ))
        replay = asyncio.run(manager.refund_payment(
            "payment_1", payload, "studio_1", "actor_1", "refund-key-1",
        ))
        with self.assertRaises(HTTPException) as unsettled:
            asyncio.run(manager.refund_payment(
                "payment_1", payload, "studio_1", "actor_1", "refund-key-2",
            ))

        self.assertEqual(first.status, "pending")
        self.assertEqual(replay.stripe_refund_id, first.stripe_refund_id)
        self.assertEqual(unsettled.exception.status_code, 409)
        self.assertIn("still settling", unsettled.exception.detail)
        self.assertEqual(len(_FakeStripeService.refunds), 1)
        self.assertEqual(len(facade.supabase.tables["audit_logs"]), 1)

    def test_new_refund_key_replaces_projected_failed_refund_owner(self):
        _FakeStripeService.reset()
        _FakeStripeService.refund_status = "failed"
        facade = _BillingFacade({
            "billing_payments": [{
                "id": "payment_1",
                "studio_id": "studio_1",
                "stripe_charge_id": "ch_1",
                "stripe_account_id": "acct_1",
                "amount_cents": 1200,
                "refunded_amount_cents": 0,
            }],
            "audit_logs": [],
        })
        manager = BillingPaymentManager(facade, stripe_service_cls=_FakeStripeService)
        payload = BillingRefundCreate(amount_cents=500)

        first = asyncio.run(manager.refund_payment(
            "payment_1", payload, "studio_1", "actor_1", "refund-key-1",
        ))
        second = asyncio.run(manager.refund_payment(
            "payment_1", payload, "studio_1", "actor_1", "refund-key-2",
        ))

        self.assertEqual(first.status, "failed")
        self.assertEqual(second.status, "failed")
        self.assertEqual(len(_FakeStripeService.refunds), 2)
        self.assertEqual(len(facade.supabase.billing_provider_operations), 2)

    def test_different_refund_keys_use_parent_state_without_payment_metadata_receipts(self):
        _FakeStripeService.reset()
        original_metadata = {"support_note": "keep"}
        facade = _BillingFacade({
            "billing_payments": [{
                "id": "payment_1",
                "studio_id": "studio_1",
                "stripe_charge_id": "ch_1",
                "stripe_account_id": "acct_1",
                "amount_cents": 1200,
                "refunded_amount_cents": 0,
                "metadata": dict(original_metadata),
            }],
            "audit_logs": [],
        })
        manager = BillingPaymentManager(facade, stripe_service_cls=_FakeStripeService)

        asyncio.run(manager.refund_payment(
            "payment_1",
            BillingRefundCreate(amount_cents=400),
            "studio_1",
            "actor_1",
            "refund-key-1",
        ))
        payment = facade.supabase.tables["billing_payments"][0]
        payment["refunded_amount_cents"] = 400
        payment["refundable_amount_cents"] = 800
        asyncio.run(manager.refund_payment(
            "payment_1",
            BillingRefundCreate(amount_cents=500),
            "studio_1",
            "actor_1",
            "refund-key-2",
        ))

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
        facade = _BillingFacade({
            "billing_payments": [{
                "id": "payment_1",
                "studio_id": "studio_1",
                "stripe_charge_id": "ch_1",
                "stripe_account_id": "acct_1",
                "amount_cents": 1200,
                "refunded_amount_cents": 0,
                "refundable_amount_cents": 1200,
                "metadata": {"support_note": "keep"},
            }],
            "audit_logs": [],
        })
        manager = BillingPaymentManager(facade, stripe_service_cls=_FakeStripeService)

        first = asyncio.run(manager.refund_payment(
            "payment_1",
            BillingRefundCreate(),
            "studio_1",
            "actor_1",
            "refund-key",
        ))
        payment = facade.supabase.tables["billing_payments"][0]
        payment["refunded_amount_cents"] = 1200
        payment["refundable_amount_cents"] = 0
        replay = asyncio.run(manager.refund_payment(
            "payment_1",
            BillingRefundCreate(),
            "studio_1",
            "actor_1",
            "refund-key",
        ))

        self.assertEqual(first.amount_cents, 1200)
        self.assertEqual(replay.amount_cents, 1200)
        self.assertEqual(len(_FakeStripeService.refunds), 1)
        operation = next(iter(facade.supabase.billing_provider_operations.values()))
        self.assertEqual(operation["result_summary"], "amount_cents:1200")
        self.assertEqual(payment["metadata"], {"support_note": "keep"})

    def test_refund_provider_success_local_failure_requires_reconciliation_without_retry(self):
        class FailingProjectionFacade(_BillingFacade):
            def _project_refund(self, refund: dict, account_id: str) -> dict:
                raise RuntimeError("local projection failed with private payload")

        _FakeStripeService.reset()
        facade = FailingProjectionFacade({
            "billing_payments": [{
                "id": "payment_1",
                "studio_id": "studio_1",
                "stripe_charge_id": "ch_1",
                "stripe_account_id": "acct_1",
                "amount_cents": 1200,
                "refunded_amount_cents": 0,
            }],
            "audit_logs": [],
        })
        manager = BillingPaymentManager(facade, stripe_service_cls=_FakeStripeService)

        with self.assertRaises(HTTPException) as failed:
            asyncio.run(manager.refund_payment(
                "payment_1",
                BillingRefundCreate(amount_cents=500),
                "studio_1",
                "actor_1",
                "refund-key",
            ))
        with self.assertRaises(HTTPException) as replay:
            asyncio.run(manager.refund_payment(
                "payment_1",
                BillingRefundCreate(amount_cents=500),
                "studio_1",
                "actor_1",
                "refund-key",
            ))

        self.assertEqual(failed.exception.status_code, 503)
        self.assertEqual(replay.exception.status_code, 409)
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
                facade = _BillingFacade({
                    "billing_payments": [{
                        "id": "payment_1",
                        "studio_id": "studio_1",
                        "stripe_charge_id": "ch_1",
                        "stripe_account_id": "acct_1",
                        "amount_cents": 1200,
                        "refunded_amount_cents": 0,
                    }],
                })
                manager = BillingPaymentManager(facade, stripe_service_cls=_FakeStripeService)

                with self.assertRaises(HTTPException):
                    asyncio.run(manager.refund_payment(
                        "payment_1",
                        BillingRefundCreate(amount_cents=500),
                        "studio_1",
                        "actor_1",
                        "refund-key",
                    ))
                with self.assertRaises(HTTPException):
                    asyncio.run(manager.refund_payment(
                        "payment_1",
                        BillingRefundCreate(amount_cents=500),
                        "studio_1",
                        "actor_1",
                        "refund-key",
                    ))

                self.assertEqual(len(_FakeStripeService.refunds), 1)
                operation = next(iter(facade.supabase.billing_provider_operations.values()))
                self.assertEqual(operation["state"], expected_state)
                self.assertNotIn("secret payload", repr(operation))

    def test_refund_rejects_cross_studio_generation_before_operation_or_provider(self):
        _FakeStripeService.reset()
        facade = _BillingFacade({
            "billing_payments": [{
                "id": "payment_1",
                "studio_id": "studio_1",
                "stripe_charge_id": "ch_1",
                "stripe_account_id": "acct_1",
                "connect_account_generation": 1,
                "amount_cents": 1200,
                "refunded_amount_cents": 0,
            }],
            "studio_payment_accounts": [{
                "studio_id": "studio_2",
                "stripe_connected_account_id": "acct_1",
                "charges_enabled": True,
                "metadata": {"connect_account_generation": 2},
            }],
        })

        with self.assertRaises(HTTPException) as context:
            asyncio.run(BillingPaymentManager(
                facade,
                stripe_service_cls=_FakeStripeService,
            ).refund_payment(
                "payment_1",
                BillingRefundCreate(amount_cents=500),
                "studio_1",
                "actor_1",
                "refund-key",
            ))

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
        facade = _BillingFacade({
            "billing_payments": [{
                "id": "payment_1",
                "studio_id": "studio_1",
                "invoice_id": "invoice_1",
                "stripe_charge_id": "ch_1",
                "stripe_account_id": "acct_1",
                "amount_cents": 1200,
                "refunded_amount_cents": 0,
            }],
            "billing_invoices": [invoice],
            "audit_logs": [],
        })
        manager = BillingPaymentManager(facade, stripe_service_cls=_FakeStripeService)

        first = asyncio.run(manager.refund_payment(
            "payment_1",
            BillingRefundCreate(amount_cents=500),
            "studio_1",
            "actor_1",
            "refund-key",
        ))
        replay = asyncio.run(manager.refund_payment(
            "payment_1",
            BillingRefundCreate(amount_cents=500),
            "studio_1",
            "actor_1",
            "refund-key",
        ))

        self.assertEqual(replay.id, first.id)
        self.assertEqual(len(_FakeStripeService.refunds), 1)
        self.assertEqual(len(facade.supabase.tables["audit_logs"]), 1)
        self.assertEqual(invoice["amount_remaining_cents"], 700)
        self.assertEqual(invoice["status"], "open")

    def test_refund_saved_result_mismatch_is_sanitized_for_completed_and_reconciled_for_projected(self):
        for operation_state in ("completed", "projected"):
            with self.subTest(operation_state=operation_state):
                _FakeStripeService.reset()
                facade = _BillingFacade({
                    "billing_payments": [{
                        "id": "payment_1",
                        "studio_id": "studio_1",
                        "stripe_charge_id": "ch_1",
                        "stripe_account_id": "acct_1",
                        "amount_cents": 1200,
                        "refunded_amount_cents": 0,
                        "metadata": {},
                    }],
                    "audit_logs": [],
                })
                manager = BillingPaymentManager(
                    facade,
                    stripe_service_cls=_FakeStripeService,
                )
                asyncio.run(manager.refund_payment(
                    "payment_1",
                    BillingRefundCreate(amount_cents=500),
                    "studio_1",
                    "actor_1",
                    "refund-key",
                ))
                operation = next(iter(facade.supabase.billing_provider_operations.values()))
                operation["state"] = operation_state
                facade.supabase.tables["billing_refunds"][0]["payment_id"] = "payment_other"

                with self.assertRaises(HTTPException) as mismatch:
                    asyncio.run(manager.refund_payment(
                        "payment_1",
                        BillingRefundCreate(amount_cents=500),
                        "studio_1",
                        "actor_1",
                        "refund-key",
                    ))

                self.assertEqual(mismatch.exception.status_code, 503)
                self.assertNotIn("payment_other", mismatch.exception.detail)
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
        facade = _BillingFacade({
            "billing_payments": [{
                "id": "payment_1",
                "studio_id": "studio_1",
                "stripe_charge_id": "ch_1",
                "stripe_account_id": "acct_1",
                "amount_cents": 1200,
                "refunded_amount_cents": 0,
            }]
        })
        manager = BillingPaymentManager(facade, stripe_service_cls=_FakeStripeService)
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
        facade = _BillingFacade({"export_jobs": []})
        facade.supabase.insert_defaults["export_jobs"] = {
            "status": "queued",
            "created_at": "2026-01-01T00:00:00Z",
            "updated_at": "2026-01-01T00:00:00Z",
        }
        manager = BillingPaymentManager(facade)

        created = asyncio.run(manager.create_export_job(
            ExportJobCreate(export_type="billing_payments", filters={"status": "paid"}),
            "studio_1",
            "actor_1",
        ))
        fetched = asyncio.run(manager.get_export_job(created.id, "studio_1"))

        self.assertEqual(fetched.status, "queued")
        self.assertEqual(fetched.metadata["filters"], {"status": "paid"})
        self.assertTrue(fetched.metadata["async_required"])

    def _refund_recovery(self, outcome, recovered_id=None):
        _FakeStripeService.reset()
        facade = _BillingFacade({
            "billing_payments": [{
                "id": "payment_1", "studio_id": "studio_1",
                "payer_id": "payer_1", "stripe_charge_id": "ch_1",
                "stripe_account_id": "acct_1", "connect_account_generation": 1,
                "amount_cents": 1200, "refunded_amount_cents": 0,
                "disputed_amount_cents": 0, "refundable_amount_cents": 1200,
                "status": "succeeded",
            }],
            "billing_refunds": [], "audit_logs": [],
        })
        manager = BillingPaymentManager(facade, stripe_service_cls=_FakeStripeService)
        payload = BillingRefundCreate(
            amount_cents=500, reason="requested_by_customer"
        )
        _FakeStripeService.refund_error = RuntimeError("lost refund response")
        with self.assertRaises(HTTPException):
            asyncio.run(manager.refund_payment(
                "payment_1", payload, "studio_1", "actor_1", "refund-recovery-key"
            ))
        operation = next(iter(facade.supabase.billing_provider_operations.values()))
        context = BillingProviderOperationContext(
            operation["id"], "studio_1", "actor_1", "payment.refund",
            operation["caller_request_key"], operation["request_sha256"],
            "acct_1", 1, str(operation["lease_owner"]),
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
        result = asyncio.run(manager.refund_payment(
            "payment_1", payload, "studio_1", "actor_1", "refund-recovery-key"
        ))
        self.assertEqual(result.amount_cents, 500)
        self.assertEqual(_FakeStripeService.refunds, [first, first])
        self.assertEqual(operation["provider_request_attempt_count"], 2)
        self.assertEqual(operation["state"], "completed")
        asyncio.run(manager.refund_payment(
            "payment_1", payload, "studio_1", "actor_1", "refund-recovery-key"
        ))
        self.assertEqual(len(_FakeStripeService.refunds), 2)

    def test_refund_reconcile_only_gets_exact_refund_without_second_mutation(self):
        facade, manager, operation, payload = self._refund_recovery(
            "provider_succeeded_reconcile_only", "re_recovered"
        )
        _FakeStripeService.refund_error = None
        _FakeStripeService.refund_response = {
            "id": "re_recovered", "charge": "ch_1", "amount": 500,
            "reason": "requested_by_customer", "status": "succeeded",
            "metadata": {
                "studio_id": "studio_1", "payment_id": "payment_1",
                "product": "koaryu_payments",
            },
        }
        result = asyncio.run(manager.refund_payment(
            "payment_1", payload, "studio_1", "actor_1", "refund-recovery-key"
        ))
        self.assertEqual(result.stripe_refund_id, "re_recovered")
        self.assertEqual(len(_FakeStripeService.refunds), 1)
        self.assertEqual(_FakeStripeService.retrieved_refunds, [{
            "account_id": "acct_1", "refund_id": "re_recovered"
        }])
        self.assertEqual(operation["provider_request_attempt_count"], 1)
        self.assertEqual(operation["state"], "completed")

    def test_refund_reconcile_only_wrong_charge_never_projects(self):
        facade, manager, operation, payload = self._refund_recovery(
            "provider_succeeded_reconcile_only", "re_recovered"
        )
        _FakeStripeService.refund_response = {
            "id": "re_recovered", "charge": "ch_wrong", "amount": 500,
            "reason": "requested_by_customer", "status": "succeeded",
            "metadata": {
                "studio_id": "studio_1", "payment_id": "payment_1",
                "product": "koaryu_payments",
            },
        }
        with self.assertRaises(HTTPException):
            asyncio.run(manager.refund_payment(
                "payment_1", payload, "studio_1", "actor_1",
                "refund-recovery-key",
            ))
        self.assertEqual(operation["state"], "reconciliation_required")
        self.assertEqual(facade.supabase.tables["billing_refunds"], [])
        self.assertEqual(len(_FakeStripeService.refunds), 1)
        self.assertEqual(facade.supabase.tables["audit_logs"], [])
