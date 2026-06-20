import unittest
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

from app.services.billing_connect_accounts import BillingConnectAccountStore
from tests.fakes.supabase import TableBackedSupabase


def fake_supabase(rows: list[dict]) -> TableBackedSupabase:
    supabase = TableBackedSupabase({"studio_payment_accounts": rows})
    supabase.insert_defaults["studio_payment_accounts"] = {"status": "not_connected"}
    return supabase


class BillingConnectAccountStoreTests(unittest.TestCase):
    def _store(self, rows: list[dict]) -> BillingConnectAccountStore:
        return BillingConnectAccountStore(
            fake_supabase(rows),
            settings=SimpleNamespace(BILLING_PLATFORM_FEE_BPS=225),
        )

    def test_ensure_row_returns_existing_or_initializes_missing_account(self):
        rows = [{"studio_id": "studio_1", "status": "charges_enabled"}]
        store = self._store(rows)

        self.assertEqual(store.ensure_row("studio_1")["status"], "charges_enabled")

        inserted = store.ensure_row("studio_2")

        self.assertEqual(inserted["studio_id"], "studio_2")
        self.assertEqual(inserted["status"], "not_connected")
        self.assertEqual(len(rows), 2)

    def test_update_by_stripe_account_and_lookup_share_the_same_scope(self):
        rows = [{
            "studio_id": "studio_1",
            "stripe_connected_account_id": "acct_1",
            "charges_enabled": False,
        }]
        store = self._store(rows)

        store.update_by_stripe_account("acct_1", {"charges_enabled": True})

        self.assertTrue(store.by_stripe_account("acct_1")["charges_enabled"])

    def test_update_from_stripe_maps_requirements_to_connect_status(self):
        store = self._store([])

        update = store.update_from_stripe({
            "charges_enabled": False,
            "payouts_enabled": False,
            "details_submitted": True,
            "requirements": {"currently_due": ["external_account"]},
        })

        self.assertEqual(update["status"], "action_required")
        self.assertEqual(update["requirements_due"], ["external_account"])
        self.assertTrue(update["details_submitted"])

    def test_should_refresh_when_status_is_incomplete_or_stale(self):
        store = self._store([])
        fresh_time = (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat()
        stale_time = (datetime.now(timezone.utc) - timedelta(minutes=30)).isoformat()

        self.assertFalse(store.should_refresh({"stripe_connected_account_id": None}))
        self.assertTrue(store.should_refresh({"stripe_connected_account_id": "acct_1", "charges_enabled": False}))
        self.assertTrue(store.should_refresh({
            "stripe_connected_account_id": "acct_1",
            "charges_enabled": True,
            "requirements_due": ["external_account"],
        }))
        self.assertFalse(store.should_refresh({
            "stripe_connected_account_id": "acct_1",
            "charges_enabled": True,
            "requirements_due": [],
            "updated_at": fresh_time,
        }))
        self.assertTrue(store.should_refresh({
            "stripe_connected_account_id": "acct_1",
            "charges_enabled": True,
            "requirements_due": [],
            "updated_at": stale_time,
        }))

    def test_refresh_status_uses_injected_stripe_service_and_updates_row(self):
        rows = [{
            "studio_id": "studio_1",
            "stripe_connected_account_id": "acct_1",
            "charges_enabled": False,
        }]
        test_case = self

        class FakeStripeService:
            def retrieve_account(self, *, account_id):
                test_case.assertEqual(account_id, "acct_1")
                return {
                    "id": account_id,
                    "charges_enabled": True,
                    "payouts_enabled": True,
                    "details_submitted": True,
                    "requirements": {"currently_due": []},
                }

        store = BillingConnectAccountStore(
            fake_supabase(rows),
            settings=SimpleNamespace(BILLING_PLATFORM_FEE_BPS=225),
            stripe_service_cls=FakeStripeService,
        )

        refreshed = store.refresh_status(rows[0], strict=True)

        self.assertEqual(refreshed["status"], "charges_enabled")
        self.assertTrue(refreshed["charges_enabled"])
        self.assertTrue(rows[0]["payouts_enabled"])

    def test_response_applies_defaults_and_text_timestamps(self):
        response = self._store([]).response({
            "studio_id": "studio_1",
            "status": None,
            "charges_enabled": 1,
            "payouts_enabled": 0,
            "details_submitted": True,
            "requirements_due": None,
            "created_at": datetime(2026, 1, 1, tzinfo=timezone.utc),
            "updated_at": "2026-01-02T00:00:00Z",
        })

        self.assertEqual(response.status, "not_connected")
        self.assertTrue(response.charges_enabled)
        self.assertFalse(response.payouts_enabled)
        self.assertEqual(response.requirements_due, [])
        self.assertEqual(response.platform_fee_bps, 225)
        self.assertEqual(response.created_at, "2026-01-01T00:00:00+00:00")


if __name__ == "__main__":
    unittest.main()
