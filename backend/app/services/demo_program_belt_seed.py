from __future__ import annotations

from typing import Any, Callable


class DemoProgramBeltSeeder:
    def __init__(
        self,
        *,
        id_for: Callable[[str, str], str],
        timestamp_for: Callable[[int, int, int], str],
        insert: Callable[[str, list[dict[str, Any]]], None],
    ):
        self.id_for = id_for
        self.timestamp_for = timestamp_for
        self.insert = insert

    def seed_programs(self, studio_id: str) -> dict[str, str]:
        now = self.timestamp_for(0, 9, 0)
        programs = {
            "bjj_core": {
                "id": self.id_for(studio_id, "program:bjj-core"),
                "studio_id": studio_id,
                "name": "Brazilian Jiu-Jitsu Core",
                "description": "Shared belt progression for kids, adults, fundamentals, and no-gi.",
                "created_at": now,
            },
            "tae_kwon_do": {
                "id": self.id_for(studio_id, "program:tae-kwon-do"),
                "studio_id": studio_id,
                "name": "Tae Kwon Do Fundamentals",
                "description": "Foundational forms, footwork, sparring, and confidence.",
                "created_at": now,
            },
        }
        self.insert("programs", list(programs.values()))
        return {key: row["id"] for key, row in programs.items()}

    def seed_belts(self, studio_id: str, program_ids: dict[str, str]) -> dict[str, str]:
        now = self.timestamp_for(0, 9, 0)
        ladder_id = self.id_for(studio_id, "ladder:bjj-core")
        tkd_ladder_id = self.id_for(studio_id, "ladder:tae-kwon-do")
        self.insert(
            "belt_ladders",
            [
                {
                    "id": ladder_id,
                    "studio_id": studio_id,
                    "name": "Brazilian Jiu-Jitsu Core",
                    "program_id": program_ids["bjj_core"],
                    "sub_rank_term": "Stripe",
                    "created_at": now,
                    "updated_at": now,
                },
                {
                    "id": tkd_ladder_id,
                    "studio_id": studio_id,
                    "name": "Tae Kwon Do Fundamentals",
                    "program_id": program_ids["tae_kwon_do"],
                    "sub_rank_term": "Stripe",
                    "created_at": now,
                    "updated_at": now,
                },
            ],
        )

        rank_rows: list[dict[str, Any]] = []
        rank_ids: dict[str, str] = {}
        for key, name, color, order, classes, months, approval, is_tip, tip_color in BJJ_RANK_SPECS:
            rank_id = self.id_for(studio_id, f"rank:{key}")
            rank_ids[key] = rank_id
            rank_rows.append(self._rank_row(
                studio_id,
                ladder_id,
                rank_id,
                name,
                color,
                order,
                classes,
                months,
                approval,
                is_tip,
                tip_color,
                now,
            ))
        for key, name, color, order, classes, months, approval, is_tip, tip_color in TKD_RANK_SPECS:
            rank_id = self.id_for(studio_id, f"rank:{key}")
            rank_ids[key] = rank_id
            rank_rows.append(self._rank_row(
                studio_id,
                tkd_ladder_id,
                rank_id,
                name,
                color,
                order,
                classes,
                months,
                approval,
                is_tip,
                tip_color,
                now,
            ))
        self.insert("belt_ranks", rank_rows)
        rank_ids["ladder"] = ladder_id
        rank_ids["tkd_ladder"] = tkd_ladder_id
        return rank_ids

    def seed_promotions(
        self,
        studio_id: str,
        actor_id: str,
        program_ids: dict[str, str],
        student_ids: dict[str, str],
        rank_ids: dict[str, str],
    ) -> None:
        rows = []
        for student_key, from_key, to_key, offset, notes in PROMOTION_SPECS:
            program_key = "tae_kwon_do" if to_key.startswith("tkd-") else "bjj_core"
            rows.append(
                {
                    "id": self.id_for(studio_id, f"promotion:{student_key}:{to_key}"),
                    "studio_id": studio_id,
                    "student_id": student_ids[student_key],
                    "student_program_membership_id": self.id_for(studio_id, f"student-program:{student_key}"),
                    "program_id": program_ids[program_key],
                    "from_rank_id": rank_ids[from_key] if from_key else None,
                    "to_rank_id": rank_ids[to_key],
                    "promoted_by": actor_id,
                    "notes": notes,
                    "promoted_at": self.timestamp_for(offset, 18, 30),
                }
            )
        self.insert("promotions", rows)

    @staticmethod
    def _rank_row(
        studio_id: str,
        ladder_id: str,
        rank_id: str,
        name: str,
        color: str,
        order: int,
        classes: int,
        months: int,
        approval: bool,
        is_tip: bool,
        tip_color: str | None,
        now: str,
    ) -> dict[str, Any]:
        return {
            "id": rank_id,
            "ladder_id": ladder_id,
            "studio_id": studio_id,
            "name": name,
            "color_hex": color,
            "display_order": order,
            "min_classes": classes,
            "min_months": months,
            "requires_approval": approval,
            "is_tip": is_tip,
            "tip_color_hex": tip_color,
            "created_at": now,
        }


BJJ_RANK_SPECS = [
    ("white", "White Belt", "#FFFFFF", 0, 0, 0, False, False, None),
    ("white-stripe-1", "White Stripe 1", "#FFFFFF", 1, 6, 1, False, True, "#EF4444"),
    ("white-stripe-2", "White Stripe 2", "#FFFFFF", 2, 8, 1, False, True, "#EF4444"),
    ("white-stripe-3", "White Stripe 3", "#FFFFFF", 3, 10, 1, False, True, "#111111"),
    ("yellow", "Yellow Belt", "#EAB308", 4, 12, 2, True, False, None),
    ("orange", "Orange Belt", "#F97316", 5, 16, 3, True, False, None),
    ("green", "Green Belt", "#22C55E", 6, 20, 4, True, False, None),
]

TKD_RANK_SPECS = [
    ("tkd-white", "White Belt", "#FFFFFF", 0, 0, 0, False, False, None),
    ("tkd-yellow-stripe", "Yellow Stripe", "#FFFFFF", 1, 5, 1, False, True, "#EAB308"),
    ("tkd-yellow", "Yellow Belt", "#EAB308", 2, 10, 2, True, False, None),
    ("tkd-green-stripe", "Green Stripe", "#FFFFFF", 3, 14, 3, False, True, "#22C55E"),
    ("tkd-green", "Green Belt", "#22C55E", 4, 18, 4, True, False, None),
    ("tkd-blue-stripe", "Blue Stripe", "#FFFFFF", 5, 22, 5, False, True, "#3B82F6"),
    ("tkd-blue", "Blue Belt", "#3B82F6", 6, 28, 6, True, False, None),
]

PROMOTION_SPECS = [
    ("aiko", None, "white-stripe-2", -45, "Clean guard retention and steady attendance."),
    ("mateo", None, "white-stripe-3", -70, "Ready for an instructor review before yellow belt."),
    ("priya", None, "white", -20, "Initial white belt assignment after onboarding."),
    ("nina", None, "white-stripe-1", -12, "First stripe earned during beginner cycle."),
    ("marcus", None, "yellow", -100, "Promoted after winter grading."),
    ("derek", None, "orange", -220, "Historical promotion retained for profile context."),
    ("james", None, "yellow", -180, "Promotion before medical hold."),
    ("hana", None, "white-stripe-1", -32, "First stripe after strong beginner attendance."),
    ("ava", None, "white-stripe-2", -54, "Second stripe earned during youth fundamentals."),
    ("noah_b", None, "white-stripe-3", -66, "Third stripe; yellow belt review is next."),
    ("ethan", None, "yellow", -140, "Youth leadership promotion."),
    ("maya", None, "orange", -260, "Adult fundamentals promotion history."),
    ("amara", None, "green", -300, "Advanced rank retained for demo progression."),
    ("kai", None, "orange", -210, "Competition-track youth promotion."),
    ("rebecca", None, "tkd-green", -120, "Adult Tae Kwon Do promotion history."),
    ("miles", None, "tkd-green-stripe", -42, "Green stripe earned after spring forms review."),
    ("julian", None, "white-stripe-3", -61, "Third stripe; yellow belt review is ready."),
]
