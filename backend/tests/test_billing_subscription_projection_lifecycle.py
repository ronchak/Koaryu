from __future__ import annotations

from app.services.billing_subscription_webhook_projection import (
    BillingSubscriptionWebhookProjector,
)
from tests.billing_lifecycle_helpers import (
    BillingPaymentsLifecycleTestBase,
    _FakeSupabase,
)


def _subscription_item(*, currency="usd", interval="month", interval_count=1, item_id="si_1"):
    recurring = {"interval": interval}
    if interval_count is not None:
        recurring["interval_count"] = interval_count
    return {
        "id": item_id,
        "metadata": {},
        "price": {"currency": currency, "recurring": recurring},
    }


class BillingSubscriptionProjectionLifecycleTest(BillingPaymentsLifecycleTestBase):
    def _project_subscription_items(self, items, *, existing=None):
        service = self.service()
        subscriptions = []
        if existing is not None:
            subscriptions.append(
                {
                    "id": "subscription_1",
                    "studio_id": "studio_1",
                    "payer_id": "payer_1",
                    "stripe_account_id": "acct_1",
                    "stripe_subscription_id": "sub_1",
                    "status": "active",
                    **existing,
                }
            )
        service.supabase = _FakeSupabase(
            {
                "studio_payment_accounts": [
                    {
                        "studio_id": "studio_1",
                        "stripe_connected_account_id": "acct_1",
                    }
                ],
                "billing_subscriptions": subscriptions,
                "student_billing_enrollments": [],
            }
        )
        projector = BillingSubscriptionWebhookProjector(
            service.supabase, service._connect_accounts()
        )
        projector.project_subscription(
            {
                "id": "sub_1",
                "status": "active",
                "customer": "cus_1",
                "currency": "cad",
                "items": items,
                "metadata": {"studio_id": "studio_1", "payer_id": "payer_1"},
            },
            "acct_1",
            "customer.subscription.updated",
            event_created=200,
        )
        return service.supabase.tables["billing_subscriptions"][0]

    def test_missing_subscription_derives_each_supported_shared_item_cadence(self):
        cases = (
            ("week", 1, "weekly"),
            ("week", 2, "biweekly"),
            ("month", 1, "monthly"),
            ("year", 1, "annual"),
        )

        for interval, interval_count, expected in cases:
            with self.subTest(interval=interval, interval_count=interval_count):
                row = self._project_subscription_items(
                    {
                        "data": [
                            _subscription_item(
                                currency=" USD ",
                                interval=interval,
                                interval_count=interval_count,
                            )
                        ],
                        "has_more": False,
                    }
                )

                self.assertEqual((row["currency"], row["billing_interval"]), ("usd", expected))

    def test_missing_subscription_keeps_unconfirmed_item_facts_null(self):
        monthly_usd = _subscription_item()
        cases = (
            ("missing completeness", {"data": [monthly_usd]}, (None, None)),
            (
                "incomplete page",
                {"data": [monthly_usd], "has_more": True},
                (None, None),
            ),
            ("empty complete list", {"data": [], "has_more": False}, (None, None)),
            (
                "missing price",
                {"data": [{"id": "si_1", "metadata": {}}], "has_more": False},
                (None, None),
            ),
            (
                "mixed currency",
                {
                    "data": [monthly_usd, _subscription_item(currency="eur", item_id="si_2")],
                    "has_more": False,
                },
                (None, "monthly"),
            ),
            (
                "mixed cadence",
                {
                    "data": [
                        monthly_usd,
                        _subscription_item(interval="year", item_id="si_2"),
                    ],
                    "has_more": False,
                },
                ("usd", None),
            ),
            (
                "unsupported cadence",
                {
                    "data": [_subscription_item(interval="day", interval_count=7)],
                    "has_more": False,
                },
                ("usd", None),
            ),
            (
                "missing interval count",
                {
                    "data": [_subscription_item(interval_count=None)],
                    "has_more": False,
                },
                ("usd", None),
            ),
        )

        for label, items, expected in cases:
            with self.subTest(label=label):
                row = self._project_subscription_items(items)

                self.assertEqual((row["currency"], row["billing_interval"]), expected)

    def test_existing_subscription_only_fills_null_facts_from_complete_evidence(self):
        complete_items = {"data": [_subscription_item()], "has_more": False}
        cases = (
            (
                "fill null facts",
                {"currency": None, "billing_interval": None},
                complete_items,
                ("usd", "monthly"),
            ),
            (
                "preserve known facts",
                {"currency": "eur", "billing_interval": "annual"},
                complete_items,
                ("eur", "annual"),
            ),
            (
                "do not fill from incomplete page",
                {"currency": None, "billing_interval": None},
                {"data": [_subscription_item()], "has_more": True},
                (None, None),
            ),
        )

        for label, existing, items, expected in cases:
            with self.subTest(label=label):
                row = self._project_subscription_items(items, existing=existing)

                self.assertEqual((row.get("currency"), row.get("billing_interval")), expected)

    def test_subscription_invoice_parent_metadata_repairs_invoice_identity_and_period(self):
        service = self.service()
        service.supabase = _FakeSupabase(
            {
                "billing_invoices": [
                    {
                        "id": "invoice_1",
                        "studio_id": "studio_1",
                        "stripe_invoice_id": "in_1",
                        "stripe_account_id": "acct_1",
                        "payer_id": None,
                        "student_id": None,
                        "enrollment_id": None,
                        "invoice_type": "manual",
                        "status": "open",
                        "amount_due_cents": 0,
                        "amount_paid_cents": 0,
                        "amount_remaining_cents": 0,
                        "currency": "usd",
                    }
                ],
                "billing_subscriptions": [
                    {
                        "id": "subscription_1",
                        "studio_id": "studio_1",
                        "stripe_account_id": "acct_1",
                        "stripe_subscription_id": "sub_1",
                        "current_period_start": None,
                        "current_period_end": None,
                    }
                ],
                "student_billing_enrollments": [
                    {
                        "id": "enrollment_1",
                        "studio_id": "studio_1",
                        "student_id": "student_1",
                        "stripe_subscription_item_id": "si_1",
                    }
                ],
                "billing_payments": [],
                "billing_payers": [{"id": "payer_1", "studio_id": "studio_1"}],
            }
        )
        webhook_projector = service._webhook_projector()

        webhook_projector.project_invoice_event(
            {
                "id": "in_1",
                "status": "paid",
                "amount_due": 200,
                "amount_paid": 200,
                "amount_remaining": 0,
                "currency": "usd",
                "customer": "cus_1",
                "metadata": {},
                "parent": {
                    "type": "subscription_details",
                    "subscription_details": {
                        "subscription": "sub_1",
                        "metadata": {
                            "studio_id": "studio_1",
                            "payer_id": "payer_1",
                            "billing_subscription_id": "subscription_1",
                        },
                    },
                },
                "lines": {
                    "data": [
                        {
                            "parent": {
                                "subscription_item_details": {
                                    "subscription": "sub_1",
                                    "subscription_item": "si_1",
                                },
                            },
                            "period": {"start": 1779140262, "end": 1781818662},
                        }
                    ]
                },
            },
            "acct_1",
            "invoice.paid",
            event_created=300,
        )

        invoice = service.supabase.tables["billing_invoices"][0]
        subscription = service.supabase.tables["billing_subscriptions"][0]
        self.assertEqual(invoice["payer_id"], "payer_1")
        self.assertEqual(invoice["student_id"], "student_1")
        self.assertEqual(invoice["enrollment_id"], "enrollment_1")
        self.assertEqual(invoice["invoice_type"], "tuition")
        self.assertEqual(invoice["stripe_subscription_id"], "sub_1")
        self.assertEqual(subscription["current_period_start"], "2026-05-18T21:37:42+00:00")
        self.assertEqual(subscription["current_period_end"], "2026-06-18T21:37:42+00:00")

    def test_paid_subscription_invoice_links_orphan_payment_by_customer_amount(self):
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
                        "stripe_customer_id": "cus_1",
                        "stripe_payment_intent_id": None,
                        "status": "open",
                        "amount_due_cents": 200,
                        "amount_paid_cents": 0,
                        "amount_remaining_cents": 200,
                        "currency": "usd",
                        "application_fee_amount_cents": 0,
                    }
                ],
                "billing_payments": [
                    {
                        "id": "payment_1",
                        "studio_id": "studio_1",
                        "payer_id": "payer_1",
                        "invoice_id": None,
                        "stripe_customer_id": "cus_1",
                        "stripe_invoice_id": None,
                        "stripe_payment_intent_id": "pi_1",
                        "stripe_charge_id": "ch_1",
                        "stripe_account_id": "acct_1",
                        "status": "succeeded",
                        "amount_cents": 200,
                        "currency": "usd",
                        "application_fee_amount_cents": 1,
                        "processed_at": "2026-05-18T21:37:45+00:00",
                    }
                ],
                "billing_subscriptions": [],
                "student_billing_enrollments": [],
                "billing_payers": [{"id": "payer_1", "studio_id": "studio_1"}],
            }
        )
        webhook_projector = service._webhook_projector()

        webhook_projector.project_invoice_event(
            {
                "id": "in_1",
                "status": "paid",
                "amount_due": 200,
                "amount_paid": 200,
                "amount_remaining": 0,
                "currency": "usd",
                "customer": "cus_1",
                "metadata": {},
                "parent": {
                    "type": "subscription_details",
                    "subscription_details": {
                        "subscription": "sub_1",
                        "metadata": {"studio_id": "studio_1", "payer_id": "payer_1"},
                    },
                },
            },
            "acct_1",
            "invoice.paid",
            event_created=300,
        )

        payment = service.supabase.tables["billing_payments"][0]
        invoice = service.supabase.tables["billing_invoices"][0]
        self.assertEqual(payment["invoice_id"], "invoice_1")
        self.assertEqual(payment["stripe_invoice_id"], "in_1")
        self.assertEqual(invoice["stripe_payment_intent_id"], "pi_1")
        self.assertEqual(invoice["application_fee_amount_cents"], 1)

    def test_paid_invoice_does_not_link_ambiguous_orphan_payments(self):
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
                        "stripe_customer_id": "cus_1",
                        "stripe_payment_intent_id": None,
                        "status": "open",
                        "amount_due_cents": 200,
                        "amount_paid_cents": 0,
                        "amount_remaining_cents": 200,
                        "currency": "usd",
                    }
                ],
                "billing_payments": [
                    {
                        "id": "payment_1",
                        "studio_id": "studio_1",
                        "payer_id": "payer_1",
                        "invoice_id": None,
                        "stripe_customer_id": "cus_1",
                        "stripe_invoice_id": None,
                        "stripe_payment_intent_id": "pi_1",
                        "stripe_account_id": "acct_1",
                        "status": "succeeded",
                        "amount_cents": 200,
                        "currency": "usd",
                        "application_fee_amount_cents": 1,
                        "processed_at": "2026-05-18T21:37:45+00:00",
                    },
                    {
                        "id": "payment_2",
                        "studio_id": "studio_1",
                        "payer_id": "payer_1",
                        "invoice_id": None,
                        "stripe_customer_id": "cus_1",
                        "stripe_invoice_id": None,
                        "stripe_payment_intent_id": "pi_2",
                        "stripe_account_id": "acct_1",
                        "status": "succeeded",
                        "amount_cents": 200,
                        "currency": "usd",
                        "application_fee_amount_cents": 1,
                        "processed_at": "2026-05-18T21:38:45+00:00",
                    },
                ],
                "billing_subscriptions": [],
                "student_billing_enrollments": [],
                "billing_payers": [{"id": "payer_1", "studio_id": "studio_1"}],
            }
        )
        webhook_projector = service._webhook_projector()

        webhook_projector.project_invoice_event(
            {
                "id": "in_1",
                "status": "paid",
                "amount_due": 200,
                "amount_paid": 200,
                "amount_remaining": 0,
                "currency": "usd",
                "customer": "cus_1",
                "metadata": {"studio_id": "studio_1", "payer_id": "payer_1"},
            },
            "acct_1",
            "invoice.paid",
            event_created=300,
        )

        self.assertIsNone(service.supabase.tables["billing_payments"][0]["invoice_id"])
        self.assertIsNone(service.supabase.tables["billing_payments"][1]["invoice_id"])
        self.assertIsNone(
            service.supabase.tables["billing_invoices"][0]["stripe_payment_intent_id"]
        )

    def test_orphan_payment_with_unknown_fee_does_not_overwrite_invoice_fee(self):
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
                        "stripe_customer_id": "cus_1",
                        "stripe_payment_intent_id": None,
                        "status": "open",
                        "amount_due_cents": 200,
                        "amount_paid_cents": 0,
                        "amount_remaining_cents": 200,
                        "currency": "usd",
                        "application_fee_amount_cents": 1,
                    }
                ],
                "billing_payments": [
                    {
                        "id": "payment_1",
                        "studio_id": "studio_1",
                        "payer_id": "payer_1",
                        "invoice_id": None,
                        "stripe_customer_id": "cus_1",
                        "stripe_invoice_id": None,
                        "stripe_payment_intent_id": "pi_1",
                        "stripe_account_id": "acct_1",
                        "status": "succeeded",
                        "amount_cents": 200,
                        "currency": "usd",
                        "application_fee_amount_cents": 0,
                        "processed_at": "2026-05-18T21:37:45+00:00",
                    }
                ],
                "billing_subscriptions": [],
                "student_billing_enrollments": [],
                "billing_payers": [{"id": "payer_1", "studio_id": "studio_1"}],
            }
        )
        webhook_projector = service._webhook_projector()

        webhook_projector.project_invoice_event(
            {
                "id": "in_1",
                "status": "paid",
                "amount_due": 200,
                "amount_paid": 200,
                "amount_remaining": 0,
                "currency": "usd",
                "customer": "cus_1",
                "metadata": {"studio_id": "studio_1", "payer_id": "payer_1"},
            },
            "acct_1",
            "invoice.paid",
            event_created=300,
        )

        self.assertEqual(
            service.supabase.tables["billing_invoices"][0]["application_fee_amount_cents"], 1
        )

    def test_sparse_invoice_update_preserves_known_stripe_relationships(self):
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
                        "stripe_customer_id": "cus_1",
                        "stripe_subscription_id": "sub_1",
                        "stripe_payment_intent_id": "pi_1",
                        "status": "paid",
                        "amount_due_cents": 200,
                        "amount_paid_cents": 200,
                        "amount_remaining_cents": 0,
                        "currency": "usd",
                    }
                ],
                "billing_payers": [{"id": "payer_1", "studio_id": "studio_1"}],
            }
        )

        service._webhook_projector().update_invoice_from_stripe(
            "invoice_1",
            "studio_1",
            {
                "id": "in_1",
                "status": "paid",
                "amount_due": 200,
                "amount_paid": 200,
                "amount_remaining": 0,
                "currency": "usd",
                "customer": "cus_1",
                "metadata": {"studio_id": "studio_1", "payer_id": "payer_1"},
            },
            "acct_1",
        )

        invoice = service.supabase.tables["billing_invoices"][0]
        self.assertEqual(invoice["stripe_subscription_id"], "sub_1")
        self.assertEqual(invoice["stripe_payment_intent_id"], "pi_1")

    def test_subscription_projection_uses_item_period_bounds(self):
        service = self.service()
        service.supabase = _FakeSupabase(
            {
                "billing_subscriptions": [
                    {
                        "id": "subscription_1",
                        "studio_id": "studio_1",
                        "payer_id": "payer_1",
                        "stripe_account_id": "acct_1",
                        "stripe_subscription_id": "sub_1",
                        "current_period_start": None,
                        "current_period_end": None,
                    }
                ],
                "student_billing_enrollments": [],
            }
        )

        service.project_connect_event(
            {
                "type": "customer.subscription.updated",
                "account": "acct_1",
                "data": {
                    "object": {
                        "id": "sub_1",
                        "status": "active",
                        "customer": "cus_1",
                        "metadata": {"studio_id": "studio_1", "payer_id": "payer_1"},
                        "items": {
                            "data": [
                                {
                                    "id": "si_1",
                                    "current_period_start": 1779140262,
                                    "current_period_end": 1781818662,
                                    "metadata": {},
                                }
                            ]
                        },
                    }
                },
            }
        )

        subscription = service.supabase.tables["billing_subscriptions"][0]
        self.assertEqual(subscription["current_period_start"], "2026-05-18T21:37:42+00:00")
        self.assertEqual(subscription["current_period_end"], "2026-06-18T21:37:42+00:00")

    def test_canceled_subscription_projection_does_not_reattach_canceled_enrollment_item(self):
        service = self.service()
        service.supabase = _FakeSupabase(
            {
                "billing_subscriptions": [
                    {
                        "id": "subscription_1",
                        "studio_id": "studio_1",
                        "payer_id": "payer_1",
                        "stripe_account_id": "acct_1",
                        "stripe_subscription_id": "sub_1",
                        "status": "active",
                        "current_period_start": "2026-05-18T21:37:42+00:00",
                        "current_period_end": "2026-06-18T21:37:42+00:00",
                    }
                ],
                "student_billing_enrollments": [
                    {
                        "id": "enrollment_1",
                        "studio_id": "studio_1",
                        "billing_subscription_id": "subscription_1",
                        "stripe_subscription_id": "sub_1",
                        "stripe_subscription_item_id": None,
                        "status": "canceled",
                        "billing_status": "upcoming",
                    }
                ],
            }
        )

        service.project_connect_event(
            {
                "type": "customer.subscription.deleted",
                "account": "acct_1",
                "data": {
                    "object": {
                        "id": "sub_1",
                        "status": "canceled",
                        "customer": "cus_1",
                        "metadata": {"studio_id": "studio_1", "payer_id": "payer_1"},
                        "items": {
                            "data": [
                                {
                                    "id": "si_1",
                                    "metadata": {"enrollment_id": "enrollment_1"},
                                }
                            ]
                        },
                    }
                },
            }
        )

        enrollment = service.supabase.tables["student_billing_enrollments"][0]
        self.assertEqual(enrollment["status"], "canceled")
        self.assertEqual(enrollment["billing_status"], "upcoming")
        self.assertIsNone(enrollment["stripe_subscription_item_id"])

    def test_old_invoice_period_does_not_regress_subscription_period(self):
        service = self.service()
        service.supabase = _FakeSupabase(
            {
                "billing_invoices": [
                    {
                        "id": "invoice_1",
                        "studio_id": "studio_1",
                        "stripe_invoice_id": "in_1",
                        "stripe_account_id": "acct_1",
                        "payer_id": "payer_1",
                        "status": "paid",
                        "last_stripe_event_created": 100,
                    }
                ],
                "billing_subscriptions": [
                    {
                        "id": "subscription_1",
                        "studio_id": "studio_1",
                        "stripe_account_id": "acct_1",
                        "stripe_subscription_id": "sub_1",
                        "current_period_start": "2026-06-18T21:37:42+00:00",
                        "current_period_end": "2026-07-18T21:37:42+00:00",
                    }
                ],
                "student_billing_enrollments": [],
                "billing_payments": [],
                "billing_payers": [{"id": "payer_1", "studio_id": "studio_1"}],
            }
        )
        webhook_projector = service._webhook_projector()

        webhook_projector.project_invoice_event(
            {
                "id": "in_1",
                "status": "paid",
                "amount_due": 200,
                "amount_paid": 200,
                "amount_remaining": 0,
                "currency": "usd",
                "customer": "cus_1",
                "metadata": {"studio_id": "studio_1", "payer_id": "payer_1"},
                "parent": {
                    "type": "subscription_details",
                    "subscription_details": {
                        "subscription": "sub_1",
                        "metadata": {"studio_id": "studio_1"},
                    },
                },
                "lines": {
                    "data": [
                        {
                            "parent": {
                                "subscription_item_details": {
                                    "subscription": "sub_1",
                                    "subscription_item": "si_1",
                                }
                            },
                            "period": {"start": 1779140262, "end": 1781818662},
                        }
                    ]
                },
            },
            "acct_1",
            "invoice.paid",
            event_created=200,
        )

        subscription = service.supabase.tables["billing_subscriptions"][0]
        self.assertEqual(subscription["current_period_start"], "2026-06-18T21:37:42+00:00")
        self.assertEqual(subscription["current_period_end"], "2026-07-18T21:37:42+00:00")

    def test_mixed_invoice_line_periods_do_not_repair_subscription_period(self):
        service = self.service()
        service.supabase = _FakeSupabase(
            {
                "billing_invoices": [
                    {
                        "id": "invoice_1",
                        "studio_id": "studio_1",
                        "stripe_invoice_id": "in_1",
                        "stripe_account_id": "acct_1",
                        "payer_id": "payer_1",
                        "status": "paid",
                    }
                ],
                "billing_subscriptions": [
                    {
                        "id": "subscription_1",
                        "studio_id": "studio_1",
                        "stripe_account_id": "acct_1",
                        "stripe_subscription_id": "sub_1",
                        "current_period_start": None,
                        "current_period_end": None,
                    }
                ],
                "student_billing_enrollments": [],
                "billing_payments": [],
                "billing_payers": [{"id": "payer_1", "studio_id": "studio_1"}],
            }
        )
        webhook_projector = service._webhook_projector()

        webhook_projector.project_invoice_event(
            {
                "id": "in_1",
                "status": "paid",
                "amount_due": 200,
                "amount_paid": 200,
                "amount_remaining": 0,
                "currency": "usd",
                "customer": "cus_1",
                "metadata": {"studio_id": "studio_1", "payer_id": "payer_1"},
                "parent": {
                    "type": "subscription_details",
                    "subscription_details": {
                        "subscription": "sub_1",
                        "metadata": {"studio_id": "studio_1"},
                    },
                },
                "lines": {
                    "data": [
                        {
                            "parent": {
                                "subscription_item_details": {
                                    "subscription": "sub_1",
                                    "subscription_item": "si_1",
                                }
                            },
                            "period": {"start": 1779140262, "end": 1781818662},
                        },
                        {
                            "parent": {
                                "subscription_item_details": {
                                    "subscription": "sub_1",
                                    "subscription_item": "si_1",
                                }
                            },
                            "period": {"start": 1779053862, "end": 1779140262},
                            "proration": True,
                        },
                        {
                            "parent": {
                                "subscription_item_details": {
                                    "subscription": "sub_1",
                                    "subscription_item": "si_1",
                                }
                            },
                            "period": {"start": 1781818662, "end": 1784410662},
                        },
                    ]
                },
            },
            "acct_1",
            "invoice.paid",
            event_created=200,
        )

        subscription = service.supabase.tables["billing_subscriptions"][0]
        self.assertIsNone(subscription["current_period_start"])
        self.assertIsNone(subscription["current_period_end"])
