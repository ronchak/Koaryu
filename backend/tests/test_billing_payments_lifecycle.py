from __future__ import annotations

import asyncio
import unittest
from unittest.mock import patch

from fastapi import HTTPException

from app.schemas.billing import (
    BillingInvoiceResponse,
    StudentBillingEnrollmentCreate,
    StudentBillingEnrollmentResponse,
)
from app.services.billing_service import BillingService
from app.services.stripe_service import StripeService


class _FakeResponse:
    def __init__(self, data):
        self.data = data


class _FakeQuery:
    def __init__(self, rows):
        self.rows = rows
        self.filters = []
        self.update_values = None

    def select(self, *_args):
        return self

    def limit(self, *_args):
        return self

    def single(self):
        return self

    def maybe_single(self):
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
            self.filters.append(lambda row, key=key: row.get(key) is None)
        return self

    def in_(self, key, values):
        values = set(values)
        self.filters.append(lambda row, key=key, values=values: row.get(key) in values)
        return self

    def execute(self):
        matched = [row for row in self.rows if all(match(row) for match in self.filters)]
        if self.update_values is not None:
            for row in matched:
                row.update(self.update_values)
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
    retrieve_account_response = None

    def create_connect_onboarding_link(self, *, account_id: str, refresh_url: str, return_url: str):
        self.__class__.onboarding_calls.append({
            "account_id": account_id,
            "refresh_url": refresh_url,
            "return_url": return_url,
        })
        return {"url": f"https://connect.stripe.test/setup/{account_id}"}

    def retrieve_account(self, *, account_id: str):
        return self.__class__.retrieve_account_response or {
            "id": account_id,
            "charges_enabled": False,
            "payouts_enabled": False,
            "details_submitted": False,
            "requirements": {"currently_due": []},
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
        self.assertEqual(idempotency_key, "koaryu-connect-account-studio_1")
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
        self.assertFalse(response.charges_enabled)
        self.assertTrue(response.payouts_enabled)
        self.assertTrue(response.details_submitted)
        self.assertEqual(response.requirements_due, ["external_account"])

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
