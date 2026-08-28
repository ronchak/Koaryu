from __future__ import annotations

import asyncio
import unittest

from fastapi import HTTPException

from app.schemas.billing import BillingPayerCreate, BillingPayerUpdate
from app.services.billing_payers import BillingPayerManager
from app.services.billing_provider_operations import (
    BillingProviderOperationContext,
    BillingProviderOperationCoordinator,
)
from app.services.stripe_mutation_policy import StripeMutationBlocked
from tests.fakes.billing_provider_operations import BillingProviderOperationRpcMixin
from tests.fakes.supabase import RpcBackedSupabase


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


class _PayerSupabase(BillingProviderOperationRpcMixin, RpcBackedSupabase):
    def __init__(self, tables):
        super().__init__(tables)
        self.initialize_billing_provider_operations()


class _BillingFacade:
    def __init__(self, tables: dict[str, list[dict]], account: dict | None = None):
        self.supabase = _PayerSupabase(tables)
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
    updated_customers: list[dict] = []
    retrieved_customers: list[dict] = []
    provider_error: Exception | None = None
    customer_response: dict | None = None

    @classmethod
    def reset(cls) -> None:
        cls.created_customers = []
        cls.updated_customers = []
        cls.retrieved_customers = []
        cls.provider_error = None
        cls.customer_response = None

    def create_connected_customer(self, **payload):
        self.__class__.created_customers.append(payload)
        if self.__class__.provider_error:
            raise self.__class__.provider_error
        return {
            "id": "cus_created",
            "invoice_settings": {
                "default_payment_method": {
                    "id": "pm_card",
                    "type": "card",
                    "card": {
                        "brand": "visa",
                        "last4": "4242",
                        "exp_month": 12,
                        "exp_year": 2030,
                    },
                },
            },
        }

    def update_connected_customer(self, **payload):
        self.__class__.updated_customers.append(payload)
        if self.__class__.provider_error:
            raise self.__class__.provider_error
        return {
            "id": payload["customer_id"],
            "invoice_settings": {"default_payment_method": None},
        }

    def retrieve_connected_customer(self, **_payload):
        self.__class__.retrieved_customers.append(_payload)
        return self.__class__.customer_response or {
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
    def test_payer_sync_preserves_active_consent_payment_method_when_provider_default_is_null(self):
        payer = {
            "id": "payer_1", "studio_id": "studio_1", "display_name": "Pat",
            "autopay_status": "enabled", "autopay_authorized_at": "2026-08-01T00:00:00Z",
            "autopay_terms_accepted_at": "2026-08-01T00:00:00Z",
            "default_payment_method_id": "pm_verified", "default_payment_method_brand": "visa",
            "default_payment_method_last4": "4242", "default_payment_method_exp_month": 12,
            "default_payment_method_exp_year": 2030,
        }
        facade = _BillingFacade({"billing_payers": [payer], "audit_logs": [],
            "billing_payer_payment_consents": [{
                "id": "consent_1", "studio_id": "studio_1", "payer_id": "payer_1",
                "terms_version": "koaryu-autopay-v1", "stripe_connected_account_id": "acct_1",
                "connect_account_generation": 1, "accepted_at": "2026-08-01T00:00:00Z",
                "completed_at": "2026-08-01T00:00:00Z", "revoked_at": None, "superseded_at": None,
            }]}, account={
            "charges_enabled": True, "status": "charges_enabled",
            "stripe_connected_account_id": "acct_1", "metadata": {"connect_account_generation": 1},
        })
        manager = BillingPayerManager(facade, stripe_service_cls=_FakeStripeService)
        context = BillingProviderOperationContext(
            operation_id="operation_1", studio_id="studio_1", actor_id="actor_1",
            operation_type="payer.sync", caller_request_key="key", request_sha256="a" * 64,
            stripe_connected_account_id="acct_1", connect_account_generation=1,
            lease_owner="lease_1",
        )

        projected = manager._project_payer_sync_result(
            payer=payer,
            provider_customer={"id": "cus_1", "invoice_settings": {"default_payment_method": None}},
            customer_id="cus_1",
            context=context,
        )

        self.assertEqual(projected["default_payment_method_id"], "pm_verified")
        self.assertEqual(projected["default_payment_method_last4"], "4242")

    def test_payer_sync_clears_local_payment_method_without_active_consent(self):
        payer = {
            "id": "payer_1", "studio_id": "studio_1", "autopay_status": "enabled",
            "autopay_authorized_at": "2026-08-01T00:00:00Z",
            "autopay_terms_accepted_at": "2026-08-01T00:00:00Z",
            "default_payment_method_id": "pm_unproved",
        }
        facade = _BillingFacade({"billing_payers": [payer], "audit_logs": []}, account={
            "charges_enabled": True, "stripe_connected_account_id": "acct_1",
            "metadata": {"connect_account_generation": 1},
        })
        context = BillingProviderOperationContext("op","studio_1","actor_1","payer.sync","key","a"*64,"acct_1",1,"lease")
        projected = BillingPayerManager(facade)._project_payer_sync_result(
            payer=payer, provider_customer={"invoice_settings": {"default_payment_method": None}},
            customer_id="cus_1", context=context,
        )
        self.assertIsNone(projected["default_payment_method_id"])

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

    def test_create_and_update_stay_local_when_connect_is_ready(self):
        _FakeStripeService.reset()
        facade = _BillingFacade({"billing_payers": [], "audit_logs": []}, account={
            "charges_enabled": True,
            "status": "charges_enabled",
            "stripe_connected_account_id": "acct_1",
            "metadata": {"connect_account_generation": 1},
        })
        manager = BillingPayerManager(facade, stripe_service_cls=_FakeStripeService)

        created = asyncio.run(manager.create_payer(
            BillingPayerCreate(display_name="Pat"), "studio_1", "actor_1",
        ))
        updated = asyncio.run(manager.update_payer(
            created.id, BillingPayerUpdate(phone="555-0101"), "studio_1", "actor_1",
        ))

        self.assertIsNone(created.stripe_customer_id)
        self.assertIsNone(created.stripe_account_id)
        self.assertIsNone(
            facade.supabase.tables["billing_payers"][0].get(
                "connect_account_generation"
            )
        )
        self.assertEqual(updated.phone, "555-0101")
        self.assertEqual(_FakeStripeService.created_customers, [])
        self.assertEqual(_FakeStripeService.updated_customers, [])
        self.assertEqual(_FakeStripeService.retrieved_customers, [])

    def test_payer_sync_create_replays_saved_result_without_second_provider_call(self):
        _FakeStripeService.reset()
        facade = _BillingFacade(
            {
                "billing_payers": [{
                    "id": "payer_1",
                    "studio_id": "studio_1",
                    "display_name": "Pat",
                    "autopay_status": "pending",
                    "billing_status": "past_due",
                    "metadata": {},
                    "created_at": "2026-01-01T00:00:00Z",
                    "updated_at": "2026-01-01T00:00:00Z",
                }],
                "audit_logs": [],
            },
            account={
                "charges_enabled": True,
                "status": "charges_enabled",
                "stripe_connected_account_id": "acct_1",
                "metadata": {"connect_account_generation": 1},
            },
        )
        manager = BillingPayerManager(facade, stripe_service_cls=_FakeStripeService)

        first = asyncio.run(manager.sync_payer(
            "payer_1", "studio_1", "actor_1", "payer-sync-key",
        ))
        replay = asyncio.run(manager.sync_payer(
            "payer_1", "studio_1", "actor_1", "payer-sync-key",
        ))

        self.assertEqual(first.stripe_customer_id, "cus_created")
        self.assertEqual(replay.stripe_customer_id, first.stripe_customer_id)
        self.assertEqual(first.default_payment_method_id, "pm_card")
        self.assertEqual(first.default_payment_method_last4, "4242")
        self.assertEqual(first.billing_status, "past_due")
        self.assertEqual(len(_FakeStripeService.created_customers), 1)
        self.assertEqual(_FakeStripeService.updated_customers, [])
        self.assertEqual(_FakeStripeService.retrieved_customers, [])
        self.assertEqual(
            _FakeStripeService.created_customers[0]["idempotency_key"],
            "koaryu:payer-sync:00000000-0000-4000-8000-000000009001",
        )
        self.assertEqual(
            _FakeStripeService.created_customers[0]["expand"],
            ["invoice_settings.default_payment_method"],
        )
        self.assertEqual(len(facade.supabase.tables["audit_logs"]), 1)
        operation = next(iter(facade.supabase.billing_provider_operations.values()))
        self.assertEqual(operation["state"], "completed")
        self.assertEqual(operation["provider_object_id"], "cus_created")
        self.assertEqual(
            operation["result_summary"],
            "sync_mode:create:target_customer_id:none",
        )
        self.assertEqual(facade.supabase.tables["billing_payers"][0]["metadata"], {})
        self.assertNotIn("Pat", repr(operation))

    def test_payer_sync_new_key_uses_update_mode_and_new_parent_identity(self):
        _FakeStripeService.reset()
        facade = _BillingFacade(
            {
                "billing_payers": [{
                    "id": "payer_1",
                    "studio_id": "studio_1",
                    "display_name": "Pat",
                    "stripe_account_id": "acct_1",
                    "stripe_customer_id": "cus_existing",
                    "autopay_status": "not_configured",
                    "billing_status": "current",
                    "metadata": {},
                    "created_at": "2026-01-01T00:00:00Z",
                    "updated_at": "2026-01-01T00:00:00Z",
                }],
                "audit_logs": [],
            },
            account={
                "charges_enabled": True,
                "status": "charges_enabled",
                "stripe_connected_account_id": "acct_1",
                "metadata": {"connect_account_generation": 2},
            },
        )
        manager = BillingPayerManager(facade, stripe_service_cls=_FakeStripeService)

        result = asyncio.run(manager.sync_payer(
            "payer_1", "studio_1", "actor_1", "payer-sync-update-key",
        ))

        self.assertEqual(result.stripe_customer_id, "cus_existing")
        self.assertEqual(_FakeStripeService.created_customers, [])
        self.assertEqual(len(_FakeStripeService.updated_customers), 1)
        operation = next(iter(facade.supabase.billing_provider_operations.values()))
        self.assertEqual(operation["result_code"], "payer_sync_completed")
        self.assertEqual(
            operation["result_summary"],
            "sync_mode:update:target_customer_id:cus_existing",
        )
        self.assertEqual(facade.supabase.tables["billing_payers"][0]["metadata"], {})

    def test_payer_sync_different_key_collapses_and_old_key_replays_without_metadata_receipts(self):
        _FakeStripeService.reset()
        original_metadata = {"source": "guardian-import"}
        facade = _BillingFacade(
            {
                "billing_payers": [{
                    "id": "payer_1",
                    "studio_id": "studio_1",
                    "display_name": "Pat",
                    "autopay_status": "not_configured",
                    "billing_status": "current",
                    "metadata": dict(original_metadata),
                    "created_at": "2026-01-01T00:00:00Z",
                    "updated_at": "2026-01-01T00:00:00Z",
                }],
                "audit_logs": [],
            },
            account={
                "charges_enabled": True,
                "status": "charges_enabled",
                "stripe_connected_account_id": "acct_1",
                "metadata": {"connect_account_generation": 1},
            },
        )
        manager = BillingPayerManager(facade, stripe_service_cls=_FakeStripeService)

        first = asyncio.run(manager.sync_payer(
            "payer_1", "studio_1", "actor_1", "payer-sync-key-1",
        ))
        second = asyncio.run(manager.sync_payer(
            "payer_1", "studio_1", "actor_1", "payer-sync-key-2",
        ))
        first_replay = asyncio.run(manager.sync_payer(
            "payer_1", "studio_1", "actor_1", "payer-sync-key-1",
        ))

        self.assertEqual(first.stripe_customer_id, "cus_created")
        self.assertEqual(second.stripe_customer_id, "cus_created")
        self.assertEqual(first_replay.stripe_customer_id, "cus_created")
        self.assertEqual(len(_FakeStripeService.created_customers), 1)
        self.assertEqual(len(_FakeStripeService.updated_customers), 0)
        self.assertEqual(len(facade.supabase.tables["audit_logs"]), 1)
        self.assertEqual(
            facade.supabase.tables["billing_payers"][0]["metadata"],
            original_metadata,
        )
        operations = facade.supabase.billing_provider_operations.values()
        summaries = {
            operation["caller_request_key"]: operation["result_summary"]
            for operation in operations
        }
        self.assertEqual(summaries, {
            "payer-sync-key-1": "sync_mode:create:target_customer_id:none",
        })

    def test_payer_sync_same_key_rejects_changed_desired_customer_state(self):
        _FakeStripeService.reset()
        facade = _BillingFacade(
            {
                "billing_payers": [{
                    "id": "payer_1",
                    "studio_id": "studio_1",
                    "display_name": "Pat",
                    "autopay_status": "not_configured",
                    "billing_status": "current",
                    "metadata": {},
                    "created_at": "2026-01-01T00:00:00Z",
                    "updated_at": "2026-01-01T00:00:00Z",
                }],
                "audit_logs": [],
            },
            account={
                "charges_enabled": True,
                "status": "charges_enabled",
                "stripe_connected_account_id": "acct_1",
                "metadata": {"connect_account_generation": 1},
            },
        )
        manager = BillingPayerManager(facade, stripe_service_cls=_FakeStripeService)

        asyncio.run(manager.sync_payer(
            "payer_1", "studio_1", "actor_1", "payer-sync-key",
        ))
        facade.supabase.tables["billing_payers"][0]["display_name"] = "Pat Updated"
        with self.assertRaises(HTTPException) as changed:
            asyncio.run(manager.sync_payer(
                "payer_1", "studio_1", "actor_1", "payer-sync-key",
            ))

        self.assertEqual(changed.exception.status_code, 409)
        self.assertEqual(len(_FakeStripeService.created_customers), 1)
        self.assertEqual(_FakeStripeService.updated_customers, [])

    def test_payer_sync_provider_success_local_failure_requires_reconciliation(self):
        _FakeStripeService.reset()
        facade = _BillingFacade(
            {
                "billing_payers": [{
                    "id": "payer_1",
                    "studio_id": "studio_1",
                    "display_name": "Pat",
                    "autopay_status": "not_configured",
                    "billing_status": "current",
                    "metadata": {},
                    "created_at": "2026-01-01T00:00:00Z",
                    "updated_at": "2026-01-01T00:00:00Z",
                }],
            },
            account={
                "charges_enabled": True,
                "status": "charges_enabled",
                "stripe_connected_account_id": "acct_1",
                "metadata": {"connect_account_generation": 1},
            },
        )
        facade.supabase.on_update_query = lambda query, _rows: (
            []
            if query.name == "billing_payers"
            and (query.update_payload or {}).get("stripe_customer_id") == "cus_created"
            else None
        )
        manager = BillingPayerManager(facade, stripe_service_cls=_FakeStripeService)

        with self.assertRaises(HTTPException) as failed:
            asyncio.run(manager.sync_payer(
                "payer_1", "studio_1", "actor_1", "payer-sync-key",
            ))
        with self.assertRaises(HTTPException) as replay:
            asyncio.run(manager.sync_payer(
                "payer_1", "studio_1", "actor_1", "payer-sync-key",
            ))

        self.assertEqual(failed.exception.status_code, 503)
        self.assertEqual(replay.exception.status_code, 409)
        self.assertEqual(len(_FakeStripeService.created_customers), 1)
        operation = next(iter(facade.supabase.billing_provider_operations.values()))
        self.assertEqual(operation["state"], "reconciliation_required")
        self.assertEqual(
            operation["reconciliation_reason_code"],
            "payer_sync_local_projection_failed",
        )

    def test_payer_sync_rejects_missing_oversized_and_stale_generation_keys(self):
        for key in (None, "é" * 128):
            with self.subTest(key=key):
                facade = _BillingFacade(
                    {
                        "billing_payers": [{
                            "id": "payer_1",
                            "studio_id": "studio_1",
                            "display_name": "Pat",
                            "metadata": {},
                            "created_at": "2026-01-01T00:00:00Z",
                            "updated_at": "2026-01-01T00:00:00Z",
                        }],
                    },
                    account={
                        "charges_enabled": True,
                        "status": "charges_enabled",
                        "stripe_connected_account_id": "acct_1",
                        "metadata": {"connect_account_generation": 1},
                    },
                )
                with self.assertRaises(HTTPException) as context:
                    asyncio.run(BillingPayerManager(
                        facade,
                        stripe_service_cls=_FakeStripeService,
                    ).sync_payer("payer_1", "studio_1", "actor_1", key))
                self.assertEqual(context.exception.status_code, 400)
                self.assertEqual(facade.supabase.billing_provider_operations, {})

    def test_payer_sync_ambiguous_and_policy_rejected_calls_are_terminally_safe(self):
        for provider_error, expected_state in (
            (RuntimeError("provider timeout with private customer payload"), "reconciliation_required"),
            (
                StripeMutationBlocked(status_code=503, detail="provider mutation blocked"),
                "definitive_rejected",
            ),
        ):
            with self.subTest(expected_state=expected_state):
                _FakeStripeService.reset()
                _FakeStripeService.provider_error = provider_error
                facade = _BillingFacade(
                    {
                        "billing_payers": [{
                            "id": "payer_1",
                            "studio_id": "studio_1",
                            "display_name": "Pat",
                            "metadata": {},
                            "created_at": "2026-01-01T00:00:00Z",
                            "updated_at": "2026-01-01T00:00:00Z",
                        }],
                    },
                    account={
                        "charges_enabled": True,
                        "status": "charges_enabled",
                        "stripe_connected_account_id": "acct_1",
                        "metadata": {"connect_account_generation": 1},
                    },
                )
                manager = BillingPayerManager(
                    facade,
                    stripe_service_cls=_FakeStripeService,
                )

                with self.assertRaises(HTTPException):
                    asyncio.run(manager.sync_payer(
                        "payer_1", "studio_1", "actor_1", "payer-sync-key",
                    ))
                with self.assertRaises(HTTPException):
                    asyncio.run(manager.sync_payer(
                        "payer_1", "studio_1", "actor_1", "payer-sync-key",
                    ))

                self.assertEqual(len(_FakeStripeService.created_customers), 1)
                operation = next(iter(facade.supabase.billing_provider_operations.values()))
                self.assertEqual(operation["state"], expected_state)
                self.assertNotIn("private customer payload", repr(operation))

    def test_payer_sync_same_key_fails_closed_after_account_generation_changes(self):
        _FakeStripeService.reset()
        account = {
            "charges_enabled": True,
            "status": "charges_enabled",
            "stripe_connected_account_id": "acct_1",
            "metadata": {"connect_account_generation": 1},
        }
        facade = _BillingFacade(
            {
                "billing_payers": [{
                    "id": "payer_1",
                    "studio_id": "studio_1",
                    "display_name": "Pat",
                    "metadata": {},
                    "created_at": "2026-01-01T00:00:00Z",
                    "updated_at": "2026-01-01T00:00:00Z",
                }],
                "audit_logs": [],
            },
            account=account,
        )
        manager = BillingPayerManager(facade, stripe_service_cls=_FakeStripeService)

        asyncio.run(manager.sync_payer(
            "payer_1", "studio_1", "actor_1", "payer-sync-key",
        ))
        account["metadata"] = {"connect_account_generation": 2}
        with self.assertRaises(HTTPException) as changed:
            asyncio.run(manager.sync_payer(
                "payer_1", "studio_1", "actor_1", "payer-sync-key",
            ))

        self.assertEqual(changed.exception.status_code, 409)
        self.assertEqual(len(_FakeStripeService.created_customers), 1)
        self.assertEqual(_FakeStripeService.updated_customers, [])

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

    def _payer_recovery(self, outcome, recovered_id=None):
        _FakeStripeService.reset()
        facade = _BillingFacade({
            "billing_payers": [{
                "id": "payer_1", "studio_id": "studio_1",
                "display_name": "Pat", "metadata": {},
                "created_at": "2026-01-01T00:00:00Z",
                "updated_at": "2026-01-01T00:00:00Z",
            }],
            "audit_logs": [],
        }, account={
            "charges_enabled": True, "status": "charges_enabled",
            "stripe_connected_account_id": "acct_1",
            "metadata": {"connect_account_generation": 1},
        })
        manager = BillingPayerManager(facade, stripe_service_cls=_FakeStripeService)
        _FakeStripeService.provider_error = RuntimeError("lost customer response")
        with self.assertRaises(HTTPException):
            asyncio.run(manager.sync_payer(
                "payer_1", "studio_1", "actor_1", "payer-recovery-key"
            ))
        operation = next(iter(facade.supabase.billing_provider_operations.values()))
        context = BillingProviderOperationContext(
            operation["id"], "studio_1", "actor_1", "payer.sync",
            operation["caller_request_key"], operation["request_sha256"],
            "acct_1", 1, str(operation["lease_owner"]),
        )
        BillingProviderOperationCoordinator(facade.supabase).authorize_recovery_v2(
            context,
            operation,
            recovery_actor_id="00000000-0000-4000-8000-000000000202",
            recovery_proof_sha256="b" * 64,
            recovery_outcome=outcome,
            recovered_provider_object_id=recovered_id,
            lease_owner="00000000-0000-4000-8000-000000000102",
        )
        return facade, manager, operation

    def test_payer_safe_retry_reuses_exact_create_payload(self):
        facade, manager, operation = self._payer_recovery(
            "provider_no_object_safe_to_retry"
        )
        first = dict(_FakeStripeService.created_customers[0])
        _FakeStripeService.provider_error = None
        result = asyncio.run(manager.sync_payer(
            "payer_1", "studio_1", "actor_1", "payer-recovery-key"
        ))
        self.assertEqual(result.stripe_customer_id, "cus_created")
        self.assertEqual(_FakeStripeService.created_customers, [first, first])
        self.assertEqual(operation["provider_request_attempt_count"], 2)
        self.assertEqual(operation["state"], "completed")
        asyncio.run(manager.sync_payer(
            "payer_1", "studio_1", "actor_1", "payer-recovery-key"
        ))
        self.assertEqual(len(_FakeStripeService.created_customers), 2)
        self.assertEqual(len(facade.supabase.billing_provider_operations), 1)

    def test_payer_safe_retry_rejects_customer_id_drift_before_stripe(self):
        facade, manager, operation = self._payer_recovery(
            "provider_no_object_safe_to_retry"
        )
        payer = facade.supabase.tables["billing_payers"][0]
        payer["stripe_customer_id"] = "cus_drifted"
        payer["stripe_account_id"] = "acct_1"
        _FakeStripeService.provider_error = None
        with self.assertRaises(HTTPException):
            asyncio.run(manager.sync_payer(
                "payer_1", "studio_1", "actor_1", "payer-recovery-key"
            ))
        self.assertEqual(len(_FakeStripeService.created_customers), 1)
        self.assertEqual(_FakeStripeService.updated_customers, [])
        self.assertEqual(operation["state"], "definitive_rejected")
        self.assertEqual(
            operation["error_code"], "payer_sync_recovery_source_drift"
        )

    def test_payer_reconcile_only_gets_exact_customer_without_mutation(self):
        facade, manager, operation = self._payer_recovery(
            "provider_succeeded_reconcile_only", "cus_recovered"
        )
        _FakeStripeService.provider_error = None
        _FakeStripeService.customer_response = {
            "id": "cus_recovered", "name": "Pat", "email": "", "phone": "",
            "address": {},
            "metadata": {
                "studio_id": "studio_1", "payer_id": "payer_1",
                "product": "koaryu_payments",
            },
            "invoice_settings": {"default_payment_method": None},
        }
        result = asyncio.run(manager.sync_payer(
            "payer_1", "studio_1", "actor_1", "payer-recovery-key"
        ))
        self.assertEqual(result.stripe_customer_id, "cus_recovered")
        self.assertEqual(len(_FakeStripeService.created_customers), 1)
        self.assertEqual(_FakeStripeService.retrieved_customers, [{
            "account_id": "acct_1", "customer_id": "cus_recovered",
            "expand": ["invoice_settings.default_payment_method"],
        }])
        self.assertEqual(operation["provider_request_attempt_count"], 1)
        self.assertEqual(operation["state"], "completed")

    def test_payer_reconcile_only_wrong_metadata_never_projects(self):
        facade, manager, operation = self._payer_recovery(
            "provider_succeeded_reconcile_only", "cus_recovered"
        )
        _FakeStripeService.customer_response = {
            "id": "cus_recovered", "name": "Pat", "email": "", "phone": "",
            "address": {}, "metadata": {"studio_id": "wrong"},
            "invoice_settings": {"default_payment_method": None},
        }
        with self.assertRaises(HTTPException):
            asyncio.run(manager.sync_payer(
                "payer_1", "studio_1", "actor_1", "payer-recovery-key"
            ))
        self.assertEqual(operation["state"], "reconciliation_required")
        self.assertIsNone(
            facade.supabase.tables["billing_payers"][0].get("stripe_customer_id")
        )
        self.assertEqual(len(_FakeStripeService.created_customers), 1)
        self.assertEqual(facade.supabase.tables["audit_logs"], [])

    def test_payer_reconcile_only_rejects_stale_address_when_saved_address_is_empty(self):
        metadata = {
            "studio_id": "studio_1",
            "payer_id": "payer_1",
            "product": "koaryu_payments",
        }
        empty_address = {
            "line1": None,
            "city": None,
            "state": None,
            "postal_code": None,
        }
        for sync_mode, local_customer_id, recovered_customer_id in (
            ("create", None, "cus_recovered"),
            ("update", "cus_existing", "cus_existing"),
        ):
            with self.subTest(sync_mode=sync_mode):
                payer = {
                    "id": "payer_1",
                    "studio_id": "studio_1",
                    "display_name": "Pat",
                    "email": None,
                    "phone": None,
                    "stripe_customer_id": local_customer_id,
                }
                customer = {
                    "id": recovered_customer_id,
                    "name": "Pat",
                    "email": "",
                    "phone": "",
                    "address": {
                        "line1": "STALE",
                        "city": "STALE",
                        "state": "ST",
                        "postal_code": "99999",
                    },
                    "metadata": metadata,
                }
                with self.assertRaisesRegex(
                    RuntimeError,
                    "payer_sync_recovered_customer_mismatch",
                ):
                    BillingPayerManager._verify_recovered_customer(
                        customer,
                        payer=payer,
                        customer_id=recovered_customer_id,
                        sync_mode=sync_mode,
                        metadata=metadata,
                        address=empty_address,
                    )
