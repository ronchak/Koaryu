import uuid
from datetime import date, datetime, time, timedelta, timezone
from typing import Any, Optional

from postgrest.exceptions import APIError as PostgrestAPIError
from supabase import Client

from app.schemas.demo import DemoResetCounts
from app.services.demo_seed_common import (
    DEMO_STUDIO_NAME,
    OPTIONAL_SCHEMA_ERROR_CODES,
    demo_seed_id,
)
from app.services.supabase_rpc import execute_required_rpc


class DemoDataAccess:
    def __init__(self, supabase: Client):
        self.supabase = supabase

    def id_for(self, studio_id: str, key: str) -> str:
        return demo_seed_id(studio_id, key)

    def today(self) -> date:
        return date.today()

    def date_for(self, days_from_today: int) -> str:
        return (self.today() + timedelta(days=days_from_today)).isoformat()

    def timestamp_for(self, days_from_today: int = 0, hour: int = 9, minute: int = 0) -> str:
        value = datetime.combine(
            self.today() + timedelta(days=days_from_today),
            time(hour=hour, minute=minute),
            tzinfo=timezone.utc,
        )
        return value.isoformat()

    def weekday_for(self, days_from_today: int = 0) -> int:
        # Python: Monday=0 ... Sunday=6. Koaryu schema: Sunday=0 ... Saturday=6.
        return ((self.today() + timedelta(days=days_from_today)).weekday() + 1) % 7

    def count_by_studio(self, table: str, studio_id: str) -> int:
        result = self.supabase.table(table).select("id").eq("studio_id", studio_id).execute()
        return len(result.data or [])

    def insert(self, table: str, rows: list[dict[str, Any]]) -> None:
        if rows:
            self.supabase.table(table).insert(rows).execute()

    def insert_optional(self, table: str, rows: list[dict[str, Any]]) -> None:
        if not rows:
            return
        try:
            self.insert(table, rows)
        except PostgrestAPIError as exc:
            if exc.code not in OPTIONAL_SCHEMA_ERROR_CODES:
                raise

    def clear_counts(self, studio_id: str) -> DemoResetCounts:
        return DemoResetCounts(
            students=self.count_by_studio("students", studio_id),
            leads=self.count_by_studio("leads", studio_id),
            belt_ranks=self.count_by_studio("belt_ranks", studio_id),
            class_sessions=self.count_by_studio("class_sessions", studio_id),
            attendance_records=self.count_by_studio("attendance", studio_id),
        )

    def studio_name(self, studio_id: str) -> str:
        result = self.supabase.table("studios").select("name").eq("id", studio_id).maybe_single().execute()
        return (result.data or {}).get("name") or "My Studio"

    def clear_demo_surface(self, studio_id: str) -> None:
        self.clear_studio_surface(studio_id, include_platform_rows=False)

    def clear_studio_surface(self, studio_id: str, *, include_platform_rows: bool) -> None:
        execute_required_rpc(self.supabase, "clear_studio_operational_data_atomic", {
            "p_studio_id": studio_id,
            "p_include_platform_rows": include_platform_rows,
        })

    def update_studio_for_demo(self, studio_id: str) -> None:
        self.supabase.table("studios").update(
            {
                "name": DEMO_STUDIO_NAME,
                "timezone": "America/New_York",
            }
        ).eq("id", studio_id).execute()

    def write_reset_audit(self, studio_id: str, actor_id: str) -> None:
        self.insert(
            "audit_logs",
            [
                {
                    "id": str(uuid.uuid4()),
                    "studio_id": studio_id,
                    "actor_id": actor_id,
                    "action": "demo.reset",
                    "entity_type": "studio",
                    "entity_id": studio_id,
                    "metadata": {"studio_name": DEMO_STUDIO_NAME},
                    "created_at": self.timestamp_for(),
                }
            ],
        )

    def write_reset_failure_audit(
        self,
        studio_id: str,
        actor_id: str,
        *,
        phase: str,
        error: Exception,
        cleanup_succeeded: bool,
        cleanup_error: Optional[Exception] = None,
    ) -> None:
        self.insert(
            "audit_logs",
            [
                {
                    "id": str(uuid.uuid4()),
                    "studio_id": studio_id,
                    "actor_id": actor_id,
                    "action": "demo.reset_failed",
                    "entity_type": "studio",
                    "entity_id": studio_id,
                    "metadata": {
                        "studio_name": DEMO_STUDIO_NAME,
                        "phase": phase,
                        "error_type": error.__class__.__name__,
                        "cleanup_succeeded": cleanup_succeeded,
                        "cleanup_error_type": cleanup_error.__class__.__name__ if cleanup_error else None,
                    },
                    "created_at": self.timestamp_for(),
                }
            ],
        )
