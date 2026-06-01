from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any, Callable, Optional

from fastapi import HTTPException

from app.schemas.belt import EligibilityEntry


class BeltEligibilityCalculator:
    def __init__(self, supabase: Any):
        self.supabase = supabase

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
                    .select(
                        "student_id, checked_in_at, counts_toward_eligibility, "
                        "class_sessions!inner(program_id, status, deleted_at)"
                    )
                .eq("studio_id", studio_id)
                .in_("student_id", student_id_chunk)
                .neq("status", "absent")
                .is_("class_sessions.deleted_at", "null")
                .neq("class_sessions.status", "canceled")
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

        students = self._fetch_paged(
            lambda: (
                self.supabase.table("students")
                .select("id, legal_first_name, legal_last_name, preferred_name, membership_start_date, program_id, current_belt_rank_id")
                .eq("studio_id", studio_id)
                .eq("status", "active")
                .is_("deleted_at", "null")
            )
        )
        student_ids = [row["id"] for row in students if row.get("id")]
        memberships_by_student: dict[str, list[dict[str, Any]]] = {}
        for student_id_chunk in self._chunked(student_ids):
            membership_rows = self._fetch_paged(
                lambda student_id_chunk=student_id_chunk: (
                    self.supabase.table("student_program_memberships")
                    .select("id, student_id, program_id, status, ended_at, started_at, current_belt_rank_id")
                    .eq("studio_id", studio_id)
                    .in_("student_id", student_id_chunk)
                    .in_("status", ["active", "paused"])
                    .is_("ended_at", "null")
                )
            )
            for membership in membership_rows:
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

        for s in students:
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
