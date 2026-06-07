from __future__ import annotations

import asyncio
import hashlib
import json
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
    StudentBillingEnrollmentUpdate,
)
from app.services.billing_service import BillingService
from app.services.stripe_service import StripeService
from app.services.stripe_service import _StripeV2RequestError
from tests.fakes.supabase import RpcBackedSupabase


class _FakeSupabase(RpcBackedSupabase):
    def __init__(self, tables):
        super().__init__(tables)

    def _rpc_claim_billing_subscription_quantity_sync(self, params: dict) -> list[dict]:
        subscription = next(
            (
                row
                for row in self.tables.setdefault("billing_subscriptions", [])
                if row.get("id") == params["p_billing_subscription_id"]
                and row.get("studio_id") == params["p_studio_id"]
            ),
            None,
        )
        if subscription is None:
            raise AssertionError("Billing subscription not found")
        metadata = dict(subscription.get("metadata") or {})
        current = metadata.get("stripe_quantity_sync_lock")
        if current and current.get("token") != params["p_lock_token"]:
            return [{
                "claimed": False,
                "lock_owner": current.get("token"),
                "locked_at": current.get("locked_at"),
            }]
        metadata["stripe_quantity_sync_lock"] = {
            "token": params["p_lock_token"],
            "locked_at": "2026-01-01T00:00:00Z",
        }
        subscription["metadata"] = metadata
        return [{
            "claimed": True,
            "lock_owner": params["p_lock_token"],
            "locked_at": "2026-01-01T00:00:00Z",
        }]

    def _rpc_finish_billing_subscription_quantity_sync(self, params: dict) -> bool:
        subscription = next(
            (
                row
                for row in self.tables.setdefault("billing_subscriptions", [])
                if row.get("id") == params["p_billing_subscription_id"]
                and row.get("studio_id") == params["p_studio_id"]
            ),
            None,
        )
        if subscription is None:
            raise AssertionError("Billing subscription not found")
        metadata = dict(subscription.get("metadata") or {})
        current = metadata.get("stripe_quantity_sync_lock")
        if not current or current.get("token") != params["p_lock_token"]:
            return False
        metadata.pop("stripe_quantity_sync_lock", None)
        subscription["metadata"] = metadata
        return True


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

    @classmethod
    def reset(cls):
        cls.Account = _FakeStripeAccount()


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
    connect_account_calls = []
    onboarding_calls = []
    setup_calls = []
    subscription_update_calls = []
    subscription_item_update_calls = []
    subscription_item_delete_calls = []
    subscription_cancel_calls = []
    retrieve_calls = []
    finalize_invoice_calls = []
    send_invoice_calls = []
    retrieve_account_response = None
    invoice_response = None
    finalize_invoice_response = None
    send_invoice_response = None
    send_invoice_error = None
    subscription_response = None
    payment_intent_response = None

    @classmethod
    def reset(cls):
        cls.connect_account_calls = []
        cls.onboarding_calls = []
        cls.setup_calls = []
        cls.subscription_update_calls = []
        cls.subscription_item_update_calls = []
        cls.subscription_item_delete_calls = []
        cls.subscription_cancel_calls = []
        cls.retrieve_calls = []
        cls.finalize_invoice_calls = []
        cls.send_invoice_calls = []
        cls.retrieve_account_response = None
        cls.invoice_response = None
        cls.finalize_invoice_response = None
        cls.send_invoice_response = None
        cls.send_invoice_error = None
        cls.subscription_response = None
        cls.payment_intent_response = None

    def create_connect_account(self, **payload):
        self.__class__.connect_account_calls.append(payload)
        return {"id": "acct_created"}

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

    def finalize_connected_invoice(self, *, account_id: str, invoice_id: str):
        self.__class__.finalize_invoice_calls.append({
            "account_id": account_id,
            "invoice_id": invoice_id,
        })
        return self.__class__.finalize_invoice_response or {
            "id": invoice_id,
            "status": "open",
            "collection_method": "send_invoice",
            "amount_due": 123,
            "amount_paid": 0,
            "amount_remaining": 123,
            "currency": "usd",
            "customer": "cus_1",
            "metadata": {"studio_id": "studio_1", "invoice_id": "invoice_1"},
            "created": 200,
        }

    def send_connected_invoice(self, *, account_id: str, invoice_id: str):
        self.__class__.send_invoice_calls.append({
            "account_id": account_id,
            "invoice_id": invoice_id,
        })
        if self.__class__.send_invoice_error:
            raise self.__class__.send_invoice_error
        return self.__class__.send_invoice_response or self.finalize_connected_invoice(
            account_id=account_id,
            invoice_id=invoice_id,
        )

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

    def update_connected_subscription_item(self, **payload):
        self.__class__.subscription_item_update_calls.append(payload)
        return {"id": payload["subscription_item_id"]}

    def update_connected_subscription(self, **payload):
        self.__class__.subscription_update_calls.append(payload)
        return {"id": payload["subscription_id"], **payload}

    def delete_connected_subscription_item(self, **payload):
        self.__class__.subscription_item_delete_calls.append(payload)
        return {"id": payload["subscription_item_id"], "deleted": True}

    def cancel_connected_subscription(self, **payload):
        self.__class__.subscription_cancel_calls.append(payload)
        return {"id": payload["subscription_id"], "status": "canceled"}

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


class _FakeBillingSettings:
    BILLING_PLATFORM_FEE_BPS = 50
    FRONTEND_URL = "https://app.koaryu.test"


def _test_invoice_request_hash(data: BillingInvoiceCreate) -> str:
    payload = data.model_dump(mode="json", exclude_none=True)
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()



class BillingPaymentsLifecycleTestBase(unittest.TestCase):
    def setUp(self):
        _FakeStripe.reset()
        _FakeStripeService.reset()

    def service(self) -> BillingService:
        with patch("app.services.billing_service.get_settings", return_value=_FakeBillingSettings()):
            return BillingService(None)
