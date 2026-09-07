"""Bounded live pagination, not a transactional snapshot of the collection."""
import time
from fastapi import HTTPException

LEAD_READ_PAGE_SIZE = 500
MAX_LEAD_READ_ROWS = 10_000


def fetch_lead_rows(client, studio_id, stage=None, source=None):
    rows = []
    cursor = None
    total = None
    deadline = time.monotonic() + 25.0
    while len(rows) <= MAX_LEAD_READ_ROWS:
        if time.monotonic() >= deadline:
            raise HTTPException(504, "Lead loading timed out. Please retry.")
        query = client.table("leads")
        query = query.select("*", count="exact") if total is None else query.select("*")
        query = query.eq("studio_id", studio_id).order("id").limit(LEAD_READ_PAGE_SIZE)
        if stage:
            query = query.eq("stage", stage)
        if source:
            query = query.eq("source", source)
        if cursor:
            query = query.gt("id", cursor)
        response = query.execute()
        if total is None:
            total = response.count
            if not isinstance(total, int) or total < 0:
                raise RuntimeError("Lead completeness could not be verified")
            if total > MAX_LEAD_READ_ROWS:
                raise HTTPException(422, "Too many leads to load at once. Narrow the stage or source filter.")
        page = response.data or []
        if not isinstance(page, list) or len(rows) + len(page) > MAX_LEAD_READ_ROWS:
            raise RuntimeError("Lead read exceeded its row budget")
        if page and (not page[-1].get("id") or page[-1]["id"] == cursor):
            raise RuntimeError("Lead cursor did not advance")
        rows.extend(page)
        if len(rows) == total:
            return sorted(rows, key=lambda row: (row["created_at"], row["id"]), reverse=True)
        if not page or len(rows) > total:
            raise HTTPException(409, "Lead collection size changed while loading. Please retry.")
        cursor = page[-1]["id"]
    raise HTTPException(409, "Leads changed while loading. Please retry.")
