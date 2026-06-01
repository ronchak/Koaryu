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

    def delete_by_studio(self, table: str, studio_id: str) -> None:
        self.supabase.table(table).delete().eq("studio_id", studio_id).execute()

    def delete_optional_by_studio(self, table: str, studio_id: str) -> None:
        try:
            self.delete_by_studio(table, studio_id)
        except PostgrestAPIError as exc:
            if exc.code not in OPTIONAL_SCHEMA_ERROR_CODES:
                raise

    def fetch_ids(self, table: str, studio_id: str) -> list[str]:
        result = self.supabase.table(table).select("id").eq("studio_id", studio_id).execute()
        return [row["id"] for row in (result.data or []) if row.get("id")]

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
        student_ids = self.fetch_ids("students", studio_id)
        guardian_ids = self.fetch_ids("guardians", studio_id)

        for table in [
            "billing_disputes",
            "billing_refunds",
            "billing_payments",
            "billing_invoice_items",
            "billing_invoices",
            "student_billing_enrollments",
            "billing_subscriptions",
            "billing_plan_programs",
            "billing_plan_prices",
            "billing_plans",
            "billing_payers",
            "email_usage_events",
            "export_jobs",
        ]:
            self.delete_optional_by_studio(table, studio_id)

        if include_platform_rows:
            for table in ["studio_payment_accounts", "studio_subscriptions"]:
                self.delete_optional_by_studio(table, studio_id)

        self.delete_by_studio("attendance", studio_id)
        self.delete_by_studio("promotions", studio_id)
        self.delete_optional_by_studio("student_program_memberships", studio_id)
        self.delete_by_studio("lead_activities", studio_id)
        self.delete_by_studio("student_import_runs", studio_id)
        self.delete_by_studio("leads", studio_id)

        if student_ids:
            self.supabase.table("student_guardians").delete().in_("student_id", student_ids).execute()
        if guardian_ids:
            self.supabase.table("student_guardians").delete().in_("guardian_id", guardian_ids).execute()

        self.delete_by_studio("class_sessions", studio_id)
        self.delete_by_studio("class_templates", studio_id)
        self.delete_by_studio("students", studio_id)
        self.delete_by_studio("guardians", studio_id)
        self.delete_by_studio("belt_ranks", studio_id)
        self.delete_by_studio("belt_ladders", studio_id)
        self.delete_by_studio("programs", studio_id)

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
