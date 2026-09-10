from __future__ import annotations

from typing import Optional

from postgrest.exceptions import APIError as PostgrestAPIError
from supabase import Client

from app.services.program_service import ProgramService


OPTIONAL_MEMBERSHIP_SCHEMA_ERROR_CODES = {"42P01", "42703", "PGRST204", "PGRST205"}


def is_optional_student_membership_schema_error(exc: PostgrestAPIError) -> bool:
    return exc.code in OPTIONAL_MEMBERSHIP_SCHEMA_ERROR_CODES


class StudentProgramMembershipStore:
    def __init__(self, supabase: Client):
        self.supabase = supabase

    def normalize_program_ids_for_write(
        self,
        studio_id: str,
        program_id: Optional[str],
        program_ids: Optional[list[str]],
    ) -> list[str]:
        values: list[str] = []
        if program_ids is not None:
            values.extend(program_ids)
        elif program_id:
            values.append(program_id)

        program_service = ProgramService(self.supabase)
        normalized = []
        seen: set[str] = set()
        for value in values:
            if value and value not in seen:
                program_service.ensure_program_active(studio_id, value)
                normalized.append(value)
                seen.add(value)

        if not normalized:
            normalized.append(program_service.get_unassigned_program_id(studio_id))

        return normalized

    @staticmethod
    def membership_write_payload(payload: dict) -> dict:
        next_payload = dict(payload)
        for key in ("started_at", "ended_at"):
            if next_payload.get(key):
                next_payload[key] = str(next_payload[key])
        return next_payload
