from __future__ import annotations

import asyncio
import hashlib
import hmac
import time
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import stripe
from fastapi import HTTPException

from app.services.stripe_service import StripeService
from app.services.stripe_mutation_policy import (
    LIVE_MUTATIONS_DISABLED_DETAIL,
    StripeMutationBlocked,
)
from app.services.webhook_service import StripeWebhookService
from tests.fakes.supabase import RpcBackedSupabase


class _FakeSupabase(RpcBackedSupabase):
    def __init__(self, rows, *, mapped_account_ids=("acct_1",)):
        super().__init__({
            "stripe_events": rows,
            "studio_payment_accounts": [
                {
                    "studio_id": f"studio_{index}",
                    "stripe_connected_account_id": account_id,
                }
                for index, account_id in enumerate(mapped_account_ids, start=1)
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

    def _rpc_finish_stripe_event_processing(self, params: dict) -> list[dict]:
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

    def __init__(self, supabase):
        self.supabase = supabase

    def project_subscription_event(self, event, *, hydrate_subscription: bool = True):
        self.__class__.hydrate_calls.append((event["id"], hydrate_subscription))


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
    def service(self, rows, *, mapped_account_ids=("acct_1",)):
        with patch("app.services.webhook_service.get_settings", return_value=_FakeSettings()):
            return StripeWebhookService(
                _FakeSupabase(rows, mapped_account_ids=mapped_account_ids)
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
            with self.assertRaises(RuntimeError):
                self.handle_connect_event(rows)
        finally:
            _FakeBillingService.raise_during_projection = None

        self.assertEqual(_FakeBillingService.calls, 1)
        self.assertEqual(rows[0]["processing_status"], "failed")
        self.assertEqual(rows[0]["error"], "unexpected_processing_error")
        self.assertNotIn("raw provider secret detail", rows[0]["error"])

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
            ["claim_stripe_event_for_processing", "finish_stripe_event_processing"],
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
                secret="whsec_first, whsec_second",
            )

        self.assertEqual(event["id"], "evt_1")

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
                    secret="whsec_first\nwhsec_third",
                )

        self.assertEqual(raised.exception.status_code, 400)
