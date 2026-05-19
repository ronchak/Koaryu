from __future__ import annotations

import argparse
from pathlib import Path
import sys

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.db.supabase import get_supabase_client
from app.services.stripe_service import StripeService


DEFAULT_PRIMARY_COLOR = "#0B0D10"
DEFAULT_SECONDARY_COLOR = "#D6B25E"


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Backfill Koaryu branding onto existing Stripe connected accounts.")
    parser.add_argument("--execute", action="store_true", help="Apply updates. Without this flag, only print the plan.")
    parser.add_argument("--icon-path", type=Path, help="Optional local PNG/JPG path to upload as the connected-account icon.")
    parser.add_argument("--logo-path", type=Path, help="Optional local PNG/JPG path to upload as the connected-account logo.")
    parser.add_argument("--primary-color", default=DEFAULT_PRIMARY_COLOR)
    parser.add_argument("--secondary-color", default=DEFAULT_SECONDARY_COLOR)
    return parser.parse_args()


def main() -> None:
    args = _parse_args()
    rows = (
        get_supabase_client()
        .table("studio_payment_accounts")
        .select("studio_id,stripe_connected_account_id")
        .not_.is_("stripe_connected_account_id", "null")
        .execute()
        .data
        or []
    )

    print(f"Found {len(rows)} connected account(s).")
    for row in rows:
        print(f"- {row['studio_id']}: {row['stripe_connected_account_id']}")

    if not args.execute:
        print("Dry run only. Re-run with --execute to apply branding updates.")
        return

    stripe_service = StripeService()
    icon_file_id = (
        stripe_service.upload_branding_file(file_path=str(args.icon_path), purpose="business_icon")
        if args.icon_path
        else None
    )
    logo_file_id = (
        stripe_service.upload_branding_file(file_path=str(args.logo_path), purpose="business_logo")
        if args.logo_path
        else None
    )

    for row in rows:
        account_id = row["stripe_connected_account_id"]
        stripe_service.update_connect_account_branding(
            account_id=account_id,
            primary_color=args.primary_color,
            secondary_color=args.secondary_color,
            icon_file_id=icon_file_id,
            logo_file_id=logo_file_id,
        )
        print(f"Updated {account_id}")


if __name__ == "__main__":
    main()
