from __future__ import annotations

from typing import Any, Optional

from fastapi import HTTPException
from postgrest.exceptions import APIError as PostgrestAPIError
from supabase import Client

from app.schemas.program import ProgramResponse, ProgramUsageResponse
from app.services.program_ladder_sync import (
    PROGRAM_BASE_SELECT,
    PROGRAM_SELECT,
    _is_optional_program_schema_error,
    _normalize_name,
)


def program_error(status_code: int, code: str, message: str, **details: Any) -> HTTPException:
    return HTTPException(
        status_code=status_code,
        detail={
            "code": code,
            "message": message,
            "details": details,
        },
    )


def row_to_program_response(
    row: dict[str, Any],
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


class ProgramRecordStore:
    def __init__(self, supabase: Client):
        self.supabase = supabase

    def list_rows(
        self,
        studio_id: str,
        include_archived: bool = False,
    ) -> list[dict[str, Any]]:
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
            result = (
                self.supabase.table("programs")
                .select(PROGRAM_BASE_SELECT)
                .eq("studio_id", studio_id)
                .order("name")
                .execute()
            )
        return result.data or []

    def get_row_or_404(self, program_id: str, studio_id: str) -> dict[str, Any]:
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
            raise program_error(
                404,
                "PROGRAM_NOT_FOUND",
                "Program not found.",
                program_id=program_id,
            )
        return result.data

    def ensure_name_available(
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
                raise program_error(
                    409,
                    "PROGRAM_NAME_CONFLICT",
                    "A program with this name already exists.",
                    name=name,
                )

    def insert_program(
        self,
        full_row: dict[str, Any],
        fallback_row: dict[str, Any],
        name: str,
    ) -> dict[str, Any]:
        try:
            result = self.supabase.table("programs").insert(full_row).execute()
        except PostgrestAPIError as exc:
            if exc.code == "23505":
                raise program_error(
                    409,
                    "PROGRAM_NAME_CONFLICT",
                    "A program with this name already exists.",
                    name=name,
                ) from exc
            if not _is_optional_program_schema_error(exc):
                raise
            try:
                result = self.supabase.table("programs").insert(fallback_row).execute()
            except PostgrestAPIError as retry_exc:
                if retry_exc.code == "23505":
                    raise program_error(
                        409,
                        "PROGRAM_NAME_CONFLICT",
                        "A program with this name already exists.",
                        name=name,
                    ) from retry_exc
                raise
        if not result.data:
            raise HTTPException(status_code=500, detail="Failed to create program")
        return result.data[0]

    def update_program(
        self,
        program_id: str,
        studio_id: str,
        update: dict[str, Any],
    ) -> Optional[dict[str, Any]]:
        try:
            result = (
                self.supabase.table("programs")
                .update(update)
                .eq("id", program_id)
                .eq("studio_id", studio_id)
                .execute()
            )
        except PostgrestAPIError as exc:
            if not _is_optional_program_schema_error(exc):
                raise
            update = {
                key: value
                for key, value in update.items()
                if key in {"name", "description"}
            }
            if not update:
                return None
            result = (
                self.supabase.table("programs")
                .update(update)
                .eq("id", program_id)
                .eq("studio_id", studio_id)
                .execute()
            )
        if not result.data:
            raise program_error(
                404,
                "PROGRAM_NOT_FOUND",
                "Program not found.",
                program_id=program_id,
            )
        return result.data[0]

    def archive_program(self, program_id: str, studio_id: str, archived_at: str) -> dict[str, Any]:
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
            raise program_error(
                409,
                "PROGRAM_ARCHIVE_UNAVAILABLE",
                "Program archiving requires the latest program migration.",
                program_id=program_id,
            ) from exc
        if not result.data:
            raise program_error(
                404,
                "PROGRAM_NOT_FOUND",
                "Program not found.",
                program_id=program_id,
            )
        return result.data[0]

    def restore_program(self, program_id: str, studio_id: str) -> dict[str, Any]:
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
            raise program_error(
                409,
                "PROGRAM_ARCHIVE_UNAVAILABLE",
                "Program archiving requires the latest program migration.",
                program_id=program_id,
            ) from exc
        if not result.data:
            raise program_error(
                404,
                "PROGRAM_NOT_FOUND",
                "Program not found.",
                program_id=program_id,
            )
        return result.data[0]

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

        full_row = {
            "studio_id": studio_id,
            "name": "Unassigned",
            "description": "Students awaiting program assignment.",
            "color_hex": "#94A3B8",
            "sort_order": 9999,
            "is_system": True,
        }
        fallback_row = {
            "studio_id": studio_id,
            "name": "Unassigned",
            "description": "Students awaiting program assignment.",
        }
        try:
            result = self.supabase.table("programs").insert(full_row).execute()
        except PostgrestAPIError as exc:
            if not _is_optional_program_schema_error(exc):
                raise
            result = self.supabase.table("programs").insert(fallback_row).execute()
        if not result.data:
            raise HTTPException(status_code=500, detail="Failed to create Unassigned program")
        return result.data[0]["id"]

    def audit(
        self,
        studio_id: str,
        actor_id: str,
        action: str,
        entity_id: str,
        metadata: dict[str, Any],
    ) -> None:
        self.supabase.table("audit_logs").insert({
            "studio_id": studio_id,
            "actor_id": actor_id,
            "action": action,
            "entity_type": "program",
            "entity_id": entity_id,
            "metadata": metadata,
        }).execute()
