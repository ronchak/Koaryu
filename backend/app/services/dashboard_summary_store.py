from __future__ import annotations

from typing import Any, Callable, Optional


class DashboardSummaryStore:
    def __init__(self, supabase: Any):
        self.supabase = supabase

    def count_rows(
        self,
        table: str,
        apply_filters: Callable[[Any], Any],
    ) -> int:
        query = self.supabase.table(table).select("id", count="exact")
        query = apply_filters(query)
        result = query.limit(0).execute()
        return int(result.count or 0)

    def fetch_rows(
        self,
        table: str,
        columns: str,
        apply_filters: Callable[[Any], Any],
        *,
        page_size: int = 1000,
    ) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        offset = 0

        while True:
            query = self.supabase.table(table).select(columns)
            query = apply_filters(query).order("id").range(offset, offset + page_size - 1)
            result = query.execute()
            batch = result.data or []
            rows.extend(batch)
            if len(batch) < page_size:
                return rows
            offset += page_size

    def fetch_one(
        self,
        table: str,
        columns: str,
        apply_filters: Callable[[Any], Any],
    ) -> Optional[dict[str, Any]]:
        result = apply_filters(
            self.supabase.table(table).select(columns)
        ).maybe_single().execute()
        if result is None:
            return None
        return result.data or None

    def fetch_studio_summary(self, studio_id: str) -> dict[str, Any]:
        result = (
            self.supabase.table("studios")
            .select("id, name, slug, timezone, logo_url")
            .eq("id", studio_id)
            .single()
            .execute()
        )
        return result.data
