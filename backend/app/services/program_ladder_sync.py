from __future__ import annotations

from typing import Any, Callable, Optional

from fastapi import HTTPException
from postgrest.exceptions import APIError as PostgrestAPIError
from supabase import Client


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


class ProgramLadderSync:
    def __init__(
        self,
        supabase: Client,
        *,
        audit_writer: Optional[Callable[[str, str, str, str, dict], None]] = None,
    ):
        self.supabase = supabase
        self.audit_writer = audit_writer

    def ensure_program_ladders(self, studio_id: str) -> None:
        """Keep the product invariant: one user-facing program owns one ladder."""
        try:
            self._attach_unscoped_ladders_to_programs(studio_id)
            self._create_missing_ladders_for_active_programs(studio_id)
        except PostgrestAPIError as exc:
            if not _is_optional_program_schema_error(exc):
                raise

    def ensure_ladder_for_program_row(
        self,
        program: dict,
        actor_id: Optional[str] = None,
    ) -> Optional[dict]:
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

    def sync_ladder_name_for_program(self, program_id: str, studio_id: str, name: str) -> None:
        if not name:
            return
        (
            self.supabase.table("belt_ladders")
            .update({"name": name})
            .eq("studio_id", studio_id)
            .eq("program_id", program_id)
            .execute()
        )

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
        if actor_id and self.audit_writer:
            self.audit_writer(
                program["studio_id"],
                actor_id,
                "program_ladder.created",
                program["id"],
                {"ladder_id": result.data[0]["id"], "name": program["name"]},
            )
        return result.data[0]

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
