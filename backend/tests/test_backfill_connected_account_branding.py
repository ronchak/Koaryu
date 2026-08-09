from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from scripts import backfill_connected_account_branding


ROWS = [
    {
        "studio_id": "11111111-1111-4111-8111-111111111111",
        "stripe_connected_account_id": "acct_one",
    },
    {
        "studio_id": "22222222-2222-4222-8222-222222222222",
        "stripe_connected_account_id": "acct_two",
    },
]


class FakeQuery:
    def __init__(self, rows: list[dict[str, str]]):
        self.not_ = self
        self._rows = rows

    def select(self, _columns: str) -> FakeQuery:
        return self

    def is_(self, _column: str, _value: str) -> FakeQuery:
        return self

    def execute(self) -> SimpleNamespace:
        return SimpleNamespace(data=self._rows)


class FakeSupabase:
    def __init__(self, rows: list[dict[str, str]]):
        self._rows = rows

    def table(self, _name: str) -> FakeQuery:
        return FakeQuery(self._rows)


class FakeStripeService:
    def __init__(self):
        self.upload_calls: list[dict[str, str]] = []
        self.update_calls: list[dict[str, str | None]] = []

    def upload_branding_file(self, **kwargs: str) -> str:
        self.upload_calls.append(kwargs)
        return f"file_{kwargs['studio_id']}_{kwargs['purpose']}"

    def update_connect_account_branding(self, **kwargs: str | None) -> None:
        self.update_calls.append(kwargs)


def args(*, execute: bool) -> SimpleNamespace:
    return SimpleNamespace(
        execute=execute,
        icon_path=Path("icon.png"),
        logo_path=Path("logo.png"),
        primary_color="#123456",
        secondary_color="#ABCDEF",
    )


class BackfillConnectedAccountBrandingTest(unittest.TestCase):
    def test_dry_run_makes_no_stripe_provider_calls(self):
        with (
            patch.object(backfill_connected_account_branding, "_parse_args", return_value=args(execute=False)),
            patch.object(
                backfill_connected_account_branding,
                "get_supabase_client",
                return_value=FakeSupabase(ROWS),
            ),
            patch.object(backfill_connected_account_branding, "StripeService") as stripe_service_class,
        ):
            backfill_connected_account_branding.main()

        stripe_service_class.assert_not_called()
        stripe_service_class.return_value.upload_branding_file.assert_not_called()
        stripe_service_class.return_value.update_connect_account_branding.assert_not_called()

    def test_execute_uploads_and_updates_branding_per_studio(self):
        stripe_service = FakeStripeService()
        with (
            patch.object(backfill_connected_account_branding, "_parse_args", return_value=args(execute=True)),
            patch.object(
                backfill_connected_account_branding,
                "get_supabase_client",
                return_value=FakeSupabase(ROWS),
            ),
            patch.object(
                backfill_connected_account_branding,
                "StripeService",
                return_value=stripe_service,
            ),
        ):
            backfill_connected_account_branding.main()

        self.assertEqual(
            stripe_service.upload_calls,
            [
                {
                    "file_path": "icon.png",
                    "purpose": "business_icon",
                    "studio_id": ROWS[0]["studio_id"],
                },
                {
                    "file_path": "logo.png",
                    "purpose": "business_logo",
                    "studio_id": ROWS[0]["studio_id"],
                },
                {
                    "file_path": "icon.png",
                    "purpose": "business_icon",
                    "studio_id": ROWS[1]["studio_id"],
                },
                {
                    "file_path": "logo.png",
                    "purpose": "business_logo",
                    "studio_id": ROWS[1]["studio_id"],
                },
            ],
        )
        self.assertEqual(
            stripe_service.update_calls,
            [
                {
                    "account_id": "acct_one",
                    "studio_id": ROWS[0]["studio_id"],
                    "primary_color": "#123456",
                    "secondary_color": "#ABCDEF",
                    "icon_file_id": f"file_{ROWS[0]['studio_id']}_business_icon",
                    "logo_file_id": f"file_{ROWS[0]['studio_id']}_business_logo",
                },
                {
                    "account_id": "acct_two",
                    "studio_id": ROWS[1]["studio_id"],
                    "primary_color": "#123456",
                    "secondary_color": "#ABCDEF",
                    "icon_file_id": f"file_{ROWS[1]['studio_id']}_business_icon",
                    "logo_file_id": f"file_{ROWS[1]['studio_id']}_business_logo",
                },
            ],
        )


if __name__ == "__main__":
    unittest.main()
