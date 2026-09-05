"""Bounded stable invoice and payment history pages; totals are separate RPC reads."""
import base64
import json
from datetime import datetime
from typing import Literal
from uuid import UUID

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, ValidationError

from app.schemas.billing import BillingInvoicePageResponse, BillingPaymentPageResponse


class _BillingCursor(BaseModel):
    model_config = ConfigDict(extra="forbid")
    studio_id: str
    dataset: Literal["invoices", "payments"]
    created_at: datetime
    id: UUID


def get_billing_page(
    client,
    studio_id: str,
    dataset: Literal["invoices", "payments"],
    cursor: str | None,
    limit: int,
) -> BillingInvoicePageResponse | BillingPaymentPageResponse:
    if not 1 <= limit <= 100:
        raise HTTPException(400, "Billing page size must be between 1 and 100.")
    query = client.table(f"billing_{dataset}").select("*").eq("studio_id", studio_id)
    if cursor:
        try:
            anchor = _BillingCursor.model_validate_json(base64.urlsafe_b64decode(cursor))
            if (
                anchor.studio_id != studio_id
                or anchor.dataset != dataset
                or anchor.created_at.tzinfo is None
            ):
                raise ValueError("Cursor scope mismatch")
        except (ValueError, ValidationError) as exc:
            raise HTTPException(400, "Invalid billing page cursor.") from exc
        stamp = anchor.created_at.isoformat()
        query = query.or_(f"created_at.lt.{stamp},and(created_at.eq.{stamp},id.lt.{anchor.id})")
    rows = query.order("created_at", desc=True).order("id", desc=True).limit(limit + 1).execute().data or []
    complete = len(rows) <= limit
    items = rows[:limit]
    next_cursor = None
    if not complete:
        last = items[-1]
        next_cursor = base64.urlsafe_b64encode(json.dumps({
            "studio_id": studio_id,
            "dataset": dataset,
            "created_at": last["created_at"],
            "id": last["id"],
        }).encode()).decode()
    response = BillingInvoicePageResponse if dataset == "invoices" else BillingPaymentPageResponse
    return response(items=items, next_cursor=next_cursor, complete=complete)
