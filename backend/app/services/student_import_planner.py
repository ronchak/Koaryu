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
from app.services.student_import_ids import deterministic_import_uuid
from app.services.student_import_matching import build_duplicate_review, match_rows
from app.services.student_import_plan_result import build_import_result
from app.services.student_import_plan_rows import (
    build_import_row_plan,
)
from app.services.studio_business_date import studio_today_for_studio

ROSTER_PAGE_SIZE = 1000
ROSTER_FILTER_BATCH_SIZE = 200


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

    def build_existing_roster(
        self,
        studio_id: str,
        *,
        completed_student_ids: Optional[dict[str, int]] = None,
    ) -> list[dict[str, Any]]:
        """Studio-scoped roster facts used only for duplicate review.

        Every query carries the studio filter. ``student_guardians`` has no
        studio column, so its links are selected by the studio's own student
        ids and the guardians are filtered by studio again. Archived students
        stay in the roster so a returning student is surfaced as a decision
        rather than silently created twice.
        """
        students: list[dict[str, Any]] = []
        offset = 0
        while True:
            page = (
                self.supabase.table("students")
                .select(
                    "id, legal_first_name, legal_last_name, preferred_name, date_of_birth, "
                    "email, phone, deleted_at"
                )
                .eq("studio_id", studio_id)
                .order("id")
                .range(offset, offset + ROSTER_PAGE_SIZE - 1)
                .execute()
            )
            batch = [row for row in (page.data or []) if row.get("id")]
            students.extend(batch)
            if len(batch) < ROSTER_PAGE_SIZE:
                break
            offset += ROSTER_PAGE_SIZE

        guardian_ids_by_student: dict[str, list[str]] = defaultdict(list)
        student_ids = [str(row["id"]) for row in students]
        for start in range(0, len(student_ids), ROSTER_FILTER_BATCH_SIZE):
            chunk = student_ids[start : start + ROSTER_FILTER_BATCH_SIZE]
            links = (
                self.supabase.table("student_guardians")
                .select("student_id, guardian_id")
                .in_("student_id", chunk)
                .execute()
            )
            for link in links.data or []:
                if link.get("student_id") and link.get("guardian_id"):
                    guardian_ids_by_student[str(link["student_id"])].append(
                        str(link["guardian_id"])
                    )

        guardians: dict[str, dict[str, Any]] = {}
        guardian_ids = sorted({gid for ids in guardian_ids_by_student.values() for gid in ids})
        for start in range(0, len(guardian_ids), ROSTER_FILTER_BATCH_SIZE):
            chunk = guardian_ids[start : start + ROSTER_FILTER_BATCH_SIZE]
            result = (
                self.supabase.table("guardians")
                .select("id, first_name, last_name, email, phone")
                .eq("studio_id", studio_id)
                .in_("id", chunk)
                .execute()
            )
            for guardian in result.data or []:
                if guardian.get("id"):
                    guardians[str(guardian["id"])] = guardian

        completed = completed_student_ids or {}
        roster: list[dict[str, Any]] = []
        for row in students:
            student_id = str(row["id"])
            entry: dict[str, Any] = {
                "key": student_id,
                "legal_first_name": row.get("legal_first_name"),
                "legal_last_name": row.get("legal_last_name"),
                "preferred_name": row.get("preferred_name"),
                "date_of_birth": row.get("date_of_birth"),
                "email": row.get("email"),
                "phone": row.get("phone"),
                "archived": bool(row.get("deleted_at")),
                "guardians": [
                    {
                        "key": gid,
                        "first_name": guardians[gid].get("first_name"),
                        "last_name": guardians[gid].get("last_name"),
                        "email": guardians[gid].get("email"),
                        "phone": guardians[gid].get("phone"),
                    }
                    for gid in guardian_ids_by_student.get(student_id, [])
                    if gid in guardians
                ],
            }
            if student_id in completed:
                entry["import_row_number"] = completed[student_id]
            roster.append(entry)
        return roster

    def prepare_import(
        self,
        rows: list[dict],
        mapping: dict[str, str],
        studio_id: Optional[str],
        options: CsvImportOptions,
        receipts: Optional[dict[str, dict[str, Any]]] = None,
        *,
        import_run_id: Optional[str] = None,
    ) -> tuple[CsvImportResult, list[dict[str, Any]]]:
        validate_csv_import_mapping(mapping)
        receipts = receipts or {}
        unfinished = any(str(i) not in receipts.get("student", {}) for i in range(2, len(rows) + 2))
        has_birth_dates = any(
            field == "date_of_birth" and any(row.get(column) for row in rows)
            for column, field in mapping.items()
        )
        business_date = (
            studio_today_for_studio(self.supabase, studio_id)
            if studio_id and unfinished and has_birth_dates
            else None
        )
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
                business_date=business_date,
            )
            row_plan["row_number"] = i
            planned_rows.append(row_plan)

        if unfinished:
            self.attach_duplicate_review(
                planned_rows, studio_id=studio_id, import_run_id=import_run_id
            )

        return build_import_result(planned_rows, total_rows=len(rows)), planned_rows

    def attach_duplicate_review(
        self,
        planned_rows: list[dict[str, Any]],
        *,
        studio_id: Optional[str],
        import_run_id: Optional[str] = None,
    ) -> list[dict[str, Any]]:
        """Run duplicate review over the rows and attach the outcome to each row.

        In-file review needs no studio. Existing-student review loads the roster
        fresh on every call, so execution sees what is there at execution start
        rather than what preview saw.
        """
        roster: list[dict[str, Any]] = []
        if studio_id and self.supabase is not None:
            completed_ids: dict[str, int] = {}
            if import_run_id:
                for row in planned_rows:
                    if row.get("completed"):
                        completed_ids[
                            deterministic_import_uuid(
                                import_run_id, "student-row", str(row["row_number"])
                            )
                        ] = int(row["row_number"])
            roster = self.build_existing_roster(studio_id, completed_student_ids=completed_ids)
        matches = {match.row_number: match for match in match_rows(planned_rows, roster)}
        for row in planned_rows:
            if row.get("completed"):
                continue
            match = matches[int(row["row_number"])]
            row["match"] = match
            row["duplicate_review"] = build_duplicate_review(match)
        return roster

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
        skipped_rows: int = 0,
        idempotency_key: Optional[str] = None,
    ) -> CsvImportResult:
        result = build_import_result(planned_rows, total_rows=total_rows)
        result.created_programs = created_programs or []
        result.created_ladders = created_ladders or []
        result.created_belts = created_belts or []
        result.imported_without_belt_count = imported_without_belt_count
        result.imported_count = imported_count
        result.skipped_rows = skipped_rows
        result.idempotency_key = idempotency_key
        return result
