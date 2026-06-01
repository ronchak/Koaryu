from __future__ import annotations

import asyncio
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

from fastapi import HTTPException

from app.services.stripe_service import StripeService
from app.services.webhook_service import StripeWebhookService
from tests.fakes.supabase import RpcBackedSupabase


class _FakeSupabase(RpcBackedSupabase):
    def __init__(self, rows):
        super().__init__({"stripe_events": rows})

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
        row.update({
            "processing_status": "processing",
            "processing_token": params["p_processing_token"],
            "processing_started_at": datetime.now(timezone.utc).isoformat(),
            "error": None,
        })
        return [{"claim_status": "claimed", "event_row": dict(row)}]

    def _rpc_finish_stripe_event_processing(self, params: dict) -> list[dict]:
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
    def _rpc_claim_stripe_event_for_processing(self, _params: dict) -> list[dict]:
        return [{
                "claim_status": "claimed",
                "event_row": {"id": "row_1"},
        }]

    def _rpc_finish_stripe_event_processing(self, params: dict) -> list[dict]:
        return [{
            "updated": True,
            "event_row": {"id": params["p_event_id"], "processing_status": params["p_status"]},
        }]


class _FakeBillingService:
    calls = 0
    mutate_during_projection = None

    def __init__(self, supabase):
        self.supabase = supabase

    def project_connect_event(self, _event):
        self.__class__.calls += 1
        if self.__class__.mutate_during_projection:
            self.__class__.mutate_during_projection(self.supabase.tables["stripe_events"])


class _FakeWebhook:
    @staticmethod
    def construct_event(payload, signature, secret):
        if secret != "whsec_second":
            raise ValueError("wrong secret")
        return {"id": "evt_1", "payload": payload.decode(), "signature": signature}


class _FakeStripeModule:
    Webhook = _FakeWebhook


class _FakeSettings:
    STRIPE_CONNECT_WEBHOOK_SECRET = "whsec_connect"
    STRIPE_PLATFORM_WEBHOOK_SECRET = "whsec_platform"


class WebhookServiceTest(unittest.TestCase):
    def service(self, rows):
        with patch("app.services.webhook_service.get_settings", return_value=_FakeSettings()):
            return StripeWebhookService(_FakeSupabase(rows))

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

    def test_fresh_processing_duplicate_is_not_reprocessed(self):
        rows = [{
            "id": "row_1",
            "stripe_event_id": "evt_1",
            "stripe_account_id": "acct_1",
            "processing_status": "processing",
            "created_at": datetime.now(timezone.utc).isoformat(),
        }]
        _FakeBillingService.calls = 0

        result = self.handle_connect_event(rows)

        self.assertEqual(result.status, "already_processing")
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
            ["claim_stripe_event_for_processing", "finish_stripe_event_processing"],
        )
        self.assertEqual(supabase.rpc_calls[0][1]["p_stripe_account_id"], "acct_1")

    def test_construct_webhook_event_accepts_rotated_secret_list(self):
        service = StripeService()
        with patch.object(service, "_stripe", return_value=_FakeStripeModule):
            event = service.construct_webhook_event(
                payload=b"{}",
                signature="sig",
                secret="whsec_first, whsec_second",
            )

        self.assertEqual(event["id"], "evt_1")

    def test_construct_webhook_event_rejects_when_no_secret_matches(self):
        service = StripeService()
        with patch.object(service, "_stripe", return_value=_FakeStripeModule):
            with self.assertRaises(HTTPException) as raised:
                service.construct_webhook_event(
                    payload=b"{}",
                    signature="sig",
                    secret="whsec_first\nwhsec_third",
                )

        self.assertEqual(raised.exception.status_code, 400)
