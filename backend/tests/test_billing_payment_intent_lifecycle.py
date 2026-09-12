from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from unittest.mock import call, patch

from fastapi import HTTPException

from app.schemas.billing import BillingReconcileRequest
from app.services.billing_payments import BillingPaymentManager
from tests.billing_lifecycle_helpers import (
    BillingPaymentsLifecycleTestBase,
    _FakeSupabase,
)


class BillingPaymentIntentLifecycleTest(BillingPaymentsLifecycleTestBase):
    def payment_facts_fixture(self):
        service = self.service()
        service.supabase = _FakeSupabase(
            {
                "studio_payment_accounts": [
                    {
                        "studio_id": "studio_1",
                        "stripe_connected_account_id": "acct_1",
                        "metadata": {"connect_account_generation": 1},
                        "charges_enabled": True,
                        "requirements_due": [],
                        "updated_at": datetime.now(timezone.utc).isoformat(),
                    }
                ],
                "billing_payers": [
                    {
                        "id": "payer_1",
                        "studio_id": "studio_1",
                        "stripe_account_id": "acct_1",
                        "stripe_customer_id": "cus_1",
                        "balance_cents": 0,
                    }
                ],
                "billing_payments": [],
                "billing_invoices": [],
                "billing_refunds": [],
                "billing_disputes": [],
                "audit_logs": [],
            }
        )
        intent = {
            "id": "pi_1",
            "status": "succeeded",
            "amount": 1000,
            "amount_received": 1000,
            "created": int(datetime(2026, 1, 1, tzinfo=timezone.utc).timestamp()),
            "currency": "usd",
            "customer": "cus_1",
            "latest_charge": "ch_1",
            "metadata": {"studio_id": "studio_1", "payer_id": "payer_1"},
        }
        return service, intent

    def test_success_sources_keep_one_payment_in_its_original_utc_month(self):
        collected = datetime(2026, 6, 30, 23, 59, 59, tzinfo=timezone.utc)
        observed = datetime(2026, 7, 10, tzinfo=timezone.utc)
        for first_source in ("payment_intent", "invoice"):
            with self.subTest(first_source=first_source):
                service, intent = self.payment_facts_fixture()
                invoice = {
                    "id": "in_1",
                    "payment_intent": "pi_1",
                    "amount_paid": 1000,
                    "currency": "usd",
                    "customer": "cus_1",
                    "metadata": intent["metadata"],
                    "status_transitions": {"paid_at": int(collected.timestamp())},
                }
                local_invoice = {"stripe_account_id": "acct_1", "paid_at": collected.isoformat()}
                with (
                    patch(
                        "app.services.billing_payment_projection.datetime", wraps=datetime
                    ) as clock,
                    patch(
                        "app.services.billing_service.StripeService",
                    ) as provider,
                ):
                    clock.now.return_value = observed
                    provider.return_value.retrieve_connected_payment_intent.return_value = intent
                    payment_events = service._webhook_projector()._payment_events()
                    if first_source == "invoice":
                        payment_events._project_payment_from_invoice(
                            invoice,
                            "acct_1",
                            local_invoice,
                            event_created=int(observed.timestamp()),
                        )
                    else:
                        service._project_payment_intent(
                            intent, "acct_1", "payment_intent.succeeded", int(collected.timestamp())
                        )
                    payment_events._project_payment_from_invoice(
                        invoice, "acct_1", local_invoice, event_created=int(observed.timestamp())
                    )
                    service._project_payment_intent(
                        intent, "acct_1", "payment_intent.succeeded", int(observed.timestamp())
                    )
                    service._project_payment_intent(intent, "acct_1", "payment_intent.succeeded")

                payments = service.supabase.tables["billing_payments"]
                self.assertEqual(len(payments), 1)
                self.assertEqual(payments[0]["processed_at"], collected.isoformat())
                manager = BillingPaymentManager(service)
                june = asyncio.run(
                    manager.current_month_payment_cohort_summary("studio_1", as_of=collected)
                )
                july = asyncio.run(
                    manager.current_month_payment_cohort_summary("studio_1", as_of=observed)
                )
                self.assertEqual((june.payment_count, june.net_amount_cents), (1, 1000))
                self.assertEqual((july.payment_count, july.net_amount_cents), (0, 0))

    def test_timestamp_initialization_keeps_a_concurrent_winner_and_newer_event_guard(self):
        for winner_event in (150, 300):
            with self.subTest(winner_event=winner_event):
                service, intent = self.payment_facts_fixture()
                service._project_payment_intent(intent, "acct_1", "payment_intent.processing", 100)
                winner_time = "2026-06-30T23:59:59+00:00"

                def concurrent_success(rows):
                    rows[0].update(
                        {
                            "processed_at": winner_time,
                            "last_stripe_event_created": winner_event,
                            "status": "succeeded",
                            "amount_cents": 1000,
                            "net_collected_amount_cents": 1000,
                            "refundable_amount_cents": 1000,
                        }
                    )

                service.supabase.before_update = concurrent_success
                service.supabase.query_log.clear()
                service._project_payment_intent(intent, "acct_1", "payment_intent.succeeded", 200)
                payment = service.supabase.tables["billing_payments"][0]
                self.assertEqual(payment["processed_at"], winner_time)
                self.assertEqual(payment["last_stripe_event_created"], max(200, winner_event))
                updates = [
                    query
                    for query in service.supabase.query_log
                    if query["table"] == "billing_payments"
                    and (query["update"] or {}).get("last_stripe_event_created") == 200
                ]
                self.assertGreaterEqual(len(updates), 1)
                self.assertLessEqual(len(updates), 2)
                self.assertIn(("is", "processed_at", "null"), updates[0]["filters"])
                for query in updates[1:]:
                    self.assertNotIn("processed_at", query["update"])
                    self.assertEqual(query["or_filters"], updates[0]["or_filters"])

    def test_broad_reconciliation_refuses_uncaptured_authorization(self):
        service, intent = self.payment_facts_fixture()
        intent.update(status="requires_capture", amount_received=0)
        with patch("app.services.billing_service.StripeService") as provider:
            provider.return_value.retrieve_account.return_value = {
                "id": "acct_1",
                "charges_enabled": True,
                "payouts_enabled": True,
                "details_submitted": True,
                "requirements": {"currently_due": []},
            }
            provider.return_value.retrieve_connected_payment_intent.return_value = intent
            with self.assertRaises(HTTPException) as raised:
                asyncio.run(
                    service.reconcile_stripe_object(
                        BillingReconcileRequest(
                            object_type="payment_intent", stripe_object_id="pi_1"
                        ),
                        "studio_1",
                        "user_1",
                    )
                )
        self.assertEqual(raised.exception.status_code, 409)
        self.assertIn("captur", raised.exception.detail)
        self.assertEqual(
            provider.return_value.method_calls,
            [
                call.retrieve_account(account_id="acct_1"),
                call.retrieve_connected_payment_intent(
                    account_id="acct_1",
                    payment_intent_id="pi_1",
                    expand=["latest_charge", "payment_method"],
                ),
            ],
        )
        self.assertEqual(service.supabase.tables["billing_payments"], [])
        self.assertEqual(service.supabase.tables["billing_invoices"], [])
        self.assertEqual(service.supabase.tables["audit_logs"], [])

    def test_success_without_provider_time_keeps_its_first_observation(self):
        service, intent = self.payment_facts_fixture()
        first_seen = datetime(2026, 6, 30, 23, 59, 59, tzinfo=timezone.utc)
        with patch("app.services.billing_payment_projection.datetime", wraps=datetime) as clock:
            clock.now.return_value = first_seen
            service._project_payment_intent(intent, "acct_1", "payment_intent.succeeded")
            clock.now.return_value = datetime(2026, 7, 2, tzinfo=timezone.utc)
            service._project_payment_intent(intent, "acct_1", "payment_intent.succeeded")
        self.assertEqual(
            service.supabase.tables["billing_payments"][0]["processed_at"], first_seen.isoformat()
        )

    def test_explicit_zero_received_cannot_pay_a_positive_invoice(self):
        service, intent = self.payment_facts_fixture()
        intent.update(invoice="in_1", amount_received=0)
        invoice = {
            "id": "invoice_1",
            "studio_id": "studio_1",
            "payer_id": "payer_1",
            "stripe_account_id": "acct_1",
            "stripe_invoice_id": "in_1",
            "status": "open",
            "amount_due_cents": 1000,
            "amount_paid_cents": 0,
            "amount_remaining_cents": 1000,
            "currency": "usd",
        }
        service.supabase.tables["billing_invoices"] = [invoice]
        service._project_payment_intent(intent, "acct_1", "payment_intent.succeeded", 100)
        payment = service.supabase.tables["billing_payments"][0]
        self.assertEqual(payment["amount_cents"], 0)
        self.assertEqual(payment["net_collected_amount_cents"], 0)
        self.assertEqual(payment["refundable_amount_cents"], 0)
        self.assertEqual((invoice["status"], invoice["amount_remaining_cents"]), ("open", 1000))

    def test_later_processing_or_failure_preserves_collected_money_and_adjustments(self):
        for terminal in ("succeeded", "refunded", "disputed"):
            for incoming in ("processing", "payment_failed"):
                with self.subTest(terminal=terminal, incoming=incoming):
                    service, intent = self.payment_facts_fixture()
                    payment_events = service._webhook_projector()._payment_events()
                    # A partial capture can collect less than the intended amount.
                    intent["amount"] = 2000
                    service._project_payment_intent(
                        intent, "acct_1", "payment_intent.succeeded", 100
                    )
                    if terminal == "refunded":
                        service._project_refund(
                            {
                                "id": "re_1",
                                "charge": "ch_1",
                                "payment_intent": "pi_1",
                                "amount": 1000,
                                "currency": "usd",
                                "status": "succeeded",
                                "metadata": {"studio_id": "studio_1"},
                            },
                            "acct_1",
                        )
                    elif terminal == "disputed":
                        payment_events._project_dispute(
                            {
                                "id": "dp_1",
                                "charge": "ch_1",
                                "amount": 1000,
                                "currency": "usd",
                                "status": "needs_response",
                                "metadata": {"studio_id": "studio_1"},
                            },
                            "acct_1",
                        )
                    payment = service.supabase.tables["billing_payments"][0]
                    expected = {
                        key: payment[key]
                        for key in (
                            "id",
                            "status",
                            "processed_at",
                            "amount_cents",
                            "refunded_amount_cents",
                            "disputed_amount_cents",
                            "net_collected_amount_cents",
                            "refundable_amount_cents",
                        )
                    }
                    self.assertEqual(expected["status"], terminal)
                    self.assertEqual(expected["amount_cents"], 1000)
                    self.assertEqual(
                        expected["net_collected_amount_cents"],
                        1000 if terminal == "succeeded" else 0,
                    )
                    service._project_payment_intent(
                        {**intent, "amount_received": 0, "status": incoming},
                        "acct_1",
                        f"payment_intent.{incoming}",
                        200,
                    )
                    actual = service.supabase.tables["billing_payments"][0]
                    self.assertEqual({key: actual[key] for key in expected}, expected)
                    self.assertEqual(
                        actual["last_stripe_event_created"],
                        200,
                        "the newer observation must reach projection rather than pass by stale-event rejection",
                    )

    def test_succeeded_payment_without_latest_charge_is_not_refundable(self):
        service = self.service()
        service.supabase = _FakeSupabase(
            {
                "studio_payment_accounts": [
                    {
                        "studio_id": "studio_1",
                        "stripe_connected_account_id": "acct_1",
                        "metadata": {"connect_account_generation": 1},
                    }
                ],
                "billing_payers": [
                    {
                        "id": "payer_1",
                        "studio_id": "studio_1",
                        "stripe_account_id": "acct_1",
                        "stripe_customer_id": "cus_1",
                    }
                ],
                "billing_payments": [],
                "billing_invoices": [],
                "billing_refunds": [],
                "billing_disputes": [],
            }
        )
        service._recompute_payer_balance = lambda *_args: None

        service._project_payment_intent(
            {
                "id": "pi_no_charge",
                "amount": 12900,
                "amount_received": 12900,
                "currency": "usd",
                "customer": "cus_1",
                "metadata": {"studio_id": "studio_1", "payer_id": "payer_1"},
            },
            "acct_1",
            "payment_intent.succeeded",
            event_created=100,
        )

        payment = service.supabase.tables["billing_payments"][0]
        self.assertEqual(payment["status"], "succeeded")
        self.assertIsNone(payment["stripe_charge_id"])
        self.assertEqual(payment["net_collected_amount_cents"], 12900)
        self.assertEqual(payment["refundable_amount_cents"], 0)

    def test_invoice_payment_intent_retrieval_failure_projects_nonrefundable_fallback(self):
        service = self.service()
        local_invoice = {
            "id": "invoice_1",
            "studio_id": "studio_1",
            "payer_id": "payer_1",
            "stripe_invoice_id": "in_1",
            "stripe_payment_intent_id": "pi_1",
            "stripe_account_id": "acct_1",
            "status": "paid",
            "amount_due_cents": 200,
            "amount_paid_cents": 200,
            "amount_remaining_cents": 0,
            "currency": "usd",
            "application_fee_amount_cents": 0,
            "paid_at": "2026-05-18T00:00:00Z",
        }
        service.supabase = _FakeSupabase(
            {
                "studio_payment_accounts": [
                    {
                        "studio_id": "studio_1",
                        "stripe_connected_account_id": "acct_1",
                        "metadata": {"connect_account_generation": 1},
                    }
                ],
                "billing_payers": [
                    {
                        "id": "payer_1",
                        "studio_id": "studio_1",
                        "stripe_account_id": "acct_1",
                        "stripe_customer_id": "cus_1",
                        "billing_status": "current",
                        "balance_cents": 0,
                    }
                ],
                "billing_invoices": [local_invoice],
                "billing_payments": [],
                "billing_refunds": [],
                "billing_disputes": [],
            }
        )

        with patch("app.services.billing_service.StripeService") as provider:
            provider.return_value.retrieve_connected_payment_intent.side_effect = RuntimeError(
                "transient retrieval failure"
            )
            payment_events = service._webhook_projector()._payment_events()
            payment_events._project_payment_from_invoice(
                {
                    "id": "in_1",
                    "payment_intent": "pi_1",
                    "amount_paid": 200,
                    "currency": "usd",
                    "customer": "cus_1",
                    "metadata": {"studio_id": "studio_1", "payer_id": "payer_1"},
                },
                "acct_1",
                local_invoice,
                event_created=100,
            )

        payment = service.supabase.tables["billing_payments"][0]
        self.assertEqual(payment["status"], "succeeded")
        self.assertIsNone(payment["stripe_charge_id"])
        self.assertEqual(payment["net_collected_amount_cents"], 200)
        self.assertEqual(payment["refundable_amount_cents"], 0)
        self.assertEqual(local_invoice["amount_remaining_cents"], 0)
        self.assertEqual(payment["processed_at"], "2026-05-18T00:00:00Z")
        provider.return_value.retrieve_connected_payment_intent.assert_called_once()

    def test_processing_then_succeeded_payment_has_exact_accounting(self):
        service = self.service()
        service.supabase = _FakeSupabase(
            {
                "studio_payment_accounts": [
                    {
                        "studio_id": "studio_1",
                        "stripe_connected_account_id": "acct_1",
                        "metadata": {"connect_account_generation": 1},
                    }
                ],
                "billing_payers": [
                    {
                        "id": "payer_1",
                        "studio_id": "studio_1",
                        "stripe_account_id": "acct_1",
                        "stripe_customer_id": "cus_1",
                    }
                ],
                "billing_payments": [],
                "billing_invoices": [],
                "billing_refunds": [],
                "billing_disputes": [],
            }
        )
        intent = {
            "id": "pi_1",
            "amount": 12900,
            "currency": "usd",
            "customer": "cus_1",
            "latest_charge": "ch_1",
            "metadata": {"studio_id": "studio_1", "payer_id": "payer_1"},
        }

        service._project_payment_intent(
            intent,
            "acct_1",
            "payment_intent.processing",
            event_created=100,
        )
        processing = service.supabase.tables["billing_payments"][0]
        self.assertEqual(processing["status"], "processing")
        self.assertEqual(processing["net_collected_amount_cents"], 0)
        self.assertEqual(processing["refundable_amount_cents"], 0)

        service._project_payment_intent(
            {**intent, "amount_received": 12900},
            "acct_1",
            "payment_intent.succeeded",
            event_created=200,
        )
        succeeded = service.supabase.tables["billing_payments"][0]
        self.assertEqual(succeeded["status"], "succeeded")
        self.assertEqual(succeeded["refunded_amount_cents"], 0)
        self.assertEqual(succeeded["disputed_amount_cents"], 0)
        self.assertEqual(succeeded["net_collected_amount_cents"], 12900)
        self.assertEqual(succeeded["refundable_amount_cents"], 12900)

    def test_failed_payment_has_zero_collected_and_refundable_amounts(self):
        service = self.service()
        service.supabase = _FakeSupabase(
            {
                "studio_payment_accounts": [
                    {
                        "studio_id": "studio_1",
                        "stripe_connected_account_id": "acct_1",
                        "metadata": {"connect_account_generation": 1},
                    }
                ],
                "billing_payers": [
                    {
                        "id": "payer_1",
                        "studio_id": "studio_1",
                        "stripe_account_id": "acct_1",
                        "stripe_customer_id": "cus_1",
                    }
                ],
                "billing_payments": [],
                "billing_invoices": [],
                "billing_refunds": [],
                "billing_disputes": [],
            }
        )

        service._project_payment_intent(
            {
                "id": "pi_failed",
                "amount": 12900,
                "currency": "usd",
                "customer": "cus_1",
                "metadata": {"studio_id": "studio_1", "payer_id": "payer_1"},
            },
            "acct_1",
            "payment_intent.payment_failed",
            event_created=100,
        )

        payment = service.supabase.tables["billing_payments"][0]
        self.assertEqual(payment["status"], "failed")
        self.assertEqual(payment["net_collected_amount_cents"], 0)
        self.assertEqual(payment["refundable_amount_cents"], 0)

    def test_delayed_payment_projection_after_reconnect_preserves_established_identity(self):
        service = self.service()
        service.supabase = _FakeSupabase(
            {
                "studio_payment_accounts": [
                    {
                        "studio_id": "studio_1",
                        "stripe_connected_account_id": "acct_1",
                        "metadata": {"connect_account_generation": 2},
                    }
                ],
                "billing_payers": [],
                "billing_invoices": [],
                "billing_refunds": [],
                "billing_disputes": [],
                "billing_payments": [
                    {
                        "id": "payment_1",
                        "studio_id": "studio_1",
                        "payer_id": "payer_original",
                        "invoice_id": "invoice_original",
                        "stripe_customer_id": "cus_original",
                        "stripe_invoice_id": "in_original",
                        "stripe_payment_intent_id": "pi_1",
                        "stripe_charge_id": "ch_original",
                        "stripe_account_id": "acct_1",
                        "connect_account_generation": 1,
                        "stripe_payment_method_id": "pm_original",
                        "status": "succeeded",
                        "amount_cents": 12900,
                        "refunded_amount_cents": 0,
                        "disputed_amount_cents": 0,
                        "net_collected_amount_cents": 12900,
                        "refundable_amount_cents": 12900,
                        "last_stripe_event_created": 100,
                    }
                ],
            }
        )
        service._recompute_payer_balance = lambda *_args: None

        service._project_payment_intent(
            {
                "id": "pi_1",
                "amount": 12900,
                "amount_received": 12900,
                "currency": "usd",
                "customer": "cus_replayed",
                "invoice": "in_replayed",
                "latest_charge": "ch_replayed",
                "payment_method": "pm_replayed",
                "metadata": {
                    "studio_id": "studio_1",
                    "payer_id": "payer_replayed",
                    "product": "koaryu_payments",
                },
            },
            "acct_1",
            "payment_intent.succeeded",
            event_created=200,
        )

        payment = service.supabase.tables["billing_payments"][0]
        self.assertEqual(payment["payer_id"], "payer_original")
        self.assertEqual(payment["invoice_id"], "invoice_original")
        self.assertEqual(payment["stripe_customer_id"], "cus_original")
        self.assertEqual(payment["stripe_invoice_id"], "in_original")
        self.assertEqual(payment["stripe_payment_intent_id"], "pi_1")
        self.assertEqual(payment["stripe_charge_id"], "ch_original")
        self.assertEqual(payment["stripe_account_id"], "acct_1")
        self.assertEqual(payment["connect_account_generation"], 1)
        self.assertEqual(payment["stripe_payment_method_id"], "pm_original")

    def test_stale_failed_payment_intent_does_not_regress_succeeded_payment(self):
        service = self.service()
        service.supabase = _FakeSupabase(
            {
                "billing_payments": [
                    {
                        "id": "payment_1",
                        "studio_id": "studio_1",
                        "stripe_account_id": "acct_1",
                        "stripe_payment_intent_id": "pi_1",
                        "status": "succeeded",
                        "processed_at": "2026-04-28T00:00:00Z",
                        "last_stripe_event_created": 200,
                    }
                ],
                "billing_invoices": [],
                "billing_disputes": [],
                "billing_payers": [],
            }
        )

        service._project_payment_intent(
            {
                "id": "pi_1",
                "amount": 12900,
                "currency": "usd",
                "metadata": {"studio_id": "studio_1"},
                "last_payment_error": {"message": "Declined"},
            },
            "acct_1",
            "payment_intent.payment_failed",
            event_created=100,
        )

        self.assertEqual(service.supabase.tables["billing_payments"][0]["status"], "succeeded")
        self.assertEqual(
            service.supabase.tables["billing_payments"][0]["processed_at"], "2026-04-28T00:00:00Z"
        )
        self.assertIsNone(service.supabase.tables["billing_payments"][0].get("failure_message"))

    def test_payment_intent_event_records_event_created_for_ordering(self):
        service = self.service()
        service.supabase = _FakeSupabase(
            {
                "studio_payment_accounts": [
                    {
                        "studio_id": "studio_1",
                        "stripe_connected_account_id": "acct_1",
                    }
                ],
                "billing_payments": [],
                "billing_invoices": [],
                "billing_disputes": [],
                "billing_payers": [
                    {
                        "id": "payer_1",
                        "studio_id": "studio_1",
                        "stripe_account_id": "acct_1",
                        "stripe_customer_id": "cus_1",
                    }
                ],
            }
        )

        service.project_connect_event(
            {
                "id": "evt_pi_1",
                "account": "acct_1",
                "created": 300,
                "type": "payment_intent.succeeded",
                "data": {
                    "object": {
                        "id": "pi_1",
                        "status": "succeeded",
                        "amount": 12900,
                        "amount_received": 12900,
                        "currency": "usd",
                        "customer": "cus_1",
                        "metadata": {
                            "studio_id": "studio_1",
                            "payer_id": "payer_1",
                        },
                    }
                },
            }
        )

        payment = service.supabase.tables["billing_payments"][0]
        self.assertEqual(payment["status"], "succeeded")
        self.assertEqual(payment["last_stripe_event_created"], 300)

    def test_stale_payment_intent_event_does_not_overwrite_newer_invoice(self):
        service = self.service()
        service.supabase = _FakeSupabase(
            {
                "billing_invoices": [
                    {
                        "id": "invoice_1",
                        "studio_id": "studio_1",
                        "payer_id": "payer_1",
                        "stripe_invoice_id": "in_1",
                        "stripe_account_id": "acct_1",
                        "status": "open",
                        "amount_due_cents": 12900,
                        "amount_paid_cents": 0,
                        "amount_remaining_cents": 12900,
                        "currency": "usd",
                        "last_stripe_event_created": 300,
                    }
                ],
                "billing_payments": [],
                "billing_disputes": [],
                "billing_payers": [
                    {
                        "id": "payer_1",
                        "studio_id": "studio_1",
                        "billing_status": "past_due",
                        "balance_cents": 12900,
                    }
                ],
            }
        )

        service._project_payment_intent(
            {
                "id": "pi_1",
                "status": "succeeded",
                "amount": 12900,
                "amount_received": 12900,
                "currency": "usd",
                "customer": "cus_1",
                "invoice": "in_1",
                "metadata": {"studio_id": "studio_1", "payer_id": "payer_1"},
            },
            "acct_1",
            "payment_intent.succeeded",
            event_created=200,
        )

        invoice = service.supabase.tables["billing_invoices"][0]
        self.assertEqual(invoice["status"], "open")
        self.assertEqual(invoice["amount_paid_cents"], 0)
        self.assertEqual(invoice["amount_remaining_cents"], 12900)
        self.assertEqual(invoice["last_stripe_event_created"], 300)

    def test_stale_payment_intent_event_with_dispute_does_not_refresh_newer_invoice(self):
        service = self.service()
        service.supabase = _FakeSupabase(
            {
                "billing_invoices": [
                    {
                        "id": "invoice_1",
                        "studio_id": "studio_1",
                        "payer_id": "payer_1",
                        "stripe_invoice_id": "in_1",
                        "stripe_account_id": "acct_1",
                        "status": "paid",
                        "amount_due_cents": 12900,
                        "amount_paid_cents": 12900,
                        "amount_remaining_cents": 0,
                        "currency": "usd",
                        "paid_at": "2026-05-18T00:00:00Z",
                        "last_stripe_event_created": 300,
                    }
                ],
                "billing_payments": [],
                "billing_disputes": [
                    {
                        "id": "dispute_1",
                        "studio_id": "studio_1",
                        "stripe_account_id": "acct_1",
                        "stripe_charge_id": "ch_1",
                        "payment_id": None,
                        "stripe_payment_intent_id": None,
                        "status": "needs_response",
                    }
                ],
                "billing_payers": [
                    {
                        "id": "payer_1",
                        "studio_id": "studio_1",
                        "billing_status": "current",
                        "balance_cents": 0,
                    }
                ],
            }
        )

        service._project_payment_intent(
            {
                "id": "pi_1",
                "status": "succeeded",
                "amount": 12900,
                "amount_received": 12900,
                "currency": "usd",
                "customer": "cus_1",
                "invoice": "in_1",
                "latest_charge": "ch_1",
                "metadata": {"studio_id": "studio_1", "payer_id": "payer_1"},
            },
            "acct_1",
            "payment_intent.succeeded",
            event_created=200,
        )

        invoice = service.supabase.tables["billing_invoices"][0]
        dispute = service.supabase.tables["billing_disputes"][0]
        self.assertEqual(invoice["status"], "paid")
        self.assertEqual(invoice["amount_paid_cents"], 12900)
        self.assertEqual(invoice["amount_remaining_cents"], 0)
        self.assertEqual(invoice["last_stripe_event_created"], 300)
        self.assertIsNone(dispute["payment_id"])

    def test_newer_payment_intent_event_advances_invoice_watermark(self):
        service = self.service()
        service.supabase = _FakeSupabase(
            {
                "billing_invoices": [
                    {
                        "id": "invoice_1",
                        "studio_id": "studio_1",
                        "payer_id": "payer_1",
                        "stripe_invoice_id": "in_1",
                        "stripe_account_id": "acct_1",
                        "status": "open",
                        "amount_due_cents": 12900,
                        "amount_paid_cents": 0,
                        "amount_remaining_cents": 12900,
                        "currency": "usd",
                        "last_stripe_event_created": 100,
                    }
                ],
                "billing_payments": [],
                "billing_disputes": [],
                "billing_payers": [
                    {
                        "id": "payer_1",
                        "studio_id": "studio_1",
                        "billing_status": "past_due",
                        "balance_cents": 12900,
                    }
                ],
            }
        )

        service._project_payment_intent(
            {
                "id": "pi_1",
                "status": "succeeded",
                "amount": 12900,
                "amount_received": 12900,
                "currency": "usd",
                "customer": "cus_1",
                "invoice": "in_1",
                "metadata": {"studio_id": "studio_1", "payer_id": "payer_1"},
            },
            "acct_1",
            "payment_intent.succeeded",
            event_created=300,
        )

        service._project_invoice_event(
            {
                "id": "in_1",
                "status": "open",
                "amount_due": 12900,
                "amount_paid": 0,
                "amount_remaining": 12900,
                "currency": "usd",
                "metadata": {"studio_id": "studio_1", "payer_id": "payer_1"},
            },
            "acct_1",
            "invoice.finalized",
            event_created=200,
        )

        invoice = service.supabase.tables["billing_invoices"][0]
        self.assertEqual(invoice["status"], "paid")
        self.assertEqual(invoice["amount_paid_cents"], 12900)
        self.assertEqual(invoice["amount_remaining_cents"], 0)
        self.assertEqual(invoice["last_stripe_event_created"], 300)

    def test_payment_intent_without_invoice_id_does_not_match_open_invoice_by_customer_amount(self):
        service = self.service()
        service.supabase = _FakeSupabase(
            {
                "billing_payments": [],
                "billing_invoices": [
                    {
                        "id": "invoice_1",
                        "studio_id": "studio_1",
                        "payer_id": "payer_1",
                        "stripe_invoice_id": "in_1",
                        "stripe_account_id": "acct_1",
                        "stripe_customer_id": "cus_1",
                        "status": "open",
                        "amount_due_cents": 50,
                        "amount_paid_cents": 0,
                        "amount_remaining_cents": 50,
                        "currency": "usd",
                        "application_fee_amount_cents": 0,
                        "created_at": "2026-05-18T19:00:00Z",
                    }
                ],
                "billing_disputes": [],
                "billing_payers": [{"id": "payer_1", "studio_id": "studio_1"}],
            }
        )

        service._project_payment_intent(
            {
                "id": "pi_1",
                "status": "succeeded",
                "amount": 50,
                "amount_received": 50,
                "application_fee_amount": 1,
                "currency": "usd",
                "customer": "cus_1",
                "latest_charge": "ch_1",
                "payment_method_types": ["card"],
                "metadata": {},
            },
            "acct_1",
            "payment_intent.succeeded",
        )

        invoice = service.supabase.tables["billing_invoices"][0]
        self.assertEqual(service.supabase.tables["billing_payments"], [])
        self.assertEqual(invoice["status"], "open")
        self.assertIsNone(invoice.get("stripe_payment_intent_id"))
        self.assertEqual(invoice["application_fee_amount_cents"], 0)
        self.assertEqual(invoice["amount_paid_cents"], 0)

    def test_metadata_empty_payment_intent_derives_payer_from_connected_customer(self):
        service = self.service()
        service.supabase = _FakeSupabase(
            {
                "studio_payment_accounts": [
                    {
                        "studio_id": "studio_1",
                        "stripe_connected_account_id": "acct_1",
                    }
                ],
                "billing_payers": [
                    {
                        "id": "payer_1",
                        "studio_id": "studio_1",
                        "stripe_account_id": "acct_1",
                        "stripe_customer_id": "cus_1",
                    }
                ],
                "billing_payments": [],
                "billing_invoices": [],
                "billing_disputes": [],
            }
        )
        service._recompute_payer_balance = lambda *_args: None

        service._project_payment_intent(
            {
                "id": "pi_1",
                "status": "succeeded",
                "amount": 200,
                "amount_received": 200,
                "application_fee_amount": 1,
                "currency": "usd",
                "customer": "cus_1",
                "latest_charge": "ch_1",
                "metadata": {},
            },
            "acct_1",
            "payment_intent.succeeded",
        )

        payment = service.supabase.tables["billing_payments"][0]
        self.assertEqual(payment["studio_id"], "studio_1")
        self.assertEqual(payment["payer_id"], "payer_1")
        self.assertIsNone(payment["invoice_id"])
        self.assertEqual(payment["stripe_payment_intent_id"], "pi_1")
        self.assertEqual(payment["application_fee_amount_cents"], 1)

    def test_unrelated_metadata_empty_payment_intent_is_ignored(self):
        service = self.service()
        service.supabase = _FakeSupabase(
            {
                "studio_payment_accounts": [
                    {
                        "studio_id": "studio_1",
                        "stripe_connected_account_id": "acct_1",
                    }
                ],
                "billing_payers": [],
                "billing_payments": [],
                "billing_invoices": [],
                "billing_disputes": [],
            }
        )

        service._project_payment_intent(
            {
                "id": "pi_1",
                "status": "succeeded",
                "amount": 200,
                "amount_received": 200,
                "currency": "usd",
                "customer": "cus_unknown",
                "latest_charge": "ch_1",
                "metadata": {},
            },
            "acct_1",
            "payment_intent.succeeded",
        )

        self.assertEqual(service.supabase.tables["billing_payments"], [])

    def test_payment_intent_does_not_amount_match_ambiguous_open_invoices(self):
        service = self.service()
        service.supabase = _FakeSupabase(
            {
                "studio_payment_accounts": [
                    {
                        "studio_id": "studio_1",
                        "stripe_connected_account_id": "acct_1",
                    }
                ],
                "billing_payments": [],
                "billing_invoices": [
                    {
                        "id": "invoice_1",
                        "studio_id": "studio_1",
                        "payer_id": "payer_1",
                        "stripe_invoice_id": "in_1",
                        "stripe_account_id": "acct_1",
                        "stripe_customer_id": "cus_1",
                        "status": "open",
                        "amount_due_cents": 200,
                        "amount_paid_cents": 0,
                        "amount_remaining_cents": 200,
                        "currency": "usd",
                        "created_at": "2026-05-18T19:00:00Z",
                    },
                    {
                        "id": "invoice_2",
                        "studio_id": "studio_1",
                        "payer_id": "payer_1",
                        "stripe_invoice_id": "in_2",
                        "stripe_account_id": "acct_1",
                        "stripe_customer_id": "cus_1",
                        "status": "open",
                        "amount_due_cents": 200,
                        "amount_paid_cents": 0,
                        "amount_remaining_cents": 200,
                        "currency": "usd",
                        "created_at": "2026-05-18T20:00:00Z",
                    },
                ],
                "billing_disputes": [],
                "billing_payers": [
                    {
                        "id": "payer_1",
                        "studio_id": "studio_1",
                        "stripe_account_id": "acct_1",
                        "stripe_customer_id": "cus_1",
                    }
                ],
            }
        )
        service._recompute_payer_balance = lambda *_args: None

        service._project_payment_intent(
            {
                "id": "pi_1",
                "status": "succeeded",
                "amount": 200,
                "amount_received": 200,
                "application_fee_amount": 1,
                "currency": "usd",
                "customer": "cus_1",
                "latest_charge": "ch_1",
                "metadata": {},
            },
            "acct_1",
            "payment_intent.succeeded",
        )

        payment = service.supabase.tables["billing_payments"][0]
        self.assertIsNone(payment["invoice_id"])
        self.assertIsNone(payment["stripe_invoice_id"])
        self.assertIsNone(
            service.supabase.tables["billing_invoices"][0].get("stripe_payment_intent_id")
        )
        self.assertIsNone(
            service.supabase.tables["billing_invoices"][1].get("stripe_payment_intent_id")
        )

    def test_payment_intent_does_not_amount_match_historical_paid_invoice(self):
        service = self.service()
        service.supabase = _FakeSupabase(
            {
                "studio_payment_accounts": [
                    {
                        "studio_id": "studio_1",
                        "stripe_connected_account_id": "acct_1",
                    }
                ],
                "billing_payments": [],
                "billing_invoices": [
                    {
                        "id": "invoice_1",
                        "studio_id": "studio_1",
                        "payer_id": "payer_1",
                        "stripe_invoice_id": "in_1",
                        "stripe_account_id": "acct_1",
                        "stripe_customer_id": "cus_1",
                        "stripe_payment_intent_id": None,
                        "status": "paid",
                        "amount_due_cents": 200,
                        "amount_paid_cents": 200,
                        "amount_remaining_cents": 0,
                        "currency": "usd",
                    }
                ],
                "billing_disputes": [],
                "billing_payers": [
                    {
                        "id": "payer_1",
                        "studio_id": "studio_1",
                        "stripe_account_id": "acct_1",
                        "stripe_customer_id": "cus_1",
                    }
                ],
            }
        )
        service._recompute_payer_balance = lambda *_args: None

        service._project_payment_intent(
            {
                "id": "pi_1",
                "status": "succeeded",
                "amount": 200,
                "amount_received": 200,
                "application_fee_amount": 1,
                "currency": "usd",
                "customer": "cus_1",
                "latest_charge": "ch_1",
                "metadata": {},
            },
            "acct_1",
            "payment_intent.succeeded",
        )

        payment = service.supabase.tables["billing_payments"][0]
        invoice = service.supabase.tables["billing_invoices"][0]
        self.assertIsNone(payment["invoice_id"])
        self.assertIsNone(payment["stripe_invoice_id"])
        self.assertIsNone(invoice["stripe_payment_intent_id"])
        self.assertEqual(invoice["status"], "paid")
