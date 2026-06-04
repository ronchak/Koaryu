from __future__ import annotations

import unittest
from datetime import datetime, timezone
from unittest.mock import patch

from app.services.platform_billing_service import PlatformBillingService
from tests.fakes.supabase import RpcBackedSupabase


class FakeSupabase(RpcBackedSupabase):
    def __init__(self, rows: list[dict]):
        super().__init__({
            "studio_subscriptions": rows,
            "email_usage_events": [],
            "studios": [{"id": "studio_1", "name": "Koaryu Test Studio"}],
            "audit_logs": [],
        })

    @staticmethod
    def _parse_timestamp(value: str):
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)

    def _rpc_sum_email_usage_for_period(self, params: dict) -> int:
        period_start = self._parse_timestamp(params["p_period_start"])
        period_end = self._parse_timestamp(params["p_period_end"])
        return sum(
            int(row.get("quantity") or 0)
            for row in self.tables.setdefault("email_usage_events", [])
            if row.get("studio_id") == params["p_studio_id"]
            and period_start <= self._parse_timestamp(row.get("sent_at")) < period_end
        )


class FakeSettings:
    FRONTEND_URL = "https://koaryu.test"
    STRIPE_KOARYU_CORE_PRICE_ID = "price_core"


class PlatformBillingServiceTestCase(unittest.TestCase):
    def service(self, rows: list[dict]) -> PlatformBillingService:
        with patch("app.services.platform_billing_service.get_settings", return_value=FakeSettings()):
            return PlatformBillingService(FakeSupabase(rows))
