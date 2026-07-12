from __future__ import annotations

import asyncio
import unittest
from datetime import datetime, timedelta, timezone

from app.schemas.billing import StudioPaymentAccountResponse
from app.services.billing_system_status import BillingSystemStatusReporter
from tests.fakes.supabase import TableBackedSupabase

TEST_STRIPE_LIVE_KEY = "_".join(("sk", "live", "configured"))


class _ConnectAccounts:
    def ensure_row(self, studio_id: str) -> dict:
        return {"studio_id": studio_id}

    def response(self, row: dict) -> StudioPaymentAccountResponse:
        return StudioPaymentAccountResponse(**row)


class _FailingConnectAccounts(_ConnectAccounts):
    def ensure_row(self, studio_id: str) -> dict:
        raise RuntimeError("stored-connect-secret-detail")


def _settings(
    secret_key: str = TEST_STRIPE_LIVE_KEY,
    *,
    stripe_mode: str = "live",
    live_billing_enabled: bool = False,
):
    return type("Settings", (), {
        "STRIPE_MODE": stripe_mode,
        "LIVE_BILLING_ENABLED": live_billing_enabled,
        "STRIPE_SECRET_KEY": secret_key,
        "STRIPE_KOARYU_CORE_PRICE_ID": "price_core",
        "STRIPE_PLATFORM_WEBHOOK_SECRET": "whsec_platform",
        "STRIPE_CONNECT_WEBHOOK_SECRET": "whsec_connect",
    })()


def _ready_account() -> StudioPaymentAccountResponse:
    return StudioPaymentAccountResponse(
        studio_id="studio_1",
        stripe_connected_account_id="acct_1",
        status="charges_enabled",
        charges_enabled=True,
        payouts_enabled=True,
        details_submitted=True,
        requirements_due=[],
    )


def _processed_event(*, account_id: str | None, observed_at: datetime, livemode: bool = True) -> dict:
    return {
        "stripe_account_id": account_id,
        "type": "invoice.paid" if account_id else "customer.subscription.updated",
        "livemode": livemode,
        "processing_status": "processed",
        "processing_started_at": observed_at.isoformat(),
        "processed_at": observed_at.isoformat(),
        "created_at": observed_at.isoformat(),
    }


class BillingSystemStatusReporterTest(unittest.TestCase):
    def reporter(self, tables: dict, *, secret_key: str = TEST_STRIPE_LIVE_KEY) -> BillingSystemStatusReporter:
        async def load_account(_studio_id: str) -> StudioPaymentAccountResponse:
            return _ready_account()

        return BillingSystemStatusReporter(
            TableBackedSupabase(tables),
            settings=_settings(secret_key),
            connect_accounts=_ConnectAccounts(),
            payment_account_loader=load_account,
        )

    def test_stale_processing_age_uses_processing_started_at_not_event_creation(self):
        now = datetime.now(timezone.utc)

        self.assertFalse(BillingSystemStatusReporter.is_stale_webhook_processing({
            "processing_status": "processing",
            "processing_started_at": (now - timedelta(minutes=1)).isoformat(),
            "created_at": (now - timedelta(days=3)).isoformat(),
        }))
        self.assertTrue(BillingSystemStatusReporter.is_stale_webhook_processing({
            "processing_status": "processing",
            "processing_started_at": (now - timedelta(minutes=11)).isoformat(),
            "created_at": now.isoformat(),
        }))

    def test_test_mode_can_be_ready_without_claiming_live_payment_readiness(self):
        now = datetime.now(timezone.utc)

        async def load_account(_studio_id: str) -> StudioPaymentAccountResponse:
            return _ready_account()

        reporter = BillingSystemStatusReporter(
            TableBackedSupabase({
                "studio_payment_accounts": [{"studio_id": "studio_1"}],
                "stripe_events": [
                    _processed_event(account_id=None, observed_at=now, livemode=False),
                    _processed_event(account_id="acct_1", observed_at=now, livemode=False),
                ],
            }),
            settings=_settings(
                "sk_" + "test_configured",
                stripe_mode="test",
                live_billing_enabled=False,
            ),
            connect_accounts=_ConnectAccounts(),
            payment_account_loader=load_account,
        )

        response = asyncio.run(reporter.get_system_status("studio_1"))

        self.assertEqual(response.configured_stripe_mode, "test")
        self.assertTrue(response.ready_for_configured_mode)
        self.assertFalse(response.live_payments_authorized)
        self.assertFalse(response.ready_for_live_payments)
        self.assertTrue(BillingSystemStatusReporter.is_stale_webhook_processing({
            "processing_status": "processing",
            "processing_started_at": None,
            "created_at": (now - timedelta(minutes=11)).isoformat(),
        }))

    def test_readiness_fails_closed_on_pending_backlog(self):
        now = datetime.now(timezone.utc)
        rows = [
            _processed_event(account_id=None, observed_at=now),
            _processed_event(account_id="acct_1", observed_at=now),
            {
                "stripe_account_id": "acct_1",
                "type": "invoice.payment_failed",
                "livemode": True,
                "processing_status": "pending",
                "created_at": now.isoformat(),
            },
        ]

        response = asyncio.run(self.reporter({
            "studio_payment_accounts": [{"studio_id": "studio_1"}],
            "stripe_events": rows,
        }).get_system_status("studio_1"))

        self.assertFalse(response.ready_for_live_payments)
        self.assertEqual(response.connect_webhooks.pending_count, 1)
        processing_check = next(check for check in response.checks if check.name == "Connect webhook processing")
        self.assertEqual(processing_check.status, "fail")

    def test_webhook_health_counts_unresolved_rows_beyond_latest_fifty(self):
        now = datetime.now(timezone.utc)
        older = now - timedelta(days=1)
        rows = [
            _processed_event(
                account_id="acct_1",
                observed_at=now - timedelta(minutes=index),
            )
            for index in range(60)
        ]
        rows.extend([
            {
                "id": "older-pending",
                "stripe_account_id": "acct_1",
                "type": "invoice.payment_failed",
                "livemode": False,
                "processing_status": "pending",
                "processing_started_at": None,
                "processed_at": None,
                "created_at": older.isoformat(),
            },
            {
                "id": "older-stale-processing",
                "stripe_account_id": "acct_1",
                "type": "invoice.updated",
                "livemode": True,
                "processing_status": "processing",
                "processing_started_at": older.isoformat(),
                "processed_at": None,
                "created_at": older.isoformat(),
            },
            {
                "id": "older-null-start-processing",
                "stripe_account_id": "acct_1",
                "type": "invoice.updated",
                "livemode": True,
                "processing_status": "processing",
                "processing_started_at": None,
                "processed_at": None,
                "created_at": older.isoformat(),
            },
        ])
        reporter = self.reporter({"stripe_events": rows})

        health = reporter.webhook_health("acct_1")

        self.assertEqual(health.latest_processed_at, now.isoformat())
        self.assertEqual(health.pending_count, 1)
        self.assertEqual(health.processing_count, 2)
        self.assertEqual(health.stale_processing_count, 2)
        self.assertEqual(health.mode_mismatch_count, 1)

    def test_readiness_fails_closed_on_stale_or_wrong_mode_webhook_observations(self):
        now = datetime.now(timezone.utc)
        old = now - timedelta(days=36)
        rows = [
            _processed_event(account_id=None, observed_at=now),
            _processed_event(account_id="acct_1", observed_at=old, livemode=False),
        ]

        response = asyncio.run(self.reporter({
            "studio_payment_accounts": [{"studio_id": "studio_1"}],
            "stripe_events": rows,
        }).get_system_status("studio_1"))

        self.assertFalse(response.ready_for_live_payments)
        self.assertEqual(response.connect_webhooks.mode_mismatch_count, 1)
        self.assertEqual(
            next(check for check in response.checks if check.name == "Connect webhook mode").status,
            "fail",
        )
        self.assertEqual(
            next(check for check in response.checks if check.name == "Recent Connect webhook").status,
            "fail",
        )

    def test_status_details_do_not_expose_exception_messages(self):
        async def fail_account(_studio_id: str) -> StudioPaymentAccountResponse:
            raise RuntimeError("sk_live_secret-value req_sensitive")

        reporter = BillingSystemStatusReporter(
            TableBackedSupabase({
                "studio_payment_accounts": [{"studio_id": "studio_1"}],
                "stripe_events": [],
            }),
            settings=_settings(),
            connect_accounts=_ConnectAccounts(),
            payment_account_loader=fail_account,
        )

        with self.assertLogs("app.services.billing_system_status", level="ERROR") as captured_logs:
            response = asyncio.run(reporter.get_system_status("studio_1"))
        detail = next(check.detail for check in response.checks if check.name == "Connect account refresh")
        log_record = next(
            record
            for record in captured_logs.records
            if record.getMessage() == "Stripe Connect account refresh failed during billing readiness check"
        )

        self.assertNotIn("sk_live_secret-value", detail)
        self.assertNotIn("req_sensitive", detail)
        self.assertRegex(detail, r"Reference: [0-9a-f]{32}$")
        self.assertIsNone(log_record.exc_info)
        self.assertEqual(log_record.exception_type, "RuntimeError")
        self.assertNotIn("sk_live_secret-value", log_record.getMessage())
        self.assertEqual(detail.rsplit("Reference: ", 1)[1], log_record.error_id)
        self.assertNotIn("studio_id", log_record.__dict__)
        self.assertNotIn("studio_1", repr(log_record.__dict__))

    def test_connect_fallback_failure_is_sanitized_and_correlated(self):
        async def fail_account(_studio_id: str) -> StudioPaymentAccountResponse:
            raise RuntimeError("refresh-secret-detail")

        reporter = BillingSystemStatusReporter(
            TableBackedSupabase({"studio_payment_accounts": [], "stripe_events": []}),
            settings=_settings(),
            connect_accounts=_FailingConnectAccounts(),
            payment_account_loader=fail_account,
        )

        with self.assertLogs("app.services.billing_system_status", level="ERROR") as captured_logs:
            response = asyncio.run(reporter.get_system_status("studio_1"))

        detail = next(check.detail for check in response.checks if check.name == "Connect account fallback")
        fallback_log = next(
            record
            for record in captured_logs.records
            if record.getMessage() == "Stripe Connect account fallback failed during billing readiness check"
        )
        self.assertNotIn("stored-connect-secret-detail", detail)
        self.assertEqual(detail.rsplit("Reference: ", 1)[1], fallback_log.error_id)
        self.assertEqual(fallback_log.exception_type, "RuntimeError")
        self.assertIsNone(fallback_log.exc_info)
        self.assertNotIn("studio_id", fallback_log.__dict__)
        self.assertNotIn("studio_1", repr(fallback_log.__dict__))

    def test_database_failure_detail_is_sanitized(self):
        supabase = TableBackedSupabase({
            "studio_payment_accounts": [{"studio_id": "studio_1"}],
            "stripe_events": [],
        })
        supabase.table_failures["studio_payment_accounts"] = RuntimeError(
            "postgres://secret-user:secret-password@db.example"
        )

        async def load_account(_studio_id: str) -> StudioPaymentAccountResponse:
            return _ready_account()

        reporter = BillingSystemStatusReporter(
            supabase,
            settings=_settings(),
            connect_accounts=_ConnectAccounts(),
            payment_account_loader=load_account,
        )
        with self.assertLogs("app.services.billing_system_status", level="ERROR") as captured_logs:
            response = asyncio.run(reporter.get_system_status("studio_1"))
        detail = next(check.detail for check in response.checks if check.name == "Supabase billing read")
        database_log = next(
            record
            for record in captured_logs.records
            if record.getMessage() == "Supabase billing readiness read failed"
        )

        self.assertNotIn("secret-password", detail)
        self.assertRegex(detail, r"Reference: [0-9a-f]{32}$")
        self.assertEqual(detail.rsplit("Reference: ", 1)[1], database_log.error_id)
        self.assertEqual(database_log.exception_type, "RuntimeError")
        self.assertIsNone(database_log.exc_info)
        self.assertNotIn("studio_id", database_log.__dict__)
        self.assertNotIn("studio_1", repr(database_log.__dict__))

    def test_webhook_query_failure_is_sanitized_and_correlated(self):
        supabase = TableBackedSupabase({
            "studio_payment_accounts": [{"studio_id": "studio_1"}],
            "stripe_events": [],
        })
        supabase.table_failures["stripe_events"] = RuntimeError("webhook-database-secret")

        async def load_account(_studio_id: str) -> StudioPaymentAccountResponse:
            return _ready_account()

        reporter = BillingSystemStatusReporter(
            supabase,
            settings=_settings(),
            connect_accounts=_ConnectAccounts(),
            payment_account_loader=load_account,
        )
        with self.assertLogs("app.services.billing_system_status", level="ERROR") as captured_logs:
            response = asyncio.run(reporter.get_system_status("studio_1"))

        platform_check = next(check for check in response.checks if check.name == "Platform webhook query")
        self.assertEqual(platform_check.status, "fail")
        self.assertNotIn("webhook-database-secret", platform_check.detail)
        platform_reference = platform_check.detail.rsplit("Reference: ", 1)[1]
        self.assertIn(platform_reference, [record.error_id for record in captured_logs.records])
        self.assertTrue(all(record.exception_type == "RuntimeError" for record in captured_logs.records))
        self.assertTrue(all(record.exc_info is None for record in captured_logs.records))
        self.assertTrue(all("stripe_account_id" not in record.__dict__ for record in captured_logs.records))
        self.assertNotIn("studio_1", repr([record.__dict__ for record in captured_logs.records]))


if __name__ == "__main__":
    unittest.main()
