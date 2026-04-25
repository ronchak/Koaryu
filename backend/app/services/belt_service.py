import json
import re
from typing import Any, Callable, Optional
from datetime import datetime, timezone
from supabase import Client
from fastapi import HTTPException
from postgrest.exceptions import APIError as PostgrestAPIError
from app.schemas.belt import (
    BeltLadderCreate, BeltLadderUpdate, BeltLadderSyncRequest, BeltLadderResponse,
    BeltRankCreate, BeltRankUpdate, BeltRankResponse,
    PromoteStudent, PromotionResponse,
    EligibilityEntry,
)
from app.services.studio_scope import ensure_optional_studio_record, ensure_studio_record
from app.services.program_service import ProgramService


class BeltService:
    def __init__(self, supabase: Client):
        self.supabase = supabase

    def _build_ladder_response(self, ladder_row: dict[str, Any]) -> BeltLadderResponse:
        ladder_copy = dict(ladder_row)
        ranks_data = ladder_copy.pop("ranks", None)
        if ranks_data is None:
            ranks_data = ladder_copy.pop("belt_ranks", []) or []
        if isinstance(ranks_data, str):
            ranks_data = json.loads(ranks_data)
        ranks = sorted(
            [BeltRankResponse(**rank) for rank in ranks_data],
            key=lambda item: item.display_order,
        )
        return BeltLadderResponse(**ladder_copy, ranks=ranks)

    def _build_synced_ladder_response(self, rpc_data: Any) -> BeltLadderResponse:
        if isinstance(rpc_data, list):
            if not rpc_data:
                raise HTTPException(status_code=500, detail="Failed to sync belt ladder")
            ladder_row = rpc_data[0]
        elif isinstance(rpc_data, dict):
            ladder_row = rpc_data
        else:
            raise HTTPException(status_code=500, detail="Failed to sync belt ladder")

        if not isinstance(ladder_row, dict):
            raise HTTPException(status_code=500, detail="Failed to sync belt ladder")

        return self._build_ladder_response(ladder_row)

    def _raise_sync_error(self, exc: Exception) -> None:
        detail = getattr(exc, "message", None) or str(exc) or "Failed to sync belt ladder"
        detail_lower = detail.lower()

        if "belt ladder not found" in detail_lower:
            status_code = 404
        elif any(
            token in detail_lower
            for token in (
                "referenced rank",
                "duplicate",
                "payload must be",
                "rank name is required",
                "must be non-negative",
                "invalid",
            )
        ):
            status_code = 400
        else:
            status_code = 500

        raise HTTPException(status_code=status_code, detail=detail) from exc

    async def _get_ladder(self, ladder_id: str, studio_id: str) -> BeltLadderResponse:
        result = (
            self.supabase.table("belt_ladders")
            .select("*, belt_ranks(*)")
            .eq("id", ladder_id)
            .eq("studio_id", studio_id)
            .single()
            .execute()
        )
        if not result.data:
            raise HTTPException(status_code=404, detail="Belt ladder not found")
        return self._build_ladder_response(result.data)

    def _get_ladder_row(self, ladder_id: str, studio_id: str) -> dict[str, Any]:
        result = (
            self.supabase.table("belt_ladders")
            .select("*")
            .eq("id", ladder_id)
            .eq("studio_id", studio_id)
            .single()
            .execute()
        )
        if not result.data:
            raise HTTPException(status_code=404, detail="Belt ladder not found")
        return result.data

    # ---- Ladders ----

    async def list_ranks(
        self, studio_id: str, ladder_id: Optional[str] = None
    ) -> list[BeltRankResponse]:
        query = (
            self.supabase.table("belt_ranks")
            .select("*")
            .eq("studio_id", studio_id)
            .order("ladder_id")
            .order("display_order")
        )
        if ladder_id:
            query = query.eq("ladder_id", ladder_id)

        result = query.execute()
        return [BeltRankResponse(**rank) for rank in (result.data or [])]

    async def list_ladders(self, studio_id: str) -> list[BeltLadderResponse]:
        ProgramService(self.supabase).ensure_program_ladders(studio_id)
        active_program_rows = (
            self.supabase.table("programs")
            .select("id, is_system, archived_at")
            .eq("studio_id", studio_id)
            .execute()
        )
        visible_program_ids = {
            row["id"]
            for row in (active_program_rows.data or [])
            if row.get("id") and not row.get("is_system") and not row.get("archived_at")
        }
        if not visible_program_ids:
            return []

        result = (
            self.supabase.table("belt_ladders")
            .select("*, belt_ranks(*)")
            .eq("studio_id", studio_id)
            .in_("program_id", list(visible_program_ids))
            .order("created_at")
            .execute()
        )
        return [self._build_ladder_response(row) for row in (result.data or [])]

    async def list_promotions(
        self,
        studio_id: str,
        student_id: Optional[str] = None,
        include_names: bool = True,
    ) -> list[PromotionResponse]:
        query = (
            self.supabase.table("promotions")
            .select("*")
            .eq("studio_id", studio_id)
            .order("promoted_at", desc=True)
        )
        if student_id:
            query = query.eq("student_id", student_id)

        result = query.execute()
        promotion_rows = result.data or []

        if not promotion_rows:
            return []

        if not include_names:
            return [PromotionResponse(**row) for row in promotion_rows]

        student_ids = sorted(
            {
                row["student_id"]
                for row in promotion_rows
                if row.get("student_id")
            }
        )
        rank_ids = sorted(
            {
                rank_id
                for row in promotion_rows
                for rank_id in (row.get("from_rank_id"), row.get("to_rank_id"))
                if rank_id
            }
        )

        students_by_id: dict[str, str] = {}
        ranks_by_id: dict[str, str] = {}

        if student_ids:
            students_result = (
                self.supabase.table("students")
                .select("id, legal_first_name, legal_last_name, preferred_name")
                .in_("id", student_ids)
                .eq("studio_id", studio_id)
                .execute()
            )
            students_by_id = {
                row["id"]: f'{row.get("preferred_name") or row.get("legal_first_name") or ""} {row.get("legal_last_name") or ""}'.strip()
                for row in (students_result.data or [])
            }

        if rank_ids:
            ranks_result = (
                self.supabase.table("belt_ranks")
                .select("id, name")
                .in_("id", rank_ids)
                .eq("studio_id", studio_id)
                .execute()
            )
            ranks_by_id = {
                row["id"]: row["name"]
                for row in (ranks_result.data or [])
            }

        return [
            PromotionResponse(
                **row,
                student_name=students_by_id.get(row["student_id"]),
                from_rank_name=ranks_by_id.get(row.get("from_rank_id")),
                to_rank_name=ranks_by_id.get(row["to_rank_id"]),
            )
            for row in promotion_rows
        ]

    async def create_ladder(
        self, data: BeltLadderCreate, studio_id: str, actor_id: str
    ) -> BeltLadderResponse:
        row = data.model_dump()
        program_id = row.get("program_id")
        if not program_id:
            raise HTTPException(
                status_code=400,
                detail="Create a program first. Each program owns exactly one belt configuration.",
            )
        ProgramService(self.supabase).ensure_program_active(studio_id, program_id)
        existing = (
            self.supabase.table("belt_ladders")
            .select("*, belt_ranks(*)")
            .eq("studio_id", studio_id)
            .eq("program_id", program_id)
            .order("created_at")
            .execute()
        )
        existing_rows = existing.data or []
        if existing_rows:
            raise HTTPException(
                status_code=409,
                detail="This program already has a belt configuration. Edit the existing program ranks instead of creating another one.",
            )
        row["studio_id"] = studio_id
        result = self.supabase.table("belt_ladders").insert(row).execute()
        if not result.data:
            raise HTTPException(status_code=500, detail="Failed to create ladder")

        self.supabase.table("audit_logs").insert({
            "studio_id": studio_id,
            "actor_id": actor_id,
            "action": "belt_ladder.created",
            "entity_type": "belt_ladder",
            "entity_id": result.data[0]["id"],
            "metadata": {"name": data.name},
        }).execute()

        return BeltLadderResponse(**result.data[0], ranks=[])

    async def update_ladder(
        self,
        ladder_id: str,
        data: BeltLadderUpdate,
        studio_id: str,
        actor_id: str,
    ) -> BeltLadderResponse:
        update_dict = data.model_dump(exclude_unset=True)
        if not update_dict:
            raise HTTPException(status_code=400, detail="No fields to update")

        ensure_studio_record(
            self.supabase,
            "belt_ladders",
            ladder_id,
            studio_id,
            "Belt ladder not found",
        )
        ProgramService(self.supabase).ensure_program_active(studio_id, update_dict.get("program_id"))
        current_ladder = self._get_ladder_row(ladder_id, studio_id)
        if "program_id" in update_dict and update_dict.get("program_id") != current_ladder.get("program_id"):
            raise HTTPException(
                status_code=409,
                detail="A belt configuration cannot be moved to another program.",
            )
        if update_dict.get("program_id"):
            existing = (
                self.supabase.table("belt_ladders")
                .select("id")
                .eq("studio_id", studio_id)
                .eq("program_id", update_dict["program_id"])
                .neq("id", ladder_id)
                .order("created_at")
                .execute()
            )
            if existing.data:
                raise HTTPException(
                    status_code=409,
                    detail="This program already has a belt ladder. Edit the existing ladder instead of assigning a second ladder to the same program.",
                )

        result = (
            self.supabase.table("belt_ladders")
            .update(update_dict)
            .eq("id", ladder_id)
            .eq("studio_id", studio_id)
            .execute()
        )
        if not result.data:
            raise HTTPException(status_code=404, detail="Belt ladder not found")

        updated_ladder = result.data[0]
        if update_dict.get("name") and updated_ladder.get("program_id"):
            try:
                (
                    self.supabase.table("programs")
                    .update({"name": update_dict["name"]})
                    .eq("id", updated_ladder["program_id"])
                    .eq("studio_id", studio_id)
                    .execute()
                )
            except PostgrestAPIError:
                pass

        self.supabase.table("audit_logs").insert({
            "studio_id": studio_id,
            "actor_id": actor_id,
            "action": "belt_ladder.updated",
            "entity_type": "belt_ladder",
            "entity_id": ladder_id,
            "metadata": update_dict,
        }).execute()

        ranks = await self.list_ranks(studio_id, ladder_id)
        return BeltLadderResponse(**result.data[0], ranks=ranks)

    async def sync_ladder(
        self,
        ladder_id: str,
        data: BeltLadderSyncRequest,
        studio_id: str,
        actor_id: str,
    ) -> BeltLadderResponse:
        ensure_studio_record(
            self.supabase,
            "belt_ladders",
            ladder_id,
            studio_id,
            "Belt ladder not found",
        )

        sub_rank_term = data.sub_rank_term.strip() if data.sub_rank_term is not None else None
        if sub_rank_term == "":
            sub_rank_term = None

        sync_payload = [
            {
                "id": rank.id,
                "name": rank.name,
                "color_hex": rank.color_hex,
                "display_order": index,
                "min_classes": rank.min_classes,
                "min_months": rank.min_months,
                "requires_approval": rank.requires_approval,
                "is_tip": rank.is_tip,
                "tip_color_hex": rank.tip_color_hex if rank.is_tip else None,
            }
            for index, rank in enumerate(data.ranks)
        ]

        try:
            result = self.supabase.rpc(
                "sync_belt_ladder_ranks",
                {
                    "p_ladder_id": ladder_id,
                    "p_studio_id": studio_id,
                    "p_sub_rank_term": sub_rank_term,
                    "p_ranks": sync_payload,
                },
            ).execute()
        except Exception as exc:
            self._raise_sync_error(exc)

        self.supabase.table("audit_logs").insert({
            "studio_id": studio_id,
            "actor_id": actor_id,
            "action": "belt_ladder.synced",
            "entity_type": "belt_ladder",
            "entity_id": ladder_id,
            "metadata": {
                "rank_count": len(sync_payload),
                "sub_rank_term": sub_rank_term,
            },
        }).execute()

        return self._build_synced_ladder_response(result.data)

    # ---- Ranks ----

    async def create_rank(
        self, ladder_id: str, data: BeltRankCreate, studio_id: str
    ) -> BeltRankResponse:
        ensure_studio_record(
            self.supabase,
            "belt_ladders",
            ladder_id,
            studio_id,
            "Belt ladder not found",
        )
        row = data.model_dump()
        row["ladder_id"] = ladder_id
        row["studio_id"] = studio_id
        result = self.supabase.table("belt_ranks").insert(row).execute()
        if not result.data:
            raise HTTPException(status_code=500, detail="Failed to create rank")
        return BeltRankResponse(**result.data[0])

    async def update_rank(
        self, rank_id: str, data: BeltRankUpdate, studio_id: str
    ) -> BeltRankResponse:
        update_dict = data.model_dump(exclude_unset=True)
        result = (
            self.supabase.table("belt_ranks")
            .update(update_dict)
            .eq("id", rank_id)
            .eq("studio_id", studio_id)
            .execute()
        )
        if not result.data:
            raise HTTPException(status_code=404, detail="Rank not found")
        return BeltRankResponse(**result.data[0])

    async def delete_rank(self, rank_id: str, studio_id: str) -> None:
        self.supabase.table("belt_ranks").delete().eq("id", rank_id).eq("studio_id", studio_id).execute()

    # ---- Eligibility ----

    @staticmethod
    def _chunked(values: list[str], size: int = 100) -> list[list[str]]:
        return [values[index:index + size] for index in range(0, len(values), size)]

    @staticmethod
    def _parse_datetime(value: Any) -> datetime:
        if isinstance(value, datetime):
            parsed = value
        else:
            normalized = str(value).strip().replace("Z", "+00:00")
            try:
                parsed = datetime.fromisoformat(normalized)
            except ValueError:
                # Supabase/PostgREST can return timestamptz values with fewer than
                # six fractional-second digits. Python 3.9's fromisoformat is picky
                # about that shape, so normalize the fraction before parsing.
                match = re.match(
                    r"^(?P<head>.*T\d{2}:\d{2}:\d{2})\.(?P<fraction>\d+)(?P<tz>[+-]\d{2}:?\d{2})?$",
                    normalized,
                )
                if not match:
                    raise

                fraction = (match.group("fraction") + "000000")[:6]
                timezone_suffix = match.group("tz") or ""
                if timezone_suffix and ":" not in timezone_suffix:
                    timezone_suffix = f"{timezone_suffix[:3]}:{timezone_suffix[3:]}"
                parsed = datetime.fromisoformat(f"{match.group('head')}.{fraction}{timezone_suffix}")
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed

    def _fetch_paged(
        self,
        query_factory: Callable[[], Any],
        page_size: int = 1000,
    ) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        offset = 0
        while True:
            result = query_factory().range(offset, offset + page_size - 1).execute()
            batch = result.data or []
            rows.extend(batch)
            if len(batch) < page_size:
                break
            offset += page_size
        return rows

    def _fetch_latest_promotions_by_context(
        self,
        studio_id: str,
        eligibility_contexts: list[dict[str, Any]],
    ) -> dict[str, Optional[str]]:
        latest_promotions: dict[str, Optional[str]] = {}
        unique_student_ids = sorted({
            context["student"]["id"]
            for context in eligibility_contexts
            if context.get("student", {}).get("id")
        })

        for student_id_chunk in self._chunked(unique_student_ids):
            promotion_rows = self._fetch_paged(
                lambda student_id_chunk=student_id_chunk: (
                    self.supabase.table("promotions")
                    .select("student_id, student_program_membership_id, program_id, promoted_at")
                    .eq("studio_id", studio_id)
                    .in_("student_id", student_id_chunk)
                    .order("promoted_at", desc=True)
                )
            )

            for context in eligibility_contexts:
                context_key = context["context_key"]
                student_id = context["student"]["id"]
                if student_id not in student_id_chunk or context_key in latest_promotions:
                    continue
                membership_id = context.get("membership_id")
                program_id = context.get("program_id")
                for row in promotion_rows:
                    if row.get("student_id") != student_id:
                        continue
                    if membership_id and row.get("student_program_membership_id") == membership_id:
                        latest_promotions[context_key] = row.get("promoted_at")
                        break
                    if program_id and row.get("program_id") == program_id:
                        latest_promotions[context_key] = row.get("promoted_at")
                        break
                    if not membership_id and not row.get("program_id"):
                        latest_promotions[context_key] = row.get("promoted_at")
                        break

        return latest_promotions

    def _fetch_attendance_counts_by_student(
        self,
        studio_id: str,
        eligibility_contexts: list[dict[str, Any]],
        latest_promotions_by_context: dict[str, Optional[str]],
        ladder_meta: dict[str, dict[str, Any]],
    ) -> dict[str, int]:
        contexts_by_student: dict[str, list[dict[str, Any]]] = {}
        for context in eligibility_contexts:
            student_id = context.get("student", {}).get("id")
            if student_id:
                contexts_by_student.setdefault(student_id, []).append(context)
        student_ids = sorted(contexts_by_student)
        attendance_counts = {context["context_key"]: 0 for context in eligibility_contexts}
        if not student_ids:
            return attendance_counts

        parsed_promotion_dates = {
            context_key: self._parse_datetime(promoted_at)
            for context_key, promoted_at in latest_promotions_by_context.items()
            if promoted_at
        }
        student_ids_with_promotions = [
            student_id for student_id in student_ids
            if any(context["context_key"] in parsed_promotion_dates for context in contexts_by_student[student_id])
        ]
        student_ids_with_promotion_set = set(student_ids_with_promotions)
        student_ids_without_promotions = [
            student_id for student_id in student_ids if student_id not in student_ids_with_promotion_set
        ]

        def build_attendance_query(student_id_chunk: list[str], lower_bound: Optional[str] = None) -> Any:
            query = (
                self.supabase.table("attendance")
                    .select("student_id, checked_in_at, counts_toward_eligibility, class_sessions!inner(program_id)")
                .eq("studio_id", studio_id)
                .in_("student_id", student_id_chunk)
                .neq("status", "absent")
            )
            if lower_bound:
                query = query.gte("checked_in_at", lower_bound)
            return query

        def process_attendance_rows(attendance_rows: list[dict[str, Any]]) -> None:
            for row in attendance_rows:
                student_id = row.get("student_id")
                contexts = contexts_by_student.get(student_id, [])
                if not student_id or not contexts:
                    continue

                class_session = row.get("class_sessions") or {}
                if isinstance(class_session, list):
                    class_session = class_session[0] if class_session else {}
                if row.get("counts_toward_eligibility") is False:
                    continue

                for context in contexts:
                    promotion_date = parsed_promotion_dates.get(context["context_key"])
                    if promotion_date:
                        checked_in_at = row.get("checked_in_at")
                        if not checked_in_at or self._parse_datetime(checked_in_at) < promotion_date:
                            continue

                    ladder_program_id = (
                        ladder_meta.get(context["target_ladder_id"]) or {}
                    ).get("program_id")
                    if ladder_program_id and class_session.get("program_id") != ladder_program_id:
                        continue

                    attendance_counts[context["context_key"]] += 1

        for student_id_chunk in self._chunked(student_ids_without_promotions):
            process_attendance_rows(
                self._fetch_paged(
                    lambda student_id_chunk=student_id_chunk: build_attendance_query(student_id_chunk)
                )
            )

        if student_ids_with_promotions:
            lower_bound = min(
                parsed_promotion_dates.values()
            ).isoformat()
            for student_id_chunk in self._chunked(student_ids_with_promotions):
                process_attendance_rows(
                    self._fetch_paged(
                        lambda student_id_chunk=student_id_chunk, lower_bound=lower_bound: (
                            build_attendance_query(student_id_chunk, lower_bound)
                        )
                    )
                )

        return attendance_counts

    async def get_eligibility(
        self, studio_id: str, ladder_id: Optional[str] = None
    ) -> list[EligibilityEntry]:
        """Compute promotion eligibility for all active students."""
        ladders_result = (
            self.supabase.table("belt_ladders")
            .select("id, name, program_id")
            .eq("studio_id", studio_id)
            .order("created_at")
            .execute()
        )
        ladder_rows = ladders_result.data or []
        ladder_meta = {
            row["id"]: row
            for row in ladder_rows
            if row.get("id")
        }

        if ladder_id and ladder_id not in ladder_meta:
            raise HTTPException(status_code=404, detail="Belt ladder not found")

        ranks_result = (
            self.supabase.table("belt_ranks")
            .select("*")
            .eq("studio_id", studio_id)
            .order("ladder_id")
            .order("display_order")
            .execute()
        )
        ranks = ranks_result.data or []

        if not ladder_meta or not ranks:
            return []

        ranks_by_ladder: dict[str, list[dict[str, Any]]] = {}
        rank_map: dict[str, dict[str, Any]] = {}
        ladders_by_program: dict[str, list[str]] = {}
        unscoped_ladder_ids: list[str] = []

        for ladder_key, ladder in ladder_meta.items():
            program_id = ladder.get("program_id")
            if program_id:
                ladders_by_program.setdefault(program_id, []).append(ladder_key)
            else:
                unscoped_ladder_ids.append(ladder_key)

        for rank in ranks:
            rank_id = rank.get("id")
            rank_ladder_id = rank.get("ladder_id")
            if not rank_id or not rank_ladder_id or rank_ladder_id not in ladder_meta:
                continue
            rank_map[rank_id] = rank
            ranks_by_ladder.setdefault(rank_ladder_id, []).append(rank)

        if ladder_id and ladder_id not in ranks_by_ladder:
            return []

        next_rank_map_by_ladder: dict[str, dict[str, dict[str, Any]]] = {}
        for rank_ladder_id, ladder_ranks in ranks_by_ladder.items():
            next_rank_map_by_ladder[rank_ladder_id] = {}
            for index, rank in enumerate(ladder_ranks[:-1]):
                next_rank_map_by_ladder[rank_ladder_id][rank["id"]] = ladder_ranks[index + 1]

        # Get active students with belt ranks
        students_result = (
            self.supabase.table("students")
            .select("id, legal_first_name, legal_last_name, preferred_name, membership_start_date, program_id, current_belt_rank_id")
            .eq("studio_id", studio_id)
            .eq("status", "active")
            .is_("deleted_at", "null")
            .execute()
        )
        student_ids = [row["id"] for row in (students_result.data or []) if row.get("id")]
        memberships_by_student: dict[str, list[dict[str, Any]]] = {}
        if student_ids:
            memberships_result = (
                self.supabase.table("student_program_memberships")
                .select("id, student_id, program_id, status, ended_at, started_at, current_belt_rank_id")
                .eq("studio_id", studio_id)
                .in_("student_id", student_ids)
                .in_("status", ["active", "paused"])
                .is_("ended_at", "null")
                .execute()
            )
            for membership in memberships_result.data or []:
                memberships_by_student.setdefault(membership["student_id"], []).append(membership)

        eligibility_contexts: list[dict[str, Any]] = []
        now = datetime.now(timezone.utc)
        selected_ladder = ladder_meta.get(ladder_id) if ladder_id else None
        studio_has_single_ladder = len(ladder_meta) == 1

        def add_context_for_program_state(
            s: dict[str, Any],
            *,
            membership_id: Optional[str],
            program_id_value: Optional[str],
            current_rank_id_value: Optional[str],
            started_at: Optional[str],
        ) -> None:
            current_rank_id = current_rank_id_value
            current_rank = rank_map.get(current_rank_id) if current_rank_id else None
            current_ladder_id = current_rank.get("ladder_id") if current_rank else None
            student_program_id = program_id_value

            target_ladder_id: Optional[str] = None

            if ladder_id:
                if current_ladder_id:
                    if current_ladder_id != ladder_id:
                        return
                    target_ladder_id = ladder_id
                elif selected_ladder and selected_ladder.get("program_id"):
                    if student_program_id != selected_ladder.get("program_id"):
                        return
                    target_ladder_id = ladder_id
                elif studio_has_single_ladder:
                    target_ladder_id = ladder_id
                elif student_program_id:
                    return
                elif len(unscoped_ladder_ids) == 1 and unscoped_ladder_ids[0] == ladder_id:
                    target_ladder_id = ladder_id
                else:
                    return
            else:
                if current_ladder_id:
                    target_ladder_id = current_ladder_id
                elif student_program_id:
                    program_ladders = ladders_by_program.get(student_program_id, [])
                    if len(program_ladders) == 1:
                        target_ladder_id = program_ladders[0]
                    else:
                        return
                elif studio_has_single_ladder:
                    target_ladder_id = next(iter(ladder_meta))
                elif len(unscoped_ladder_ids) == 1:
                    target_ladder_id = unscoped_ladder_ids[0]
                else:
                    return

            if not target_ladder_id:
                return

            ladder_ranks = ranks_by_ladder.get(target_ladder_id, [])
            if not ladder_ranks:
                return

            if current_rank and current_rank.get("ladder_id") != target_ladder_id:
                current_rank = None

            context_base = {
                "student": s,
                "membership_id": membership_id,
                "program_id": student_program_id,
                "target_ladder_id": target_ladder_id,
                "started_at": started_at,
                "context_key": membership_id or f"{s['id']}:{student_program_id or 'legacy'}:{target_ladder_id}",
            }

            # If no rank, the next rank is the first one
            if not current_rank:
                next_rank = ladder_ranks[0]
                if not next_rank:
                    return
                eligibility_contexts.append({
                    **context_base,
                    "current_rank_id": None,
                    "current_rank": None,
                    "next_rank": next_rank,
                })
                return

            next_rank = next_rank_map_by_ladder.get(target_ladder_id, {}).get(current_rank_id)
            if not next_rank:
                return  # Already at highest rank

            eligibility_contexts.append({
                **context_base,
                "current_rank_id": current_rank_id,
                "current_rank": current_rank,
                "next_rank": next_rank,
            })

        for s in students_result.data or []:
            memberships = memberships_by_student.get(s["id"]) or []
            if memberships:
                for membership in memberships:
                    add_context_for_program_state(
                        s,
                        membership_id=membership.get("id"),
                        program_id_value=membership.get("program_id"),
                        current_rank_id_value=membership.get("current_belt_rank_id"),
                        started_at=membership.get("started_at"),
                    )
            else:
                add_context_for_program_state(
                    s,
                    membership_id=None,
                    program_id_value=s.get("program_id"),
                    current_rank_id_value=s.get("current_belt_rank_id"),
                    started_at=s.get("membership_start_date"),
                )

        latest_promotions_by_context = self._fetch_latest_promotions_by_context(
            studio_id,
            eligibility_contexts,
        )
        attendance_counts_by_student = self._fetch_attendance_counts_by_student(
            studio_id,
            eligibility_contexts,
            latest_promotions_by_context,
            ladder_meta,
        )

        entries = []
        for context in eligibility_contexts:
            s = context["student"]
            current_rank = context["current_rank"]
            next_rank = context["next_rank"]
            current_rank_id = context["current_rank_id"]
            context_key = context["context_key"]
            latest_promo_date = latest_promotions_by_context.get(context_key)
            classes_since = attendance_counts_by_student.get(context_key, 0)

            if not current_rank:
                anchor_date = latest_promo_date or context.get("started_at") or s.get("membership_start_date")
                days_at = max(0, (now - self._parse_datetime(anchor_date)).days) if anchor_date else 0
                classes_met = classes_since >= next_rank["min_classes"]
                time_met = days_at >= next_rank["min_months"] * 30
                entries.append(EligibilityEntry(
                    student_id=s["id"],
                    student_program_membership_id=context.get("membership_id"),
                    program_id=context.get("program_id"),
                    student_name=f"{s.get('preferred_name') or s['legal_first_name']} {s['legal_last_name']}",
                    current_rank_id=None,
                    current_rank_name=None,
                    current_rank_color=None,
                    next_rank_id=next_rank["id"],
                    next_rank_name=next_rank["name"],
                    next_rank_color=next_rank["color_hex"],
                    classes_since_promo=classes_since,
                    classes_required=next_rank["min_classes"],
                    days_at_rank=days_at,
                    days_required=next_rank["min_months"] * 30,
                    classes_met=classes_met,
                    time_met=time_met,
                    needs_approval=next_rank["requires_approval"],
                    is_eligible=classes_met and time_met and not next_rank["requires_approval"],
                ))
                continue

            # Days at current rank
            anchor_date = latest_promo_date or context.get("started_at") or s.get("membership_start_date")
            if anchor_date:
                anchor_dt = self._parse_datetime(anchor_date)
                days_at = max(0, (now - anchor_dt).days)
            else:
                days_at = 0

            classes_req = next_rank["min_classes"]
            days_req = next_rank["min_months"] * 30
            classes_met = classes_since >= classes_req
            time_met = days_at >= days_req
            needs_approval = next_rank["requires_approval"]

            entries.append(EligibilityEntry(
                student_id=s["id"],
                student_program_membership_id=context.get("membership_id"),
                program_id=context.get("program_id"),
                student_name=f"{s.get('preferred_name') or s['legal_first_name']} {s['legal_last_name']}",
                current_rank_id=current_rank_id,
                current_rank_name=current_rank["name"],
                current_rank_color=current_rank["color_hex"],
                next_rank_id=next_rank["id"],
                next_rank_name=next_rank["name"],
                next_rank_color=next_rank["color_hex"],
                classes_since_promo=classes_since,
                classes_required=classes_req,
                days_at_rank=days_at,
                days_required=days_req,
                classes_met=classes_met,
                time_met=time_met,
                needs_approval=needs_approval,
                is_eligible=classes_met and time_met and not needs_approval,
            ))

        return entries

    # ---- Promote ----

    async def promote_student(
        self, data: PromoteStudent, studio_id: str, actor_id: str
    ) -> PromotionResponse:
        target_rank_result = (
            self.supabase.table("belt_ranks")
            .select("id, ladder_id")
            .eq("id", data.to_rank_id)
            .eq("studio_id", studio_id)
            .single()
            .execute()
        )
        if not target_rank_result.data:
            raise HTTPException(status_code=404, detail="Target belt rank not found")
        target_rank = target_rank_result.data

        target_ladder_result = (
            self.supabase.table("belt_ladders")
            .select("id, program_id")
            .eq("id", target_rank["ladder_id"])
            .eq("studio_id", studio_id)
            .single()
            .execute()
        )
        if not target_ladder_result.data:
            raise HTTPException(status_code=404, detail="Belt ladder not found")
        target_ladder = target_ladder_result.data

        student_result = (
            self.supabase.table("students")
            .select("program_id, current_belt_rank_id")
            .eq("id", data.student_id)
            .eq("studio_id", studio_id)
            .single()
            .execute()
        )
        if not student_result.data:
            raise HTTPException(status_code=404, detail="Student not found")

        student_program_id = student_result.data.get("program_id")
        membership = None
        target_program_id = data.program_id or target_ladder.get("program_id") or student_program_id
        if data.student_program_membership_id:
            membership_result = (
                self.supabase.table("student_program_memberships")
                .select("id, program_id, current_belt_rank_id, status, ended_at")
                .eq("id", data.student_program_membership_id)
                .eq("student_id", data.student_id)
                .eq("studio_id", studio_id)
                .maybe_single()
                .execute()
            )
            membership = membership_result.data
        elif target_program_id:
            membership_result = (
                self.supabase.table("student_program_memberships")
                .select("id, program_id, current_belt_rank_id, status, ended_at")
                .eq("student_id", data.student_id)
                .eq("studio_id", studio_id)
                .eq("program_id", target_program_id)
                .in_("status", ["active", "paused"])
                .is_("ended_at", "null")
                .maybe_single()
                .execute()
            )
            membership = membership_result.data

        if target_ladder.get("program_id"):
            if not membership or membership.get("program_id") != target_ladder.get("program_id"):
                raise HTTPException(
                    status_code=400,
                    detail="This student does not belong to the selected program ladder.",
                )

        if membership and membership.get("ended_at"):
            raise HTTPException(status_code=400, detail="Cannot promote an ended program membership.")

        from_rank_id = (
            membership.get("current_belt_rank_id")
            if membership
            else student_result.data.get("current_belt_rank_id")
        )
        current_rank = None
        if from_rank_id:
            current_rank_result = (
                self.supabase.table("belt_ranks")
                .select("id, ladder_id")
                .eq("id", from_rank_id)
                .eq("studio_id", studio_id)
                .single()
                .execute()
            )
            current_rank = current_rank_result.data
            if not current_rank:
                raise HTTPException(status_code=404, detail="Current belt rank not found")
            if current_rank["ladder_id"] != target_rank["ladder_id"]:
                raise HTTPException(
                    status_code=400,
                    detail="Promotions must stay within the student's current belt ladder.",
                )

        ladder_ranks_result = (
            self.supabase.table("belt_ranks")
            .select("id")
            .eq("studio_id", studio_id)
            .eq("ladder_id", target_rank["ladder_id"])
            .order("display_order")
            .execute()
        )
        ladder_rank_ids = [rank["id"] for rank in (ladder_ranks_result.data or []) if rank.get("id")]
        if not ladder_rank_ids:
            raise HTTPException(status_code=400, detail="The selected ladder has no ranks configured.")

        if from_rank_id:
            try:
                current_index = ladder_rank_ids.index(from_rank_id)
            except ValueError as exc:
                raise HTTPException(status_code=400, detail="The student's current rank is not part of the selected ladder.") from exc
            expected_next_rank_id = ladder_rank_ids[current_index + 1] if current_index + 1 < len(ladder_rank_ids) else None
            if expected_next_rank_id != data.to_rank_id:
                raise HTTPException(
                    status_code=400,
                    detail="Students can only be promoted to the next rank in their current ladder.",
                )
        elif ladder_rank_ids[0] != data.to_rank_id:
            raise HTTPException(
                status_code=400,
                detail="Unranked students can only be assigned the first rank in the selected ladder.",
            )

        # Create promotion record
        promo = {
            "studio_id": studio_id,
            "student_id": data.student_id,
            "student_program_membership_id": membership.get("id") if membership else None,
            "program_id": membership.get("program_id") if membership else target_ladder.get("program_id"),
            "from_rank_id": from_rank_id,
            "to_rank_id": data.to_rank_id,
            "promoted_by": actor_id,
            "notes": data.notes,
        }
        result = self.supabase.table("promotions").insert(promo).execute()
        if not result.data:
            raise HTTPException(status_code=500, detail="Failed to record promotion")

        if membership:
            (
                self.supabase.table("student_program_memberships")
                .update({"current_belt_rank_id": data.to_rank_id})
                .eq("id", membership["id"])
                .eq("studio_id", studio_id)
                .execute()
            )

        # Compatibility fields for older UI paths during migration.
        self.supabase.table("students").update({
            "current_belt_rank_id": data.to_rank_id,
            "program_id": (membership.get("program_id") if membership else student_program_id),
        }).eq("id", data.student_id).eq("studio_id", studio_id).execute()

        # Audit log
        self.supabase.table("audit_logs").insert({
            "studio_id": studio_id,
            "actor_id": actor_id,
            "action": "student.promoted",
            "entity_type": "promotion",
            "entity_id": result.data[0]["id"],
            "metadata": {
                "student_id": data.student_id,
                "student_program_membership_id": membership.get("id") if membership else None,
                "program_id": membership.get("program_id") if membership else target_ladder.get("program_id"),
                "from_rank_id": from_rank_id,
                "to_rank_id": data.to_rank_id,
            },
        }).execute()

        return PromotionResponse(**result.data[0])
