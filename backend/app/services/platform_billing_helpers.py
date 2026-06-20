from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from typing import Any, Optional
from urllib.parse import urlparse

from fastapi import HTTPException

from app.schemas.billing import EmailUsageResponse, PlatformBillingStatusResponse


PENDING_CHECKOUT_METADATA_KEY = "core_checkout_session"
SUBSCRIPTION_EVENT_METADATA_KEY = "core_subscription_event_created"
INVOICE_PAYMENT_EVENT_METADATA_KEY = "core_invoice_payment_event_created"
MAX_IDEMPOTENCY_KEY_LENGTH = 255


def to_text(value: Any) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.isoformat()
    return str(value)


def build_idempotency_key(*parts: Any) -> str:
    raw = "koaryu:" + ":".join(str(part).replace(":", "_") for part in parts if part is not None)
    if len(raw) <= MAX_IDEMPOTENCY_KEY_LENGTH:
        return raw

    operation = str(parts[0]).replace(":", "_") if parts else "request"
    digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()
    return f"koaryu:{operation}:{digest}"[:MAX_IDEMPOTENCY_KEY_LENGTH]


def normalize_idempotency_key(value: Optional[str]) -> Optional[str]:
    if value is None:
        return None
    normalized = value.strip()
    if not normalized:
        return None
    if len(normalized) > MAX_IDEMPOTENCY_KEY_LENGTH:
        raise HTTPException(
            status_code=400,
            detail=f"Idempotency-Key must be {MAX_IDEMPOTENCY_KEY_LENGTH} characters or fewer.",
        )
    return normalized


def stable_hash(payload: dict[str, Any]) -> str:
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def build_core_checkout_idempotency_key(
    studio_id: str,
    customer_id: str,
    checkout_urls: dict[str, str],
    request_key: Optional[str],
    price_id: Any,
) -> str:
    normalized = normalize_idempotency_key(request_key)
    if normalized:
        return build_idempotency_key("core-checkout", studio_id, normalized)
    request_hash = stable_hash({
        "customer_id": customer_id,
        "price_id": price_id,
        "success_url": checkout_urls["success_url"],
        "cancel_url": checkout_urls["cancel_url"],
    })
    return build_idempotency_key("core-checkout", studio_id, request_hash)


def allowed_redirect_origins(frontend_url: str) -> set[str]:
    parsed = urlparse(frontend_url.rstrip("/"))
    if not parsed.scheme or not parsed.netloc:
        return set()
    origins = {f"{parsed.scheme}://{parsed.netloc}"}
    if parsed.scheme == "http" and parsed.hostname in {"localhost", "127.0.0.1"} and parsed.port:
        alternate_host = "127.0.0.1" if parsed.hostname == "localhost" else "localhost"
        origins.add(f"http://{alternate_host}:{parsed.port}")
    return origins


def safe_redirect_url(value: Optional[str], default: str, frontend_url: str) -> str:
    url = (value or default).strip()
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise HTTPException(status_code=400, detail="Billing redirect URL must be absolute.")
    origin = f"{parsed.scheme}://{parsed.netloc}"
    if origin not in allowed_redirect_origins(frontend_url):
        raise HTTPException(status_code=400, detail="Billing redirect URL is not allowed.")
    return url


def row_metadata(row: dict[str, Any]) -> dict[str, Any]:
    metadata = row.get("metadata")
    return dict(metadata) if isinstance(metadata, dict) else {}


def merge_metadata(row: dict[str, Any], patch: dict[str, Any]) -> dict[str, Any]:
    metadata = row_metadata(row)
    for key, value in patch.items():
        if value is None:
            metadata.pop(key, None)
        else:
            metadata[key] = value
    return metadata


def pending_checkout_url(row: dict[str, Any], now: Optional[datetime] = None) -> Optional[str]:
    pending = row_metadata(row).get(PENDING_CHECKOUT_METADATA_KEY)
    if not isinstance(pending, dict):
        return None
    session_url = pending.get("url")
    expires_at = pending.get("expires_at")
    if not session_url or not expires_at:
        return None
    try:
        expires_epoch = int(expires_at)
    except (TypeError, ValueError):
        return None
    now = now or datetime.now(timezone.utc)
    if expires_epoch <= int(now.timestamp()) + 60:
        return None
    return str(session_url)


def pending_checkout_metadata_update(
    row: dict[str, Any],
    *,
    session_id: Optional[str],
    session_url: str,
    expires_at: Optional[int],
    now: Optional[datetime] = None,
) -> Optional[dict[str, Any]]:
    if not expires_at:
        return None
    now = now or datetime.now(timezone.utc)
    pending = {
        "id": session_id,
        "url": session_url,
        "expires_at": int(expires_at),
        "created_at": now.isoformat(),
    }
    return {"metadata": merge_metadata(row, {PENDING_CHECKOUT_METADATA_KEY: pending})}


def status_response(row: dict[str, Any], email_usage: EmailUsageResponse) -> PlatformBillingStatusResponse:
    return PlatformBillingStatusResponse(
        studio_id=row["studio_id"],
        plan_name=row.get("plan_name") or "Koaryu Core",
        monthly_price_cents=row.get("monthly_price_cents") or 2700,
        currency=row.get("currency") or "usd",
        status=row.get("status") or "comped",
        comped=bool(row.get("comped", True)),
        trial_start=to_text(row.get("trial_start")),
        trial_end=to_text(row.get("trial_end")),
        current_period_start=to_text(row.get("current_period_start")),
        current_period_end=to_text(row.get("current_period_end")),
        cancel_at_period_end=bool(row.get("cancel_at_period_end")),
        last_payment_status=row.get("last_payment_status"),
        stripe_customer_id=row.get("stripe_customer_id"),
        stripe_subscription_id=row.get("stripe_subscription_id"),
        email_usage=email_usage,
    )
