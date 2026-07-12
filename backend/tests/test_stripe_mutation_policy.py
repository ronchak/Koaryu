from types import SimpleNamespace
import unittest
from unittest.mock import Mock

from fastapi import HTTPException

from app.services.stripe_mutation_policy import (
    LIVE_MUTATIONS_DISABLED_DETAIL,
    LIVE_MUTATIONS_REQUIRE_DURABLE_AUTHORIZATION_DETAIL,
    STRIPE_MODE_MISMATCH_DETAIL,
    StripeMutationPolicy,
)
from app.services.stripe_service import StripeService


def _settings(*, mode: str, live_enabled: bool = False, key_mode: str | None = None):
    effective_key_mode = key_mode or mode
    return SimpleNamespace(
        STRIPE_MODE=mode,
        LIVE_BILLING_ENABLED=live_enabled,
        STRIPE_SECRET_KEY=f"sk_{effective_key_mode}_fixture",
        STRIPE_KOARYU_CORE_PRICE_ID="price_fixture",
    )


class _Customer:
    calls = []

    @classmethod
    def create(cls, **payload):
        cls.calls.append(payload)
        return {"id": "cus_test"}


class _Stripe:
    Customer = _Customer


class StripeMutationPolicyTest(unittest.TestCase):
    def test_test_mode_mutations_are_automatically_permitted(self):
        service = StripeService()
        service.settings = _settings(mode="test")
        service._stripe = lambda: _Stripe
        _Customer.calls = []

        customer = service.create_customer(name="Test Studio", metadata={"studio_id": "studio_1"})

        self.assertEqual(customer["id"], "cus_test")
        self.assertEqual(len(_Customer.calls), 1)

    def test_live_mutations_fail_before_loading_stripe_when_switch_is_off(self):
        service = StripeService()
        service.settings = _settings(mode="live", live_enabled=False)
        service._stripe = Mock(side_effect=AssertionError("Stripe client must not load"))

        with self.assertRaises(HTTPException) as raised:
            service.create_customer(name="Live Studio", metadata={})

        self.assertEqual(raised.exception.status_code, 503)
        self.assertEqual(raised.exception.detail, LIVE_MUTATIONS_DISABLED_DETAIL)
        service._stripe.assert_not_called()

    def test_live_switch_is_not_sufficient_without_durable_authorization(self):
        policy = StripeMutationPolicy(_settings(mode="live", live_enabled=True))

        with self.assertRaises(HTTPException) as raised:
            policy.issue_permit("customer.create")

        self.assertEqual(raised.exception.status_code, 503)
        self.assertEqual(
            raised.exception.detail,
            LIVE_MUTATIONS_REQUIRE_DURABLE_AUTHORIZATION_DETAIL,
        )
        self.assertFalse(policy.live_payments_authorized())

    def test_declared_mode_and_secret_key_must_match(self):
        policy = StripeMutationPolicy(_settings(mode="test", key_mode="live"))

        with self.assertRaises(HTTPException) as raised:
            policy.issue_permit("customer.create")

        self.assertEqual(raised.exception.detail, STRIPE_MODE_MISMATCH_DETAIL)

    def test_declared_mode_without_a_secret_key_fails_closed(self):
        settings = _settings(mode="test")
        settings.STRIPE_SECRET_KEY = ""

        with self.assertRaises(HTTPException) as raised:
            StripeMutationPolicy(settings).issue_permit("customer.create")

        self.assertEqual(raised.exception.detail, STRIPE_MODE_MISMATCH_DETAIL)

    def test_every_direct_stripe_service_mutation_is_policy_marked(self):
        expected = {
            "_stripe_v2_patch",
            "_stripe_v2_post",
            "_stripe_v2_request",
            "cancel_connected_subscription",
            "create_connect_account",
            "create_connect_onboarding_link",
            "create_connected_customer",
            "create_connected_invoice",
            "create_connected_invoice_item",
            "create_connected_price",
            "create_connected_product",
            "create_connected_refund",
            "create_connected_subscription",
            "create_connected_subscription_item",
            "create_core_checkout_session",
            "create_customer",
            "create_customer_portal_session",
            "create_setup_checkout_session",
            "delete_connected_subscription_item",
            "finalize_connected_invoice",
            "pay_connected_invoice",
            "send_connected_invoice",
            "set_connected_customer_default_payment_method",
            "update_connect_account_branding",
            "update_connected_customer",
            "update_connected_product",
            "update_connected_subscription",
            "update_connected_subscription_item",
            "upload_branding_file",
            "void_connected_invoice",
        }
        marked = {
            name
            for name in dir(StripeService)
            if getattr(
                getattr(StripeService, name),
                "__stripe_mutation_operation__",
                None,
            )
        }

        self.assertEqual(marked, expected)

    def test_live_legacy_dashboard_login_link_is_closed_without_mutating(self):
        calls = []

        class _Account:
            @staticmethod
            def retrieve(_account_id):
                return {"id": "acct_legacy", "type": "express"}

            @staticmethod
            def create_login_link(account_id):
                calls.append(account_id)
                return {"url": "https://dashboard.stripe.test/login"}

        service = StripeService()
        service.settings = _settings(mode="live", live_enabled=False)
        service._stripe = lambda: SimpleNamespace(Account=_Account)

        with self.assertRaises(HTTPException) as raised:
            service.create_connect_dashboard_url(account_id="acct_legacy")

        self.assertEqual(raised.exception.detail, LIVE_MUTATIONS_DISABLED_DETAIL)
        self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main()
