from supabase import Client
from fastapi import HTTPException
from postgrest.exceptions import APIError as PostgrestAPIError

from app.schemas.student import BulkStatusUpdate, BulkTagUpdate, BulkStudentArchiveRequest
from app.services.supabase_rpc import execute_required_rpc


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
        tags_to_add = list(dict.fromkeys(tag.strip() for tag in data.tags_to_add if tag.strip()))
        tags_to_remove = sorted({tag.strip() for tag in data.tags_to_remove if tag.strip()})
        result = self._mutate({
            "p_studio_id": studio_id, "p_actor_id": actor_id,
            "p_student_ids": student_ids, "p_operation": "tags",
            "p_tags_to_add": tags_to_add, "p_tags_to_remove": tags_to_remove,
            "p_status": None,
        })
        return int(result.data or 0)

    async def update_status(
        self,
        data: BulkStatusUpdate,
        studio_id: str,
        actor_id: str,
    ) -> int:
        student_ids = list(dict.fromkeys(data.student_ids))
        result = self._mutate({
            "p_studio_id": studio_id,
            "p_actor_id": actor_id,
            "p_student_ids": student_ids,
            "p_operation": "status",
            "p_tags_to_add": [],
            "p_tags_to_remove": [],
            "p_status": data.status,
        })
        return int(result.data or 0)

    async def archive_students(
        self,
        data: BulkStudentArchiveRequest,
        studio_id: str,
        actor_id: str,
    ) -> int:
        student_ids = list(dict.fromkeys(str(student_id) for student_id in data.student_ids))
        try:
            result = execute_required_rpc(
                self.supabase,
                "archive_students_bulk_atomic",
                {
                    "p_studio_id": studio_id,
                    "p_actor_id": actor_id,
                    "p_student_ids": student_ids,
                },
            )
        except PostgrestAPIError as exc:
            if getattr(exc, "code", None) == "P0002":
                raise HTTPException(status_code=404, detail="One or more students were not found") from exc
            if getattr(exc, "code", None) == "42501":
                raise HTTPException(
                    status_code=403,
                    detail="Bulk student archive requires a roster manager role.",
                ) from exc
            raise
        return int(result.data or 0)

    def _mutate(self, payload: dict):
        try:
            return execute_required_rpc(self.supabase, "mutate_students_bulk_atomic", payload)
        except PostgrestAPIError as exc:
            if getattr(exc, "code", None) == "P0002":
                raise HTTPException(status_code=404, detail="One or more students were not found") from exc
            raise
