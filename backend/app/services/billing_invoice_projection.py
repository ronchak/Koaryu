from __future__ import annotations

from datetime import datetime
from typing import Any, Optional


def to_text(value: Any) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.isoformat()
    return str(value)


def stripe_id(value: Any) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        return value.get("id")
    return getattr(value, "id", None)


def object_get(value: Any, key: str, default: Any = None) -> Any:
    if value is None:
        return default
    if isinstance(value, dict):
        return value.get(key, default)
    return getattr(value, key, default)


def invoice_metadata(invoice: Any) -> dict[str, Any]:
    merged: dict[str, Any] = {}
    parent_details = invoice_parent_subscription_details(invoice)
    merged.update(object_get(parent_details, "metadata") or {})
    single_line = single_invoice_line(invoice)
    if single_line:
        merged.update(object_get(single_line, "metadata") or {})
    merged.update(object_get(invoice, "metadata") or {})
    return merged


def merge_invoice_identity_from_stored_event(invoice: dict[str, Any], stored_invoice: dict[str, Any]) -> dict[str, Any]:
    merged = dict(invoice)
    if not invoice_parent_subscription_details(merged) and invoice_parent_subscription_details(stored_invoice):
        merged["parent"] = stored_invoice.get("parent")
    if not invoice_lines(merged) and invoice_lines(stored_invoice):
        merged["lines"] = stored_invoice.get("lines")
    if not (merged.get("metadata") or {}) and (stored_invoice.get("metadata") or {}):
        merged["metadata"] = stored_invoice.get("metadata")
    return merged


def invoice_parent_subscription_details(invoice: Any) -> dict[str, Any]:
    parent = object_get(invoice, "parent") or {}
    if object_get(parent, "type") != "subscription_details":
        return {}
    return object_get(parent, "subscription_details") or {}


def invoice_subscription_id(invoice: Any) -> Optional[str]:
    direct = stripe_id(object_get(invoice, "subscription"))
    if direct:
        return direct
    parent_details = invoice_parent_subscription_details(invoice)
    parent_subscription = stripe_id(object_get(parent_details, "subscription"))
    if parent_subscription:
        return parent_subscription
    line_subscriptions = {
        stripe_id(object_get(object_get(object_get(line, "parent") or {}, "subscription_item_details") or {}, "subscription"))
        or stripe_id(object_get(line, "subscription"))
        for line in invoice_lines(invoice)
    }
    line_subscriptions.discard(None)
    return next(iter(line_subscriptions)) if len(line_subscriptions) == 1 else None


def invoice_subscription_item_id(invoice: Any) -> Optional[str]:
    line_items = {
        stripe_id(object_get(object_get(object_get(line, "parent") or {}, "subscription_item_details") or {}, "subscription_item"))
        or stripe_id(object_get(line, "subscription_item"))
        for line in invoice_lines(invoice)
    }
    line_items.discard(None)
    return next(iter(line_items)) if len(line_items) == 1 else None


def invoice_line_period_bounds(invoice: Any) -> tuple[Optional[Any], Optional[Any]]:
    period_pairs: set[tuple[Any, Any]] = set()
    for line in invoice_lines(invoice):
        if object_get(line, "proration"):
            continue
        period = object_get(line, "period") or {}
        start = object_get(period, "start")
        end = object_get(period, "end")
        if start and end:
            period_pairs.add((start, end))
    if len(period_pairs) != 1:
        return None, None
    return next(iter(period_pairs))


def invoice_lines(invoice: Any) -> list[Any]:
    lines = object_get(invoice, "lines") or {}
    return list(object_get(lines, "data") or [])


def single_invoice_line(invoice: Any) -> Optional[Any]:
    lines = invoice_lines(invoice)
    return lines[0] if len(lines) == 1 else None


def subscription_period_bounds(subscription: dict[str, Any]) -> tuple[Optional[Any], Optional[Any]]:
    start = subscription.get("current_period_start")
    end = subscription.get("current_period_end")
    if start and end:
        return start, end
    item_starts: list[Any] = []
    item_ends: list[Any] = []
    for item in ((subscription.get("items") or {}).get("data") or []):
        item_start = item.get("current_period_start")
        item_end = item.get("current_period_end")
        if item_start:
            item_starts.append(item_start)
        if item_end:
            item_ends.append(item_end)
    return (start or (min(item_starts) if item_starts else None), end or (max(item_ends) if item_ends else None))


def local_invoice_status(stripe_status: str) -> str:
    if stripe_status == "void":
        return "void"
    if stripe_status == "uncollectible":
        return "uncollectible"
    if stripe_status in {"draft", "open", "paid"}:
        return stripe_status
    return "open"


_to_text = to_text
_stripe_id = stripe_id
_object_get = object_get
