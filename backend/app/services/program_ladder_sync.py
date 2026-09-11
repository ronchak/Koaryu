from __future__ import annotations

from typing import Callable, Optional

from fastapi import HTTPException
from supabase import Client


class ProgramLadderSync:
    def __init__(
        self,
        supabase: Client,
        *,
        audit_writer: Optional[Callable[[str, str, str, str, dict], None]] = None,
    ):
        self.supabase = supabase
        self.audit_writer = audit_writer

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
