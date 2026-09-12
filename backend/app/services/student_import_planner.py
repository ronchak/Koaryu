from __future__ import annotations

from collections import defaultdict
from typing import Any, Optional

from supabase import Client

from app.schemas.student import (
    CsvImportIssue,
    CsvImportOptions,
    CsvImportResult,
)
from app.services.student_import_csv import (
    normalize_header,
    validate_csv_import_mapping,
)
from app.services.student_import_plan_result import build_import_result
from app.services.student_import_plan_rows import (
    build_import_row_plan,
)


class StudentImportPlanner:
    def __init__(self, supabase: Optional[Client]):
        self.supabase = supabase

    def build_program_lookup(
        self,
        studio_id: str,
        confirmed: Optional[dict[str, dict[str, Any]]] = None,
    ) -> dict[str, Any]:
        result = (
            self.supabase.table("programs")
            .select("id, name, archived_at")
            .eq("studio_id", studio_id)
            .execute()
        )
        records = {row["id"]: row for row in result.data or [] if row.get("id")}
        names: dict[str, list[str]] = defaultdict(list)
        for record_id, row in records.items():
            name = normalize_header(row.get("name") or "")
            if name:
                names[name].append(record_id)
        name_lookup: dict[str, str] = {}
        ambiguous_names: set[str] = set()
        for name, ids in names.items():
            candidates = [
                record_id for record_id in ids if not records[record_id].get("archived_at")
            ] or ids
            if len(candidates) == 1:
                name_lookup[name] = candidates[0]
            else:
                ambiguous_names.add(name)
        return {
            "id_lookup": set(records),
            "name_lookup": name_lookup,
            "ambiguous_names": ambiguous_names,
            "records": records,
            "confirmed": confirmed or {},
        }

    def build_belt_rank_lookup(self, studio_id: str) -> dict[str, Any]:
        ladders_result = (
            self.supabase.table("belt_ladders")
            .select("id, name, program_id")
            .eq("studio_id", studio_id)
            .execute()
        )
        ladder_meta = {
            row["id"]: {
                "name": row.get("name"),
                "program_id": row.get("program_id"),
            }
            for row in (ladders_result.data or [])
            if row.get("id")
        }
        ladders_by_program: dict[str, list[str]] = defaultdict(list)
        unscoped_ladder_ids: list[str] = []
        for ladder_id, ladder in ladder_meta.items():
            program_id = ladder.get("program_id")
            if program_id:
                ladders_by_program[program_id].append(ladder_id)
            else:
                unscoped_ladder_ids.append(ladder_id)

        result = (
            self.supabase.table("belt_ranks")
            .select("id, name, ladder_id")
            .eq("studio_id", studio_id)
            .execute()
        )

        id_lookup: set[str] = set()
        rank_meta: dict[str, dict[str, Optional[str]]] = {}
        rank_ids_by_name: dict[str, list[str]] = defaultdict(list)
        program_rank_name_lookup: dict[str, dict[str, list[str]]] = defaultdict(
            lambda: defaultdict(list)
        )
        unscoped_rank_name_lookup: dict[str, list[str]] = defaultdict(list)

        for row in result.data or []:
            record_id = row.get("id")
            record_name = row.get("name")
            ladder_id = row.get("ladder_id")
            if not record_id or not record_name:
                continue

            id_lookup.add(record_id)
            normalized_name = normalize_header(record_name)
            if normalized_name:
                rank_ids_by_name[normalized_name].append(record_id)

            ladder = ladder_meta.get(ladder_id, {})
            program_id = ladder.get("program_id")
            if normalized_name and program_id:
                program_rank_name_lookup[program_id][normalized_name].append(record_id)
            elif normalized_name and not program_id:
                unscoped_rank_name_lookup[normalized_name].append(record_id)
            rank_meta[record_id] = {
                "ladder_id": ladder_id,
                "ladder_name": ladder.get("name"),
                "program_id": program_id,
            }

        return {
            "id_lookup": id_lookup,
            "name_to_rank_ids": {
                normalized_name: list(rank_ids)
                for normalized_name, rank_ids in rank_ids_by_name.items()
            },
            "program_rank_name_lookup": {
                program_id: {
                    normalized_name: list(rank_ids)
                    for normalized_name, rank_ids in name_map.items()
                }
                for program_id, name_map in program_rank_name_lookup.items()
            },
            "unscoped_rank_name_lookup": {
                normalized_name: list(rank_ids)
                for normalized_name, rank_ids in unscoped_rank_name_lookup.items()
            },
            "rank_meta": rank_meta,
            "ladder_meta": ladder_meta,
            "ladders_by_program": dict(ladders_by_program),
            "unscoped_ladder_ids": unscoped_ladder_ids,
            "sole_ladder_id": next(iter(ladder_meta)) if len(ladder_meta) == 1 else None,
            "ladder_count": len(ladder_meta),
        }

    def prepare_import(
        self,
        rows: list[dict],
        mapping: dict[str, str],
        studio_id: Optional[str],
        options: CsvImportOptions,
        receipts: Optional[dict[str, dict[str, Any]]] = None,
    ) -> tuple[CsvImportResult, list[dict[str, Any]]]:
        validate_csv_import_mapping(mapping)
        receipts = receipts or {}
        unfinished = any(str(i) not in receipts.get("student", {}) for i in range(2, len(rows) + 2))
        program_lookup = (
            self.build_program_lookup(studio_id, receipts.get("program"))
            if studio_id and unfinished
            else None
        )
        belt_rank_lookup = (
            self.build_belt_rank_lookup(studio_id) if studio_id and unfinished else None
        )
        if belt_rank_lookup is not None:
            belt_rank_lookup["confirmed_ranks"] = {
                (receipt["context_program_id"], key.split(":", 1)[1]): receipt
                for key, receipt in receipts.get("rank", {}).items()
            }
            unassigned = receipts.get("program", {}).get("__unassigned__", {}).get("program_id")
            for key, receipt in receipts.get("rank", {}).items():
                if receipt["context_program_id"] == unassigned:
                    belt_rank_lookup["confirmed_ranks"][(None, key.split(":", 1)[1])] = receipt

        planned_rows: list[dict[str, Any]] = []
        for i, raw_row in enumerate(rows, start=2):
            completed = receipts.get("student", {}).get(str(i))
            if completed is not None:
                outcome = dict(completed["outcome"])
                outcome["issues"] = [
                    CsvImportIssue.model_validate(issue) for issue in outcome["issues"]
                ]
                outcome["completed"] = True
                planned_rows.append(outcome)
                continue
            row_plan = build_import_row_plan(
                raw_row,
                mapping,
                options=options,
                program_lookup=program_lookup,
                belt_rank_lookup=belt_rank_lookup,
            )
            row_plan["row_number"] = i
            planned_rows.append(row_plan)

        return build_import_result(planned_rows, total_rows=len(rows)), planned_rows

    def hydrate_import_result(
        self,
        planned_rows: list[dict[str, Any]],
        *,
        total_rows: int,
        created_programs: Optional[list[str]] = None,
        created_ladders: Optional[list[str]] = None,
        created_belts: Optional[list[str]] = None,
        imported_without_belt_count: int = 0,
        imported_count: int = 0,
        idempotency_key: Optional[str] = None,
    ) -> CsvImportResult:
        result = build_import_result(planned_rows, total_rows=total_rows)
        result.created_programs = created_programs or []
        result.created_ladders = created_ladders or []
        result.created_belts = created_belts or []
        result.imported_without_belt_count = imported_without_belt_count
        result.imported_count = imported_count
        result.idempotency_key = idempotency_key
        return result
