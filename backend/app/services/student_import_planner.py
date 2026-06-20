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
    append_import_note,
    build_import_row_plan,
    classify_belt_creation_target,
    normalize_import_status,
    parse_import_date,
    resolve_belt_rank_reference,
    resolve_named_import_reference,
)


class StudentImportPlanner:
    def __init__(self, supabase: Optional[Client]):
        self.supabase = supabase

    def parse_import_date(
        self,
        raw_value: Optional[str],
        field_label: str,
    ) -> tuple[Optional[str], Optional[str]]:
        return parse_import_date(raw_value, field_label)

    def _parse_import_date(
        self,
        raw_value: Optional[str],
        field_label: str,
    ) -> tuple[Optional[str], Optional[str]]:
        return self.parse_import_date(raw_value, field_label)

    def build_named_record_lookup(
        self,
        table_name: str,
        studio_id: str,
    ) -> tuple[set[str], dict[str, str], set[str]]:
        result = (
            self.supabase.table(table_name)
            .select("id, name")
            .eq("studio_id", studio_id)
            .execute()
        )

        id_lookup: set[str] = set()
        name_lookup: dict[str, str] = {}
        ambiguous_names: set[str] = set()

        for row in result.data or []:
            record_id = row.get("id")
            record_name = row.get("name")
            if not record_id or not record_name:
                continue

            id_lookup.add(record_id)
            normalized_name = normalize_header(record_name)
            if not normalized_name:
                continue

            if normalized_name in name_lookup and name_lookup[normalized_name] != record_id:
                ambiguous_names.add(normalized_name)
                name_lookup.pop(normalized_name, None)
                continue

            if normalized_name not in ambiguous_names:
                name_lookup[normalized_name] = record_id

        return id_lookup, name_lookup, ambiguous_names

    def _build_named_record_lookup(
        self,
        table_name: str,
        studio_id: str,
    ) -> tuple[set[str], dict[str, str], set[str]]:
        return self.build_named_record_lookup(table_name, studio_id)

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
        name_lookup: dict[str, str] = {}
        ambiguous_names: set[str] = set()
        rank_meta: dict[str, dict[str, Optional[str]]] = {}
        rank_ids_by_name: dict[str, list[str]] = defaultdict(list)
        program_rank_name_lookup: dict[str, dict[str, list[str]]] = defaultdict(lambda: defaultdict(list))
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
                if normalized_name in name_lookup and name_lookup[normalized_name] != record_id:
                    ambiguous_names.add(normalized_name)
                    name_lookup.pop(normalized_name, None)
                elif normalized_name not in ambiguous_names:
                    name_lookup[normalized_name] = record_id

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
            "name_lookup": name_lookup,
            "ambiguous_names": ambiguous_names,
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
            "rank_count": len(rank_meta),
        }

    def _build_belt_rank_lookup(self, studio_id: str) -> dict[str, Any]:
        return self.build_belt_rank_lookup(studio_id)

    def resolve_belt_rank_reference(
        self,
        raw_value: Optional[str],
        *,
        resolved_program_id: Optional[str],
        raw_program_value: Optional[str],
        belt_rank_lookup: dict[str, Any],
    ) -> tuple[Optional[str], Optional[str], Optional[str]]:
        return resolve_belt_rank_reference(
            raw_value,
            resolved_program_id=resolved_program_id,
            raw_program_value=raw_program_value,
            belt_rank_lookup=belt_rank_lookup,
        )

    def _resolve_belt_rank_reference(
        self,
        raw_value: Optional[str],
        *,
        resolved_program_id: Optional[str],
        raw_program_value: Optional[str],
        belt_rank_lookup: dict[str, Any],
    ) -> tuple[Optional[str], Optional[str], Optional[str]]:
        return self.resolve_belt_rank_reference(
            raw_value,
            resolved_program_id=resolved_program_id,
            raw_program_value=raw_program_value,
            belt_rank_lookup=belt_rank_lookup,
        )

    def classify_belt_creation_target(
        self,
        *,
        resolved_program_id: Optional[str],
        pending_program_name: Optional[str],
        raw_program_value: Optional[str],
        options: CsvImportOptions,
        belt_rank_lookup: dict[str, Any],
    ) -> dict[str, Any]:
        return classify_belt_creation_target(
            resolved_program_id=resolved_program_id,
            pending_program_name=pending_program_name,
            raw_program_value=raw_program_value,
            options=options,
            belt_rank_lookup=belt_rank_lookup,
        )

    def _classify_belt_creation_target(
        self,
        *,
        resolved_program_id: Optional[str],
        pending_program_name: Optional[str],
        raw_program_value: Optional[str],
        options: CsvImportOptions,
        belt_rank_lookup: dict[str, Any],
    ) -> dict[str, Any]:
        return self.classify_belt_creation_target(
            resolved_program_id=resolved_program_id,
            pending_program_name=pending_program_name,
            raw_program_value=raw_program_value,
            options=options,
            belt_rank_lookup=belt_rank_lookup,
        )

    def resolve_named_import_reference(
        self,
        raw_value: Optional[str],
        *,
        label: str,
        id_lookup: set[str],
        name_lookup: dict[str, str],
        ambiguous_names: set[str],
    ) -> tuple[Optional[str], Optional[str], Optional[str]]:
        return resolve_named_import_reference(
            raw_value,
            label=label,
            id_lookup=id_lookup,
            name_lookup=name_lookup,
            ambiguous_names=ambiguous_names,
        )

    def _resolve_named_import_reference(
        self,
        raw_value: Optional[str],
        *,
        label: str,
        id_lookup: set[str],
        name_lookup: dict[str, str],
        ambiguous_names: set[str],
    ) -> tuple[Optional[str], Optional[str], Optional[str]]:
        return self.resolve_named_import_reference(
            raw_value,
            label=label,
            id_lookup=id_lookup,
            name_lookup=name_lookup,
            ambiguous_names=ambiguous_names,
        )

    def append_import_note(self, existing: Optional[str], note: str) -> str:
        return append_import_note(existing, note)

    def _append_import_note(self, existing: Optional[str], note: str) -> str:
        return self.append_import_note(existing, note)

    def normalize_import_status(
        self,
        raw_value: Optional[str],
        options: CsvImportOptions,
        issues: list[CsvImportIssue],
    ) -> Optional[str]:
        return normalize_import_status(raw_value, options, issues)

    def _normalize_import_status(
        self,
        raw_value: Optional[str],
        options: CsvImportOptions,
        issues: list[CsvImportIssue],
    ) -> Optional[str]:
        return self.normalize_import_status(raw_value, options, issues)

    def build_import_row_plan(
        self,
        raw_row: dict,
        mapping: dict[str, str],
        *,
        options: CsvImportOptions,
        program_lookup: Optional[tuple[set[str], dict[str, str], set[str]]] = None,
        belt_rank_lookup: Optional[dict[str, Any]] = None,
    ) -> dict[str, Any]:
        return build_import_row_plan(
            raw_row,
            mapping,
            options=options,
            program_lookup=program_lookup,
            belt_rank_lookup=belt_rank_lookup,
        )

    def _build_import_row_plan(
        self,
        raw_row: dict,
        mapping: dict[str, str],
        *,
        options: CsvImportOptions,
        program_lookup: Optional[tuple[set[str], dict[str, str], set[str]]] = None,
        belt_rank_lookup: Optional[dict[str, Any]] = None,
    ) -> dict[str, Any]:
        return self.build_import_row_plan(
            raw_row,
            mapping,
            options=options,
            program_lookup=program_lookup,
            belt_rank_lookup=belt_rank_lookup,
        )

    def build_import_result(
        self,
        rows: list[dict[str, Any]],
        *,
        total_rows: int,
    ) -> CsvImportResult:
        return build_import_result(rows, total_rows=total_rows)

    def _build_import_result(
        self,
        rows: list[dict[str, Any]],
        *,
        total_rows: int,
    ) -> CsvImportResult:
        return self.build_import_result(rows, total_rows=total_rows)

    def prepare_import(
        self,
        rows: list[dict],
        mapping: dict[str, str],
        studio_id: Optional[str],
        options: CsvImportOptions,
    ) -> tuple[CsvImportResult, list[dict[str, Any]]]:
        validate_csv_import_mapping(mapping)
        program_lookup = self.build_named_record_lookup("programs", studio_id) if studio_id else None
        belt_rank_lookup = self.build_belt_rank_lookup(studio_id) if studio_id else None

        planned_rows: list[dict[str, Any]] = []
        for i, raw_row in enumerate(rows, start=2):
            row_plan = self.build_import_row_plan(
                raw_row,
                mapping,
                options=options,
                program_lookup=program_lookup,
                belt_rank_lookup=belt_rank_lookup,
            )
            row_plan["row_number"] = i
            planned_rows.append(row_plan)

        return self.build_import_result(planned_rows, total_rows=len(rows)), planned_rows

    def _prepare_import(
        self,
        rows: list[dict],
        mapping: dict[str, str],
        studio_id: Optional[str],
        options: CsvImportOptions,
    ) -> tuple[CsvImportResult, list[dict[str, Any]]]:
        return self.prepare_import(rows, mapping, studio_id, options)

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
        result = self.build_import_result(planned_rows, total_rows=total_rows)
        result.created_programs = created_programs or []
        result.created_ladders = created_ladders or []
        result.created_belts = created_belts or []
        result.imported_without_belt_count = imported_without_belt_count
        result.imported_count = imported_count
        result.idempotency_key = idempotency_key
        return result

    def _hydrate_import_result(
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
        return self.hydrate_import_result(
            planned_rows,
            total_rows=total_rows,
            created_programs=created_programs,
            created_ladders=created_ladders,
            created_belts=created_belts,
            imported_without_belt_count=imported_without_belt_count,
            imported_count=imported_count,
            idempotency_key=idempotency_key,
        )
