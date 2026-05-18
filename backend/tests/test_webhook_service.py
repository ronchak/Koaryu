from __future__ import annotations

import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

from app.services.webhook_service import StripeWebhookService


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

    def insert(self, values):
        self.rows.append(dict(values))
        return self

    def update(self, values):
        self.update_values = dict(values)
        return self

    def eq(self, key, value):
        self.filters.append(lambda row, key=key, value=value: row.get(key) == value)
        return self

    def is_(self, key, value):
        if value == "null":
            self.filters.append(lambda row, key=key: row.get(key) is None)
        return self

    def in_(self, key, values):
        allowed = set(values)
        self.filters.append(lambda row, key=key, allowed=allowed: row.get(key) in allowed)
        return self

    def execute(self):
        matched = [row for row in self.rows if all(match(row) for match in self.filters)]
        if self.update_values is not None:
            for row in matched:
                row.update(self.update_values)
        return _FakeResponse([dict(row) for row in matched])


class _FakeSupabase:
    def __init__(self, rows):
        self.rows = rows

    def table(self, name):
        assert name == "stripe_events"
        return _FakeQuery(self.rows)


class _FakeBillingService:
    calls = 0

    def __init__(self, _supabase):
        pass

    def project_connect_event(self, _event):
        self.__class__.calls += 1


class WebhookServiceTest(unittest.TestCase):
    def service(self, rows):
        service = object.__new__(StripeWebhookService)
        service.supabase = _FakeSupabase(rows)
        service.settings = object()
        return service

    def test_fresh_processing_duplicate_is_not_reprocessed(self):
        rows = [{
            "id": "row_1",
            "stripe_event_id": "evt_1",
            "stripe_account_id": "acct_1",
            "processing_status": "processing",
            "created_at": datetime.now(timezone.utc).isoformat(),
        }]
        _FakeBillingService.calls = 0

        with patch("app.services.webhook_service.BillingService", _FakeBillingService):
            result = self.service(rows)._store_and_process(
                {"id": "evt_1", "type": "account.updated", "livemode": True, "data": {"object": {"id": "acct_1"}}},
                stripe_account_id="acct_1",
                processor="connect",
            )

        self.assertEqual(result.status, "already_processing")
        self.assertEqual(_FakeBillingService.calls, 0)
        self.assertEqual(rows[0]["processing_status"], "processing")

    def test_stale_processing_duplicate_is_reclaimed(self):
        rows = [{
            "id": "row_1",
            "stripe_event_id": "evt_1",
            "stripe_account_id": "acct_1",
            "processing_status": "processing",
            "created_at": (datetime.now(timezone.utc) - timedelta(minutes=11)).isoformat(),
            "error": "worker exited",
        }]
        _FakeBillingService.calls = 0

        with patch("app.services.webhook_service.BillingService", _FakeBillingService):
            result = self.service(rows)._store_and_process(
                {"id": "evt_1", "type": "account.updated", "livemode": True, "data": {"object": {"id": "acct_1"}}},
                stripe_account_id="acct_1",
                processor="connect",
            )

        self.assertEqual(result.status, "processed")
        self.assertEqual(_FakeBillingService.calls, 1)
        self.assertEqual(rows[0]["processing_status"], "processed")
        self.assertIsNone(rows[0]["error"])
        self.assertIsNotNone(rows[0]["processed_at"])
