from __future__ import annotations

import asyncio
import unittest
from datetime import datetime, timezone

from fastapi import HTTPException
from postgrest.exceptions import APIError as PostgrestAPIError

from app.schemas.billing import BillingRefundCreate, ExportJobCreate, ExternalPaymentCreate
from app.services.billing_payments import (
    EXTERNAL_PAYMENT_IDEMPOTENCY_REQUIRED_DETAIL,
    EXTERNAL_PAYMENT_OVERPAY_DETAIL,
    BillingPaymentManager,
    build_external_payment_request_hash,
)
from app.services.platform_billing_helpers import MAX_IDEMPOTENCY_KEY_LENGTH, build_idempotency_key
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


class _BillingSupabase(RpcBackedSupabase):
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

    def _audit(self, studio_id: str, actor_id: str, action: str, entity_id: str, metadata: dict) -> None:
        self.supabase.table("audit_logs").insert({
            "studio_id": studio_id,
            "actor_id": actor_id,
            "action": action,
            "entity_id": entity_id,
            "metadata": metadata,
        }).execute()

    def _project_refund(self, refund: dict, account_id: str) -> dict:
        return {
            "id": "refund_local",
            "studio_id": refund["metadata"]["studio_id"],
            "payment_id": refund["metadata"]["payment_id"],
            "stripe_refund_id": refund["id"],
            "stripe_charge_id": refund["charge"],
            "stripe_account_id": account_id,
            "amount_cents": refund["amount"],
            "status": "succeeded",
            "reason": refund.get("reason"),
            "created_at": "2026-01-01T00:00:00Z",
        }


class _FakeStripeService:
    out_of_band_payments: list[dict] = []
    refunds: list[dict] = []
    pay_error: Exception | None = None

    @classmethod
    def reset(cls) -> None:
        cls.out_of_band_payments = []
        cls.refunds = []
        cls.pay_error = None

    def pay_connected_invoice(self, **payload):
        self.__class__.out_of_band_payments.append(payload)
        if self.__class__.pay_error:
            raise self.__class__.pay_error
        return {"id": payload["invoice_id"]}

    def create_connected_refund(self, **payload):
        self.__class__.refunds.append(payload)
        return {
            "id": "re_created",
            "charge": payload["charge_id"],
            "amount": payload["amount"],
            "reason": payload.get("reason"),
            "metadata": payload["metadata"],
        }


class BillingPaymentManagerTests(unittest.TestCase):
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
                "status": "succeeded",
                "amount_cents": 1000,
                "refunded_amount_cents": 400,
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
        self.assertEqual(summary.stripe_net_amount_cents, 21100)
        self.assertEqual(summary.external_net_amount_cents, 500)
        self.assertEqual(summary.net_amount_cents, 21600)
        self.assertEqual(summary.period_start, "2026-07-01T00:00:00+00:00")
        self.assertEqual(summary.period_end, "2026-08-01T00:00:00+00:00")
        self.assertIn("cumulative refunds", summary.disclosure)
        self.assertIn("not cash movement or true period-net revenue", summary.disclosure)

    def test_external_payment_request_hash_honors_empty_effective_payer_id(self):
        payload = ExternalPaymentCreate(
            payer_id="request-payer",
            amount_cents=500,
            external_method="cash",
        )

        request_payer_hash = build_external_payment_request_hash(payload, effective_payer_id=None)
        empty_effective_payer_hash = build_external_payment_request_hash(payload, effective_payer_id="")

        self.assertNotEqual(empty_effective_payer_hash, request_payer_hash)

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
        self.assertEqual(invoice["status"], "paid")
        self.assertEqual(invoice["amount_remaining_cents"], 0)
        self.assertEqual(invoice["application_fee_amount_cents"], 0)
        self.assertEqual(facade.balance_recomputes, [("studio_1", "payer_1")])
        self.assertEqual(_FakeStripeService.out_of_band_payments[0]["paid_out_of_band"], True)
        self.assertEqual(_FakeStripeService.out_of_band_payments[0]["idempotency_key"], "koaryu:external-invoice-pay:billing_payments_2")
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

    def test_external_payment_defers_paid_invoice_status_when_stripe_sync_fails_then_retries(self):
        _FakeStripeService.reset()
        _FakeStripeService.pay_error = RuntimeError("Stripe unavailable")
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
        manager = BillingPaymentManager(facade, stripe_service_cls=_FakeStripeService)
        payload = ExternalPaymentCreate(
            invoice_id="invoice_1",
            amount_cents=1000,
            external_method="check",
        )

        first = asyncio.run(manager.record_external_payment(payload, "studio_1", "actor_1", "payment-key-1"))

        invoice = facade.supabase.tables["billing_invoices"][0]
        self.assertEqual(first.status, "externally_recorded")
        self.assertEqual(invoice["status"], "open")
        self.assertEqual(invoice["amount_paid_cents"], 0)
        self.assertEqual(invoice["amount_remaining_cents"], 1000)
        self.assertIsNone(invoice.get("paid_at"))
        self.assertIn("Stripe sync failed", invoice["last_payment_error"])
        self.assertNotIn("Stripe unavailable", invoice["last_payment_error"])
        self.assertRegex(invoice["last_payment_error"], r"Reference: [0-9a-f]{32}$")
        self.assertEqual(facade.supabase.rpc_calls, [])
        self.assertEqual(len(facade.supabase.tables["billing_payments"]), 1)
        self.assertEqual(len(facade.supabase.tables["audit_logs"]), 1)

        _FakeStripeService.pay_error = None
        second = asyncio.run(manager.record_external_payment(payload, "studio_1", "actor_1", "payment-key-1"))

        invoice = facade.supabase.tables["billing_invoices"][0]
        self.assertEqual(first.id, second.id)
        self.assertEqual(invoice["status"], "paid")
        self.assertEqual(invoice["amount_paid_cents"], 1000)
        self.assertEqual(invoice["amount_remaining_cents"], 0)
        self.assertIsNone(invoice.get("last_payment_error"))
        self.assertEqual(len(_FakeStripeService.out_of_band_payments), 2)
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
        self.assertEqual(_FakeStripeService.refunds[0]["idempotency_key"], "koaryu:refund:studio_1:payment_1:refund-key-1")
        self.assertEqual(facade.supabase.tables["audit_logs"][0]["action"], "billing.payment_refunded")

    def test_refund_payment_requires_request_idempotency_key(self):
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

        with self.assertRaises(HTTPException) as context:
            asyncio.run(manager.refund_payment(
                "payment_1",
                BillingRefundCreate(amount_cents=500),
                "studio_1",
                "actor_1",
            ))

        self.assertEqual(context.exception.status_code, 400)
        self.assertIn("Idempotency-Key is required", context.exception.detail)

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
        asyncio.run(manager.refund_payment("payment_1", payload, "studio_1", "actor_1", "refund-key-2"))
        asyncio.run(manager.refund_payment("payment_1", payload, "studio_1", "actor_1", "refund-key-1"))

        self.assertEqual(
            [refund["idempotency_key"] for refund in _FakeStripeService.refunds],
            [
                "koaryu:refund:studio_1:payment_1:refund-key-1",
                "koaryu:refund:studio_1:payment_1:refund-key-2",
                "koaryu:refund:studio_1:payment_1:refund-key-1",
            ],
        )

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
        self.assertTrue(all(key.startswith("koaryu:refund:") for key in keys))

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
