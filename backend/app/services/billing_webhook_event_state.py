from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional


INVOICE_STATUS_ORDER = {
    "draft": 0,
    "open": 1,
    "uncollectible": 2,
    "paid": 3,
    "partially_refunded": 4,
    "refunded": 4,
    "void": 4,
}
SUBSCRIPTION_STATUS_ORDER = {
    "incomplete": 0,
    "trialing": 1,
    "active": 2,
    "past_due": 2,
    "unpaid": 3,
    "canceled": 4,
    "incomplete_expired": 4,
}
PAYMENT_STATUS_ORDER = {
    "failed": 0,
    "processing": 1,
    "succeeded": 2,
    "externally_recorded": 2,
    "disputed": 3,
    "partially_refunded": 4,
    "refunded": 4,
}
ACCOUNT_STATUS_ORDER = {
    "not_connected": 0,
    "onboarding_incomplete": 1,
    "action_required": 1,
    "charges_enabled": 2,
    "deauthorized": 3,
}


def is_stale_stripe_event(row: dict[str, Any], event_created: Optional[int]) -> bool:
    if event_created is None:
        return False
    last_created = row.get("last_stripe_event_created")
    return last_created is not None and int(last_created) > int(event_created)


def is_same_second_status_regression(
    last_event_created: Any,
    event_created: Optional[int],
    *,
    current_status: Optional[str],
    incoming_status: Optional[str],
    status_order: dict[str, int],
) -> bool:
    if event_created is None or last_event_created is None:
        return False
    try:
        if int(last_event_created) != int(event_created):
            return False
    except (TypeError, ValueError):
        return False
    return status_order.get(current_status or "", -1) > status_order.get(incoming_status or "", -1)


def add_stripe_event_created_guard(query: Any, event_created: Optional[int]) -> Any:
    if event_created is None:
        return query
    return query.or_(
        f"last_stripe_event_created.is.null,last_stripe_event_created.lte.{int(event_created)}"
    )


def preserve_invoice_terminal_state(update: dict[str, Any], current: dict[str, Any]) -> dict[str, Any]:
    preserved = dict(update)
    for field in (
        "status",
        "amount_paid_cents",
        "amount_remaining_cents",
        "stripe_payment_intent_id",
        "application_fee_amount_cents",
        "paid_at",
        "last_payment_error",
    ):
        if current.get(field) is not None:
            preserved[field] = current[field]
    return preserved


def timestamp(value: Any) -> Optional[str]:
    if not value:
        return None
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(value, tz=timezone.utc).isoformat()
    if isinstance(value, datetime):
        return value.isoformat()
    return str(value)


def epoch_seconds(value: Any) -> Optional[float]:
    if not value:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, datetime):
        parsed = value
    else:
        try:
            parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        except ValueError:
            return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.timestamp()


def date_from_epoch(value: Any) -> Optional[str]:
    if not value:
        return None
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(value, tz=timezone.utc).date().isoformat()
    return str(value)
