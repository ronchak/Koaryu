from __future__ import annotations

import unittest
from unittest.mock import patch

from app.services.platform_billing_service import PlatformBillingService
from tests.fakes.supabase import TableBackedSupabase


class FakeSupabase(TableBackedSupabase):
    def __init__(self, rows: list[dict]):
        super().__init__({
            "studio_subscriptions": rows,
            "email_usage_events": [],
            "studios": [{"id": "studio_1", "name": "Koaryu Test Studio"}],
            "audit_logs": [],
        })


class FakeSettings:
    FRONTEND_URL = "https://koaryu.test"
    STRIPE_KOARYU_CORE_PRICE_ID = "price_core"


class PlatformBillingServiceTestCase(unittest.TestCase):
    def service(self, rows: list[dict]) -> PlatformBillingService:
        with patch("app.services.platform_billing_service.get_settings", return_value=FakeSettings()):
            return PlatformBillingService(FakeSupabase(rows))
