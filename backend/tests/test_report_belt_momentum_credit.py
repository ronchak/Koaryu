import asyncio
import unittest
from datetime import date

from app.services.belt_eligibility import BeltEligibilityCalculator
from app.services.report_intelligence_operations import build_belt_momentum_testing_pipeline
from tests.fakes.supabase import TableBackedSupabase


STUDIO_ID = "studio-1"
PROGRAM_ID = "program-1"
OTHER_PROGRAM_ID = "program-2"
PROMOTED_AT = "2026-05-15T10:00:00Z"
TODAY = date(2026, 6, 1)


def report_dataset() -> dict:
    student_defaults = {
        "studio_id": STUDIO_ID,
        "preferred_name": None,
        "status": "active",
        "membership_start_date": "2026-01-01",
        "program_id": PROGRAM_ID,
        "current_belt_rank_id": "rank-1",
        "deleted_at": None,
        "created_at": "2026-01-01T00:00:00Z",
    }
    session_defaults = {
        "studio_id": STUDIO_ID,
        "program_id": PROGRAM_ID,
        "instructor_id": "staff-1",
        "name": "Adult",
        "status": "scheduled",
        "capacity": 10,
        "deleted_at": None,
    }
    attendance_defaults = {"studio_id": STUDIO_ID, "status": "present"}
    return {
        "students": [
            {
                **student_defaults,
                "id": "student-1",
                "legal_first_name": "Ada",
                "legal_last_name": "L",
            },
            {
                **student_defaults,
                "id": "student-2",
                "legal_first_name": "Bea",
                "legal_last_name": "M",
            },
        ],
        "programs": [
            {"id": PROGRAM_ID, "studio_id": STUDIO_ID, "name": "Adult"},
            {"id": OTHER_PROGRAM_ID, "studio_id": STUDIO_ID, "name": "Kids"},
        ],
        "memberships": [
            {
                "id": "membership-1",
                "studio_id": STUDIO_ID,
                "student_id": "student-1",
                "program_id": PROGRAM_ID,
                "status": "active",
                "current_belt_rank_id": "rank-1",
                "started_at": "2026-01-01",
            },
            {
                "id": "membership-2",
                "studio_id": STUDIO_ID,
                "student_id": "student-2",
                "program_id": PROGRAM_ID,
                "status": "active",
                "current_belt_rank_id": "rank-1",
                "started_at": "2026-05-25",
            },
        ],
        "belt_ladders": [
            {"id": "ladder-1", "studio_id": STUDIO_ID, "program_id": PROGRAM_ID},
            {"id": "ladder-2", "studio_id": STUDIO_ID, "program_id": OTHER_PROGRAM_ID},
        ],
        "belt_ranks": [
            {
                "id": "rank-1",
                "studio_id": STUDIO_ID,
                "ladder_id": "ladder-1",
                "name": "White",
                "display_order": 1,
                "min_classes": 0,
                "min_months": 0,
                "requires_approval": False,
            },
            {
                "id": "rank-2",
                "studio_id": STUDIO_ID,
                "ladder_id": "ladder-1",
                "name": "Blue",
                "display_order": 2,
                "min_classes": 3,
                "min_months": 0,
                "requires_approval": True,
            },
        ],
        "promotions": [
            {
                "id": "promotion-1",
                "studio_id": STUDIO_ID,
                "student_id": "student-1",
                "student_program_membership_id": "membership-1",
                "program_id": PROGRAM_ID,
                "promoted_at": PROMOTED_AT,
            }
        ],
        "sessions": [
            {**session_defaults, "id": "session-promotion-day", "date": "2026-05-15"},
            {
                **session_defaults,
                "id": "session-other-program",
                "date": "2026-05-20",
                "program_id": OTHER_PROGRAM_ID,
            },
            {**session_defaults, "id": "session-late", "date": "2026-05-21"},
            {
                **session_defaults,
                "id": "session-canceled",
                "date": "2026-05-23",
                "status": "canceled",
            },
            {**session_defaults, "id": "session-old", "date": "2026-03-01"},
        ],
        "attendance": [
            # Same session date as the promotion; only the exact instant decides credit.
            {
                **attendance_defaults,
                "id": "before",
                "session_id": "session-promotion-day",
                "student_id": "student-1",
                "checked_in_at": "2026-05-15T09:59:59Z",
            },
            {
                **attendance_defaults,
                "id": "before-offset",
                "session_id": "session-promotion-day",
                "student_id": "student-1",
                "checked_in_at": "2026-05-15T11:59:59+02:00",
            },
            {
                **attendance_defaults,
                "id": "at",
                "session_id": "session-promotion-day",
                "student_id": "student-1",
                "checked_in_at": "2026-05-15T10:00:00Z",
                "counts_toward_eligibility": True,
            },
            {
                **attendance_defaults,
                "id": "after",
                "session_id": "session-promotion-day",
                "student_id": "student-1",
                "checked_in_at": "2026-05-15T10:00:01Z",
                "counts_toward_eligibility": None,
            },
            {
                **attendance_defaults,
                "id": "program-mismatch",
                "session_id": "session-other-program",
                "student_id": "student-1",
                "checked_in_at": "2026-05-20T18:00:00Z",
            },
            {
                **attendance_defaults,
                "id": "no-credit",
                "session_id": "session-late",
                "student_id": "student-1",
                "checked_in_at": "2026-05-21T18:00:00Z",
                "counts_toward_eligibility": False,
            },
            {
                **attendance_defaults,
                "id": "missing-session",
                "session_id": "session-does-not-exist",
                "student_id": "student-1",
                "checked_in_at": "2026-05-22T18:00:00Z",
            },
            {
                **attendance_defaults,
                "id": "canceled",
                "session_id": "session-canceled",
                "student_id": "student-1",
                "checked_in_at": "2026-05-23T18:00:00Z",
            },
            {
                **attendance_defaults,
                "id": "absent",
                "session_id": "session-late",
                "student_id": "student-1",
                "checked_in_at": "2026-05-21T18:05:00Z",
                "status": "absent",
            },
            # No promotion: operational credit is unbounded, not cut off at started_at.
            {
                **attendance_defaults,
                "id": "unpromoted-history",
                "session_id": "session-old",
                "student_id": "student-2",
                "checked_in_at": "2026-03-01T18:00:00Z",
            },
        ],
    }


def operational_supabase(data: dict) -> TableBackedSupabase:
    """Translate the same facts into the rows the operational calculator reads.

    Operational eligibility embeds class_sessions with an inner join, so an
    attendance row whose session row does not exist is never returned.
    """
    sessions_by_id = {row["id"]: row for row in data["sessions"]}
    joined_attendance = []
    for row in data["attendance"]:
        session = sessions_by_id.get(row["session_id"])
        if session is None:
            continue
        joined_attendance.append(
            {
                **row,
                "class_sessions": {"program_id": session["program_id"]},
                "class_sessions.status": session["status"],
                "class_sessions.deleted_at": session["deleted_at"],
            }
        )
    return TableBackedSupabase(
        {
            "belt_ladders": [
                {**row, "name": row["id"], "created_at": "2026-01-01T00:00:00Z"}
                for row in data["belt_ladders"]
            ],
            "belt_ranks": [{**row, "color_hex": "#ffffff"} for row in data["belt_ranks"]],
            "students": data["students"],
            "student_program_memberships": [
                {**row, "ended_at": None} for row in data["memberships"]
            ],
            "promotions": data["promotions"],
            "attendance": joined_attendance,
        }
    )


class BeltMomentumCreditTest(unittest.TestCase):
    def test_export_credit_uses_exact_promotion_instant_and_operational_filters(self):
        rows = {
            row["membership_id"]: row
            for row in build_belt_momentum_testing_pipeline(report_dataset(), TODAY)
        }

        # Only "at" and "after" earn credit: "before"/"before-offset" precede the
        # promotion instant, and mismatch/no-credit/missing/canceled/absent are excluded.
        promoted = rows["membership-1"]
        self.assertEqual(2, promoted["classes_since_rank_start"])
        self.assertEqual(17, promoted["days_at_rank"])
        self.assertFalse(promoted["classes_met"])
        self.assertTrue(promoted["time_met"])
        self.assertTrue(promoted["requires_approval"])
        self.assertEqual("classes_pending", promoted["pipeline_status"])

        unpromoted = rows["membership-2"]
        self.assertEqual(1, unpromoted["classes_since_rank_start"])
        self.assertEqual(7, unpromoted["days_at_rank"])

    def test_export_credit_matches_operational_eligibility_for_same_facts(self):
        data = report_dataset()
        report_counts = {
            row["membership_id"]: row["classes_since_rank_start"]
            for row in build_belt_momentum_testing_pipeline(data, TODAY)
        }
        entries = asyncio.run(
            BeltEligibilityCalculator(operational_supabase(data)).get_eligibility(STUDIO_ID)
        )
        operational_counts = {
            entry.student_program_membership_id: entry.classes_since_promo for entry in entries
        }

        self.assertEqual({"membership-1": 2, "membership-2": 1}, operational_counts)
        self.assertEqual(operational_counts, report_counts)

    def test_newer_same_program_promotion_anchors_credit_and_display_days(self):
        data = with_newer_same_program_promotion(report_dataset())
        rows = {
            row["membership_id"]: row for row in build_belt_momentum_testing_pipeline(data, TODAY)
        }

        # Operational matching picks the May 20 promotion recorded under another
        # membership in the same program, so display days count from May 20 too.
        promoted = rows["membership-1"]
        self.assertEqual(12, promoted["days_at_rank"])
        self.assertEqual(1, promoted["classes_since_rank_start"])

        calculator = BeltEligibilityCalculator(operational_supabase(data))
        selected = calculator._fetch_latest_promotions_by_context(
            STUDIO_ID,
            [
                {
                    "context_key": "membership-1",
                    "student": {"id": "student-1"},
                    "membership_id": "membership-1",
                    "program_id": PROGRAM_ID,
                }
            ],
        )
        self.assertEqual({"membership-1": NEWER_PROMOTED_AT}, selected)
        entries = asyncio.run(calculator.get_eligibility(STUDIO_ID))
        operational_counts = {
            entry.student_program_membership_id: entry.classes_since_promo for entry in entries
        }
        self.assertEqual(operational_counts["membership-1"], promoted["classes_since_rank_start"])

    def test_matching_null_promotion_is_selected_and_leaves_credit_unbounded(self):
        from app.services.report_intelligence_helpers import _belt_credit_promotion

        null_promotion = {
            "id": "promotion-null",
            "student_id": "student-1",
            "student_program_membership_id": "membership-1",
            "program_id": PROGRAM_ID,
            "promoted_at": None,
        }
        dated_promotion = {
            **null_promotion,
            "id": "promotion-dated",
            "promoted_at": PROMOTED_AT,
        }
        # Operational orders promoted_at DESC, which is NULLS FIRST in Postgres.
        self.assertIs(
            null_promotion,
            _belt_credit_promotion(
                [dated_promotion, null_promotion],
                membership_id="membership-1",
                program_id=PROGRAM_ID,
            ),
        )

        data = report_dataset()
        data["promotions"].append(null_promotion)
        promoted = next(
            row
            for row in build_belt_momentum_testing_pipeline(data, TODAY)
            if row["membership_id"] == "membership-1"
        )
        # No lower bound: before, before-offset, at and after all earn credit, and
        # display days fall back to the membership start (2026-01-01).
        self.assertEqual(4, promoted["classes_since_rank_start"])
        self.assertEqual(151, promoted["days_at_rank"])


NEWER_PROMOTED_AT = "2026-05-20T10:00:00Z"


def with_newer_same_program_promotion(data: dict) -> dict:
    data["promotions"].append(
        {
            "id": "promotion-other-membership",
            "studio_id": STUDIO_ID,
            "student_id": "student-1",
            "student_program_membership_id": "membership-earlier",
            "program_id": PROGRAM_ID,
            "promoted_at": NEWER_PROMOTED_AT,
        }
    )
    data["sessions"].append(
        {
            "id": "session-newer-promotion-day",
            "studio_id": STUDIO_ID,
            "program_id": PROGRAM_ID,
            "instructor_id": "staff-1",
            "name": "Adult",
            "status": "scheduled",
            "capacity": 10,
            "deleted_at": None,
            "date": "2026-05-20",
        }
    )
    for attendance_id, checked_in_at in (
        ("newer-before", "2026-05-20T09:59:59Z"),
        ("newer-at", NEWER_PROMOTED_AT),
    ):
        data["attendance"].append(
            {
                "id": attendance_id,
                "studio_id": STUDIO_ID,
                "status": "present",
                "session_id": "session-newer-promotion-day",
                "student_id": "student-1",
                "checked_in_at": checked_in_at,
            }
        )
    return data


if __name__ == "__main__":
    unittest.main()
