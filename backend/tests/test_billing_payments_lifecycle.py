from __future__ import annotations

import asyncio
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

from fastapi import HTTPException

from app.schemas.billing import (
    BillingInvoiceCreate,
    BillingPayerAutopaySetupRequest,
    BillingReconcileRequest,
    BillingInvoiceResponse,
    StudentBillingEnrollmentCreate,
    StudentBillingEnrollmentResponse,
)
from app.services.billing_service import BillingService
from app.services.stripe_service import StripeService
from app.services.stripe_service import _StripeV2RequestError


class _FakeResponse:
    def __init__(self, data):
        self.data = data


class _FakeQuery:
    def __init__(self, rows):
        self.rows = rows
        self.filters = []
        self.update_values = None
        self.negate_next_is = False
        self.single_row = False

    def select(self, *_args):
        return self

    def limit(self, *_args):
        return self

    def single(self):
        self.single_row = True
        return self

    def maybe_single(self):
        self.single_row = True
        return self

    def insert(self, values):
        if isinstance(values, list):
            self.rows.extend(values)
        else:
            self.rows.append(values)
        return self

    def update(self, values):
        self.update_values = values
        return self

    def eq(self, key, value):
        self.filters.append(lambda row, key=key, value=value: row.get(key) == value)
        return self

    def is_(self, key, value):
        if value == "null":
            if self.negate_next_is:
                self.filters.append(lambda row, key=key: row.get(key) is not None)
            else:
                self.filters.append(lambda row, key=key: row.get(key) is None)
        self.negate_next_is = False
        return self

    def in_(self, key, values):
        values = set(values)
        self.filters.append(lambda row, key=key, values=values: row.get(key) in values)
        return self

    def order(self, key, desc=False):
        self.rows.sort(key=lambda row, key=key: row.get(key) or "", reverse=desc)
        return self

    @property
    def not_(self):
        self.negate_next_is = True
        return self

    def execute(self):
        matched = [row for row in self.rows if all(match(row) for match in self.filters)]
        if self.update_values is not None:
            for row in matched:
                row.update(self.update_values)
        if self.single_row:
            return _FakeResponse(matched[0] if matched else None)
        return _FakeResponse(matched)


class _FakeSupabase:
    def __init__(self, tables):
        self.tables = tables

    def table(self, name):
        return _FakeQuery(self.tables[name])


class _FakeStripeAccount:
    def __init__(self):
        self.calls = []

    def retrieve(self, account_id=None):
        self.calls.append(("retrieve", account_id))
        if account_id:
            return {
                "id": account_id,
                "type": "standard",
                "controller": {"stripe_dashboard": {"type": "full"}},
            }
        return {"id": "acct_platform"}

    def create_login_link(self, account_id):
        self.calls.append(("create_login_link", account_id))
        return {"url": f"https://connect.stripe.com/express/{account_id}"}


class _FakeStripe:
    Account = _FakeStripeAccount()


class _FakeStripeConnectMismatchError(Exception):
    __module__ = "stripe.error"


class _FakeStripeMismatchedAccount:
    def retrieve(self, account_id=None):
        if account_id:
            raise _FakeStripeConnectMismatchError(
                "Only Stripe Connect platforms can work with other accounts."
            )
        return {"id": "acct_platform"}


class _FakeStripeWithMismatchedAccount:
    Account = _FakeStripeMismatchedAccount()


class _FakeStripeService:
    onboarding_calls = []
    setup_calls = []
    retrieve_calls = []
    retrieve_account_response = None
    invoice_response = None
    subscription_response = None
    payment_intent_response = None

    def create_connect_onboarding_link(self, *, account_id: str, refresh_url: str, return_url: str):
        self.__class__.onboarding_calls.append({
            "account_id": account_id,
            "refresh_url": refresh_url,
            "return_url": return_url,
        })
        return {"url": f"https://connect.stripe.test/setup/{account_id}"}

    def retrieve_account(self, *, account_id: str):
        self.__class__.retrieve_calls.append(account_id)
        return self.__class__.retrieve_account_response or {
            "id": account_id,
            "charges_enabled": False,
            "payouts_enabled": False,
            "details_submitted": False,
            "requirements": {"currently_due": []},
        }

    def retrieve_connected_invoice(self, *, account_id: str, invoice_id: str, expand=None):
        return self.__class__.invoice_response or {
            "id": invoice_id,
            "status": "open",
            "amount_due": 123,
            "amount_paid": 0,
            "amount_remaining": 123,
            "currency": "usd",
            "customer": "cus_1",
            "metadata": {"studio_id": "studio_1", "invoice_id": "invoice_1"},
            "created": 200,
        }

    def retrieve_connected_subscription(self, *, account_id: str, subscription_id: str, expand=None):
        return self.__class__.subscription_response or {
            "id": subscription_id,
            "status": "active",
            "customer": "cus_1",
            "items": {"data": []},
            "metadata": {"studio_id": "studio_1", "payer_id": "payer_1", "billing_subscription_id": "subscription_1"},
            "created": 200,
        }

    def retrieve_connected_payment_intent(self, *, account_id: str, payment_intent_id: str, expand=None):
        return self.__class__.payment_intent_response or {
            "id": payment_intent_id,
            "status": "succeeded",
            "amount": 123,
            "amount_received": 123,
            "currency": "usd",
            "customer": "cus_1",
            "metadata": {"studio_id": "studio_1", "payer_id": "payer_1"},
        }

    def create_setup_checkout_session(self, **payload):
        self.__class__.setup_calls.append(payload)
        return {"url": "https://checkout.stripe.test/setup"}

    def update_connected_customer(self, **_payload):
        return {"id": _payload["customer_id"]}

    def create_connected_customer(self, **_payload):
        return {"id": "cus_created"}

    def retrieve_connected_customer(self, *, account_id: str, customer_id: str, expand=None):
        return {
            "id": customer_id,
            "invoice_settings": {
                "default_payment_method": {
                    "id": "pm_123",
                    "type": "card",
                    "card": {"brand": "visa", "last4": "2167", "exp_month": 12, "exp_year": 2030},
                }
            },
        }


class BillingPaymentsLifecycleTest(unittest.TestCase):
    def service(self) -> BillingService:
        service = object.__new__(BillingService)
        service.settings = type("Settings", (), {"BILLING_PLATFORM_FEE_BPS": 50})()
        return service

    def test_interval_mapping_for_stripe_prices(self):
        service = self.service()

        self.assertEqual(service._stripe_recurring_for_interval("monthly"), ({"interval": "month", "interval_count": 1}, 1))
        self.assertEqual(service._stripe_recurring_for_interval("biweekly"), ({"interval": "week", "interval_count": 2}, 2))
        self.assertEqual(service._stripe_recurring_for_interval("annual"), ({"interval": "year", "interval_count": 1}, 1))
        self.assertEqual(service._stripe_recurring_for_interval("paid_in_full"), (None, 1))

    def test_application_fee_percent_and_amount_use_platform_bps(self):
        service = self.service()
        account = {"platform_fee_bps": 50}

        self.assertEqual(service._application_fee_percent(account), 0.5)
        self.assertEqual(service._application_fee_amount(12900, account), 64)

    def test_out_of_band_paid_invoice_projects_external_totals_without_fee(self):
        service = self.service()

        projection = service._invoice_projection({
            "id": "in_123",
            "status": "paid",
            "paid_out_of_band": True,
            "amount_due": 234,
            "amount_paid": 0,
            "amount_remaining": 234,
            "currency": "usd",
            "application_fee_amount": 1,
        }, "acct_123")

        self.assertEqual(projection["status"], "paid")
        self.assertEqual(projection["amount_paid_cents"], 234)
        self.assertEqual(projection["amount_remaining_cents"], 0)
        self.assertEqual(projection["application_fee_amount_cents"], 0)

    def test_invoice_projection_does_not_clear_missing_application_fee(self):
        service = self.service()

        projection = service._invoice_projection({
            "id": "in_123",
            "status": "paid",
            "amount_due": 200,
            "amount_paid": 200,
            "amount_remaining": 0,
            "currency": "usd",
            "application_fee_amount": None,
        }, "acct_123")

        self.assertNotIn("application_fee_amount_cents", projection)

    def test_non_card_payment_method_summary_uses_method_type(self):
        service = self.service()

        fields = service._payment_method_fields_from_payment_method({
            "id": "pm_link",
            "type": "link",
        })

        self.assertEqual(fields["default_payment_method_id"], "pm_link")
        self.assertEqual(fields["default_payment_method_brand"], "link")
        self.assertIsNone(fields["default_payment_method_last4"])

    def test_frontend_enrollment_payload_aliases_are_accepted(self):
        payload = StudentBillingEnrollmentCreate.model_validate({
            "student_id": "student_1",
            "payer_id": "payer_1",
            "plan_id": "plan_1",
            "collection_mode": "invoice_link",
            "start_date": "2026-04-28",
            "next_bill_date": "2026-05-01",
        })

        self.assertEqual(payload.billing_plan_id, "plan_1")
        self.assertEqual(payload.next_bill_on, "2026-05-01")

    def test_enrollment_response_exposes_frontend_aliases(self):
        response = StudentBillingEnrollmentResponse.model_validate({
            "id": "enrollment_1",
            "studio_id": "studio_1",
            "student_id": "student_1",
            "payer_id": "payer_1",
            "billing_plan_id": "plan_1",
            "billing_subscription_id": "billing_sub_1",
            "collection_mode": "autopay",
            "status": "active",
            "billing_status": "current",
            "start_date": "2026-04-28",
            "next_bill_on": "2026-05-01",
            "created_at": "2026-04-28T00:00:00Z",
            "updated_at": "2026-04-28T00:00:00Z",
        })

        self.assertEqual(response.plan_id, "plan_1")
        self.assertEqual(response.subscription_id, "billing_sub_1")
        self.assertEqual(response.next_bill_date, "2026-05-01")

    def test_invoice_response_exposes_stripe_number_alias(self):
        response = BillingInvoiceResponse.model_validate({
            "id": "invoice_1",
            "studio_id": "studio_1",
            "invoice_number": "INV-001",
            "invoice_type": "tuition",
            "status": "open",
            "amount_due_cents": 12900,
            "amount_paid_cents": 0,
            "currency": "usd",
            "external": False,
            "created_at": "2026-04-28T00:00:00Z",
            "updated_at": "2026-04-28T00:00:00Z",
        })

        self.assertEqual(response.number, "INV-001")

    def test_invoice_request_hash_is_stable_for_equivalent_payloads(self):
        service = self.service()

        first = BillingInvoiceCreate(payer_id="payer_1", amount_cents=12900, description="May tuition")
        second = BillingInvoiceCreate.model_validate({
            "description": "May tuition",
            "amount_cents": 12900,
            "payer_id": "payer_1",
        })

        self.assertEqual(service._invoice_request_hash(first), service._invoice_request_hash(second))

    def test_claim_invoice_create_request_reuses_matching_idempotency_key(self):
        service = self.service()
        service.supabase = _FakeSupabase({
            "billing_invoices": [{
                "id": "invoice_1",
                "studio_id": "studio_1",
                "idempotency_key": "invoice-key",
                "request_hash": "same-hash",
            }],
        })

        invoice = service._claim_invoice_create_request(
            "studio_1",
            "invoice-key",
            "same-hash",
            {"studio_id": "studio_1", "idempotency_key": "invoice-key", "request_hash": "same-hash"},
        )

        self.assertEqual(invoice["id"], "invoice_1")
        self.assertEqual(len(service.supabase.tables["billing_invoices"]), 1)

    def test_claim_invoice_create_request_rejects_reused_key_for_different_payload(self):
        service = self.service()
        service.supabase = _FakeSupabase({
            "billing_invoices": [{
                "id": "invoice_1",
                "studio_id": "studio_1",
                "idempotency_key": "invoice-key",
                "request_hash": "original-hash",
            }],
        })

        with self.assertRaises(HTTPException) as exc:
            service._claim_invoice_create_request(
                "studio_1",
                "invoice-key",
                "different-hash",
                {"studio_id": "studio_1", "idempotency_key": "invoice-key", "request_hash": "different-hash"},
            )

        self.assertEqual(exc.exception.status_code, 409)

    def test_late_payment_intent_links_existing_dispute_and_marks_payment_disputed(self):
        service = self.service()
        service.supabase = _FakeSupabase({
            "billing_disputes": [{
                "id": "dispute_1",
                "studio_id": "studio_1",
                "stripe_account_id": "acct_1",
                "stripe_charge_id": "ch_1",
                "payment_id": None,
                "stripe_payment_intent_id": None,
                "status": "needs_response",
            }],
            "billing_payments": [{
                "id": "payment_1",
                "studio_id": "studio_1",
                "stripe_account_id": "acct_1",
                "stripe_charge_id": "ch_1",
                "stripe_payment_intent_id": "pi_1",
                "status": "succeeded",
            }],
        })

        payment = service._link_disputes_to_payment({
            "id": "payment_1",
            "studio_id": "studio_1",
            "stripe_account_id": "acct_1",
            "stripe_charge_id": "ch_1",
            "stripe_payment_intent_id": "pi_1",
            "status": "succeeded",
        }, "acct_1")

        dispute = service.supabase.tables["billing_disputes"][0]
        stored_payment = service.supabase.tables["billing_payments"][0]
        self.assertEqual(payment["status"], "disputed")
        self.assertEqual(stored_payment["status"], "disputed")
        self.assertEqual(dispute["payment_id"], "payment_1")
        self.assertEqual(dispute["stripe_payment_intent_id"], "pi_1")

    def test_stale_failed_payment_intent_does_not_regress_succeeded_payment(self):
        service = self.service()
        service.supabase = _FakeSupabase({
            "billing_payments": [{
                "id": "payment_1",
                "studio_id": "studio_1",
                "stripe_account_id": "acct_1",
                "stripe_payment_intent_id": "pi_1",
                "status": "succeeded",
                "processed_at": "2026-04-28T00:00:00Z",
            }],
            "billing_invoices": [],
            "billing_disputes": [],
            "billing_payers": [],
        })

        service._project_payment_intent({
            "id": "pi_1",
            "amount": 12900,
            "currency": "usd",
            "metadata": {"studio_id": "studio_1"},
            "last_payment_error": {"message": "Declined"},
        }, "acct_1", "payment_intent.payment_failed")

        self.assertEqual(service.supabase.tables["billing_payments"][0]["status"], "succeeded")
        self.assertEqual(service.supabase.tables["billing_payments"][0]["processed_at"], "2026-04-28T00:00:00Z")

    def test_payment_intent_without_invoice_id_matches_open_invoice_by_customer_amount(self):
        service = self.service()
        service.supabase = _FakeSupabase({
            "billing_payments": [],
            "billing_invoices": [{
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
            }],
            "billing_disputes": [],
            "billing_payers": [{"id": "payer_1", "studio_id": "studio_1"}],
        })

        service._project_payment_intent({
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
        }, "acct_1", "payment_intent.succeeded")

        payment = service.supabase.tables["billing_payments"][0]
        invoice = service.supabase.tables["billing_invoices"][0]
        self.assertEqual(payment["invoice_id"], "invoice_1")
        self.assertEqual(payment["stripe_invoice_id"], "in_1")
        self.assertEqual(payment["stripe_payment_intent_id"], "pi_1")
        self.assertEqual(payment["stripe_charge_id"], "ch_1")
        self.assertEqual(payment["status"], "succeeded")
        self.assertEqual(payment["application_fee_amount_cents"], 1)
        self.assertEqual(invoice["status"], "paid")
        self.assertEqual(invoice["stripe_payment_intent_id"], "pi_1")
        self.assertEqual(invoice["application_fee_amount_cents"], 1)
        self.assertEqual(invoice["amount_paid_cents"], 50)

    def test_successful_invoice_payment_stores_payment_method_without_enabling_autopay(self):
        service = self.service()
        service.supabase = _FakeSupabase({
            "billing_payments": [],
            "billing_invoices": [{
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
                "application_fee_amount_cents": 1,
                "created_at": "2026-05-18T19:00:00Z",
            }],
            "billing_disputes": [],
            "billing_payers": [{
                "id": "payer_1",
                "studio_id": "studio_1",
                "autopay_status": "not_configured",
            }],
        })
        service._store_invoice_payment_method = lambda studio_id, payer_id, account_id, customer_id, payment_method: service.supabase.tables["billing_payers"][0].update({
            "stripe_account_id": account_id,
            "stripe_customer_id": customer_id,
            "default_payment_method_id": payment_method["id"],
            "default_payment_method_brand": payment_method["card"]["brand"],
            "default_payment_method_last4": payment_method["card"]["last4"],
        })

        service._project_payment_intent({
            "id": "pi_1",
            "status": "succeeded",
            "amount": 200,
            "amount_received": 200,
            "application_fee_amount": 1,
            "currency": "usd",
            "customer": "cus_1",
            "latest_charge": "ch_1",
            "payment_method": {
                "id": "pm_1",
                "type": "card",
                "card": {"brand": "visa", "last4": "2167"},
            },
            "metadata": {},
        }, "acct_1", "payment_intent.succeeded")

        payer = service.supabase.tables["billing_payers"][0]
        self.assertEqual(payer["default_payment_method_id"], "pm_1")
        self.assertEqual(payer["default_payment_method_brand"], "visa")
        self.assertEqual(payer["default_payment_method_last4"], "2167")
        self.assertEqual(payer["autopay_status"], "not_configured")

    def test_payer_sync_stores_saved_card_without_enabling_autopay(self):
        service = self.service()
        service.supabase = _FakeSupabase({
            "billing_payers": [{
                "id": "payer_1",
                "studio_id": "studio_1",
                "display_name": "Rehearsal Payer",
                "stripe_account_id": "acct_1",
                "stripe_customer_id": "cus_1",
                "autopay_status": "not_configured",
                "billing_status": "no_payment_method",
            }],
        })

        with patch("app.services.billing_service.StripeService", _FakeStripeService):
            payer = service._sync_payer_customer(
                service.supabase.tables["billing_payers"][0],
                {"stripe_connected_account_id": "acct_1"},
            )

        self.assertEqual(payer["default_payment_method_id"], "pm_123")
        self.assertEqual(payer["default_payment_method_last4"], "2167")
        self.assertEqual(payer["autopay_status"], "not_configured")

    def test_autopay_setup_requires_explicit_terms_acceptance(self):
        service = self.service()
        service.settings = type("Settings", (), {
            "BILLING_PLATFORM_FEE_BPS": 50,
            "FRONTEND_URL": "https://app.koaryu.test",
        })()

        with self.assertRaises(HTTPException) as context:
            asyncio.run(service.create_autopay_setup_link(
                "payer_1",
                BillingPayerAutopaySetupRequest(),
                "studio_1",
                "user_1",
            ))

        self.assertEqual(context.exception.status_code, 400)
        self.assertIn("accepted autopay terms", context.exception.detail)

    def test_autopay_setup_uses_explicit_terms_and_allowed_redirect(self):
        service = self.service()
        service.settings = type("Settings", (), {
            "BILLING_PLATFORM_FEE_BPS": 50,
            "FRONTEND_URL": "https://app.koaryu.test",
        })()
        service.supabase = _FakeSupabase({
            "studio_payment_accounts": [{
                "studio_id": "studio_1",
                "stripe_connected_account_id": "acct_1",
                "status": "charges_enabled",
                "charges_enabled": True,
                "payouts_enabled": True,
                "details_submitted": True,
                "requirements_due": [],
                "platform_fee_bps": 50,
                "metadata": {},
            }],
            "billing_payers": [{
                "id": "payer_1",
                "studio_id": "studio_1",
                "display_name": "Rehearsal Payer",
                "stripe_customer_id": "cus_1",
                "autopay_status": "not_configured",
                "billing_status": "current",
            }],
            "audit_logs": [],
        })
        _FakeStripeService.retrieve_account_response = {
            "id": "acct_1",
            "charges_enabled": True,
            "payouts_enabled": True,
            "details_submitted": True,
            "requirements": {"currently_due": []},
        }
        _FakeStripeService.setup_calls = []

        with patch("app.services.billing_service.StripeService", _FakeStripeService):
            link = asyncio.run(service.create_autopay_setup_link(
                "payer_1",
                BillingPayerAutopaySetupRequest(
                    return_url="https://app.koaryu.test/billing",
                    terms_accepted=True,
                ),
                "studio_1",
                "user_1",
            ))

        self.assertEqual(link.url, "https://checkout.stripe.test/setup")
        self.assertEqual(service.supabase.tables["billing_payers"][0]["autopay_status"], "pending")
        self.assertIsNotNone(service.supabase.tables["billing_payers"][0]["autopay_terms_accepted_at"])
        self.assertEqual(_FakeStripeService.setup_calls[0]["success_url"], "https://app.koaryu.test/billing")

    def test_autopay_invoice_requires_authorized_payer_terms(self):
        service = self.service()
        service.supabase = _FakeSupabase({
            "studio_payment_accounts": [{
                "studio_id": "studio_1",
                "stripe_connected_account_id": "acct_1",
                "status": "charges_enabled",
                "charges_enabled": True,
                "payouts_enabled": True,
                "details_submitted": True,
                "requirements_due": [],
                "platform_fee_bps": 50,
                "metadata": {},
            }],
            "billing_payers": [{
                "id": "payer_1",
                "studio_id": "studio_1",
                "display_name": "Rehearsal Payer",
                "stripe_customer_id": "cus_1",
                "default_payment_method_id": "pm_123",
                "autopay_status": "not_configured",
                "billing_status": "current",
            }],
            "billing_invoices": [],
            "billing_invoice_items": [],
        })
        _FakeStripeService.retrieve_account_response = {
            "id": "acct_1",
            "charges_enabled": True,
            "payouts_enabled": True,
            "details_submitted": True,
            "requirements": {"currently_due": []},
        }

        with patch("app.services.billing_service.StripeService", _FakeStripeService):
            with self.assertRaises(HTTPException) as context:
                asyncio.run(service.create_invoice(
                    BillingInvoiceCreate(
                        payer_id="payer_1",
                        collection_mode="autopay",
                        amount_cents=200,
                        description="Autopay consent rehearsal",
                    ),
                    "studio_1",
                    "user_1",
                ))

        self.assertEqual(context.exception.status_code, 409)
        self.assertIn("accepted autopay terms", context.exception.detail)

    def test_autopay_enrollment_requires_authorized_payer_terms(self):
        service = self.service()
        service.supabase = _FakeSupabase({
            "studio_payment_accounts": [{
                "studio_id": "studio_1",
                "stripe_connected_account_id": "acct_1",
                "status": "charges_enabled",
                "charges_enabled": True,
                "payouts_enabled": True,
                "details_submitted": True,
                "requirements_due": [],
                "platform_fee_bps": 50,
                "metadata": {},
            }],
            "billing_payers": [{
                "id": "payer_1",
                "studio_id": "studio_1",
                "display_name": "Rehearsal Payer",
                "stripe_customer_id": "cus_1",
                "default_payment_method_id": "pm_123",
                "autopay_status": "not_configured",
                "billing_status": "current",
            }],
        })
        _FakeStripeService.retrieve_account_response = {
            "id": "acct_1",
            "charges_enabled": True,
            "payouts_enabled": True,
            "details_submitted": True,
            "requirements": {"currently_due": []},
        }

        with patch("app.services.billing_service.StripeService", _FakeStripeService):
            with self.assertRaises(HTTPException) as context:
                service._activate_stripe_enrollment(
                    {
                        "id": "enrollment_1",
                        "studio_id": "studio_1",
                        "student_id": "student_1",
                        "payer_id": "payer_1",
                        "collection_mode": "autopay",
                    },
                    {
                        "id": "plan_1",
                        "studio_id": "studio_1",
                        "name": "Live Autopay Rehearsal",
                        "amount_cents": 200,
                        "currency": "usd",
                        "billing_interval": "monthly",
                        "trial_days": 0,
                        "stripe_price_id": "price_1",
                    },
                    "studio_1",
                )

        self.assertEqual(context.exception.status_code, 409)
        self.assertIn("accepted autopay terms", context.exception.detail)

    def test_stale_invoice_event_is_ignored(self):
        service = self.service()
        service.supabase = _FakeSupabase({
            "billing_invoices": [{
                "id": "invoice_1",
                "studio_id": "studio_1",
                "stripe_invoice_id": "in_1",
                "stripe_account_id": "acct_1",
                "payer_id": None,
                "status": "paid",
                "last_stripe_event_created": 200,
            }],
        })

        service._project_invoice_event({
            "id": "in_1",
            "status": "open",
            "amount_due": 12900,
            "amount_paid": 0,
            "amount_remaining": 12900,
            "currency": "usd",
            "metadata": {"studio_id": "studio_1"},
        }, "acct_1", "invoice.finalized", event_created=100)

        self.assertEqual(service.supabase.tables["billing_invoices"][0]["status"], "paid")

    def test_standard_connect_account_uses_platform_dashboard_url(self):
        service = StripeService()
        service.settings = type("Settings", (), {"STRIPE_SECRET_KEY": "sk_test_123"})()
        service._stripe = lambda: _FakeStripe

        url = service.create_connect_dashboard_url(account_id="acct_connected")

        self.assertEqual(
            url,
            "https://dashboard.stripe.com/acct_platform/test/connect/accounts/acct_connected/activity",
        )
        self.assertNotIn(("create_login_link", "acct_connected"), _FakeStripe.Account.calls)

    def test_connect_account_creation_uses_accounts_v2_full_dashboard(self):
        service = StripeService()
        service.settings = type("Settings", (), {"STRIPE_SECRET_KEY": "sk_live_123"})()
        calls = []

        def fake_v2_post(path, payload, *, idempotency_key=None):
            calls.append((path, payload, idempotency_key))
            return {"id": "acct_v2", "object": "v2.core.account"}

        service._stripe_v2_post = fake_v2_post

        account = service.create_connect_account(
            studio_id="studio_1",
            business_name="River City Martial Arts",
            contact_email="owner@example.com",
        )

        self.assertEqual(account["id"], "acct_v2")
        path, payload, idempotency_key = calls[0]
        self.assertEqual(path, "/v2/core/accounts")
        self.assertEqual(idempotency_key, "koaryu-connect-account-studio_1-g1")
        self.assertEqual(payload["dashboard"], "full")
        self.assertEqual(payload["contact_email"], "owner@example.com")
        self.assertEqual(payload["identity"]["entity_type"], "company")
        self.assertEqual(payload["metadata"]["business_entity_type"], "company")
        self.assertEqual(payload["configuration"]["merchant"]["capabilities"]["card_payments"]["requested"], True)
        self.assertEqual(payload["defaults"]["responsibilities"]["fees_collector"], "stripe")
        self.assertEqual(payload["defaults"]["responsibilities"]["losses_collector"], "stripe")

    def test_connect_account_creation_passes_individual_entity_type(self):
        service = StripeService()
        service.settings = type("Settings", (), {"STRIPE_SECRET_KEY": "sk_live_123"})()
        calls = []

        def fake_v2_post(path, payload, *, idempotency_key=None):
            calls.append((path, payload, idempotency_key))
            return {"id": "acct_v2", "object": "v2.core.account"}

        service._stripe_v2_post = fake_v2_post

        service.create_connect_account(
            studio_id="studio_1",
            business_name="River City Martial Arts",
            contact_email="owner@example.com",
            business_entity_type="individual",
        )

        payload = calls[0][1]
        self.assertEqual(payload["identity"]["entity_type"], "individual")
        self.assertNotIn("business_details", payload["identity"])
        self.assertEqual(payload["metadata"]["business_entity_type"], "individual")

    def test_connected_account_branding_update_uses_accounts_v2(self):
        service = StripeService()
        service.settings = type("Settings", (), {"STRIPE_SECRET_KEY": "sk_live_123"})()
        calls = []

        def fake_v2_patch(path, payload, *, idempotency_key=None):
            calls.append((path, payload, idempotency_key))
            return {"id": "acct_v2"}

        service._stripe_v2_patch = fake_v2_patch

        service.update_connect_account_branding(
            account_id="acct_v2",
            primary_color="#0B0D10",
            secondary_color="#D6B25E",
            icon_file_id="file_icon",
            logo_file_id="file_logo",
        )

        path, payload, idempotency_key = calls[0]
        self.assertEqual(path, "/v2/core/accounts/acct_v2")
        self.assertEqual(idempotency_key, "koaryu-connect-branding-acct_v2")
        self.assertEqual(payload["configuration"]["merchant"]["branding"], {
            "primary_color": "#0B0D10",
            "secondary_color": "#D6B25E",
            "icon": "file_icon",
            "logo": "file_logo",
        })

    def test_connected_account_branding_update_falls_back_to_accounts_v1(self):
        service = StripeService()
        service.settings = type("Settings", (), {"STRIPE_SECRET_KEY": "sk_live_123"})()
        calls = []

        class _BrandingAccount:
            @staticmethod
            def modify(account_id, **payload):
                calls.append((account_id, payload))
                return {"id": account_id}

        class _BrandingStripe:
            Account = _BrandingAccount()

        def fake_v2_patch(*_args, **_kwargs):
            raise _StripeV2RequestError(code="accounts_v2_access_blocked", message="blocked")

        service._stripe_v2_patch = fake_v2_patch
        service._stripe = lambda: _BrandingStripe

        service.update_connect_account_branding(
            account_id="acct_v1",
            primary_color="#0B0D10",
            secondary_color="#D6B25E",
        )

        account_id, payload = calls[0]
        self.assertEqual(account_id, "acct_v1")
        self.assertEqual(payload["settings"]["branding"], {
            "primary_color": "#0B0D10",
            "secondary_color": "#D6B25E",
        })
        self.assertEqual(payload["idempotency_key"], "koaryu-connect-branding-acct_v1")

    def test_existing_connect_account_uses_default_refresh_and_return_urls_without_studio_lookup(self):
        service = self.service()
        service.settings = type("Settings", (), {
            "BILLING_PLATFORM_FEE_BPS": 50,
            "FRONTEND_URL": "https://app.koaryu.test",
        })()
        service.supabase = _FakeSupabase({
            "studio_payment_accounts": [{
                "studio_id": "studio_1",
                "stripe_connected_account_id": "acct_existing",
                "status": "onboarding_incomplete",
                "charges_enabled": False,
                "payouts_enabled": False,
                "details_submitted": False,
                "requirements_due": [],
                "platform_fee_bps": 50,
                "metadata": {},
            }],
        })
        _FakeStripeService.onboarding_calls = []
        service._audit = lambda *_args, **_kwargs: self.fail("Hot onboarding path should not wait on audit writes.")

        with patch("app.services.billing_service.StripeService", _FakeStripeService):
            link = asyncio.run(service.create_connect_onboarding_link("studio_1", "user_1", business_entity_type="individual"))

        self.assertEqual(link.url, "https://connect.stripe.test/setup/acct_existing")
        self.assertEqual(_FakeStripeService.onboarding_calls[0]["refresh_url"], "https://app.koaryu.test/billing/connect/refresh")
        self.assertEqual(_FakeStripeService.onboarding_calls[0]["return_url"], "https://app.koaryu.test/billing?connect=return")

    def test_connect_sync_projects_current_stripe_account_requirements(self):
        service = self.service()
        service.supabase = _FakeSupabase({
            "studio_payment_accounts": [{
                "studio_id": "studio_1",
                "stripe_connected_account_id": "acct_existing",
                "status": "onboarding_incomplete",
                "charges_enabled": False,
                "payouts_enabled": False,
                "details_submitted": False,
                "requirements_due": [],
                "platform_fee_bps": 50,
                "metadata": {},
            }],
        })
        _FakeStripeService.retrieve_calls = []
        _FakeStripeService.retrieve_account_response = {
            "id": "acct_existing",
            "charges_enabled": False,
            "payouts_enabled": True,
            "details_submitted": True,
            "requirements": {"currently_due": ["external_account"]},
        }

        with patch("app.services.billing_service.StripeService", _FakeStripeService):
            response = asyncio.run(service.sync_connect_account("studio_1"))

        self.assertEqual(response.status, "action_required")
        self.assertEqual(_FakeStripeService.retrieve_calls, ["acct_existing"])
        self.assertFalse(response.charges_enabled)
        self.assertTrue(response.payouts_enabled)
        self.assertTrue(response.details_submitted)
        self.assertEqual(response.requirements_due, ["external_account"])

    def test_get_payment_account_refreshes_stale_connected_account(self):
        service = self.service()
        service.supabase = _FakeSupabase({
            "studio_payment_accounts": [{
                "studio_id": "studio_1",
                "stripe_connected_account_id": "acct_existing",
                "status": "charges_enabled",
                "charges_enabled": True,
                "payouts_enabled": True,
                "details_submitted": True,
                "requirements_due": [],
                "platform_fee_bps": 50,
                "metadata": {},
                "updated_at": "2026-01-01T00:00:00+00:00",
            }],
        })
        _FakeStripeService.retrieve_calls = []
        _FakeStripeService.retrieve_account_response = {
            "id": "acct_existing",
            "charges_enabled": False,
            "payouts_enabled": True,
            "details_submitted": True,
            "requirements": {"currently_due": ["individual.id_number"]},
        }

        with patch("app.services.billing_service.StripeService", _FakeStripeService):
            response = asyncio.run(service.get_payment_account("studio_1"))

        self.assertEqual(_FakeStripeService.retrieve_calls, ["acct_existing"])
        self.assertEqual(response.status, "action_required")
        self.assertFalse(response.charges_enabled)
        self.assertEqual(response.requirements_due, ["individual.id_number"])

    def test_connect_ready_uses_live_stripe_status_before_hosted_actions(self):
        service = self.service()
        service.supabase = _FakeSupabase({
            "studio_payment_accounts": [{
                "studio_id": "studio_1",
                "stripe_connected_account_id": "acct_existing",
                "status": "charges_enabled",
                "charges_enabled": True,
                "payouts_enabled": True,
                "details_submitted": True,
                "requirements_due": [],
                "platform_fee_bps": 50,
                "metadata": {},
            }],
        })
        _FakeStripeService.retrieve_calls = []
        _FakeStripeService.retrieve_account_response = {
            "id": "acct_existing",
            "charges_enabled": False,
            "payouts_enabled": True,
            "details_submitted": True,
            "requirements": {"currently_due": ["external_account"]},
        }

        with patch("app.services.billing_service.StripeService", _FakeStripeService):
            with self.assertRaises(HTTPException) as context:
                service._ensure_connect_ready("studio_1")

        self.assertEqual(_FakeStripeService.retrieve_calls, ["acct_existing"])
        self.assertEqual(context.exception.status_code, 409)
        self.assertIn("charges are not enabled", context.exception.detail)

    def test_billing_system_status_reports_live_readiness_and_webhook_health(self):
        service = self.service()
        now = datetime.now(timezone.utc)
        service.settings = type("Settings", (), {
            "BILLING_PLATFORM_FEE_BPS": 50,
            "STRIPE_SECRET_KEY": "sk_live_123",
            "STRIPE_KOARYU_CORE_PRICE_ID": "price_core",
            "STRIPE_PLATFORM_WEBHOOK_SECRET": "whsec_platform",
            "STRIPE_CONNECT_WEBHOOK_SECRET": "whsec_connect",
        })()
        service.supabase = _FakeSupabase({
            "studio_payment_accounts": [{
                "studio_id": "studio_1",
                "stripe_connected_account_id": "acct_existing",
                "status": "charges_enabled",
                "charges_enabled": True,
                "payouts_enabled": True,
                "details_submitted": True,
                "requirements_due": [],
                "platform_fee_bps": 50,
                "metadata": {},
                "updated_at": now.isoformat(),
            }],
            "stripe_events": [
                {
                    "stripe_account_id": None,
                    "type": "customer.subscription.updated",
                    "processing_status": "processed",
                    "processed_at": now.isoformat(),
                    "created_at": now.isoformat(),
                },
                {
                    "stripe_account_id": "acct_existing",
                    "type": "invoice.paid",
                    "processing_status": "processed",
                    "processed_at": now.isoformat(),
                    "created_at": now.isoformat(),
                },
            ],
        })

        response = asyncio.run(service.get_system_status("studio_1"))

        self.assertTrue(response.ready_for_live_payments)
        self.assertEqual(response.payment_account.status, "charges_enabled")
        self.assertEqual(response.connect_webhooks.latest_event_type, "invoice.paid")
        self.assertFalse([check for check in response.checks if check.status == "fail"])

    def test_billing_system_status_flags_stale_connect_webhook_processing(self):
        service = self.service()
        old = datetime.now(timezone.utc) - timedelta(minutes=20)
        service.settings = type("Settings", (), {
            "BILLING_PLATFORM_FEE_BPS": 50,
            "STRIPE_SECRET_KEY": "sk_live_123",
            "STRIPE_KOARYU_CORE_PRICE_ID": "price_core",
            "STRIPE_PLATFORM_WEBHOOK_SECRET": "whsec_platform",
            "STRIPE_CONNECT_WEBHOOK_SECRET": "whsec_connect",
        })()
        service.supabase = _FakeSupabase({
            "studio_payment_accounts": [{
                "studio_id": "studio_1",
                "stripe_connected_account_id": "acct_existing",
                "status": "charges_enabled",
                "charges_enabled": True,
                "payouts_enabled": True,
                "details_submitted": True,
                "requirements_due": [],
                "platform_fee_bps": 50,
                "metadata": {},
                "updated_at": datetime.now(timezone.utc).isoformat(),
            }],
            "stripe_events": [{
                "stripe_account_id": "acct_existing",
                "type": "invoice.paid",
                "processing_status": "processing",
                "processed_at": None,
                "created_at": old.isoformat(),
            }],
        })

        response = asyncio.run(service.get_system_status("studio_1"))

        self.assertFalse(response.ready_for_live_payments)
        self.assertEqual(response.connect_webhooks.stale_processing_count, 1)

    def test_reconcile_invoice_by_stripe_id_repairs_local_projection(self):
        service = self.service()
        service.supabase = _FakeSupabase({
            "studio_payment_accounts": [{
                "studio_id": "studio_1",
                "stripe_connected_account_id": "acct_existing",
                "status": "charges_enabled",
                "charges_enabled": True,
                "payouts_enabled": True,
                "details_submitted": True,
                "requirements_due": [],
                "platform_fee_bps": 50,
                "metadata": {},
            }],
            "billing_invoices": [{
                "id": "invoice_1",
                "studio_id": "studio_1",
                "stripe_invoice_id": "in_1",
                "stripe_account_id": "acct_existing",
                "payer_id": "payer_1",
                "status": "draft",
                "amount_due_cents": 0,
                "amount_paid_cents": 0,
                "amount_remaining_cents": 0,
                "currency": "usd",
            }],
            "billing_payers": [{"id": "payer_1", "studio_id": "studio_1", "billing_status": "current", "balance_cents": 0}],
            "audit_logs": [],
        })
        _FakeStripeService.retrieve_calls = []
        _FakeStripeService.retrieve_account_response = {
            "id": "acct_existing",
            "charges_enabled": True,
            "payouts_enabled": True,
            "details_submitted": True,
            "requirements": {"currently_due": []},
        }
        _FakeStripeService.invoice_response = {
            "id": "in_1",
            "status": "open",
            "amount_due": 123,
            "amount_paid": 0,
            "amount_remaining": 123,
            "currency": "usd",
            "customer": "cus_1",
            "metadata": {"studio_id": "studio_1", "invoice_id": "invoice_1"},
            "created": 200,
        }

        with patch("app.services.billing_service.StripeService", _FakeStripeService):
            response = asyncio.run(service.reconcile_stripe_object(
                BillingReconcileRequest(object_type="invoice", stripe_object_id="in_1"),
                "studio_1",
                "user_1",
            ))

        self.assertEqual(response.local_object_id, "invoice_1")
        self.assertEqual(response.status, "open")
        self.assertEqual(service.supabase.tables["billing_invoices"][0]["amount_due_cents"], 123)
        self.assertEqual(service.supabase.tables["billing_payers"][0]["balance_cents"], 123)

    def test_connect_reset_clears_stale_account_when_no_stripe_history_exists(self):
        service = self.service()
        service.supabase = _FakeSupabase({
            "studio_payment_accounts": [{
                "studio_id": "studio_1",
                "stripe_connected_account_id": "acct_stale",
                "status": "action_required",
                "charges_enabled": False,
                "payouts_enabled": False,
                "details_submitted": False,
                "requirements_due": ["external_account"],
                "platform_fee_bps": 50,
                "metadata": {},
            }],
            "billing_plans": [],
            "billing_payers": [],
            "billing_subscriptions": [],
            "billing_invoices": [],
            "billing_payments": [],
            "billing_refunds": [],
            "billing_disputes": [],
            "audit_logs": [],
        })

        response = asyncio.run(service.reset_connect_account("studio_1", "user_1"))

        self.assertEqual(response.status, "not_connected")
        self.assertIsNone(response.stripe_connected_account_id)
        self.assertEqual(
            service.supabase.tables["studio_payment_accounts"][0]["metadata"]["previous_stripe_connected_account_ids"],
            ["acct_stale"],
        )
        self.assertEqual(
            service.supabase.tables["studio_payment_accounts"][0]["metadata"]["connect_account_generation"],
            2,
        )

    def test_connect_reset_blocks_when_stripe_history_exists(self):
        service = self.service()
        service.supabase = _FakeSupabase({
            "studio_payment_accounts": [{
                "studio_id": "studio_1",
                "stripe_connected_account_id": "acct_stale",
                "status": "action_required",
                "charges_enabled": False,
                "payouts_enabled": False,
                "details_submitted": False,
                "requirements_due": [],
                "platform_fee_bps": 50,
                "metadata": {},
            }],
            "billing_plans": [{"id": "plan_1", "studio_id": "studio_1", "stripe_price_id": "price_1"}],
            "billing_payers": [],
            "billing_subscriptions": [],
            "billing_invoices": [],
            "billing_payments": [],
            "billing_refunds": [],
            "billing_disputes": [],
        })

        with self.assertRaises(HTTPException) as context:
            asyncio.run(service.reset_connect_account("studio_1", "user_1"))

        self.assertEqual(context.exception.status_code, 409)
        self.assertIn("already has Stripe billing history", context.exception.detail)

    def test_stale_connected_account_returns_actionable_conflict(self):
        service = StripeService()
        service.settings = type("Settings", (), {"STRIPE_SECRET_KEY": "sk_live_123"})()
        service._stripe = lambda: _FakeStripeWithMismatchedAccount

        with self.assertRaises(HTTPException) as context:
            service.create_connect_dashboard_url(account_id="acct_from_other_platform")

        self.assertEqual(context.exception.status_code, 409)
        self.assertIn("Reconnect Stripe Payments in live mode", context.exception.detail)


if __name__ == "__main__":
    unittest.main()
