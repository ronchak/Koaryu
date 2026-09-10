from __future__ import annotations

from collections import defaultdict
from typing import Any

from supabase import Client

from app.services.student_import_csv import belt_import_sort_key, infer_belt_color_hex, make_import_issue, normalize_header
from app.services.student_import_ids import deterministic_import_uuid
from app.services.student_import_planner import StudentImportPlanner
from app.services.supabase_rpc import execute_required_rpc, first_rpc_row


class StudentImportSetupWriter:
    """Prepare only valid unfinished rows; SQL owns each confirmed setup outcome."""

    def __init__(self, supabase: Client):
        self.supabase = supabase

    def prepare(
        self,
        planned_rows: list[dict[str, Any]],
        *,
        studio_id: str,
        import_run_id: str,
        processing_token: str,
        receipts: dict[str, dict[str, Any]],
    ) -> None:
        unfinished = [row for row in planned_rows if row["is_valid"] and not row.get("completed")]
        programs = receipts.setdefault("program", {})
        requested: dict[str, str] = {}
        for row in unfinished:
            if name := row.get("pending_program_name"):
                requested.setdefault(normalize_header(name), name.strip())
            elif not row.get("resolved_program_id"):
                requested.setdefault("__unassigned__", "Unassigned")
        for key, name in requested.items():
            if key in programs:
                continue
            program_id = deterministic_import_uuid(import_run_id, "program", key)
            result = first_rpc_row(execute_required_rpc(self.supabase, "prepare_student_import_program_v1", {
                "p_studio_id": studio_id,
                "p_import_run_id": import_run_id,
                "p_processing_token": processing_token,
                "p_key": key,
                "p_program_id": program_id,
                "p_name": name,
                "p_ladder_id": deterministic_import_uuid(import_run_id, "ladder", program_id),
                "p_unassigned": key == "__unassigned__",
            }))
            if not result or not result.get("program_id"):
                raise RuntimeError("Import program setup returned no confirmed identity")
            programs[key] = result
        for row in unfinished:
            name = row.get("pending_program_name")
            if name:
                row["resolved_program_id"] = programs[normalize_header(name)]["program_id"]
            elif not row.get("resolved_program_id"):
                row["resolved_program_id"] = programs["__unassigned__"]["program_id"]

        pending_belts = [row for row in unfinished if row.get("pending_belt_name")]
        if not pending_belts:
            return
        lookup = StudentImportPlanner(self.supabase).build_belt_rank_lookup(studio_id)
        by_program: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for row in pending_belts:
            by_program[row["resolved_program_id"]].append(row)
        confirmed_ladders = receipts.setdefault("ladder", {})
        confirmed_ranks = receipts.setdefault("rank", {})
        default_ladders = {value["program_id"]: value["ladder_id"] for value in programs.values() if value.get("ladder_id")}
        for program_id, rows in by_program.items():
            current_ladders = lookup["ladders_by_program"].get(program_id, [])
            confirmed = confirmed_ladders.get(program_id)
            ladder_id = (confirmed or {}).get("ladder_id") or default_ladders.get(program_id)
            create_ladder = False
            if not ladder_id:
                if len(current_ladders) > 1:
                    self._reject(rows, "ambiguous_belt_ladder", "This program has multiple belt ladders. Choose one in Belt Tracker before importing these belts.")
                    continue
                ladder_id = current_ladders[0] if current_ladders else deterministic_import_uuid(import_run_id, "ladder", program_id)
                create_ladder = not current_ladders
            elif ladder_id not in current_ladders:
                self._reject(rows, "unavailable_belt_ladder", "The ladder confirmed by this import is no longer available. Reconcile its saved setup before importing these belts.")
                continue

            requests: dict[str, dict[str, Any]] = {}
            for row in rows:
                name = row["pending_belt_name"].strip()
                key = normalize_header(name)
                existing = lookup["program_rank_name_lookup"].get(program_id, {}).get(key, [])
                if len(existing) > 1:
                    self._reject([row], "ambiguous_belt", "This belt name matches multiple ranks in its program. Choose an unambiguous belt before importing this row.")
                    continue
                requests.setdefault(key, {
                    "key": key,
                    "name": name,
                    "id": deterministic_import_uuid(import_run_id, "belt", f"{ladder_id}:{key}"),
                    "existing_id": existing[0] if existing else None,
                    "color_hex": infer_belt_color_hex(name),
                })
            if not requests:
                continue
            ordered = sorted(requests.values(), key=lambda request: belt_import_sort_key(request["name"]))
            result = first_rpc_row(execute_required_rpc(self.supabase, "prepare_student_import_belts_v1", {
                "p_studio_id": studio_id,
                "p_import_run_id": import_run_id,
                "p_processing_token": processing_token,
                "p_program_id": program_id,
                "p_ladder_id": ladder_id,
                "p_ranks": ordered,
                "p_create_ladder": create_ladder,
            }))
            if not result or len(result.get("ranks", [])) != len(ordered):
                raise RuntimeError("Import belt setup returned incomplete outcomes")
            confirmed_ladders[program_id] = result["ladder"]
            for request, rank in zip(ordered, result["ranks"], strict=True):
                confirmed_ranks[f"{ladder_id}:{request['key']}"] = rank
            for row in rows:
                if row["is_valid"]:
                    key = f"{ladder_id}:{normalize_header(row['pending_belt_name'])}"
                    row["resolved_belt_rank_id"] = confirmed_ranks[key]["rank_id"]

    @staticmethod
    def _reject(rows: list[dict[str, Any]], code: str, message: str) -> None:
        for row in rows:
            row["issues"].append(make_import_issue(code, message, field="current_belt_rank_id"))
            row["is_valid"] = False
