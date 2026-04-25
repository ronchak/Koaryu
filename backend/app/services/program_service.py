from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import HTTPException, status
from postgrest.exceptions import APIError as PostgrestAPIError
from supabase import Client

from app.schemas.program import (
    ProgramCreate,
    ProgramResponse,
    ProgramUpdate,
    ProgramUsageResponse,
)


PROGRAM_SELECT = (
    "id, studio_id, name, description, color_hex, sort_order, is_system, "
    "archived_at, created_at, updated_at"
)
PROGRAM_BASE_SELECT = "id, studio_id, name, description, created_at"
OPTIONAL_PROGRAM_SCHEMA_ERROR_CODES = {"42P01", "42703", "PGRST204", "PGRST205"}


def _normalize_name(value: str) -> str:
    return " ".join(value.strip().split()).lower()


def _is_optional_program_schema_error(exc: PostgrestAPIError) -> bool:
    return exc.code in OPTIONAL_PROGRAM_SCHEMA_ERROR_CODES


def _program_error(status_code: int, code: str, message: str, **details: Any) -> HTTPException:
    return HTTPException(
        status_code=status_code,
        detail={
            "code": code,
            "message": message,
            "details": details,
        },
    )


class ProgramService:
    def __init__(self, supabase: Client):
        self.supabase = supabase

    def ensure_program_ladders(self, studio_id: str) -> None:
        """Keep the product invariant: one user-facing program owns one ladder."""
        try:
            self._attach_unscoped_ladders_to_programs(studio_id)
            self._create_missing_ladders_for_active_programs(studio_id)
        except PostgrestAPIError as exc:
            if not _is_optional_program_schema_error(exc):
                raise

    async def list_programs(
        self,
        studio_id: str,
        include_archived: bool = False,
    ) -> list[ProgramResponse]:
        self.ensure_program_ladders(studio_id)
        query = (
            self.supabase.table("programs")
            .select(PROGRAM_SELECT)
            .eq("studio_id", studio_id)
            .order("sort_order")
            .order("name")
        )
        if not include_archived:
            query = query.is_("archived_at", "null")

        try:
            result = query.execute()
        except PostgrestAPIError as exc:
            if not _is_optional_program_schema_error(exc):
                raise
            fallback = (
                self.supabase.table("programs")
                .select(PROGRAM_BASE_SELECT)
                .eq("studio_id", studio_id)
                .order("name")
                .execute()
            )
            rows = fallback.data or []
            usage_by_program_id = self._usage_for_programs(
                studio_id,
                [row["id"] for row in rows if row.get("id")],
            )
            return [
                self._row_to_response(row, usage_by_program_id.get(row.get("id")))
                for row in rows
            ]

        usage_by_program_id = self._usage_for_programs(
            studio_id,
            [row["id"] for row in (result.data or []) if row.get("id")],
        )
        return [
            self._row_to_response(row, usage_by_program_id.get(row.get("id")))
            for row in (result.data or [])
        ]

    async def get_program(
        self,
        program_id: str,
        studio_id: str,
    ) -> ProgramResponse:
        row = self._get_program_row_or_404(program_id, studio_id)
        return self._row_to_response(row, self._usage_for_program(program_id, studio_id))

    async def create_program(
        self,
        data: ProgramCreate,
        studio_id: str,
        actor_id: str,
    ) -> ProgramResponse:
        name = " ".join(data.name.strip().split())
        if not name:
            raise _program_error(
                status.HTTP_400_BAD_REQUEST,
                "PROGRAM_NAME_REQUIRED",
                "Program name is required.",
            )
        self._ensure_name_available(studio_id, name)

        row = data.model_dump()
        row["name"] = name
        row["studio_id"] = studio_id
        try:
            result = self.supabase.table("programs").insert(row).execute()
        except PostgrestAPIError as exc:
            if exc.code == "23505":
                raise _program_error(
                    status.HTTP_409_CONFLICT,
                    "PROGRAM_NAME_CONFLICT",
                    "A program with this name already exists.",
                    name=name,
                ) from exc
            if _is_optional_program_schema_error(exc):
                base_row = {
                    "studio_id": studio_id,
                    "name": name,
                    "description": data.description,
                }
                try:
                    result = self.supabase.table("programs").insert(base_row).execute()
                except PostgrestAPIError as retry_exc:
                    if retry_exc.code == "23505":
                        raise _program_error(
                            status.HTTP_409_CONFLICT,
                            "PROGRAM_NAME_CONFLICT",
                            "A program with this name already exists.",
                            name=name,
                        ) from retry_exc
                    raise
            else:
                raise
        if not result.data:
            raise HTTPException(status_code=500, detail="Failed to create program")

        program_row = result.data[0]
        self._ensure_ladder_for_program_row(program_row, actor_id)

        self._audit(
            studio_id,
            actor_id,
            "program.created",
            program_row["id"],
            {"name": name},
        )
        return self._row_to_response(program_row, self._usage_for_program(program_row["id"], studio_id))

    async def update_program(
        self,
        program_id: str,
        data: ProgramUpdate,
        studio_id: str,
        actor_id: str,
    ) -> ProgramResponse:
        current = self._get_program_row_or_404(program_id, studio_id)
        update_dict = data.model_dump(exclude_unset=True)
        if not update_dict:
            raise _program_error(
                status.HTTP_400_BAD_REQUEST,
                "PROGRAM_NO_FIELDS",
                "No fields to update.",
            )

        if "name" in update_dict and update_dict["name"] is not None:
            next_name = " ".join(update_dict["name"].strip().split())
            if not next_name:
                raise _program_error(
                    status.HTTP_400_BAD_REQUEST,
                    "PROGRAM_NAME_REQUIRED",
                    "Program name is required.",
                )
            self._ensure_name_available(studio_id, next_name, excluding_program_id=program_id)
            update_dict["name"] = next_name

        try:
            result = (
                self.supabase.table("programs")
                .update(update_dict)
                .eq("id", program_id)
                .eq("studio_id", studio_id)
                .execute()
            )
        except PostgrestAPIError as exc:
            if not _is_optional_program_schema_error(exc):
                raise
            update_dict = {
                key: value
                for key, value in update_dict.items()
                if key in {"name", "description"}
            }
            if not update_dict:
                return self._row_to_response(current, self._usage_for_program(program_id, studio_id))
            result = (
                self.supabase.table("programs")
                .update(update_dict)
                .eq("id", program_id)
                .eq("studio_id", studio_id)
                .execute()
            )
        if not result.data:
            raise _program_error(
                status.HTTP_404_NOT_FOUND,
                "PROGRAM_NOT_FOUND",
                "Program not found.",
                program_id=program_id,
            )

        self._sync_ladder_name_for_program(program_id, studio_id, result.data[0].get("name") or current.get("name") or "")

        self._audit(
            studio_id,
            actor_id,
            "program.updated",
            program_id,
            {
                "previous_name": current.get("name"),
                "changes": update_dict,
            },
        )
        return self._row_to_response(result.data[0], self._usage_for_program(program_id, studio_id))

    async def archive_program(
        self,
        program_id: str,
        studio_id: str,
        actor_id: str,
    ) -> ProgramResponse:
        row = self._get_program_row_or_404(program_id, studio_id)
        if "archived_at" not in row:
            raise _program_error(
                status.HTTP_409_CONFLICT,
                "PROGRAM_ARCHIVE_UNAVAILABLE",
                "Program archiving requires the latest program migration.",
                program_id=program_id,
            )
        if row.get("is_system"):
            raise _program_error(
                status.HTTP_409_CONFLICT,
                "PROGRAM_PROTECTED",
                "The Unassigned program cannot be archived.",
                program_id=program_id,
            )
        if row.get("archived_at"):
            return self._row_to_response(row, self._usage_for_program(program_id, studio_id))

        usage = self._usage_for_program(program_id, studio_id)
        if usage.active_student_count > 0 or usage.active_class_count > 0:
            raise _program_error(
                status.HTTP_409_CONFLICT,
                "PROGRAM_ACTIVE_USAGE",
                "Move active students and active classes before archiving this program.",
                program_id=program_id,
                active_student_count=usage.active_student_count,
                active_class_count=usage.active_class_count,
            )

        archived_at = datetime.now(timezone.utc).isoformat()
        try:
            result = (
                self.supabase.table("programs")
                .update({"archived_at": archived_at})
                .eq("id", program_id)
                .eq("studio_id", studio_id)
                .execute()
            )
        except PostgrestAPIError as exc:
            if not _is_optional_program_schema_error(exc):
                raise
            raise _program_error(
                status.HTTP_409_CONFLICT,
                "PROGRAM_ARCHIVE_UNAVAILABLE",
                "Program archiving requires the latest program migration.",
                program_id=program_id,
            ) from exc
        if not result.data:
            raise _program_error(
                status.HTTP_404_NOT_FOUND,
                "PROGRAM_NOT_FOUND",
                "Program not found.",
                program_id=program_id,
            )

        self._audit(studio_id, actor_id, "program.archived", program_id, {"name": row.get("name")})
        return self._row_to_response(result.data[0], usage)

    async def restore_program(
        self,
        program_id: str,
        studio_id: str,
        actor_id: str,
    ) -> ProgramResponse:
        row = self._get_program_row_or_404(program_id, studio_id)
        if "archived_at" not in row:
            raise _program_error(
                status.HTTP_409_CONFLICT,
                "PROGRAM_ARCHIVE_UNAVAILABLE",
                "Program archiving requires the latest program migration.",
                program_id=program_id,
            )
        self._ensure_name_available(studio_id, row.get("name") or "", excluding_program_id=program_id)
        try:
            result = (
                self.supabase.table("programs")
                .update({"archived_at": None})
                .eq("id", program_id)
                .eq("studio_id", studio_id)
                .execute()
            )
        except PostgrestAPIError as exc:
            if not _is_optional_program_schema_error(exc):
                raise
            raise _program_error(
                status.HTTP_409_CONFLICT,
                "PROGRAM_ARCHIVE_UNAVAILABLE",
                "Program archiving requires the latest program migration.",
                program_id=program_id,
            ) from exc
        if not result.data:
            raise _program_error(
                status.HTTP_404_NOT_FOUND,
                "PROGRAM_NOT_FOUND",
                "Program not found.",
                program_id=program_id,
            )
        self._audit(studio_id, actor_id, "program.restored", program_id, {"name": row.get("name")})
        return self._row_to_response(result.data[0], self._usage_for_program(program_id, studio_id))

    async def get_usage(self, program_id: str, studio_id: str) -> ProgramUsageResponse:
        self._get_program_row_or_404(program_id, studio_id)
        return self._usage_for_program(program_id, studio_id)

    def ensure_program_active(self, studio_id: str, program_id: Optional[str]) -> None:
        if not program_id:
            return
        program = self._get_program_row_or_404(program_id, studio_id)
        if program.get("archived_at"):
            raise _program_error(
                status.HTTP_409_CONFLICT,
                "PROGRAM_INACTIVE",
                "Archived programs cannot be used for new records.",
                program_id=program_id,
            )

    def get_unassigned_program_id(self, studio_id: str) -> str:
        existing = (
            self.supabase.table("programs")
            .select("id")
            .eq("studio_id", studio_id)
            .eq("name", "Unassigned")
            .limit(1)
            .execute()
        )
        if existing.data:
            return existing.data[0]["id"]

        try:
            result = (
                self.supabase.table("programs")
                .insert({
                    "studio_id": studio_id,
                    "name": "Unassigned",
                    "description": "Students awaiting program assignment.",
                    "color_hex": "#94A3B8",
                    "sort_order": 9999,
                    "is_system": True,
                })
                .execute()
            )
        except PostgrestAPIError as exc:
            if not _is_optional_program_schema_error(exc):
                raise
            result = (
                self.supabase.table("programs")
                .insert({
                    "studio_id": studio_id,
                    "name": "Unassigned",
                    "description": "Students awaiting program assignment.",
                })
                .execute()
            )
        if not result.data:
            raise HTTPException(status_code=500, detail="Failed to create Unassigned program")
        return result.data[0]["id"]

    def _fetch_active_program_rows(self, studio_id: str) -> list[dict]:
        try:
            result = (
                self.supabase.table("programs")
                .select(PROGRAM_SELECT)
                .eq("studio_id", studio_id)
                .is_("archived_at", "null")
                .order("sort_order")
                .order("name")
                .execute()
            )
        except PostgrestAPIError as exc:
            if not _is_optional_program_schema_error(exc):
                raise
            result = (
                self.supabase.table("programs")
                .select(PROGRAM_BASE_SELECT)
                .eq("studio_id", studio_id)
                .order("name")
                .execute()
            )
        return result.data or []

    def _insert_program_row(self, row: dict[str, Any]) -> dict:
        try:
            result = self.supabase.table("programs").insert(row).execute()
        except PostgrestAPIError as exc:
            if not _is_optional_program_schema_error(exc):
                raise
            base_row = {
                "studio_id": row["studio_id"],
                "name": row["name"],
                "description": row.get("description"),
            }
            result = self.supabase.table("programs").insert(base_row).execute()
        if not result.data:
            raise HTTPException(status_code=500, detail="Failed to create program")
        return result.data[0]

    def _insert_ladder_for_program(self, program: dict, actor_id: Optional[str] = None) -> dict:
        result = (
            self.supabase.table("belt_ladders")
            .insert({
                "studio_id": program["studio_id"],
                "name": program["name"],
                "program_id": program["id"],
                "sub_rank_term": "Stripe",
            })
            .execute()
        )
        if not result.data:
            raise HTTPException(status_code=500, detail="Failed to create program ladder")
        if actor_id:
            self._audit(
                program["studio_id"],
                actor_id,
                "program_ladder.created",
                program["id"],
                {"ladder_id": result.data[0]["id"], "name": program["name"]},
            )
        return result.data[0]

    def _ensure_ladder_for_program_row(self, program: dict, actor_id: Optional[str] = None) -> Optional[dict]:
        if program.get("archived_at"):
            return None
        existing = (
            self.supabase.table("belt_ladders")
            .select("id, name")
            .eq("studio_id", program["studio_id"])
            .eq("program_id", program["id"])
            .limit(1)
            .execute()
        )
        if existing.data:
            return existing.data[0]
        return self._insert_ladder_for_program(program, actor_id)

    def _attach_unscoped_ladders_to_programs(self, studio_id: str) -> None:
        ladders_result = (
            self.supabase.table("belt_ladders")
            .select("id, studio_id, name, program_id, created_at")
            .eq("studio_id", studio_id)
            .is_("program_id", "null")
            .order("created_at")
            .execute()
        )
        unscoped_ladders = ladders_result.data or []
        if not unscoped_ladders:
            return

        active_programs = [
            program
            for program in self._fetch_active_program_rows(studio_id)
            if not program.get("is_system")
        ]
        existing_ladders = (
            self.supabase.table("belt_ladders")
            .select("id, program_id")
            .eq("studio_id", studio_id)
            .execute()
        )
        used_program_ids = {
            row.get("program_id")
            for row in (existing_ladders.data or [])
            if row.get("program_id")
        }

        programs_by_name = {}
        for program in active_programs:
            programs_by_name.setdefault(_normalize_name(program.get("name") or ""), []).append(program)

        for ladder in unscoped_ladders:
            normalized_ladder_name = _normalize_name(ladder.get("name") or "")
            reusable_program = next(
                (
                    program
                    for program in programs_by_name.get(normalized_ladder_name, [])
                    if program.get("id") not in used_program_ids
                ),
                None,
            )
            if reusable_program is None:
                program_name = ladder.get("name") or "Untitled Program"
                if programs_by_name.get(normalized_ladder_name):
                    program_name = f"{program_name} {str(ladder['id'])[:8]}"
                reusable_program = self._insert_program_row({
                    "studio_id": studio_id,
                    "name": program_name,
                    "description": "Program created from an existing belt tracker ladder.",
                    "color_hex": "#64748B",
                    "sort_order": len(active_programs) * 10,
                    "is_system": False,
                })
                active_programs.append(reusable_program)
                programs_by_name.setdefault(_normalize_name(reusable_program.get("name") or ""), []).append(reusable_program)

            (
                self.supabase.table("belt_ladders")
                .update({"program_id": reusable_program["id"], "name": reusable_program["name"]})
                .eq("id", ladder["id"])
                .eq("studio_id", studio_id)
                .execute()
            )
            used_program_ids.add(reusable_program["id"])

    def _create_missing_ladders_for_active_programs(self, studio_id: str) -> None:
        active_programs = [
            program
            for program in self._fetch_active_program_rows(studio_id)
            if not program.get("is_system")
        ]
        if not active_programs:
            return
        ladders_result = (
            self.supabase.table("belt_ladders")
            .select("id, program_id")
            .eq("studio_id", studio_id)
            .execute()
        )
        program_ids_with_ladders = {
            row.get("program_id")
            for row in (ladders_result.data or [])
            if row.get("program_id")
        }
        for program in active_programs:
            if program.get("id") not in program_ids_with_ladders:
                self._insert_ladder_for_program(program)
                program_ids_with_ladders.add(program.get("id"))

    def _sync_ladder_name_for_program(self, program_id: str, studio_id: str, name: str) -> None:
        if not name:
            return
        (
            self.supabase.table("belt_ladders")
            .update({"name": name})
            .eq("studio_id", studio_id)
            .eq("program_id", program_id)
            .execute()
        )

    def _get_program_row_or_404(self, program_id: str, studio_id: str) -> dict:
        query = (
            self.supabase.table("programs")
            .select(PROGRAM_SELECT)
            .eq("id", program_id)
            .eq("studio_id", studio_id)
            .maybe_single()
        )
        try:
            result = query.execute()
        except PostgrestAPIError as exc:
            if not _is_optional_program_schema_error(exc):
                raise
            result = (
                self.supabase.table("programs")
                .select(PROGRAM_BASE_SELECT)
                .eq("id", program_id)
                .eq("studio_id", studio_id)
                .maybe_single()
                .execute()
            )
        if not result.data:
            raise _program_error(
                status.HTTP_404_NOT_FOUND,
                "PROGRAM_NOT_FOUND",
                "Program not found.",
                program_id=program_id,
            )
        return result.data

    def _ensure_name_available(
        self,
        studio_id: str,
        name: str,
        excluding_program_id: Optional[str] = None,
    ) -> None:
        normalized_name = _normalize_name(name)
        try:
            programs = (
                self.supabase.table("programs")
                .select("id, name, archived_at")
                .eq("studio_id", studio_id)
                .is_("archived_at", "null")
                .execute()
            )
        except PostgrestAPIError as exc:
            if not _is_optional_program_schema_error(exc):
                raise
            programs = (
                self.supabase.table("programs")
                .select("id, name")
                .eq("studio_id", studio_id)
                .execute()
            )
        for row in programs.data or []:
            if excluding_program_id and row.get("id") == excluding_program_id:
                continue
            if _normalize_name(row.get("name") or "") == normalized_name:
                raise _program_error(
                    status.HTTP_409_CONFLICT,
                    "PROGRAM_NAME_CONFLICT",
                    "A program with this name already exists.",
                    name=name,
                )

    def _usage_for_programs(
        self,
        studio_id: str,
        program_ids: list[str],
    ) -> dict[str, ProgramUsageResponse]:
        usage = {program_id: ProgramUsageResponse() for program_id in program_ids}
        for program_id in program_ids:
            usage[program_id] = self._usage_for_program(program_id, studio_id)
        return usage

    def _usage_for_program(self, program_id: str, studio_id: str) -> ProgramUsageResponse:
        try:
            membership_rows = (
                self.supabase.table("student_program_memberships")
                .select("id, status, ended_at")
                .eq("studio_id", studio_id)
                .eq("program_id", program_id)
                .execute()
            )
            memberships = membership_rows.data or []
        except PostgrestAPIError as exc:
            if not _is_optional_program_schema_error(exc):
                raise
            student_rows = (
                self.supabase.table("students")
                .select("id, status")
                .eq("studio_id", studio_id)
                .eq("program_id", program_id)
                .is_("deleted_at", "null")
                .execute()
            )
            memberships = [
                {"status": row.get("status") or "active", "ended_at": None}
                for row in (student_rows.data or [])
            ]

        try:
            session_rows = (
                self.supabase.table("class_sessions")
                .select("id, status")
                .eq("studio_id", studio_id)
                .eq("program_id", program_id)
                .execute()
            )
            sessions = session_rows.data or []
        except PostgrestAPIError as exc:
            if not _is_optional_program_schema_error(exc):
                raise
            sessions = []

        try:
            lead_rows = (
                self.supabase.table("leads")
                .select("id")
                .eq("studio_id", studio_id)
                .eq("program_id", program_id)
                .execute()
            )
            lead_count = len(lead_rows.data or [])
        except PostgrestAPIError as exc:
            if not _is_optional_program_schema_error(exc):
                raise
            lead_count = 0

        try:
            ladder_rows = (
                self.supabase.table("belt_ladders")
                .select("id")
                .eq("studio_id", studio_id)
                .eq("program_id", program_id)
                .execute()
            )
            belt_ladder_count = len(ladder_rows.data or [])
        except PostgrestAPIError as exc:
            if not _is_optional_program_schema_error(exc):
                raise
            belt_ladder_count = 0

        return ProgramUsageResponse(
            student_count=len(memberships),
            active_student_count=len([
                row for row in memberships
                if row.get("status") in {"active", "paused"} and not row.get("ended_at")
            ]),
            class_count=len(sessions),
            active_class_count=len([
                row for row in sessions
                if row.get("status") in {"scheduled", "in_progress"}
            ]),
            lead_count=lead_count,
            belt_ladder_count=belt_ladder_count,
        )

    def _row_to_response(
        self,
        row: dict,
        usage: Optional[ProgramUsageResponse] = None,
    ) -> ProgramResponse:
        normalized = {
            "id": row["id"],
            "studio_id": row["studio_id"],
            "name": row["name"],
            "description": row.get("description"),
            "color_hex": row.get("color_hex") or "#64748B",
            "sort_order": row.get("sort_order") or 0,
            "is_system": bool(row.get("is_system", False)),
            "archived_at": row.get("archived_at"),
            "created_at": row["created_at"],
            "updated_at": row.get("updated_at") or row["created_at"],
            "usage": usage or ProgramUsageResponse(),
        }
        return ProgramResponse(**normalized)

    def _audit(
        self,
        studio_id: str,
        actor_id: str,
        action: str,
        entity_id: str,
        metadata: dict,
    ) -> None:
        self.supabase.table("audit_logs").insert({
            "studio_id": studio_id,
            "actor_id": actor_id,
            "action": action,
            "entity_type": "program",
            "entity_id": entity_id,
            "metadata": metadata,
        }).execute()
