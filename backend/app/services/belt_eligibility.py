from __future__ import annotations

import re
from datetime import UTC, date, datetime, timezone
from typing import Any, Callable, Optional

from fastapi import HTTPException

from app.schemas.belt import EligibilityEntry
from app.schemas.belt_test import BeltTestEventResponse
from app.services.studio_business_date import studio_today

CANDIDATES_STATE_DETAIL = "Candidates require a future scheduled belt test."
CANDIDATES_CONTEXT_DETAIL = "This belt test's ladder or program is no longer available."
CANDIDATES_UNAVAILABLE_DETAIL = (
    "Belt-test candidates are temporarily unavailable. Try again shortly."
)


class _CandidateContextUnavailable(Exception):
    """A successful read confirmed that the captured event context no longer holds."""


def attendance_earns_belt_credit(
    row: dict[str, Any],
    class_session: dict[str, Any],
    *,
    promotion_instant: Optional[datetime],
    ladder_program_id: Optional[str],
) -> bool:
    """Whether a non-absent visit to a live class session counts toward one context.

    Callers must already have excluded absent rows and missing, deleted or
    canceled sessions. Promotion bounds compare exact instants, not dates.
    """
    if row.get("counts_toward_eligibility") is False:
        return False
    if promotion_instant:
        checked_in_at = row.get("checked_in_at")
        if (
            not checked_in_at
            or BeltEligibilityCalculator._parse_datetime(checked_in_at) < promotion_instant
        ):
            return False
    if ladder_program_id and class_session.get("program_id") != ladder_program_id:
        return False
    return True


class BeltEligibilityCalculator:
    def __init__(self, supabase: Any):
        self.supabase = supabase

    @staticmethod
    def _chunked(values: list[str], size: int = 100) -> list[list[str]]:
        return [values[index : index + size] for index in range(0, len(values), size)]

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
                parsed = datetime.fromisoformat(
                    f"{match.group('head')}.{fraction}{timezone_suffix}"
                )
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed

    def _fetch_paged(
        self,
        query_factory: Callable[[], Any],
        page_size: int = 1000,
        *,
        required_fields: tuple[str, ...] = (),
    ) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        offset = 0
        while True:
            result = query_factory().range(offset, offset + page_size - 1).execute()
            batch = self._read_rows(result, required_fields)
            rows.extend(batch)
            if len(batch) < page_size:
                break
            offset += page_size
        return rows

    @staticmethod
    def _read_rows(result: Any, required_fields: tuple[str, ...] = ()) -> list[dict[str, Any]]:
        # Event suggestions cannot turn a malformed provider response into an
        # empty context or interpret an omitted nullable field as known null.
        if required_fields:
            rows = result.data
            if not isinstance(rows, list) or any(
                not isinstance(row, dict) or not set(required_fields).issubset(row) for row in rows
            ):
                raise ValueError("Invalid candidate facts.")
            return rows
        return result.data or []

    def _fetch_latest_promotions_by_context(
        self,
        studio_id: str,
        eligibility_contexts: list[dict[str, Any]],
        *,
        strict: bool = False,
    ) -> dict[str, Optional[str]]:
        latest_promotions: dict[str, Optional[str]] = {}
        unique_student_ids = sorted(
            {
                context["student"]["id"]
                for context in eligibility_contexts
                if context.get("student", {}).get("id")
            }
        )

        for student_id_chunk in self._chunked(unique_student_ids):
            promotion_rows = self._fetch_paged(
                lambda student_id_chunk=student_id_chunk: (
                    self.supabase.table("promotions")
                    .select("student_id, student_program_membership_id, program_id, promoted_at")
                    .eq("studio_id", studio_id)
                    .in_("student_id", student_id_chunk)
                    .order("promoted_at", desc=True)
                ),
                required_fields=(
                    ("student_id", "student_program_membership_id", "program_id", "promoted_at")
                    if strict
                    else ()
                ),
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
        *,
        strict: bool = False,
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
        fully_bounded_student_ids = [
            student_id
            for student_id in student_ids
            if all(
                context["context_key"] in parsed_promotion_dates
                for context in contexts_by_student[student_id]
            )
        ]
        fully_bounded_student_id_set = set(fully_bounded_student_ids)
        unbounded_student_ids = [
            student_id
            for student_id in student_ids
            if student_id not in fully_bounded_student_id_set
        ]

        def build_attendance_query(
            student_id_chunk: list[str], lower_bound: Optional[str] = None
        ) -> Any:
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

                class_session = row.get("class_sessions")
                if strict:
                    if isinstance(class_session, list) and len(class_session) == 1:
                        class_session = class_session[0]
                    if (
                        not isinstance(class_session, dict)
                        or not {"program_id", "status", "deleted_at"}.issubset(class_session)
                        or (
                            class_session["program_id"] is not None
                            and not isinstance(class_session["program_id"], str)
                        )
                        or not isinstance(class_session["status"], str)
                        or class_session["status"]
                        not in {"scheduled", "in_progress", "completed", "canceled"}
                        or (
                            class_session["deleted_at"] is not None
                            and not isinstance(class_session["deleted_at"], str)
                        )
                        or (
                            row["counts_toward_eligibility"] is not None
                            and type(row["counts_toward_eligibility"]) is not bool
                        )
                    ):
                        raise ValueError("Attendance context unavailable.")
                    if (
                        class_session["deleted_at"] is not None
                        or class_session["status"] == "canceled"
                    ):
                        continue
                class_session = class_session or {}
                if isinstance(class_session, list):
                    class_session = class_session[0] if class_session else {}
                if row.get("counts_toward_eligibility") is False:
                    continue

                for context in contexts:
                    ladder_program_id = (ladder_meta.get(context["target_ladder_id"]) or {}).get(
                        "program_id"
                    )
                    if attendance_earns_belt_credit(
                        row,
                        class_session,
                        promotion_instant=parsed_promotion_dates.get(context["context_key"]),
                        ladder_program_id=ladder_program_id,
                    ):
                        attendance_counts[context["context_key"]] += 1

        for student_id_chunk in self._chunked(unbounded_student_ids):
            process_attendance_rows(
                self._fetch_paged(
                    lambda student_id_chunk=student_id_chunk: build_attendance_query(
                        student_id_chunk
                    ),
                    required_fields=(
                        (
                            "student_id",
                            "checked_in_at",
                            "counts_toward_eligibility",
                            "class_sessions",
                        )
                        if strict
                        else ()
                    ),
                )
            )

        if fully_bounded_student_ids:
            lower_bound = min(
                parsed_promotion_dates[context["context_key"]]
                for student_id in fully_bounded_student_ids
                for context in contexts_by_student[student_id]
            ).isoformat()
            for student_id_chunk in self._chunked(fully_bounded_student_ids):
                process_attendance_rows(
                    self._fetch_paged(
                        lambda student_id_chunk=student_id_chunk, lower_bound=lower_bound: (
                            build_attendance_query(student_id_chunk, lower_bound)
                        ),
                        required_fields=(
                            (
                                "student_id",
                                "checked_in_at",
                                "counts_toward_eligibility",
                                "class_sessions",
                            )
                            if strict
                            else ()
                        ),
                    )
                )

        return attendance_counts

    async def get_eligibility(
        self, studio_id: str, ladder_id: Optional[str] = None
    ) -> list[EligibilityEntry]:
        """Compute promotion eligibility for all active students."""
        return await self._get_eligibility(studio_id, ladder_id)

    async def get_event_candidates(
        self, studio_id: str, event: BeltTestEventResponse
    ) -> list[EligibilityEntry]:
        """Suggest current contexts; the atomic approval command rechecks all facts."""
        now = datetime.now(UTC)
        if event.status != "scheduled" or event.starts_at <= now:
            raise HTTPException(409, CANDIDATES_STATE_DETAIL)
        try:
            return await self._get_eligibility(
                studio_id, str(event.ladder_id), event=event, reference_time=now
            )
        except _CandidateContextUnavailable:
            raise HTTPException(409, CANDIDATES_CONTEXT_DETAIL) from None
        except Exception:  # noqa: BLE001 - Provider details are never public candidate facts.
            raise HTTPException(503, CANDIDATES_UNAVAILABLE_DETAIL) from None

    async def _get_eligibility(
        self,
        studio_id: str,
        ladder_id: str | None,
        *,
        event: BeltTestEventResponse | None = None,
        reference_time: datetime | None = None,
    ) -> list[EligibilityEntry]:
        ladders_query = (
            self.supabase.table("belt_ladders")
            .select("id, name, program_id, studio_id" if event else "id, name, program_id")
            .eq("studio_id", studio_id)
            .order("created_at")
        )
        if event:
            ladders_query = ladders_query.eq("id", ladder_id)
        ladders_result = ladders_query.execute()
        ladder_rows = self._read_rows(
            ladders_result, ("id", "name", "program_id", "studio_id") if event else ()
        )
        ladder_meta = {row["id"]: row for row in ladder_rows if row.get("id")}

        current_program_ids: set[str] = set()
        business_date = None
        if event:
            selected_ladder = ladder_meta.get(ladder_id)
            event_program_id = str(event.program_id) if event.program_id is not None else None
            if (
                str(event.studio_id) != studio_id
                or not selected_ladder
                or selected_ladder["studio_id"] != studio_id
                or selected_ladder["program_id"] != event_program_id
            ):
                raise _CandidateContextUnavailable
            programs = self._fetch_paged(
                lambda: (
                    self.supabase.table("programs")
                    .select("id, studio_id, archived_at")
                    .eq("studio_id", studio_id)
                    .is_("archived_at", "null")
                ),
                required_fields=("id", "studio_id", "archived_at"),
            )
            current_program_ids = {
                program["id"]
                for program in programs
                if program["studio_id"] == studio_id and program["archived_at"] is None
            }
            if event_program_id is not None and event_program_id not in current_program_ids:
                raise _CandidateContextUnavailable
            studio_rows = self._read_rows(
                self.supabase.table("studios").select("id, timezone").eq("id", studio_id).execute(),
                ("id", "timezone"),
            )
            if len(studio_rows) != 1 or studio_rows[0]["id"] != studio_id:
                raise ValueError("Studio facts unavailable.")
            business_date = studio_today(studio_rows[0]["timezone"], now=reference_time)[0]

        if ladder_id and ladder_id not in ladder_meta:
            raise HTTPException(status_code=404, detail="Belt ladder not found")

        ranks_query = (
            self.supabase.table("belt_ranks")
            .select("*")
            .eq("studio_id", studio_id)
            .order("ladder_id")
            .order("display_order")
            .order("created_at")
            .order("id")
        )
        if event:
            ranks_query = ranks_query.eq("ladder_id", ladder_id)
        ranks_result = ranks_query.execute()
        ranks = self._read_rows(
            ranks_result,
            (
                "id",
                "studio_id",
                "ladder_id",
                "name",
                "color_hex",
                "min_classes",
                "min_months",
                "requires_approval",
            )
            if event
            else (),
        )

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
            if event and (rank["studio_id"] != studio_id or rank["ladder_id"] != ladder_id):
                continue
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
                .select(
                    "id, legal_first_name, legal_last_name, preferred_name, membership_start_date, program_id, current_belt_rank_id"
                    + (
                        ", studio_id, status, deleted_at, hold_start_date, hold_end_date"
                        if event
                        else ""
                    )
                )
                .eq("studio_id", studio_id)
                .eq("status", "active")
                .is_("deleted_at", "null")
            ),
            required_fields=(
                "id",
                "studio_id",
                "status",
                "deleted_at",
                "hold_start_date",
                "hold_end_date",
                "program_id",
                "current_belt_rank_id",
                "membership_start_date",
            )
            if event
            else (),
        )
        student_ids = [row["id"] for row in students if row.get("id")]
        memberships_by_student: dict[str, list[dict[str, Any]]] = {}
        for student_id_chunk in self._chunked(student_ids):
            membership_rows = self._fetch_paged(
                lambda student_id_chunk=student_id_chunk: (
                    self.supabase.table("student_program_memberships")
                    .select(
                        "id, student_id, program_id, status, ended_at, started_at, current_belt_rank_id"
                        + (", studio_id" if event else "")
                    )
                    .eq("studio_id", studio_id)
                    .in_("student_id", student_id_chunk)
                    .in_("status", ["active", "paused"])
                    .is_("ended_at", "null")
                ),
                required_fields=(
                    "id",
                    "studio_id",
                    "student_id",
                    "program_id",
                    "status",
                    "ended_at",
                    "started_at",
                    "current_belt_rank_id",
                )
                if event
                else (),
            )
            for membership in membership_rows:
                memberships_by_student.setdefault(membership["student_id"], []).append(membership)

        eligibility_contexts: list[dict[str, Any]] = []
        now = reference_time or datetime.now(timezone.utc)
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

            if event:
                # Check the captured context before the generic unranked fallback.
                if current_rank_id is not None and (
                    not current_rank
                    or current_rank["studio_id"] != studio_id
                    or current_ladder_id != ladder_id
                ):
                    return
                if program_id_value is not None and program_id_value not in current_program_ids:
                    return
                if membership_id is None and event.program_id is not None:
                    return
                if event.program_id is not None and program_id_value != str(event.program_id):
                    return

            target_ladder_id: Optional[str] = None

            if event:
                target_ladder_id = ladder_id
            elif ladder_id:
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
                "context_key": membership_id
                or f"{s['id']}:{student_program_id or 'legacy'}:{target_ladder_id}",
            }

            # If no rank, the next rank is the first one
            if not current_rank:
                next_rank = ladder_ranks[0]
                if not next_rank:
                    return
                eligibility_contexts.append(
                    {
                        **context_base,
                        "current_rank_id": None,
                        "current_rank": None,
                        "next_rank": next_rank,
                    }
                )
                return

            next_rank = next_rank_map_by_ladder.get(target_ladder_id, {}).get(current_rank_id)
            if not next_rank:
                return  # Already at highest rank

            eligibility_contexts.append(
                {
                    **context_base,
                    "current_rank_id": current_rank_id,
                    "current_rank": current_rank,
                    "next_rank": next_rank,
                }
            )

        for s in students:
            if event:
                if (
                    s["studio_id"] != studio_id
                    or s["status"] != "active"
                    or s["deleted_at"] is not None
                ):
                    continue
                hold_start = (
                    date.fromisoformat(s["hold_start_date"])
                    if s["hold_start_date"] is not None
                    else None
                )
                hold_end = (
                    date.fromisoformat(s["hold_end_date"])
                    if s["hold_end_date"] is not None
                    else None
                )
                if (
                    hold_start is not None
                    and hold_start <= business_date
                    and (hold_end is None or hold_end >= business_date)
                ):
                    continue
            memberships = memberships_by_student.get(s["id"]) or []
            if memberships:
                for membership in memberships:
                    if event and (
                        not membership["id"]
                        or membership["studio_id"] != studio_id
                        or membership["student_id"] != s["id"]
                        or membership["status"] not in {"active", "paused"}
                        or membership["ended_at"] is not None
                        or membership["program_id"] not in current_program_ids
                    ):
                        continue
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
            strict=event is not None,
        )
        attendance_counts_by_student = self._fetch_attendance_counts_by_student(
            studio_id,
            eligibility_contexts,
            latest_promotions_by_context,
            ladder_meta,
            strict=event is not None,
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
                anchor_date = (
                    latest_promo_date or context.get("started_at") or s.get("membership_start_date")
                )
                days_at = (
                    max(0, (now - self._parse_datetime(anchor_date)).days) if anchor_date else 0
                )
                classes_met = classes_since >= next_rank["min_classes"]
                time_met = days_at >= next_rank["min_months"] * 30
                entries.append(
                    EligibilityEntry(
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
                    )
                )
                continue

            # Days at current rank
            anchor_date = (
                latest_promo_date or context.get("started_at") or s.get("membership_start_date")
            )
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

            entries.append(
                EligibilityEntry(
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
                )
            )

        return entries

    # ---- Promote ----
