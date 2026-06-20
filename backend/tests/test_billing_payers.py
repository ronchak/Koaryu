from __future__ import annotations

import asyncio
import unittest

from fastapi import HTTPException

from app.schemas.billing import BillingPayerCreate, BillingPayerUpdate
from app.services.billing_payers import BillingPayerManager
from tests.fakes.supabase import TableBackedSupabase


def _payer_defaults(_table: str) -> dict:
    return {
        "autopay_status": "not_configured",
        "billing_status": "no_payment_method",
        "balance_cents": 0,
        "created_at": "2026-01-01T00:00:00Z",
        "updated_at": "2026-01-01T00:00:00Z",
    }


class _ConnectAccounts:
    def __init__(self, account: dict):
        self.account = account

    def ensure_row(self, studio_id: str) -> dict:
        return {"studio_id": studio_id, **self.account}


class _BillingFacade:
    def __init__(self, tables: dict[str, list[dict]], account: dict | None = None):
        self.supabase = TableBackedSupabase(tables)
        self.supabase.insert_defaults["billing_payers"] = _payer_defaults
        self.account = account or {"charges_enabled": False, "stripe_connected_account_id": None}
        self.validated_accounts: list[dict] = []

    def _connect_accounts(self) -> _ConnectAccounts:
        return _ConnectAccounts(self.account)

    def _ensure_connect_ready(self, studio_id: str) -> dict:
        account = self._connect_accounts().ensure_row(studio_id)
        if not account.get("charges_enabled"):
            raise HTTPException(status_code=409, detail="Stripe Connect charges are not enabled yet.")
        return account

    def _get_row_or_404(self, table: str, record_id: str, studio_id: str, detail: str) -> dict:
        result = self.supabase.table(table).select("*").eq("id", record_id).eq("studio_id", studio_id).limit(1).execute()
        if not result.data:
            raise HTTPException(status_code=404, detail=detail)
        return result.data[0]

    def _ensure_record_in_studio(self, table: str, record_id: str, studio_id: str, detail: str) -> None:
        self._get_row_or_404(table, record_id, studio_id, detail)

    def _validate_connect_account_access(self, account: dict) -> None:
        self.validated_accounts.append(account)

    def _idempotency_key(self, *parts: str) -> str:
        return "koaryu:" + ":".join(parts)

    def _audit(self, studio_id: str, actor_id: str, action: str, entity_id: str, metadata: dict) -> None:
        self.supabase.table("audit_logs").insert({
            "studio_id": studio_id,
            "actor_id": actor_id,
            "action": action,
            "entity_id": entity_id,
            "metadata": metadata,
        }).execute()


class _FakeStripeService:
    created_customers: list[dict] = []

    @classmethod
    def reset(cls) -> None:
        cls.created_customers = []

    def create_connected_customer(self, **payload):
        self.__class__.created_customers.append(payload)
        return {"id": "cus_created"}

    def update_connected_customer(self, **_payload):
        raise AssertionError("New payer sync should create a customer, not update one.")

    def retrieve_connected_customer(self, **_payload):
        return {
            "id": "cus_created",
            "invoice_settings": {
                "default_payment_method": {
                    "id": "pm_card",
                    "type": "card",
                    "card": {"brand": "visa", "last4": "4242", "exp_month": 12, "exp_year": 2030},
                }
            },
        }


class BillingPayerManagerTests(unittest.TestCase):
    def test_create_update_get_and_list_payers_without_stripe(self):
        facade = _BillingFacade({
            "guardians": [{"id": "guardian_1", "studio_id": "studio_1"}],
            "billing_payers": [{
                "id": "payer_z",
                "studio_id": "studio_1",
                "display_name": "Zed",
                "created_at": "2026-01-01T00:00:00Z",
                "updated_at": "2026-01-01T00:00:00Z",
            }],
        })
        manager = BillingPayerManager(facade)

        created = asyncio.run(manager.create_payer(
            BillingPayerCreate(display_name="Alice", guardian_id="guardian_1", email="alice@example.com"),
            "studio_1",
            "actor_1",
        ))
        updated = asyncio.run(manager.update_payer(
            created.id,
            BillingPayerUpdate(phone="555-0100"),
            "studio_1",
            "actor_1",
        ))
        fetched = asyncio.run(manager.get_payer(created.id, "studio_1"))
        listed = asyncio.run(manager.list_payers("studio_1"))

        self.assertEqual(created.display_name, "Alice")
        self.assertEqual(updated.phone, "555-0100")
        self.assertEqual(fetched.email, "alice@example.com")
        self.assertEqual([payer.display_name for payer in listed], ["Alice", "Zed"])
        self.assertEqual(facade.supabase.tables["audit_logs"][0]["action"], "billing.payer_created")

    def test_sync_payer_customer_uses_injected_stripe_and_records_saved_card(self):
        _FakeStripeService.reset()
        facade = _BillingFacade({
            "billing_payers": [{
                "id": "payer_1",
                "studio_id": "studio_1",
                "display_name": "Pat",
                "autopay_status": "pending",
                "billing_status": "no_payment_method",
                "created_at": "2026-01-01T00:00:00Z",
                "updated_at": "2026-01-01T00:00:00Z",
            }]
        })
        manager = BillingPayerManager(facade, stripe_service_cls=_FakeStripeService)

        updated = manager._sync_payer_customer(
            facade.supabase.tables["billing_payers"][0],
            {"stripe_connected_account_id": "acct_1"},
        )

        self.assertEqual(_FakeStripeService.created_customers[0]["idempotency_key"], "koaryu:payer-customer:payer_1")
        self.assertEqual(updated["stripe_customer_id"], "cus_created")
        self.assertEqual(updated["default_payment_method_id"], "pm_card")
        self.assertEqual(updated["default_payment_method_brand"], "visa")
        self.assertEqual(updated["billing_status"], "current")
        self.assertEqual(updated["autopay_status"], "pending")

    def test_customer_lookup_respects_connected_account_scope(self):
        manager = BillingPayerManager(_BillingFacade({
            "billing_payers": [
                {"id": "payer_platform", "studio_id": "studio_1", "stripe_account_id": None, "stripe_customer_id": "cus_1"},
                {"id": "payer_connected", "studio_id": "studio_1", "stripe_account_id": "acct_1", "stripe_customer_id": "cus_1"},
            ],
        }))

        self.assertEqual(manager._payer_id_for_customer("studio_1", None, "cus_1"), "payer_platform")
        self.assertEqual(manager._payer_id_for_customer("studio_1", "acct_1", "cus_1"), "payer_connected")
        self.assertIsNone(manager._payer_id_for_customer("studio_1", "acct_2", "cus_1"))

    def test_recompute_payer_balance_ignores_terminal_invoice_states(self):
        facade = _BillingFacade({
            "billing_payers": [{"id": "payer_1", "studio_id": "studio_1", "balance_cents": 0, "billing_status": "current"}],
            "billing_invoices": [
                {"studio_id": "studio_1", "payer_id": "payer_1", "status": "open", "amount_due_cents": 2500, "amount_paid_cents": 500},
                {"studio_id": "studio_1", "payer_id": "payer_1", "status": "paid", "amount_due_cents": 9999, "amount_paid_cents": 0},
            ],
        })

        BillingPayerManager(facade)._recompute_payer_balance("studio_1", "payer_1")

        payer = facade.supabase.tables["billing_payers"][0]
        self.assertEqual(payer["balance_cents"], 2000)
        self.assertEqual(payer["billing_status"], "past_due")
