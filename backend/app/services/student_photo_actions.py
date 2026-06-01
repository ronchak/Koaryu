from datetime import datetime, timezone

from fastapi import HTTPException, UploadFile
from supabase import Client

from app.schemas.student import StudentResponse
from app.services.student_photo_store import StudentPhotoStore
from app.services.student_response_builder import StudentResponseBuilder


class StudentPhotoActions:
    def __init__(
        self,
        supabase: Client,
        photo_store: StudentPhotoStore,
        response_builder: StudentResponseBuilder,
    ):
        self.supabase = supabase
        self.photo_store = photo_store
        self.response_builder = response_builder

    def _fetch_student_row_for_studio(self, student_id: str, studio_id: str) -> dict:
        result = (
            self.supabase.table("students")
            .select("*")
            .eq("id", student_id)
            .eq("studio_id", studio_id)
            .is_("deleted_at", "null")
            .maybe_single()
            .execute()
        )
        if not result or not result.data:
            raise HTTPException(status_code=404, detail="Student not found")
        return result.data

    async def upload(
        self,
        student_id: str,
        studio_id: str,
        actor_id: str,
        file: UploadFile,
    ) -> StudentResponse:
        student = self._fetch_student_row_for_studio(student_id, studio_id)
        content, content_type, extension = await self.photo_store.read_validated_file(file)
        photo_path = self.photo_store.path_for(student, extension)
        previous_photo_path = student.get("photo_path")

        self.photo_store.upload(photo_path, content, content_type)

        update_payload = {
            "photo_path": photo_path,
            "photo_updated_at": datetime.now(timezone.utc).isoformat(),
        }
        if not self.photo_store.columns_available():
            self._write_audit_log(
                studio_id,
                actor_id,
                "student.photo_uploaded",
                student_id,
                {
                    "photo_path": photo_path,
                    "content_type": content_type,
                    "size_bytes": len(content),
                    "metadata_persisted": False,
                },
            )
            return self.response_builder.row_to_response(
                {**student, **update_payload},
                photo_url=self.photo_store.create_signed_url(photo_path),
            )

        result = (
            self.supabase.table("students")
            .update(update_payload)
            .eq("id", student_id)
            .eq("studio_id", studio_id)
            .is_("deleted_at", "null")
            .execute()
        )
        if not result.data:
            if photo_path != previous_photo_path:
                self.photo_store.remove([photo_path], raise_on_failure=False)
            raise HTTPException(status_code=404, detail="Student not found")

        if previous_photo_path and previous_photo_path != photo_path:
            self.photo_store.remove([previous_photo_path], raise_on_failure=False)

        self._write_audit_log(
            studio_id,
            actor_id,
            "student.photo_uploaded",
            student_id,
            {
                "photo_path": photo_path,
                "content_type": content_type,
                "size_bytes": len(content),
            },
        )
        return self.response_builder.row_to_response(result.data[0])

    async def delete(
        self,
        student_id: str,
        studio_id: str,
        actor_id: str,
    ) -> StudentResponse:
        student = self._fetch_student_row_for_studio(student_id, studio_id)
        previous_photo_path = student.get("photo_path")
        if not previous_photo_path and not self.photo_store.columns_available():
            previous_photo_path = self.photo_store.path_for(student, "webp")
        if previous_photo_path:
            self.photo_store.remove([previous_photo_path])

        if not self.photo_store.columns_available():
            self._write_audit_log(
                studio_id,
                actor_id,
                "student.photo_deleted",
                student_id,
                {
                    "photo_path": previous_photo_path,
                    "metadata_persisted": False,
                },
            )
            return self.response_builder.row_to_response(
                {
                    **student,
                    "photo_path": None,
                    "photo_updated_at": None,
                },
                photo_url=None,
            )

        result = (
            self.supabase.table("students")
            .update({
                "photo_path": None,
                "photo_updated_at": None,
            })
            .eq("id", student_id)
            .eq("studio_id", studio_id)
            .is_("deleted_at", "null")
            .execute()
        )
        if not result.data:
            raise HTTPException(status_code=404, detail="Student not found")

        self._write_audit_log(
            studio_id,
            actor_id,
            "student.photo_deleted",
            student_id,
            {"photo_path": previous_photo_path},
        )
        return self.response_builder.row_to_response(result.data[0], photo_url=None)

    def _write_audit_log(
        self,
        studio_id: str,
        actor_id: str,
        action: str,
        student_id: str,
        metadata: dict,
    ) -> None:
        self.supabase.table("audit_logs").insert({
            "studio_id": studio_id,
            "actor_id": actor_id,
            "action": action,
            "entity_type": "student",
            "entity_id": student_id,
            "metadata": metadata,
        }).execute()
