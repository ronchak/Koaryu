from fastapi import HTTPException
from supabase import Client

from app.schemas.student import BulkStatusUpdate, BulkTagUpdate, STUDENT_STATUSES


class StudentBulkActions:
    def __init__(self, supabase: Client):
        self.supabase = supabase

    async def update_tags(
        self,
        data: BulkTagUpdate,
        studio_id: str,
        actor_id: str,
    ) -> int:
        student_ids = list(dict.fromkeys(data.student_ids))
        existing_by_id = self._fetch_students_by_id(student_ids, studio_id, "id, tags")
        self._ensure_all_students_available(student_ids, existing_by_id)

        tags_to_add = list(dict.fromkeys(tag.strip() for tag in data.tags_to_add if tag.strip()))
        tags_to_remove = {tag.strip() for tag in data.tags_to_remove if tag.strip()}
        audit_logs = []

        for student_id in student_ids:
            current_tags: list[str] = existing_by_id[student_id].get("tags") or []
            next_tags = [tag for tag in current_tags if tag not in tags_to_remove]
            for tag in tags_to_add:
                if tag not in next_tags:
                    next_tags.append(tag)

            result = (
                self.supabase.table("students")
                .update({"tags": next_tags})
                .eq("id", student_id)
                .eq("studio_id", studio_id)
                .is_("deleted_at", "null")
                .execute()
            )
            if not result.data:
                raise HTTPException(
                    status_code=409,
                    detail="One or more selected students changed during the bulk update",
                )

            audit_logs.append({
                "studio_id": studio_id,
                "actor_id": actor_id,
                "action": "student.tags.bulk_updated",
                "entity_type": "student",
                "entity_id": student_id,
                "metadata": {
                    "tags_to_add": tags_to_add,
                    "tags_to_remove": sorted(tags_to_remove),
                    "resulting_tags": next_tags,
                },
            })

        if audit_logs:
            self.supabase.table("audit_logs").insert(audit_logs).execute()
        return len(student_ids)

    async def update_status(
        self,
        data: BulkStatusUpdate,
        studio_id: str,
        actor_id: str,
    ) -> int:
        if data.status not in STUDENT_STATUSES:
            raise HTTPException(status_code=400, detail=f"Invalid status: {data.status}")

        student_ids = list(dict.fromkeys(data.student_ids))
        existing_by_id = self._fetch_students_by_id(student_ids, studio_id, "id, status")
        self._ensure_all_students_available(student_ids, existing_by_id)

        result = (
            self.supabase.table("students")
            .update({"status": data.status})
            .in_("id", student_ids)
            .eq("studio_id", studio_id)
            .is_("deleted_at", "null")
            .execute()
        )
        if len(result.data or []) != len(student_ids):
            raise HTTPException(
                status_code=409,
                detail="One or more selected students changed during the bulk update",
            )

        audit_logs = [
            {
                "studio_id": studio_id,
                "actor_id": actor_id,
                "action": "student.status.bulk_updated",
                "entity_type": "student",
                "entity_id": student_id,
                "metadata": {
                    "previous_status": existing_by_id[student_id].get("status"),
                    "new_status": data.status,
                },
            }
            for student_id in student_ids
        ]
        if audit_logs:
            self.supabase.table("audit_logs").insert(audit_logs).execute()
        return len(student_ids)

    def _fetch_students_by_id(
        self,
        student_ids: list[str],
        studio_id: str,
        columns: str,
    ) -> dict[str, dict]:
        result = (
            self.supabase.table("students")
            .select(columns)
            .in_("id", student_ids)
            .eq("studio_id", studio_id)
            .is_("deleted_at", "null")
            .execute()
        )
        return {row["id"]: row for row in (result.data or [])}

    def _ensure_all_students_available(
        self,
        student_ids: list[str],
        existing_by_id: dict[str, dict],
    ) -> None:
        missing_ids = [student_id for student_id in student_ids if student_id not in existing_by_id]
        if missing_ids:
            raise HTTPException(
                status_code=404,
                detail="One or more selected students are no longer available",
            )
