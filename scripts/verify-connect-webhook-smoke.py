#!/usr/bin/env python3
"""Smoke-test Koaryu's local Stripe Connect webhook endpoint.

This does not create or modify Stripe Dashboard webhook endpoints. It sends a
signed synthetic Connect webhook to the running local backend and repeats the
same event to verify local dedupe behavior.
"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import sys
import time
import uuid
from pathlib import Path
from typing import Any

import httpx
from dotenv import load_dotenv


ROOT_DIR = Path(__file__).resolve().parents[1]
BACKEND_DIR = ROOT_DIR / "backend"
BACKEND_ENV = ROOT_DIR / "backend" / ".env"
DEFAULT_ENDPOINT = "http://127.0.0.1:8001/api/v1/webhooks/stripe/connect"
STAGING_ENDPOINT = "https://koaryu-staging.onrender.com/api/v1/webhooks/stripe/connect"
LOCAL_SUPABASE_URL = "http://127.0.0.1:54321"
STAGING_SUPABASE_URL = "https://nxgsektqsgrtyfhawxbc.supabase.co"
PRODUCTION_SUPABASE_URL = "https://mimguepumzsgmcaycdsh.supabase.co"

sys.path.insert(0, str(BACKEND_DIR))
from app.db.supabase import create_supabase_client  # noqa: E402


def _load_environment() -> None:
    load_dotenv(BACKEND_ENV)
    load_dotenv(ROOT_DIR / ".env")


def _require_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise SystemExit(f"Missing required environment variable: {name}")
    return value


def _connect_webhook_secret() -> str:
    raw_secret = _require_env("STRIPE_CONNECT_WEBHOOK_SECRET")
    secrets = [chunk.strip() for chunk in raw_secret.replace("\n", ",").split(",") if chunk.strip()]
    if not secrets:
        raise SystemExit("STRIPE_CONNECT_WEBHOOK_SECRET must contain at least one webhook secret.")
    return secrets[0]


def _require_safety_confirmation(args: argparse.Namespace) -> None:
    if not args.confirm_stateful_target:
        raise SystemExit(
            "This smoke test reads a Supabase service-role key and posts a synthetic "
            "webhook that mutates billing tables. Re-run with --confirm-stateful-target "
            "after verifying the loaded .env files and backend point at the intended "
            "disposable/local target."
        )

    environment = str(os.environ.get("ENVIRONMENT") or "").strip().lower()
    supabase_url = str(os.environ.get("SUPABASE_URL") or "").strip().rstrip("/")
    stripe_keys = [
        str(os.environ.get(name) or "").strip()
        for name in ("STRIPE_SECRET_KEY", "STRIPE_RESTRICTED_KEY")
    ]
    if (
        environment == "production"
        or supabase_url == PRODUCTION_SUPABASE_URL
        or any(key.startswith(("sk_live_", "rk_live_")) for key in stripe_keys)
    ):
        raise SystemExit("Production configuration is permanently denied for the synthetic Connect smoke.")

    expected = {
        "local": ("development", LOCAL_SUPABASE_URL, DEFAULT_ENDPOINT),
        "staging": ("staging", STAGING_SUPABASE_URL, STAGING_ENDPOINT),
    }[args.target]
    expected_environment, expected_supabase_url, expected_endpoint = expected
    if environment != expected_environment or supabase_url != expected_supabase_url:
        raise SystemExit(f"Loaded configuration does not match the pinned {args.target} target.")
    if args.endpoint != expected_endpoint:
        raise SystemExit(f"Webhook endpoint does not match the pinned {args.target} target.")
    if not stripe_keys[0].startswith("sk_test_"):
        raise SystemExit("Synthetic Connect smoke requires an explicit Stripe test secret key.")
    if stripe_keys[1] and not stripe_keys[1].startswith("rk_test_"):
        raise SystemExit("Synthetic Connect smoke restricted key must remain in test mode.")

    if not args.account and not args.allow_newest_account:
        raise SystemExit(
            "Pass --account acct_... to choose a connected account explicitly, or pass "
            "--allow-newest-account only when the loaded Supabase target is disposable."
        )


def _supabase_client():
    return create_supabase_client()


def _first_connect_account(account_id: str | None) -> dict[str, Any]:
    supabase = _supabase_client()
    query = (
        supabase.table("studio_payment_accounts")
        .select("*")
        .not_.is_("stripe_connected_account_id", "null")
        .order("created_at", desc=True)
        .limit(1)
    )
    if account_id:
        query = (
            supabase.table("studio_payment_accounts")
            .select("*")
            .eq("stripe_connected_account_id", account_id)
            .limit(1)
        )
    result = query.execute()
    if not result.data:
        raise SystemExit("No studio_payment_accounts row with a connected Stripe account was found.")
    return result.data[0]


def _event_payload(account: dict[str, Any], event_id: str) -> bytes:
    stripe_account_id = account["stripe_connected_account_id"]
    payload = {
        "id": event_id,
        "object": "event",
        "api_version": "2024-06-20",
        "created": int(time.time()),
        "livemode": False,
        "type": "account.updated",
        "account": stripe_account_id,
        "data": {
            "object": {
                "id": stripe_account_id,
                "object": "account",
                "charges_enabled": bool(account.get("charges_enabled")),
                "payouts_enabled": bool(account.get("payouts_enabled")),
                "details_submitted": bool(account.get("details_submitted")),
                "requirements": {
                    "currently_due": account.get("requirements_due") or [],
                },
                "metadata": {
                    "verification": "koaryu_connect_webhook_smoke",
                },
            },
        },
    }
    return json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")


def _signature_header(secret: str, payload: bytes) -> str:
    timestamp = str(int(time.time()))
    signed_payload = timestamp.encode("utf-8") + b"." + payload
    signature = hmac.new(secret.encode("utf-8"), signed_payload, hashlib.sha256).hexdigest()
    return f"t={timestamp},v1={signature}"


def _post(endpoint: str, secret: str, payload: bytes) -> dict[str, Any]:
    headers = {
        "content-type": "application/json",
        "stripe-signature": _signature_header(secret, payload),
    }
    response = httpx.post(endpoint, content=payload, headers=headers, timeout=15)
    try:
        body = response.json()
    except json.JSONDecodeError:
        body = {"raw": response.text}
    if response.status_code >= 400:
        raise SystemExit(f"Webhook POST failed with HTTP {response.status_code}: {body}")
    return body


def main() -> int:
    parser = argparse.ArgumentParser(description="Smoke-test Koaryu's Stripe Connect webhook route.")
    parser.add_argument("--target", choices=("local", "staging"), required=True)
    parser.add_argument("--account", help="Stripe connected account id to target. Defaults to newest local account row.")
    parser.add_argument("--event-id", default=f"evt_koaryu_connect_smoke_{uuid.uuid4().hex[:24]}")
    parser.add_argument(
        "--confirm-stateful-target",
        action="store_true",
        help="Required. Confirms the loaded env files/backend target are intentionally disposable for this stateful smoke.",
    )
    parser.add_argument(
        "--allow-newest-account",
        action="store_true",
        help="Allow choosing the newest connected account row when --account is omitted.",
    )
    args = parser.parse_args()

    _load_environment()
    args.endpoint = DEFAULT_ENDPOINT if args.target == "local" else STAGING_ENDPOINT
    _require_safety_confirmation(args)
    secret = _connect_webhook_secret()
    account = _first_connect_account(args.account)
    payload = _event_payload(account, args.event_id)

    first = _post(args.endpoint, secret, payload)
    second = _post(args.endpoint, secret, payload)

    expected = ("processed", "already_processed")
    actual = (first.get("status"), second.get("status"))
    print(json.dumps({
        "endpoint": args.endpoint,
        "stripe_account_id": account["stripe_connected_account_id"],
        "event_id": args.event_id,
        "first_status": actual[0],
        "second_status": actual[1],
        "ok": actual == expected,
    }, indent=2))
    if actual != expected:
        print(f"Expected statuses {expected}, got {actual}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
