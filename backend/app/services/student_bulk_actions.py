from supabase import Client

from app.schemas.student import BulkStatusUpdate, BulkTagUpdate
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
        result = execute_required_rpc(self.supabase, "mutate_students_bulk_atomic", {
            "p_studio_id": studio_id,
            "p_actor_id": actor_id,
            "p_student_ids": student_ids,
            "p_operation": "tags",
            "p_tags_to_add": tags_to_add,
            "p_tags_to_remove": tags_to_remove,
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
        result = execute_required_rpc(self.supabase, "mutate_students_bulk_atomic", {
            "p_studio_id": studio_id,
            "p_actor_id": actor_id,
            "p_student_ids": student_ids,
            "p_operation": "status",
            "p_tags_to_add": [],
            "p_tags_to_remove": [],
            "p_status": data.status,
        })
        return int(result.data or 0)
