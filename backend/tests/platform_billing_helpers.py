from __future__ import annotations

import unittest
from copy import deepcopy
from datetime import datetime, timezone
from math import floor
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
        self.on_update_query = self._apply_studio_subscription_update

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

    def _rpc_clear_studio_comp_for_billing_event(self, params: dict) -> bool:
        row = next(
            (
                item
                for item in self.tables["studio_subscriptions"]
                if item.get("studio_id") == params["p_studio_id"]
            ),
            None,
        )
        if row is None:
            raise RuntimeError("Studio subscription not found.")
        if not row.get("comped", False):
            return False

        metadata = row.get("metadata")
        comp_value = metadata.get("comp") if isinstance(metadata, dict) else None
        comp = comp_value if isinstance(comp_value, dict) else {}
        if comp.get("state") == "granted":
            event_created = params.get("p_event_created")
            granted_at = comp.get("at")
            if event_created is None or not granted_at:
                return False
            try:
                grant_epoch = self._parse_timestamp(granted_at).timestamp()
            except (TypeError, ValueError):
                return False
            if float(event_created) < floor(grant_epoch):
                return False

        row["comped"] = False
        return True

    def _apply_studio_subscription_update(self, query, rows):
        if query.name != "studio_subscriptions":
            return None

        before_update = self.before_update
        if before_update:
            self.before_update = None
            before_update(rows)

        matched = query._matched_rows(rows)
        for row in matched:
            update = deepcopy(query.update_payload)
            previous_comp = (row.get("metadata") or {}).get("comp")
            if "metadata" in update and previous_comp is not None:
                metadata = deepcopy(update.get("metadata") or {})
                if metadata.get("comp") != previous_comp:
                    metadata["comp"] = deepcopy(previous_comp)
                update["metadata"] = metadata
            row.update(update)
        return [dict(row) for row in matched]


class FakeSettings:
    FRONTEND_URL = "https://koaryu.test"
    STRIPE_KOARYU_CORE_PRICE_ID = "price_core"


class PlatformBillingServiceTestCase(unittest.TestCase):
    def service(self, rows: list[dict]) -> PlatformBillingService:
        with patch("app.services.platform_billing_service.get_settings", return_value=FakeSettings()):
            return PlatformBillingService(FakeSupabase(rows))
