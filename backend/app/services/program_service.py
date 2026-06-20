from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from typing import Optional

from fastapi import status
from supabase import Client

from app.schemas.program import (
    ProgramCreate,
    ProgramResponse,
    ProgramUpdate,
    ProgramUsageResponse,
)
from app.services.program_ladder_sync import (
    ProgramLadderSync,
)
from app.services.program_records import (
    ProgramRecordStore,
    program_error as _program_error,
    row_to_program_response,
)
from app.services.program_usage import ProgramUsageCalculator


class ProgramService:
    def __init__(self, supabase: Client):
        self.supabase = supabase
        self._records = ProgramRecordStore(supabase)

    def _program_ladders(self) -> ProgramLadderSync:
        return ProgramLadderSync(self.supabase, audit_writer=self._records.audit)

    def ensure_program_ladders(self, studio_id: str) -> None:
        self._program_ladders().ensure_program_ladders(studio_id)

    async def list_programs(
        self,
        studio_id: str,
        include_archived: bool = False,
    ) -> list[ProgramResponse]:
        return await asyncio.to_thread(
            self.list_programs_sync,
            studio_id,
            include_archived,
        )

    def list_programs_sync(
        self,
        studio_id: str,
        include_archived: bool = False,
    ) -> list[ProgramResponse]:
        rows = self._records.list_rows(studio_id, include_archived)
        usage_by_program_id = self._usage_for_programs(
            studio_id,
            [row["id"] for row in rows if row.get("id")],
        )
        return [
            row_to_program_response(row, usage_by_program_id.get(row.get("id")))
            for row in rows
        ]

    def list_programs_metadata_sync(
        self,
        studio_id: str,
        include_archived: bool = False,
    ) -> list[ProgramResponse]:
        return [
            row_to_program_response(row)
            for row in self._records.list_rows(studio_id, include_archived)
        ]

    async def get_program(
        self,
        program_id: str,
        studio_id: str,
    ) -> ProgramResponse:
        row = self._records.get_row_or_404(program_id, studio_id)
        return row_to_program_response(row, self._usage_for_program(program_id, studio_id))

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
        self._records.ensure_name_available(studio_id, name)

        row = data.model_dump()
        row["name"] = name
        row["studio_id"] = studio_id
        program_row = self._records.insert_program(
            row,
            {
                "studio_id": studio_id,
                "name": name,
                "description": data.description,
            },
            name,
        )
        self._program_ladders().ensure_ladder_for_program_row(program_row, actor_id)

        self._records.audit(
            studio_id,
            actor_id,
            "program.created",
            program_row["id"],
            {"name": name},
        )
        return row_to_program_response(program_row, self._usage_for_program(program_row["id"], studio_id))

    async def update_program(
        self,
        program_id: str,
        data: ProgramUpdate,
        studio_id: str,
        actor_id: str,
    ) -> ProgramResponse:
        current = self._records.get_row_or_404(program_id, studio_id)
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
            self._records.ensure_name_available(studio_id, next_name, excluding_program_id=program_id)
            update_dict["name"] = next_name

        updated = self._records.update_program(program_id, studio_id, update_dict)
        if updated is None:
            return row_to_program_response(current, self._usage_for_program(program_id, studio_id))

        self._program_ladders().sync_ladder_name_for_program(
            program_id,
            studio_id,
            updated.get("name") or current.get("name") or "",
        )

        self._records.audit(
            studio_id,
            actor_id,
            "program.updated",
            program_id,
            {
                "previous_name": current.get("name"),
                "changes": update_dict,
            },
        )
        return row_to_program_response(updated, self._usage_for_program(program_id, studio_id))

    async def archive_program(
        self,
        program_id: str,
        studio_id: str,
        actor_id: str,
    ) -> ProgramResponse:
        row = self._records.get_row_or_404(program_id, studio_id)
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
            return row_to_program_response(row, self._usage_for_program(program_id, studio_id))

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
        archived = self._records.archive_program(program_id, studio_id, archived_at)
        self._records.audit(studio_id, actor_id, "program.archived", program_id, {"name": row.get("name")})
        return row_to_program_response(archived, usage)

    async def restore_program(
        self,
        program_id: str,
        studio_id: str,
        actor_id: str,
    ) -> ProgramResponse:
        row = self._records.get_row_or_404(program_id, studio_id)
        if "archived_at" not in row:
            raise _program_error(
                status.HTTP_409_CONFLICT,
                "PROGRAM_ARCHIVE_UNAVAILABLE",
                "Program archiving requires the latest program migration.",
                program_id=program_id,
            )
        self._records.ensure_name_available(studio_id, row.get("name") or "", excluding_program_id=program_id)
        restored = self._records.restore_program(program_id, studio_id)
        self._records.audit(studio_id, actor_id, "program.restored", program_id, {"name": row.get("name")})
        return row_to_program_response(restored, self._usage_for_program(program_id, studio_id))

    async def get_usage(self, program_id: str, studio_id: str) -> ProgramUsageResponse:
        self._records.get_row_or_404(program_id, studio_id)
        return self._usage_for_program(program_id, studio_id)

    def ensure_program_active(self, studio_id: str, program_id: Optional[str]) -> None:
        if not program_id:
            return
        program = self._records.get_row_or_404(program_id, studio_id)
        if program.get("archived_at"):
            raise _program_error(
                status.HTTP_409_CONFLICT,
                "PROGRAM_INACTIVE",
                "Archived programs cannot be used for new records.",
                program_id=program_id,
            )

    def get_unassigned_program_id(self, studio_id: str) -> str:
        return self._records.get_unassigned_program_id(studio_id)

    def _usage_for_programs(
        self,
        studio_id: str,
        program_ids: list[str],
    ) -> dict[str, ProgramUsageResponse]:
        return ProgramUsageCalculator(self.supabase)._usage_for_programs(studio_id, program_ids)

    def _usage_for_program(self, program_id: str, studio_id: str) -> ProgramUsageResponse:
        return ProgramUsageCalculator(self.supabase)._usage_for_program(program_id, studio_id)
