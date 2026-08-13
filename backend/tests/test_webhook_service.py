from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import time
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import stripe
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app.core.deps import get_supabase
from app.main import app
from app.services.stripe_service import StripeService
from app.services.stripe_mutation_policy import (
    LIVE_MUTATIONS_DISABLED_DETAIL,
    StripeMutationBlocked,
)
from app.services.webhook_service import StripeWebhookService
from tests.fakes.supabase import RpcBackedSupabase


class _FakeSupabase(RpcBackedSupabase):
    def __init__(
        self,
        rows,
        *,
        mapped_account_ids=("acct_1",),
        excluded_account_ids=(),
    ):
        super().__init__({
            "stripe_events": rows,
            "studio_payment_accounts": [
                {
                    "studio_id": f"studio_{index}",
                    "stripe_connected_account_id": account_id,
                }
                for index, account_id in enumerate(mapped_account_ids, start=1)
            ],
            "stripe_connect_account_dispositions": [
                {
                    "stripe_connected_account_id": account_id,
                    "excluded": True,
                }
                for account_id in excluded_account_ids
            ],
        })

    def _rpc_claim_stripe_event_for_processing(self, params: dict) -> list[dict]:
        rows = self.tables["stripe_events"]
        event_id = params["p_stripe_event_id"]
        account_id = params.get("p_stripe_account_id")
        row = next(
            (
                candidate
                for candidate in rows
                if candidate.get("stripe_event_id") == event_id
                and candidate.get("stripe_account_id") == account_id
            ),
            None,
        )
        if row is None:
            row = {
                "id": "row_1",
                "stripe_event_id": event_id,
                "stripe_account_id": account_id,
                "processing_status": "processing",
                "processing_token": params["p_processing_token"],
                "processing_started_at": datetime.now(timezone.utc).isoformat(),
            }
            rows.append(row)
            return [{"claim_status": "claimed", "event_row": dict(row)}]
        if row.get("processing_status") == "processed":
            return [{"claim_status": "already_processed", "event_row": dict(row)}]
        if row.get("processing_status") == "processing" and not self._is_stale(row):
            return [{"claim_status": "already_processing", "event_row": dict(row)}]
        if row.get("processing_status") not in {"pending", "processing", "failed"}:
            return [{"claim_status": "already_processing", "event_row": dict(row)}]
        row.update({
            "processing_status": "processing",
            "processing_token": params["p_processing_token"],
            "processing_started_at": datetime.now(timezone.utc).isoformat(),
            "error": None,
        })
        return [{"claim_status": "claimed", "event_row": dict(row)}]

    def _rpc_finish_stripe_event_processing_v2(self, params: dict) -> list[dict]:
        for row in self.tables["stripe_events"]:
            if row.get("id") == params["p_event_id"] and row.get("processing_token") == params["p_processing_token"]:
                row["processing_status"] = params["p_status"]
                row["processing_token"] = None
                row["processing_started_at"] = None
                row["processed_at"] = (
                    datetime.now(timezone.utc).isoformat()
                    if params["p_status"] == "processed"
                    else row.get("processed_at")
                )
                row["error"] = params["p_error"] if params["p_status"] == "failed" else None
                row["error_reference"] = (
                    params["p_error_reference"] if params["p_status"] == "failed" else None
                )
                return [{"updated": True, "event_row": dict(row)}]
        return [{"updated": False, "event_row": None}]

    @staticmethod
    def _is_stale(row: dict) -> bool:
        raw_started = row.get("processing_started_at") or row.get("created_at")
        started = datetime.fromisoformat(str(raw_started).replace("Z", "+00:00"))
        if started.tzinfo is None:
            started = started.replace(tzinfo=timezone.utc)
        return datetime.now(timezone.utc) - started >= timedelta(minutes=10)


class _RpcWebhookSupabase(RpcBackedSupabase):
    def __init__(self):
        super().__init__({
            "studio_payment_accounts": [{
                "studio_id": "studio_1",
                "stripe_connected_account_id": "acct_1",
            }],
        })

    def _rpc_claim_stripe_event_for_processing(self, _params: dict) -> list[dict]:
        return [{
                "claim_status": "claimed",
                "event_row": {"id": "row_1"},
        }]

    def _rpc_finish_stripe_event_processing_v2(self, params: dict) -> list[dict]:
        return [{
            "updated": True,
            "event_row": {"id": params["p_event_id"], "processing_status": params["p_status"]},
        }]


class _FakeBillingService:
    calls = 0
    mutate_during_projection = None
    raise_during_projection = None

    def __init__(self, supabase):
        self.supabase = supabase

    def project_connect_event(self, _event):
        self.__class__.calls += 1
        if self.__class__.raise_during_projection:
            raise self.__class__.raise_during_projection
        if self.__class__.mutate_during_projection:
            self.__class__.mutate_during_projection(self.supabase.tables["stripe_events"])


class _FakePlatformBillingService:
    hydrate_calls = []
    raise_during_projection = None

    def __init__(self, supabase):
        self.supabase = supabase

    def project_subscription_event(self, event, *, hydrate_subscription: bool = True):
        self.__class__.hydrate_calls.append((event["id"], hydrate_subscription))
        if self.__class__.raise_during_projection:
            raise self.__class__.raise_during_projection


class _FakeWebhook:
    @staticmethod
    def construct_event(payload, signature, secret):
        if secret != "whsec_second":
            raise ValueError("wrong secret")
        return {"id": "evt_1", "payload": payload.decode(), "signature": signature}


class _FakeStripeModule:
    Webhook = _FakeWebhook


class _FakeSettings:
    STRIPE_MODE = "live"
    LIVE_BILLING_ENABLED = False
    STRIPE_SECRET_KEY = "sk_live_fixture"
    STRIPE_CONNECT_WEBHOOK_SECRET = "whsec_connect"
    STRIPE_PLATFORM_WEBHOOK_SECRET = "whsec_platform"


class WebhookServiceTest(unittest.TestCase):
    def service(
        self,
        rows,
        *,
        mapped_account_ids=("acct_1",),
        excluded_account_ids=(),
    ):
        with patch("app.services.webhook_service.get_settings", return_value=_FakeSettings()):
            return StripeWebhookService(
                _FakeSupabase(
                    rows,
                    mapped_account_ids=mapped_account_ids,
                    excluded_account_ids=excluded_account_ids,
                )
            )

    def handle_connect_event(self, rows):
        test_case = self

        class FakeStripeService:
            def construct_webhook_event(self, *, payload, signature, secret):
                test_case.assertEqual(secret, "whsec_connect")
                test_case.assertEqual(payload, b'{"id":"evt_1"}')
                test_case.assertEqual(signature, "sig")
                return {
                    "id": "evt_1",
                    "account": "acct_1",
                    "type": "account.updated",
                    "livemode": True,
                    "data": {"object": {"id": "acct_1"}},
                }

        with patch("app.services.webhook_service.StripeService", FakeStripeService):
            with patch("app.services.webhook_service.BillingService", _FakeBillingService):
                return asyncio.run(
                    self.service(rows).handle_connect_webhook(
                        b'{"id":"evt_1"}',
                        "sig",
                    )
                )

    def test_handle_connect_webhook_reclaims_stale_duplicate_through_public_handler(self):
        rows = [{
            "id": "row_1",
            "stripe_event_id": "evt_1",
            "stripe_account_id": "acct_1",
            "processing_status": "failed",
            "processing_token": "old-token",
            "created_at": (datetime.now(timezone.utc) - timedelta(minutes=11)).isoformat(),
            "error": "worker exited",
        }]
        _FakeBillingService.calls = 0

        result = self.handle_connect_event(rows)

        self.assertEqual(result.status, "processed")
        self.assertEqual(_FakeBillingService.calls, 1)
        self.assertEqual(rows[0]["processing_status"], "processed")
        self.assertIsNone(rows[0]["processing_token"])

    def test_wrong_mode_event_is_rejected_before_claim_or_storage(self):
        rows = []
        service = self.service(rows)

        with self.assertRaises(HTTPException) as raised:
            service._store_and_process(
                {
                    "id": "evt_test_mode",
                    "account": "acct_1",
                    "type": "account.updated",
                    "livemode": False,
                    "data": {"object": {"id": "acct_1"}},
                },
                stripe_account_id="acct_1",
                processor="connect",
            )

        self.assertEqual(raised.exception.status_code, 400)
        self.assertIn("STRIPE_MODE", raised.exception.detail)
        self.assertEqual(rows, [])
        self.assertEqual(service.supabase.rpc_calls, [])

    def test_missing_livemode_is_rejected_in_test_mode_before_claim_or_storage(self):
        rows = []
        service = self.service(rows)
        service.settings.STRIPE_MODE = "test"

        with self.assertRaises(HTTPException) as raised:
            service._store_and_process(
                {
                    "id": "evt_missing_mode",
                    "account": "acct_1",
                    "type": "account.updated",
                    "data": {"object": {"id": "acct_1"}},
                },
                stripe_account_id="acct_1",
                processor="connect",
            )

        self.assertEqual(raised.exception.status_code, 400)
        self.assertIn("boolean", raised.exception.detail)
        self.assertEqual(rows, [])
        self.assertEqual(service.supabase.rpc_calls, [])

    def test_string_livemode_is_rejected_before_claim_or_storage(self):
        rows = []
        service = self.service(rows)

        with self.assertRaises(HTTPException) as raised:
            service._store_and_process(
                {
                    "id": "evt_string_mode",
                    "account": "acct_1",
                    "type": "account.updated",
                    "livemode": "false",
                    "data": {"object": {"id": "acct_1"}},
                },
                stripe_account_id="acct_1",
                processor="connect",
            )

        self.assertEqual(raised.exception.status_code, 400)
        self.assertIn("boolean", raised.exception.detail)
        self.assertEqual(rows, [])
        self.assertEqual(service.supabase.rpc_calls, [])

    def test_key_mode_mismatch_is_rejected_before_claim_or_storage(self):
        rows = []
        service = self.service(rows)
        service.settings.STRIPE_SECRET_KEY = "sk_test_fixture"

        with self.assertRaises(HTTPException) as raised:
            service._store_and_process(
                {
                    "id": "evt_mismatched_configuration",
                    "account": "acct_1",
                    "type": "account.updated",
                    "livemode": True,
                    "data": {"object": {"id": "acct_1"}},
                },
                stripe_account_id="acct_1",
                processor="connect",
            )

        self.assertEqual(raised.exception.status_code, 503)
        self.assertIn("matching STRIPE_MODE", raised.exception.detail)
        self.assertEqual(rows, [])
        self.assertEqual(service.supabase.rpc_calls, [])

    def test_unmapped_live_connect_event_retries_and_processes_after_mapping(self):
        rows = []
        service = self.service(rows, mapped_account_ids=())
        _FakeBillingService.calls = 0

        with patch("app.services.webhook_service.BillingService", _FakeBillingService):
            with self.assertRaises(HTTPException) as raised:
                service._store_and_process(
                    {
                        "id": "evt_unmapped_live",
                        "account": "acct_unmapped",
                        "type": "invoice.paid",
                        "livemode": True,
                        "data": {"object": {"id": "in_1"}},
                    },
                    stripe_account_id="acct_unmapped",
                    processor="connect",
                )

        self.assertEqual(raised.exception.status_code, 503)
        self.assertEqual(raised.exception.headers["Retry-After"], "60")
        self.assertEqual(_FakeBillingService.calls, 0)
        self.assertEqual(rows[0]["processing_status"], "failed")
        self.assertEqual(rows[0]["error"], "unmapped_live_connect_account")

        service.supabase.tables["studio_payment_accounts"].append({
            "studio_id": "studio_mapped",
            "stripe_connected_account_id": "acct_unmapped",
        })
        with patch("app.services.webhook_service.BillingService", _FakeBillingService):
            result = service._store_and_process(
                {
                    "id": "evt_unmapped_live",
                    "account": "acct_unmapped",
                    "type": "invoice.paid",
                    "livemode": True,
                    "data": {"object": {"id": "in_1"}},
                },
                stripe_account_id="acct_unmapped",
                processor="connect",
            )

        self.assertEqual(result.status, "processed")
        self.assertEqual(_FakeBillingService.calls, 1)
        self.assertEqual(rows[0]["processing_status"], "processed")
        self.assertIsNone(rows[0]["error"])

    def test_excluded_unmapped_live_connect_event_is_ignored_without_projection(self):
        rows = []
        service = self.service(
            rows,
            mapped_account_ids=(),
            excluded_account_ids=("acct_retired",),
        )
        _FakeBillingService.calls = 0

        with patch("app.services.webhook_service.BillingService", _FakeBillingService):
            result = service._store_and_process(
                {
                    "id": "evt_retired_account",
                    "account": "acct_retired",
                    "type": "account.application.deauthorized",
                    "livemode": True,
                    "data": {"object": {"id": "acct_retired"}},
                },
                stripe_account_id="acct_retired",
                processor="connect",
            )

        self.assertEqual(result.status, "ignored")
        self.assertEqual(_FakeBillingService.calls, 0)
        self.assertEqual(rows[0]["processing_status"], "ignored")
        self.assertIsNone(rows[0]["error"])

        with patch("app.services.webhook_service.BillingService", _FakeBillingService):
            duplicate = service._store_and_process(
                {
                    "id": "evt_retired_account",
                    "account": "acct_retired",
                    "type": "account.application.deauthorized",
                    "livemode": True,
                    "data": {"object": {"id": "acct_retired"}},
                },
                stripe_account_id="acct_retired",
                processor="connect",
            )

        self.assertEqual(duplicate.status, "ignored")
        self.assertEqual(_FakeBillingService.calls, 0)
        self.assertEqual(rows[0]["processing_status"], "ignored")

        service.supabase.tables["stripe_connect_account_dispositions"].clear()
        with self.assertRaises(HTTPException) as raised:
            service._store_and_process(
                {
                    "id": "evt_retired_account",
                    "account": "acct_retired",
                    "type": "account.application.deauthorized",
                    "livemode": True,
                    "data": {"object": {"id": "acct_retired"}},
                },
                stripe_account_id="acct_retired",
                processor="connect",
            )

        self.assertEqual(raised.exception.status_code, 503)
        self.assertEqual(rows[0]["processing_status"], "ignored")

    def test_mapped_live_connect_event_projects_even_with_stale_exclusion_fixture(self):
        rows = []
        service = self.service(
            rows,
            mapped_account_ids=("acct_1",),
            excluded_account_ids=("acct_1",),
        )
        _FakeBillingService.calls = 0

        with patch("app.services.webhook_service.BillingService", _FakeBillingService):
            result = service._store_and_process(
                {
                    "id": "evt_mapped_account",
                    "account": "acct_1",
                    "type": "account.updated",
                    "livemode": True,
                    "data": {"object": {"id": "acct_1"}},
                },
                stripe_account_id="acct_1",
                processor="connect",
            )

        self.assertEqual(result.status, "processed")
        self.assertEqual(_FakeBillingService.calls, 1)
        self.assertEqual(rows[0]["processing_status"], "processed")

    def test_accountless_platform_event_on_connect_route_is_quarantined_as_wrong_route(self):
        rows = []
        _FakeBillingService.calls = 0

        class FakeStripeService:
            def construct_webhook_event(self, *, payload, signature, secret):
                return {
                    "id": "evt_platform_on_connect",
                    "type": "customer.subscription.updated",
                    "livemode": True,
                    "data": {"object": {"id": "sub_1"}},
                }

        with patch("app.services.webhook_service.get_settings", return_value=_FakeSettings()):
            with patch("app.services.webhook_service.StripeService", FakeStripeService):
                with patch("app.services.webhook_service.BillingService", _FakeBillingService):
                    with self.assertRaises(HTTPException) as raised:
                        asyncio.run(
                            StripeWebhookService(_FakeSupabase(rows)).handle_connect_webhook(
                                b'{"id":"evt_platform_on_connect"}',
                                "sig",
                            )
                        )

        self.assertEqual(raised.exception.status_code, 400)
        self.assertEqual(_FakeBillingService.calls, 0)
        self.assertEqual(rows[0]["stripe_account_id"], None)
        self.assertEqual(rows[0]["processing_status"], "failed")
        self.assertEqual(rows[0]["error"], "wrong_route_platform_event")

    def test_accountless_connect_only_event_is_quarantined_as_missing_context(self):
        rows = []
        _FakeBillingService.calls = 0

        class FakeStripeService:
            def construct_webhook_event(self, *, payload, signature, secret):
                return {
                    "id": "evt_missing_connect_context",
                    "type": "invoice.created",
                    "livemode": True,
                    "data": {"object": {"id": "in_1"}},
                }

        with patch("app.services.webhook_service.get_settings", return_value=_FakeSettings()):
            with patch("app.services.webhook_service.StripeService", FakeStripeService):
                with patch("app.services.webhook_service.BillingService", _FakeBillingService):
                    with self.assertRaises(HTTPException) as raised:
                        asyncio.run(
                            StripeWebhookService(_FakeSupabase(rows)).handle_connect_webhook(
                                b'{"id":"evt_missing_connect_context"}',
                                "sig",
                            )
                        )

        self.assertEqual(raised.exception.status_code, 400)
        self.assertEqual(_FakeBillingService.calls, 0)
        self.assertEqual(rows[0]["processing_status"], "failed")
        self.assertEqual(rows[0]["error"], "missing_connect_account_context")

    def test_account_object_id_cannot_replace_top_level_connect_context(self):
        rows = []
        _FakeBillingService.calls = 0

        class FakeStripeService:
            def construct_webhook_event(self, *, payload, signature, secret):
                return {
                    "id": "evt_account_without_context",
                    "type": "account.updated",
                    "livemode": True,
                    "data": {"object": {"id": "acct_1"}},
                }

        with patch("app.services.webhook_service.get_settings", return_value=_FakeSettings()):
            with patch("app.services.webhook_service.StripeService", FakeStripeService):
                with patch("app.services.webhook_service.BillingService", _FakeBillingService):
                    with self.assertRaises(HTTPException) as raised:
                        asyncio.run(
                            StripeWebhookService(_FakeSupabase(rows)).handle_connect_webhook(
                                b'{"id":"evt_account_without_context"}',
                                "sig",
                            )
                        )

        self.assertEqual(raised.exception.status_code, 400)
        self.assertEqual(_FakeBillingService.calls, 0)
        self.assertEqual(rows[0]["stripe_account_id"], None)
        self.assertEqual(rows[0]["error"], "missing_connect_account_context")

    def test_connected_account_event_on_platform_route_is_quarantined_as_wrong_route(self):
        rows = []
        _FakePlatformBillingService.hydrate_calls = []

        class FakeStripeService:
            def construct_webhook_event(self, *, payload, signature, secret):
                return {
                    "id": "evt_connect_on_platform",
                    "account": "acct_1",
                    "type": "customer.subscription.updated",
                    "livemode": True,
                    "data": {"object": {"id": "sub_1"}},
                }

        with patch("app.services.webhook_service.get_settings", return_value=_FakeSettings()):
            with patch("app.services.webhook_service.StripeService", FakeStripeService):
                with patch("app.services.webhook_service.PlatformBillingService", _FakePlatformBillingService):
                    with self.assertRaises(HTTPException) as raised:
                        asyncio.run(
                            StripeWebhookService(_FakeSupabase(rows)).handle_platform_webhook(
                                b'{"id":"evt_connect_on_platform"}',
                                "sig",
                            )
                        )

        self.assertEqual(raised.exception.status_code, 400)
        self.assertEqual(_FakePlatformBillingService.hydrate_calls, [])
        self.assertEqual(rows[0]["stripe_account_id"], "acct_1")
        self.assertEqual(rows[0]["processing_status"], "failed")
        self.assertEqual(rows[0]["error"], "wrong_route_connect_event")

    def test_matching_live_connect_event_projects_while_live_mutations_are_closed(self):
        rows = []
        _FakeBillingService.calls = 0

        result = self.handle_connect_event(rows)

        self.assertFalse(_FakeSettings.LIVE_BILLING_ENABLED)
        self.assertEqual(result.status, "processed")
        self.assertEqual(_FakeBillingService.calls, 1)

    def test_processed_duplicate_returns_already_processed_without_projection(self):
        rows = [{
            "id": "row_1",
            "stripe_event_id": "evt_1",
            "stripe_account_id": "acct_1",
            "processing_status": "processed",
            "processed_at": datetime.now(timezone.utc).isoformat(),
        }]
        _FakeBillingService.calls = 0

        result = self.handle_connect_event(rows)

        self.assertEqual(result.status, "already_processed")
        self.assertEqual(_FakeBillingService.calls, 0)
        self.assertEqual(rows[0]["processing_status"], "processed")
        self.assertNotIn("processing_token", rows[0])

    def test_fresh_processing_duplicate_raises_retryable_error(self):
        rows = [{
            "id": "row_1",
            "stripe_event_id": "evt_1",
            "stripe_account_id": "acct_1",
            "processing_status": "processing",
            "created_at": datetime.now(timezone.utc).isoformat(),
        }]
        _FakeBillingService.calls = 0

        with self.assertRaises(HTTPException) as context:
            self.handle_connect_event(rows)

        self.assertEqual(context.exception.status_code, 503)
        self.assertEqual(context.exception.headers["Retry-After"], "600")
        self.assertEqual(_FakeBillingService.calls, 0)
        self.assertEqual(rows[0]["processing_status"], "processing")

    def test_stale_processing_duplicate_is_reclaimed(self):
        rows = [{
            "id": "row_1",
            "stripe_event_id": "evt_1",
            "stripe_account_id": "acct_1",
            "processing_status": "processing",
            "processing_token": "old-token",
            "created_at": (datetime.now(timezone.utc) - timedelta(minutes=11)).isoformat(),
            "error": "worker exited",
        }]
        _FakeBillingService.calls = 0

        result = self.handle_connect_event(rows)

        self.assertEqual(result.status, "processed")
        self.assertEqual(_FakeBillingService.calls, 1)
        self.assertEqual(rows[0]["processing_status"], "processed")
        self.assertIsNone(rows[0]["processing_token"])
        self.assertIsNone(rows[0]["processing_started_at"])
        self.assertIsNone(rows[0]["error"])
        self.assertIsNotNone(rows[0]["processed_at"])

    def test_lost_completion_lease_raises_instead_of_reporting_processed(self):
        rows = [{
            "id": "row_1",
            "stripe_event_id": "evt_1",
            "stripe_account_id": "acct_1",
            "processing_status": "failed",
            "processing_token": "old-token",
            "created_at": (datetime.now(timezone.utc) - timedelta(minutes=11)).isoformat(),
            "error": "worker exited",
        }]
        _FakeBillingService.calls = 0
        _FakeBillingService.mutate_during_projection = lambda rows_to_mutate: rows_to_mutate[0].update({
            "processing_token": "other-worker",
        })
        try:
            with self.assertRaises(RuntimeError):
                self.handle_connect_event(rows)
        finally:
            _FakeBillingService.mutate_during_projection = None

        self.assertEqual(_FakeBillingService.calls, 1)
        self.assertEqual(rows[0]["processing_status"], "processing")
        self.assertEqual(rows[0]["processing_token"], "other-worker")

    def test_projection_failure_persists_stable_error_code_without_exception_text(self):
        rows = []
        _FakeBillingService.calls = 0
        _FakeBillingService.raise_during_projection = RuntimeError("raw provider secret detail")
        try:
            with self.assertLogs("app.services.webhook_service", logging.ERROR) as logs:
                with self.assertRaises(RuntimeError):
                    self.handle_connect_event(rows)
        finally:
            _FakeBillingService.raise_during_projection = None

        self.assertEqual(_FakeBillingService.calls, 1)
        self.assertEqual(rows[0]["processing_status"], "failed")
        self.assertEqual(rows[0]["error"], "unexpected_processing_error")
        self.assertRegex(rows[0]["error_reference"], r"^[0-9a-f]{32}$")
        self.assertNotIn("raw provider secret detail", rows[0]["error"])
        self.assertIn("event_id=evt_1", logs.output[0])
        self.assertIn(f"reference={rows[0]['error_reference']}", logs.output[0])
        self.assertIn("exception_type=RuntimeError", logs.output[0])
        self.assertNotIn("raw provider secret detail", logs.output[0])

    def test_live_mutation_interlock_keeps_webhook_failed_and_retryable(self):
        rows = []
        service = self.service(rows)

        class InterlockedBillingService:
            def __init__(self, _supabase):
                pass

            def project_connect_event(self, _event):
                raise StripeMutationBlocked(
                    status_code=503,
                    detail=LIVE_MUTATIONS_DISABLED_DETAIL,
                )

        with patch("app.services.webhook_service.BillingService", InterlockedBillingService):
            with self.assertRaises(StripeMutationBlocked) as raised:
                service._store_and_process(
                    {
                        "id": "evt_live_interlocked",
                        "account": "acct_1",
                        "type": "checkout.session.completed",
                        "livemode": True,
                        "data": {"object": {"id": "cs_1"}},
                    },
                    stripe_account_id="acct_1",
                    processor="connect",
                )

        self.assertEqual(raised.exception.status_code, 503)
        self.assertEqual(rows[0]["processing_status"], "failed")
        self.assertEqual(rows[0]["error"], "live_mutation_blocked")
        self.assertIsNone(rows[0]["processing_token"])

    def test_connect_webhook_uses_worker_claim_rpc_when_available(self):
        supabase = _RpcWebhookSupabase()
        _FakeBillingService.calls = 0

        class FakeStripeService:
            def construct_webhook_event(self, *, payload, signature, secret):
                return {
                    "id": "evt_1",
                    "account": "acct_1",
                    "type": "account.updated",
                    "livemode": True,
                    "data": {"object": {"id": "acct_1"}},
                }

        with patch("app.services.webhook_service.get_settings", return_value=_FakeSettings()):
            with patch("app.services.webhook_service.StripeService", FakeStripeService):
                with patch("app.services.webhook_service.BillingService", _FakeBillingService):
                    result = asyncio.run(
                        StripeWebhookService(supabase).handle_connect_webhook(
                            b'{"id":"evt_1"}',
                            "sig",
                        )
                    )

        self.assertEqual(result.status, "processed")
        self.assertEqual(_FakeBillingService.calls, 1)
        self.assertEqual(
            [name for name, _params in supabase.rpc_calls],
            ["claim_stripe_event_for_processing", "finish_stripe_event_processing_v2"],
        )
        self.assertEqual(supabase.rpc_calls[0][1]["p_stripe_account_id"], "acct_1")

    def test_platform_webhook_hydrates_checkout_subscription_state(self):
        supabase = _RpcWebhookSupabase()
        _FakePlatformBillingService.hydrate_calls = []

        class FakeStripeService:
            def construct_webhook_event(self, *, payload, signature, secret):
                return {
                    "id": "evt_checkout",
                    "type": "checkout.session.completed",
                    "livemode": True,
                    "payload": payload.decode(),
                    "data": {"object": {"metadata": {"studio_id": "studio_1"}}},
                }

        with patch("app.services.webhook_service.get_settings", return_value=_FakeSettings()):
            with patch("app.services.webhook_service.StripeService", FakeStripeService):
                with patch("app.services.webhook_service.PlatformBillingService", _FakePlatformBillingService):
                    result = asyncio.run(
                        StripeWebhookService(supabase).handle_platform_webhook(
                            b'{"id":"evt_checkout"}',
                            "sig",
                        )
                    )

        self.assertEqual(result.status, "processed")
        self.assertEqual(_FakePlatformBillingService.hydrate_calls, [("evt_checkout", True)])
        self.assertEqual(supabase.rpc_calls[0][1]["p_stripe_account_id"], None)

    def test_construct_webhook_event_accepts_rotated_secret_list(self):
        service = StripeService()
        with patch.object(service, "_stripe", return_value=_FakeStripeModule):
            event = service.construct_webhook_event(
                payload=b"{}",
                signature="sig",
                secret="whsec_first,whsec_second",
            )

        self.assertEqual(event["id"], "evt_1")

    def test_construct_webhook_event_rejects_noncanonical_secrets_before_sdk(self):
        invalid_values = (
            " whsec_first",
            "whsec_first ",
            ",whsec_first",
            "whsec_first,",
            "whsec_first, whsec_second",
            "whsec_first\tvalue",
            "whsec_first\rvalue",
            "whsec_first\nwhsec_second",
            "whsec_first,,whsec_second",
        )
        service = StripeService()

        for secret in invalid_values:
            with self.subTest(value_kind=repr(secret)):
                with patch.object(service, "_stripe") as stripe_module:
                    with self.assertRaisesRegex(RuntimeError, "webhook secret") as error:
                        service.construct_webhook_event(
                            payload=b"{}",
                            signature="sig",
                            secret=secret,
                        )

                self.assertNotIn(secret, str(error.exception))
                stripe_module.assert_not_called()

    def test_construct_webhook_event_accepts_real_stripe_sdk_signature(self):
        payload = b'{"id":"evt_real_sdk","object":"event"}'
        secret = "whsec_real_sdk_test"
        timestamp = int(time.time())
        signed_payload = f"{timestamp}.{payload.decode('utf-8')}".encode()
        signature = hmac.new(secret.encode(), signed_payload, hashlib.sha256).hexdigest()
        header = f"t={timestamp},v1={signature}"
        service = StripeService()

        with patch.object(service, "_stripe", return_value=stripe):
            event = service.construct_webhook_event(
                payload=payload,
                signature=header,
                secret=secret,
            )

        self.assertEqual(event["id"], "evt_real_sdk")
        with patch.object(service, "_stripe", return_value=stripe):
            with self.assertRaises(HTTPException) as raised:
                service.construct_webhook_event(
                    payload=b'{"id":"evt_mutated","object":"event"}',
                    signature=header,
                    secret=secret,
                )
        self.assertEqual(raised.exception.status_code, 400)

    def test_construct_webhook_event_rejects_missing_signature_before_stripe_sdk(self):
        service = StripeService()
        with patch.object(service, "_stripe") as stripe_module:
            with self.assertRaises(HTTPException) as raised:
                service.construct_webhook_event(
                    payload=b"{}",
                    signature=None,
                    secret="whsec_first",
                )

        self.assertEqual(raised.exception.status_code, 400)
        self.assertEqual(raised.exception.detail, "Missing Stripe signature.")
        stripe_module.assert_not_called()

    def test_construct_webhook_event_rejects_when_no_secret_matches(self):
        service = StripeService()
        with patch.object(service, "_stripe", return_value=_FakeStripeModule):
            with self.assertRaises(HTTPException) as raised:
                service.construct_webhook_event(
                    payload=b"{}",
                    signature="sig",
                    secret="whsec_first,whsec_third",
                )

        self.assertEqual(raised.exception.status_code, 400)


class WebhookRouteIntegrationTest(unittest.TestCase):
    def setUp(self):
        self.rows = []
        self.supabase = _FakeSupabase(self.rows)
        self.client = TestClient(app, raise_server_exceptions=False)
        app.dependency_overrides[get_supabase] = lambda: self.supabase
        stripe_settings_patcher = patch(
            "app.services.stripe_service.get_settings",
            return_value=_FakeSettings(),
        )
        stripe_settings_patcher.start()
        self.addCleanup(stripe_settings_patcher.stop)
        _FakeBillingService.calls = 0
        _FakeBillingService.raise_during_projection = None
        _FakePlatformBillingService.hydrate_calls = []
        _FakePlatformBillingService.raise_during_projection = None

    def tearDown(self):
        app.dependency_overrides.clear()
        _FakeBillingService.raise_during_projection = None
        _FakePlatformBillingService.raise_during_projection = None

    @staticmethod
    def _signed_event(event: dict, secret: str) -> tuple[bytes, str]:
        payload = json.dumps(event, separators=(",", ":")).encode()
        timestamp = int(time.time())
        signed_payload = f"{timestamp}.{payload.decode()}".encode()
        signature = hmac.new(secret.encode(), signed_payload, hashlib.sha256).hexdigest()
        return payload, f"t={timestamp},v1={signature}"

    def _post_event(self, route: str, event: dict, secret: str):
        payload, signature = self._signed_event(event, secret)
        return self.client.post(
            f"/api/v1/webhooks/stripe/{route}",
            content=payload,
            headers={"Stripe-Signature": signature},
        )

    def test_platform_event_is_reclaimed_when_retried_on_platform_route(self):
        event = {
            "id": "evt_platform_route_retry",
            "object": "event",
            "type": "customer.subscription.updated",
            "livemode": True,
            "data": {"object": {"id": "sub_1"}},
        }

        with patch("app.services.webhook_service.get_settings", return_value=_FakeSettings()):
            with patch("app.services.webhook_service.BillingService", _FakeBillingService):
                with patch(
                    "app.services.webhook_service.PlatformBillingService",
                    _FakePlatformBillingService,
                ):
                    wrong_route = self._post_event(
                        "connect",
                        event,
                        _FakeSettings.STRIPE_CONNECT_WEBHOOK_SECRET,
                    )
                    self.assertEqual(wrong_route.status_code, 400)
                    self.assertEqual(
                        wrong_route.json()["detail"],
                        "Platform events must be delivered to the platform webhook route.",
                    )
                    self.assertEqual(len(self.rows), 1)
                    self.assertEqual(self.rows[0]["processing_status"], "failed")
                    self.assertEqual(self.rows[0]["error"], "wrong_route_platform_event")
                    retried = self._post_event(
                        "platform",
                        event,
                        _FakeSettings.STRIPE_PLATFORM_WEBHOOK_SECRET,
                    )

        self.assertEqual(retried.status_code, 200)
        self.assertEqual(retried.json(), {"received": True, "status": "processed"})
        self.assertEqual(_FakeBillingService.calls, 0)
        self.assertEqual(
            _FakePlatformBillingService.hydrate_calls,
            [("evt_platform_route_retry", True)],
        )
        self.assertEqual(len(self.rows), 1)
        self.assertEqual(self.rows[0]["processing_status"], "processed")
        self.assertIsNone(self.rows[0]["stripe_account_id"])
        self.assertIsNone(self.rows[0]["error"])

    def test_connect_event_is_reclaimed_when_retried_on_connect_route(self):
        event = {
            "id": "evt_connect_route_retry",
            "object": "event",
            "account": "acct_1",
            "type": "account.updated",
            "livemode": True,
            "data": {"object": {"id": "acct_1"}},
        }

        with patch("app.services.webhook_service.get_settings", return_value=_FakeSettings()):
            with patch("app.services.webhook_service.BillingService", _FakeBillingService):
                with patch(
                    "app.services.webhook_service.PlatformBillingService",
                    _FakePlatformBillingService,
                ):
                    wrong_route = self._post_event(
                        "platform",
                        event,
                        _FakeSettings.STRIPE_PLATFORM_WEBHOOK_SECRET,
                    )
                    self.assertEqual(wrong_route.status_code, 400)
                    self.assertEqual(
                        wrong_route.json()["detail"],
                        "Connected-account events must be delivered to the Connect webhook route.",
                    )
                    self.assertEqual(len(self.rows), 1)
                    self.assertEqual(self.rows[0]["processing_status"], "failed")
                    self.assertEqual(self.rows[0]["error"], "wrong_route_connect_event")
                    retried = self._post_event(
                        "connect",
                        event,
                        _FakeSettings.STRIPE_CONNECT_WEBHOOK_SECRET,
                    )

        self.assertEqual(retried.status_code, 200)
        self.assertEqual(retried.json(), {"received": True, "status": "processed"})
        self.assertEqual(_FakeBillingService.calls, 1)
        self.assertEqual(_FakePlatformBillingService.hydrate_calls, [])
        self.assertEqual(len(self.rows), 1)
        self.assertEqual(self.rows[0]["processing_status"], "processed")
        self.assertEqual(self.rows[0]["stripe_account_id"], "acct_1")
        self.assertIsNone(self.rows[0]["error"])

    def test_excluded_unmapped_connect_event_returns_success_and_is_ignored(self):
        self.supabase.tables["stripe_connect_account_dispositions"].append({
            "stripe_connected_account_id": "acct_retired",
            "excluded": True,
        })
        event = {
            "id": "evt_retired_account_route",
            "object": "event",
            "account": "acct_retired",
            "type": "account.application.deauthorized",
            "livemode": True,
            "data": {"object": {"id": "acct_retired"}},
        }

        with patch("app.services.webhook_service.get_settings", return_value=_FakeSettings()):
            with patch("app.services.webhook_service.BillingService", _FakeBillingService):
                response = self._post_event(
                    "connect",
                    event,
                    _FakeSettings.STRIPE_CONNECT_WEBHOOK_SECRET,
                )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"received": True, "status": "ignored"})
        self.assertEqual(_FakeBillingService.calls, 0)
        self.assertEqual(len(self.rows), 1)
        self.assertEqual(self.rows[0]["processing_status"], "ignored")
        self.assertIsNone(self.rows[0]["error"])

        with patch("app.services.webhook_service.get_settings", return_value=_FakeSettings()):
            with patch("app.services.webhook_service.BillingService", _FakeBillingService):
                duplicate = self._post_event(
                    "connect",
                    event,
                    _FakeSettings.STRIPE_CONNECT_WEBHOOK_SECRET,
                )

        self.assertEqual(duplicate.status_code, 200)
        self.assertEqual(duplicate.json(), {"received": True, "status": "ignored"})
        self.assertEqual(_FakeBillingService.calls, 0)
        self.assertEqual(len(self.rows), 1)

    def test_platform_route_reclaims_provider_retry_after_projection_failure(self):
        event = {
            "id": "evt_platform_projection_retry",
            "object": "event",
            "type": "invoice.paid",
            "livemode": True,
            "data": {"object": {"id": "in_1"}},
        }
        _FakePlatformBillingService.raise_during_projection = RuntimeError(
            "transient platform projection failure"
        )

        with patch("app.services.webhook_service.get_settings", return_value=_FakeSettings()):
            with patch(
                "app.services.webhook_service.PlatformBillingService",
                _FakePlatformBillingService,
            ):
                first_attempt = self._post_event(
                    "platform",
                    event,
                    _FakeSettings.STRIPE_PLATFORM_WEBHOOK_SECRET,
                )
                self.assertEqual(first_attempt.status_code, 500)
                self.assertEqual(first_attempt.json()["detail"], "Internal server error.")
                self.assertNotIn("transient platform projection failure", first_attempt.text)
                self.assertEqual(self.rows[0]["processing_status"], "failed")
                self.assertEqual(self.rows[0]["error"], "unexpected_processing_error")

                _FakePlatformBillingService.raise_during_projection = None
                retried = self._post_event(
                    "platform",
                    event,
                    _FakeSettings.STRIPE_PLATFORM_WEBHOOK_SECRET,
                )

        self.assertEqual(retried.status_code, 200)
        self.assertEqual(retried.json(), {"received": True, "status": "processed"})
        self.assertEqual(
            _FakePlatformBillingService.hydrate_calls,
            [
                ("evt_platform_projection_retry", True),
                ("evt_platform_projection_retry", True),
            ],
        )
        self.assertEqual(len(self.rows), 1)
        self.assertEqual(self.rows[0]["processing_status"], "processed")
        self.assertIsNone(self.rows[0]["error"])
