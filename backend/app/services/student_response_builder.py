from __future__ import annotations

from typing import Any, Optional

from postgrest.exceptions import APIError as PostgrestAPIError

from app.schemas.student import (
    GuardianResponse,
    StudentProgramMembershipResponse,
    StudentResponse,
)
from app.services.student_photo_store import StudentPhotoStore
from app.services.student_program_memberships import is_optional_student_membership_schema_error

PHOTO_URL_UNSET = object()


class StudentResponseBuilder:
    def __init__(self, supabase: Any, photo_store: StudentPhotoStore):
        self.supabase = supabase
        self.photo_store = photo_store

    def guardian_row_to_response(self, guardian_row: dict) -> GuardianResponse:
        return GuardianResponse(**{
            "id": guardian_row["id"],
            "first_name": guardian_row["first_name"],
            "last_name": guardian_row["last_name"],
            "email": guardian_row.get("email"),
            "phone": guardian_row.get("phone"),
            "relation": guardian_row.get("relation"),
            "is_primary_contact": guardian_row.get("is_primary_contact", False),
        })

    def guardian_from_link_row(self, row: dict) -> Optional[GuardianResponse]:
        if not isinstance(row, dict):
            return None
        guardian = row.get("guardians") or {}
        if not guardian:
            return None
        return self.guardian_row_to_response(guardian)

    def fetch_guardians_for_students(
        self,
        student_ids: list[str],
        student_studio_ids: Optional[dict[str, str]] = None,
    ) -> dict[str, list[GuardianResponse]]:
        ordered_student_ids = list(dict.fromkeys(student_ids))
        guardians_by_student_id: dict[str, list[GuardianResponse]] = {
            student_id: []
            for student_id in ordered_student_ids
        }
        if not ordered_student_ids:
            return guardians_by_student_id

        result = (
            self.supabase.table("student_guardians")
            .select("student_id, guardian_id, guardians(*)")
            .in_("student_id", ordered_student_ids)
            .execute()
        )
        for row in result.data or []:
            student_id = row.get("student_id")
            if student_id not in guardians_by_student_id:
                continue
            expected_studio_id = (student_studio_ids or {}).get(student_id)
            guardian_row = row.get("guardians") or {}
            if expected_studio_id and guardian_row.get("studio_id") != expected_studio_id:
                continue
            guardian = self.guardian_from_link_row(row)
            if guardian:
                guardians_by_student_id[student_id].append(guardian)

        return guardians_by_student_id

    def fetch_guardians_for_student(self, student_id: str, studio_id: Optional[str] = None) -> list[GuardianResponse]:
        studio_map = {student_id: studio_id} if studio_id else None
        return self.fetch_guardians_for_students([student_id], studio_map).get(student_id, [])

    def membership_row_to_response(self, row: dict) -> StudentProgramMembershipResponse:
        program = row.get("programs") or {}
        rank = row.get("belt_ranks") or {}
        if isinstance(program, list):
            program = program[0] if program else {}
        if isinstance(rank, list):
            rank = rank[0] if rank else {}
        return StudentProgramMembershipResponse(
            id=row["id"],
            studio_id=row["studio_id"],
            student_id=row["student_id"],
            program_id=row["program_id"],
            program_name=program.get("name"),
            program_color_hex=program.get("color_hex"),
            status=row.get("status") or "active",
            started_at=row.get("started_at"),
            ended_at=row.get("ended_at"),
            current_belt_rank_id=row.get("current_belt_rank_id"),
            current_belt_rank_name=rank.get("name"),
            current_belt_rank_color=rank.get("color_hex"),
            created_at=row["created_at"],
            updated_at=row.get("updated_at") or row["created_at"],
        )

    def fetch_memberships_for_students(
        self,
        student_ids: list[str],
        student_studio_ids: Optional[dict[str, str]] = None,
    ) -> dict[str, list[StudentProgramMembershipResponse]]:
        ordered_student_ids = list(dict.fromkeys(student_ids))
        memberships_by_student_id: dict[str, list[StudentProgramMembershipResponse]] = {
            student_id: []
            for student_id in ordered_student_ids
        }
        if not ordered_student_ids:
            return memberships_by_student_id

        try:
            query = (
                self.supabase.table("student_program_memberships")
                .select("*, programs(name, color_hex), belt_ranks(name, color_hex)")
                .in_("student_id", ordered_student_ids)
                .order("created_at")
            )
            expected_studios = set((student_studio_ids or {}).values())
            if len(expected_studios) == 1:
                query = query.eq("studio_id", next(iter(expected_studios)))
            result = query.execute()
        except PostgrestAPIError as exc:
            if not is_optional_student_membership_schema_error(exc):
                raise
            return memberships_by_student_id

        for row in result.data or []:
            student_id = row.get("student_id")
            if student_id not in memberships_by_student_id:
                continue
            expected_studio_id = (student_studio_ids or {}).get(student_id)
            if expected_studio_id and row.get("studio_id") != expected_studio_id:
                continue
            memberships_by_student_id[student_id].append(self.membership_row_to_response(row))

        return memberships_by_student_id

    def fetch_memberships_for_student(self, student_id: str, studio_id: Optional[str] = None) -> list[StudentProgramMembershipResponse]:
        studio_map = {student_id: studio_id} if studio_id else None
        return self.fetch_memberships_for_students([student_id], studio_map).get(student_id, [])

    def embedded_guardians_from_row(self, row: dict) -> Optional[list[GuardianResponse]]:
        if "student_guardians" not in row:
            return None

        link_rows = row.get("student_guardians") or []
        if isinstance(link_rows, dict):
            link_rows = [link_rows]

        guardians = []
        for link_row in link_rows:
            guardian = self.guardian_from_link_row(link_row)
            if guardian:
                guardians.append(guardian)
        return guardians

    def rows_to_responses(
        self,
        rows: list[dict],
        *,
        include_guardians: bool = True,
        include_photo_urls: bool = True,
    ) -> list[StudentResponse]:
        student_ids = [
            row["id"]
            for row in rows
            if row.get("id")
        ]
        student_studio_ids = {
            row["id"]: row["studio_id"]
            for row in rows
            if row.get("id") and row.get("studio_id")
        }
        guardians_by_student_id = (
            self.fetch_guardians_for_students([*student_ids], student_studio_ids)
            if include_guardians
            else {student_id: [] for student_id in student_ids}
        )
        memberships_by_student_id = self.fetch_memberships_for_students(student_ids, student_studio_ids)
        photo_urls_by_path = (
            self.photo_store.create_signed_urls([
                row["photo_path"]
                for row in rows
                if row.get("photo_path")
            ])
            if include_photo_urls
            else {}
        )
        return [
            self.row_to_response(
                row,
                guardians=guardians_by_student_id.get(row.get("id"), []),
                memberships=memberships_by_student_id.get(row.get("id"), []),
                photo_url=photo_urls_by_path.get(row.get("photo_path")) if include_photo_urls else None,
            )
            for row in rows
        ]

    def row_to_response(
        self,
        row: dict,
        guardians: Optional[list[GuardianResponse]] = None,
        memberships: Optional[list[StudentProgramMembershipResponse]] = None,
        photo_url: Any = PHOTO_URL_UNSET,
    ) -> StudentResponse:
        if guardians is None:
            guardians = self.embedded_guardians_from_row(row)
        if guardians is None:
            guardians = self.fetch_guardians_for_student(row["id"], row.get("studio_id"))
        if memberships is None:
            memberships = self.fetch_memberships_for_student(row["id"], row.get("studio_id"))
        if photo_url is PHOTO_URL_UNSET:
            photo_path = row.get("photo_path")
            if not photo_path and not self.photo_store.columns_available():
                photo_path = self.photo_store.find_stored_path(row)
                if photo_path:
                    row = {**row, "photo_path": photo_path}
            photo_url = self.photo_store.create_signed_url(photo_path)

        normalized_row = {
            **{
                k: v
                for k, v in row.items()
                if k not in ("deleted_at", "student_guardians")
            },
            "tags": row.get("tags") or [],
            "photo_url": photo_url,
        }
        return StudentResponse(
            **normalized_row,
            guardians=guardians,
            program_memberships=memberships,
        )
