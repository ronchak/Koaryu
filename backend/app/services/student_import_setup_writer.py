from __future__ import annotations

import logging
from collections import defaultdict
from typing import Any, Optional

from fastapi import HTTPException
from postgrest.exceptions import APIError as PostgrestAPIError
from supabase import Client

from app.services.program_service import ProgramService
from app.services.student_import_csv import (
    belt_import_sort_key,
    infer_belt_color_hex,
    make_import_issue,
    normalize_header,
)
from app.services.student_import_ids import deterministic_import_uuid
from app.services.student_import_planner import StudentImportPlanner


logger = logging.getLogger(__name__)


class StudentImportSetupWriter:
    def __init__(self, supabase: Client):
        self.supabase = supabase

    def _build_named_record_lookup(
        self,
        table_name: str,
        studio_id: str,
    ) -> tuple[set[str], dict[str, str], set[str]]:
        return StudentImportPlanner(self.supabase).build_named_record_lookup(table_name, studio_id)

    def _resolve_named_import_reference(
        self,
        raw_value: Optional[str],
        *,
        label: str,
        id_lookup: set[str],
        name_lookup: dict[str, str],
        ambiguous_names: set[str],
    ) -> tuple[Optional[str], Optional[str], Optional[str]]:
        return StudentImportPlanner(self.supabase).resolve_named_import_reference(
            raw_value,
            label=label,
            id_lookup=id_lookup,
            name_lookup=name_lookup,
            ambiguous_names=ambiguous_names,
        )

    def _create_missing_programs(
        self,
        studio_id: str,
        actor_id: str,
        planned_rows: list[dict[str, Any]],
        import_run_id: str,
        non_critical_errors: Optional[list[str]] = None,
    ) -> list[str]:
        requested_names: dict[str, str] = {}
        for row in planned_rows:
            raw_name = row.get("pending_program_name")
            if not raw_name:
                continue
            normalized_name = normalize_header(raw_name)
            if normalized_name and normalized_name not in requested_names:
                requested_names[normalized_name] = raw_name.strip()

        if not requested_names:
            return []

        program_lookup = self._build_named_record_lookup("programs", studio_id)
        program_service = ProgramService(self.supabase)
        created_programs: list[str] = []
        for normalized_name, raw_name in requested_names.items():
            existing_id = program_lookup[1].get(normalized_name)
            if existing_id:
                continue

            program_id = deterministic_import_uuid(import_run_id, "program", normalized_name)
            result = None
            sort_order = (len(program_lookup[0]) + len(created_programs)) * 10
            full_program_row = {
                "id": program_id,
                "studio_id": studio_id,
                "name": raw_name,
                "description": "Program created from student import.",
                "color_hex": "#64748B",
                "sort_order": sort_order,
                "is_system": False,
                "archived_at": None,
            }
            try:
                result = (
                    self.supabase.table("programs")
                    .upsert(
                        full_program_row,
                        on_conflict="id",
                    )
                    .execute()
                )
            except PostgrestAPIError as exc:
                if exc.code not in {"42703", "PGRST204", "PGRST205"}:
                    result = None
                else:
                    result = (
                        self.supabase.table("programs")
                        .upsert(
                            {
                                "id": program_id,
                                "studio_id": studio_id,
                                "name": raw_name,
                                "description": "Program created from student import.",
                            },
                            on_conflict="id",
                        )
                        .execute()
                    )
            except Exception:
                result = None
            if not result or not result.data:
                refreshed_lookup = self._build_named_record_lookup("programs", studio_id)
                if refreshed_lookup[1].get(normalized_name):
                    program_lookup = refreshed_lookup
                    continue
                raise HTTPException(status_code=500, detail=f"Failed to create program '{raw_name}'")

            created_programs.append(raw_name)
            program_lookup = self._build_named_record_lookup("programs", studio_id)

        if created_programs:
            program_service.ensure_program_ladders(studio_id)
            try:
                self.supabase.table("audit_logs").insert({
                    "studio_id": studio_id,
                    "actor_id": actor_id,
                    "action": "programs.created_from_import",
                    "entity_type": "program",
                    "entity_id": None,
                    "metadata": {"names": created_programs},
                }).execute()
            except Exception:
                logger.exception(
                    "Student import program audit log write failed",
                    extra={"studio_id": studio_id, "import_run_id": import_run_id},
                )
                if non_critical_errors is not None:
                    non_critical_errors.append(
                        "Programs were created, but the import audit log could not be written."
                    )

        refreshed_lookup = self._build_named_record_lookup("programs", studio_id)
        for row in planned_rows:
            raw_name = row.get("pending_program_name")
            if not raw_name:
                continue
            resolved_id, _, _ = self._resolve_named_import_reference(
                raw_name,
                label="Program",
                id_lookup=refreshed_lookup[0],
                name_lookup=refreshed_lookup[1],
                ambiguous_names=refreshed_lookup[2],
            )
            row["resolved_program_id"] = resolved_id

        return created_programs

    def _create_missing_belts(
        self,
        studio_id: str,
        actor_id: str,
        planned_rows: list[dict[str, Any]],
        belt_rank_lookup: dict[str, Any],
        import_run_id: str,
        non_critical_errors: Optional[list[str]] = None,
    ) -> tuple[list[str], list[str]]:
        pending_rows = [row for row in planned_rows if row.get("pending_belt_name")]
        if not pending_rows:
            return [], []

        ladders_by_program: dict[str, list[str]] = defaultdict(list, {
            program_id: list(ladder_ids)
            for program_id, ladder_ids in belt_rank_lookup.get("ladders_by_program", {}).items()
        })
        ladder_meta = {
            ladder_id: dict(meta)
            for ladder_id, meta in belt_rank_lookup.get("ladder_meta", {}).items()
        }

        requested_program_ids = sorted({
            row.get("resolved_program_id")
            for row in pending_rows
            if row.get("resolved_program_id")
        })
        program_names: dict[str, str] = {}
        if requested_program_ids:
            programs_result = (
                self.supabase.table("programs")
                .select("id, name")
                .eq("studio_id", studio_id)
                .in_("id", requested_program_ids)
                .execute()
            )
            program_names = {
                row["id"]: row.get("name") or "Imported Program"
                for row in (programs_result.data or [])
                if row.get("id")
            }

        requested_new_ladders: dict[str, str] = {}
        for row in pending_rows:
            if row.get("belt_creation_target_ladder_id"):
                continue

            program_id = row.get("resolved_program_id")
            if not program_id:
                continue

            program_ladders = ladders_by_program.get(program_id, [])
            if len(program_ladders) == 1:
                row["belt_creation_target_ladder_id"] = program_ladders[0]
                row["belt_creation_requires_new_ladder"] = False
                continue

            if len(program_ladders) == 0:
                requested_new_ladders[program_id] = program_names.get(program_id, "Imported Program")
                continue

            row["issues"].append(make_import_issue(
                "ambiguous_belt_ladder",
                f"{program_names.get(program_id, 'This program')} has multiple belt ladders, so Koaryu could not safely auto-create this current belt during import.",
                field="current_belt_rank_id",
                value=row.get("unresolved_belt_value"),
                suggested_action="Choose one ladder for this program in Belt Tracker, then retry the import.",
            ))
            row["is_valid"] = False

        created_ladders: list[str] = []
        created_ladder_ids: dict[str, str] = {}
        for program_id, program_name in sorted(requested_new_ladders.items(), key=lambda item: item[1].lower()):
            existing_program_ladders = (
                self.supabase.table("belt_ladders")
                .select("id, name, program_id")
                .eq("studio_id", studio_id)
                .eq("program_id", program_id)
                .order("created_at")
                .execute()
            )
            existing_program_ladder_rows = existing_program_ladders.data or []
            if len(existing_program_ladder_rows) == 1:
                existing_ladder = existing_program_ladder_rows[0]
                ladder_id = existing_ladder["id"]
                created_ladder_ids[program_id] = ladder_id
                ladders_by_program[program_id] = [ladder_id]
                ladder_meta[ladder_id] = {
                    "name": existing_ladder.get("name") or program_name,
                    "program_id": program_id,
                }
                continue
            if len(existing_program_ladder_rows) > 1:
                raise HTTPException(
                    status_code=409,
                    detail=f"Program '{program_name}' has multiple ladders. Please clean them up in Belt Tracker before importing current belts.",
                )

            ladder_id = deterministic_import_uuid(import_run_id, "ladder", program_id)
            result = None
            try:
                result = (
                    self.supabase.table("belt_ladders")
                    .upsert(
                        {
                            "id": ladder_id,
                            "studio_id": studio_id,
                            "name": program_name,
                            "program_id": program_id,
                            "sub_rank_term": "Stripe",
                        },
                        on_conflict="id",
                    )
                    .execute()
                )
            except Exception:
                result = None
            if not result or not result.data:
                existing_program_ladders = (
                    self.supabase.table("belt_ladders")
                    .select("id, name, program_id")
                    .eq("studio_id", studio_id)
                    .eq("program_id", program_id)
                    .order("created_at")
                    .execute()
                )
                existing_program_ladder_rows = existing_program_ladders.data or []
                if len(existing_program_ladder_rows) == 1:
                    existing_ladder = existing_program_ladder_rows[0]
                    ladder_id = existing_ladder["id"]
                    created_ladder_ids[program_id] = ladder_id
                    ladders_by_program[program_id] = [ladder_id]
                    ladder_meta[ladder_id] = {
                        "name": existing_ladder.get("name") or program_name,
                        "program_id": program_id,
                    }
                    continue
                raise HTTPException(status_code=500, detail=f"Failed to create ladder for program '{program_name}'")

            ladder_id = result.data[0]["id"]
            created_ladder_ids[program_id] = ladder_id
            ladders_by_program[program_id] = [ladder_id]
            ladder_meta[ladder_id] = {
                "name": result.data[0].get("name") or program_name,
                "program_id": program_id,
            }
            created_ladders.append(program_name)

        if created_ladders:
            try:
                self.supabase.table("audit_logs").insert({
                    "studio_id": studio_id,
                    "actor_id": actor_id,
                    "action": "belt_ladders.created_from_import",
                    "entity_type": "belt_ladder",
                    "entity_id": None,
                    "metadata": {"names": created_ladders},
                }).execute()
            except Exception:
                logger.exception(
                    "Student import belt ladder audit log write failed",
                    extra={"studio_id": studio_id, "import_run_id": import_run_id},
                )
                if non_critical_errors is not None:
                    non_critical_errors.append(
                        "Belt ladders were created, but the import audit log could not be written."
                    )

        for row in pending_rows:
            if row.get("belt_creation_target_ladder_id"):
                continue
            program_id = row.get("resolved_program_id")
            if program_id and program_id in created_ladder_ids:
                row["belt_creation_target_ladder_id"] = created_ladder_ids[program_id]
                row["belt_creation_requires_new_ladder"] = False

        requested_belts: dict[tuple[str, str], dict[str, str]] = {}
        for row in pending_rows:
            raw_name = row.get("pending_belt_name")
            ladder_id = row.get("belt_creation_target_ladder_id")
            if not raw_name or not ladder_id:
                continue

            normalized_name = normalize_header(raw_name)
            if not normalized_name:
                continue

            key = (ladder_id, normalized_name)
            if key not in requested_belts:
                ladder_name = (
                    (ladder_meta.get(ladder_id) or {}).get("name")
                    or "Imported ladder"
                )
                requested_belts[key] = {
                    "raw_name": raw_name.strip(),
                    "ladder_name": ladder_name,
                }

        if not requested_belts:
            return created_ladders, []

        ladder_ids = sorted({ladder_id for ladder_id, _ in requested_belts.keys()})
        ranks_result = (
            self.supabase.table("belt_ranks")
            .select("id, ladder_id, display_order, name")
            .eq("studio_id", studio_id)
            .in_("ladder_id", ladder_ids)
            .order("display_order")
            .execute()
        )

        next_display_order: dict[str, int] = defaultdict(int)
        existing_rank_ids_by_key: dict[tuple[str, str], str] = {}
        for rank in ranks_result.data or []:
            ladder_id = rank.get("ladder_id")
            if not ladder_id:
                continue
            next_display_order[ladder_id] = max(
                next_display_order[ladder_id],
                int(rank.get("display_order", 0)) + 1,
            )
            normalized_rank_name = normalize_header(rank.get("name") or "")
            if normalized_rank_name:
                existing_rank_ids_by_key[(ladder_id, normalized_rank_name)] = rank["id"]

        created_belt_ids: dict[tuple[str, str], str] = {}
        created_belts: list[str] = []
        ordered_requests = sorted(
            requested_belts.items(),
            key=lambda item: (item[0][0], belt_import_sort_key(item[1]["raw_name"])),
        )
        for (ladder_id, normalized_name), meta in ordered_requests:
            existing_rank_id = existing_rank_ids_by_key.get((ladder_id, normalized_name))
            if existing_rank_id:
                created_belt_ids[(ladder_id, normalized_name)] = existing_rank_id
                continue

            rank_id = deterministic_import_uuid(import_run_id, "belt", f"{ladder_id}:{normalized_name}")
            result = None
            try:
                result = (
                    self.supabase.table("belt_ranks")
                    .upsert(
                        {
                            "id": rank_id,
                            "studio_id": studio_id,
                            "ladder_id": ladder_id,
                            "name": meta["raw_name"],
                            "color_hex": infer_belt_color_hex(meta["raw_name"]),
                            "display_order": next_display_order[ladder_id],
                            "min_classes": 0,
                            "min_months": 0,
                            "requires_approval": True,
                            "is_tip": False,
                            "tip_color_hex": None,
                        },
                        on_conflict="id",
                    )
                    .execute()
                )
            except Exception:
                result = None

            if result and result.data:
                created_belt_ids[(ladder_id, normalized_name)] = result.data[0]["id"]
                existing_rank_ids_by_key[(ladder_id, normalized_name)] = result.data[0]["id"]
                next_display_order[ladder_id] += 1
                created_belts.append(f"{meta['raw_name']} ({meta['ladder_name']})")
                continue

            existing_rank = (
                self.supabase.table("belt_ranks")
                .select("id, name")
                .eq("studio_id", studio_id)
                .eq("ladder_id", ladder_id)
                .execute()
            )
            existing_rank_id = next(
                (
                    rank.get("id")
                    for rank in (existing_rank.data or [])
                    if normalize_header(rank.get("name") or "") == normalized_name
                ),
                None,
            )
            if not existing_rank_id:
                raise HTTPException(status_code=500, detail=f"Failed to create belt '{meta['raw_name']}'")
            created_belt_ids[(ladder_id, normalized_name)] = existing_rank_id

        if created_belts:
            try:
                self.supabase.table("audit_logs").insert({
                    "studio_id": studio_id,
                    "actor_id": actor_id,
                    "action": "belt_ranks.created_from_import",
                    "entity_type": "belt_rank",
                    "entity_id": None,
                    "metadata": {"names": created_belts},
                }).execute()
            except Exception:
                logger.exception(
                    "Student import belt rank audit log write failed",
                    extra={"studio_id": studio_id, "import_run_id": import_run_id},
                )
                if non_critical_errors is not None:
                    non_critical_errors.append(
                        "Belt ranks were created, but the import audit log could not be written."
                    )

        for row in planned_rows:
            raw_name = row.get("pending_belt_name")
            ladder_id = row.get("belt_creation_target_ladder_id")
            if not raw_name or not ladder_id:
                continue
            normalized_name = normalize_header(raw_name)
            created_rank_id = created_belt_ids.get((ladder_id, normalized_name))
            if created_rank_id:
                row["resolved_belt_rank_id"] = created_rank_id

        return created_ladders, created_belts
